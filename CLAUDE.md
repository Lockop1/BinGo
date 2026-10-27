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

- 5×5 board; center defaults to a free space (the host can turn it off on the Create screen; the lobby
  shows it but has no toggle).
- Max 10 players, each with a distinct color from a 10-color palette readable on dark and
  light themes.
- Lobby editing: any player edits any square, last write wins, label ≤40 chars, optional
  details ≤200 chars. Squares lock when the game starts.
- Optional counter squares (`target_count`, e.g. 15 signatures): sheet shows 3/15 with +1;
  completes at target; whoever hits the target gets credit.
- Undo: the completer or the host.
- Bingo: rows, columns, both diagonals (12 lines); each new line celebrates once; blackout
  (25/25) gets a bigger celebration and prompts the host to end.
- Only the host ends a game early; otherwise every game ends automatically at its **deadline**
  (`deadline_at`), for everyone at once. The host picks it when creating the game (presets
  "Tonight (3 AM)" (default), "24 hours", "This weekend (Sunday 11:59 PM)" or a custom date/time,
  computed on the phone in its time zone; 10 minutes to 7 days ahead) and can change it in the
  lobby until the start. While the game is live the host may **extend it once**, by up to one day.
  The cleanup cron also ends games past their deadline (backstop).
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
  `deadline_at` (not null, `> created_at`; when the game ends automatically: host-set at creation /
  in the lobby, default now + 24 h on the server), `deadline_extended_at` (null until the host's one
  live extension), `expires_at` (`created_at` + 30 days, whatever the deadline), `next_game_id` /
  `next_join_code` (set by `play_again`; the rematch lobby other players join with one tap),
  `updated_at` (trigger-stamped on every update; clients drop older rows by it).
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
| `create_game` | any signed-in (anonymous) user | creates game + host player + 25 squares, with the host's deadline (10 min – 7 days ahead; none → now + 24 h) |
| `join_game(code, display_name)` | any signed-in user | lobby or active (late join); max 10 players; assigns a distinct color |
| `set_ready` | player | lobby only |
| `update_square` | player | lobby only; label ≤40, details ≤200; last write wins |
| `set_deadline` | host only | lobby only; 10 min – 7 days ahead |
| `start_game` | host only | lobby only; deadline not passed; all players ready; sets `started_at` (the deadline stays as set) |
| `complete_square` | player | active only |
| `increment_square` | player | active only; +1 per tap, idempotent per client action id; completes at `target_count`, credit to whoever hits it |
| `undo_completion` | completer or host | active only |
| `extend_deadline` | host only | active (and not past the deadline) only; once per game; later by at most 1 day |
| `end_game` | host only | lobby or active (ending a lobby is how the host closes it); an overdue game ends at its deadline |
| `leave_game` | player (not the host) | lobby only; deletes the caller's player row |
| `remove_player` | host only | lobby only; deletes another player's row (never the host's) |
| `register_media` | player | records an uploaded object under the game's storage prefix |
| `play_again` | player | ended (or overdue) games only; one rematch per game: creates (or returns) a new lobby with the same name, free center and board, hosted by the first caller; the old game points at it |
| `peek_game_public(code)` | anyone, no session needed (`anon`) | link previews: name, effective status, player count, free center; unknown or expired codes are not found; the only function `anon` may execute |

The free-space toggle is host-only and enforced in the RPC that applies it; so are deadline changes
(`set_deadline`, `extend_deadline`).

## Media rules

- Photos are compressed client-side to max 1600px long edge, JPEG.
- Videos: max 15s and 50MB, checked after selection.
- Upload in the background; never block the board.
- Recap shows media in board order, with per-item save and a "Download all" zip.
- Show an "Album available until [date]" nudge.
- Bucket `game-media` is private; serve only via short-lived signed URLs to game members.

## 30-day expiry

- "Your games" = games on this phone from the last 30 days.
- The album expiry always counts from creation (`expires_at` = `created_at` + 30 days); the deadline
  (and its extension) never moves it.
- A daily Vercel Cron hits `/api/cron/cleanup` (requires `CRON_SECRET`). It ends active games past
  their `deadline_at` (a backstop: every RPC and phone already treats them as ended), deletes storage
  objects for expired games (`expires_at` passed), then deletes the expired game rows (cascade to
  players, squares, media).

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
- Every RPC needs a signed-in (anonymous) user, otherwise `not_authenticated`, except
  `peek_game_public`, which needs no session at all.
- Game-scoped RPCs (everything taking `game_id`) answer `game_not_found` both for a nonexistent game
  and for a game the caller is not a player in, so membership cannot be probed.
- **Effective status**: an `active` game whose `deadline_at <= now()` is treated as ended by every RPC
  (completions get `game_not_active`, joins get `game_ended`, `peek_game` / `peek_game_public` say
  `ended`, `extend_deadline` gets `game_not_active`, `play_again` is allowed) even before the daily
  cron sets `status = 'ended'`. The UI should compute
  `ended = status === "ended" || (status === "active" && deadline_at <= now)` (`effectiveStatus` in
  `lib/game/types.ts`). `deadline_at` is never null; a lobby past its deadline stays a lobby (only
  `start_game` refuses it, with `deadline_passed`).
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
| `deadline_at` (`create_game`, `set_deadline`) | `timestamptz` (send an ISO string); **10 minutes to 7 days from now** (the server accepts a little slack either side for clock drift: `now + 9 min` … `now + 168 h 10 min`); `create_game` with `null` / omitted → `now() + 24 h` |
| `deadline_at` (`extend_deadline`) | strictly later than the current `deadline_at` and at most current `deadline_at` + 24 hours (exact, no slack) |

All deadline caps are elapsed time, written in hours and minutes in SQL (`interval '168 hours'`,
`'24 hours'`), never calendar days: for `timestamptz`, `'1 day'` / `'7 days'` follow the session
`TimeZone`, which any client can set (PostgREST honours `Prefer: timezone=…`), and would be 23 or 25
hours across a DST change. "7 days" and "1 day" in this file mean 168 and 24 hours.

### RPCs

| RPC (exact argument names) | Returns | Who / when | Errors, in check order |
| --- | --- | --- | --- |
| `create_game(name text, host_name text, free_center boolean = true, squares jsonb = '[]', deadline_at timestamptz = null)` | `games` row | any signed-in user; caller becomes host and player color 0 (`is_ready = false`); 25 squares created; `deadline_at` stored (`null` → `now() + 24 h`), `deadline_extended_at = null`. The only `create_game` (the 4-argument one was dropped, so PostgREST never sees two overloads) | `not_authenticated`, `invalid_name`, `invalid_display_name`, then per square: `invalid_squares` / `label_too_long` / `details_too_long` / `invalid_target_count`; `invalid_deadline`; `join_code_generation_failed` (practically never) |
| `join_game(code text, display_name text)` | `players` row | any signed-in user; game in `lobby` or `active` (late join). Already a member: returns the existing row (any status) and updates `display_name` unless the game is effectively ended (ended, active past its deadline, or past `expires_at`: the same test that refuses newcomers). New players get the lowest free color 0–9 | `not_authenticated`, `invalid_display_name`, `game_not_found`, `game_ended` (ended, overdue or expired), `game_full` (10 players) |
| `peek_game(code text)` | `game_preview` | any signed-in user (join screen, no membership needed) | `not_authenticated`, `game_not_found` |
| `peek_game_public(code text)` | `game_preview` | **anyone, including `anon` (no session)**: the same normalisation and result as `peek_game`, for link previews (Open Graph images, chat-app crawlers). Games past `expires_at` count as unknown. Call it with `peekGamePublic` from `lib/game/publicRpc.ts` (plain anon client, works in server code) | `game_not_found` (unknown, malformed or expired code) |
| `set_ready(game_id uuid, ready boolean)` | `players` row (caller) | player; `lobby` only | `not_authenticated`, `game_not_found`, `game_not_in_lobby`, `invalid_argument` (`ready` null) |
| `update_square(game_id uuid, position integer, label text, details text, target_count integer)` | `squares` row | any player; `lobby` only; replaces label/details/target (last write wins), `current_count` reset to 0 | `not_authenticated`, `game_not_found`, `game_not_in_lobby`, `invalid_position`, `label_too_long`, `details_too_long`, `invalid_target_count` |
| `set_free_center(game_id uuid, enabled boolean)` | `games` row | host only; `lobby` only | `not_authenticated`, `game_not_found`, `not_host`, `game_not_in_lobby`, `invalid_argument` (`enabled` null) |
| `set_deadline(game_id uuid, deadline_at timestamptz)` | `games` row | host only; `lobby` only; replaces `deadline_at` (any number of times before the start); never touches `deadline_extended_at` or `expires_at` | `not_authenticated`, `game_not_found`, `not_host`, `game_not_in_lobby`, `invalid_deadline` (null, under 10 minutes or over 7 days (168 h) ahead) |
| `start_game(game_id uuid)` | `games` row | host only; `lobby` only; the deadline must not have passed (`deadline_at > now()`; otherwise the host picks a new one with `set_deadline`); **every** player incl. the host must be ready. Sets `status = 'active'`, `started_at = now()`; `deadline_at` stays as set. If `free_center`: square 12 completed with `completed_by_player_id = null`, `current_count = target_count`, label `'FREE'` if blank | `not_authenticated`, `game_not_found`, `not_host`, `game_not_in_lobby`, `deadline_passed`, `players_not_ready` |
| `complete_square(game_id uuid, position integer)` | `square_result` | any player; `active` only; only squares with `target_count = 1`. Already completed (by anyone, incl. free center) → `applied = false` + current row, **no error** | `not_authenticated`, `game_not_found`, `game_not_active`, `invalid_position`, `is_counter` (use `increment_square`) |
| `increment_square(game_id uuid, position integer, action_id uuid = null)` | `square_result` | any player; `active` only; counter squares (`target_count > 1`). +1 under the square's row lock; reaching the target completes it and credits the caller. Already completed → `applied = false`. `action_id` is a client-generated UUID per tap, sent again unchanged on every retry of that tap: each id counts at most once (a repeat → `applied = false` + the current row, recorded in the internal `square_increments` log), while different ids always all count, so simultaneous and offline taps are never lost. `null` → a plain +1 with no retry protection. Either way, on `applied = false` adopt the returned row | `not_authenticated`, `game_not_found`, `game_not_active`, `invalid_position`, `not_counter` |
| `undo_completion(game_id uuid, position integer)` | `square_result` | the completer or the host; `active` only. Clears completion; `current_count = target_count - 1` (0 for normal squares). Not completed → `applied = false`, no error. Free center (completed by nobody) can never be undone | `not_authenticated`, `game_not_found`, `game_not_active`, `invalid_position`, `not_allowed` |
| `end_game(game_id uuid)` | `games` row | host only; from `lobby` **or** `active` (in the lobby it is the host's way out, since the host cannot `leave_game`); sets `status = 'ended'`, `ended_at` (= `deadline_at` if already overdue, else now). Already ended → returns row unchanged | `not_authenticated`, `game_not_found`, `not_host` |
| `extend_deadline(game_id uuid, deadline_at timestamptz)` | `games` row | host only; the game must be live: `active` **and** `deadline_at > now()` (a game already past its deadline is over and cannot be revived); once per game. Under the game row lock sets `deadline_at` to the new value and `deadline_extended_at = now()`; `expires_at` unchanged | `not_authenticated`, `game_not_found`, `not_host`, `game_not_active` (lobby, ended or past the deadline), `already_extended`, `invalid_deadline` (null, not later than the current deadline, or more than 24 hours later) |
| `leave_game(game_id uuid)` | `boolean` (`true`) | any player except the host; `lobby` only. Deletes the caller's `players` row under the game lock (like `join_game`), freeing the slot and color for the next joiner. The caller is then a non-member (RLS hides the game); they may join again with the code | `not_authenticated`, `game_not_found`, `game_not_in_lobby`, `host_cannot_leave` |
| `remove_player(game_id uuid, player_id uuid)` | `boolean` (`true`) | host only; `lobby` only. Deletes another player's row under the game lock (e.g. someone who wandered off without tapping Ready), so `start_game` is no longer blocked by them | `not_authenticated`, `game_not_found`, `not_host`, `game_not_in_lobby`, `not_allowed` (removing yourself), `player_not_found` (not a player of this game, e.g. already left) |
| `play_again(game_id uuid)` | `games` row (the **new** game) | any player of the old game; the old game must be effectively ended (`ended`, or `active` past `deadline_at`). Under the old game's row lock: if `next_game_id` is set and that game still exists, returns it unchanged (one rematch per game, whoever asks; a later caller is **not** joined, they `join_game(next_join_code, …)`). Otherwise creates a lobby exactly like `create_game` without a deadline (fresh join code, `expires_at`, `deadline_at = now() + 24 h` for the host to edit in the lobby, `deadline_extended_at = null`, 25 squares) with the same `name` and `free_center`, squares copied by position (`label`, `details`, `target_count`; `current_count = 0`, nothing completed, no media; a free center that `start_game` labelled `'FREE'` goes back to blank), the caller as host and player color 0 under their `display_name` from the old game, `is_ready = false`; then sets the old row's `next_game_id` / `next_join_code` (members see it via RLS, Realtime and resync) | `not_authenticated`, `game_not_found`, `game_not_ended`, `join_code_generation_failed` (practically never) |
| `register_media(game_id uuid, position integer, storage_path text, kind text)` | `media` row | any player; game `active` or `ended`, before `expires_at`; square must be completed. `storage_path` = `<game_id>/<segments>` where each segment matches `[A-Za-z0-9_-][A-Za-z0-9._-]*`, max 512 chars; `kind` is `'photo'` or `'video'`. Same path again by the same player/square → returns the existing row | `not_authenticated`, `game_not_found`, `game_not_started` (lobby), `game_expired`, `invalid_kind`, `invalid_storage_path`, `invalid_position`, `square_not_completed`, `invalid_storage_path` (path already used by someone else) |
| `auto_end_due_games()` | `number` (games ended) | **service_role only** (cleanup cron); no `auth.uid()` check. Ends every `active` game with `deadline_at <= now()`, setting `ended_at = deadline_at` (the backstop for the effective status) | `42501` for any other role |

`peek_game_public` is deliberately the **single function `anon` may execute** (SQL test (n) checks
the whole catalog): link previews are fetched by crawlers with no session, the join code is
unguessable (40 random bits), and anyone holding the link already sees the same four fields on the
join screen. `anon` still has no table access and no other function.

Policy helpers (EXECUTE for `authenticated`, used by RLS; the UI rarely needs them):
`is_game_member(game_id uuid) → boolean`, `is_game_host(game_id uuid) → boolean`,
`can_upload_game_media(game_id uuid) → boolean`, `safe_uuid(value text) → uuid | null`.

### Return shapes

- `games`: `id, join_code, name, host_user_id, status ('lobby'|'active'|'ended'), free_center, created_at, started_at, ended_at, deadline_at, deadline_extended_at, expires_at, next_game_id, next_join_code, updated_at`. `updated_at` (not null, `= created_at` on insert) is stamped with `clock_timestamp()` by a `before update` trigger after the row lock, like squares, so it strictly increases with every change of the row (every RPC result carries it). `deadline_at` is never null; `deadline_extended_at` is null until `extend_deadline`. The last two are null until `play_again` creates the rematch; `next_join_code` is that game's `join_code`, so members of the old game can join it without being able to read it (`next_game_id` is nulled if the rematch is ever deleted). The client `Game` type marks `deadline_extended_at`, `next_game_id`, `next_join_code` and `updated_at` optional (snapshots cached by older builds lack them): read them with `?? null`.
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
| `game_not_active` | "The game isn't live." (lobby, ended, or past its deadline) |
| `game_not_ended` | "The game isn't over yet." (`play_again` on a lobby or live game) |
| `game_not_started` | "Media can be added once the game starts." |
| `game_expired` | "This album has expired." |
| `not_host` | "Only the host can do that." |
| `not_allowed` | "Only the person who completed it or the host can undo this." / the free space can't be undone / the host tried to remove themselves |
| `host_cannot_leave` | "The host can't leave. End the game instead." |
| `player_not_found` | "That player has already left." (`remove_player` on someone not in the game) |
| `players_not_ready` | "Everyone needs to tap Ready first." |
| `deadline_passed` | "The deadline has passed. Pick a new one before starting." (`start_game` on a lobby past its `deadline_at`) |
| `already_extended` | "The deadline can only be extended once." |
| `invalid_deadline` | "Pick a time between 10 minutes and 7 days from now." (for `extend_deadline`: the new time must be later than the current deadline, by at most a day) |
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
  go through the RPCs. `anon` has no table access at all (its only privilege is EXECUTE on
  `peek_game_public`).
- **Realtime**: all four tables are in `supabase_realtime` with `replica identity full`. Subscribe to
  `postgres_changes` with filter `game_id=eq.<id>` (`players`, `squares`, `media`) and `id=eq.<id>`
  (`games`); RLS decides who receives events. A square's and a game's `updated_at` strictly increase
  with every change of the row (stamped after the row lock), so drop any square or games event (or
  fetched row) older than the row you hold. Deadline changes (`set_deadline`, `extend_deadline`) arrive
  as ordinary `games` row updates.
- **Storage** (`game-media`, private, 50 MB, jpeg/png/webp/heic/mp4/quicktime/webm): object name
  `<game_id>/<position>/<uuid>.<ext>` (lower-case game id as returned by the DB). Members may upload
  while the game is active or ended and before `expires_at`, only as themselves; upload with
  `upsert: false` (there is no UPDATE policy). Then call `register_media` with the same path. Read
  only via `createSignedUrl` (members only). The uploader or the host may delete an object (there is
  no RPC that deletes a `media` row yet).
- **Cron** (`/api/cron/cleanup`, service-role client): `rpc("auto_end_due_games")`, then remove
  storage objects of games with `expires_at < now()`, then `delete from games where expires_at < now()`
  (cascades to players, squares, media, square_increments). `service_role`'s select / insert / update /
  delete on all five tables are granted explicitly in the migrations, not left to Supabase's default
  privileges for new tables (SQL test (s) checks them).
- **`square_increments`** (counter action log, `action_id` primary key): internal to
  `increment_square`. RLS on with no policies, no privileges for `anon` / `authenticated`, not in the
  Realtime publication; nothing client-facing reads it.

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
  squares)` / `tests.start_game(f)` fixtures, `tests.pass_deadline(game_id, ago)` (time travel as
  postgres: moves `deadline_at` to `now() - ago` and `created_at` / `started_at` back with it, since
  `now()` is fixed within a test), `tests.login(uid)` / `tests.login_anon()` /
  `tests.login_service()` / `tests.logout()` to switch roles (sets `request.jwt.claims` and
  `SET LOCAL ROLE`), and `tests.is` / `tests.ok` / `tests.throws(stmt, code)` /
  `tests.denied(stmt)` (privilege missing) / `tests.rls_denied(stmt)` (RLS rejected the row).
  `*.test.sh` files get the database URL as `$1` and print their own PASS/FAIL line (used for the
  multi-session tests: concurrent joins (t) and concurrent counter +1s (v)).
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

## Client architecture

- **`src/components/`**: `home` (home page, `YourGames`, `InstantReturn`), `create` (form + pack
  picker), `join` (`/g/[code]`), `lobby` (paper lobby: board, `SquareEditor`, dock, invite, `SyncDot`),
  `game` (`GameScreen` routes lobby / board / recap by status, `StartTransition`), `board` (live
  board: `BoardScreen`, `TopBar`, grid, sheets, toasts, `Celebration`), `media` (add/share buttons,
  strip, `useUploadedMedia`), `recap` (summary, story viewer, save / zip), `pwa` (SW registration),
  `ui` (buttons, sheet, fields), `paper` (`PaperPage`), `providers` (`SessionProvider`, `SessionGate`).
- **Identity** (`lib/supabase/auth.ts`): `ensureSession()` (deduped) returns the stored session, signs
  in anonymously only when nothing is stored or the server says the refresh token is dead
  (`classifyRefreshError` = `definitive`, logged once). Any other refresh failure throws
  `SessionReconnectError` and keeps the identity; `SessionProvider` shows "Couldn't reconnect…" and
  retries (`retryDelayMs` backoff + `online`). If auth-js wipes the cookie after a non-final error, the
  keeper asks the same identity back via `refreshSession({ refresh_token })` from its remembered token.
- **Data / sync** (`lib/game/useGame.ts`): parallel selects of `games`/`players`/`squares`/`media`
  (`fetchGameSnapshot`), then one Realtime channel per game (`subscribeToGame`, `postgres_changes` on
  all four tables) plus a full resync on channel `SUBSCRIBED`, tab visible, `online` and a poll every
  `syncPollMs()` (`NEXT_PUBLIC_SYNC_POLL_MS`, default 15 s; 60 s once ended). Events and fetches merge
  through the pure reducers in `realtime.ts` (`applySquareChange`, `mergeSnapshot`, …), which drop any
  square older than the held row by `updated_at` (`isNewerSquare`, µs precision). The games row (event,
  fetch or RPC result via `applyGame`) goes through `mergeGame`: status never moves backwards and a
  forward move always wins; for the same status the newer `updated_at` wins and an older or equal one is
  dropped (`compareGameVersions`, µs precision), so a resync that read the game before an extension or a
  lobby `set_deadline` committed can never undo it; a row without `updated_at` on either side (a
  snapshot cached by an older build) falls back to the status rule alone. `syncState`:
  `live` | `syncing` (a resync > 400 ms, or the cached snapshot awaiting its first answer) | `offline`.
- **Deadline**: every screen follows `effectiveStatus(game)` (`lib/game/types.ts`: `active` past
  `deadline_at` → `ended`). `GameScreen` re-renders the instant `deadline_at` passes (`useRerenderAt`,
  re-armed when an extension arrives), so every phone moves to the recap on time without waiting for
  the cron or the server. Wrappers in `lib/game/rpc.ts`: `createGame({ …, deadlineAt })` (ISO string;
  `null` = server default, 24 h), `setDeadline(gameId, deadlineAt)` (lobby),
  `extendDeadline(gameId, deadlineAt)` (live, once). The board sheets' "Ends <when> (<left>)" line
  reads `deadline_at` (`useDeadlineLine` in `components/board/PlayersSheet.tsx`).
- **Deadline UI** (pure helpers in `lib/deadline/`, clocks in `useNow.ts`, all text only after mount):
  `CreateGameForm` holds the `DeadlinePicker` value (its mount `onChange` fills Tonight) and sends it as
  `deadlineAt`. A selected preset that drifts under 10 minutes away re-resolves the moment it does
  (`useNowUntil` wakes at `tooSoonFromMs`; `refreshDriftedPreset` in `lib/deadline/drift.ts`) and the
  picker says so in one line (`presetRefreshNotice`, "Updated to the next 3 AM — …"); the form judges
  validity on a clock no older than the value and names any other reason Create is disabled
  (`deadlineBlockMessage`). The lobby's `LobbyDeadline` line under the name (`DeadlineSummary`, "Passed"
  once gone) has a host-only "Change" sheet whose picker only fills a draft; Save calls `setDeadline`
  (optimistic overlay in `Lobby`, then `applyGame(row)`); a passed deadline disables Start (`LobbyDock`
  copy). The board's `TopBar` shows `useCountdown`'s label right after the name (muted, ink under 1 h,
  hidden under a toast; tap → Players); a name over 8 characters keeps a floor of about 8 characters, and
  when that leaves too little room the countdown shows only its leading unit ("23h", never cut mid-unit).
  `BoardScreen` pushes `deadlineToast()` ("1 hour left.", tap → Players) when `shouldShowDeadlineToast`
  says so: under an hour and not yet shown for this deadline value, remembered in
  `bingo.deadlineToast.<gameId>`, so a reload never repeats it and an extension allows one more. The
  host's "Extend deadline" (Players sheet, hidden once `deadline_extended_at` is set) opens
  `ExtendDeadlineForm` (+1 h / +3 h / +24 h / custom, ≤ current + 24 h, `lib/deadline/extend.ts`) →
  `extendDeadline`, shown at once via an overlay, reverted with inline copy on error. When the clock ends
  a live game, `GameScreen` sends `game_ended` with `by: "auto"` from the host's phone only.
- **Optimistic layer**: taps go into `pendingActions.ts` (one queue per game, persisted to
  `bingo.pending.<gameId>`): one action at a time per square, squares in parallel, only while online,
  exponential backoff (≤ 30 s) on `unknown` / `not_authenticated`, any other error code is final
  (game-over codes drop the whole queue; ≤ 50 items). `boardState.ts` derives the board as base (newer of
  server row and this phone's last RPC result) + unsettled overlays in tap order, so refetches never
  flip a pending cross-off back; a settled `square_result` row always wins (`applied = false` just
  adopts it). `useBoardState` wires the queue to the RPCs and folds rows back via `applySquare`.
  **Counters use action ids, not compare-and-set**: every queued action has a client UUID
  (`newActionId`, also without `crypto.randomUUID`), kept across retries and reloads; a +1 sends it as
  `increment_square`'s `action_id`, so a retried tap is never counted twice and taps from several
  phones, or made offline and sent later, all count. A counter shows `current_count` + this phone's
  pending +1s (capped at the target), whatever count was on screen when tapping; a +1's
  `applied = false` means "already counted (a retry) or already completed" and is adopted silently.
  Queue items saved by older builds (with `expectedCount`) still restore; the field is ignored.
- **Feedback**: `diffBoards` events → `toasts.ts` (one toast at a time, 2.5 s, ≤ 4 waiting; also
  `mediaToasts`; `GameScreen` shows `droppedNotices` for given-up taps), `celebrations.ts` (each line / blackout once per phone, remembered in
  `bingo.celebrated.<gameId>`; highlight → overlay → host blackout prompt), `lib/haptics.ts`
  (`pulse` on own cross-off / start, `doublePulse` on bingo; no-op where `navigator.vibrate` is missing).
- **Settings** (`lib/settings`): `bingo.settings` = `{ theme, textSize, squareSize }`, validated per
  field; `theme: null` follows `prefers-color-scheme`. `BoardScreen` sets `data-theme` /
  `data-text-size` / `data-square-size`; the CSS tokens live in `globals.css`.
- **Instant return** (`lib/game/activeGame.ts`): `bingo.activeGame` holds the last lobby / active game
  with a full snapshot (board draws before the session or network answers); `bingo.lastEnded` sends the
  next open to the recap once (24 h). `/` decides client-side (`InstantReturn` + `HOME_GUARD_SCRIPT`,
  never a server redirect, so it works from the SW cache); `?stay=1` or the per-tab sessionStorage
  flag `bingo.stayHome` (Leave / Home links) keeps home. The record clears on end, not-found (incl.
  "You're no longer in this game" after the host removed this phone) and Leave. The record carries
  `deadlineAt` (an active record stops being returnable once it passes); records saved by builds from
  before the deadline (the fixed 24 h end field) are upgraded on read by `upgradeLegacyRecord`, with
  the same value the migration backfilled (old end, else `started_at` / `created_at` + 24 h).
- **Media**: `prepareMedia` (photo → JPEG ≤ 1600 px; video ≤ 15 s / 50 MB) → `uploadQueue` (in memory
  only, one item at a time, `<game_id>/<position>/<uuid>.<ext>`, `upsert: false`, 3 tries, then
  `register_media`; wired in `defaultUploadQueue.ts`) → `applyMedia`. Display only through
  `signedUrls.ts` (1 h URLs, batches of 50, cached, re-signed 5 min before expiry). The recap
  (`components/recap`) builds items in board order, saves per item (share sheet / download) or zips all.
- **Rematch** (`PlayAgainLink` in `components/recap/RecapSummary.tsx`, wired from `GameScreen` via
  `Recap`'s `playAgain` prop; the media lab leaves it out): one small muted text link, the very last
  thing in the recap summary. No `next_join_code` on the game → "Play again" (`playAgain` →
  `track("play_again", { source: "recap" })` → `router.push('/game/<new id>')`; if the returned game is
  someone else's, it first joins it). `next_join_code` set and the new game not readable (RLS: not a
  player of it) → "A new game is ready · Join" (`joinGame(next_join_code, <my display_name here>)`).
  Readable → "Go to the new game" ("You started a new game · Go to it" for its host). Errors show the
  `GameError` copy in the same small style. The pointer arrives on the old `games` row via Realtime
  and the resync: the recap refetches once on mount, and `useGame` keeps the live `syncPollMs()` poll
  for `REMATCH_WATCH_MS` (10 min) after the end while `next_join_code` is null, instead of the 60 s
  ended poll. `lib/game/publicRpc.ts` (`peekGamePublic`) is the session-less counterpart of `rpc.ts`
  for server code: a plain `@supabase/supabase-js` anon client without auth persistence.
- **PWA**: `public/sw.js` + pure `public/sw-policy.js` (unit-tested in `lib/pwa/swPolicy.test.ts`):
  only the app shell is cached (navigations network-first with a 3 s fallback, hashed `/_next/static`
  cache-first, icons / fonts / manifest stale-while-revalidate); Supabase, `/api`, RSC and non-GET
  never. Bump `CACHE_VERSION` when rules or layout change. Registered in production, or in dev with
  `NEXT_PUBLIC_ENABLE_SW=1` (the e2e sets it), as `/sw.js?supabase=<origin>[&dev=1]`.
- **Browser storage keys** (all through `lib/storage/local.ts`, never throwing): `bingo.displayName`,
  `bingo.settings`, `bingo.activeGame`, `bingo.lastEnded`, `bingo.pending.<gameId>`,
  `bingo.celebrated.<gameId>`; sessionStorage `bingo.stayHome`; auth lives in @supabase/ssr cookies
  `sb-<ref>-auth-token[.N]`.
- **Tests**: `npm run test` (Vitest, `src/**/*.test.ts`, node env), `npm run e2e` (Playwright,
  Chromium 375×812, starts or reuses `next dev` on :3000 with `NEXT_PUBLIC_SYNC_POLL_MS=1500`),
  `npm run db:test` (SQL suite, see above), `npm run backend:{reset,migrate,start,stop,status,env,smoke}`
  (local stand-in backend, `scripts/local-backend/README.md`). `/dev/media-lab` is a dev-only page
  (404 in production) that runs the real image/video pipeline and the recap on fake data
  (`e2e/media.spec.ts`).
- **Known limitation (local backend)**: real GoTrue + PostgREST, but Realtime never emits events
  (cross-phone changes arrive via the resync poll) and Storage is a stub that returns 501 (e2e calls
  `register_media` through `rpcAs`). Realtime and uploads are only exercised against a real project.
