-- =============================================================================
-- Host-set game deadline (replaces the fixed 24-hour auto end).
--
--   * games.deadline_at (not null): when the game ends automatically. The host
--     picks it when creating the game (presets are computed on the phone in its
--     time zone; the server only validates: 10 minutes to 7 days from now,
--     with a few minutes of slack for clock drift and slow submits) and may
--     change it in the lobby with set_deadline.
--     create_game without a deadline uses now() + 24 hours.
--   * games.deadline_extended_at: set by extend_deadline, the host's single
--     extension while the game is live (later, by at most one day).
--   * Every effective-status check that used auto_end_at now uses deadline_at:
--     an 'active' game whose deadline_at has passed is treated as ended by every
--     RPC before the cron flips it; auto_end_due_games (the cron backstop) and
--     end_game on an overdue game set ended_at = deadline_at.
--   * start_game no longer sets an end time; it refuses a lobby whose deadline
--     has already passed (deadline_passed) until the host picks a new one.
--   * play_again's rematch lobby gets now() + 24 hours (the host edits it in
--     the lobby) and no extension.
--   * games.auto_end_at is dropped once nothing uses it. expires_at (the album,
--     created_at + 30 days) is unchanged.
--
-- RLS, policies, table privileges, replica identity and the Realtime
-- publication are unchanged: the new columns are read like the rest of the
-- row (members only), Realtime carries them with every games update, and only
-- the SECURITY DEFINER RPCs below write them.
--
-- Conventions as in the game RPC migration: SECURITY DEFINER, search_path
-- pinned, every object schema-qualified, errors raised as stable snake_case
-- messages (SQLSTATE P0001), non-members get game_not_found, parameters that
-- share a column's name are function-qualified (or copied into v_ locals).
-- =============================================================================

-- games: deadline columns ---------------------------------------------------------

alter table public.games
  add column deadline_at timestamptz,
  add column deadline_extended_at timestamptz;

-- Existing games keep the end they already had: a started game its
-- auto_end_at (= started_at + 24 h), anything else 24 hours after creation.
update public.games g
set deadline_at = coalesce(g.auto_end_at, g.started_at + interval '24 hours', g.created_at + interval '24 hours');

alter table public.games
  alter column deadline_at set not null,
  add constraint games_deadline_after_created check (deadline_at > created_at),
  -- Only a started game can have been extended (extend_deadline is live-only).
  add constraint games_deadline_extended_after_start
    check (deadline_extended_at is null or started_at is not null);

-- The status / timestamp consistency rule, without auto_end_at.
alter table public.games drop constraint games_status_timestamps;
alter table public.games
  add constraint games_status_timestamps check (
    (status = 'lobby' and started_at is null and ended_at is null)
    or (status = 'active' and started_at is not null and ended_at is null)
    or (status = 'ended' and ended_at is not null)
  );

-- The cron's "active and due" lookup.
drop index public.games_auto_end_at_active_idx;
create index games_deadline_at_active_idx on public.games (deadline_at) where status = 'active';

comment on column public.games.deadline_at is
  'When the game ends automatically (an active game past it is effectively ended). Host-set: 10 minutes to 7 days ahead (validate_deadline allows a little slack); set_deadline in the lobby, extend_deadline once while live.';
comment on column public.games.deadline_extended_at is
  'When the host used the single live extension (extend_deadline); null until then.';

-- Internal helpers -----------------------------------------------------------------

-- A deadline the host may pick (create_game, set_deadline). The rule shown to
-- people is "10 minutes to 7 days from now"; the phone's picker can offer
-- exactly either bound, and its clock drifts and submits take time, so the
-- server accepts a little either side: from now + 9 minutes to now + 7 days
-- 10 minutes.
create function private.validate_deadline(candidate timestamptz)
returns void
language plpgsql
stable
set search_path = public, pg_temp
as $$
begin
  if validate_deadline.candidate is null
     or validate_deadline.candidate < now() + interval '9 minutes'
     or validate_deadline.candidate > now() + interval '7 days' + interval '10 minutes' then
    raise exception 'invalid_deadline';
  end if;
end;
$$;

-- A fresh lobby game row, now with its deadline (validated or chosen by the
-- caller). Same join-code draw as before: 8 symbols from a 32-symbol alphabet
-- (40 bits) taken from gen_random_uuid() (a CSPRNG; bytes 0-5 and 9-10 of a v4
-- UUID are fully random and 256 is a multiple of 32, so every symbol is
-- uniform), retried on the astronomically unlikely unique collision.
drop function private.insert_lobby_game(text, uuid, boolean);

create function private.insert_lobby_game(
  name text,
  host_user_id uuid,
  free_center boolean,
  deadline_at timestamptz
)
returns public.games
language plpgsql
volatile
set search_path = public, pg_temp
as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_bytes bytea;
  v_code text;
  v_attempt integer := 0;
  v_game public.games;
begin
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

    insert into public.games as g (join_code, name, host_user_id, free_center, deadline_at)
    values (
      v_code,
      insert_lobby_game.name,
      insert_lobby_game.host_user_id,
      coalesce(insert_lobby_game.free_center, true),
      insert_lobby_game.deadline_at
    )
    on conflict on constraint games_join_code_key do nothing
    returning g.* into v_game;

    exit when found;
    if v_attempt >= 10 then
      raise exception 'join_code_generation_failed';
    end if;
  end loop;

  return v_game;
end;
$$;

-- create_game ----------------------------------------------------------------------
-- Dropped and re-created (not overloaded): two create_game functions would make
-- PostgREST's named-argument resolution ambiguous.

drop function public.create_game(text, text, boolean, jsonb);

create function public.create_game(
  name text,
  host_name text,
  free_center boolean default true,
  squares jsonb default '[]'::jsonb,
  deadline_at timestamptz default null
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
  v_deadline timestamptz := create_game.deadline_at;
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

  -- No deadline given: 24 hours from now. Otherwise 10 minutes to 7 days ahead
  -- (with validate_deadline's slack).
  if v_deadline is null then
    v_deadline := now() + interval '24 hours';
  else
    perform private.validate_deadline(v_deadline);
  end if;

  v_game := private.insert_lobby_game(v_name, v_uid, coalesce(create_game.free_center, true), v_deadline);

  insert into public.players (game_id, user_id, display_name, color, is_ready)
  values (v_game.id, v_uid, v_host_name, 0, false);

  insert into public.squares (game_id, position, label, details, target_count)
  select v_game.id, gs.pos, v_labels[gs.pos + 1], v_details[gs.pos + 1], v_targets[gs.pos + 1]
  from generate_series(0, 24) as gs(pos);

  return v_game;
end;
$$;

comment on function public.create_game(text, text, boolean, jsonb, timestamptz) is
  'Creates a lobby game with 25 squares and a deadline (default now + 24 h); the caller becomes host and player color 0.';

-- set_deadline (host, lobby) ---------------------------------------------------------

create function public.set_deadline(game_id uuid, deadline_at timestamptz)
returns public.games
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_deadline timestamptz := set_deadline.deadline_at;
  v_player public.players;
  v_game public.games;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  select p.* into v_player
  from public.players p
  where p.game_id = set_deadline.game_id
    and p.user_id = v_uid;
  if not found then
    raise exception 'game_not_found';
  end if;

  -- Exclusive game lock: serializes against start_game.
  select g.* into v_game from public.games g where g.id = v_player.game_id for update;

  if v_game.host_user_id <> v_uid then
    raise exception 'not_host';
  end if;
  if v_game.status <> 'lobby' then
    raise exception 'game_not_in_lobby';
  end if;
  perform private.validate_deadline(v_deadline);

  update public.games g
  set deadline_at = v_deadline
  where g.id = v_game.id
  returning g.* into v_game;

  return v_game;
end;
$$;

comment on function public.set_deadline(uuid, timestamptz) is
  'Host only, lobby only: sets the game deadline (10 minutes to 7 days from now, with a little slack).';

-- extend_deadline (host, live, once) -------------------------------------------------

create function public.extend_deadline(game_id uuid, deadline_at timestamptz)
returns public.games
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_deadline timestamptz := extend_deadline.deadline_at;
  v_player public.players;
  v_game public.games;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  select p.* into v_player
  from public.players p
  where p.game_id = extend_deadline.game_id
    and p.user_id = v_uid;
  if not found then
    raise exception 'game_not_found';
  end if;

  -- Exclusive game lock: two extensions (or an extension and end_game / the
  -- cron) serialize here, so "once" holds under any race.
  select g.* into v_game from public.games g where g.id = v_player.game_id for update;

  if v_game.host_user_id <> v_uid then
    raise exception 'not_host';
  end if;
  -- Live only: a game already past its deadline is over and cannot be revived.
  if v_game.status <> 'active' or v_game.deadline_at <= now() then
    raise exception 'game_not_active';
  end if;
  if v_game.deadline_extended_at is not null then
    raise exception 'already_extended';
  end if;
  if v_deadline is null
     or v_deadline <= v_game.deadline_at
     or v_deadline > v_game.deadline_at + interval '1 day' then
    raise exception 'invalid_deadline';
  end if;

  update public.games g
  set deadline_at = v_deadline,
      deadline_extended_at = now()
  where g.id = v_game.id
  returning g.* into v_game;

  return v_game;
end;
$$;

comment on function public.extend_deadline(uuid, timestamptz) is
  'Host only, live games only, once per game: moves the deadline later by at most one day.';

-- start_game -----------------------------------------------------------------------

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

  update public.games g
  set status = 'active',
      started_at = now()
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

-- join_game ------------------------------------------------------------------------

create or replace function public.join_game(code text, display_name text)
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
     or (v_game.status = 'active' and v_game.deadline_at <= now())
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

-- peek_game ------------------------------------------------------------------------

create or replace function public.peek_game(code text)
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
        or (g.status = 'active' and g.deadline_at <= now())
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

-- peek_game_public -----------------------------------------------------------------

create or replace function public.peek_game_public(code text)
returns public.game_preview
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_code text;
  v_result public.game_preview;
begin
  -- No auth.uid() check: crawlers have no session. Same normalisation as
  -- peek_game / join_game; anything that cannot be a code is simply unknown.
  v_code := upper(regexp_replace(left(coalesce(peek_game_public.code, ''), 64), '[^A-Za-z0-9]', '', 'g'));
  if char_length(v_code) <> 8 then
    raise exception 'game_not_found';
  end if;

  select
    g.name,
    case
      when g.status = 'ended'
        or (g.status = 'active' and g.deadline_at <= now())
        then 'ended'::public.game_status
      else g.status
    end,
    (select count(*)::integer from public.players p where p.game_id = g.id),
    g.free_center
  into v_result
  from public.games g
  where g.join_code = v_code
    and g.expires_at > now();

  -- Unknown, or past expires_at (its album is gone; the cron deletes it soon).
  if not found then
    raise exception 'game_not_found';
  end if;

  return v_result;
end;
$$;

-- complete_square ------------------------------------------------------------------

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

  -- Share lock: serializes against end_game / auto-end / extend_deadline, not
  -- against other completions.
  select g.* into v_game from public.games g where g.id = v_player.game_id for share;

  if v_game.status <> 'active' or v_game.deadline_at <= now() then
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

-- increment_square -----------------------------------------------------------------

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

  -- Share lock: serializes against end_game / auto-end / extend_deadline, not
  -- against other taps.
  select g.* into v_game from public.games g where g.id = v_player.game_id for share;

  if v_game.status <> 'active' or v_game.deadline_at <= now() then
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

-- undo_completion ------------------------------------------------------------------

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

  select g.* into v_game from public.games g where g.id = v_player.game_id for share;

  if v_game.status <> 'active' or v_game.deadline_at <= now() then
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

-- end_game -------------------------------------------------------------------------

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

  -- A live game already past its deadline ended at the deadline.
  update public.games g
  set status = 'ended',
      ended_at = case
        when g.status = 'active' and g.deadline_at <= now() then g.deadline_at
        else now()
      end
  where g.id = v_game.id
  returning g.* into v_game;

  return v_game;
end;
$$;

-- auto_end_due_games (service role / cron only) ------------------------------------

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
      ended_at = g.deadline_at
  where g.status = 'active'
    and g.deadline_at <= now();

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- play_again -----------------------------------------------------------------------

create or replace function public.play_again(game_id uuid)
returns public.games
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_player public.players;
  v_old public.games;
  v_new public.games;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  select p.* into v_player
  from public.players p
  where p.game_id = play_again.game_id
    and p.user_id = v_uid;
  if not found then
    raise exception 'game_not_found';
  end if;

  -- Exclusive lock on the old game: two members tapping Play again at once
  -- serialize here, and the second one finds the first one's rematch.
  select g.* into v_old from public.games g where g.id = v_player.game_id for update;

  -- Effective status: ended, or active past its deadline (before the cron runs).
  if not (v_old.status = 'ended' or (v_old.status = 'active' and v_old.deadline_at <= now())) then
    raise exception 'game_not_ended';
  end if;

  -- Idempotent: one rematch per game. (If that game is gone, next_game_id was
  -- nulled by the foreign key and a new rematch replaces the stale code.)
  if v_old.next_game_id is not null then
    select g.* into v_new from public.games g where g.id = v_old.next_game_id;
    if found then
      return v_new;
    end if;
  end if;

  -- A new lobby exactly as create_game makes one without a deadline: fresh
  -- join code, expiry, deadline 24 hours from now (the host edits it in the
  -- lobby), no extension, the caller as host and player color 0 (not ready),
  -- 25 squares.
  v_new := private.insert_lobby_game(v_old.name, v_uid, v_old.free_center, now() + interval '24 hours');

  insert into public.players (game_id, user_id, display_name, color, is_ready)
  values (v_new.id, v_uid, v_player.display_name, 0, false);

  -- The board by position: content only (counts reset, nothing completed, no
  -- media). start_game labelled a blank free center 'FREE'; it goes back to
  -- blank, as in a fresh lobby, and the next start labels it again.
  insert into public.squares (game_id, position, label, details, target_count)
  select
    v_new.id,
    gs.pos,
    case
      when gs.pos = 12 and v_old.free_center and s.label = 'FREE' then ''
      else coalesce(s.label, '')
    end,
    coalesce(s.details, ''),
    coalesce(s.target_count, 1)
  from generate_series(0, 24) as gs(pos)
  left join public.squares s
    on s.game_id = v_old.id
   and s.position = gs.pos;

  update public.games g
  set next_game_id = v_new.id,
      next_join_code = v_new.join_code
  where g.id = v_old.id;

  return v_new;
end;
$$;

-- games.auto_end_at: nothing reads it any more ------------------------------------
-- (Its CHECK constraint and index were replaced above.)

alter table public.games drop column auto_end_at;

-- Function privileges ---------------------------------------------------------------
-- Reset to nothing, then allow exactly the intended roles (as for every RPC):
-- authenticated for the app RPCs, service_role for the cron's
-- auto_end_due_games, anon + authenticated for the public peek. Private
-- helpers: nobody (schema private is not reachable by any API role anyway).

revoke all on function private.validate_deadline(timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.insert_lobby_game(text, uuid, boolean, timestamptz) from public, anon, authenticated, service_role;

revoke all on function public.create_game(text, text, boolean, jsonb, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.set_deadline(uuid, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.extend_deadline(uuid, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.start_game(uuid) from public, anon, authenticated, service_role;
revoke all on function public.join_game(text, text) from public, anon, authenticated, service_role;
revoke all on function public.peek_game(text) from public, anon, authenticated, service_role;
revoke all on function public.peek_game_public(text) from public, anon, authenticated, service_role;
revoke all on function public.complete_square(uuid, integer) from public, anon, authenticated, service_role;
revoke all on function public.increment_square(uuid, integer, uuid) from public, anon, authenticated, service_role;
revoke all on function public.undo_completion(uuid, integer) from public, anon, authenticated, service_role;
revoke all on function public.end_game(uuid) from public, anon, authenticated, service_role;
revoke all on function public.auto_end_due_games() from public, anon, authenticated, service_role;
revoke all on function public.play_again(uuid) from public, anon, authenticated, service_role;

grant execute on function public.create_game(text, text, boolean, jsonb, timestamptz) to authenticated;
grant execute on function public.set_deadline(uuid, timestamptz) to authenticated;
grant execute on function public.extend_deadline(uuid, timestamptz) to authenticated;
grant execute on function public.start_game(uuid) to authenticated;
grant execute on function public.join_game(text, text) to authenticated;
grant execute on function public.peek_game(text) to authenticated;
grant execute on function public.peek_game_public(text) to anon, authenticated;
grant execute on function public.complete_square(uuid, integer) to authenticated;
grant execute on function public.increment_square(uuid, integer, uuid) to authenticated;
grant execute on function public.undo_completion(uuid, integer) to authenticated;
grant execute on function public.end_game(uuid) to authenticated;
grant execute on function public.auto_end_due_games() to service_role;
grant execute on function public.play_again(uuid) to authenticated;
