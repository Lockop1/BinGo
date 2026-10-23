# Phases

Update the checkbox and status notes as each phase lands. See `CLAUDE.md` for invariants.

- [x] **Phase 0 — Scaffold and project docs**
  - Status notes: DONE. Next.js 16.4.3 (Turbopack), folder skeleton, Supabase clients/proxy, env template, CLAUDE.md, PHASES.md, README local setup.
- [x] **Phase 1 — Schema, RLS, RPCs** [EXTRA-HIGH]
  - Status notes: DONE. 3 migrations (core schema + RLS, 13 RPCs, private game-media bucket + storage policies), 21/21 SQL tests green via `npm run db:test` on the local shim, generated `src/types/database.ts`, Database API table in CLAUDE.md. Not yet pushed to a hosted project (needs the human: `npx supabase db push`). Local PostgREST+GoTrue harness in `scripts/local-backend` (`npm run backend:*`).
- [ ] **Phase 2 — Home, create, join**
  - Status notes: not started.
- [ ] **Phase 3 — Lobby**
  - Status notes: not started.
- [ ] **Phase 4 — Live board** [EXTRA-HIGH]
  - Status notes: not started.
- [ ] **Phase 5 — Themes, transition, settings**
  - Status notes: not started.
- [ ] **Phase 6 — Media, sharing, recap**
  - Status notes: not started.
- [ ] **Phase 7 — Instant return and offline** [EXTRA-HIGH]
  - Status notes: not started.
- [ ] **Phase 8 — Cleanup, polish, deploy**
  - Status notes: not started.
- [ ] **Phase 9 — Independent verification**
  - Status notes: not started.
