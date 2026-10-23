-- =============================================================================
-- Core schema: games, players, squares, media.
--
-- Access model (see CLAUDE.md > Database API):
--   * RLS is enabled on every table in the same statement group that creates it.
--   * The `authenticated` role may only SELECT rows of games it is a player in.
--     There are no INSERT/UPDATE/DELETE policies: every write goes through the
--     security-definer RPCs in the next migration.
--   * Table privileges match the policies exactly: `anon` gets nothing,
--     `authenticated` gets SELECT only, `service_role` keeps the Supabase
--     defaults (the cleanup cron uses it).
-- =============================================================================

-- Enums ------------------------------------------------------------------------

create type public.game_status as enum ('lobby', 'active', 'ended');
create type public.media_kind as enum ('photo', 'video');

-- games ------------------------------------------------------------------------

create table public.games (
  id uuid primary key default gen_random_uuid(),
  -- 8 chars from an alphabet without the ambiguous 0/O/1/I. Always stored
  -- upper-case; RPCs upper-case the input, so lookups are case-insensitive.
  join_code text not null,
  name text not null,
  host_user_id uuid not null references auth.users (id) on delete cascade,
  status public.game_status not null default 'lobby',
  free_center boolean not null default true,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  ended_at timestamptz,
  -- Set by start_game to started_at + 24 hours.
  auto_end_at timestamptz,
  -- created_at + 30 days. now() is the transaction timestamp, so in the same
  -- INSERT this is exactly created_at + 30 days.
  expires_at timestamptz not null default (now() + interval '30 days'),
  constraint games_join_code_key unique (join_code),
  constraint games_join_code_format
    check (join_code ~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$'),
  constraint games_name_length check (char_length(name) between 1 and 60),
  constraint games_expires_after_created check (expires_at > created_at),
  constraint games_status_timestamps check (
    (status = 'lobby' and started_at is null and auto_end_at is null and ended_at is null)
    or (status = 'active' and started_at is not null and auto_end_at is not null and ended_at is null)
    or (status = 'ended' and ended_at is not null)
  )
);

alter table public.games enable row level security;

comment on table public.games is
  'One bingo game. Clients read it via RLS (members only); all writes go through RPCs.';

-- players ----------------------------------------------------------------------

create table public.players (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  display_name text not null,
  -- Index into the 10-colour palette. Unique per game, so at most 10 players
  -- can ever exist in one game (enforced structurally, not only in join_game).
  color smallint not null,
  is_ready boolean not null default false,
  joined_at timestamptz not null default now(),
  constraint players_game_id_user_id_key unique (game_id, user_id),
  constraint players_game_id_color_key unique (game_id, color),
  -- Target for the composite foreign keys below (same-game integrity).
  constraint players_game_id_id_key unique (game_id, id),
  constraint players_color_range check (color between 0 and 9),
  constraint players_display_name_length check (char_length(display_name) between 1 and 24)
);

alter table public.players enable row level security;

comment on table public.players is
  'Membership of a user in a game. A user can read a game only if they have a row here.';

-- squares ----------------------------------------------------------------------

create table public.squares (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games (id) on delete cascade,
  position smallint not null,
  label text not null default '',
  details text not null default '',
  target_count integer not null default 1,
  current_count integer not null default 0,
  -- null + completed_at set = the free center (completed by nobody).
  completed_by_player_id uuid,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint squares_game_id_position_key unique (game_id, position),
  constraint squares_game_id_id_key unique (game_id, id),
  constraint squares_position_range check (position between 0 and 24),
  constraint squares_label_length check (char_length(label) <= 40),
  constraint squares_details_length check (char_length(details) <= 200),
  constraint squares_target_count_range check (target_count between 1 and 99),
  constraint squares_current_count_range check (current_count between 0 and target_count),
  constraint squares_completion_consistent check (
    (completed_at is null and completed_by_player_id is null and current_count < target_count)
    or (completed_at is not null and current_count = target_count)
  ),
  -- The completer must be a player of the same game.
  constraint squares_completed_by_player_fkey foreign key (game_id, completed_by_player_id)
    references public.players (game_id, id) on delete set null (completed_by_player_id)
);

alter table public.squares enable row level security;

comment on table public.squares is
  'The 25 squares of a game board (position 0-24, row-major; 12 is the center).';

-- media ------------------------------------------------------------------------

create table public.media (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games (id) on delete cascade,
  square_id uuid not null,
  player_id uuid not null,
  storage_path text not null,
  kind public.media_kind not null,
  created_at timestamptz not null default now(),
  constraint media_storage_path_key unique (storage_path),
  -- Object name inside the game-media bucket: '<game_id>/<something>'.
  constraint media_storage_path_in_game_folder check (
    starts_with(storage_path, game_id::text || '/')
    and char_length(storage_path) > char_length(game_id::text) + 1
    and char_length(storage_path) <= 512
  ),
  constraint media_square_fkey foreign key (game_id, square_id)
    references public.squares (game_id, id) on delete cascade,
  constraint media_player_fkey foreign key (game_id, player_id)
    references public.players (game_id, id) on delete cascade
);

alter table public.media enable row level security;

comment on table public.media is
  'An uploaded photo/video in storage bucket game-media, attached to a completed square.';

-- Indexes ----------------------------------------------------------------------
-- games(join_code): served by the unique index games_join_code_key.
-- players(game_id): served by players_game_id_user_id_key (game_id is the
--   leading column; the same index also serves the membership check).
-- squares(game_id): served by squares_game_id_position_key (leading column).
-- media(game_id): served by media_game_id_square_id_idx (leading column).

create index games_host_user_id_idx on public.games (host_user_id);
create index games_expires_at_idx on public.games (expires_at);
create index games_auto_end_at_active_idx on public.games (auto_end_at) where status = 'active';
create index players_user_id_idx on public.players (user_id);
create index squares_game_id_completed_by_idx on public.squares (game_id, completed_by_player_id);
create index media_game_id_square_id_idx on public.media (game_id, square_id);
create index media_game_id_player_id_idx on public.media (game_id, player_id);

-- updated_at trigger on squares -------------------------------------------------
-- clock_timestamp(), not now(): a BEFORE ROW trigger runs after the row lock is
-- taken, so per square updated_at increases in commit order and clients can
-- use it to drop stale Realtime events. now() (transaction start) could go
-- backwards when two RPCs race on the same square.

create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

create trigger squares_set_updated_at
  before update on public.squares
  for each row execute function public.set_updated_at();

-- Membership helpers ------------------------------------------------------------
-- SECURITY DEFINER so they read players/games without RLS. This is what keeps
-- the players SELECT policy from recursing into itself. They only ever answer
-- questions about the calling user (auth.uid()).

create function public.is_game_member(game_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.players p
    where p.game_id = is_game_member.game_id
      and p.user_id = auth.uid()
  );
$$;

create function public.is_game_host(game_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.games g
    where g.id = is_game_host.game_id
      and g.host_user_id = auth.uid()
  );
$$;

-- Casts text to uuid, returning null instead of raising for non-uuid input.
-- Used by the storage policies on the first folder of an object name.
create function public.safe_uuid(value text)
returns uuid
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when safe_uuid.value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then safe_uuid.value::uuid
  end;
$$;

-- Function privileges: nothing for PUBLIC/anon; the predicates are called by
-- RLS policies as the invoking role, so authenticated may execute them.
revoke all on function public.set_updated_at() from public, anon, authenticated, service_role;
revoke all on function public.is_game_member(uuid) from public, anon, authenticated, service_role;
revoke all on function public.is_game_host(uuid) from public, anon, authenticated, service_role;
revoke all on function public.safe_uuid(text) from public, anon, authenticated, service_role;
grant execute on function public.is_game_member(uuid) to authenticated;
grant execute on function public.is_game_host(uuid) to authenticated;
grant execute on function public.safe_uuid(text) to authenticated;

-- RLS policies: members may read their games. Nothing else. -------------------

create policy games_select_members on public.games
  for select to authenticated
  using (public.is_game_member(id));

create policy players_select_members on public.players
  for select to authenticated
  using (public.is_game_member(game_id));

create policy squares_select_members on public.squares
  for select to authenticated
  using (public.is_game_member(game_id));

create policy media_select_members on public.media
  for select to authenticated
  using (public.is_game_member(game_id));

-- Table privileges, matching the policies exactly ------------------------------
-- service_role keeps the Supabase defaults (used by the cleanup cron).

revoke all on table public.games, public.players, public.squares, public.media
  from anon, authenticated;
grant select on table public.games, public.players, public.squares, public.media
  to authenticated;

-- Realtime ---------------------------------------------------------------------

alter table public.games replica identity full;
alter table public.players replica identity full;
alter table public.squares replica identity full;
alter table public.media replica identity full;

alter publication supabase_realtime
  add table public.games, public.players, public.squares, public.media;
