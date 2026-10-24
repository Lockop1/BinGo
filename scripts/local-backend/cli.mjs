#!/usr/bin/env node
// Local backend harness for Bingo Night: Supabase Auth + PostgREST on a plain
// local Postgres, behind a small gateway. LOCAL DEVELOPMENT AND TESTING ONLY.
// See scripts/local-backend/README.md.

import { envLines } from "./config.mjs";

const USAGE = `Usage: node scripts/local-backend/cli.mjs <command>

  download        fetch the PostgREST and Supabase Auth binaries into .bin/ if missing
  reset           drop + recreate bingo_local; auth migrations, shim, app migrations
  migrate         apply pending supabase/migrations/*.sql
  start           run PostgREST, Auth and the gateway in the foreground (Ctrl+C stops)
  start --detach  same, in the background (PIDs and logs in .run/)
  stop            stop a detached backend
  status          show process and database status (exit 3 if not all up,
                  exit 4 if an applied migration file changed since it was applied)
  env             print the .env.local lines
  smoke           end-to-end check with supabase-js against the running backend
`;

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "download": {
      const { download } = await import("./download.mjs");
      download();
      break;
    }
    case "reset": {
      const { reset } = await import("./db.mjs");
      reset();
      console.log("reset: done");
      break;
    }
    case "migrate": {
      const { migrate } = await import("./db.mjs");
      migrate();
      break;
    }
    case "start": {
      const { start } = await import("./processes.mjs");
      await start({ detach: rest.includes("--detach") || rest.includes("-d") });
      break;
    }
    case "stop": {
      const { stop } = await import("./processes.mjs");
      await stop();
      break;
    }
    case "status": {
      const { status } = await import("./processes.mjs");
      const { allUp, drifted } = await status();
      // Drift wins: a green run against a stale schema is worse than a red one.
      if (drifted > 0) process.exitCode = 4;
      else if (!allUp) process.exitCode = 3;
      break;
    }
    case "env":
      for (const line of envLines()) console.log(line);
      break;
    case "smoke": {
      const { smoke } = await import("./smoke.mjs");
      const ok = await smoke();
      // supabase-js keeps timers alive; exit explicitly.
      process.exit(ok ? 0 : 1);
      break;
    }
    case "__proxy": {
      // Internal: the detached gateway process started by `start --detach`.
      const { startProxy } = await import("./proxy.mjs");
      const server = await startProxy();
      const shutdown = () => {
        server.close();
        server.closeAllConnections();
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      break;
    }
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(USAGE);
      break;
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
      process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
