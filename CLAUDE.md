# Bingo Night — agent guide

@AGENTS.md

Read this file before doing anything. Phase plan and status live in `PHASES.md`.
This repo runs **Next.js 16** (see `AGENTS.md`): check `node_modules/next/dist/docs/` before
using any Next API you are not sure about. Notably: `src/proxy.ts` (not `middleware.ts`),
async `cookies()`/`headers()`/`params`, Turbopack is the default for `dev` and `build`, and
`cacheComponents` + `partialPrefetching` are enabled in `next.config.ts` (read runtime data
such as `params`/`cookies()` inside a `<Suspense>` boundary).

## Product summary

A mobile-first web app for friend groups to play activity bingo on a night out. A host
creates a game, shares a link, friends join a lobby (no signup, display name only) and edit a
5×5 board together, everyone readies up, then one shared board updates live for everyone as
squares get completed. At the end, everyone's photos/videos become a recap album available
for 30 days.

### Core loop

- **Home** → New game / Your games (last 30 days on this phone).
- **Create game** → name + starter pack or blank.
- **Lobby** (pencil-on-notebook-paper theme) → host shares invite link (Web Share API + copy);
  joiners enter a display name only; everyone edits squares live and taps Ready; host taps
  Start when all are ready.
- **Start transition** (~1s) from the paper lobby to the final board in the player's theme.
- **Live board** → one shared 5×5 board; completing a square crosses it off for everyone with
  a toast ("Jake got Skyline Chili").
- **Complete-square sheet**: full text + details, Complete (deliberate press), Add photo/video
  (camera-first), Share to group chat.
- **Recap album** at game end: story-style swipe through squares with media and who completed
  each; viewable/saveable for 30 days.

### Game rules

- 5×5 board; center defaults to a free space (host can turn it off).
- Max 10 players, each with a distinct color from a 10-color palette readable on dark and
  light themes.
- Lobby editing: any player edits any square, last write wins, label ≤40 chars, optional
  details ≤200 chars. Squares lock when the game starts.
- Optional counter squares (`target_count`, e.g. 15 signatures): sheet shows 3/15 with +1;
  completes at target; whoever hits the target gets credit.
- Undo: the completer or the host.
- Bingo: rows, columns, both diagonals (12 lines); each new line celebrates once; blackout
  (25/25) gets a bigger celebration and prompts the host to end.
- Only the host ends a game; games auto-end 24h after start.
- Late joiners can join mid-game. No host transfer in MVP.

### Starter packs

"Night Out" (social challenges / nerve tests), "Day Adventure" (outdoors / exploring), and
"Blank". Content must be app-store-safe: no excessive drinking, sexual acts, illegal activity,
trespassing, or physical danger. Packs live in a typed TS file in the repo
(`src/content/packs/`), not the DB.

### Settings (3 only, stored in localStorage)

- Board theme: Dark Scoreboard | Whiteboard (default from `prefers-color-scheme`).
- Text size: Normal | Large | Extra large.
- Square size: Normal | Tall.
- The grid always fits the screen width at every setting.

### Themes

- **Lobby**: pencil on lined loose-leaf paper (red margin line, handwritten font, slightly
  imperfect grid).
- **Whiteboard**: clean white, marker font, thick marker lines, scribbled cross-off in the
  completer's color.
- **Dark Scoreboard**: near-black, bold condensed type, scoreboard-light grid lines, completed
  squares light up in the completer's color.
- Fonts via `next/font` (e.g. Patrick Hand / Gochi Hand for pencil, Permanent Marker for
  marker, Bebas Neue / Oswald for scoreboard).

### Night-out realities

Dark bars, bad signal, one-handed use. Optimistic completions, no blocking spinners, no Wake
Lock, camera-first capture with background upload. Instant return: active game ID + last
board state cached in localStorage; root redirects to the active board; service worker caches
the app shell; web manifest; clear the active game on end.

## Tech stack

- Next.js (App Router) + TypeScript, deployed on Vercel.
- Tailwind CSS (v4, CSS-first config in `src/app/globals.css`).
- Supabase:
  - Postgres (schema via Supabase CLI migrations).
  - Realtime `postgres_changes`, filtered by `game_id`.
  - Storage: private bucket `game-media`, served via short-lived signed URLs.
  - Auth: Anonymous sign-ins (no accounts).
- Motion (`motion` package, formerly Framer Motion) + SVG scribbles for animation.
- Lucide icons (`lucide-react`), sparingly.
- Vercel Cron → `/api/cron/cleanup` (protected by `CRON_SECRET`, uses the service-role
  client, server-only).

### Supabase clients (`src/lib/supabase/`)

| File | Use | Key |
| --- | --- | --- |
| `client.ts` | Client Components (browser) | anon |
| `server.ts` | Server Components / Server Functions / Route Handlers (`server-only`) | anon + user cookies |
| `proxy.ts` | `updateSession()` used by `src/proxy.ts` to refresh the session | anon |
| `admin.ts` | **Cleanup cron route only** (`server-only`, ESLint-restricted) | service role |

`src/lib/env.ts` validates `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` when a
client is created (never at import time, so `next build` works without `.env.local`).

## Project Constraint Block

These are invariants. Every phase must keep all of them true.

- enable RLS on every table at creation; never weaken or disable RLS policies
- every new table's migration includes explicit GRANTs to the authenticated role matching exactly the verbs its RLS policies allow
- a user may only read or write rows for games they are a player in (membership check via players.user_id = auth.uid())
- keep all state-changing game actions RPC-owned (security definer functions with internal membership/role checks); do not reimplement game rules in TypeScript or write tables directly from the client
- host-only actions (start_game, end_game, free-space toggle, undo of others' completions) are enforced in the RPC, not just hidden in the UI
- squares cannot be edited once a game is active; completions cannot happen in lobby or ended games
- use Supabase CLI migrations for every schema change — no dashboard edits, no raw SQL outside migrations
- never expose SUPABASE_SERVICE_ROLE_KEY to browser code or prefix it NEXT_PUBLIC_; it is used only in the cleanup cron route
- storage bucket game-media is private; media is served only via short-lived signed URLs to game members
- official starter-pack content stays app-store-safe
- the board must fit the screen width at every setting — no horizontal scrolling
- no keep-screen-awake / Wake Lock
- completions update optimistically on the completer's phone and must reconcile correctly with the server, including after offline periods

## Data model

- **games**: `id`, `join_code` (8-char, unguessable), `name`, `host_user_id`, `status`
  (`lobby` | `active` | `ended`), `free_center` bool, `created_at`, `started_at`, `ended_at`,
  `auto_end_at`, `expires_at` (`created_at` + 30 days).
- **players**: `id`, `game_id`, `user_id`, `display_name`, `color`, `is_ready`, `joined_at`;
  unique (`game_id`, `user_id`); max 10 per game.
- **squares**: `id`, `game_id`, `position` 0–24, `label`, `details`, `target_count` default 1,
  `current_count` default 0, `completed_by_player_id` nullable, `completed_at`, `updated_at`;
  unique (`game_id`, `position`).
- **media**: `id`, `game_id`, `square_id`, `player_id`, `storage_path`, `kind`
  (`photo` | `video`), `created_at`.

## Server logic (RPCs)

All state changes go through these Postgres functions: `security definer`, with explicit
membership / role / status checks inside, `search_path` pinned. The client never writes
tables directly.

| RPC | Who | Rules |
| --- | --- | --- |
| `create_game` | any signed-in (anonymous) user | creates game + host player + 25 squares |
| `join_game(code, display_name)` | any signed-in user | lobby or active (late join); max 10 players; assigns a distinct color |
| `set_ready` | player | lobby only |
| `update_square` | player | lobby only; label ≤40, details ≤200; last write wins |
| `start_game` | host only | lobby only; all players ready; sets `started_at`, `auto_end_at` (+24h) |
| `complete_square` | player | active only |
| `increment_square` | player | active only; completes at `target_count`, credit to whoever hits it |
| `undo_completion` | completer or host | active only |
| `end_game` | host only | active only |
| `register_media` | player | records an uploaded object under the game's storage prefix |

The free-space toggle is host-only and enforced in the RPC that applies it.

## Media rules

- Photos are compressed client-side to max 1600px long edge, JPEG.
- Videos: max 15s and 50MB, checked after selection.
- Upload in the background; never block the board.
- Recap shows media in board order, with per-item save and a "Download all" zip.
- Show an "Album available until [date]" nudge.
- Bucket `game-media` is private; serve only via short-lived signed URLs to game members.

## 30-day expiry

- "Your games" = games on this phone from the last 30 days.
- A daily Vercel Cron hits `/api/cron/cleanup` (requires `CRON_SECRET`). It auto-ends active
  games past `auto_end_at`, deletes storage objects for expired games (`expires_at` passed),
  then deletes the expired game rows (cascade to players, squares, media).

## Known limitation

No accounts means "Your games" lives on one phone (keyed by the anonymous Supabase user ID). Clearing browser data or switching phones loses history.

## Coding conventions

- TypeScript `strict`; no `any` unless justified in a comment.
- Tailwind for styling; theme tokens as CSS variables.
- Motion (`motion/react`) for animation; respect `prefers-reduced-motion` (Motion's
  `useReducedMotion` / CSS media query) for every animation.
- No emoji as UI icons. Lucide icons, sparingly.
- Mobile-first; tap targets ≥44px; one-handed reachable primary actions.
- The board fits the screen width at every text/square-size setting — no horizontal scroll.
- Visual style: no purple/blue gradients, no glassmorphism, no glow effects.
- No Wake Lock / keep-screen-awake.
- Game rules live in SQL RPCs, not TypeScript. TS may only predict outcomes optimistically
  and must reconcile with server state.
- Never import `@/lib/supabase/admin` outside `src/app/api/cron/cleanup/route.ts` (ESLint
  enforces this). Never reference the service-role key anywhere else.
- Run `npm run lint` and `npm run build` before declaring a task done.

### Folder layout

```
src/
  app/                    routes (App Router)
    g/[code]/             join link route
    game/[id]/            lobby / live board / recap
    api/cron/cleanup/     daily cleanup (service role)
  components/             UI components
  content/packs/          typed starter packs
  lib/                    shared utils (env.ts, ...)
    supabase/             client.ts, server.ts, proxy.ts, admin.ts
  types/                  shared types (generated DB types go here)
  proxy.ts                session-refresh request handler (Next 16 "proxy")
supabase/
  migrations/             Supabase CLI migrations (the only way to change schema)
```

## Next.js 16 notes

- `cacheComponents: true` is on. Route handlers and pages must NOT export `dynamic`, `runtime` or
  `revalidate` segment config (the build rejects them); call `await connection()` from `next/server`
  to opt a handler out of prerendering, and keep `params`/`cookies()`/`useSearchParams` reads under a
  `<Suspense>` boundary. Route handlers run on Node by default.
- Middleware is `src/proxy.ts` (exports `proxy`), not `middleware.ts`.

## Git and migration workflow

- Work on the assigned branch; do not commit to `main` directly.
- Every schema, RLS, grant, function, storage-bucket or storage-policy change is a new file in
  `supabase/migrations/` created with `supabase migration new <name>`. Never edit an applied
  migration; add a new one. No dashboard edits, no raw SQL outside migrations.
- Apply locally with `supabase db reset` / `supabase migration up`; push with
  `supabase db push`.
- Regenerate types after schema changes (`supabase gen types typescript` → `src/types/`).
- Never commit `.env*.local` or any secret.

## Database API

Source of truth: `supabase/migrations/` (schema + RLS, RPCs, storage). Types: `src/types/database.ts`
(generated). Every rule below is enforced in SQL and covered by `npm run db:test`.

### Calling conventions

- Call RPCs with `supabase.rpc("<name>", { ...args })`. Arguments are **named**: use the exact names
  below. Each RPC returns a single object (not an array), except `auto_end_due_games` (a number).
- Errors: `error.code === "P0001"` and `error.message` is one of the stable snake_case codes below.
  Map codes to copy in the UI; never show raw messages. `error.code === "42501"` means the role has
  no privilege at all (e.g. called without a session); treat it as a bug.
- Every RPC needs a signed-in (anonymous) user, otherwise `not_authenticated`.
- Game-scoped RPCs (everything taking `game_id`) answer `game_not_found` both for a nonexistent game
  and for a game the caller is not a player in, so membership cannot be probed.
- **Effective status**: an `active` game whose `auto_end_at <= now()` is treated as ended by every RPC
  (completions get `game_not_active`, joins get `game_ended`, `peek_game` says `ended`) even before
  the daily cron sets `status = 'ended'`. The UI should compute
  `ended = status === "ended" || (status === "active" && auto_end_at <= now)`.
- Errors are checked in the order listed in each row; the first failing check wins.

### Input rules (applied by the RPCs; the client may pre-validate with the same limits)

| Field | Rule |
| --- | --- |
| game `name` | whitespace runs collapsed to one space, trimmed; 1–60 chars |
| `display_name` / `host_name` | collapsed + trimmed; 1–24 chars |
| square `label` | collapsed + trimmed (single line); 0–40 chars; `null` → `''` |
| square `details` | trimmed (inner newlines kept); 0–200 chars; `null` → `''` |
| `target_count` | integer 1–99; `null` → 1 (1 = normal square, >1 = counter square) |
| `position` | integer 0–24, row-major (`row * 5 + col`); 12 is the center |
| join `code` | upper-cased, non-alphanumerics stripped (so `abcd-efgh` works); 8 chars from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` |

### RPCs

| RPC (exact argument names) | Returns | Who / when | Errors, in check order |
| --- | --- | --- | --- |
| `create_game(name text, host_name text, free_center boolean = true, squares jsonb = '[]')` | `games` row | any signed-in user; caller becomes host and player color 0 (`is_ready = false`); 25 squares created | `not_authenticated`, `invalid_name`, `invalid_display_name`, then per square: `invalid_squares` / `label_too_long` / `details_too_long` / `invalid_target_count`; `join_code_generation_failed` (practically never) |
| `join_game(code text, display_name text)` | `players` row | any signed-in user; game in `lobby` or `active` (late join). Already a member: returns the existing row (any status) and updates `display_name` unless ended. New players get the lowest free color 0–9 | `not_authenticated`, `invalid_display_name`, `game_not_found`, `game_ended` (ended, overdue or expired), `game_full` (10 players) |
| `peek_game(code text)` | `game_preview` | any signed-in user (join screen, no membership needed) | `not_authenticated`, `game_not_found` |
| `set_ready(game_id uuid, ready boolean)` | `players` row (caller) | player; `lobby` only | `not_authenticated`, `game_not_found`, `game_not_in_lobby`, `invalid_argument` (`ready` null) |
| `update_square(game_id uuid, position integer, label text, details text, target_count integer)` | `squares` row | any player; `lobby` only; replaces label/details/target (last write wins), `current_count` reset to 0 | `not_authenticated`, `game_not_found`, `game_not_in_lobby`, `invalid_position`, `label_too_long`, `details_too_long`, `invalid_target_count` |
| `set_free_center(game_id uuid, enabled boolean)` | `games` row | host only; `lobby` only | `not_authenticated`, `game_not_found`, `not_host`, `game_not_in_lobby`, `invalid_argument` (`enabled` null) |
| `start_game(game_id uuid)` | `games` row | host only; `lobby` only; **every** player incl. the host must be ready. Sets `status = 'active'`, `started_at = now()`, `auto_end_at = started_at + 24h`. If `free_center`: square 12 completed with `completed_by_player_id = null`, `current_count = target_count`, label `'FREE'` if blank | `not_authenticated`, `game_not_found`, `not_host`, `game_not_in_lobby`, `players_not_ready` |
| `complete_square(game_id uuid, position integer)` | `square_result` | any player; `active` only; only squares with `target_count = 1`. Already completed (by anyone, incl. free center) → `applied = false` + current row, **no error** | `not_authenticated`, `game_not_found`, `game_not_active`, `invalid_position`, `is_counter` (use `increment_square`) |
| `increment_square(game_id uuid, position integer, expected_count integer = null)` | `square_result` | any player; `active` only; counter squares (`target_count > 1`). Atomic +1; reaching the target completes it and credits the caller. Already completed → `applied = false`. With `expected_count`, only applies if `current_count = expected_count` (compare-and-set: send the count you saw so a retried request never double-counts; on `applied = false` adopt the returned row) | `not_authenticated`, `game_not_found`, `game_not_active`, `invalid_position`, `not_counter` |
| `undo_completion(game_id uuid, position integer)` | `square_result` | the completer or the host; `active` only. Clears completion; `current_count = target_count - 1` (0 for normal squares). Not completed → `applied = false`, no error. Free center (completed by nobody) can never be undone | `not_authenticated`, `game_not_found`, `game_not_active`, `invalid_position`, `not_allowed` |
| `end_game(game_id uuid)` | `games` row | host only; from `lobby` or `active`; sets `status = 'ended'`, `ended_at` (= `auto_end_at` if already overdue, else now). Already ended → returns row unchanged | `not_authenticated`, `game_not_found`, `not_host` |
| `register_media(game_id uuid, position integer, storage_path text, kind text)` | `media` row | any player; game `active` or `ended`, before `expires_at`; square must be completed. `storage_path` = `<game_id>/<segments>` where each segment matches `[A-Za-z0-9_-][A-Za-z0-9._-]*`, max 512 chars; `kind` is `'photo'` or `'video'`. Same path again by the same player/square → returns the existing row | `not_authenticated`, `game_not_found`, `game_not_started` (lobby), `game_expired`, `invalid_kind`, `invalid_storage_path`, `invalid_position`, `square_not_completed`, `invalid_storage_path` (path already used by someone else) |
| `auto_end_due_games()` | `number` (games ended) | **service_role only** (cleanup cron); no `auth.uid()` check. Ends every `active` game with `auto_end_at <= now()`, setting `ended_at = auto_end_at` | `42501` for any other role |

Policy helpers (EXECUTE for `authenticated`, used by RLS; the UI rarely needs them):
`is_game_member(game_id uuid) → boolean`, `is_game_host(game_id uuid) → boolean`,
`can_upload_game_media(game_id uuid) → boolean`, `safe_uuid(value text) → uuid | null`.

### Return shapes

- `games`: `id, join_code, name, host_user_id, status ('lobby'|'active'|'ended'), free_center, created_at, started_at, ended_at, auto_end_at, expires_at`.
- `players`: `id, game_id, user_id, display_name, color (0–9 palette index), is_ready, joined_at`. "Me" is the row whose `user_id` equals the session user id.
- `squares`: `id, game_id, position, label, details, target_count, current_count, completed_by_player_id (null + completed_at set = free center), completed_at (null = open), updated_at`.
- `media`: `id, game_id, square_id, player_id, storage_path, kind ('photo'|'video'), created_at`.
- `square_result`: `{ applied: boolean }` plus every `squares` column. `applied = true` means this call
  changed the square; either way the square columns are the authoritative state after the call, so
  optimistic clients overwrite their local square with them. (Generated types mark composite fields
  nullable; in practice only `completed_by_player_id` and `completed_at` can be null.)
- `game_preview`: `{ name, status, player_count, free_center }`; `status` is the effective status.

### Error codes

| `error.message` | Meaning (suggested UI copy) |
| --- | --- |
| `not_authenticated` | No session yet. Sign in anonymously and retry. |
| `game_not_found` | "We couldn't find that game." (unknown code/id, or not a player in it) |
| `game_ended` | "This game has already ended." |
| `game_full` | "This game is full (10 players)." |
| `game_not_in_lobby` | "The game has already started." (lobby-only action) |
| `game_not_active` | "The game isn't live." (lobby, ended, or past its 24h limit) |
| `game_not_started` | "Media can be added once the game starts." |
| `game_expired` | "This album has expired." |
| `not_host` | "Only the host can do that." |
| `not_allowed` | "Only the person who completed it or the host can undo this." / the free space can't be undone |
| `players_not_ready` | "Everyone needs to tap Ready first." |
| `invalid_name` | Game name must be 1–60 characters. |
| `invalid_display_name` | Name must be 1–24 characters. |
| `invalid_squares` | Malformed `squares` payload (client bug). |
| `invalid_position` | Position outside 0–24 (client bug). |
| `label_too_long` | Square text is limited to 40 characters. |
| `details_too_long` | Details are limited to 200 characters. |
| `invalid_target_count` | Counter target must be 1–99. |
| `is_counter` | Counter squares complete via `increment_square`. |
| `not_counter` | `increment_square` on a normal square (client bug). |
| `square_not_completed` | Media can only be attached to completed squares. |
| `invalid_storage_path` | Path not under `<game_id>/`, malformed, or already used by someone else. |
| `invalid_kind` | `kind` must be `photo` or `video`. |
| `invalid_argument` | A required boolean was null (client bug). |
| `join_code_generation_failed` | Could not allocate a join code; retry. |

### Reads, Realtime, Storage, cron

- **Reads**: `authenticated` may `select` from `games`, `players`, `squares`, `media` only for games it
  is a player in (RLS via `is_game_member`). Direct INSERT/UPDATE/DELETE fail with `42501`; all writes
  go through the RPCs. `anon` has no table access at all.
- **Realtime**: all four tables are in `supabase_realtime` with `replica identity full`. Subscribe to
  `postgres_changes` with filter `game_id=eq.<id>` (`players`, `squares`, `media`) and `id=eq.<id>`
  (`games`); RLS decides who receives events. A square's `updated_at` strictly increases with every
  change (stamped after the row lock), so drop any square event older than the row you hold.
- **Storage** (`game-media`, private, 50 MB, jpeg/png/webp/heic/mp4/quicktime/webm): object name
  `<game_id>/<position>/<uuid>.<ext>` (lower-case game id as returned by the DB). Members may upload
  while the game is active or ended and before `expires_at`, only as themselves; upload with
  `upsert: false` (there is no UPDATE policy). Then call `register_media` with the same path. Read
  only via `createSignedUrl` (members only). The uploader or the host may delete an object (there is
  no RPC that deletes a `media` row yet).
- **Cron** (`/api/cron/cleanup`, service-role client): `rpc("auto_end_due_games")`, then remove
  storage objects of games with `expires_at < now()`, then `delete from games where expires_at < now()`
  (cascades to players, squares, media). service_role keeps its table privileges for this.

### Regenerating `src/types/database.ts`

Against a real project: `npx supabase gen types typescript --linked --schema public`. Locally without
Docker, after `npm run db:test` has built `bingo_test`:

```
psql postgresql://postgres@127.0.0.1:54329/bingo_test -c "drop extension if exists pgcrypto"   # shim-only, keeps it out of the types
npx supabase gen types typescript --db-url "postgresql://postgres@127.0.0.1:54329/bingo_test?sslmode=disable" --schema public
```

The CLI output is unformatted; format it before committing (it was reprinted with the TypeScript
compiler's printer, 2-space indent) and keep the header comment.

### Running the DB tests

- `npm run db:test` (= `scripts/db-test.sh`). Needs `psql` and a local Postgres 16+ cluster at
  `127.0.0.1:54329` with a trust-auth superuser `postgres` (override with `BINGO_DB_HOST`,
  `BINGO_DB_PORT`, `BINGO_DB_USER`). No Docker, no Supabase project.
- It drops and recreates the database **`bingo_test`** (never any other name), applies
  `supabase/tests/local_shim.sql`, applies every migration in filename order (one transaction each,
  `ON_ERROR_STOP`), loads `supabase/tests/test_helpers.sql`, then runs every
  `supabase/tests/*.test.sql` and `*.test.sh`. It prints one `PASS (<id>)` / `FAIL (<id>)` line per
  test and exits non-zero on any failure or if a required id (a)–(n) did not pass.
- Writing a test: `select tests.run('<id>', '<description>', $body$ <plpgsql block> $body$);`. The
  block runs in a subtransaction that is always rolled back. Use `tests.make_game(n, free_center,
  squares)` / `tests.start_game(f)` fixtures, `tests.login(uid)` / `tests.login_anon()` /
  `tests.login_service()` / `tests.logout()` to switch roles (sets `request.jwt.claims` and
  `SET LOCAL ROLE`), and `tests.is` / `tests.ok` / `tests.throws(stmt, code)` /
  `tests.denied(stmt)` (privilege missing) / `tests.rls_denied(stmt)` (RLS rejected the row).
  `*.test.sh` files get the database URL as `$1` and print their own PASS/FAIL line (used for the
  multi-session concurrent-join test).
- Shim caveat: the shim only emulates what the migrations touch: the `anon` / `authenticated` /
  `service_role` / `authenticator` roles, Supabase-style default privileges on `public`,
  `auth.users` (stub) and `auth.uid()/jwt()/role()` read from `request.jwt.claims`, stub
  `storage.buckets` / `storage.objects` (RLS on) with `storage.foldername()`, and the
  `supabase_realtime` publication. No PostgREST, GoTrue, storage server (so bucket size/MIME limits
  and owner stamping are not exercised; tests set `owner`/`owner_id` themselves) or Realtime server.
  It runs Postgres 16 while hosted is 17, and it installs `pgcrypto` into `public` (hosted:
  `extensions`), so migrations must not rely on pgcrypto. Never apply the shim or `test_helpers.sql`
  to a real project. A green suite is necessary but not sufficient: after `npx supabase db push`,
  smoke-test create/join/complete/upload against the real project.
