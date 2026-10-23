// Fetches the PostgREST and Supabase Auth release binaries into .bin/ (if missing).

import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { AUTH_BIN, AUTH_MIGRATIONS_DIR, BIN_DIR, DOWNLOADS, POSTGREST_BIN } from "./config.mjs";

function run(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: "utf8" });
  if (result.error) throw new Error(`could not run ${cmd}: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed (exit ${result.status}):\n${result.stderr.trim()}`);
  }
  return result.stdout;
}

/** Downloads `url` and unpacks it into a fresh, empty temp directory under .bin/. */
function fetchArchive(url) {
  mkdirSync(BIN_DIR, { recursive: true });
  const dir = mkdtempSync(path.join(BIN_DIR, ".download-"));
  const archive = path.join(dir, path.basename(new URL(url).pathname));
  const extractDir = path.join(dir, "x");
  mkdirSync(extractDir);
  console.log(`download: ${url}`);
  // curl honours HTTPS_PROXY and the system CA bundle.
  run("curl", ["-fsSL", "--retry", "3", "-o", archive, url]);
  run("tar", [url.endsWith(".tar.xz") ? "-xJf" : "-xzf", archive, "-C", extractDir]);
  return { dir, extractDir };
}

function downloadPostgrest() {
  if (existsSync(POSTGREST_BIN)) {
    console.log(`download: postgrest already present (${POSTGREST_BIN})`);
    return;
  }
  const { dir, extractDir } = fetchArchive(DOWNLOADS.postgrest.url);
  try {
    const bin = path.join(extractDir, "postgrest");
    if (!existsSync(bin)) throw new Error("postgrest archive did not contain a postgrest binary");
    renameSync(bin, POSTGREST_BIN);
    chmodSync(POSTGREST_BIN, 0o755);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function downloadAuth() {
  if (existsSync(AUTH_BIN) && existsSync(AUTH_MIGRATIONS_DIR)) {
    console.log(`download: auth already present (${AUTH_BIN})`);
    return;
  }
  const { dir, extractDir } = fetchArchive(DOWNLOADS.auth.url);
  try {
    const bin = path.join(extractDir, "auth");
    const migrations = path.join(extractDir, "migrations");
    if (!existsSync(bin) || !existsSync(migrations)) {
      throw new Error("auth archive did not contain the auth binary and migrations/ directory");
    }
    rmSync(AUTH_MIGRATIONS_DIR, { recursive: true, force: true });
    renameSync(bin, AUTH_BIN);
    chmodSync(AUTH_BIN, 0o755);
    cpSync(migrations, AUTH_MIGRATIONS_DIR, { recursive: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function download() {
  downloadPostgrest();
  downloadAuth();
  console.log(`download: ${run(POSTGREST_BIN, ["--version"]).trim()}`);
  console.log(`download: auth ${run(AUTH_BIN, ["version"]).split("\n").find((l) => /^v?\d/.test(l)) ?? "unknown"}`);
}
