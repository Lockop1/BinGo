# Phases

Update the checkbox and status notes as each phase lands. See `CLAUDE.md` for invariants.

- [x] **Phase 0 — Scaffold and project docs**
  - Status notes: DONE. Next.js 16.4.3 (Turbopack), folder skeleton, Supabase clients/proxy, env template, CLAUDE.md, PHASES.md, README local setup.
- [x] **Phase 1 — Schema, RLS, RPCs** [EXTRA-HIGH]
  - Status notes: DONE. 3 migrations (core schema + RLS, 13 RPCs, private game-media bucket + storage policies), 21/21 SQL tests green via `npm run db:test` on the local shim, generated `src/types/database.ts`, Database API table in CLAUDE.md. Not yet pushed to a hosted project (needs the human: `npx supabase db push`). Local PostgREST+GoTrue harness in `scripts/local-backend` (`npm run backend:*`).
- [x] **Phase 2 — Home, create, join**
  - Status notes: DONE. Silent anonymous sign-in (SessionProvider/SessionGate), typed RPC wrappers + GameError copy, 10-color palette with contrast tests, starter packs (Night Out, Day Adventure, Blank) with safety tests, paper-look home `/`, create `/new`, join `/g/[code]`, game stub `/game/[id]` with `useGame`. Playwright e2e (two contexts create+join) green against the local backend: `npm run e2e`.
- [x] **Phase 3 — Lobby**
  - Status notes: DONE. Realtime channel per game (postgres_changes on games/players/squares) + resync on SUBSCRIBED/visibility/online/poll (`NEXT_PUBLIC_SYNC_POLL_MS`, default 15s), pure merge reducers unit-tested; paper lobby with invite share/copy, player list with ready checks, Ready dock, host free-space toggle + Start (enabled only when all ready), square editor sheet with last-write-wins + conflict prompt. e2e `e2e/lobby.spec.ts` green via the poll path (Realtime events cannot be exercised locally).
- [x] **Phase 4 — Live board** [EXTRA-HIGH]
  - Status notes: DONE. BoardScreen (top bar, 5×5 grid with container-query text, seeded SVG scribble cross-offs, initials badges), SquareSheet with press-and-hold Complete / +1 counters (compare-and-set) / Undo, pendingActions store (per-square queue, backoff, pluggable persistence) + boardState overlays with reconciliation rules (a)–(g) unit-tested, toast queue, haptics, bingo/blackout detection with once-per-phone celebrations persisted in localStorage, PlayersSheet with host End game. e2e `e2e/board.spec.ts` covers cross-off+toast, one-time bingo, undo rules, counters, offline completion sync, end game.
- [x] **Phase 5 — Themes, transition, settings**
  - Status notes: DONE. Settings store (`bingo.settings`: theme scoreboard/whiteboard/null=system, text size, square size) with `useSettings`; Whiteboard (marker lines) and Dark Scoreboard (amber dotted lights, lit completed cells) token sets; SettingsSheet with "(phone default)" and "Follow phone setting"; StartTransition overlay with whiteboard and scoreboard variants (~1s, fires on every phone on a live lobby→active flip only, 300ms fade under reduced motion); theme-aware player colors everywhere on the board. e2e `e2e/settings.spec.ts`: theme follows color scheme, transition on both phones, all 12 combinations fit 320/375px, persistence.
- [x] **Phase 6 — Media, sharing, recap**
  - Status notes: DONE. 6a: compressImage (1600px JPEG, EXIF), checkVideo (15s/50MB), prepareMedia, upload queue (upsert:false, `<game_id>/<position>/<uuid>.<ext>`, retry/definitive errors) + register_media, signed-URL cache, AddMediaButton (camera-first + library), ShareButton, Recap (paper summary + dark story viewer, per-item Save, Download all zip, available-until nudge), dev media lab + e2e. 6b: media rows in useGame/Realtime, MediaActions + thumbnail strip in the square sheet, album button with live story, recap on the ended screen, media toasts. Real uploads/signed URLs unverified locally (Storage stubbed) — needs the hosted smoke test.
- [ ] **Phase 7 — Instant return and offline** [EXTRA-HIGH]
  - Status notes: not started.
- [ ] **Phase 8 — Cleanup, polish, deploy**
  - Status notes: not started.
- [ ] **Phase 9 — Independent verification**
  - Status notes: not started.
