-- =============================================================================
-- Play again (rematch) and a public game preview for link previews.
--
--   * games.next_game_id / games.next_join_code: set once by play_again on an
--     ended game. Members of the old game read them like any other column of
--     their game (RLS, Realtime, resync), so every phone on the recap can offer
--     "join the new game" under the player's existing name.
--   * play_again(game_id): a member of an (effectively) ended game starts a new
--     lobby with the same name, free_center and board (labels, details,
--     targets; counts, completions and media are not carried over). The caller
--     hosts it. Idempotent per old game: once a rematch exists every later
--     call, by anyone in the old game, returns that same new game.
--   * peek_game_public(code): the join-screen preview (name, effective status,
--     player count, free_center) WITHOUT a session. Link previews (Open Graph
--     images, chat-app crawlers) fetch a game's name with no user at all. This
--     is deliberately the only function `anon` may execute: the code is
--     unguessable (40 random bits) and anyone holding the link already sees
--     the same data on the join screen; expired games answer game_not_found.
--
-- Conventions as in the game RPC migration: SECURITY DEFINER, search_path
-- pinned, every object schema-qualified, errors raised as stable snake_case
-- messages (SQLSTATE P0001), non-members get game_not_found.
-- =============================================================================

-- games: the rematch pointer ------------------------------------------------------

alter table public.games
  add column next_game_id uuid references public.games (id) on delete set null,
  add column next_join_code text;

alter table public.games
  add constraint games_next_join_code_format
    check (next_join_code is null or next_join_code ~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$'),
  add constraint games_next_game_not_self
    check (next_game_id is null or next_game_id <> id);

comment on column public.games.next_game_id is
  'The rematch started from this (ended) game by play_again; null until then.';
comment on column public.games.next_join_code is
  'join_code of next_game_id, so members of this game can join the rematch without reading it.';

-- Serves the ON DELETE SET NULL lookup when the cleanup cron deletes a game
-- (otherwise a scan of games per deleted row). Most games never get one.
create index games_next_game_id_idx on public.games (next_game_id) where next_game_id is not null;

-- RLS, policies, table privileges and the Realtime publication are unchanged:
-- the new columns are read exactly like the rest of the row (members only),
-- and only play_again (SECURITY DEFINER) writes them.

-- Internal helper: a fresh lobby game row -----------------------------------------
-- The same join-code draw as create_game: 8 symbols from a 32-symbol alphabet
-- (40 bits) taken from gen_random_uuid() (a CSPRNG; bytes 0-5 and 9-10 of a v4
-- UUID are fully random and 256 is a multiple of 32, so every symbol is
-- uniform), retried on the astronomically unlikely unique collision.
-- Inputs are trusted (the caller validated or copied them from a valid row).

create function private.insert_lobby_game(name text, host_user_id uuid, free_center boolean)
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

    insert into public.games as g (join_code, name, host_user_id, free_center)
    values (v_code, insert_lobby_game.name, insert_lobby_game.host_user_id, coalesce(insert_lobby_game.free_center, true))
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

-- peek_game_public ----------------------------------------------------------------

create function public.peek_game_public(code text)
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
        or (g.status = 'active' and g.auto_end_at <= now())
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

comment on function public.peek_game_public(text) is
  'Link-preview peek by join code, no session needed: name, effective status, player count, free_center. game_not_found for unknown or expired games.';

-- play_again ----------------------------------------------------------------------

create function public.play_again(game_id uuid)
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

  -- Effective status: ended, or active past auto_end_at (before the cron runs).
  if not (v_old.status = 'ended' or (v_old.status = 'active' and v_old.auto_end_at <= now())) then
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

  -- A new lobby exactly as create_game makes one: fresh join code, expiry,
  -- the caller as host and player color 0 (not ready), 25 squares.
  v_new := private.insert_lobby_game(v_old.name, v_uid, v_old.free_center);

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

comment on function public.play_again(uuid) is
  'A member of an ended game starts (or gets) its rematch: a new lobby with the same name, free_center and board, hosted by the first caller.';

-- Function privileges ---------------------------------------------------------------
-- Reset to nothing, then allow exactly the intended roles. peek_game_public is
-- the single function anon may execute (see the header).

revoke all on function private.insert_lobby_game(text, uuid, boolean) from public, anon, authenticated, service_role;
revoke all on function public.peek_game_public(text) from public, anon, authenticated, service_role;
revoke all on function public.play_again(uuid) from public, anon, authenticated, service_role;

grant execute on function public.peek_game_public(text) to anon, authenticated;
grant execute on function public.play_again(uuid) to authenticated;
