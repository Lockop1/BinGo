-- Live play: completions, counters, undo, game end.

select tests.run('g', 'complete_square (and increment/undo) fail with game_not_active in lobby and after end_game', $body$
declare
  f tests.fixture;
  v_game public.games;
begin
  f := tests.make_game(2, true, '[{"position": 4, "target_count": 3}]');

  perform tests.login(f.users[2]);
  perform tests.throws(format('select public.complete_square(%L, 0)', f.game_id), 'game_not_active', 'complete in lobby');
  perform tests.throws(format('select public.increment_square(%L, 4)', f.game_id), 'game_not_active', 'increment in lobby');
  perform tests.throws(format('select public.undo_completion(%L, 0)', f.game_id), 'game_not_active', 'undo in lobby');

  perform tests.start_game(f);
  perform tests.login(f.users[2]);
  perform tests.ok((public.complete_square(f.game_id, 0)).applied, 'complete while active');

  perform tests.login(f.users[1]);
  v_game := public.end_game(f.game_id);
  perform tests.is(v_game.status, 'ended'::public.game_status, 'ended');
  perform tests.ok(v_game.ended_at is not null, 'ended_at set');
  perform tests.is((public.end_game(f.game_id)).ended_at, v_game.ended_at, 'end_game is idempotent');

  perform tests.login(f.users[2]);
  perform tests.throws(format('select public.complete_square(%L, 1)', f.game_id), 'game_not_active', 'complete after end');
  perform tests.throws(format('select public.complete_square(%L, 0)', f.game_id), 'game_not_active', 'complete completed square after end');
  perform tests.throws(format('select public.increment_square(%L, 4)', f.game_id), 'game_not_active', 'increment after end');
  perform tests.throws(format('select public.undo_completion(%L, 0)', f.game_id), 'game_not_active', 'undo after end');

  perform tests.logout();
  perform tests.is(
    (select count(*) from public.squares where game_id = f.game_id and completed_at is not null),
    2::bigint, 'only center + square 0 completed');

  -- The host may also end a game straight from the lobby.
  f := tests.make_game(1);
  perform tests.login(f.users[1]);
  v_game := public.end_game(f.game_id);
  perform tests.is(v_game.status, 'ended'::public.game_status, 'ended from lobby');
  perform tests.throws(format('select public.complete_square(%L, 0)', f.game_id), 'game_not_active', 'complete in game ended from lobby');
end
$body$);

select tests.run('i', 'undo_completion: allowed for the completer and the host, not_allowed for another member and for the free center', $body$
declare
  f tests.fixture;
  r public.square_result;
begin
  f := tests.make_game(3, true, '[{"position": 5, "target_count": 2}]');
  perform tests.start_game(f);

  -- Completer undoes their own completion.
  perform tests.login(f.users[2]);
  perform public.complete_square(f.game_id, 0);
  r := public.undo_completion(f.game_id, 0);
  perform tests.is(r.applied, true, 'completer undo applied');
  perform tests.is(r.completed_at, null::timestamptz, 'completion cleared');
  perform tests.is(r.completed_by_player_id, null::uuid, 'completer cleared');
  perform tests.is(r.current_count, 0, 'count reset to 0 for target 1');

  -- Undoing again is a no-op that reports the current state.
  r := public.undo_completion(f.game_id, 0);
  perform tests.is(r.applied, false, 'second undo not applied');
  perform tests.is(r.position, 0::smallint, 'row returned');

  -- Host undoes another player's completion.
  perform public.complete_square(f.game_id, 1);
  perform tests.login(f.users[1]);
  r := public.undo_completion(f.game_id, 1);
  perform tests.is(r.applied, true, 'host undo applied');
  perform tests.is(r.completed_at, null::timestamptz, 'host undo cleared completion');

  -- Another (non-host) member cannot.
  perform tests.login(f.users[2]);
  perform public.complete_square(f.game_id, 2);
  perform tests.login(f.users[3]);
  perform tests.throws(format('select public.undo_completion(%L, 2)', f.game_id), 'not_allowed', 'other member undo');
  perform tests.logout();
  perform tests.is(
    (select completed_by_player_id from public.squares where game_id = f.game_id and position = 2),
    f.players[2], 'completion intact after refused undo');

  -- Nobody can undo the free center, not even the host.
  perform tests.login(f.users[1]);
  perform tests.throws(format('select public.undo_completion(%L, 12)', f.game_id), 'not_allowed', 'host undo free center');
  perform tests.login(f.users[2]);
  perform tests.throws(format('select public.undo_completion(%L, 12)', f.game_id), 'not_allowed', 'member undo free center');

  -- Undoing a completed counter square leaves it one short of the target.
  perform tests.login(f.users[3]);
  perform public.increment_square(f.game_id, 5);
  r := public.increment_square(f.game_id, 5);
  perform tests.ok(r.applied and r.completed_by_player_id = f.players[3], 'counter completed by player 3');
  r := public.undo_completion(f.game_id, 5);
  perform tests.is(r.current_count, 1, 'counter undo -> target - 1');
  perform tests.is(r.completed_at, null::timestamptz, 'counter undo cleared completion');

  perform tests.throws(format('select public.undo_completion(%L, 25)', f.game_id), 'invalid_position', 'bad position');
end
$body$);

select tests.run('j', 'counter square (target 3): two increments stay incomplete, the third completes it crediting the incrementer, a fourth returns applied=false', $body$
declare
  f tests.fixture;
  r public.square_result;
begin
  f := tests.make_game(3, true, '[{"position": 6, "label": "Get 3 signatures", "target_count": 3}]');
  perform tests.start_game(f);

  perform tests.login(f.users[2]);
  perform tests.throws(format('select public.complete_square(%L, 6)', f.game_id), 'is_counter', 'complete_square on a counter');
  perform tests.throws(format('select public.increment_square(%L, 0)', f.game_id), 'not_counter', 'increment on a target-1 square');

  r := public.increment_square(f.game_id, 6);
  perform tests.ok(r.applied and r.current_count = 1 and r.completed_at is null, '1/3 incomplete');
  perform tests.login(f.users[3]);
  r := public.increment_square(f.game_id, 6);
  perform tests.ok(r.applied and r.current_count = 2 and r.completed_at is null, '2/3 incomplete');
  perform tests.is(r.completed_by_player_id, null::uuid, 'no completer yet');

  perform tests.login(f.users[1]);
  r := public.increment_square(f.game_id, 6);
  perform tests.is(r.applied, true, 'third increment applied');
  perform tests.is(r.current_count, 3, '3/3');
  perform tests.ok(r.completed_at is not null, 'completed at target');
  perform tests.is(r.completed_by_player_id, f.players[1], 'credited to whoever hit the target');

  perform tests.login(f.users[2]);
  r := public.increment_square(f.game_id, 6);
  perform tests.is(r.applied, false, 'fourth increment not applied');
  perform tests.is(r.current_count, 3, 'count capped at target');
  perform tests.is(r.completed_by_player_id, f.players[1], 'credit unchanged');
  perform tests.is(r.label, 'Get 3 signatures', 'full row returned');
  perform tests.is((public.complete_square(f.game_id, 6)).applied, false, 'complete_square on completed counter: applied=false');
end
$body$);

select tests.run('k', 'complete_square twice: first applied=true, second applied=false with the first completer intact', $body$
declare
  f tests.fixture;
  r1 public.square_result;
  r2 public.square_result;
  r3 public.square_result;
begin
  f := tests.make_game(2);
  perform tests.start_game(f);

  perform tests.login(f.users[1]);
  r1 := public.complete_square(f.game_id, 7);
  perform tests.is(r1.applied, true, 'first applied');
  perform tests.is(r1.completed_by_player_id, f.players[1], 'first completer');
  perform tests.is(r1.current_count, 1, 'count = target');

  perform tests.login(f.users[2]);
  r2 := public.complete_square(f.game_id, 7);
  perform tests.is(r2.applied, false, 'second not applied');
  perform tests.is(r2.completed_by_player_id, f.players[1], 'first completer intact');
  perform tests.is(r2.completed_at, r1.completed_at, 'completed_at intact');
  perform tests.is(r2.id, r1.id, 'same square');

  -- Same caller retrying (e.g. after a lost response) is also a clean no-op.
  perform tests.login(f.users[1]);
  r3 := public.complete_square(f.game_id, 7);
  perform tests.is(r3.applied, false, 'retry not applied');
  perform tests.is(r3.completed_by_player_id, f.players[1], 'retry keeps completer');

  -- The free center reports applied=false as well.
  perform tests.is((public.complete_square(f.game_id, 12)).applied, false, 'free center already completed');
  perform tests.throws(format('select public.complete_square(%L, 25)', f.game_id), 'invalid_position', 'position 25');
  perform tests.throws(format('select public.complete_square(%L, null)', f.game_id), 'invalid_position', 'position null');
end
$body$);

select tests.run('p', 'an active game past auto_end_at is treated as ended before the cron runs', $body$
declare
  f tests.fixture;
  v_user uuid;
  v_game public.games;
begin
  f := tests.make_game(2, true, '[{"position": 4, "target_count": 2}]');
  perform tests.start_game(f);
  perform tests.login(f.users[2]);
  perform public.complete_square(f.game_id, 0);

  perform tests.logout();
  update public.games set auto_end_at = now() - interval '1 minute' where id = f.game_id;

  perform tests.login(f.users[2]);
  perform tests.throws(format('select public.complete_square(%L, 1)', f.game_id), 'game_not_active', 'complete when overdue');
  perform tests.throws(format('select public.increment_square(%L, 4)', f.game_id), 'game_not_active', 'increment when overdue');
  perform tests.throws(format('select public.undo_completion(%L, 0)', f.game_id), 'game_not_active', 'undo when overdue');
  perform tests.is(to_jsonb(public.peek_game(f.join_code)) ->> 'status', 'ended', 'peek reports ended');
  -- Media for the recap can still be added.
  perform tests.ok(
    (public.register_media(f.game_id, 0, f.game_id || '/0/late.jpg', 'photo')).id is not null,
    'media still registrable');

  perform tests.logout();
  v_user := tests.new_user();
  perform tests.login(v_user);
  perform tests.throws(format('select public.join_game(%L, ''Newbie'')', f.join_code), 'game_ended', 'join when overdue');

  perform tests.login(f.users[1]);
  v_game := public.end_game(f.game_id);
  perform tests.is(v_game.status, 'ended'::public.game_status, 'host can finalize');
  perform tests.is(v_game.ended_at, v_game.auto_end_at, 'ended_at = auto_end_at');
end
$body$);

select tests.run('q', 'increment_square with expected_count is a compare-and-set, so a retried increment never double counts', $body$
declare
  f tests.fixture;
  r public.square_result;
begin
  f := tests.make_game(2, true, '[{"position": 9, "target_count": 5}]');
  perform tests.start_game(f);
  perform tests.login(f.users[2]);

  r := public.increment_square(f.game_id, 9, 0);
  perform tests.ok(r.applied and r.current_count = 1, '0 -> 1');
  r := public.increment_square(f.game_id, 9, 0);
  perform tests.ok(not r.applied and r.current_count = 1, 'retry from 0 is a no-op returning 1');

  perform tests.login(f.users[1]);
  r := public.increment_square(f.game_id, 9, 1);
  perform tests.ok(r.applied and r.current_count = 2, 'host 1 -> 2');

  perform tests.login(f.users[2]);
  r := public.increment_square(f.game_id, 9, 1);
  perform tests.ok(not r.applied and r.current_count = 2, 'stale expected_count reports 2');
  r := public.increment_square(f.game_id, 9);
  perform tests.ok(r.applied and r.current_count = 3, 'plain increment still works');
end
$body$);
