# Bingo Night: independent verification

**Date:** 2026-10-24 · **Branch:** `claude/modest-clarke-porll9` (clean tree at start; this file is the only change)
**Verifier:** an independent agent that did not build this code. I read CLAUDE.md, PHASES.md, HUMAN_STEPS.md, DEPLOY.md, README.md, every e2e spec, every SQL test, all 3 migrations and the client code that matters for each finding.
**Environment:** local stand-in backend (`127.0.0.1:54321`: real GoTrue + PostgREST, Realtime stub that never emits events, Storage returning 501), local Postgres 16 (`127.0.0.1:54329`), Chromium via Playwright, `next dev` with `NEXT_PUBLIC_SYNC_POLL_MS=1500 NEXT_PUBLIC_ENABLE_SW=1`. Nothing here could reach a hosted Supabase or Vercel project.

Scratch evidence (outside the repo) is in `/tmp/claude-0/-home-user-BinGo/8bb7be13-4a03-5c1c-a267-bab4a95a5cb6/scratchpad/`:

- Scripts: `playthrough.mjs`, `counter.mjs`, `counter-offline.mjs`, `leave.mjs`, `extra.mjs`, `taps.mjs`, `probe/rpc-probe.mjs`, `probe/cas.mjs`.
- Logs: `*.log`.
- Screenshots: `shots/`.

---

## 1. Gate results

| Gate | Result | Exact output |
| --- | --- | --- |
| `npm run lint` | **pass** (exit 0) | no warnings or errors printed |
| `npm run build` | **pass** (exit 0) | Next.js 16.4.3 (Turbopack), "Compiled successfully", TypeScript OK, 9/9 static pages. Routes: `/` ○, `/_not-found` ○, `/api/cron/cleanup` ƒ, `/dev/media-lab` ○, `/g/[code]` ◐, `/game/[id]` ◐, `/manifest.webmanifest` ○, `/new` ○, Proxy ƒ |
| `npm run test` | **pass** (exit 0) | `Test Files 22 passed (22)`, `Tests 300 passed (300)`, 1.51 s |
| `npm run db:test` | **pass** (exit 0) | `==> 21 passed, 0 failed` (ids a–u, including (t), the concurrent-join shell test) |
| `npm run e2e` (1st run) | **pass** (exit 0) | `18 passed (3.2m)`. **Caveat:** this run used a **stale** local database (finding P3) |
| `npm run e2e` (after `npm run backend:reset`) | **pass** (exit 0) | `18 passed (3.2m)` against a schema identical to the committed migrations (schema-only `pg_dump` diff of `bingo_local` against a fresh `bingo_test`: 0 lines) |

Extra checks against the production build (`next start` on :3100):

- `/dev/media-lab` returns 404.
- `/api/cron/cleanup` returns 401 with no bearer and with a wrong bearer, and 200 with the right one: `{"endedGames":0,"expiredGames":0,"deletedGames":0,"deletedObjects":0,"errors":[]}`.
- The service-role key value and the `CRON_SECRET` value do not appear anywhere in `.next/static` (I grepped for the literal values).

---

## 2. Playthrough findings

What I ran:

- My own two-phone Playwright script, `playthrough.mjs`, at 375×812 in two contexts.
- Three full runs: light scheme, dark scheme, and light with `reducedMotion: 'reduce'`.
- Spot checks at 320 px.
- After a backend reset, steps marked PASS below passed in all three runs.

**What worked (verified, not assumed):**

- **Create and join:** create → lobby code and invite (copy fallback "Copied", link `…/g/<code>`) → join via `/g/<code>`.
- **Players:** two players with distinct palette colors on both phones.
- **Lobby edits:** edits from both phones cross over within one poll, including a counter square (`×3` badge).
- **Free space:** the non-host gets an explanation and no toggle; `set_free_center` called as the non-host returns `not_host`; the host's toggle reaches the other phone.
- **Ready and start:** Start stays disabled until both phones are ready.
- **Start transition:** plays on both phones:
  - whiteboard or scoreboard variant, about 1035 ms;
  - with reduced motion, a 334 ms fade.
- **Completing squares:**
  - Cross-off shows within 2 ms (optimistic).
  - The other phone gets the toast "Fynn got Sing on stage at karaoke" in about 0.8–1.4 s (poll path).
  - A 250 ms press does **not** complete; an 800 ms hold does. With reduced motion it is a tap then Confirm.
- **Undo:** the wrong player has no Undo; `undo_completion` called as that user returns `not_allowed` and the square stays crossed.
- **Bingo:** exactly one celebration per phone. Blackout prompt shows on the host only (`extra.mjs`).
- **Media:** "Add photo/video" has `capture=environment` and fails honestly ("Upload failed — tap to retry"); the board stays usable.
- **End game:** both phones land on the recap with "Album available until Monday, November 23", and `bingo.activeGame` is cleared.
- **Instant return:** with `**/rest/v1/**` held for 3 s, reopening `/` draws the board in about 1.1–1.2 s with **0** REST responses.
- **Offline:** a completion made in airplane mode survives an offline reload (served by the service worker, status 200, board drawn) and syncs to the host on reconnect.
- **Late joiner:** lands straight on the live board.
- **Width:** no horizontal scroll at 320 or 375 in either scheme, with 24-character names and a 60-character game name.
- **Tap targets:** all at least 44 px on home, lobby, board and sheet. Only text-field `<label>`s are shorter.
- **Look:** no emoji icons, gradients, glow or blur seen in any screenshot.

### Findings

**P1. Counter "+1" taps are silently lost when two phones tap close together, or after offline. Severity: Major. Violates the constraint "completions … must reconcile correctly with the server, including after offline periods".**

- **Repro A (simultaneous):**
  1. Two phones are on an active Night Out board.
  2. Both open square 2, "Collect 15 stranger signatures", and both show 0/15.
  3. Tap +1 on both at the same moment.
- **Repro B (offline):**
  1. Friend goes offline and taps +1 (friend shows 1/15).
  2. Host taps +1 twice while online (DB is 2).
  3. Friend comes back online.
- **Repro C (stale view):**
  1. Host taps +1 three times quickly.
  2. The friend taps +1 before the poll lands.
- **Expected:** A → 2/15; B → 3/15; C → 5/15.
- **Actual:** A → 1/15 on both phones and in the DB. B → 2/15, so the friend's offline +1 vanished. C → 4/15. Logs: `counter.mjs`, `counter-offline.mjs`.
- **Messaging:** no message is shown. `square-outcome` is empty, and the UI just jumps to the server count.
- **Full playthrough:** the counter step failed in all three schemes. Two simultaneous +1s on a 3-target counter gave 1/3, a third tap gave 2/3, and the square never completed.
- **Cause:** by design.
  - The client sends `expected_count = shown count` (`src/lib/game/useBoardState.ts`, `increment`).
  - `increment_square` treats this as a compare-and-set (`supabase/migrations/20261023204256_game_rpcs.sql`).
  - `applied = false` is adopted silently (`src/lib/game/pendingActions.ts`). `src/lib/game/pendingActions.test.ts:213` ("increment applied=false … is adopted silently") enshrines this.
- **Suggestion:** make the +1 idempotent with a client action id (dedupe retries server-side) instead of a CAS on the count, so concurrent and offline taps all count.

**P2. Lobby "Leave" does not leave, and a departed or idle player blocks Start forever. Severity: Major.**

- **Repro (`leave.mjs`):**
  1. The host creates a game.
  2. A friend joins, then taps **Leave**.
  3. The host taps Ready.
- **Expected:** the friend is gone, or the host can remove them or start anyway.
- **Actual:**
  - The host still lists 2 players: "1 of 2 ready. Start unlocks when everyone is." Start stays disabled forever.
  - The friend's home still lists the game.
- **Cause:** `leaveToHome` only forgets the game locally ("membership stays", `src/components/lobby/LobbyHeader.tsx`). `start_game` requires every player to be ready, and there is no leave or remove RPC.
- **Impact:** anyone who joins by mistake or closes the app makes the host recreate the game.
- **Suggestion:** add a lobby-only `leave_game` RPC, and a host-only remove.

**P3. The local stand-in database was running pre-edit versions of two applied migrations, and nothing detects it. Severity: Major (test infrastructure; makes green e2e untrustworthy).**

- **Repro, before my reset:** in `bingo_local`, `select filename, checksum from _local_backend.migrations` gave:
  - `core_schema` = `74f8c434…`, while the file's sha256 is `d715a31e…`;
  - `game_rpcs` = `3d2941eb…`, while the file's sha256 is `85ba2dd9…`.
- **`npm run backend:status`** still printed `database bingo_local, 3 app migration(s) applied`. Only `migrate` compares checksums.
- **What the stale schema got wrong:**
  - `increment_square` / `complete_square` returned an **all-null row** on `applied = false`. In psql: `{"applied":false,"id":null,…,"current_count":null}`.
  - `set_updated_at` used `now()` instead of `clock_timestamp()`.
  - The helpers lived in `public`, not `private`.
- **Effect:** the first `npm run e2e` (18/18 green) ran against that schema. The committed migrations are correct: the same CAS call in a fresh `bingo_test` returns `count=1` with a real row.
- **Process issue:** applied migration files were edited after being applied. This is local only (nothing has been pushed to a hosted project), but it is what CLAUDE.md forbids.
- **What I did:** ran `npm run backend:reset`, then re-ran e2e and the playthrough.
- **Files:** `scripts/local-backend/cli.mjs` / `db.mjs` (status), `playwright.config.ts`.
- **Suggestion:** have `backend:status` and an e2e `globalSetup` fail on checksum drift.

**P4. Toasts cover the board's top bar. Severity: Minor.**

- **Repro:** another phone completes a square, and a toast appears at the top of the board.
- **Expected:** title, players, settings and album controls stay reachable.
- **Actual:** the toast sits over the whole top bar for 2.5 s per toast. That is up to about 12 s with the queue of 4 waiting plus the current one. Tapping there opens the toast's square instead.
- **Screenshots:** `shots/dark-15-celebration-friend.png`, `shots/light-12-toast-host.png`, `shots/extra-many-toasts-host.png`.
- **Files:** `src/components/board/Toasts.tsx`, `BoardScreen.tsx`.

**P5. "Share to group chat" without Web Share copies only the invite URL. Severity: Minor.**

- **Repro:** desktop Chromium (no `navigator.share`): open a completed square → Share to group chat → paste.
- **Expected:** "Hana just completed …" plus the link.
- **Actual:** clipboard is `http://localhost:3000/g/<code>` only.
- **File:** `src/lib/share.ts` (`shareOrCopy` copies `data.url`).

**P6. Lobby grid at 320/375: the counter badge overlaps the label, and words break with no hyphen. Severity: Nit.**

- **Overlap:** `×15` sits on top of "Collect 15".
- **Breaks:** "Complime / nt a stranger…" (`overflow-wrap: anywhere`).
- **Screenshot:** `shots/zoom-lobby-320-grid.png`.
- **Files:** `src/components/lobby/LobbyBoard.tsx`, `src/app/globals.css` (`.square-label`).

**P7. Lobby dock at 320 px is cramped. Severity: Nit.**

- The status line is cut off: "0 of 2 ready. Start unlocks when eve…".
- "Start game" wraps to two lines.
- **Screenshot:** `shots/light-08-lobby-320.png`.
- **File:** `src/components/lobby/LobbyDock.tsx`.

**P8. At 320 px a 24-character player name pushes the square name out of the toast. Severity: Nit.**

- The toast reads "Mmmmmmmmmmmmmmmmm…", so it no longer says what was completed.
- **Screenshot:** `shots/extra-many-toasts-host.png`.
- **File:** `Toasts.tsx`.

**P9. Undo is a single tap with no confirmation, including the host undoing someone else's square. Severity: Nit (UX).**

- **Repro:** host opens a friend's completed square and taps Undo. It reverts immediately.
- **File:** `src/components/board/SquareSheet.tsx`.

**P10. Media rows are loosely tied to their square. Severity: Nit.**

- Media on a square that is later undone stays in the album and recap, with no completer shown.
- `register_media` accepts any path under `<game_id>/`: it does not check that the `<position>` segment matches, or that the object exists and was uploaded by the caller. A member can register another member's not-yet-registered object.
- **Files:** `src/components/recap/recapItems.ts`, `register_media` in the RPC migration.

---

## 3. Constraint audit

### 3a. Project Constraint Block

| Constraint | Verdict | Evidence |
| --- | --- | --- |
| RLS on every table at creation | **pass** | `alter table … enable row level security` right after each `create table` (`20261023204254_core_schema.sql`); SQL test (s) checks `relrowsecurity` for every public table |
| GRANTs match exactly the RLS verbs | **pass** (with a note) | `revoke all … from anon, authenticated; grant select … to authenticated`; only SELECT policies exist; test (b). Probe: authenticated POST/PATCH/DELETE on `squares`/`games`/`players`/`media` → `403 42501`. Note: `service_role` privileges are never granted explicitly (see 3b (k)) |
| Membership-only reads/writes | **pass** | Probe as an outsider (`rpc-probe.mjs`): `games` (by id, by join_code, unfiltered), `players`, `squares`, `media` all return `[]`; 9 game-scoped RPCs × {real game, random uuid} all return `400 game_not_found` |
| State changes are RPC-owned; no client table writes | **pass** | Grep (a): the only `.insert/.update/.upsert/.delete(` on a Supabase table is `client.from("games").delete()` in `src/lib/cleanup/runCleanup.ts`, called only from the cron route. TS only predicts outcomes (`boardState.ts`) and adopts server rows |
| Host-only actions enforced in the RPC | **pass** | Probe: non-host `start_game` / `end_game` (lobby and active) / `set_free_center` → `not_host`; third player `undo_completion` → `not_allowed`; host undo of the free center → `not_allowed` |
| No square edits once active; no completions in lobby/ended | **pass** | Probe: `update_square` after start (host and member) → `game_not_in_lobby`; `complete_square` / `increment_square` / `undo_completion` in lobby and after end → `game_not_active`; SQL tests (f), (g), (p) |
| Supabase CLI migrations only | **partial** | All schema is in `supabase/migrations/` (3 files), with no dashboard or raw SQL in the app. But two applied migrations were edited after local application (P3). Not yet pushed to a hosted project, so unverifiable there |
| Service-role key never exposed; cron only | **pass** | Grep (b): `SUPABASE_SERVICE_ROLE_KEY` is read only in `src/lib/supabase/admin.ts` (`import "server-only"`), imported only by `src/app/api/cron/cleanup/route.ts`; ESLint `no-restricted-imports` blocks other imports; the key value is absent from `.next/static` |
| `game-media` private; signed URLs to members only | **pass in SQL / unverifiable live** | Bucket `public=false`, 50 MB, MIME list (test (s)); SELECT/INSERT/DELETE policies gated on membership (test (l)); the client reads only via `createSignedUrls` (`src/lib/media/signedUrls.ts`). Live Storage is a 501 stub, so signing and upload were not exercised |
| Starter packs app-store-safe | **pass** (nit) | `src/content/packs/index.ts`: no drinking dares, sexual content, illegal activity or danger; swimming and climbing are framed with lifeguard / marked trail. Nit: "Bartender names a drink after us" is alcohol-venue framed (mitigated by "Mocktails and sodas count") |
| Board fits the width, no horizontal scroll | **pass** | My runs at 320 and 375, light/dark/reduced motion: `scrollWidth` = viewport and the grid fits (`375:363`, `320:308`); lobby, sheets and recap too; the repo's spec covers all 12 setting combinations |
| No Wake Lock | **pass** | Grep (c) for `wakeLock` / `keep awake` / `nosleep` in `src` and `public`: 0 hits |
| Optimistic completions reconcile, including offline | **fail for counters**, pass for normal squares | Normal squares: optimistic in 2 ms, survive an offline reload, sync on reconnect. Counters: +1 taps are lost on concurrency or offline (P1) |

### 3b. Adversarial checks (a)–(k)

| Check | Verdict | Evidence |
| --- | --- | --- |
| (a) table writes outside cron | pass | Only `runCleanup.ts:204` (`games.delete()`), reached only from the cron route |
| (b) service role / admin outside cron | pass | See 3a |
| (c) Wake Lock | pass | 0 hits |
| (d) emoji as UI icons in TSX | pass | Unicode scan of `src`: only `→`, `×`, `…`, `·` in comments and copy, plus one emoji inside a unit-test string (`recap.test.ts:72`); icons are lucide-react |
| (e) gradients / backdrop-filter / blur / glow | pass | Only hard-stop `linear-gradient`s for paper rules and margin lines (`globals.css` 77–186); `box-shadow`s are solid offset "pencil" shadows (`2px 3px 0 var(--ink)`); no `backdrop-filter`, `blur(`, `drop-shadow` or `text-shadow`; screenshots confirm |
| (f) selects that could leak if RLS were wrong | **partial** | `useGame.fetchGameSnapshot` filters every table by `game_id` / `id` (pass). `YourGames.tsx` selects `games` with **no** membership filter (`.gt(expires_at).limit(50)`), and `JoinScreen.findMembership` treats any readable `games` row with that code as membership. Both rely solely on RLS. Suggestion: filter through `players.user_id = <session uid>` |
| (g) RPCs as a non-member via REST | pass | `rpc-probe.mjs`: 70/71 checks OK on the stale DB, with the one failure being the stale-schema CAS (P3); fine against the committed schema (`cas.mjs`). Details below |
| (h) `public/sw.js` never caches Supabase, API or non-GET | pass | `sw-policy.js` `selectStrategy`: returns null for non-GET, the Supabase origin and other origins, auth/apikey/range/RSC headers, `_rsc`, signed-URL params, `/api/` `/auth/` `/rest/` `/storage/` …; `pwa.spec.ts` inventories the caches |
| (i) starter packs | pass (nit) | See 3a. Outside the official-pack constraint: user-generated names and labels have no filter or report path (App Store 1.2) |
| (j) docs vs code | **minor issues** | Listed below |
| (k) hosted Postgres 17 vs shim | **mostly pass, one risk** | Listed below |

**(g) probe details.** Each line is what came back:

- `set_ready`, `update_square`, `set_free_center`, `start_game`, `complete_square`, `increment_square`, `undo_completion`, `end_game`, `register_media` as an outsider, on the real game and on a random uuid → `game_not_found` (18/18).
- Outsider selects on all four tables → `[]`.
- Anon key only: `peek_game` → 401 "permission denied for function"; `games` → 401.
- Authenticated `auto_end_due_games` → 403 `42501`.
- `private.normalize_single_line` → 403.
- `update_square` after start → `game_not_in_lobby`.
- `complete_square` in lobby → `game_not_active`.
- Non-host `start_game` / `end_game` / `set_free_center` → `not_host`.
- Third-player `undo_completion` → `not_allowed`.
- 10 joins get colors 0–9; the 11th `join_game` → `game_full`.
- Join after end → `game_ended`.
- Outsider `peek_game` returns only `{name, status, player_count, free_center}`.
- `is_game_member` is callable via REST, but only answers for the caller.
- Storage paths: unverifiable (the gateway returns 501 for `/storage/v1/*`).

**(j) docs vs code:**

- CLAUDE.md "Server logic" says `end_game` is "active only", but the RPC and the Database API allow ending from the lobby (probe: 200, `status=ended`).
- HUMAN_STEPS §2 suggests an optional `npx supabase config push`, which would push `site_url = "http://127.0.0.1:3000"`, the localhost redirect URLs and the auth rate limits to the hosted project.
- README's `npm run backend:env > .env.local` writes npm's `> bingo-night@0.1.0 backend:env` banner lines into `.env.local` (`npm run -s` avoids it).
- `config.toml` seeds `./seed.sql`, which does not exist.
- `.env.example` does not mention `NEXT_PUBLIC_SYNC_POLL_MS` / `NEXT_PUBLIC_ENABLE_SW`.
- Everything else I checked (cron schedule, engines, env-var table, "Photo added" copy, 13 RPCs, 21 SQL tests) matches.

**(k) hosted Postgres 17 vs the shim:**

- **Nothing found that hosted would reject.** `gen_random_uuid` and `uuid_send` are core, so there is no pgcrypto dependency. `ON DELETE SET NULL (col)` needs PG 15+. Storage policies created by `postgres` follow Supabase's documented pattern, and `owner_id` exists on hosted.
- **Risk:** the migrations never GRANT to `service_role`. The cron's select and delete on `games` relies on Supabase's default privileges, and test (b) only passes because `local_shim.sql` emulates them (`alter default privileges … to service_role`). If the hosted project does not auto-grant on new tables (`config.toml` mentions `auto_expose_new_tables`), the cron fails with `42501`. Suggestion: grant `select, delete` on `games` (and what the cascade needs) to `service_role` explicitly.
- **Expected, not a bug:** the shim's `postgres` is superuser, while hosted's is not.

---

## 4. Test-coverage gaps

**What the suites prove.** The SQL suite is strong: per-RPC error order, RLS, grants, storage policies, concurrent joins. The e2e suite is broad, but it mostly proves happy paths over the poll.

**What they miss:**

1. **Concurrent or offline counter increments are not tested anywhere.**
   - `board.spec.ts` increments sequentially, from one phone and then the other after it settled.
   - The unit test `pendingActions.test.ts:213` asserts the silent loss as correct.
   - This is why P1 shipped.
2. **Leave and idle players.** There is no test that a departed or never-ready player can be handled (P2).
3. **No drift guard on the e2e database.** The suite trusts whatever `bingo_local` holds (P3). It went green on a stale schema.
4. **Server rejection is not tested end to end.** `board.spec.ts` says "the RPC enforces it anyway" but only asserts the hidden Undo; no spec calls a forbidden RPC as the wrong user. SQL tests cover the rules, but not through PostgREST + GoTrue JWTs. My `rpc-probe.mjs` did that.
5. **Realtime is never exercised.** It is production's primary sync path: event merge, `updated_at` stale-event dropping, RLS-filtered delivery. Every cross-phone assertion goes through the 1.5 s poll.
6. **Real uploads, signed URLs and storage deletion are never exercised.** `media-wiring.spec.ts` injects rows with `rpcAs("register_media")` for objects that do not exist. The cron's storage walk is only unit-tested with a fake. Locally it reports `list_storage: storage not available` and correctly keeps the row (I verified with an expired game).
7. **Several flows have no e2e at all:**
   - blackout prompt (I verified it manually: host only);
   - late join mid-game;
   - the 11-player `game_full` UI;
   - the 24 h auto-end flip on the client;
   - a two-phone race to complete the same square ("X got it first");
   - host undo while the completer is offline.
8. **Horizontal-scroll checks are thin.** They measure `documentElement.scrollWidth` and the grid box. Overlap and cramping (P6–P8) are not asserted. Only the settings spec checks cell overflow.
9. **`reuseExistingServer: true`** silently reuses a dev server started *without* `NEXT_PUBLIC_SYNC_POLL_MS=1500` / `NEXT_PUBLIC_ENABLE_SW=1`. The 3 s `LIVE` waits and the PWA spec would then fail or flake for an environmental reason.
10. **SQL tests run on Postgres 16 with a superuser `postgres` and emulated default privileges.** Passing them does not prove `service_role` grants on hosted (3b (k)).

---

## 5. Only verifiable on a hosted project or real device

- **Realtime:**
  - delivery and latency of `postgres_changes` filtered by `game_id`;
  - RLS-filtered delivery to members only;
  - the publication contents after `db push`;
  - DEPLOY.md's "within a second" claim.
- **Storage:**
  - upload with `upsert: false` under the INSERT policy (`owner_id` stamping);
  - `createSignedUrls` for members, and refusal for non-members;
  - MIME and size enforcement by the storage server;
  - HEIC passthrough rendering on non-Safari browsers (`image/heif` is not in the allowed list).
- **Cron:**
  - Vercel Cron bearer delivery;
  - recursive `list()` and `remove()` of real objects;
  - row deletion after storage succeeds;
  - `service_role` table privileges (3b (k));
  - the `maxDuration = 60` budget.
- **Auth:**
  - the anonymous sign-in rate limit (hosted default 30/h per IP; a whole group on one bar Wi-Fi shares an IP);
  - refresh-token rotation across the proxy and browser keeper.
- **iOS Safari:**
  - ITP caps script-written cookies (the `@supabase/ssr` browser client) at 7 days, and evicts localStorage after 7 days without interaction for non-installed sites. The anonymous identity, "Your games" and recap access may not survive to the advertised 30 days.
  - Press-and-hold versus text selection and callout.
  - Web Share sheet behaviour.
  - Camera capture.
  - Service worker plus Add to Home Screen offline open.
  - Haptics are a no-op on iOS (`navigator.vibrate` is missing).
- **Production hydration of service-worker-cached pages.** Dev already hydrated in my runs; prod is untested here.

---

## 6. Overall verdict

The security core is solid and holds up adversarially: RLS, grants, membership hiding, host-only rules, lobby and active locks, and the service-key boundary all held in my own REST probes. The night-out basics work on two phones in both themes and with reduced motion: optimistic cross-off, hold-to-complete, toasts, one celebration per line, instant return from the snapshot, an offline completion surviving a reload, and the recap.

Two **Major** product bugs block "done":

- **P1:** counter +1s are silently lost on concurrent or offline taps. This breaks the reconcile constraint.
- **P2:** a player who leaves or idles in the lobby makes the game unstartable.

The green e2e result needs to be taken with care: the first run went against a **stale** local schema, and nothing detects that (**P3**). It is green on the committed schema too, but it never exercises Realtime, real Storage or concurrency.

**Not ready to ship until P1 and P2 are fixed and P3 is guarded.** The hosted smoke test in DEPLOY.md is still required.

---

## Resolution

Status of every finding above after the follow-up work. "Fixed in 0e6beed" is the committed Major-fix pass; "fixed in working tree" is the final polish pass (committed as fe74509). Gates after the polish pass: `npm run lint` clean, `npm run build` OK, `npm run test` 23 files / 314 tests, `npm run e2e` 20/20 against a drift-free `bingo_local`.

### Section 2 findings

| Id | Finding | Status |
| --- | --- | --- |
| P1 | Counter "+1" taps lost on concurrent / offline taps (Major) | **Fixed in 0e6beed**: `increment_square` takes a per-tap client `action_id` (dedup log `square_increments`) instead of a compare-and-set; `e2e/counters.spec.ts` and SQL test (v) cover simultaneous, offline and retried taps. |
| P2 | Lobby Leave does not leave; an idle player blocks Start (Major) | **Fixed in 0e6beed**: lobby-only `leave_game`, host-only `remove_player` with inline confirm; `e2e/lobby-leave.spec.ts`. |
| P3 | Local DB ran edited versions of applied migrations; nothing detected it (Major, test infra) | **Fixed in working tree**: `backend:status` re-hashes every applied migration and prints `DRIFT: <file> changed after it was applied — run: npm run backend:reset` (exit 4); `backend:start` prints the same warning without blocking; `e2e/global-setup.ts` (Playwright `globalSetup`) runs `status` and aborts the run when the backend is down (exit 3) or drifted (exit 4). Verified by appending a line to a migration (status exit 4, e2e aborted) and restoring it byte-for-byte (sha256 unchanged). |
| P4 | Toasts cover the top bar (Minor) | **Fixed in working tree**: the toast now lives in the top bar's centre slot over the game name (same box, absolutely positioned, no layout shift); players / settings / album stay visible and tappable, nothing overlays the grid. Tap-to-open, queue timing and the reduced-motion fade are unchanged. While a sheet is open the toast sits under the sheet's scrim like the rest of the bar. |
| P5 | "Share to group chat" fallback copies only the URL (Minor) | **Fixed in working tree**: `shareOrCopy` copies `text + "\n" + url`; the invite keeps copying the bare link (`{ copy: "url" }`). `src/lib/share.test.ts` and `e2e/media-wiring.spec.ts` assert the clipboard text. |
| P6 | Lobby grid at 320/375: counter badge over the label, hyphenless word breaks (Nit) | **Fixed in working tree**: the `×N` badge takes its own corner row and the label gets the rest of the cell (2 lines); `.square-label` hyphenates first (`overflow-wrap: break-word` instead of `anywhere`, `lang="en"` already on `<html>`); lobby cells are size containers so labels with a long word drop a size step in cells under 60 px. |
| P7 | Lobby dock cramped at 320 px (Nit) | **Fixed in working tree**: the status line wraps instead of truncating; below 360 px the dock buttons use a smaller label and padding so "Start game" stays on one line; buttons stay 56 px tall. |
| P8 | Long player name pushes the square name out of the toast (Nit) | **Fixed in working tree**: the leading player name is capped with its own ellipsis (`min(14ch, 40%)`) and the toast text may use two lines, so the square label stays visible. |
| P9 | Undo is one tap with no confirmation (Nit, UX) | **Fixed in working tree**: Undo → "Confirm undo" (second tap within ~4 s; a double-tap does not count), ≥44 px; `e2e/board.spec.ts` covers the revert and the confirm. |
| P10 | Media loosely tied to its square (Nit) | **Partly fixed in working tree**: media on a square that was undone later stays in the album and recap with a correct caption ("Photo by <uploader> · not crossed off", never "On the house"); the summary counts only crossed-off squares (unit test in `recap.test.ts`). **Deferred**: `register_media` still does not check that the `<position>` segment matches or that the caller uploaded the object; that needs a new migration (out of scope for a client-only pass). Impact is low: only members can register, under their own game's prefix. |

### Section 3 findings

| Id | Finding | Status |
| --- | --- | --- |
| 3a "Supabase CLI migrations only" partial | Applied migrations edited after local application | **Process fixed**: the P3 drift guard now catches it locally (status, start, e2e). Nothing was ever pushed to a hosted project. |
| 3a starter packs (nit) | "Bartender names a drink after us" is venue-framed | **Deferred**: judged acceptable (non-alcoholic framing in the pack copy); revisit during store review. |
| 3b (f) | `YourGames` and `JoinScreen` membership rely on RLS alone | **Fixed in working tree**: both now filter explicitly through `players!inner(user_id)` with `.eq("players.user_id", <session uid>)` (RLS still applies on top). |
| 3b (i) | User-generated names/labels have no filter or report path | **Deferred**: a product decision for store submission (App Store 1.2), not a code bug. |
| 3b (j) | Docs vs code | `end_game` from the lobby, `config push`, README `backend:env` banner, missing `seed.sql`: **fixed in 9d875a0 / 0e6beed**. `.env.example` still omits `NEXT_PUBLIC_SYNC_POLL_MS` / `NEXT_PUBLIC_ENABLE_SW`: **deferred** (test-only knobs, set by `playwright.config.ts`). |
| 3b (k) | Migrations never GRANT to `service_role` | **Fixed in 0e6beed**: explicit `service_role` grants; SQL test (s) checks them. |

### Section 4 coverage gaps

- 1 (concurrent / offline counters) and 2 (leave / idle players): **fixed in 0e6beed** (`counters.spec.ts`, `lobby-leave.spec.ts`).
- 3 (no drift guard): **fixed in working tree** (P3).
- 8 (overlap / cramping not asserted): **partly fixed**: board spec asserts the Undo target size; the 320 px layouts were checked by screenshot only.
- 9 (`reuseExistingServer` may reuse a dev server without the e2e env): **deferred**: the global setup checks the backend, not the dev server's environment; start `npm run e2e` with no dev server running (or with the same env) until a check exists.
- 4–7 and 10 (server rejections through PostgREST, Realtime, real Storage, untested flows, PG 16 shim): **deferred**: they need a hosted project or new specs; covered by the DEPLOY.md smoke test until then.

---

## Phase 10 verification (2026-10-24)

**Scope:** 10a Play again + `peek_game_public`, 10b logo / icons / Open Graph cards for `/g/[code]`, 10c PostHog analytics. Independent agent that did not build these; nothing was fixed. This section is the only change to the repo (`git status` shows only `VERIFICATION.md`).
**Environment:** local stand-in backend (`127.0.0.1:54321`), Postgres 16 (`bingo_local` for REST probes, `bingo_test` for SQL), Chromium via Playwright, `next dev` on :3000 and `next start` (production build) on :3100.
**Evidence** (scratchpad, outside the repo): `/tmp/claude-0/-home-user-BinGo/8bb7be13-4a03-5c1c-a267-bab4a95a5cb6/scratchpad/`
- scripts: `v10-probe.mjs` (RPC/RLS probe), `v10-embed.mjs` (PostgREST FK embed), `v10-cron.sql` (cron vs rematch FK), `v10-og.mjs` (unfurl + card timings), `v10-ux.mjs` (two phones + outsider, recap screenshots, analytics capture), `v10-icons/` (real-size icon render);
- logs: `v10-*.log`; screenshots: `v10-ux-nokey/`, `v10-ux-key/` (+ `payloads.json`), `v10-og-prod/`, `v10-og-dev/`, `v10-icons/`.

### 10.1 Gate results

| Gate | Result | Exact output |
| --- | --- | --- |
| `npm run lint` | **pass** (exit 0) | no output besides the npm banner |
| `npm run build` | **pass** (exit 0) | Next.js 16.4.3 (Turbopack), TypeScript OK, 9/9 static pages; new route `ƒ /g/[code]/opengraph-image`; `/g/[code]` ◐ |
| `npm run test` | **pass** (exit 0) | `Test Files 26 passed (26)`, `Tests 351 passed (351)` |
| `npm run db:test` | **pass** (exit 0) | `==> 28 passed, 0 failed` (new: (y) `peek_game_public`, (z) / (aa) `play_again`, (ab) 6-session race) |
| `npm run e2e` | **pass** (exit 0) | `24 passed, 1 skipped (4.4m)`; the skip is `analytics.spec.ts` |
| analytics spec, run properly | **pass** | Skip condition: `test.skip(!/\/__ph\/?$/.test(process.env.NEXT_PUBLIC_POSTHOG_HOST))`, so it only runs when the Playwright process itself has that env var and a dev server built with the key is already listening. Ran `NEXT_PUBLIC_POSTHOG_KEY=phc_test NEXT_PUBLIC_POSTHOG_HOST=http://127.0.0.1:3000/__ph NEXT_PUBLIC_ENABLE_SW=1 NEXT_PUBLIC_SYNC_POLL_MS=1500 npm run dev -- --hostname 127.0.0.1 --port 3000`, then `E2E_SKIP_BACKEND_CHECK=1 NEXT_PUBLIC_POSTHOG_HOST=http://127.0.0.1:3000/__ph npx playwright test e2e/analytics.spec.ts` → `1 passed (29.7s)`. Server stopped afterwards |

Dev-server noise seen during e2e (not a failure): every `/g/<code>` request logs `Error: Route "/g/[code]": Next.js encountered uncached data in generateMetadata()` (see P13).

### 10.2 Findings

No Blocker or Major. The security core of 10a held under every probe I could run.

**P11. "Play again" is not at the very bottom of the recap. Severity: Minor (misses the brief).**
- **Repro:** end a game, then scroll the recap to the bottom at 375 px (`v10-ux-nokey/recap-light-full.png`, `recap-dark-full.png`).
- **Expected:** a small text link below everything on the recap.
- **Actual:** the link (y = 486, 67×44 px) sits above the full-width outlined "Back to home" button (y = 558, 307×45 px). The link is the last child of `RecapSummary`, but `GameScreen` renders `Back to home` after `<Recap>`. `e2e/play-again.spec.ts` only checks "last element of the summary", so it passes.
- Everything else about the link matches the brief: muted ink (`rgb(98,103,108)` light / `rgb(183,176,162)` dark), 18 px, underlined, no fill, border or shadow, static position, 44 px tall, no horizontal scroll.
- **Files:** `src/components/game/GameScreen.tsx` (ended branch), `src/components/recap/RecapSummary.tsx`, `e2e/play-again.spec.ts`.
- **Suggestion:** render the rematch link after `Back to home`, and assert it is the lowest element on the page.

**P12. With a same-origin PostHog host, every analytics POST carries the Supabase auth cookie. Severity: Minor (depends on configuration).**
- **Repro:** analytics on with `NEXT_PUBLIC_POSTHOG_HOST=http://127.0.0.1:3000/__ph`; capture the requests (`v10-ux-key/payloads.json`).
- **Actual:** each `POST /__ph/e/` has `cookie: sb-127-auth-token=base64-…` (about 1300 chars: the access and refresh tokens).
- **Impact:** a same-origin reverse proxy (PostHog's recommended Next.js `/ingest` rewrite against ad blockers) would forward the anonymous session tokens to PostHog. The documented cross-origin hosts (`https://us|eu.i.posthog.com`) do not receive our cookies, and `Referer` was origin-only (`http://127.0.0.1:3000/`).
- **Files:** `src/lib/analytics.ts`, `DEPLOY.md` / `HUMAN_STEPS.md` §3b.
- **Suggestion:** document "PostHog host must be cross-origin, or strip `Cookie` in the rewrite"; or refuse a same-origin `api_host`.

**P13. Dev error on every `/g/[code]` request. Severity: Minor (developer experience; production unaffected).**
- **Error:** `Next.js encountered uncached data in generateMetadata()`, from `peek_game_public` in `generateMetadata`.
- **Effect:** the dev overlay shows a red "1 Issue" badge on every phone that came through an invite link (`v10-ux-nokey/recap-dark-full.png`).
- **Scope:** `next build` passes, and `next start` logs nothing.
- **File:** `src/app/g/[code]/page.tsx`.
- **Suggestion:** add the documented `<Suspense><Connection/></Suspense>` dynamic marker (`node_modules/next/dist/docs/.../generate-metadata.md`, "With Cache Components").

**P14. The OG card can be about a day staler than the text next to it. Severity: Minor.**
- **What happens:** the card is served with `Cache-Control: public, max-age=300, s-maxage=3600, stale-while-revalidate=86400`, and the image URL is the same for the life of a build (`/g/<code>/opengraph-image?26eae99ccb932628`).
- **Effect:** a CDN may show "1 player in · Tap to join" for up to about 25 h after the game filled up or ended. Meanwhile `og:description` comes from no-store HTML and says "This game has ended."
- **File:** `src/app/g/[code]/opengraph-image.tsx`.
- **Suggestion:** use `s-maxage=300` with no long SWR, or leave the live count and status off the image.

**P15. An empty `NEXT_PUBLIC_APP_URL` crashes the root layout. Severity: Minor (from reading the code; not run).**
- **Cause:** `src/app/layout.tsx` does `metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000")`. `??` does not catch `""`, and `new URL("")` throws `Invalid URL` (checked in node). A scheme-less value like `bingo.example` throws too.
- **Trigger:** `.env.example` ships `NEXT_PUBLIC_APP_URL=` empty. `page.tsx`'s `appBase()` and `links.ts` handle an empty value; the layout does not.
- **Not run:** I could not confirm whether this fails `next build` or every request. A scratch build outside the repo cannot resolve `next` (Turbopack workspace root).
- **Suggestion:** `||` plus try/catch, falling back to `VERCEL_PROJECT_PRODUCTION_URL` / localhost.

**P16. Analytics undercounts or miscounts. Severity: Nit.**
- The one-tap rematch Join, and `play_again`'s join fallback, never send `player_joined` (in `RecapSummary.tsx` only `play_again` is tracked).
- `game_ended` with `by: "auto"` is in the schema but never sent, so 24 h auto-ends are invisible.
- `play_again` is sent even when the caller lost the race and only joined someone else's rematch.
- `recap_viewed.media_count` is read once at mount (it was `0` in my run because there was no media; it can also be 0 before media loads).

**P17. A very wide game name runs into the board on the card. Severity: Nit.**
- **Repro:** a 60-character all-"W" name: the clamped two-line heading's "…" runs past the 590 px text column into the board (`v10-og-prod/card-wide60.png`).
- A realistic 57-character name clamps cleanly (`card-long.png`).
- **Files:** `src/lib/og/preview.ts` (`headingFontSize` counts characters, not width), `opengraph-image.tsx`.

**P18. Malformed percent-encoding in a dynamic route returns 500 in production. Severity: Nit (framework-level; also affects `/game/[id]`).**
- `/g/%ZZ`, `/g/%`, `/g/%E0%A4%A`, `/g/%E0%A4%A/opengraph-image` and `/game/%E0%A4%A` all return `500 Internal Server Error` on `next start`; dev returns 400.
- There is no stack trace in the body and nothing in the server log. Everything else I tried never returned 500 (list in 10.4).

**P19. Rematch players change colours. Severity: Nit.**
- Whoever taps Play again first becomes colour 0, and the others get the next free colour as they join.
- In my run the friend went from orange to red and the old host went from red to orange (`v10-ux-nokey/host-joined-lobby.png`).

**P20. "Go to the new game" also shows for an ended rematch, and `play_again` accepts an expired old game. Severity: Nit.**
- Once the rematch has itself ended, `play_again(old)` returns it (probe: `status=ended`). The old recap still says "Go to the new game", which lands on another recap.
- `play_again` has no `expires_at` check (a game in the window between expiry and the cron can spawn a rematch). Harmless, but inconsistent with `peek_game_public`.

**P21. Logo: the "scribble" reads as a clean strike-through. Severity: Nit (see 10.6).**

### 10.3 Probe results

All probes are REST against `127.0.0.1:54321` unless marked psql. Log: `v10-probe.log` (69 of 71 OK; the 2 BAD lines are my own wrong expectations, explained in the table).

| # | Probe | Result | Evidence |
| --- | --- | --- | --- |
| a1 | Only the anon `apikey` header, no `Authorization`: every RPC in the Database API (`create_game`, `join_game`, `peek_game`, `set_ready`, `update_square`, `set_free_center`, `start_game`, `complete_square`, `increment_square`, `undo_completion`, `end_game`, `leave_game`, `remove_player`, `register_media`, `auto_end_due_games`, `play_again`, `is_game_member`, `is_game_host`, `can_upload_game_media`, `safe_uuid`) | **pass** | each one: `401 42501 permission denied for function <name>`, a privilege error and never a game error. `set_updated_at` returns `404 PGRST202` (a trigger function, not RPC-callable) |
| a2 | Anon-only `peek_game_public` | **pass** | `200 {"name":"Probe P10","status":"lobby","player_count":3,"free_center":true}` |
| a3 | Anon-only `select` on `games`, `players`, `squares`, `media`, `square_increments` | **pass** | each one: `401 42501 permission denied for table …` |
| a4 | `Authorization: Bearer <anon key>` (what supabase-js sends with no session) on `peek_game` | **pass** | 401 `42501` |
| a5 | `pg_proc` privileges (psql, `bingo_local`) | **pass** (shim note) | Of the app functions, anon may execute only `peek_game_public`. pgcrypto functions in `public` are anon-executable, but only because the local shim installs pgcrypto there; PostgREST still answered `PGRST202` for them |
| b1 | `peek_game_public` keys | **pass** | exactly `name,status,player_count,free_center`: no squares, players or codes |
| b2 | Malformed codes: `""`, `ABC`, `ZZZZZZZZ`, `abcd-efgh-x`, `IIIIOOOO`, `%00`, `../../etc`, 300×`A`, SQL-ish, `null` | **pass** | `400 game_not_found` for each |
| b3 | Lower-case dashed code | **pass** | resolves to the same game |
| b4 | Expired game (`expires_at` set in the past with psql) | **pass** | `400 game_not_found`. Note: the authenticated `peek_game` still answers `ended` for it (pre-existing behaviour) |
| c1 | `play_again` as a non-member / on an unknown id | **pass** | `game_not_found` / `game_not_found`. A malformed uuid gives `22P02` (PostgREST cast) |
| c2 | `play_again` on an active game and on a lobby game | **pass** | `game_not_ended` |
| c3 | Two different members in turn | **pass** | the same new id; the host is the first caller (B), not the old host |
| c4 | New board compared with the old one | **pass** | 25 squares; labels, details and target_count identical by position (center `FREE` → `''`); every `current_count = 0`; no completions; no media |
| c5 | Old member reads `next_join_code` / `next_game_id` on the old row; an outsider sees no pointer | **pass** | the values match the new game / `[]` |
| c6 | Old member not yet joined: `games` by id and by join_code, `players`, `squares`, `media` of the new game | **pass** | all `[]` |
| c7 | After `join_game(next_join_code)` | **pass** | joined under the old name, colour 1; the new game is now readable |
| c8 | 10 members race `play_again` (10 parallel REST calls through the PostgREST pool), plus 5 more rounds | **pass** | 10×200, 1 distinct id, exactly 1 new row, rematch has 1 player; 0 bad rounds |
| d1 | Old member, not in the new game, via a PostgREST FK embed (`select=id,next:next_game_id(...,players(display_name))`) | **pass** | `next: null` for the non-member; a member of both gets the row, so RLS applies to embeds (`v10-embed.mjs`) |
| d2 | Old member: `is_game_member(new)`, `can_upload_game_media(new)`, `set_ready(new)`, `play_again(new)` | **pass** | `false`, `false`, `game_not_found`, `game_not_found` |
| d3 | Realtime and Storage, reasoned from policies | **pass by reasoning** | Realtime `postgres_changes` delivery is RLS-checked per subscriber (`is_game_member`), so a non-member gets no INSERT/UPDATE events for the new game even with `id=eq.<new>`. The old row's UPDATE (with the pointer) goes only to old members. Storage SELECT/INSERT policies key on the first path segment (`is_game_member` / `can_upload_game_media`), both false for the new game. Caveat (hosted, pre-existing): Supabase does not RLS-check DELETE events, which carry only primary keys under RLS |
| d4 | `peek_game(next_join_code)` as an old member | info | returns name/status/count, the same as the join screen; intended |
| e1 | Cron (psql, `bingo_test`, rolled back): delete an expired old game (as `service_role`) whose `next_game_id` points at a live game | **pass** | the old row is deleted; the rematch is untouched (still a lobby with 1 player) |
| e2 | The rematch is deleted first | **pass** | the old row's `next_game_id` becomes NULL via `on delete set null`; `next_join_code` stays stale, and the client then shows "Play again" again (`!nextCode \|\| !nextGameId`) |
| e3 | Chain A→B→C, all expired, one `delete … where expires_at < now()` | **pass** | all 3 deleted, no FK error |
| e4 | `games_next_game_not_self` | **pass** | a self-pointer is rejected |
| u1 | UX: a phone joins with its name, without typing | **pass** | the host tapped "A new game is ready · Join": lobby in 312–368 ms, players `["Friendo V","Hosty V"]`, no name field |
| u2 | UX: the old recap flips after someone else's Play again | **pass** | flipped to "A new game is ready · Join" 1.4–1.8 s after the friend's tap (1.5 s poll). Back on the old recap: joiner "Go to the new game", starter "You started a new game · Go to it" |
| u3 | UX: a third phone that was never in the old game | **pass** | `/game/<old>` and `/game/<new>` both show "We couldn't find that game"; `play_again(old)` and `play_again(new)` give `game_not_found`; the pointer is not readable; the code appears nowhere. Joining through `/g/<newCode>` works, and the old pointer stays hidden afterwards |

### 10.4 Open Graph and icon review

**Metadata.** Requests with no cookies, at :3100 (production) and :3000 (dev). With the crawler user agents `facebookexternalhit/1.1`, `Twitterbot/1.0`, the iMessage UA (`… facebookexternalhit/1.1 Facebot Twitterbot/1.0`), Slackbot and `WhatsApp/2.23` (Signal uses this UA), every tag is in `<head>`:
- `<title>` and `og:title` = `Join Friday Pub Crawl · Bingo Night`;
- `og:description` = `2 players in. Tap to join the board — no signup.`;
- `og:image` = `twitter:image` = `http://localhost:3000/g/<code>/opengraph-image?26eae99ccb932628`, absolute under `NEXT_PUBLIC_APP_URL`, with `og:image:width/height` 1200/630 and alt `Bingo Night board`;
- `og:url` uses the normalised code;
- `twitter:card` = `summary_large_image`.

Edge cases:
- **Ended game:** `<Name> · Bingo Night` / "This game has ended."
- **Bogus code:** `Join the game · Bingo Night` (200).
- **Lower-case dashed code:** resolves (but `og:image` keeps the raw `/g/sk5n-h2cq/…` path).
- **No leaks:** the host name, player name and square label appear in neither the HTML nor the PNG bytes.
- **Discord, Telegram, LinkedIn, Google:** also get the tags in `<head>`.
- **Other user agents:** an unknown UA (curl, desktop Chrome) gets them streamed after `</head>`. That is Next's `htmlLimitedBots` default, fine for the major apps.

**Card image.** 200 `image/png`, 1200×630, about 112–128 KB, `Cache-Control: public, max-age=300, s-maxage=3600, stale-while-revalidate=86400` (P14).

Timings (local, including the `peek_game_public` round trip):

| | First request after server start (fonts read) | Warm |
| --- | --- | --- |
| Production | 341 ms | 74–117 ms |
| Dev | 1283 ms (compile) | 105–193 ms |
| Page HTML (production) | 159 ms | 35–90 ms |

**Odd paths.** I looked at every card.
- `/g/%00`, 300-char code, `<script>`, `ZZZZ%20ZZZZ`, `abcd-efgh`, emoji: generic card, 200.
- `/g/..` and `/g/%2e%2e`: normalise to `/` or 404, not 500.
- Malformed percent-encoding: 500 in production (P18).

**My judgement of the card:** good.
- The name is large and legible in Permanent Marker. Long names clamp to two lines with "…" (except pathological widths, P17).
- The logo and "Bingo Night" are small but clear. The board is a hand-drawn whiteboard with generic sample labels ("Group selfie", "High five", "Find a dog"…) and two red cross-offs; the FREE label disappears when free space is off.
- No gradients, glow or emoji; white background, ink and one red.
- Data shown: name, count and code only.
- Minor taste point: the two red X's sit over sample labels ("Ka…ke", "Sin…ong") and half-hide them.

**Icons.** Rendered at real size by Chromium at DPR 1 and 2 (`v10-icons/icons-dpr1.png`, `tabs-dpr1-x3.png`, which is a nearest-neighbour ×3 of the DPR-1 screenshot).
- `favicon-16.png` (pixel-hinted): crisp, reads as a grid with a red slash in both light and dark tab strips.
- `logo.svg` at 16 px, which Chrome may pick over the `.ico` since both are linked: slightly soft but still legible.
- `favicon-32.png` / SVG at 32: clear.
- `icon-192`: the art fills the rounded square.
- `icon-maskable-512`: the grid sits well inside the 80 % safe-zone circle, and stays intact even under a 40 %-radius circle mask. Pass.
- `favicon.ico`: header reserved 0, type 1, count 2; entries 16×16 and 32×32, 32 bpp, PNG-encoded, both decode.
- `/manifest.webmanifest`: 200 `application/manifest+json`. `icon-192.png` (192×192), `icon-512.png` (512×512) and `icon-maskable-512.png` (512×512, `purpose: maskable`) are all 200 `image/png` at the declared sizes. `apple-touch-icon.png` is 180×180; `favicon-16`/`-32` are 16/32.
- Small note: `public/sw-policy.js` `CACHE_VERSION` is still `v1` while icons and the layout changed. Harmless before the first deploy (icons are stale-while-revalidate).

**CSP.** There is none. The production `/` response carries no `Content-Security-Policy`, `X-Frame-Options`, `Referrer-Policy` or `Permissions-Policy`. So nothing restricts `connect-src` to the PostHog host, and nothing blocks it either.

### 10.5 Analytics privacy

**Init options** (`posthogOptions()`, frozen by a unit test):
- `persistence: "memory"`, `autocapture: false`, `capture_pageview: false`, `capture_pageleave: false`;
- `disable_session_recording: true`, surveys / tours / conversations / web experiments off;
- `advanced_disable_flags: true`, `disable_external_dependency_loading: true`;
- `save_referrer: false`, `save_campaign_params: false`, `mask_personal_data_properties: true`;
- `person_profiles: "identified_only"`, `respect_dnt: true`;
- an allow-list `sanitize_properties` and a `before_send` that drops unknown events and `$set` / `$set_once`.

`identify` is never called (grep). The app also does its own DNT/GPC check; that is unit-tested only, I did not run it in a browser.

**Captured payloads.** Two phones, decoded from `v10-ux-key/payloads.json` plus the spec's run:
- 4 requests, all `POST /__ph/e/` with no query string;
- no `/flags`, `/decide`, `/s/` or config GETs;
- top-level keys only `uuid, event, properties, timestamp`.

| Event (sent from) | Own props actually sent | SDK props present | Verdict |
| --- | --- | --- | --- |
| `game_created` (`CreateGameForm`) | `pack:"night-out"`, `free_center:true` | `$os, $browser, $device_type, $screen_*, $viewport_*, $lib, $lib_version, $insert_id, $time, distinct_id, token, $is_identified:false, $process_person_profile:false` | **pass** |
| `player_joined` (`JoinScreen`) | `late_join:false` | same | **pass**. Not sent for rematch joins (P16) |
| `game_started` (`Lobby`, host only) | `player_count:2`, `counter_squares:1` | same | **pass** |
| `square_completed` (`useBoardState`, applied only) | `counter:false`, `total_completed:2` | same | **pass** |
| `media_uploaded` (`useUploadedMedia`) | `kind` (enum) | not exercised (Storage is a 501 stub); code read only | **pass (by reading)** |
| `game_ended` (`BoardScreen`, host only) | `squares_completed, lines, blackout, duration_min, player_count, by:"host"` | same | **pass**. `by:"auto"` never sent (P16) |
| `recap_viewed` (`RecapViewedTracker`) | `media_count:0` | same | **pass**. The game id is only an in-memory dedupe key and is never sent |
| `play_again` (`RecapSummary`) | `source:"recap"` | same | **pass** |

- **Absent from every payload:** `$current_url`, `$pathname`, `$host`, `$referrer`, `$referring_domain`, `$initial_*`, `title`, `$session_id`, `$window_id`, `$set`, `$set_once`, and any name, code, game id, user id or square text. Both the spec's string scan and mine came up empty.
- **What remains:**
  - `distinct_id`: a fresh UUIDv7 per page load, which links one phone's events within a page load and encodes its start time;
  - device class only: OS, browser, device type, screen and viewport size;
  - request headers: `User-Agent` and the client IP reach PostHog;
  - with a same-origin host, the auth cookie too (P12).
- **No key** (production build): `posthog-js` lives in its own 323 KB chunk (`42czaq68gvcn3.js`). That chunk is referenced only from the analytics module's dynamic `import()`, never from the HTML of `/`, `/new` or `/g/<code>` (0 references; 8 initial scripts checked).
- **No key** (dev UX run): requests went only to `127.0.0.1:3000` and `127.0.0.1:54321`. No PostHog host was contacted.
- **Service worker:** PostHog's cross-origin host returns `null` from `selectStrategy` (`url.origin !== config.origin`). A same-origin proxy is never cached either: events are POSTs, and unknown same-origin GET paths fall through to `null`.

### 10.6 Logo review

**Brief:** "simplified 3×3 bingo grid drawn in thick marker strokes with one diagonal line scribbled through it in a bold accent color; must read clearly at 32 px; no gradients, no glow, no generic AI-style icon".

**Verdict: mostly meets it.**
- **Grid:** a 3×3 grid in 44/512 ink strokes with slight hand wobble (quadratic paths), on a cream rounded square.
- **Accent:** one red (`#c8302a`) diagonal.
- **Effects:** no gradient or glow.
- **Feel:** it does not look like a generic AI icon.
- **At 32 px:** grid and line read clearly (`v10-icons/icons-dpr1.png`). The hand-hinted 16 px version is crisp.

**Where it falls short:**
- The red line is not really "scribbled". Its second, thinner pass lies almost on top of the first, so at every size it reads as one clean bar.
- The bar runs corner to corner across the frame, so the mark can read as a strike-through, "cancelled grid" sign rather than a winning line.

**What I would change:**
- start and end the line inside the corner cells, through the three diagonal cell centres;
- offset the second pass visibly (about 12–16 units, slightly different angle) so it looks like a quick double marker stroke;
- optionally use round dot ends.

### 10.7 Only verifiable on a hosted project

- **Realtime:**
  - RLS-filtered delivery of the old game's UPDATE (`next_game_id` / `next_join_code`) to old members only;
  - no events for non-members of the rematch;
  - the recap flip time without the 1.5 s e2e poll (production poll is 15 s, so it depends on Realtime).
- **Supabase DELETE events** are not RLS-checked (primary keys only); confirm that this is acceptable.
- **PostgREST/Kong anon rate limiting on `peek_game_public`.** Codes have 40 bits; with no rate limit, enumeration is still impractical, but nothing throttles it.
- **Vercel CDN** behaviour of the card's `s-maxage` / SWR (P14).
- **Real unfurls:** iMessage, WhatsApp, Signal, Slack, Discord and X fetching the public `NEXT_PUBLIC_APP_URL`, including preview deployments, where `og:image` points at whatever `NEXT_PUBLIC_APP_URL` says.
- **PostHog project settings:**
  - "Discard client IP data" and GeoIP enrichment (the IP and User-Agent reach PostHog regardless of the client allow-list);
  - data region (us/eu);
  - the bot filter (headless and crawler traffic is dropped, which the spec works around by spoofing a phone UA).
- **Production behaviour with a key built in** (I only ran the keyed build in dev).
- **Postgres 17 / hosted `postgres` role** for the new migration (it uses only core functions and `on delete set null`; nothing found that hosted would reject).

### 10.8 Verdict

- **10a:** the security model is sound. `peek_game_public` is the only anon-executable function and returns only the four preview fields. `play_again` is member-only, ended-only, idempotent and race-safe (10-way REST races, six rounds). The rematch stays invisible to old members until they join with the code, and the cron's FK behaviour is correct.
- **10b:** the cards and icons are on-brand, legible, fast (about 80–120 ms warm in production) and leak nothing.
- **10c:** analytics sends only the allow-listed counts and enums, with no personal data, and stays unloaded without a key.

Nothing blocks a deploy. Before or right after deploying:
- move the rematch link below "Back to home" (P11);
- do not point PostHog at a same-origin proxy, or strip cookies if you do (P12);
- harden `metadataBase` against an empty or invalid `NEXT_PUBLIC_APP_URL` (P15);
- shorten the card's CDN cache (P14).

The rest are nits.

## Phase 10 resolution (2026-10-24)

- **P11** fixed in working tree: `PlayAgainLink` moved to `src/components/recap/PlayAgainLink.tsx` and rendered by `GameScreen` after "Back to home" (centred, muted, 44 px); `e2e/play-again.spec.ts` asserts it is the lowest in-flow element and below `back-home` at 375 px in light and dark.
- **P12** fixed in cf914b4 (PostHog host must be cross-origin or strip `Cookie`; documented).
- **P13** fixed in working tree: `/g/[code]` renders a `<Suspense><Connection/></Suspense>` marker (`await connection()`), the documented Next 16 way to make request-time metadata intentional; no dev log line and no overlay issue on `/g/<code>`; the preview stays uncached (live status and head count).
  Seen while checking: in dev, crawler user agents (`htmlLimitedBots`, e.g. `facebookexternalhit`, `Twitterbot`) still log Next's own `Invariant: Route "/g/[code]" did not produce a static shell … This is a bug in Next.js`. It is pre-existing (the HEAD page logs it too), dev-only, answers 200 with the right tags and shows no overlay (bots only). `export const instant = false` silences it but also changes the route's prefetch hints, so it was not applied.
- **P14** fixed in cf914b4 (card CDN cache shortened).
- **P15** fixed in cf914b4 (`metadataBase` hardened against empty / invalid `NEXT_PUBLIC_APP_URL`).
- **P16** fixed in working tree for the rematch: `play_again` is sent only when this call created the rematch (`createdRematch`: no known pointer before and the returned host is this phone; deduped per page load); one-tap Join and the lost-race join fallback send `player_joined` (`late_join` from the rematch's status). Still open by design: `game_ended` with `by: "auto"` (24 h auto-ends happen in the cron with no client to report them; `game_ended` stays host-only) and `recap_viewed.media_count` read once at mount.
- **P17** deferred: pathological all-wide 60-char names only; needs width-based text measuring in the card.
- **P18** deferred: framework-level 500 on malformed percent-encoding in production (also `/game/[id]`); needs a `proxy.ts` guard or an upstream fix.
- **P19** deferred: rematch colours follow join order; keeping colours needs a `play_again` / `join_game` change in SQL.
- **P20** fixed in working tree (UI half): the old recap looks up the rematch's effective status (member `select` when readable, else `peek_game_public(next_join_code)`, not-found = expired) and shows no rematch link once it has ended (`rematchKind` unit-tested, e2e step "once the rematch has ended…"). `play_again` accepting an expired old game is deferred (harmless; a migration).
- **P21** fixed in working tree: the logo's red line is now a three-pass marker scribble (up, hooked turn, back down, half-way up) through the diagonal cell centres, same colours and widths; `logo-16.svg` keeps a single clean diagonal; every PNG and `favicon.ico` regenerated with `scripts/make-icons.mjs` and checked by eye at 192 px and 32 px.

## Phase 11 verification (2026-10-26)

**Scope:** the host-set game deadline (`games.deadline_at`) that replaced the fixed 24-hour auto-end (11a migration + RPCs, 11b presets / picker, 11c create / lobby / board / recap wiring). Independent agent that did not build it; nothing was fixed. This section is the only change to the repo (`git status` shows only `VERIFICATION.md`).
**Environment:** local stand-in backend (`127.0.0.1:54321`, `bingo_local`), Postgres 16 (`bingo_test` for SQL), Chromium via Playwright 1.63 with `next dev` on :3000 (`NEXT_PUBLIC_SYNC_POLL_MS=1500`, `NEXT_PUBLIC_ENABLE_SW=1`; stopped afterwards). Wall clock during the run: Sun 2026-10-25 ~23:45–00:10 in New York, which happened to exercise the "Sunday night" edge of the weekend preset live.
**Evidence** (scratchpad, outside the repo): `/tmp/claude-0/-home-user-BinGo/8bb7be13-4a03-5c1c-a267-bab4a95a5cb6/scratchpad/`
- scripts: `v11-probe.mjs` (REST probes, 71 lines of output), `v11-probe2.mjs` (expiry / old lobby), `v11-db.sql` (psql schema / cron), `v11-tzhdr.mjs` (session time zone), `v11-tz.mts` (preset time-zone matrix, run with `node --experimental-strip-types --import ./v11-alias.mjs`), `v11-ux.mjs` (two-phone playthrough), `v11-ux2.mjs` / `v11-ux3.mjs` (skewed clocks, offline extension, stale-row provocation), `v11-drift.mjs` (picker drift);
- logs: `v11-*.log`, `v11-tz-table.md` (all 146 cases); screenshots: `v11-ux/`, `v11-ux2/`, `v11-ux3/`, `v11-drift/`.

### 11.1 Gate results

| Gate | Result | Exact output |
| --- | --- | --- |
| `npm run lint` | **pass** (exit 0) | `> eslint`, no findings |
| `npm run build` | **pass** (exit 0) | Next.js 16.4.3 (Turbopack), compiled in 511 ms, TypeScript OK, 9/9 static pages; routes unchanged (`/g/[code]` and `/game/[id]` ◐) |
| `npm run test` | **pass** (exit 0) | `Test Files 30 passed (30)`, `Tests 462 passed (462)` |
| `npm run db:test` | **pass** (exit 0) | `==> 34 passed, 0 failed`; new: (ac) create deadline, (ad) `set_deadline`, (ae) `extend_deadline`, (af) `deadline_passed`, (ag) effective status past the deadline, (ah) deadline schema; (m) / (p) now use `deadline_at` |
| `npm run e2e` | **pass** (exit 0) | `25 passed, 1 skipped (5.0m)`; the skip is `analytics.spec.ts` (needs a PostHog host, as in Phase 10); `deadline.spec.ts` passed in 46.4 s |

### 11.2 Findings

No Blocker or Major. The database enforces every deadline rule I probed, the presets land on the right wall-clock time in every zone and DST case I tried, and the board countdown is quiet.

**P22. The 1-day extension cap and the 7-day maximum follow the request's session time zone, which any client can set. Severity: Minor.**
- **Repro** (`v11-tzhdr.mjs`): an active game with `deadline_at = 2026-10-31T12:00Z`; `extend_deadline(…, '2026-11-01T13:00Z')` (+25 h, across the New York fall-back) → `400 invalid_deadline`; the same call with the header `Prefer: timezone=America/New_York` → `200`, stored `2026-11-01T08:00-05:00` (PostgREST answered `Preference-Applied: timezone=America/New_York`). Likewise `create_game(deadline_at = now + 7 d 1 h 5 min)` → `invalid_deadline` normally, `200` with the header.
- **Expected:** "at most current `deadline_at` + 1 day (exact, no slack)" and "now + 9 min … now + 7 days 10 min" (CLAUDE.md, Database API).
- **Actual:** `extend_deadline` uses `interval '1 day'` and `private.validate_deadline` uses `interval '7 days'`; for `timestamptz` the day part is a calendar day in the session `TimeZone` (23 h or 25 h across DST). Only search_path is pinned. Local default is `Etc/UTC`, so normal clients and the SQL suite never see it. Impact is one hour, at most, near a DST change.
- **Files:** `supabase/migrations/20261026024940_game_deadline.sql` (`validate_deadline`, `extend_deadline`).
- **Suggestion:** a new migration that uses `interval '24 hours'` / `'168 hours'` (or `set timezone = 'UTC'` on the functions), plus a SQL test under `set local timezone = 'America/New_York'`.

**P23. A stale games row can briefly undo the host's extension and offer Extend again. Severity: Minor.**
- **Repro** (`v11-ux3.mjs` part C, `v11-ux2.mjs` last check): a host phone whose `games` reads arrive 1.4 s late (Playwright route; a slow bar connection), the host completes squares just before and after tapping Extend +3 h. The sampled countdown went `2h 56m → 5h 56m → 2h 56m → 5h 56m`. During the ~1.4 s revert the reopened Players sheet showed "Extend deadline" again (`ext=1`), where it had said "Deadline extended once". Reproduced in 2 of 4 runs with square taps, 0 of 3 runs without them.
- **Expected:** once a phone has shown the extension, it never shows the old deadline again.
- **Cause:** `fetchOnce` (`useGame.ts`) retries a fetch that raced a mutation only `RACE_RETRIES = 2` times, then accepts it. `mergeGame` (`realtime.ts`) accepts any games row of the same status, because games have no `updated_at` to compare (squares do). So the last attempt's games row, read before the extension committed, overwrites the RPC result. On a hosted project, Realtime square events count as mutations too, so a friend's phone can hit the same path.
- **Effect:** transient (until the next poll or games event). A second Extend tap gets "The deadline can only be extended once." If the old deadline falls inside the window, the phone flips to the recap and back. The same race can revert a lobby `set_deadline` on the host's phone.
- **Files:** `src/lib/game/realtime.ts` (`mergeGame`), `src/lib/game/useGame.ts` (`fetchOnce`).
- **Suggestion:** while active, never take a row with `deadline_extended_at = null` over one that has it set (a live deadline only moves once, later); or add a games `updated_at` and compare it like squares.

**P24. A phone with a wrong clock ends the game early or late. Severity: Minor (phones normally sync their clock from the network).**
- **Repro** (`v11-ux2.mjs`, `v11-ux3.mjs` part A; Playwright `clock.install` at ±10 min):
  - Deadline set to real now + 5 min. The **fast** phone went to the recap 0.95 s later. Host, friend and slow phone still showed `4m`, `4m` and `14m`, and the server still accepted the host's completion (`square 1 completed = t`).
  - After the real deadline, the **slow** phone stayed on the board showing `10m`. A tap there showed "Couldn't save Sing on stage at karaoke — the game had already ended", and the board stayed up.
  - In the lobby the fast phone read `· 23h 49m` while the others read `23h 59m`. The "1 hour left." toast follows the phone clock too.
- **Expected** (spec 4): the game ends for everyone at the deadline.
- **Actual:** `effectiveStatus`, `useRerenderAt`, the countdowns and the toast all compare `deadline_at` with the phone's `Date.now()`. There is no server-time offset, and a `game_not_active` answer does not end the game on that phone. TESTING.md §14 already tells testers to note a wrong phone clock.
- **Files:** `src/lib/game/types.ts` (`effectiveStatus`), `src/components/game/GameScreen.tsx` (`useRerenderAt`), `src/lib/deadline/useNow.ts`, `src/lib/game/pendingActions.ts`.
- **Suggestion:** estimate a server clock offset (e.g. from fetch `Date` headers) and apply it to all deadline maths; treat `game_not_active` as "ended" and resync.

**P25. Picker drift: Create is greyed out with no reason, then the deadline jumps by a day (or a week). Severity: Nit.**
- **Repro** (`v11-drift.mjs`, New York phone clock 02:49:40, Tonight selected):
  - 02:49:41: "Tonight 3:00 AM · 10m", Create enabled.
  - 02:50:12: "· 9m", Create **disabled**, with no message.
  - 02:50:42: the row silently becomes "Tomorrow 3:00 AM · 1d", and Create is enabled again.
  - With "This weekend" clamped (Sunday 23:49:41), Create was disabled for about 15 s right after the tap.
- **Cause:** the picker's re-resolve clock ticks every 60 s (`useNow(60_000)`), while the form's validity clock ticks every 15 s (`useNow(15_000)`) and is older than the clamped value.
- **Lobby:** no unintended RPC. While the Change sheet's draft drifted, `set_deadline` was called 0 times and the lobby line was unchanged (only Save sends).
- **Files:** `src/components/deadline/DeadlinePicker.tsx`, `src/components/create/CreateGameForm.tsx`.
- **Suggestion:** one shared clock (or re-resolve the selected preset on submit), and a short line when a preset rolls over.

**P26. "This weekend (Sunday 11:59 PM)" does not give 11:59 PM late on Sunday or in the week of a fall-back. Severity: Nit.**
- From Sunday 23:49 on, it clamps to now + 7 days ("Sun, Nov 15, 11:55 PM").
- Seen live today in New York at 23:54: the row read "This weekend (Sunday 11:59 PM)" next to "Sun, Nov 1, 10:54 PM". 7 × 24 h across the Nov 1 fall-back ends an hour earlier on the wall clock.
- The row shows the real time, so nothing is hidden. Only the label and the value disagree.
- **File:** `src/lib/deadline/presets.ts` (`computePreset`).

**P27. At 320 px a long game name shrinks to two letters next to the countdown. Severity: Nit.**
- **Repro:** a 60-character "W…" name at 320 px: the title is 59 px ("WW…") and the countdown keeps its full "23h 59m" (`shrink-0`) (`v11-ux2/02-topbar-xlarge-320.png`).
- No horizontal scroll at any text size. The countdown stays 16 px whatever the text-size setting.
- **File:** `src/components/board/TopBar.tsx`.

**P28. `join_game` still renames an existing member after the deadline. Severity: Nit (pre-existing pattern).**
- **Repro:** probe e4b. A member calls `join_game(code, 'Bobby')` on an active game past `deadline_at` → `200`, `display_name = 'Bobby'`.
- The rename guard is `v_game.status <> 'ended'` (raw status), while every other check uses the effective status. CLAUDE.md says "updates display_name unless ended".
- **File:** migration `join_game`.

**P29. A lobby left open for more than 23 days can get a deadline after its album expiry. Severity: Nit (also noted in the builder's PHASES status).**
- **Repro:** `v11-probe2.mjs`. A lobby with `expires_at` 2 days away accepted `set_deadline(now + 6 d)` (`deadline_at > expires_at = t`).
- The cron would delete the game before its deadline.
- **Suggestion:** cap at `least(now + 7 d, expires_at)` for `set_deadline`.

**P30. TESTING.md §6 step 12's "If it fails" line is misleading. Severity: Nit (docs).**
- It says "The deadline can only be extended once." on a first try, or "Only the host can do that.", means the `game_deadline` migration isn't pushed.
- A missing migration makes `extend_deadline` unknown to PostgREST, so the phone would show the generic error copy, not those codes. And with the old schema the board would not load at all.

### 11.3 DB probe table

REST rows ran as real anonymous users against `127.0.0.1:54321` (`v11-probe.log`: 64 OK, 4 BAD; each BAD is explained in the table). psql rows ran on `bingo_test` (`v11-db.log`).

| # | Probe | Result | Evidence |
| --- | --- | --- | --- |
| a1 | `create_game` with `deadline_at` null / omitted | **pass** | `deadline_at − created_at = 86400.000000 s` both ways |
| a2–a3 | now + 5 min; now + 8 days | **pass** | `invalid_deadline` / `invalid_deadline` |
| a4–a5 | exactly now + 10 min; exactly now + 7 days | **pass** | both 200 |
| a6–a9 | slack edges: + 9 min 30 s; + 8 min 50 s; + 7 d 9 min; + 7 d 11 min | **pass** | 200 / `invalid_deadline` / 200 / `invalid_deadline` |
| a10–a14 | past time; `"tonight"`; blank name with a bad deadline; an offset string; the returned row | **pass** | `invalid_deadline`; `22007` cast error; `invalid_name` first; `…03:00-04:00` stored as `07:00Z`; `deadline_extended_at` null |
| b1 | `set_deadline` as non-host / non-member | **pass** | `not_host` / `game_not_found` |
| b2–b5 | + 5 min; null; + 90 min; a second change | **pass** | `invalid_deadline` / `invalid_deadline` / 200 / 200 |
| b6–b7 | after start (host / non-host) | **pass** | `game_not_in_lobby` / `not_host` |
| c1 | `extend_deadline` in the lobby (host / non-host) | **pass** | `game_not_active` / `not_host` |
| c2 | live, non-host / non-member | **pass** | `not_host` / `game_not_found` |
| c3–c5 | + 1 d + 1 min; + 1 d + 1 ms; = current; earlier; null | **pass** | `invalid_deadline` each; `deadline_extended_at` still null afterwards |
| c6 | exactly + 1 day | **pass** | 200; `deadline_extended_at` set; `expires_at` unchanged (`v11-probe2`: same value before and after; the probe-log "BAD c6b" only reflects my own time travel moving `created_at`) |
| c7 | second extension (valid and invalid value) | **pass** | `already_extended` both (`already_extended` is checked before the value) |
| c8 | extension when the current deadline already passed (psql) | **pass** | `game_not_active` |
| r1 | 6 parallel host extensions over separate connections | **pass** | exactly 1 × 200; 5 × `already_extended`; final deadline = the winner's |
| d1–d3 | `start_game` with a passed deadline: nobody ready / non-host / everyone ready | **pass** | `deadline_passed` / `not_host` / `deadline_passed`. Order: `not_host` → `game_not_in_lobby` → `deadline_passed` → `players_not_ready` |
| d4–d7 | overdue lobby: peek, late join, `set_deadline` then start | **pass** | still `lobby`; join 200; start 200 with `deadline_at` unchanged |
| e1–e3 | active past deadline: `complete_square` / `increment_square` / `undo_completion` | **pass** | `game_not_active` × 3 |
| e4 | `join_game`: newcomer / existing member | **pass** / Nit | `game_ended`; the member is renamed (P28; the probe-log "BAD e4b") |
| e5–e6 | `peek_game` / anon `peek_game_public` | **pass** | `status: ended` |
| e7 | `register_media` past deadline | **pass** | 200 (ended games take media before expiry) |
| e8–e9, e13, e15 | `set_deadline` / `extend_deadline` past the deadline, after `end_game`, or on an ended game | **pass** | `game_not_in_lobby`; `game_not_active` (checked before `already_extended`; the probe-log "BAD e9 / e13" were my wrong expectations) |
| e10–e12 | `end_game` non-host; overdue host; again | **pass** | `not_host`; `ended_at = deadline_at` exactly; unchanged on repeat |
| e14 | `end_game` before the deadline | **pass** | `ended_at ≈ now` |
| e16 | `auto_end_due_games` as service_role (psql) | **pass** | overdue active → `ended`, `ended_at = deadline_at`; a live game and an overdue lobby untouched; `authenticated` → `42501` |
| f1–f4 | `play_again` on an overdue (and extended) game | **pass** | rematch `deadline_at − created_at = 1 day`, `deadline_extended_at` null, `expires_at = created_at + 30 days` |
| g | `expires_at` vs deadline: 7-day deadline, extension, rematch | **pass** | always `created_at + 30 days`. Extension can take a game to 8 days after creation |
| h1 | check constraints | **pass** | `deadline_at = created_at`, `< created_at` and null rejected; `deadline_extended_at` on a lobby rejected; `games_status_timestamps` without the old column (lobby / active / ended rules hold) |
| h2 | partial index | **pass** | `games_deadline_at_active_idx … (deadline_at) WHERE status = 'active'`; the cron's lookup uses it (Index Scan) |
| h3 | privileges | **pass** | anon executes only `public.peek_game_public` (shim's pgcrypto excluded); `create_game` (5 args), `set_deadline`, `extend_deadline` granted to `authenticated` only, `security definer`, search_path pinned; private helpers no grants; `auto_end_due_games` service_role only |
| h4 | no function still references the dropped column | **pass** | `pg_proc.prosrc ilike '%auto_end_at%'` → 0 rows; no policy mentions it |
| i | `grep -rn auto_end_at src e2e supabase/tests` | **pass** | only `src/lib/game/activeGame.ts:161,163,169` (the documented legacy-record mapping) |
| tz | session `TimeZone` via `Prefer: timezone=` | **Minor** | P22 |
| x | old lobby near expiry | Nit | P29 |

### 11.4 Time-zone table

`computePreset` from `src/lib/deadline/presets.ts`, run in Node for 146 "now" instants × 3 presets (438 results). Every result was checked for:
- within now + 10 min … now + 7 days;
- landing on the intended wall clock, read back with `Intl.DateTimeFormat` in that zone: Tonight 03:00 within 25 h; 24 hours exactly + 24 h; Weekend Sunday 23:59, or the 7-day clamp.

**0 failures.** The full matrix is in `v11-tz-table.md`.

| Zone | Wed 00:30 | Wed 02:55 | Wed 03:00 | Wed 17:00 | Wed 23:00 | Sun 23:49 | Sun 23:55 | DST nights (00:30–03:05, 17:00, 23:xx) | Result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| America/New_York | T today 03:00 (+2.5 h) | T Thu 03:00 (+24.1 h) | T Thu 03:00 (+24 h) | T 03:00 (+10 h) | T 03:00 (+4 h) | W tonight 23:59 (+10 min) | W clamp Sun 11/15 23:55 | 03-08 and 11-01, 23 cases: T always 03:00; 24 h shifts the wall clock ±1 h (17:00→18:00 / 16:00) | 32/32 pass |
| Europe/London | same pattern | +24.1 h | +24 h | +10 h | +4 h | +10 min | clamp | 03-29 and 10-25, incl. the second 01:30 (GMT) → T 03:00 (+1.5 h) | 32/32 pass |
| Asia/Kolkata | +2.5 h | +24.1 h | +24 h | +10 h | +4 h | +10 min | clamp | no DST | 9/9 pass |
| Pacific/Auckland | +2.5 h | +24.1 h | +24 h | +10 h | +4 h | +10 min | clamp | 04-05 (03:00 NZDT→02:00): first 02:30 → T 03:00 NZST (+1.5 h), second 02:30 → +0.5 h; 09-27 gap: 01:59 → next day (03:00 is 1 min away) | 32/32 pass |
| Pacific/Kiritimati (UTC+14) | +2.5 h | +24.1 h | +24 h | +10 h | +4 h | +10 min | clamp | no DST | 9/9 pass |
| America/St_Johns (−3:30/−2:30) | +2.5 h | +24.1 h | +24 h | +10 h | +4 h | +10 min | clamp | 03-08 and 11-01 incl. the second 01:30 NST → T 03:00 (+1.5 h) | 32/32 pass |

Notes:
- "Tonight" from 02:51 to the next evening gives tomorrow's 03:00. At 02:55 that is 24 h 5 min, and the row says "Tomorrow 3:00 AM", which is honest. On spring-forward nights, 01:51–01:59 also rolls to the next day, because 03:00 is only minutes away.
- "24 hours" is exactly 24 elapsed hours, so across DST its wall time moves by an hour. The row shows it.
- At exactly 03:00, Tonight and 24 hours give the same instant and `matchPreset` reads it as Tonight (6 cases). This is documented.
- `zonedTimeToInstant`: gaps push forward (NY 03-08 02:30 → 03:30 EDT); overlaps take the first occurrence (NY 11-01 01:30 → EDT).
- The `describeDeadline` wording was right in every case ("Tonight / Today / Tomorrow / weekday / full date").

### 11.5 UI playthrough notes (own script `v11-ux.mjs`, 26/26 checks pass)

Host phone: `America/New_York`, light. Friend phone: `Asia/Kolkata`, dark. Both 375×812 at DPR 2.

1. **Create (default).**
   - The picker preselects Tonight: "Tonight 3:00 AM", "Tomorrow 11:54 PM", "Sun, Nov 1, 10:54 PM" (P26 live), "Pick a time".
   - Stored `2026-10-26T07:00:00Z` = 3:00 AM New York.
   - The radiogroup is labelled "Game ends"; the radios are 48 px (Weekend 76 px, two lines) × 307 px (`01-create-host-ny.png`).
2. **Lobby on both phones.**
   - Host: "Ends tonight 3:00 AM · 3h 5m". Friend: "Ends today 12:30 PM · 3h 5m".
   - Same instant, each phone's zone, identical time left. The friend has no Change control; the host's Change is 86×44 (`02-lobby-*.png`).
3. **Change → This weekend.**
   - Save → DB in 36 ms → the friend's line updated 269 ms later.
   - Host "Ends Sun, Nov 1, 10:54 PM · 6d 23h". Friend "Ends Mon, Nov 2, 9:24 AM · 6d 23h".
4. **Passed (psql).**
   - Both lines read "Passed" (red, `rgb(180,35,24)`) within 1.6 s. Start is disabled.
   - Host copy: "Pick a new deadline first". Friend copy: "Waiting for Hosty to set a new deadline" (`04-passed-*.png`).
   - The Change sheet starts on Tonight. Custom 50 min → stored, shown as "Ends tonight 12:45 AM · 50m" / "Ends today 10:15 AM · 50m". Start re-enabled with Ready kept.
5. **Board countdown.**
   - "50m" sits right after the title (gap 0 px, vertically centred), 44×44 tap target, `aria-label="Time left: 50m. Players"`.
   - Type: 16 px Patrick Hand against a 20 px marker / Bebas title.
   - Under 1 h it takes the board ink; above 1 h it is muted: `#575d64` on white, `#b1ab9e` on near-black (`v11-ux2/01-topbar-muted-*.png`).
   - **Judgement: subtle.** It reads as a quiet note after the name and does not compete with the grid in either theme (`05-board-whiteboard-host.png`, `v11-ux2/01-board-muted-scoreboard.png`). Taste note: in Dark Scoreboard the handwritten face is the only pencil glyph on the board; a condensed face would match better.
   - No horizontal scroll at 375 or 320 at any text size (P27 for very long names).
6. **Under a toast.** When "Friendo got Sing on stage at karaoke" covered the title, the countdown went to opacity 0 with `aria-hidden="true"` and `tabindex=-1` (`06-toast-over-title-host.png`).
7. **"1 hour left."**
   - Exactly once per phone, right at the start (50 min left), on both phones; stored in `bingo.deadlineToast.<id>`.
   - 0 again after a reload on both phones. 0 after the +1 h extension (1 h 50 m left).
   - The toast itself is a bordered box in the title slot (`05-board-scoreboard-friend.png`).
8. **Extend +1 hour.**
   - Host countdown in 3 ms (overlay); friend 525 ms (poll). DB +3600 s exactly.
   - The host's Players sheet then reads "Deadline extended once", with no Extend button. The friend's sheet has no Extend or End game and reads "Ends today 11:15 AM (1h 50m)".
   - Extend options are radios, 48 px; the radiogroup is labelled "New deadline".
9. **Late joiner** (`Europe/London`): the countdown "1h 50m" was in the DOM 3 ms after the grid.
10. **Instant return.**
    - `bingo.activeGame.deadlineAt` and `snapshot.game.deadline_at` equal the extended deadline, with `deadline_extended_at` set.
    - An offline reload drew the board with "1h 50m" in 97 ms (`09-offline-reload-friend.png`).
11. **Auto-end.**
    - Deadline set to now + 20 s (psql). Host, friend and late joiner were on "Night recap" 437–438 ms after the deadline.
    - `data-status=ended`, `bingo.activeGame` cleared, `bingo.lastEnded` noted. The server row was still `active` (the cron is only the backstop).
    - "Your games" row: "… Ended · Album until Nov 24".

### 11.6 Edge probes

- **(a) Extension race:** 6 parallel `extend_deadline` calls from the host over separate HTTP connections → exactly one 200, five `already_extended` (row lock). **Pass.**
- **(b) Stale row after an extension:**
  - **Reasoning.** Realtime delivers one games UPDATE per extension, in commit order. Polls are serialised (`running` / `queued`). A fetch that raced an applied event or RPC result is retried. So a revert needs the retries exhausted (`RACE_RETRIES = 2`) and a final attempt whose games read predates the commit.
  - **Provoked:** yes, see P23 (slow reads plus concurrent taps; 2 of 4 runs).
  - **Classification:** Minor. It is transient and the server stays authoritative. Its worst effect is a flicker to the recap and back when the old deadline is seconds away.
- **(c) Picker auto-`onChange` drift:**
  - Lobby: cannot cause a `set_deadline` (0 calls; only Save sends).
  - Create form: does change the value silently (Tonight +24 h, Weekend to the 7-day clamp), with a 15–60 s greyed-out Create beforehand (P25).
- **(d) Wrong phone clock (±10 min):** see P24.
  - Countdown and toast are off by the skew. A fast phone shows the recap early (server still live). A slow phone stays on the board after the real deadline, and its taps are refused with the "already ended" notice.
  - The presets on a skewed phone are computed from its own clock. A phone 10 min slow choosing "Tonight" at 02:49 would get `invalid_deadline` with clear copy.
- **(e) Cron:**
  - `src/lib/cleanup/runCleanup.ts:170` still calls `rpc("auto_end_due_games")` first.
  - The SQL now ends `status = 'active' and deadline_at <= now()` with `ended_at = deadline_at`, via the new partial index. **Pass** (psql e16).
- **(f) Accessibility. Pass.**
  - Picker: `role=radiogroup` (labelled by the visible "Game ends" heading), `role=radio` + `aria-checked`, roving tabindex, arrows / Home / End, 48 px rows.
  - Custom input: labelled, with an `aria-live` hint, `aria-invalid` when out of range.
  - Lobby Change: 86×44, accessible name "Change when the game ends".
  - Countdown: a 44×44 button named "Time left: … Players", hidden from assistive tech under a toast, no live region (quiet by design). Toast copy is plain text.
  - Muted contrast, computed with the WCAG formula: 6.66:1 (light) and 8.6:1 (dark).
- **(g) Docs.**
  - `README.md` (nothing time-based), `DEPLOY.md` (checklist picks a deadline), `HUMAN_STEPS.md` (6 migrations), `FINAL_REPORT.md` ("The fixed 24-hour auto-end is gone…") and `TESTING.md` (§6 deadline steps, §14 auto-end) match the code.
  - No stale "games end after 24 hours" copy in docs or UI. Remaining "24 hours" strings are the preset, the server default and the +24 h extension, all correct.
  - One misleading troubleshooting line (P30).
- **Extra: offline phone across a last-minute extension** (`v11-ux3` B).
  - While offline, the friend showed the recap at the old deadline (activeGame cleared, `lastEnded` noted; it cannot know better).
  - Back online, it returned to the board in 1.2 s, re-saved `bingo.activeGame` with the new `deadlineAt`, and `/` landed on the live board.
  - `bingo.lastEnded` stays unconsumed but harmless. Info only.
- **Extra: the host's own phone near the deadline.** `GameScreen.useRerenderAt` follows `result.game.deadline_at`, not `BoardScreen`'s extension overlay. A host who extends seconds before the deadline on a slow connection briefly sees the recap until the RPC answers. Info, from reading the code; not run.

### 11.7 Verdict

The deadline is enforced by the database:
- bounds, host-only, lobby-only edits;
- live-only, once-only, ≤ 1 day extension, race-safe;
- `deadline_passed`;
- effective status in every RPC;
- cron backstop on a partial index;
- album expiry from creation.

The presets are correct in all six zones, including the DST nights, UTC+14 and half-hour offsets. On the board the countdown is small, muted, hidden under toasts, and never pushes the grid. Every phone reached the recap within half a second of the deadline. Nothing blocks shipping. Worth fixing:
- make the SQL caps time-zone-proof (P22);
- stop a stale games row from undoing an extension (P23);
- consider a server clock offset for phones with wrong clocks (P24).

The rest are nits.

## Phase 11 resolution (2026-10-26)

- **P22** fixed in working tree: new migration `20261026041631_deadline_hours_and_games_updated_at.sql` re-creates `private.validate_deadline` (`interval '9 minutes'` … `interval '168 hours' + interval '10 minutes'`) and `extend_deadline` (cap `interval '24 hours'`) in elapsed hours, with a comment on why (calendar days follow the session `TimeZone`, which `Prefer: timezone=` sets). SQL test (ai): under `America/New_York` across the next fall back and spring forward, `current + 24 h + 1 min` → `invalid_deadline`, `current + 24 h` → ok; `now + 169 h` → `invalid_deadline`, `now + 168 h` → ok; the same in POSIX zones with a DST change 3 days out. Run against the old function bodies, (ai) fails.
- **P23** fixed in working tree: `games.updated_at` (not null, default `now()`, backfilled with `coalesce(ended_at, started_at, created_at)`, stamped `clock_timestamp()` by `games_set_updated_at`, the squares trigger function; no RLS or grant change), test (aj). `mergeGame` (so `applyGameChange`, `applyGame` and `mergeSnapshot`) drops a same-status row whose `updated_at` is older or equal (µs, `compareGameVersions`); status still never moves backwards; rows without a stamp fall back to the status rule. Unit tests replay the verifier's sequence (RPC result, then a stale snapshot: the extension stays; a newer row or the end still wins). New e2e step in `deadline.spec.ts` answers every host `games` read with the pre-extension row for 6 s after Save: the phone only ever shows `1d` and no Extend button. With the old merge rule the same step shows `23h 59m` and Extend again (the verifier's flicker, reproduced).
- **P24** deferred: phones keep their clocks NTP-synced, and the server enforces the real deadline in every RPC whatever a phone shows.
- **P25** fixed in working tree: the picker's clock wakes the moment the selected value goes under 10 minutes (`useNowUntil`, `tooSoonFromMs`), re-resolves the preset and shows one line under the rows ("Updated to the next 3 AM — the earlier time is less than 10 minutes away"; also "24 hours from now" / "the next weekend") until the next pick. The form checks validity on a clock no older than the value (a weekend clamp is valid the instant it is picked) and names any other deadline reason Create is disabled (`deadlineBlockMessage`). New e2e step: 02:49:40 New York, stepped a second at a time past 02:50, Create is always enabled or explained. With the HEAD picker and form the step fails at 02:50:09 (disabled, no message). Still open: the lobby Change sheet's Save keeps its own 15 s clock (`LobbyDeadline.tsx`, not in this change), so after a weekend clamp it can be disabled for a few seconds.
- **P26** by design: the row shows the real resolved time; the 7-day cap is 168 hours.
- **P27** fixed in working tree: in `TopBar` a name over 8 characters gets a floor of about 8 characters (5em marker, 4em scoreboard, never more than leaves room for the countdown's first unit), and the countdown (`white-space: nowrap`, whole units only) drops to its leading unit when there is no room for both: at 320 px "Saturday pub crawl on Main St!" with 2 players shows "Saturday…" + "23h" (whiteboard, was 5 characters) and "SATURDAY …" + "23h 43m" (scoreboard). With 4 players: scoreboard 8 characters + "23h" (was 5), whiteboard 6 + "23h" (was 4); 8 marker characters need 99 px and the slot is 116 px. No horizontal scroll at 320 or 375 px; `settings.spec.ts` green.
- **P28** fixed in working tree: `join_game` leaves an existing member's name alone once the game is effectively ended (ended, active past its deadline, or past `expires_at`), test (ak).
- **P29** deferred: the cron deletes the game at `expires_at` anyway.
- **P30** fixed in working tree: TESTING.md §6 step 12 now gives the real causes ("Only the host can do that." = Phone A's sign-in changed; "can only be extended once" on a first try = already extended; the generic copy = `extend_deadline` missing from the database).
- Gates: `npm run db:test` 37 passed, 0 failed (new (ai), (aj), (ak)); `npm run lint` clean; `npm run build` OK; `npm run test` 31 files, 483 tests passed; `npm run backend:status` 7 migrations; `npm run e2e` 27 passed, 1 skipped (analytics, needs a PostHog host).
