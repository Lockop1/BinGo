# Local backend harness

**Local development and testing only.** This runs Supabase Auth (GoTrue) and
PostgREST against a plain local Postgres 16 cluster, behind a small Node
gateway that stands in for Supabase's API gateway. It lets `npm run dev` and
scripts make real `@supabase/supabase-js` calls (anonymous sign-in, REST, RPCs)
without Docker or a hosted project. Its JWT secret and keys are public dev
values: never point it at, or reuse them for, a real Supabase project.

## Quick start

```sh
node scripts/local-backend/cli.mjs download        # once: fetch binaries into .bin/
node scripts/local-backend/cli.mjs reset && node scripts/local-backend/cli.mjs start --detach && node scripts/local-backend/cli.mjs smoke
```

Then put the lines printed by `start` (or `node scripts/local-backend/cli.mjs env`)
into `.env.local` and run `npm run dev`:

```sh
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=<printed anon key>
# Server-only (cleanup cron route). Never prefix with NEXT_PUBLIC_.
SUPABASE_SERVICE_ROLE_KEY=<printed service-role key>
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

The keys are deterministic (fixed secret, fixed `iat`), so pasted values keep
working across restarts and resets. Set `LOCAL_BACKEND_JWT_SECRET` (32+ chars)
to use a different secret; the keys change with it.

## Requirements

- A local Postgres 16 at `postgresql://postgres@127.0.0.1:54329` with trust
  auth (superuser `postgres`) and `psql` on `PATH`.
- Node 22. `curl` and `tar` for `download`.
- The harness only ever uses the database **`bingo_local`**; `reset` drops and
  recreates it. It never touches any other database on the cluster.

## Commands

| Command | What it does |
| --- | --- |
| `download` | Fetches PostgREST 13.0.7 and Supabase Auth 2.185.0 (binary + its SQL migrations) into `.bin/` if missing. `LOCAL_BACKEND_BIN_DIR` overrides the directory. |
| `reset` | Drops and recreates `bingo_local`, creates the `auth` schema, runs Auth's own migrations (`auth migrate`), applies `supabase/tests/local_shim.sql`, then `migrate`. Auth runs first so the real `auth.users` exists and the shim's stub is skipped. |
| `migrate` | Applies pending `supabase/migrations/*.sql` in filename order with `psql -v ON_ERROR_STOP=1`, one transaction per file. Applied files are tracked in `_local_backend.migrations` and skipped on re-run; a warning is printed if an applied file was edited. An empty file (a fresh `supabase migration new`) is not recorded and stops the run, so files are never applied out of order. Sends `NOTIFY pgrst, 'reload schema'` so a running PostgREST sees new tables and functions. `LOCAL_BACKEND_MIGRATIONS_DIR` overrides the directory (for experiments). |
| `start` | Runs PostgREST (127.0.0.1:54323), Auth (127.0.0.1:54324) and the gateway (127.0.0.1:54321) in the foreground; Ctrl+C stops all three. Prints a `DRIFT:` line for each drifted migration (see below) but starts anyway. |
| `start --detach` | Same, in the background. PIDs and logs go to `.run/`. |
| `stop` | Stops a detached backend (SIGTERM, then SIGKILL after 5s). |
| `status` | Health of each process, how many app migrations are applied, and a `DRIFT:` line for each drifted migration. Exit code 4 if any migration drifted, else 3 if anything is down (or `bingo_local` is missing), else 0. |
| `env` | Prints the `.env.local` lines. |
| `smoke` | End-to-end check with supabase-js (see below). Exit code 1 on failure. |

You can `reset` or `migrate` while the backend is running; PostgREST reconnects
and reloads its schema cache.

## Migration drift

`migrate` records each applied file's sha256 in `_local_backend.migrations`.
`status` and `start` re-hash every applied file and compare. If a file was
edited (or deleted) after it was applied, `bingo_local` no longer matches the
committed migrations, and they print:

```
DRIFT: supabase/migrations/<file>.sql changed after it was applied — run: npm run backend:reset
```

`status` then exits with code 4; `start` only warns. The fix is always
`npm run backend:reset` (and, in the repo, never editing an applied migration:
add a new one instead).

`npm run e2e` runs `e2e/global-setup.ts` (Playwright `globalSetup`) first: it runs
`node scripts/local-backend/cli.mjs status` and aborts the whole run with that
output if the backend is down (exit 3) or drifted (exit 4). It never starts or
resets the backend itself. `E2E_PORT` / `E2E_BASE_URL` still choose the app
server as before; set `E2E_SKIP_BACKEND_CHECK=1` to skip the check when
`.env.local` points somewhere other than this harness.

## Gateway routes (port 54321)

| Path | Goes to |
| --- | --- |
| `/auth/v1/*` | Supabase Auth, prefix stripped |
| `/rest/v1/*` | PostgREST, prefix stripped, all request headers forwarded (`Authorization`, `apikey`, `Prefer`, `Range`, `Content-Profile`, `Accept-Profile`, ...) |
| `/storage/v1/*` | `501 {"error":"storage not available in local backend"}` |
| `/realtime/v1/websocket` | WebSocket stub speaking the minimal Phoenix protocol (see below) |
| anything else | `404` JSON |

CORS: preflights get `204` with `Access-Control-Allow-Origin: *`, the
supabase-js headers (`authorization, apikey, content-type, prefer,
x-client-info, range, content-profile, accept-profile, x-supabase-api-version`)
and methods `GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD`. Upstream CORS
headers are replaced by the gateway's.

## What is and is not emulated

Emulated for real:

- **Auth**: the real Supabase Auth server. Anonymous sign-ins are enabled,
  email/SMS auto-confirm is on, rate limits are raised for testing. Access
  tokens are HS256 JWTs with `role: authenticated`.
- **REST and RPCs**: the real PostgREST. JWTs are verified with the shared
  secret and requests run as `anon` / `authenticated` / `service_role`, so RLS
  policies, grants and `security definer` RPCs behave as they will in Supabase.

Not emulated:

- **Realtime events**: the WebSocket stub accepts connections, answers
  `heartbeat`, `phx_join` (echoing the requested `postgres_changes` bindings
  with ids so channels reach `SUBSCRIBED`) and `phx_leave`, and acknowledges
  `broadcast`/`presence` pushes. **No events are ever delivered**, so other
  players' changes do not appear live; reload or re-fetch to see them.
  Binary (vsn 2.0.0 broadcast) frames are accepted and ignored.
- **Storage**: every `/storage/v1` call returns 501. Media upload, signed URLs
  and the recap album's media cannot be exercised. The shim only creates
  `storage.buckets` / `storage.objects` tables so storage-policy migrations apply.
- **Email/SMS**: nothing is sent (auto-confirm, no mailer).
- Anything else from the Supabase platform (Edge Functions, Studio, the
  `pg_cron`/`pg_net` extensions, the dashboard).

## Smoke test

`smoke` expects a running backend and checks, using real supabase-js clients
with the anon key:

1. Auth health through the gateway.
2. Two `auth.signInAnonymously()` calls give two distinct user ids.
3. `from('games').select('*')` as each user: `[]` (or rows), a permission
   error, or "table does not exist yet" all prove the REST path and the JWT;
   the output says which. A forged JWT must get `401`.
4. CORS preflight and the storage 501 stub.
5. If `create_game` and `join_game` exist in `bingo_local` (checked in
   `pg_proc`), user A creates a game, user B joins it by code, and both must
   see the game and both players. Arguments are guessed from parameter names;
   if a required one cannot be guessed the step is reported as SKIP.
6. A `postgres_changes` channel must reach `SUBSCRIBED` within 5s, and a raw
   heartbeat must get `phx_reply ok`.

It prints one PASS/FAIL/SKIP line per check and a final `SMOKE PASS` or
`SMOKE FAIL`.

## Files

- `cli.mjs` entry point; `config.mjs` ports, keys and process config;
  `db.mjs` reset/migrate; `processes.mjs` start/stop/status; `proxy.mjs` the
  gateway and WebSocket stub; `smoke.mjs`; `download.mjs`.
- `.bin/` (binaries) and `.run/` (generated `postgrest.conf`, PIDs, logs) are
  gitignored.

Startup log lines from Auth and PostgREST are printed at info level even with
`log-level = warn`; that is the binaries' behaviour, not an error.
