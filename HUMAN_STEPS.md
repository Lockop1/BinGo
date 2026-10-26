# Human steps (do these when you're back)

The sandbox that built this app cannot reach Supabase or Vercel, so the
steps below could not be done for you. Everything else is built and tested
against a local Postgres + PostgREST + GoTrue stand-in (see
`scripts/local-backend/README.md`). Work through this list top to bottom.

## 1. Create the Supabase project (~5 min)

1. https://supabase.com/dashboard → **New project**. Any name/region. Save the
   database password somewhere; you need it for step 2.
2. **Authentication → Sign In / Providers → Anonymous sign-ins → Enable**.
   (`supabase/config.toml` also has `enable_anonymous_sign_ins = true`, but the
   hosted project needs the dashboard toggle. Do NOT run `supabase config push`: `config.toml` holds local-only URLs.)
3. **Project Settings → API**: copy the **Project URL**, the **anon public** key
   and the **service_role** key.
4. On your machine, in the repo root, create `.env.local`:

   ```
   NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co
   NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key>
   SUPABASE_SERVICE_ROLE_KEY=<service_role key>   # server-only, never NEXT_PUBLIC_
   CRON_SECRET=<any long random string>
   NEXT_PUBLIC_APP_URL=http://localhost:3000
   ```

## 2. Push the schema (~2 min)

```
npm install
npx supabase login            # opens a browser for an access token
npx supabase link --project-ref <ref>
npx supabase db push          # applies supabase/migrations/* in order (6 files)
```

Deploy order matters: the app and the schema must move together (`npx supabase db push`,
then deploy the matching app build). An old app build against a newer schema would send
`increment_square` arguments the database no longer accepts until players reload.

Then verify in the dashboard: **Database → Replication** shows the
`supabase_realtime` publication including `games`, `players`, `squares`,
`media`; **Storage** shows a private bucket `game-media`.

## 3. Run it locally against the real project

```
npm run dev
```

Open http://localhost:3000 in a normal window and an incognito window; create
a game in one, join it from the other.

## 3b. Optional: analytics (PostHog free tier, ~3 min)

1. https://posthog.com → new project (US or EU cloud). Copy the **Project API key**
   (`phc_…`) and the ingestion host shown in the project settings
   (`https://us.i.posthog.com` or `https://eu.i.posthog.com`).
2. In the PostHog project settings, enable **Discard client IP data** so no IP
   addresses are stored. The app already sends no names, codes, ids or URLs.
3. Add to `.env.local` and to Vercel:

   ```
   NEXT_PUBLIC_POSTHOG_KEY=phc_...
   NEXT_PUBLIC_POSTHOG_HOST=https://us.i.posthog.com
   ```

   Leave both empty to run with analytics off.

## 4. Deploy to Vercel

1. Import the GitHub repo in Vercel (framework preset: Next.js).
2. **Environment variables** (Production + Preview):
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY` (server-only; Vercel keeps it off the client
     because it has no `NEXT_PUBLIC_` prefix)
   - `CRON_SECRET` (Vercel Cron sends it as a bearer token to
     `/api/cron/cleanup`)
   - `NEXT_PUBLIC_APP_URL` = your production URL (e.g. `https://bingo-night.vercel.app`)
   - `NEXT_PUBLIC_POSTHOG_KEY`, `NEXT_PUBLIC_POSTHOG_HOST` (optional, see 3b)
3. Deploy. `vercel.json` already schedules the daily cleanup cron.
4. In Supabase **Authentication → URL Configuration**, set **Site URL** to the
   production URL and add it to **Redirect URLs**.

## 5. Real-device check

Open the production URL on an iPhone (Safari) and an Android phone, add it to
the home screen, and run one full game: create → join → edit → ready → start →
complete → photo → bingo → end → recap.

---
Items below are filled in by the build as phases land.

- [x] Phase 1 migrations ready to push (`supabase/migrations/2026102320425{4,6,8}_*.sql`)
- [x] Cron route + `vercel.json` ready (daily 09:17 UTC; set `CRON_SECRET` in Vercel)
- [x] Deploy checklist written: see `DEPLOY.md`
