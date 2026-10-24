# Bingo Night

Mobile-first activity bingo for friend groups on a night out. Built with Next.js, Tailwind
CSS and Supabase. Project rules and architecture live in [`CLAUDE.md`](./CLAUDE.md); the
build plan is in [`PHASES.md`](./PHASES.md).

## Local setup

1. **Create a Supabase project** at [supabase.com](https://supabase.com).
2. **Enable Anonymous sign-ins**: Authentication > Sign In / Providers > Anonymous sign-ins.
3. **Copy keys into `.env.local`**:
   ```bash
   cp .env.example .env.local
   ```
   Fill in `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` from Project
   Settings > API, and set `NEXT_PUBLIC_APP_URL=http://localhost:3000`.
   `SUPABASE_SERVICE_ROLE_KEY` and `CRON_SECRET` are only needed to run the cleanup cron
   route. Never prefix the service-role key with `NEXT_PUBLIC_`.
4. **Install and run**:
   ```bash
   npm install
   npm run dev
   ```
   Open [http://localhost:3000](http://localhost:3000).

Schema changes go through Supabase CLI migrations in `supabase/migrations/` (see
`CLAUDE.md`).

## Analytics

Keep `NEXT_PUBLIC_POSTHOG_HOST` on PostHog's own origin (`us.i.posthog.com` / `eu.i.posthog.com`). Do not proxy it through a same-origin rewrite: same-origin requests would carry the Supabase auth cookies.

Optional, privacy-first product analytics via PostHog (`src/lib/analytics.ts`). It is off
unless `NEXT_PUBLIC_POSTHOG_KEY` is set (`NEXT_PUBLIC_POSTHOG_HOST` defaults to
`https://us.i.posthog.com`), and off for browsers sending Do Not Track or Global Privacy
Control; when off, `posthog-js` is never loaded. Only eight events with allow-listed counts
and flags are sent (`game_created`, `player_joined`, `game_started`, `square_completed`,
`media_uploaded`, `game_ended`, `recap_viewed`, `play_again`). No names, join codes, game or
user ids, square text, URLs or referrers; no autocapture, pageviews, session recording,
surveys, cookies or stored identifiers (a fresh anonymous id per page load).
`e2e/analytics.spec.ts` checks the payloads; it is skipped unless the dev server and Playwright
both run with `NEXT_PUBLIC_POSTHOG_KEY=phc_test NEXT_PUBLIC_POSTHOG_HOST=http://127.0.0.1:<port>/__ph`.

## Developing locally

Without a hosted Supabase project you can run against the local stand-in backend
(real Auth + PostgREST; Storage returns 501 and Realtime never emits events, so other
players' changes arrive through the resync poll, every 15 s by default or
`NEXT_PUBLIC_SYNC_POLL_MS`). See `scripts/local-backend/README.md`.

```bash
npm run backend:status          # or: npm run backend:reset && npm run backend:start
node scripts/local-backend/cli.mjs env > .env.local   # (not via npm run: npm adds banner lines)
npm run dev                     # NEXT_PUBLIC_ENABLE_SW=1 npm run dev to run the service worker too
```

If Turbopack serves stale files in dev, `rm -rf .next/dev` and restart.

Tests:

- `npm run test` — Vitest unit tests (`src/**/*.test.ts`): game reducers, optimistic queue,
  board state, celebrations, toasts, instant return, settings, media pipeline, service-worker
  policy, session handling, cleanup cron, starter-pack content rules, palette contrast.
- `npm run e2e` — Playwright (Chromium, 375×812): create / join, lobby, live board (incl.
  offline), instant return, settings, media, PWA. Starts `npm run dev` on `127.0.0.1:3000`
  (with `NEXT_PUBLIC_SYNC_POLL_MS=1500`, `NEXT_PUBLIC_ENABLE_SW=1`) or reuses one already running.
- `npm run db:test` — the SQL suite (RLS, RPCs, grants) against a local Postgres 16+ at
  `127.0.0.1:54329`; see `CLAUDE.md` > Running the DB tests.

## Scripts

- `npm run dev` — dev server (Turbopack)
- `npm run build` — production build
- `npm run start` — serve the production build
- `npm run lint` — ESLint
- `npm run test` — unit tests (Vitest)
- `npm run e2e` — end-to-end tests (Playwright)
- `npm run db:test` — database tests (`scripts/db-test.sh`)
- `npm run backend:reset` / `backend:migrate` — recreate the local backend database / apply
  pending migrations
- `npm run backend:start` / `backend:stop` / `backend:status` — run (detached), stop or check
  the local backend
- `npm run backend:env` — print the `.env.local` lines for the local backend
- `npm run backend:smoke` — end-to-end check of the local backend with supabase-js
