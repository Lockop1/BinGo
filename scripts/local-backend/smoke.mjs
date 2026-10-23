// End-to-end smoke test against the running local backend, using real supabase-js.

import { createClient } from "@supabase/supabase-js";
import { ANON_KEY, API_URL } from "./config.mjs";
import { psqlValue } from "./db.mjs";

const results = [];
const record = (status, name, detail = "") => {
  results.push({ status, name, detail });
  console.log(`${status.padEnd(4)} ${name}${detail ? ` — ${detail}` : ""}`);
};
const pass = (name, detail) => record("PASS", name, detail);
const fail = (name, detail) => record("FAIL", name, detail);
const skip = (name, detail) => record("SKIP", name, detail);

function newClient() {
  return createClient(API_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

const errText = (error) =>
  [error?.code, error?.message, error?.details, error?.hint].filter(Boolean).join(" | ");

/** Describes a REST select result; returns null when it does not prove anything. */
function describeSelect({ data, error }) {
  if (!error) return `ok, ${data.length} row(s) visible`;
  if (error.code === "42501") return `permission denied (${error.message}) — JWT accepted, RLS/grants enforced`;
  if (error.code === "PGRST205" || error.code === "42P01") {
    return "table does not exist yet (no app migrations?) — REST path and JWT accepted";
  }
  return null;
}

/** Signature of public.<name>(...) from the catalog, or null if absent. */
function rpcSignature(name) {
  const json = psqlValue(`
select coalesce(json_agg(json_build_object(
  'name', p.parameter_name, 'type', p.udt_name, 'hasDefault', p.parameter_default is not null)
  order by p.ordinal_position), '[]')
from information_schema.parameters p
where p.specific_schema = 'public'
  and p.parameter_mode in ('IN', 'INOUT')
  and p.specific_name = (
    select r.specific_name from information_schema.routines r
    where r.routine_schema = 'public' and r.routine_name = '${name}'
    order by r.specific_name limit 1);
`);
  const exists = psqlValue(
    `select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = '${name}';`,
  );
  return exists === "0" ? null : JSON.parse(json);
}

/**
 * Builds RPC arguments for the required parameters, guessed from their names.
 * Returns { args } or { missing } when a required parameter cannot be guessed.
 */
function buildArgs(params, values) {
  const args = {};
  const missing = [];
  for (const param of params) {
    // Optional parameters keep the RPC's own defaults.
    if (param.hasDefault) continue;
    const n = (param.name ?? "").toLowerCase();
    const t = param.type;
    let value;
    if (n.includes("code")) value = values.code;
    else if (n.includes("display") || n.includes("host") || n.includes("player") || n.includes("nick")) value = values.displayName;
    else if (n.includes("free")) value = true;
    else if (n.includes("pack")) value = "blank";
    else if (n.includes("label") || n.includes("square")) {
      const labels = Array.from({ length: 25 }, (_, i) => `Smoke square ${i + 1}`);
      if (t === "_text") value = labels;
      else if (t === "jsonb" || t === "json") value = labels.map((label, position) => ({ position, label }));
    } else if (n.includes("name") || n.includes("title")) value = values.gameName;
    if (value === undefined && values.gameId && n.includes("game")) value = values.gameId;

    if (value !== undefined) args[param.name] = value;
    else missing.push(`${param.name} ${t}`);
  }
  return missing.length ? { missing } : { args };
}

/** Pulls { id, join_code } out of whatever create_game returned. */
function gameFromResult(data) {
  const row = Array.isArray(data) ? data[0] : data;
  if (typeof row === "string") return { id: row };
  if (row && typeof row === "object") {
    return {
      id: row.id ?? row.game_id ?? row.game?.id,
      code: row.join_code ?? row.code ?? row.game?.join_code,
    };
  }
  return {};
}

async function checkRpcFlow(a, b, userA, userB) {
  let create;
  let join;
  try {
    create = rpcSignature("create_game");
    join = rpcSignature("join_game");
  } catch (err) {
    fail("rpc catalog lookup", err.message.split("\n")[0]);
    return null;
  }
  if (!create || !join) {
    skip("create_game / join_game flow", "RPCs not present in bingo_local (no app migrations for them yet)");
    return null;
  }

  const createArgs = buildArgs(create, { gameName: "Smoke test game", displayName: "Smoke A" });
  if (createArgs.missing) {
    skip("create_game", `cannot guess required args: ${createArgs.missing.join(", ")}`);
    return null;
  }
  const created = await a.rpc("create_game", createArgs.args);
  if (created.error) {
    fail("create_game as user A", errText(created.error));
    return null;
  }
  let { id: gameId, code } = gameFromResult(created.data);
  if (!gameId) {
    fail("create_game as user A", `could not find a game id in result ${JSON.stringify(created.data)}`);
    return null;
  }
  if (!code) {
    const row = await a.from("games").select("join_code").eq("id", gameId).maybeSingle();
    code = row.data?.join_code;
  }
  pass("create_game as user A", `game ${gameId}${code ? `, join code ${code}` : ""}`);
  if (!code) {
    fail("join_game as user B", "could not determine the join code");
    return gameId;
  }

  const joinArgs = buildArgs(join, { code, displayName: "Smoke B", gameId });
  if (joinArgs.missing) {
    skip("join_game", `cannot guess required args: ${joinArgs.missing.join(", ")}`);
    return gameId;
  }
  const joined = await b.rpc("join_game", joinArgs.args);
  if (joined.error) {
    fail("join_game as user B", errText(joined.error));
    return gameId;
  }
  pass("join_game as user B");

  for (const [label, client] of [
    ["A", a],
    ["B", b],
  ]) {
    const game = await client.from("games").select("*").eq("id", gameId);
    if (game.error || game.data.length !== 1) {
      fail(`user ${label} selects the game`, game.error ? errText(game.error) : `${game.data.length} rows`);
    } else {
      pass(`user ${label} selects the game`);
    }
    const players = await client.from("players").select("*").eq("game_id", gameId);
    const ids = new Set((players.data ?? []).map((p) => p.user_id));
    if (players.error || players.data.length !== 2 || !ids.has(userA) || !ids.has(userB)) {
      fail(
        `user ${label} selects both players`,
        players.error ? errText(players.error) : `${players.data.length} rows`,
      );
    } else {
      pass(`user ${label} selects both players`);
    }
  }
  return gameId;
}

async function checkRealtime(client, gameId) {
  const channel = client.channel(`smoke-${Date.now()}`);
  const status = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve("TIMEOUT (5s)"), 5000);
    channel
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "squares",
          filter: `game_id=eq.${gameId ?? "00000000-0000-0000-0000-000000000000"}`,
        },
        () => {},
      )
      .subscribe((state, err) => {
        if (state === "SUBSCRIBED" || state === "CHANNEL_ERROR" || state === "TIMED_OUT") {
          clearTimeout(timer);
          resolve(err ? `${state}: ${err.message}` : state);
        }
      });
  });
  if (status === "SUBSCRIBED") pass("realtime postgres_changes channel", "SUBSCRIBED against the stub");
  else fail("realtime postgres_changes channel", status);
  await client.removeChannel(channel);
}

async function checkHeartbeat() {
  const ws = new WebSocket(`${API_URL.replace("http", "ws")}/realtime/v1/websocket?apikey=${ANON_KEY}&vsn=2.0.0`);
  const outcome = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve("no reply within 5s"), 5000);
    ws.onopen = () => ws.send(JSON.stringify([null, "hb-1", "phoenix", "heartbeat", {}]));
    ws.onerror = () => {
      clearTimeout(timer);
      resolve("websocket error");
    };
    ws.onmessage = (event) => {
      clearTimeout(timer);
      const [, ref, , evt, payload] = JSON.parse(event.data);
      resolve(ref === "hb-1" && evt === "phx_reply" && payload?.status === "ok" ? "ok" : event.data);
    };
  });
  ws.close();
  if (outcome === "ok") pass("realtime heartbeat", "phx_reply ok");
  else fail("realtime heartbeat", outcome);
}

async function checkGateway() {
  const preflight = await fetch(`${API_URL}/rest/v1/games`, {
    method: "OPTIONS",
    headers: {
      origin: "http://localhost:3000",
      "access-control-request-method": "POST",
      "access-control-request-headers": "authorization, apikey, content-type, x-supabase-api-version",
    },
  });
  if (preflight.status === 204 && preflight.headers.get("access-control-allow-origin") === "*") {
    pass("CORS preflight", "204, Access-Control-Allow-Origin: *");
  } else {
    fail("CORS preflight", `status ${preflight.status}`);
  }

  const storage = await fetch(`${API_URL}/storage/v1/bucket`, { headers: { apikey: ANON_KEY } });
  const storageBody = await storage.json().catch(() => ({}));
  if (storage.status === 501 && storageBody.error) pass("storage stub", "501 storage not available");
  else fail("storage stub", `status ${storage.status}`);

  const forged = await fetch(`${API_URL}/rest/v1/games?select=*`, {
    headers: { apikey: ANON_KEY, authorization: `Bearer ${ANON_KEY.slice(0, -4)}AAAA` },
  });
  await forged.arrayBuffer();
  if (forged.status === 401) pass("REST rejects a forged JWT", "401");
  else fail("REST rejects a forged JWT", `expected 401, got ${forged.status}`);
}

export async function smoke() {
  console.log(`smoke: ${API_URL}\n`);
  try {
    const health = await fetch(`${API_URL}/auth/v1/health`);
    if (!health.ok) throw new Error(`status ${health.status}`);
    pass("auth health via gateway");
  } catch (err) {
    fail("auth health via gateway", `${err.message} — is the backend running? (cli.mjs start --detach)`);
    return finish();
  }

  const a = newClient();
  const b = newClient();
  const signA = await a.auth.signInAnonymously();
  const signB = await b.auth.signInAnonymously();
  if (signA.error || signB.error) {
    fail("signInAnonymously x2", errText(signA.error ?? signB.error));
    return finish();
  }
  const userA = signA.data.user.id;
  const userB = signB.data.user.id;
  if (userA && userB && userA !== userB) {
    pass("signInAnonymously x2", `distinct users ${userA.slice(0, 8)}… / ${userB.slice(0, 8)}…`);
  } else {
    fail("signInAnonymously x2", `ids not distinct: ${userA} / ${userB}`);
  }
  if (signA.data.user.is_anonymous !== true) fail("anonymous flag", "user.is_anonymous is not true");

  for (const [label, client] of [
    ["A", a],
    ["B", b],
  ]) {
    const result = await client.from("games").select("*");
    const description = describeSelect(result);
    if (description) pass(`REST select games as user ${label}`, description);
    else fail(`REST select games as user ${label}`, errText(result.error));
  }

  await checkGateway();
  const gameId = await checkRpcFlow(a, b, userA, userB);
  await checkRealtime(a, gameId);
  await checkHeartbeat();

  a.realtime.disconnect();
  b.realtime.disconnect();
  return finish();
}

function finish() {
  const failed = results.filter((r) => r.status === "FAIL").length;
  const skipped = results.filter((r) => r.status === "SKIP").length;
  const passed = results.length - failed - skipped;
  console.log(
    `\nSMOKE ${failed ? "FAIL" : "PASS"}: ${passed} passed, ${failed} failed, ${skipped} skipped`,
  );
  return failed === 0;
}
