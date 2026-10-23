# Deploy checklist (Vercel + Supabase)

Solo-shipping checklist for Bingo Night. Work top to bottom; each box is a
real failure mode seen on first deploys.

## Before the first deploy

- [ ] Supabase project exists, **Anonymous sign-ins** enabled, and
      `npx supabase db push` has applied `supabase/migrations/*` (see
      `HUMAN_STEPS.md` §1–2).
- [ ] In Supabase **Database → Replication**, the `supabase_realtime`
      publication lists `games`, `players`, `squares`, `media`.
- [ ] In Supabase **Storage**, bucket `game-media` exists and is **private**.
- [ ] `package.json` has `"engines": { "node": ">=22" }` so Vercel's default
      Node cannot drift under the build.

## Environment variables (Vercel → Project → Settings → Environment Variables)

Vercel does not read `.env.local`. Add every variable for **Production** and
**Preview**:

| Variable | Scope | Notes |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Prod + Preview | `https://<ref>.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Prod + Preview | anon public key |
| `SUPABASE_SERVICE_ROLE_KEY` | Prod + Preview | **server-only**, used by `/api/cron/cleanup` only. Never add a `NEXT_PUBLIC_` prefix. |
| `CRON_SECRET` | Prod (+ Preview) | long random string; Vercel Cron sends it as `Authorization: Bearer` |
| `NEXT_PUBLIC_APP_URL` | Prod + Preview | the public origin used in invite links, e.g. `https://bingo-night.vercel.app` (Preview can use the preview URL or be left as the prod URL) |

`NEXT_PUBLIC_*` values are inlined at **build** time. Changing them requires a
redeploy, not just a restart.

## Region and runtime

- [ ] Set the Vercel function region to match the Supabase project's region
      (`vercel.json` → `"regions": ["<iad1|fra1|…>"]`). Every RPC call is a
      database round-trip; a mismatched region adds real latency.
- [ ] `vercel.json` keeps the daily cron `17 9 * * *` → `/api/cron/cleanup`
      (Hobby plan allows one daily cron). After the first run, open
      **Vercel → Project → Cron Jobs** and confirm a 200 with a JSON report.

## Supabase Auth URL configuration

- [ ] **Authentication → URL Configuration**: Site URL = the production URL;
      add the production URL and `https://*-<team>.vercel.app` preview
      pattern to Redirect URLs. Anonymous sign-in itself needs no redirect,
      but cookie refresh via the proxy should not log warnings.

## Preview deployment smoke test (before promoting to production)

Open the preview URL on two phones (or a phone and an incognito window):

- [ ] Home → New game → Night Out → lobby shows the code.
- [ ] Second phone joins via the invite link; both see two players with
      different colors **within a second** (Realtime). If it takes ~15 s, the
      publication is missing a table or RLS blocks the event: check
      Replication and that the joiner is a member.
- [ ] Both ready → Start → the start transition plays on both phones.
- [ ] Complete a square → cross-off + toast on the other phone.
- [ ] Add a photo → status reaches "Photo added"; open **Storage →
      game-media** and confirm the object under `<game_id>/<position>/`.
- [ ] Host ends the game → both phones land on the recap; photos load via
      signed URLs (private bucket).
- [ ] Add to Home Screen on iPhone; reopen with Wi-Fi/cellular off → the
      shell still renders (service worker), game data honestly fails.

## After the first real traffic

- [ ] Check **Vercel → Logs** once for 500s or `Missing NEXT_PUBLIC_…`
      errors (env vars are the first suspect when prod differs from local).
- [ ] Check the first cron run's report body: `endedGames`, `expiredGames`,
      `deletedGames`, `errors: []`.
- [ ] Shipped a change to `public/sw.js`? Bump `CACHE_VERSION` in
      `public/sw-policy.js` so clients drop old caches.

## Custom domain (optional)

Add it in **Vercel → Domains**, create the DNS records Vercel shows, give
propagation a few hours, then update `NEXT_PUBLIC_APP_URL` and the Supabase
Site URL and redeploy.
