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

## Developing locally

Without a hosted Supabase project you can run against the local stand-in backend
(real Auth + PostgREST; Storage returns 501 and Realtime never emits events, so other
players' changes need a refresh). See `scripts/local-backend/README.md`.

```bash
npm run backend:status          # or: npm run backend:reset && npm run backend:start
npm run backend:env > .env.local
npm run dev
```

Tests:

- `npm run test` — Vitest unit tests (starter-pack content rules, palette contrast).
- `npm run e2e` — Playwright (Chromium, 375×812): two browser contexts create and join a
  game. Starts `npm run dev` on `127.0.0.1:3000` or reuses one already running.

## Scripts

- `npm run dev` — dev server (Turbopack)
- `npm run build` — production build
- `npm run lint` — ESLint
- `npm run test` — unit tests (Vitest)
- `npm run e2e` — end-to-end tests (Playwright)
