import { spawnSync } from "node:child_process";
import { join } from "node:path";

/**
 * Fails the run before any spec starts when the local stand-in backend is down or its
 * database was built from migration files that have since been edited (`DRIFT: …`), so a
 * green suite always means "green against the committed schema". It only checks: it never
 * starts or resets the backend. The app's port / URL (E2E_PORT, E2E_BASE_URL) are not
 * involved; this looks at the backend on its fixed local ports.
 *
 * E2E_SKIP_BACKEND_CHECK=1 skips it (e.g. when .env.local points at a hosted project).
 */
export default function globalSetup(): void {
  if (process.env.E2E_SKIP_BACKEND_CHECK === "1") return;
  const cli = join(__dirname, "..", "scripts", "local-backend", "cli.mjs");
  const result = spawnSync(process.execPath, [cli, "status"], { encoding: "utf8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.error) throw new Error(`e2e global setup: could not run backend status: ${result.error.message}`);
  if (result.status === 0) return;

  const drift = output.split("\n").filter((line) => line.startsWith("DRIFT:"));
  const reason =
    result.status === 4
      ? `the local database is out of date with supabase/migrations:\n${drift.join("\n")}`
      : "the local backend is not up. Start it with: npm run backend:start (after npm run backend:reset if bingo_local is missing)";
  throw new Error(`e2e global setup: ${reason}\n\nnode scripts/local-backend/cli.mjs status (exit ${result.status}):\n${output}`);
}
