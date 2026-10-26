-- =============================================================================
-- Deadline caps in fixed-length hours, games.updated_at, and no rename of a
-- member after the deadline (Phase 11 verification P22, P23, P28).
--
--   * private.validate_deadline and extend_deadline compare against intervals
--     written in hours and minutes only: 9 minutes ... 168 hours + 10 minutes
--     ahead (the "10 minutes to 7 days" rule with its slack), and at most
--     24 hours past the current deadline for the single live extension.
--     Why: for timestamptz, `+ interval '1 day'` / `'7 days'` adds *calendar*
--     days in the session TimeZone, which any client can choose (PostgREST
--     honours `Prefer: timezone=...`). Across a DST change such a "day" is 23
--     or 25 hours, so a New York session could extend by 25 hours or pick a
--     deadline 7 days 1 hour away. Hour and minute fields are always exact
--     elapsed time, whatever the zone. Pinning `set timezone = 'UTC'` on the
--     functions was rejected: it protects only the functions that carry the
--     clause (the next one doing deadline maths could forget it), it changes
--     the zone for everything else the function does, and the rule the app
--     promises is elapsed time, which the hours form states in the code itself.
--   * games.updated_at: stamped with clock_timestamp() by a BEFORE UPDATE
--     trigger (the same public.set_updated_at() as squares). The trigger runs
--     after the row lock is taken, so per game it strictly increases in commit
--     order, and phones drop a games row older than the one they hold (a resync
--     that read the row before an extension committed can no longer undo it).
--     Every UPDATE stamps, even one that changes nothing. New rows get now()
--     (= created_at). Existing rows are backfilled with their last known change.
--   * join_game: an existing member of a game that is effectively ended
--     (ended, active past its deadline, or past its album expiry: the same
--     test that refuses newcomers with game_ended) gets their row back without
--     the display name being changed.
--
-- RLS, policies, table privileges, replica identity and the Realtime
-- publication are unchanged: the new column is read like the rest of the row
-- (members only; the games SELECT grant covers every column), Realtime carries
-- it with every games update (replica identity full), and only the trigger
-- writes it. Functions are re-created with `create or replace` and the same
-- signatures, so their grants are kept as they are.
-- =============================================================================

-- games.updated_at -----------------------------------------------------------------

alter table public.games
  add column updated_at timestamptz not null default now();

-- Before the trigger exists (it would overwrite these values with the clock).
update public.games g
set updated_at = coalesce(g.ended_at, g.started_at, g.created_at);

-- clock_timestamp(), not now(): see the squares trigger in the core schema.
create trigger games_set_updated_at
  before update on public.games
  for each row execute function public.set_updated_at();

comment on column public.games.updated_at is
  'When the row last changed: clock_timestamp() stamped by games_set_updated_at after the row lock, so it strictly increases per game. Clients drop a games row older than the one they hold.';

-- validate_deadline: 9 minutes to 168 hours + 10 minutes ahead ---------------------

-- A deadline the host may pick (create_game, set_deadline). The rule shown to
-- people is "10 minutes to 7 days from now"; the phone's picker can offer
-- exactly either bound, and its clock drifts and submits take time, so the
-- server accepts a little either side: from now + 9 minutes to now + 7 days
-- (168 hours, not a calendar week) + 10 minutes.
create or replace function private.validate_deadline(candidate timestamptz)
returns void
language plpgsql
stable
set search_path = public, pg_temp
as $$
begin
  if validate_deadline.candidate is null
     or validate_deadline.candidate < now() + interval '9 minutes'
     or validate_deadline.candidate > now() + interval '168 hours' + interval '10 minutes' then
    raise exception 'invalid_deadline';
  end if;
end;
$$;

-- extend_deadline (host, live, once): at most 24 hours later -------------------------

create or replace function public.extend_deadline(game_id uuid, deadline_at timestamptz)
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
  -- 24 elapsed hours, never a calendar day (23 or 25 hours across DST in the
  -- session time zone).
  if v_deadline is null
     or v_deadline <= v_game.deadline_at
     or v_deadline > v_game.deadline_at + interval '24 hours' then
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
  'Host only, live games only, once per game: moves the deadline later by at most 24 hours.';

-- join_game: no rename once the game is effectively ended ----------------------------

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
  v_ended boolean;
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

  -- Effectively ended: ended, live past its deadline (before the cron flips
  -- it), or past its album expiry (before the cron deletes it).
  v_ended := v_game.status = 'ended'
    or (v_game.status = 'active' and v_game.deadline_at <= now())
    or v_game.expires_at <= now();

  -- Already a member: idempotent. Refresh the display name unless ended.
  select p.* into v_player
  from public.players p
  where p.game_id = v_game.id
    and p.user_id = v_uid;

  if found then
    if not v_ended and v_player.display_name <> v_display_name then
      update public.players p
      set display_name = v_display_name
      where p.id = v_player.id
      returning p.* into v_player;
    end if;
    return v_player;
  end if;

  if v_ended then
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
