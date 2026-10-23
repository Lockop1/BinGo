// Process management for the local backend harness: start, stop, status.

import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AUTH_BIN,
  AUTH_PORT,
  BIN_DIR,
  HOST,
  POSTGREST_BIN,
  POSTGREST_PORT,
  PROXY_PORT,
  RUN_DIR,
  authEnv,
  envLines,
  postgrestConfig,
} from "./config.mjs";
import { appliedMigrations, databaseExists } from "./db.mjs";
import { startProxy } from "./proxy.mjs";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.mjs");
const POSTGREST_CONF = path.join(RUN_DIR, "postgrest.conf");

const SERVICES = [
  {
    name: "postgrest",
    port: POSTGREST_PORT,
    health: `http://${HOST}:${POSTGREST_PORT}/`,
    marker: "postgrest",
    command: () => [POSTGREST_BIN, [POSTGREST_CONF], {}],
  },
  {
    name: "auth",
    port: AUTH_PORT,
    health: `http://${HOST}:${AUTH_PORT}/health`,
    marker: "auth",
    command: () => [AUTH_BIN, ["serve"], authEnv()],
  },
  {
    name: "proxy",
    port: PROXY_PORT,
    health: `http://${HOST}:${PROXY_PORT}/auth/v1/health`,
    marker: "cli.mjs",
    command: () => [process.execPath, [CLI, "__proxy"], {}],
  },
];

const pidFile = (name) => path.join(RUN_DIR, `${name}.pid`);
const logFile = (name) => path.join(RUN_DIR, `${name}.log`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readPid(name) {
  try {
    const pid = Number.parseInt(readFileSync(pidFile(name), "utf8"), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** True if `pid` is alive and (where /proc exists) still looks like our process. */
function isOurProcess(pid, marker) {
  if (!isAlive(pid)) return false;
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return cmdline.includes(marker);
  } catch {
    return true; // no /proc: trust the pid file
  }
}

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: HOST, port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

async function healthy(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    await res.arrayBuffer();
    return res.status < 500;
  } catch {
    return false;
  }
}

async function waitHealthy(service, child, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) return false;
    if (await healthy(service.health)) return true;
    await sleep(200);
  }
  return false;
}

function tail(file, lines = 20) {
  try {
    return readFileSync(file, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
  } catch {
    return "(no log)";
  }
}

async function preflight() {
  for (const bin of [POSTGREST_BIN, AUTH_BIN]) {
    if (!existsSync(bin)) {
      throw new Error(`${bin} missing. Run: node scripts/local-backend/cli.mjs download`);
    }
  }
  if (!databaseExists()) {
    throw new Error("database bingo_local does not exist. Run: node scripts/local-backend/cli.mjs reset");
  }
  for (const service of SERVICES) {
    const pid = readPid(service.name);
    if (pid && isOurProcess(pid, service.marker)) {
      throw new Error(`${service.name} already running (pid ${pid}). Run stop first.`);
    }
    if (await portInUse(service.port)) {
      throw new Error(`port ${service.port} (${service.name}) is already in use by another process`);
    }
  }
  mkdirSync(RUN_DIR, { recursive: true });
  writeFileSync(POSTGREST_CONF, postgrestConfig(), { mode: 0o600 });
}

function printEnv() {
  console.log("\nLocal backend is up. Put these in .env.local (local development only):\n");
  for (const line of envLines()) console.log(line);
  console.log("");
}

/** Starts everything detached; PIDs and logs go to .run/. */
async function startDetached() {
  const started = [];
  for (const service of SERVICES) {
    const [cmd, args, env] = service.command();
    const log = openSync(logFile(service.name), "w");
    const child = spawn(cmd, args, {
      cwd: BIN_DIR,
      detached: true,
      stdio: ["ignore", log, log],
      env: { ...process.env, ...env },
    });
    closeSync(log);
    child.unref();
    writeFileSync(pidFile(service.name), `${child.pid}\n`);
    started.push(service);
    if (!(await waitHealthy(service, child))) {
      console.error(`${service.name} failed to become healthy. Last log lines (${logFile(service.name)}):`);
      console.error(tail(logFile(service.name)));
      await stop({ quiet: true });
      process.exitCode = 1;
      return;
    }
    console.log(`  ${service.name.padEnd(9)} pid ${String(child.pid).padEnd(7)} http://${HOST}:${service.port}`);
  }
  printEnv();
  console.log("Logs: scripts/local-backend/.run/*.log. Stop with: node scripts/local-backend/cli.mjs stop");
}

/** Starts everything in the foreground until SIGINT/SIGTERM. */
async function startForeground() {
  const children = [];
  let shuttingDown = false;
  let server = null;

  const shutdown = (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\nstopping local backend...");
    server?.close();
    server?.closeAllConnections?.();
    for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
    setTimeout(() => {
      for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
      process.exit(code);
    }, 3000).unref();
    Promise.all(
      children.map((child) =>
        child.exitCode !== null ? null : new Promise((resolve) => child.once("exit", resolve)),
      ),
    ).then(() => process.exit(code));
  };
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));

  for (const service of SERVICES.filter((s) => s.name !== "proxy")) {
    const [cmd, args, env] = service.command();
    const child = spawn(cmd, args, {
      cwd: BIN_DIR,
      stdio: ["ignore", "inherit", "inherit"],
      env: { ...process.env, ...env },
    });
    children.push(child);
    child.once("exit", (code, signal) => {
      if (!shuttingDown) {
        console.error(`${service.name} exited unexpectedly (code ${code}, signal ${signal})`);
        shutdown(1);
      }
    });
    if (!(await waitHealthy(service, child))) {
      console.error(`${service.name} failed to become healthy`);
      shutdown(1);
      return;
    }
    console.log(`  ${service.name.padEnd(9)} pid ${String(child.pid).padEnd(7)} http://${HOST}:${service.port}`);
  }
  try {
    server = await startProxy();
  } catch (err) {
    console.error(`proxy failed to start: ${err.message}`);
    shutdown(1);
    return;
  }
  console.log(`  ${"proxy".padEnd(9)} pid ${String(process.pid).padEnd(7)} http://${HOST}:${PROXY_PORT}`);
  printEnv();
  console.log("Press Ctrl+C to stop.");
}

export async function start({ detach = false } = {}) {
  await preflight();
  console.log(`start: launching local backend${detach ? " (detached)" : ""}`);
  if (detach) await startDetached();
  else await startForeground();
}

export async function stop({ quiet = false } = {}) {
  for (const service of [...SERVICES].reverse()) {
    const pid = readPid(service.name);
    if (!pid) continue;
    if (isOurProcess(pid, service.marker)) {
      try {
        // Detached children lead their own process group.
        process.kill(-pid, "SIGTERM");
      } catch {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // already gone
        }
      }
      const deadline = Date.now() + 5000;
      while (isAlive(pid) && Date.now() < deadline) await sleep(100);
      if (isAlive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
      if (!quiet) console.log(`stopped ${service.name} (pid ${pid})`);
    } else if (!quiet) {
      console.log(`${service.name}: stale pid file (pid ${pid} not running)`);
    }
    rmSync(pidFile(service.name), { force: true });
  }
  if (!quiet) console.log("stop: done");
}

export async function status() {
  let allUp = true;
  for (const service of SERVICES) {
    const pid = readPid(service.name);
    const running = pid !== null && isOurProcess(pid, service.marker);
    const ok = await healthy(service.health);
    if (!ok) allUp = false;
    const state = ok ? "up" : running ? "running, not healthy" : "down";
    const pidText = pid ? `pid ${pid}${running ? "" : " (stale)"}` : "no pid file";
    console.log(`${service.name.padEnd(9)} ${state.padEnd(22)} ${pidText.padEnd(18)} http://${HOST}:${service.port}`);
  }
  try {
    const applied = appliedMigrations();
    console.log(
      applied === null
        ? "database  bingo_local does not exist (run reset)"
        : `database  bingo_local, ${applied.length} app migration(s) applied`,
    );
  } catch (err) {
    allUp = false;
    console.log(`database  unreachable: ${err.message.split("\n")[0]}`);
  }
  return allUp;
}
