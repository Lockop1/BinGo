-- =============================================================================
-- Game RPCs. Every state change in the app goes through these functions.
--
-- Conventions (documented for the UI in CLAUDE.md > Database API):
--   * SECURITY DEFINER, search_path pinned, every object schema-qualified.
--   * Each RPC first raises 'not_authenticated' when auth.uid() is null
--     (auto_end_due_games is the service-role exception).
--   * Errors are raised as SQLSTATE P0001 with a stable snake_case message,
--     e.g. 'game_not_found'. PostgREST returns it as error.message.
--   * A caller who is not a player of the game gets 'game_not_found', exactly
--     like a nonexistent game, so membership cannot be probed.
--   * An 'active' game whose auto_end_at has passed is treated as ended by
--     every RPC, even before the cron flips its status.
--   * Parameters share names with columns, so inside SQL statements columns
--     are always alias-qualified and parameters function-qualified (or copied
--     into v_ locals). plpgsql's default variable_conflict = error turns any
--     slip into a loud runtime error instead of a silent wrong match.
-- =============================================================================

-- Return types -------------------------------------------------------------------

-- Result of complete_square / increment_square / undo_completion: whether this
-- call changed the square, plus the authoritative square row after the call.
create type public.square_result as (
  applied boolean,
  id uuid,
  game_id uuid,
  position smallint,
  label text,
  details text,
  target_count integer,
  current_count integer,
  completed_by_player_id uuid,
  completed_at timestamptz,
  updated_at timestamptz
);

-- Result of peek_game: the only data a non-member can see, given a join code.
create type public.game_preview as (
  name text,
  status public.game_status,
  player_count integer,
  free_center boolean
);

-- Internal helpers ---------------------------------------------------------------
-- Schema `private` is not exposed by PostgREST and the API roles have no USAGE
-- on it, so these can only be called from inside the RPCs (which run as the
-- function owner).

create schema if not exists private;
revoke all on schema private from public, anon, authenticated, service_role;

-- Collapses all whitespace runs (including newlines) to one space and trims.
create function private.normalize_single_line(value text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select btrim(regexp_replace(coalesce(normalize_single_line.value, ''), '\s+', ' ', 'g'));
$$;

-- Trims leading/trailing whitespace, keeps inner newlines.
create function private.normalize_multi_line(value text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select regexp_replace(coalesce(normalize_multi_line.value, ''), '^\s+|\s+$', '', 'g');
$$;

create function private.make_square_result(applied boolean, sq public.squares)
returns public.square_result
language sql
immutable
set search_path = public, pg_temp
as $$
  select row(make_square_result.applied, (make_square_result.sq).*)::public.square_result;
$$;

-- create_game ---------------------------------------------------------------------

create function public.create_game(
  name text,
  host_name text,
  free_center boolean default true,
  squares jsonb default '[]'::jsonb
)
returns public.games
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_name text;
  v_host_name text;
  v_squares jsonb;
  v_labels text[] := array_fill(''::text, array[25]);
  v_details text[] := array_fill(''::text, array[25]);
  v_targets integer[] := array_fill(1, array[25]);
  v_seen boolean[] := array_fill(false, array[25]);
  v_elem jsonb;
  v_num numeric;
  v_idx integer;
  v_type text;
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_bytes bytea;
  v_code text;
  v_attempt integer := 0;
  v_game public.games;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  v_name := private.normalize_single_line(create_game.name);
  if char_length(v_name) not between 1 and 60 then
    raise exception 'invalid_name';
  end if;

  v_host_name := private.normalize_single_line(create_game.host_name);
  if char_length(v_host_name) not between 1 and 24 then
    raise exception 'invalid_display_name';
  end if;

  -- squares: jsonb array of up to 25 {position, label?, details?, target_count?}.
  v_squares := coalesce(create_game.squares, '[]'::jsonb);
  if jsonb_typeof(v_squares) <> 'array' then
    raise exception 'invalid_squares';
  end if;
  if jsonb_array_length(v_squares) > 25 then
    raise exception 'invalid_squares';
  end if;

  for v_elem in select t.e from jsonb_array_elements(v_squares) as t(e) loop
    if jsonb_typeof(v_elem) <> 'object' then
      raise exception 'invalid_squares';
    end if;

    if jsonb_typeof(v_elem -> 'position') is distinct from 'number' then
      raise exception 'invalid_squares';
    end if;
    v_num := (v_elem ->> 'position')::numeric;
    if v_num <> trunc(v_num) or v_num < 0 or v_num > 24 then
      raise exception 'invalid_squares';
    end if;
    v_idx := v_num::integer + 1;
    if v_seen[v_idx] then
      raise exception 'invalid_squares';
    end if;
    v_seen[v_idx] := true;

    v_type := coalesce(jsonb_typeof(v_elem -> 'label'), 'null');
    if v_type = 'string' then
      v_labels[v_idx] := private.normalize_single_line(v_elem ->> 'label');
    elsif v_type <> 'null' then
      raise exception 'invalid_squares';
    end if;
    if char_length(v_labels[v_idx]) > 40 then
      raise exception 'label_too_long';
    end if;

    v_type := coalesce(jsonb_typeof(v_elem -> 'details'), 'null');
    if v_type = 'string' then
      v_details[v_idx] := private.normalize_multi_line(v_elem ->> 'details');
    elsif v_type <> 'null' then
      raise exception 'invalid_squares';
    end if;
    if char_length(v_details[v_idx]) > 200 then
      raise exception 'details_too_long';
    end if;

    v_type := coalesce(jsonb_typeof(v_elem -> 'target_count'), 'null');
    if v_type = 'number' then
      v_num := (v_elem ->> 'target_count')::numeric;
      if v_num <> trunc(v_num) or v_num < 1 or v_num > 99 then
        raise exception 'invalid_target_count';
      end if;
      v_targets[v_idx] := v_num::integer;
    elsif v_type <> 'null' then
      raise exception 'invalid_target_count';
    end if;
  end loop;

  -- Join code: 8 symbols from a 32-symbol alphabet (40 bits), drawn from
  -- gen_random_uuid() (a CSPRNG). Bytes 0-5 and 9-10 of a v4 UUID are fully
  -- random and 256 is a multiple of 32, so every symbol is uniform. Retries on
  -- the (astronomically unlikely) unique collision.
  loop
    v_attempt := v_attempt + 1;
    v_bytes := uuid_send(gen_random_uuid());
    v_code := '';
    for i in 0..7 loop
      v_code := v_code || substr(
        v_alphabet,
        (get_byte(v_bytes, case when i < 6 then i else i + 3 end) % 32) + 1,
        1
      );
    end loop;

    insert into public.games as g (join_code, name, host_user_id, free_center)
    values (v_code, v_name, v_uid, coalesce(create_game.free_center, true))
    on conflict on constraint games_join_code_key do nothing
    returning g.* into v_game;

    exit when found;
    if v_attempt >= 10 then
      raise exception 'join_code_generation_failed';
    end if;
  end loop;

  insert into public.players (game_id, user_id, display_name, color, is_ready)
  values (v_game.id, v_uid, v_host_name, 0, false);

  insert into public.squares (game_id, position, label, details, target_count)
  select v_game.id, gs.pos, v_labels[gs.pos + 1], v_details[gs.pos + 1], v_targets[gs.pos + 1]
  from generate_series(0, 24) as gs(pos);

  return v_game;
end;
$$;

comment on function public.create_game(text, text, boolean, jsonb) is
  'Creates a lobby game with 25 squares; the caller becomes host and player color 0.';

-- join_game -----------------------------------------------------------------------

create function public.join_game(code text, display_name text)
returns public.players
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_code text;
  v_display_name text;
  v_game public.games;
  v_player public.players;
  v_count integer;
  v_color smallint;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  v_display_name := private.normalize_single_line(join_game.display_name);
  if char_length(v_display_name) not between 1 and 24 then
    raise exception 'invalid_display_name';
  end if;

  v_code := upper(regexp_replace(coalesce(join_game.code, ''), '[^A-Za-z0-9]', '', 'g'));

  -- Per-game lock: concurrent joins of the same game serialize here, so the
  -- player count and the lowest free color are read and used atomically.
  select g.* into v_game
  from public.games g
  where g.join_code = v_code
  for update;

  if not found then
    raise exception 'game_not_found';
  end if;

  -- Already a member: idempotent. Refresh the display name unless ended.
  select p.* into v_player
  from public.players p
  where p.game_id = v_game.id
    and p.user_id = v_uid;

  if found then
    if v_game.status <> 'ended' and v_player.display_name <> v_display_name then
      update public.players p
      set display_name = v_display_name
      where p.id = v_player.id
      returning p.* into v_player;
    end if;
    return v_player;
  end if;

  if v_game.status = 'ended'
     or (v_game.status = 'active' and v_game.auto_end_at <= now())
     or v_game.expires_at <= now() then
    raise exception 'game_ended';
  end if;

  select count(*) into v_count
  from public.players p
  where p.game_id = v_game.id;

  if v_count >= 10 then
    raise exception 'game_full';
  end if;

  select min(c.color) into v_color
  from generate_series(0, 9) as c(color)
  where not exists (
    select 1 from public.players p
    where p.game_id = v_game.id
      and p.color = c.color
  );

  insert into public.players as p (game_id, user_id, display_name, color, is_ready)
  values (v_game.id, v_uid, v_display_name, v_color, false)
  returning p.* into v_player;

  return v_player;
end;
$$;

comment on function public.join_game(text, text) is
  'Joins a game by join code (case-insensitive) in lobby or active; idempotent for members.';

-- peek_game -----------------------------------------------------------------------

create function public.peek_game(code text)
returns public.game_preview
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_code text;
  v_result public.game_preview;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  v_code := upper(regexp_replace(coalesce(peek_game.code, ''), '[^A-Za-z0-9]', '', 'g'));

  select
    g.name,
    case
      when g.status = 'ended'
        or (g.status = 'active' and g.auto_end_at <= now())
        or g.expires_at <= now()
        then 'ended'::public.game_status
      else g.status
    end,
    (select count(*)::integer from public.players p where p.game_id = g.id),
    g.free_center
  into v_result
  from public.games g
  where g.join_code = v_code;

  if not found then
    raise exception 'game_not_found';
  end if;

  return v_result;
end;
$$;

comment on function public.peek_game(text) is
  'Join-screen preview by join code: name, effective status, player count, free_center.';

-- set_ready -----------------------------------------------------------------------

create function public.set_ready(game_id uuid, ready boolean)
returns public.players
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
  where p.game_id = set_ready.game_id
    and p.user_id = v_uid;
  if not found then
    raise exception 'game_not_found';
  end if;

  -- Share lock: serializes against start_game (which takes FOR UPDATE).
  select g.* into v_game from public.games g where g.id = v_player.game_id for share;

  if v_game.status <> 'lobby' then
    raise exception 'game_not_in_lobby';
  end if;
  if set_ready.ready is null then
    raise exception 'invalid_argument';
  end if;

  update public.players p
  set is_ready = set_ready.ready
  where p.id = v_player.id
  returning p.* into v_player;

  return v_player;
end;
$$;

-- update_square -------------------------------------------------------------------

create function public.update_square(
  game_id uuid,
  "position" integer,
  label text,
  details text,
  target_count integer
)
returns public.squares
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_pos integer := "position";
  v_label text;
  v_details text;
  v_target integer;
  v_player public.players;
  v_game public.games;
  v_square public.squares;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  select p.* into v_player
  from public.players p
  where p.game_id = update_square.game_id
    and p.user_id = v_uid;
  if not found then
    raise exception 'game_not_found';
  end if;

  -- Share lock: an edit racing start_game either lands before the start or
  -- sees status 'active' and is rejected. Squares never change after start.
  select g.* into v_game from public.games g where g.id = v_player.game_id for share;

  if v_game.status <> 'lobby' then
    raise exception 'game_not_in_lobby';
  end if;
  if v_pos is null or v_pos not between 0 and 24 then
    raise exception 'invalid_position';
  end if;

  v_label := private.normalize_single_line(update_square.label);
  if char_length(v_label) > 40 then
    raise exception 'label_too_long';
  end if;

  v_details := private.normalize_multi_line(update_square.details);
  if char_length(v_details) > 200 then
    raise exception 'details_too_long';
  end if;

  v_target := coalesce(update_square.target_count, 1);
  if v_target not between 1 and 99 then
    raise exception 'invalid_target_count';
  end if;

  -- Last write wins: the whole square content is replaced.
  update public.squares s
  set label = v_label,
      details = v_details,
      target_count = v_target,
      current_count = 0
  where s.game_id = v_game.id
    and s.position = v_pos
  returning s.* into v_square;

  if not found then
    raise exception 'invalid_position';
  end if;

  return v_square;
end;
$$;

-- set_free_center -----------------------------------------------------------------

create function public.set_free_center(game_id uuid, enabled boolean)
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
  where p.game_id = set_free_center.game_id
    and p.user_id = v_uid;
  if not found then
    raise exception 'game_not_found';
  end if;

  select g.* into v_game from public.games g where g.id = v_player.game_id for update;

  if v_game.host_user_id <> v_uid then
    raise exception 'not_host';
  end if;
  if v_game.status <> 'lobby' then
    raise exception 'game_not_in_lobby';
  end if;
  if set_free_center.enabled is null then
    raise exception 'invalid_argument';
  end if;

  update public.games g
  set free_center = set_free_center.enabled
  where g.id = v_game.id
  returning g.* into v_game;

  return v_game;
end;
$$;

-- start_game ----------------------------------------------------------------------

create function public.start_game(game_id uuid)
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

  -- Exclusive game lock: no join, ready toggle or square edit can interleave.
  select g.* into v_game from public.games g where g.id = v_player.game_id for update;

  if v_game.host_user_id <> v_uid then
    raise exception 'not_host';
  end if;
  if v_game.status <> 'lobby' then
    raise exception 'game_not_in_lobby';
  end if;
  if exists (
    select 1 from public.players p
    where p.game_id = v_game.id
      and not p.is_ready
  ) then
    raise exception 'players_not_ready';
  end if;

  update public.games g
  set status = 'active',
      started_at = now(),
      auto_end_at = now() + interval '24 hours'
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

-- complete_square -----------------------------------------------------------------

create function public.complete_square(game_id uuid, "position" integer)
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

  -- Share lock: serializes against end_game / auto-end, not against other
  -- completions.
  select g.* into v_game from public.games g where g.id = v_player.game_id for share;

  if v_game.status <> 'active' or v_game.auto_end_at <= now() then
    raise exception 'game_not_active';
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

  if found then
    return private.make_square_result(true, v_square);
  end if;

  -- Lost a race with a concurrent completion: report the winner's row.
  -- (RETURNING INTO nulls v_square when no row matched, hence v_square_id.)
  select s.* into v_square from public.squares s where s.id = v_square_id;
  return private.make_square_result(false, v_square);
end;
$$;

-- increment_square ----------------------------------------------------------------

create function public.increment_square(
  game_id uuid,
  "position" integer,
  expected_count integer default null
)
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
  where p.game_id = increment_square.game_id
    and p.user_id = v_uid;
  if not found then
    raise exception 'game_not_found';
  end if;

  select g.* into v_game from public.games g where g.id = v_player.game_id for share;

  if v_game.status <> 'active' or v_game.auto_end_at <= now() then
    raise exception 'game_not_active';
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

  if v_square.target_count <= 1 then
    raise exception 'not_counter';
  end if;

  if v_square.completed_at is not null then
    return private.make_square_result(false, v_square);
  end if;

  -- Atomic +1. Reaching target_count completes the square and credits the
  -- caller. With expected_count set it is a compare-and-set, so a retried
  -- request (e.g. after a lost response offline) cannot count twice.
  v_square_id := v_square.id;

  update public.squares s
  set current_count = s.current_count + 1,
      completed_at = case when s.current_count + 1 >= s.target_count then now() end,
      completed_by_player_id = case when s.current_count + 1 >= s.target_count then v_player.id end
  where s.id = v_square_id
    and s.completed_at is null
    and (increment_square.expected_count is null or s.current_count = increment_square.expected_count)
  returning s.* into v_square;

  if found then
    return private.make_square_result(true, v_square);
  end if;

  -- (RETURNING INTO nulls v_square when no row matched, hence v_square_id.)
  select s.* into v_square from public.squares s where s.id = v_square_id;
  return private.make_square_result(false, v_square);
end;
$$;

-- undo_completion -----------------------------------------------------------------

create function public.undo_completion(game_id uuid, "position" integer)
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

  select g.* into v_game from public.games g where g.id = v_player.game_id for share;

  if v_game.status <> 'active' or v_game.auto_end_at <= now() then
    raise exception 'game_not_active';
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

-- end_game ------------------------------------------------------------------------

create function public.end_game(game_id uuid)
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
  where p.game_id = end_game.game_id
    and p.user_id = v_uid;
  if not found then
    raise exception 'game_not_found';
  end if;

  select g.* into v_game from public.games g where g.id = v_player.game_id for update;

  if v_game.host_user_id <> v_uid then
    raise exception 'not_host';
  end if;

  -- Idempotent: ending an ended game returns it unchanged.
  if v_game.status = 'ended' then
    return v_game;
  end if;

  update public.games g
  set status = 'ended',
      ended_at = case
        when g.status = 'active' and g.auto_end_at <= now() then g.auto_end_at
        else now()
      end
  where g.id = v_game.id
  returning g.* into v_game;

  return v_game;
end;
$$;

-- register_media ------------------------------------------------------------------

create function public.register_media(
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

-- auto_end_due_games (service role / cron only) -----------------------------------

-- No auth.uid() check: the service-role JWT has no `sub`. Access is limited by
-- EXECUTE privilege, which only service_role holds.
create function public.auto_end_due_games()
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
      ended_at = g.auto_end_at
  where g.status = 'active'
    and g.auto_end_at <= now();

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Function privileges ---------------------------------------------------------------
-- Reset to nothing, then allow exactly one role per function.

revoke all on function private.normalize_single_line(text) from public, anon, authenticated, service_role;
revoke all on function private.normalize_multi_line(text) from public, anon, authenticated, service_role;
revoke all on function private.make_square_result(boolean, public.squares) from public, anon, authenticated, service_role;

revoke all on function public.create_game(text, text, boolean, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.join_game(text, text) from public, anon, authenticated, service_role;
revoke all on function public.peek_game(text) from public, anon, authenticated, service_role;
revoke all on function public.set_ready(uuid, boolean) from public, anon, authenticated, service_role;
revoke all on function public.update_square(uuid, integer, text, text, integer) from public, anon, authenticated, service_role;
revoke all on function public.set_free_center(uuid, boolean) from public, anon, authenticated, service_role;
revoke all on function public.start_game(uuid) from public, anon, authenticated, service_role;
revoke all on function public.complete_square(uuid, integer) from public, anon, authenticated, service_role;
revoke all on function public.increment_square(uuid, integer, integer) from public, anon, authenticated, service_role;
revoke all on function public.undo_completion(uuid, integer) from public, anon, authenticated, service_role;
revoke all on function public.end_game(uuid) from public, anon, authenticated, service_role;
revoke all on function public.register_media(uuid, integer, text, text) from public, anon, authenticated, service_role;
revoke all on function public.auto_end_due_games() from public, anon, authenticated, service_role;

grant execute on function public.create_game(text, text, boolean, jsonb) to authenticated;
grant execute on function public.join_game(text, text) to authenticated;
grant execute on function public.peek_game(text) to authenticated;
grant execute on function public.set_ready(uuid, boolean) to authenticated;
grant execute on function public.update_square(uuid, integer, text, text, integer) to authenticated;
grant execute on function public.set_free_center(uuid, boolean) to authenticated;
grant execute on function public.start_game(uuid) to authenticated;
grant execute on function public.complete_square(uuid, integer) to authenticated;
grant execute on function public.increment_square(uuid, integer, integer) to authenticated;
grant execute on function public.undo_completion(uuid, integer) to authenticated;
grant execute on function public.end_game(uuid) to authenticated;
grant execute on function public.register_media(uuid, integer, text, text) to authenticated;
grant execute on function public.auto_end_due_games() to service_role;
