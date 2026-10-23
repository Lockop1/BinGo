-- =============================================================================
-- TEST-ONLY helpers for the SQL suite. scripts/db-test.sh applies this to the
-- throwaway `bingo_test` database after the shim and all migrations. It is NOT
-- a migration and must never be applied to a real Supabase project.
--
-- Each test is   select tests.run('<id>', '<description>', $body$ <plpgsql block> $body$);
-- The block runs as a DO statement inside a subtransaction that is always
-- rolled back, so tests are isolated from each other. tests.run returns one
-- 'PASS (<id>) ...' or 'FAIL (<id>) ...: <error>' line.
--
-- Simulating users (all transaction-local, undone by the rollback):
--   tests.login(uid)   -> request.jwt.claims {"sub": uid, "role": "authenticated"}
--                         + SET LOCAL ROLE authenticated
--   tests.login_anon() / tests.login_service() / tests.logout() (back to postgres)
-- =============================================================================

drop schema if exists tests cascade;
create schema tests;
grant usage on schema tests to anon, authenticated, service_role;

-- Users and roles -------------------------------------------------------------

-- Inserts a stub anonymous user into auth.users. Call as postgres (logout first).
create function tests.new_user() returns uuid
language sql as $$
  insert into auth.users (id, aud, role, is_anonymous)
  values (gen_random_uuid(), 'authenticated', 'authenticated', true)
  returning id;
$$;

create function tests.logout() returns void
language plpgsql as $$
begin
  set local role none;
  perform set_config('request.jwt.claims', '', true);
end;
$$;

create function tests.login(uid uuid) returns void
language plpgsql as $$
begin
  set local role none;
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', uid, 'role', 'authenticated')::text,
    true
  );
  set local role authenticated;
end;
$$;

-- Authenticated role but no JWT subject (exercises 'not_authenticated').
create function tests.login_without_sub() returns void
language plpgsql as $$
begin
  set local role none;
  perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  set local role authenticated;
end;
$$;

create function tests.login_anon() returns void
language plpgsql as $$
begin
  set local role none;
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;
end;
$$;

create function tests.login_service() returns void
language plpgsql as $$
begin
  set local role none;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  set local role service_role;
end;
$$;

-- Assertions ------------------------------------------------------------------

create function tests.ok(cond boolean, description text) returns void
language plpgsql as $$
begin
  if cond is not true then
    raise exception 'assertion failed: %', description;
  end if;
end;
$$;

create function tests.is(actual anyelement, expected anyelement, description text) returns void
language plpgsql as $$
begin
  if actual is distinct from expected then
    raise exception 'assertion failed: % (expected %, got %)', description, expected, actual;
  end if;
end;
$$;

-- Runs `stmt` and asserts it raises. `expected` matches the error message
-- exactly (e.g. 'game_not_found'), or the SQLSTATE (e.g. '22P02'), or, when it
-- contains '%', the message as a LIKE pattern. Note RLS rejections and missing
-- privileges both use SQLSTATE 42501, so privilege tests match the message:
-- tests.denied() for 'permission denied ...', tests.rls_denied() for RLS.
create function tests.throws(stmt text, expected text, description text default null) returns void
language plpgsql as $$
declare
  v_msg text;
  v_state text;
begin
  begin
    execute stmt;
  exception when others then
    get stacked diagnostics v_msg = message_text, v_state = returned_sqlstate;
    if v_msg = expected or v_state = expected
       or (strpos(expected, '%') > 0 and v_msg like expected) then
      return;
    end if;
    raise exception 'assertion failed: % -- expected error "%", got "%" (SQLSTATE %)',
      coalesce(description, stmt), expected, v_msg, v_state;
  end;
  raise exception 'assertion failed: % -- expected error "%", but it succeeded',
    coalesce(description, stmt), expected;
end;
$$;

-- Missing privilege (GRANT), as opposed to an RLS policy rejection.
create function tests.denied(stmt text, description text default null) returns void
language sql as $$
  select tests.throws(stmt, 'permission denied for %', description);
$$;

-- Row rejected by an RLS WITH CHECK / policy (the privilege itself exists).
create function tests.rls_denied(stmt text, description text default null) returns void
language sql as $$
  select tests.throws(stmt, 'new row violates row-level security policy%', description);
$$;

-- Runner ----------------------------------------------------------------------

create function tests.run(test_id text, description text, body text) returns text
language plpgsql as $$
declare
  v_passed boolean := false;
  v_msg text;
  v_ctx text;
begin
  begin
    execute format('do %L', body);
    v_passed := true;
    -- Always roll the test back (data, role and settings).
    raise exception 'test rollback' using errcode = 'TRBCK';
  exception
    when sqlstate 'TRBCK' then
      null;
    when others then
      get stacked diagnostics v_msg = message_text, v_ctx = pg_exception_context;
  end;

  if v_passed then
    return format('PASS (%s) %s', test_id, description);
  end if;
  -- Point at the failing line of the test body.
  return format('FAIL (%s) %s :: %s [%s]', test_id, description, v_msg,
    coalesce(substring(v_ctx from 'inline_code_block line [0-9]+'), split_part(coalesce(v_ctx, ''), E'\n', 1)));
end;
$$;

-- Fixtures --------------------------------------------------------------------

-- users[1] is the host; players[i] is users[i]'s players.id.
create type tests.fixture as (
  game_id uuid,
  join_code text,
  users uuid[],
  players uuid[]
);

-- Creates a lobby game via the RPCs: a new host user plus (player_count - 1)
-- new users who join it. Leaves the session as postgres.
create function tests.make_game(
  player_count integer default 1,
  free_center boolean default true,
  squares jsonb default '[]'::jsonb
) returns tests.fixture
language plpgsql as $$
declare
  f tests.fixture;
  v_uid uuid;
  v_game public.games;
  v_player public.players;
begin
  f.users := array[]::uuid[];
  f.players := array[]::uuid[];
  for i in 1..player_count loop
    perform tests.logout();
    v_uid := tests.new_user();
    perform tests.login(v_uid);
    if i = 1 then
      v_game := public.create_game('Test game', 'Player 1', make_game.free_center, make_game.squares);
      f.game_id := v_game.id;
      f.join_code := v_game.join_code;
      select p.* into v_player
      from public.players p
      where p.game_id = v_game.id and p.user_id = v_uid;
    else
      v_player := public.join_game(f.join_code, 'Player ' || i);
    end if;
    f.users := f.users || v_uid;
    f.players := f.players || v_player.id;
  end loop;
  perform tests.logout();
  return f;
end;
$$;

-- Readies every player and starts the game as the host. Leaves session as postgres.
create function tests.start_game(f tests.fixture) returns void
language plpgsql as $$
begin
  for i in 1..coalesce(array_length(f.users, 1), 0) loop
    perform tests.login(f.users[i]);
    perform public.set_ready(f.game_id, true);
  end loop;
  perform tests.login(f.users[1]);
  perform public.start_game(f.game_id);
  perform tests.logout();
end;
$$;
