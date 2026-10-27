# Bingo Night — build report

Branch: `claude/modest-clarke-porll9` (all work committed and pushed).
Date: 2026-10-24.

## What was built

A mobile-first Next.js 16 + Supabase web app for friend-group activity bingo:

- **Home / Create / Join**: silent anonymous identity, "Your games" for the
  last 30 days on this phone, starter packs (Night Out, Day Adventure, Blank,
  all app-store-safe and content-tested), invite links `/g/<code>`.
- **Paper lobby**: live player list with ready checks, shared square editing
  (last write wins, conflict prompt), counter squares, host free-space toggle,
  Leave / host Remove, Start enabled only when everyone is ready.
- **Live board**: Whiteboard and Dark Scoreboard themes, one-second start
  transition on every phone, press-and-hold Complete, +1 counters that count
  exactly once under concurrency and offline, Undo with confirm, toasts in
  the top bar, bingo-line and blackout celebrations once per phone, host End
  game, a quiet deadline countdown, settings (theme / text size / square
  size) that always fit the width.
- **Media and recap**: camera-first photo/video with 1600 px JPEG compression
  and the 15 s video check, background uploads to the private `game-media`
  bucket via signed URLs, Share to group chat, story-style recap with per-item
  Save and Download all, "Album available until" nudge.
- **Instant return and offline**: web manifest + icons, a hand-written service
  worker that caches the app shell and never caches game data, active-game
  snapshot so reopening lands on the board before the network answers,
  persisted offline completion queue that syncs on reconnect.
- **Backend**: 4 Supabase CLI migrations — RLS on every table with select-only
  grants, 15 security-definer RPCs that own every rule (membership, host-only,
  lobby/active locks, 10-player cap, idempotent counters), private storage
  policies, Realtime publication, explicit service_role grants — proven by 24
  SQL tests run on a local Postgres with a Supabase shim.
- **Operations**: protected daily cleanup cron (`/api/cron/cleanup`,
  `vercel.json`), deadline backstop, `DEPLOY.md` checklist, a local
  PostgREST + GoTrue stand-in backend for end-to-end tests without Docker.

Gates at hand-off: lint clean, production build OK, 483 unit tests, 37 SQL
tests, 27 Playwright specs (two-phone flows; +1 analytics spec run with a key),
three independent verification passes in `VERIFICATION.md` with every finding
fixed or explicitly deferred.

## Spec additions (Phase 10)

- **Open Graph invite cards**: `/g/<code>` serves title/description/Open Graph/Twitter tags and
  a 1200×630 whiteboard-style PNG with the logo, game name, player count and code, rendered per
  request from the new anon-only `peek_game_public` RPC (generic card for unknown codes).
- **Logo and icon set**: a 3×3 marker grid with a red diagonal scribble on paper
  (`public/icons/logo.svg`), exported to favicon.ico (16+32), apple-touch 180, 192/512 and a
  maskable 512, plus an inline React `Logo` used on the card.
- **Analytics**: PostHog free tier behind `src/lib/analytics.ts`, off unless
  `NEXT_PUBLIC_POSTHOG_KEY` is set and the browser has no Do Not Track / Global Privacy
  Control; memory persistence, no autocapture/pageviews/recordings/identify; eight events
  (`game_created`, `player_joined`, `game_started`, `square_completed`, `media_uploaded`,
  `game_ended`, `recap_viewed`, `play_again`) with a strict property allow-list, verified by
  decoding intercepted payloads: no names, codes, ids or URLs.
- **Play again**: a small muted text link at the very bottom of the recap creates one rematch
  lobby per game (same name, free-space setting and squares, counts reset; the tapper hosts
  under their old name); the other players' recaps offer "A new game is ready · Join", a
  one-tap join under their existing names.
- **TESTING.md**: a step-by-step two-phone checklist (45 min) using the exact on-screen copy.

## Game deadline (Phase 11)

The fixed 24-hour auto-end is gone. The host picks a deadline when creating the game
("Tonight (3 AM)" by default, "24 hours", "This weekend (Sunday 11:59 PM)" or a custom
time, at most 7 days out, computed in the phone's own time zone with correct DST
handling) and can change it in the lobby until Start. Everyone sees it in the lobby; the
board shows a small countdown next to the game name and one "1 hour left." toast per
phone. The host may extend the deadline once during the game by up to a day. At the
deadline every phone moves to the recap, and the daily cron ends any active game past
its deadline as a backstop. The database owns the rules (`games.deadline_at`,
`set_deadline`, `extend_deadline`, `start_game` refusing a passed deadline); the 30-day
album expiry still counts from creation.

## Playtest fixes, round 1

- **Home "Join game"**: a code field under New game that normalises the code, checks it and
  shows not-found / full / ended copy inline before routing to the join screen.
- **Lobby**: the game name is a real pencil title with the deadline beneath; the free-space
  toggle lives only on the Create screen.
- **Shared start countdown**: `start_game` sets a server `countdown_ends_at` five seconds out;
  every phone counts down to it (pencil-sketched 5-4-3-2-1 with a buzz per tick), completions are
  refused server-side until then, and late openers skip it.
- **Host controls in Settings**: Extend deadline and End game sit in a Host section at the top
  of the settings sheet; no new board buttons.
- **Blackout auto-end**: the 25th square ends the game inside the same transaction with
  `end_reason = 'blackout'` (host and deadline ends are recorded too); a marquee-bulb BLACKOUT
  sequence, then a credits card (name, date, players in their colors, squares completed) leads
  into the recap; host/deadline ends get a short buzzer intro. Reduced motion gets fades.
- **Post-game media**: uploads keep working after the end for the uploader's own squares (any
  square within ten minutes of the end, so in-flight blackout photos land); the recap lists
  "Your squares" with Add photo/video.

## Live URL

None yet. The sandbox could not reach Supabase or Vercel, so nothing is
deployed. `HUMAN_STEPS.md` is the exact to-do list; `DEPLOY.md` is the
pre-flight checklist.

## Human steps outstanding (see HUMAN_STEPS.md)

1. Create the Supabase project, enable Anonymous sign-ins, copy the URL and
   keys into `.env.local`.
2. `npx supabase link` then `npx supabase db push` (8 migrations), then deploy
   the matching app build right after.
3. Smoke-test on two phones against the real project (Realtime, uploads,
   signed URLs, recap) — the one thing the local stand-in cannot prove.
4. Optional: a PostHog project and its two env vars (HUMAN_STEPS.md §3b).
5. Vercel: import the repo, add the env vars (service role key and
   `CRON_SECRET` server-only), deploy, check the first cron run.
5. Real-device pass on iPhone Safari and Android, add to home screen.

## Known limitations

- No accounts: "Your games" lives on one phone; clearing browser data or
  switching phones loses history. No host transfer.
- Unverified here (needs the hosted project): Realtime event latency, real
  Storage uploads and signed URLs, cron deletion of storage objects, iOS
  Safari specifics (no haptics, clunky zip downloads).
- Deferred from verification: `register_media` does not check the uploader
  owns the object or that the path's position matches; no filter/report path
  for user-written square text; the local backend has no Realtime events or
  Storage, so cross-phone sync in tests travels over the resync poll.
- Players who leave a live game stay listed; leaving is lobby-only by design.

## Three most valuable next features

1. **Competitive modes**: solo race (each player's own board, first to bingo)
   and teams (two shared boards, team colors), reusing the same RPC layer.
2. **Boss squares with point values**: weighted squares and a live score strip,
   with the recap turning into a scoreboard.
3. **Community packs**: submit and browse packs (moderated, stored in the DB
   with a review state), plus "remix last night's board".
