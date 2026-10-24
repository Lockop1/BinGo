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
