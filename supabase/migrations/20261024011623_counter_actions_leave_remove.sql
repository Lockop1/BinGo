-- =============================================================================
-- Counter +1 by client action id, lobby leave / remove, explicit service_role
-- table privileges.
--
--   * increment_square no longer takes `expected_count` (a compare-and-set that
--     silently dropped concurrent or offline taps). Each +1 now carries the
--     client's action id; public.square_increments remembers ids already
--     applied, so a retried request never counts twice while different taps,
--     however close together, all count.
--   * leave_game: a non-host player leaves a lobby. remove_player: the host
--     removes a player from the lobby. Either way start_game can no longer be
--     blocked forever by someone who left or never readies up.
--   * The cleanup cron (service_role) reads and deletes games; its table
--     privileges are now stated here instead of relying on Supabase's default
--     privileges for new tables.
--
-- Conventions as in the game RPC migration: SECURITY DEFINER, search_path
-- pinned, every object schema-qualified, errors raised as stable snake_case
-- messages (SQLSTATE P0001).
-- =============================================================================

-- square_increments ---------------------------------------------------------------
-- One row per applied counter +1 that carried an action id. Internal
-- bookkeeping for increment_square only: no client role can read or write it
-- (RLS on, no policies, no privileges for anon/authenticated). Rows go away
-- with their game (cascade), like everything else.

create table public.square_increments (
  action_id uuid primary key,
  game_id uuid not null references public.games (id) on delete cascade,
  square_id uuid not null references public.squares (id) on delete cascade,
  player_id uuid not null references public.players (id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.square_increments enable row level security;

comment on table public.square_increments is
  'Counter +1 actions already applied, by client action id (dedupes retries). Internal: no client access.';

-- square_id serves the squares cascade; game_id and player_id serve the
-- games / players cascades (the cleanup cron, leave_game, remove_player),
-- which would otherwise scan the whole table per deleted row.
create index square_increments_square_id_idx on public.square_increments (square_id);
create index square_increments_game_id_idx on public.square_increments (game_id);
create index square_increments_player_id_idx on public.square_increments (player_id);

-- No policies: RLS denies every row to the API roles. Privileges match that
-- (nothing for anon/authenticated); the cleanup cron's role keeps CRUD.
revoke all on table public.square_increments from anon, authenticated;
grant select, insert, update, delete on table public.square_increments to service_role;

-- increment_square ----------------------------------------------------------------

drop function public.increment_square(uuid, integer, integer);

create function public.increment_square(
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

  -- Share lock: serializes against end_game / auto-end, not against other taps.
  select g.* into v_game from public.games g where g.id = v_player.game_id for share;

  if v_game.status <> 'active' or v_game.auto_end_at <= now() then
    raise exception 'game_not_active';
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

  return private.make_square_result(true, v_square);
end;
$$;

comment on function public.increment_square(uuid, integer, uuid) is
  'Counter +1 (active games, target_count > 1). Idempotent per action_id; completes at the target, crediting the caller.';

-- leave_game ----------------------------------------------------------------------

create function public.leave_game(game_id uuid)
returns boolean
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
  where p.game_id = leave_game.game_id
    and p.user_id = v_uid;
  if not found then
    raise exception 'game_not_found';
  end if;

  -- Exclusive game lock, as in join_game: a concurrent join sees the player
  -- count and the free colors either before or after this leave, never half.
  select g.* into v_game from public.games g where g.id = v_player.game_id for update;

  -- Removed by the host while this call waited for the lock: not a member.
  if not exists (select 1 from public.players p where p.id = v_player.id) then
    raise exception 'game_not_found';
  end if;

  if v_game.status <> 'lobby' then
    raise exception 'game_not_in_lobby';
  end if;
  -- No host transfer: the host ends the game instead.
  if v_game.host_user_id = v_uid then
    raise exception 'host_cannot_leave';
  end if;

  delete from public.players p where p.id = v_player.id;

  return true;
end;
$$;

comment on function public.leave_game(uuid) is
  'A non-host player leaves a lobby (their players row is deleted, freeing the slot and color).';

-- remove_player -------------------------------------------------------------------

create function public.remove_player(game_id uuid, player_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_me public.players;
  v_game public.games;
  v_removed uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  select p.* into v_me
  from public.players p
  where p.game_id = remove_player.game_id
    and p.user_id = v_uid;
  if not found then
    raise exception 'game_not_found';
  end if;

  -- Exclusive game lock, as in join_game / leave_game.
  select g.* into v_game from public.games g where g.id = v_me.game_id for update;

  if v_game.host_user_id <> v_uid then
    raise exception 'not_host';
  end if;
  if v_game.status <> 'lobby' then
    raise exception 'game_not_in_lobby';
  end if;
  if remove_player.player_id = v_me.id then
    raise exception 'not_allowed';
  end if;

  delete from public.players p
  where p.game_id = v_game.id
    and p.id = remove_player.player_id
  returning p.id into v_removed;

  if v_removed is null then
    raise exception 'player_not_found';
  end if;

  return true;
end;
$$;

comment on function public.remove_player(uuid, uuid) is
  'Host only, lobby only: removes another player from the game (e.g. someone who left without tapping Leave).';

-- Function privileges ---------------------------------------------------------------
-- Reset to nothing, then allow exactly the signed-in role (as for every RPC).

revoke all on function public.increment_square(uuid, integer, uuid) from public, anon, authenticated, service_role;
revoke all on function public.leave_game(uuid) from public, anon, authenticated, service_role;
revoke all on function public.remove_player(uuid, uuid) from public, anon, authenticated, service_role;

grant execute on function public.increment_square(uuid, integer, uuid) to authenticated;
grant execute on function public.leave_game(uuid) to authenticated;
grant execute on function public.remove_player(uuid, uuid) to authenticated;

-- Cleanup cron table privileges -------------------------------------------------------
-- The cron route uses the service-role client: auto_end_due_games, then
-- select / delete of expired games (cascading to players, squares, media and
-- square_increments). Stated explicitly so it never depends on the hosted
-- project's default privileges for new tables. RLS is unaffected
-- (service_role bypasses it on Supabase, as before).

grant select, insert, update, delete on table public.games, public.players, public.squares, public.media
  to service_role;
