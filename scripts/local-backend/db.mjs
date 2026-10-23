// Database steps for the local backend harness: reset and migrate.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  ADMIN_DB_URL,
  APP_MIGRATIONS_DIR,
  AUTH_BIN,
  AUTH_MIGRATIONS_DIR,
  BIN_DIR,
  DB_NAME,
  DB_URL,
  REPO_ROOT,
  SHIM_FILE,
  authEnv,
} from "./config.mjs";

/** SQL string literal. */
export const lit = (value) => `'${String(value).replaceAll("'", "''")}'`;

/**
 * Runs psql with ON_ERROR_STOP. `script` is fed on stdin. Returns stdout;
 * throws with psql's stderr on failure.
 */
export function psql(script, { url = DB_URL, extraArgs = [] } = {}) {
  const result = spawnSync(
    "psql",
    [url, "-X", "-q", "-v", "ON_ERROR_STOP=1", "--no-psqlrc", ...extraArgs],
    {
      input: script,
      encoding: "utf8",
      env: { ...process.env, PGOPTIONS: "-c client_min_messages=warning" },
    },
  );
  if (result.error) {
    throw new Error(`could not run psql: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`psql failed (exit ${result.status}):\n${result.stderr.trim()}`);
  }
  return result.stdout;
}

/** Runs a query and returns its single text value (tuples only, unaligned). */
export function psqlValue(sql, opts) {
  return psql(sql, { ...opts, extraArgs: ["-At"] }).trim();
}

export function databaseExists() {
  return psqlValue(`select count(*) from pg_database where datname = ${lit(DB_NAME)};`, {
    url: ADMIN_DB_URL,
  }) === "1";
}

function assertHarnessDatabase() {
  // Belt and braces: this module must never drop anything but bingo_local.
  if (DB_NAME !== "bingo_local") throw new Error(`refusing to manage database ${DB_NAME}`);
}

function runAuthMigrations() {
  if (!existsSync(AUTH_BIN) || !existsSync(AUTH_MIGRATIONS_DIR)) {
    throw new Error(
      `Supabase Auth binary or migrations missing in ${BIN_DIR}. Run: node scripts/local-backend/cli.mjs download`,
    );
  }
  const result = spawnSync(AUTH_BIN, ["migrate"], {
    cwd: BIN_DIR,
    encoding: "utf8",
    env: { ...process.env, ...authEnv(), GOTRUE_LOG_LEVEL: "info" },
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.error || result.status !== 0 || !output.includes("migrations applied successfully")) {
    const fatal = output
      .split("\n")
      .filter((line) => line.includes('"fatal"') || line.includes('"error"'))
      .join("\n");
    throw new Error(
      `auth migrate failed (exit ${result.status}): ${result.error?.message ?? ""}\n${(fatal || output).slice(-4000)}`,
    );
  }
  const count = /"count":(\d+)/.exec(output)?.[1];
  console.log(`  auth migrations applied${count ? ` (${count})` : ""}`);
}

/** Drops and recreates bingo_local, then applies GoTrue migrations, the shim and app migrations. */
export function reset() {
  assertHarnessDatabase();
  console.log(`reset: dropping and recreating ${DB_NAME}`);
  psql(`drop database if exists ${DB_NAME} with (force);\ncreate database ${DB_NAME};\n`, {
    url: ADMIN_DB_URL,
  });

  // GoTrue's first migration expects the auth schema to exist already.
  psql("create schema if not exists auth;\n");
  console.log("reset: running Supabase Auth migrations");
  runAuthMigrations();

  // The shim runs after GoTrue so the real auth.users exists and its stub is skipped.
  console.log("reset: applying supabase/tests/local_shim.sql");
  psql(`\\i ${lit(SHIM_FILE)}\n`);

  migrate();
}

function ensureTrackingTable() {
  psql(`
create schema if not exists _local_backend;
revoke all on schema _local_backend from public;
create table if not exists _local_backend.migrations (
  filename text primary key,
  checksum text not null,
  applied_at timestamptz not null default now()
);
`);
}

const displayPath = (p) => {
  const rel = path.relative(REPO_ROOT, p);
  return rel && !rel.startsWith("..") ? rel : p;
};

/** Applies pending supabase/migrations/*.sql files in filename order. Re-runnable. */
export function migrate() {
  if (!databaseExists()) {
    throw new Error(`database ${DB_NAME} does not exist. Run: node scripts/local-backend/cli.mjs reset`);
  }
  ensureTrackingTable();

  const files = existsSync(APP_MIGRATIONS_DIR)
    ? readdirSync(APP_MIGRATIONS_DIR)
        .filter((name) => name.endsWith(".sql"))
        .sort()
    : [];
  const applied = new Map(
    JSON.parse(
      psqlValue(
        "select coalesce(json_agg(json_build_array(filename, checksum)), '[]') from _local_backend.migrations;",
      ),
    ),
  );

  let count = 0;
  let skippedEmpty = null;
  for (const name of files) {
    const file = path.join(APP_MIGRATIONS_DIR, name);
    const contents = readFileSync(file);
    const checksum = createHash("sha256").update(contents).digest("hex");
    if (applied.has(name)) {
      if (applied.get(name) !== checksum) {
        console.warn(
          `migrate: WARNING ${name} changed after it was applied (never edit an applied migration; add a new one, or run reset)`,
        );
      }
      continue;
    }
    if (contents.toString("utf8").trim() === "") {
      // A fresh `supabase migration new` file, probably still being written.
      // Recording it would hide its real contents later, and applying the
      // files after it would break the order, so stop here.
      skippedEmpty = name;
      console.warn(`migrate: ${name} is empty; not recorded, stopping here (later files not applied)`);
      break;
    }
    console.log(`migrate: applying ${name}`);
    // One transaction per file: the migration and its tracking row commit together.
    psql(
      [
        "begin;",
        `\\i ${lit(file)}`,
        `insert into _local_backend.migrations (filename, checksum) values (${lit(name)}, ${lit(checksum)});`,
        "commit;",
        "",
      ].join("\n"),
    );
    count += 1;
  }

  // Tell a running PostgREST to pick up new tables / functions.
  psql("notify pgrst, 'reload schema';\n");
  const pending = files.filter((name) => !applied.has(name)).length - count;
  console.log(
    `migrate: ${count} applied, ${applied.size} previously applied, ${pending} pending, ${files.length} total in ${displayPath(APP_MIGRATIONS_DIR)}`,
  );
  if (skippedEmpty) console.warn("migrate: re-run migrate once the empty file has contents");
}

/** Applied migration filenames (empty if the DB or tracking table is missing). */
export function appliedMigrations() {
  if (!databaseExists()) return null;
  if (psqlValue("select to_regclass('_local_backend.migrations') is not null;") !== "t") return [];
  const out = psqlValue(
    "select coalesce(string_agg(filename, E'\\n' order by filename), '') from _local_backend.migrations;",
  );
  return out ? out.split("\n") : [];
}
