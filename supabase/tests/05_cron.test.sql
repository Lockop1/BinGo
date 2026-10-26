-- Service-role maintenance used by the cleanup cron.

select tests.run('m', 'auto_end_due_games as service_role ends active games past deadline_at (ended_at = deadline_at) and leaves others alone', $body$
declare
  f_due tests.fixture;
  f_active tests.fixture;
  f_lobby tests.fixture;
  f_ended tests.fixture;
  v_ended_at timestamptz;
  v_game public.games;
begin
  f_due := tests.make_game(2);
  perform tests.start_game(f_due);
  f_active := tests.make_game(1);
  perform tests.start_game(f_active);
  f_lobby := tests.make_game(1);
  f_ended := tests.make_game(1);
  perform tests.start_game(f_ended);
  perform tests.login(f_ended.users[1]);
  perform public.end_game(f_ended.game_id);

  -- Time travel as postgres.
  perform tests.logout();
  perform tests.pass_deadline(f_due.game_id, interval '5 minutes');
  perform tests.pass_deadline(f_ended.game_id, interval '1 hour');
  perform tests.pass_deadline(f_lobby.game_id, interval '1 hour');
  select ended_at into v_ended_at from public.games where id = f_ended.game_id;

  -- Clients cannot run it.
  perform tests.login(f_due.users[1]);
  perform tests.denied('select public.auto_end_due_games()', 'authenticated cannot auto-end');

  perform tests.login_service();
  perform tests.is(public.auto_end_due_games(), 1, 'exactly one game auto-ended');
  perform tests.is(public.auto_end_due_games(), 0, 'second run is a no-op');

  perform tests.logout();
  select * into v_game from public.games where id = f_due.game_id;
  perform tests.is(v_game.status, 'ended'::public.game_status, 'due game ended');
  perform tests.is(v_game.ended_at, v_game.deadline_at, 'ended_at = deadline_at');
  perform tests.is(v_game.ended_at, now() - interval '5 minutes', 'ended at the deadline, not at the cron run');
  perform tests.is((select status from public.games where id = f_active.game_id), 'active'::public.game_status, 'future game still active');
  perform tests.is((select status from public.games where id = f_lobby.game_id), 'lobby'::public.game_status, 'lobby past its deadline untouched (start_game refuses it)');
  perform tests.is((select ended_at from public.games where id = f_ended.game_id), v_ended_at, 'ended game untouched');

  -- The cron's other job: service_role can delete expired games (cascade).
  perform tests.login_service();
  delete from public.games where id = f_lobby.game_id;
  perform tests.logout();
  perform tests.is((select count(*) from public.players where game_id = f_lobby.game_id), 0::bigint, 'players cascaded');
  perform tests.is((select count(*) from public.squares where game_id = f_lobby.game_id), 0::bigint, 'squares cascaded');
end
$body$);
