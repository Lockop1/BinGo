-- =============================================================================
-- Start countdown, how a game ended (incl. blackout), media after the end
-- (playtest fixes, round 1).
--
--   * games.countdown_ends_at: start_game sets it to now() + 5 seconds as the
--     game goes active. Every phone counts down to this one server timestamp,
--     so the board appears everywhere at the same moment. Until it passes,
--     complete_square / increment_square / undo_completion raise
--     countdown_in_progress (checked right after game_not_active, before
--     invalid_position). Null in a lobby (a play_again rematch starts with
--     null, like any new lobby) and on games started before this migration.
--   * games.end_reason: why an ended game ended. 'host' (end_game, the lobby
--     included), 'deadline' (end_game on a game already past its deadline, or
--     the auto_end_due_games cron), 'blackout' (complete_square /
--     increment_square applied the completion that crossed off the 25th
--     square: the game ends in the same transaction, ended_at = now(), and the
--     call still returns its square_result). Set exactly when status = 'ended'
--     (games_end_reason_iff_ended). Existing ended games are backfilled:
--     'deadline' when they ended at or after their deadline, else 'host'.
--     Ending is final: undo_completion after a blackout is game_not_active,
--     like any other ended game.
--   * Blackout detection must see every other completion: complete_square and
--     increment_square now take the game row FOR NO KEY UPDATE (was FOR
--     SHARE), so completions of one game apply one after another and the one
--     that finishes the board always sees the other 24 squares. FOR NO KEY
--     UPDATE still lets foreign-key checks (FOR KEY SHARE) through, and every
--     call is a single short transaction. undo_completion keeps FOR SHARE: it
--     cannot finish a board, and FOR SHARE still waits for a completion that
--     is deciding the blackout (and vice versa).
--   * register_media after the end (status 'ended', or 'active' past its
--     deadline, which every RPC treats as ended; until expires_at as before):
--     allowed for a square the caller's own player row completed, or for any
--     completed square within 10 minutes of the end (ended_at, or deadline_at
--     for an overdue game), so uploads in flight when a blackout (or the host)
--     ends the game still land. Otherwise not_allowed (checked after
--     square_not_completed). A repeat of a registration that already exists
--     (same path, player and square: its answer was lost) still returns that
--     row. Live games are unchanged: any member, any completed square.
--     The storage INSERT policy (can_upload_game_media: member, active or
--     ended, before expires_at) is unchanged; register_media is the gate, and
--     the phone removes an object the RPC refused.
--
-- RLS, policies, table privileges, replica identity and the Realtime
-- publication are unchanged: the new columns are read like the rest of the
-- row (members only; the games SELECT grant covers every column), Realtime
-- carries them with every games update (replica identity full), and only the
-- SECURITY DEFINER RPCs below write them. Functions are re-created with
-- `create or replace` and the same signatures, so their grants are kept.
--
-- Conventions as in the game RPC migration: SECURITY DEFINER, search_path
-- pinned, every object schema-qualified, errors raised as stable snake_case
-- messages (SQLSTATE P0001), non-members get game_not_found, parameters that
-- share a column's name are function-qualified (or copied into v_ locals).
-- All intervals are elapsed time (seconds / minutes), never calendar units.
-- =============================================================================

-- games: countdown and end reason ---------------------------------------------------

alter table public.games
  add column countdown_ends_at timestamptz,
  add column end_reason text;

-- Games that ended before this migration: at (or after) the deadline means
-- the deadline ended it (auto_end_due_games, or end_game on an overdue game,
-- both of which set ended_at = deadline_at); anything earlier was the host.
update public.games g
set end_reason = case when g.ended_at >= g.deadline_at then 'deadline' else 'host' end
where g.status = 'ended';

alter table public.games
  add constraint games_end_reason_values
    check (end_reason in ('host', 'deadline', 'blackout')),
  add constraint games_end_reason_iff_ended
    check ((status = 'ended') = (end_reason is not null)),
  -- Only a started game counts down, and not from before its start.
  add constraint games_countdown_after_start
    check (countdown_ends_at is null or (started_at is not null and countdown_ends_at >= started_at));

comment on column public.games.countdown_ends_at is
  'Set by start_game to started_at + 5 seconds: every phone counts down to it, and completions wait for it (countdown_in_progress). Null in a lobby and on games started before it existed.';
comment on column public.games.end_reason is
  'Why the game ended: host (end_game), deadline (the deadline passed: cron, or end_game on an overdue game) or blackout (the 25th square was crossed off). Set exactly when status = ended.';

-- start_game: the countdown --------------------------------------------------------

create or replace function public.start_game(game_id uuid)
returns public.games
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_player public.players;
  v_game public.games;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  select p.* into v_player
  from public.players p
  where p.game_id = start_game.game_id
    and p.user_id = v_uid;
  if not found then
    raise exception 'game_not_found';
  end if;

  -- Exclusive game lock: no join, ready toggle, square or deadline edit can interleave.
  select g.* into v_game from public.games g where g.id = v_player.game_id for update;

  if v_game.host_user_id <> v_uid then
    raise exception 'not_host';
  end if;
  if v_game.status <> 'lobby' then
    raise exception 'game_not_in_lobby';
  end if;
  -- A lobby that sat past its deadline: the host picks a new one first.
  if v_game.deadline_at <= now() then
    raise exception 'deadline_passed';
  end if;
  if exists (
    select 1 from public.players p
    where p.game_id = v_game.id
      and not p.is_ready
  ) then
    raise exception 'players_not_ready';
  end if;

  -- Live from now, playable once the shared 5-second countdown has run out.
  update public.games g
  set status = 'active',
      started_at = now(),
      countdown_ends_at = now() + interval '5 seconds'
  where g.id = v_game.id
  returning g.* into v_game;

  if v_game.free_center then
    update public.squares s
    set completed_at = now(),
        completed_by_player_id = null,
        current_count = s.target_count,
        label = case when s.label = '' then 'FREE' else s.label end
    where s.game_id = v_game.id
      and s.position = 12;
  end if;

  return v_game;
end;
$$;

-- complete_square: countdown, blackout ---------------------------------------------

create or replace function public.complete_square(game_id uuid, "position" integer)
returns public.square_result
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_pos integer := "position";
  v_player public.players;
  v_game public.games;
  v_square public.squares;
  v_square_id uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  select p.* into v_player
  from public.players p
  where p.game_id = complete_square.game_id
    and p.user_id = v_uid;
  if not found then
    raise exception 'game_not_found';
  end if;

  -- Completions of one game apply one after another (and against end_game /
  -- auto-end / extend_deadline), so the one that finishes the board sees all
  -- the others: see the header.
  select g.* into v_game from public.games g where g.id = v_player.game_id for no key update;

  if v_game.status <> 'active' or v_game.deadline_at <= now() then
    raise exception 'game_not_active';
  end if;
  if v_game.countdown_ends_at > now() then
    raise exception 'countdown_in_progress';
  end if;
  if v_pos is null or v_pos not between 0 and 24 then
    raise exception 'invalid_position';
  end if;

  select s.* into v_square
  from public.squares s
  where s.game_id = v_game.id
    and s.position = v_pos;
  if not found then
    raise exception 'invalid_position';
  end if;

  -- Already completed (by anyone, including the free center): not an error.
  -- Return the authoritative row so an optimistic client can reconcile.
  if v_square.completed_at is not null then
    return private.make_square_result(false, v_square);
  end if;

  if v_square.target_count > 1 then
    raise exception 'is_counter';
  end if;

  v_square_id := v_square.id;

  update public.squares s
  set completed_at = now(),
      completed_by_player_id = v_player.id,
      current_count = s.target_count
  where s.id = v_square_id
    and s.completed_at is null
  returning s.* into v_square;

  if not found then
    -- Lost a race with a concurrent completion: report the winner's row.
    -- (RETURNING INTO nulls v_square when no row matched, hence v_square_id.)
    select s.* into v_square from public.squares s where s.id = v_square_id;
    return private.make_square_result(false, v_square);
  end if;

  -- Blackout: that was the last open square. The game ends now, for everyone.
  if not exists (
    select 1 from public.squares s
    where s.game_id = v_game.id
      and s.completed_at is null
  ) then
    update public.games g
    set status = 'ended',
        ended_at = now(),
        end_reason = 'blackout'
    where g.id = v_game.id;
  end if;

  return private.make_square_result(true, v_square);
end;
$$;

-- increment_square: countdown, blackout --------------------------------------------

create or replace function public.increment_square(
  game_id uuid,
  "position" integer,
  action_id uuid default null
)
returns public.square_result
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_pos integer := "position";
  v_action_id uuid := increment_square.action_id;
  v_player public.players;
  v_game public.games;
  v_square public.squares;
  v_logged uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  select p.* into v_player
  from public.players p
  where p.game_id = increment_square.game_id
    and p.user_id = v_uid;
  if not found then
    raise exception 'game_not_found';
  end if;

  -- One completion at a time per game (see complete_square and the header).
  select g.* into v_game from public.games g where g.id = v_player.game_id for no key update;

  if v_game.status <> 'active' or v_game.deadline_at <= now() then
    raise exception 'game_not_active';
  end if;
  if v_game.countdown_ends_at > now() then
    raise exception 'countdown_in_progress';
  end if;
  if v_pos is null or v_pos not between 0 and 24 then
    raise exception 'invalid_position';
  end if;

  -- Row lock: concurrent taps on this square apply one after another, each on
  -- the latest count (none is lost, the count never passes the target).
  select s.* into v_square
  from public.squares s
  where s.game_id = v_game.id
    and s.position = v_pos
  for update;
  if not found then
    raise exception 'invalid_position';
  end if;

  if v_square.target_count <= 1 then
    raise exception 'not_counter';
  end if;

  -- Already completed (by this tap's earlier attempt, or by anyone): no error,
  -- report the authoritative row so an optimistic client can reconcile.
  if v_square.completed_at is not null then
    return private.make_square_result(false, v_square);
  end if;

  -- With an action id, each tap counts at most once: a retry of an id that was
  -- already applied (e.g. the response was lost offline) changes nothing.
  -- (The conflict target is named by constraint: a bare `(action_id)` would be
  -- ambiguous with the parameter of the same name.)
  if v_action_id is not null then
    insert into public.square_increments as si (action_id, game_id, square_id, player_id)
    values (v_action_id, v_game.id, v_square.id, v_player.id)
    on conflict on constraint square_increments_pkey do nothing
    returning si.action_id into v_logged;

    if v_logged is null then
      return private.make_square_result(false, v_square);
    end if;
  end if;

  -- +1. Reaching target_count completes the square and credits the caller.
  update public.squares s
  set current_count = s.current_count + 1,
      completed_at = case when s.current_count + 1 >= s.target_count then now() end,
      completed_by_player_id = case when s.current_count + 1 >= s.target_count then v_player.id end
  where s.id = v_square.id
  returning s.* into v_square;

  -- Blackout: this +1 completed the last open square. The game ends now.
  if v_square.completed_at is not null and not exists (
    select 1 from public.squares s
    where s.game_id = v_game.id
      and s.completed_at is null
  ) then
    update public.games g
    set status = 'ended',
        ended_at = now(),
        end_reason = 'blackout'
    where g.id = v_game.id;
  end if;

  return private.make_square_result(true, v_square);
end;
$$;

-- undo_completion: countdown --------------------------------------------------------

create or replace function public.undo_completion(game_id uuid, "position" integer)
returns public.square_result
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_pos integer := "position";
  v_player public.players;
  v_game public.games;
  v_square public.squares;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  select p.* into v_player
  from public.players p
  where p.game_id = undo_completion.game_id
    and p.user_id = v_uid;
  if not found then
    raise exception 'game_not_found';
  end if;

  -- Share lock: an undo cannot finish the board; it still waits for (and is
  -- waited on by) a completion deciding the blackout.
  select g.* into v_game from public.games g where g.id = v_player.game_id for share;

  -- Ended includes a blackout: the board is final.
  if v_game.status <> 'active' or v_game.deadline_at <= now() then
    raise exception 'game_not_active';
  end if;
  if v_game.countdown_ends_at > now() then
    raise exception 'countdown_in_progress';
  end if;
  if v_pos is null or v_pos not between 0 and 24 then
    raise exception 'invalid_position';
  end if;

  select s.* into v_square
  from public.squares s
  where s.game_id = v_game.id
    and s.position = v_pos
  for update;
  if not found then
    raise exception 'invalid_position';
  end if;

  -- Not completed (e.g. a retried undo): nothing to do, report current state.
  if v_square.completed_at is null then
    return private.make_square_result(false, v_square);
  end if;

  -- The free center (completed by nobody) cannot be undone, even by the host.
  if v_square.completed_by_player_id is null then
    raise exception 'not_allowed';
  end if;
  if v_square.completed_by_player_id <> v_player.id and v_game.host_user_id <> v_uid then
    raise exception 'not_allowed';
  end if;

  update public.squares s
  set completed_at = null,
      completed_by_player_id = null,
      current_count = s.target_count - 1
  where s.id = v_square.id
  returning s.* into v_square;

  return private.make_square_result(true, v_square);
end;
$$;

-- end_game: records the reason ------------------------------------------------------

create or replace function public.end_game(game_id uuid)
returns public.games
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_player public.players;
  v_game public.games;
  v_overdue boolean;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  select p.* into v_player
  from public.players p
  where p.game_id = end_game.game_id
    and p.user_id = v_uid;
  if not found then
    raise exception 'game_not_found';
  end if;

  select g.* into v_game from public.games g where g.id = v_player.game_id for update;

  if v_game.host_user_id <> v_uid then
    raise exception 'not_host';
  end if;

  -- Idempotent: ending an ended game (whatever ended it) returns it unchanged.
  if v_game.status = 'ended' then
    return v_game;
  end if;

  -- A live game already past its deadline ended at the deadline, by the deadline.
  v_overdue := v_game.status = 'active' and v_game.deadline_at <= now();

  update public.games g
  set status = 'ended',
      ended_at = case when v_overdue then g.deadline_at else now() end,
      end_reason = case when v_overdue then 'deadline' else 'host' end
  where g.id = v_game.id
  returning g.* into v_game;

  return v_game;
end;
$$;

-- auto_end_due_games (service role / cron only): records the reason ------------------

-- No auth.uid() check: the service-role JWT has no `sub`. Access is limited by
-- EXECUTE privilege, which only service_role holds. The cron backstop: phones
-- already treat these games as ended (effective status).
create or replace function public.auto_end_due_games()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  update public.games g
  set status = 'ended',
      ended_at = g.deadline_at,
      end_reason = 'deadline'
  where g.status = 'active'
    and g.deadline_at <= now();

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- register_media: own squares after the end, any square within the grace ------------

create or replace function public.register_media(
  game_id uuid,
  "position" integer,
  storage_path text,
  kind text
)
returns public.media
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_pos integer := "position";
  v_path text := register_media.storage_path;
  v_kind text := register_media.kind;
  v_prefix text;
  v_player public.players;
  v_game public.games;
  v_square public.squares;
  v_media public.media;
  v_ended_at timestamptz;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  select p.* into v_player
  from public.players p
  where p.game_id = register_media.game_id
    and p.user_id = v_uid;
  if not found then
    raise exception 'game_not_found';
  end if;

  select g.* into v_game from public.games g where g.id = v_player.game_id for share;

  if v_game.status = 'lobby' then
    raise exception 'game_not_started';
  end if;
  if v_game.expires_at <= now() then
    raise exception 'game_expired';
  end if;

  if v_kind is null or v_kind not in ('photo', 'video') then
    raise exception 'invalid_kind';
  end if;

  -- '<game_id>/' followed by one or more '/'-separated segments; a segment
  -- starts with [A-Za-z0-9_-] (so no '.', '..' or empty segments).
  v_prefix := v_game.id::text || '/';
  if v_path is null
     or char_length(v_path) > 512
     or not starts_with(v_path, v_prefix)
     or substr(v_path, char_length(v_prefix) + 1)
        !~ '^[A-Za-z0-9_-][A-Za-z0-9._-]*(/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$' then
    raise exception 'invalid_storage_path';
  end if;

  if v_pos is null or v_pos not between 0 and 24 then
    raise exception 'invalid_position';
  end if;

  select s.* into v_square
  from public.squares s
  where s.game_id = v_game.id
    and s.position = v_pos;
  if not found then
    raise exception 'invalid_position';
  end if;

  if v_square.completed_at is null then
    raise exception 'square_not_completed';
  end if;

  -- After the end (ended, or live past its deadline): the caller's own
  -- squares until the album expires; anyone's completed square only within
  -- 10 minutes of the end, for uploads that were in flight when it ended.
  v_ended_at := case
    when v_game.status = 'ended' then v_game.ended_at
    when v_game.deadline_at <= now() then v_game.deadline_at
  end;
  if v_ended_at is not null
     and v_square.completed_by_player_id is distinct from v_player.id
     and now() > v_ended_at + interval '10 minutes' then
    -- A repeat of a registration that already went through (its answer was
    -- lost) still gets its row back.
    select m.* into v_media
    from public.media m
    where m.storage_path = v_path
      and m.game_id = v_game.id
      and m.player_id = v_player.id
      and m.square_id = v_square.id;
    if found then
      return v_media;
    end if;
    raise exception 'not_allowed';
  end if;

  insert into public.media as m (game_id, square_id, player_id, storage_path, kind)
  values (v_game.id, v_square.id, v_player.id, v_path, v_kind::public.media_kind)
  on conflict on constraint media_storage_path_key do nothing
  returning m.* into v_media;

  if found then
    return v_media;
  end if;

  -- Same path registered before: idempotent for the same player and square.
  select m.* into v_media from public.media m where m.storage_path = v_path;
  if v_media.game_id = v_game.id
     and v_media.player_id = v_player.id
     and v_media.square_id = v_square.id then
    return v_media;
  end if;

  raise exception 'invalid_storage_path';
end;
$$;

comment on function public.start_game(uuid) is
  'Host only, lobby only, everyone ready, deadline not passed: the game goes active with a 5-second countdown (countdown_ends_at) before squares can be completed.';
comment on function public.complete_square(uuid, integer) is
  'Any player, live games after the countdown: crosses off a normal square; the 25th completion ends the game (end_reason blackout).';
comment on function public.increment_square(uuid, integer, uuid) is
  'Any player, live games after the countdown: +1 on a counter square (idempotent per action_id); reaching the target completes it; the 25th completion ends the game (end_reason blackout).';
comment on function public.register_media(uuid, integer, text, text) is
  'Any player: records an uploaded object for a completed square. After the end, own squares only (any square within 10 minutes of the end); never past expires_at.';
