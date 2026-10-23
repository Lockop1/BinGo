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

## Git and migration workflow

- Work on the assigned branch; do not commit to `main` directly.
- Every schema, RLS, grant, function, storage-bucket or storage-policy change is a new file in
  `supabase/migrations/` created with `supabase migration new <name>`. Never edit an applied
  migration; add a new one. No dashboard edits, no raw SQL outside migrations.
- Apply locally with `supabase db reset` / `supabase migration up`; push with
  `supabase db push`.
- Regenerate types after schema changes (`supabase gen types typescript` → `src/types/`).
- Never commit `.env*.local` or any secret.
