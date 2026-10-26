-- Host-set deadline: create_game / set_deadline validation, the single live
-- extension, start_game on a passed deadline, ending by the deadline (effective
-- status and the cron backstop), and the schema behind it.
-- now() is fixed for a whole test, so "now() + x" in a statement run inside the
-- test is exactly the same instant the RPC sees.

select tests.run('ac', 'create_game deadline: null -> now() + 24 h; a valid one is stored; 10 minutes to 7 days ahead (a little slack either side), anything else invalid_deadline (checked after the name and squares); expires_at stays created_at + 30 days', $body$
declare
  v_host uuid;
  v_game public.games;
  v_before bigint;
  v_cases text[];
begin
  v_host := tests.new_user();
  perform tests.login(v_host);

  -- Omitted, or an explicit null: 24 hours from now.
  v_game := public.create_game('Default deadline', 'Host');
  perform tests.is(v_game.deadline_at, now() + interval '24 hours', 'omitted -> now() + 24 h');
  perform tests.is(v_game.deadline_extended_at, null::timestamptz, 'not extended');
  v_game := public.create_game('Null deadline', 'Host', true, '[]'::jsonb, null);
  perform tests.is(v_game.deadline_at, now() + interval '24 hours', 'null -> now() + 24 h');

  -- A host-picked deadline (named argument, as PostgREST sends it) is stored as is.
  v_game := public.create_game('Picked', 'Host', deadline_at => now() + interval '5 hours 7 minutes');
  perform tests.is(v_game.deadline_at, now() + interval '5 hours 7 minutes', 'picked deadline stored');
  perform tests.is((select deadline_at from public.games where id = v_game.id), now() + interval '5 hours 7 minutes', 'row holds it');

  -- Inside the 10 minutes ... 7 days window (the picker's own bounds are inside
  -- the server's slack); the album expiry never depends on the deadline.
  v_game := public.create_game('Soon', 'Host', deadline_at => now() + interval '12 minutes');
  perform tests.is(v_game.deadline_at, now() + interval '12 minutes', '12 minutes ahead is allowed');
  v_game := public.create_game('Picker minimum', 'Host', deadline_at => now() + interval '10 minutes');
  perform tests.is(v_game.deadline_at, now() + interval '10 minutes', 'exactly 10 minutes (the picker minimum) is allowed');
  v_game := public.create_game('Far', 'Host', deadline_at => now() + interval '6 days');
  perform tests.is(v_game.deadline_at, now() + interval '6 days', '6 days ahead is allowed');
  v_game := public.create_game('Picker maximum', 'Host', deadline_at => now() + interval '7 days');
  perform tests.is(v_game.deadline_at, now() + interval '7 days', 'exactly 7 days (the picker maximum) is allowed');
  perform tests.is(v_game.expires_at, v_game.created_at + interval '30 days', 'expires_at = created_at + 30 days with a 7-day deadline');

  select count(*) into v_before from public.games;
  v_cases := array[
    $q$select public.create_game('Game', 'Host', deadline_at => now() + interval '5 minutes')$q$, 'invalid_deadline',
    $q$select public.create_game('Game', 'Host', deadline_at => now())$q$, 'invalid_deadline',
    $q$select public.create_game('Game', 'Host', deadline_at => now() - interval '1 hour')$q$, 'invalid_deadline',
    $q$select public.create_game('Game', 'Host', deadline_at => now() + interval '8 days')$q$, 'invalid_deadline',
    $q$select public.create_game('Game', 'Host', deadline_at => now() + interval '30 days')$q$, 'invalid_deadline',
    $q$select public.create_game('Game', 'Host', deadline_at => 'infinity'::timestamptz)$q$, 'invalid_deadline',
    $q$select public.create_game('Game', 'Host', deadline_at => '-infinity'::timestamptz)$q$, 'invalid_deadline',
    -- Earlier checks win over the deadline.
    $q$select public.create_game('', 'Host', deadline_at => now() + interval '8 days')$q$, 'invalid_name',
    $q$select public.create_game('Game', '', deadline_at => now() + interval '8 days')$q$, 'invalid_display_name',
    $q$select public.create_game('Game', 'Host', true, '[1]'::jsonb, now() + interval '8 days')$q$, 'invalid_squares',
    $q$select public.create_game('Game', 'Host', true, '[{"position": 2, "target_count": 0}]'::jsonb, now() + interval '8 days')$q$, 'invalid_target_count'
  ];
  for i in 1..array_length(v_cases, 1) / 2 loop
    perform tests.throws(v_cases[2 * i - 1], v_cases[2 * i], v_cases[2 * i - 1]);
  end loop;
  perform tests.is((select count(*) from public.games), v_before, 'no game created by a refused call');
end
$body$);

select tests.run('ad', 'set_deadline: host only (not_host first), lobby only (game_not_in_lobby), 10 minutes to 7 days with slack (invalid_deadline); any number of lobby edits; never touches the extension or the album expiry', $body$
declare
  f tests.fixture;
  v_game public.games;
  v_expires timestamptz;
begin
  f := tests.make_game(2);
  select expires_at into v_expires from public.games where id = f.game_id;

  -- A member who is not the host: refused, whatever the value.
  perform tests.login(f.users[2]);
  perform tests.throws(format('select public.set_deadline(%L, now() + interval ''2 hours'')', f.game_id), 'not_host', 'member sets deadline');
  perform tests.throws(format('select public.set_deadline(%L, null)', f.game_id), 'not_host', 'member, invalid value: not_host first');

  -- The host edits it as often as they like.
  perform tests.login(f.users[1]);
  v_game := public.set_deadline(f.game_id, now() + interval '2 hours');
  perform tests.is(v_game.deadline_at, now() + interval '2 hours', 'host sets 2 hours');
  v_game := public.set_deadline(f.game_id, now() + interval '3 days');
  perform tests.is(v_game.deadline_at, now() + interval '3 days', 'host changes it to 3 days');
  v_game := public.set_deadline(f.game_id, now() + interval '12 minutes');
  perform tests.is(v_game.deadline_at, now() + interval '12 minutes', '12 minutes allowed');
  v_game := public.set_deadline(f.game_id, now() + interval '6 days');
  perform tests.is(v_game.deadline_at, now() + interval '6 days', '6 days allowed');
  v_game := public.set_deadline(f.game_id, now() + interval '7 days');
  perform tests.is(v_game.deadline_at, now() + interval '7 days', 'exactly 7 days (the picker maximum) allowed');
  perform tests.is(v_game.status, 'lobby'::public.game_status, 'still a lobby');
  perform tests.is(v_game.deadline_extended_at, null::timestamptz, 'set_deadline is not an extension');
  perform tests.is(v_game.expires_at, v_expires, 'expires_at unchanged');

  -- Validation: nothing changes on a refusal.
  perform tests.throws(format('select public.set_deadline(%L, null)', f.game_id), 'invalid_deadline', 'null');
  perform tests.throws(format('select public.set_deadline(%L, now() + interval ''5 minutes'')', f.game_id), 'invalid_deadline', '5 minutes');
  perform tests.throws(format('select public.set_deadline(%L, now() - interval ''1 day'')', f.game_id), 'invalid_deadline', 'in the past');
  perform tests.throws(format('select public.set_deadline(%L, now() + interval ''8 days'')', f.game_id), 'invalid_deadline', '8 days');
  perform tests.logout();
  perform tests.is((select deadline_at from public.games where id = f.game_id), now() + interval '7 days', 'refusals left the deadline alone');

  -- Lobby only: after the start (host and member) and after the end.
  perform tests.start_game(f);
  perform tests.login(f.users[1]);
  perform tests.throws(format('select public.set_deadline(%L, now() + interval ''2 hours'')', f.game_id), 'game_not_in_lobby', 'host after start');
  perform tests.login(f.users[2]);
  perform tests.throws(format('select public.set_deadline(%L, now() + interval ''2 hours'')', f.game_id), 'not_host', 'member after start');
  perform tests.login(f.users[1]);
  perform public.end_game(f.game_id);
  perform tests.throws(format('select public.set_deadline(%L, now() + interval ''2 hours'')', f.game_id), 'game_not_in_lobby', 'host after end');
  perform tests.logout();
  perform tests.is((select deadline_at from public.games where id = f.game_id), now() + interval '7 days', 'deadline unchanged after start');
end
$body$);

select tests.run('ae', 'extend_deadline: host only, live games only (lobby, ended or past the deadline: game_not_active), later by at most one day (invalid_deadline), exactly once (already_extended); sets deadline_at and deadline_extended_at; the game stays live until the new deadline', $body$
declare
  f tests.fixture;
  g tests.fixture;
  v_game public.games;
  v_old timestamptz;
  v_expires timestamptz;
begin
  f := tests.make_game(2);

  -- Lobby: not live yet (the lobby uses set_deadline). Non-host: not_host first.
  perform tests.login(f.users[1]);
  perform tests.throws(format('select public.extend_deadline(%L, now() + interval ''25 hours'')', f.game_id), 'game_not_active', 'host in lobby');
  perform tests.login(f.users[2]);
  perform tests.throws(format('select public.extend_deadline(%L, now() + interval ''25 hours'')', f.game_id), 'not_host', 'member in lobby');

  perform tests.start_game(f);
  select deadline_at, expires_at into v_old, v_expires from public.games where id = f.game_id;
  perform tests.is(v_old, now() + interval '24 hours', 'default deadline');

  perform tests.login(f.users[2]);
  perform tests.throws(format('select public.extend_deadline(%L, now() + interval ''25 hours'')', f.game_id), 'not_host', 'member while live');

  -- Invalid values: not later, or more than a day later. Nothing is used up.
  perform tests.login(f.users[1]);
  perform tests.throws(format('select public.extend_deadline(%L, null)', f.game_id), 'invalid_deadline', 'null');
  perform tests.throws(format('select public.extend_deadline(%L, %L::timestamptz)', f.game_id, v_old), 'invalid_deadline', 'same deadline');
  perform tests.throws(format('select public.extend_deadline(%L, %L::timestamptz - interval ''1 minute'')', f.game_id, v_old), 'invalid_deadline', 'earlier');
  perform tests.throws(format('select public.extend_deadline(%L, %L::timestamptz + interval ''1 day 1 second'')', f.game_id, v_old), 'invalid_deadline', 'more than a day later');
  perform tests.logout();
  perform tests.is(
    (select format('%s|%s', deadline_at = v_old, deadline_extended_at) from public.games where id = f.game_id),
    't|', 'refusals changed nothing');

  -- Once: exactly one day later is the limit.
  perform tests.login(f.users[1]);
  v_game := public.extend_deadline(f.game_id, v_old + interval '1 day');
  perform tests.is(v_game.deadline_at, v_old + interval '1 day', 'deadline moved a day later');
  perform tests.is(v_game.deadline_extended_at, now(), 'deadline_extended_at = now()');
  perform tests.is(v_game.status, 'active'::public.game_status, 'still live');
  perform tests.is(v_game.expires_at, v_expires, 'expires_at unchanged (still from creation)');

  -- A second extension, valid or not, by the host: already_extended. A member: not_host.
  perform tests.throws(format('select public.extend_deadline(%L, %L::timestamptz + interval ''1 hour'')', f.game_id, v_game.deadline_at), 'already_extended', 'second extension');
  perform tests.throws(format('select public.extend_deadline(%L, null)', f.game_id), 'already_extended', 'second extension, invalid value');
  perform tests.login(f.users[2]);
  perform tests.throws(format('select public.extend_deadline(%L, null)', f.game_id), 'not_host', 'member after the extension');

  -- Live until the new deadline: completions work, the cron leaves it alone.
  perform tests.ok((public.complete_square(f.game_id, 3)).applied, 'complete after the extension');
  perform tests.login_service();
  perform tests.is(public.auto_end_due_games(), 0, 'cron: not due');

  -- Past the (extended) deadline: over, and an over game cannot be revived.
  perform tests.logout();
  perform tests.pass_deadline(f.game_id);
  perform tests.login(f.users[1]);
  perform tests.throws(format('select public.extend_deadline(%L, now() + interval ''1 hour'')', f.game_id), 'game_not_active', 'extended game past its deadline');
  perform tests.login(f.users[2]);
  perform tests.throws(format('select public.complete_square(%L, 4)', f.game_id), 'game_not_active', 'complete past the extended deadline');

  -- A never-extended game past its deadline: game_not_active, not a fresh extension.
  g := tests.make_game(1);
  perform tests.start_game(g);
  perform tests.logout();
  perform tests.pass_deadline(g.game_id);
  perform tests.login(g.users[1]);
  perform tests.throws(format('select public.extend_deadline(%L, now() + interval ''1 hour'')', g.game_id), 'game_not_active', 'past the deadline, never extended');
  perform tests.logout();
  perform tests.is((select deadline_extended_at from public.games where id = g.game_id), null::timestamptz, 'still not extended');

  -- Ended by the host: game_not_active.
  g := tests.make_game(1);
  perform tests.start_game(g);
  perform tests.login(g.users[1]);
  perform public.end_game(g.game_id);
  perform tests.throws(format('select public.extend_deadline(%L, now() + interval ''25 hours'')', g.game_id), 'game_not_active', 'ended game');
end
$body$);

select tests.run('af', 'start_game on a lobby whose deadline has passed: deadline_passed (after not_host / game_not_in_lobby, before players_not_ready); the host picks a new deadline with set_deadline and the start goes through', $body$
declare
  f tests.fixture;
  v_game public.games;
begin
  f := tests.make_game(2);
  perform tests.logout();
  perform tests.pass_deadline(f.game_id, interval '2 hours');

  -- Nobody ready yet: the passed deadline is reported first.
  perform tests.login(f.users[1]);
  perform tests.throws(format('select public.start_game(%L)', f.game_id), 'deadline_passed', 'deadline before readiness');
  perform tests.login(f.users[2]);
  perform tests.throws(format('select public.start_game(%L)', f.game_id), 'not_host', 'member: not_host first');

  -- Everyone ready: still refused.
  perform public.set_ready(f.game_id, true);
  perform tests.login(f.users[1]);
  perform public.set_ready(f.game_id, true);
  perform tests.throws(format('select public.start_game(%L)', f.game_id), 'deadline_passed', 'everyone ready, deadline passed');
  perform tests.logout();
  perform tests.is((select status from public.games where id = f.game_id), 'lobby'::public.game_status, 'still a lobby');

  -- A new deadline: the start works and keeps it.
  perform tests.login(f.users[1]);
  perform public.set_deadline(f.game_id, now() + interval '4 hours');
  v_game := public.start_game(f.game_id);
  perform tests.is(v_game.status, 'active'::public.game_status, 'started after set_deadline');
  perform tests.is(v_game.deadline_at, now() + interval '4 hours', 'with the new deadline');
  perform tests.throws(format('select public.start_game(%L)', f.game_id), 'game_not_in_lobby', 'start twice');

  -- Readiness is still enforced with a valid deadline.
  f := tests.make_game(2);
  perform tests.login(f.users[1]);
  perform public.set_ready(f.game_id, true);
  perform tests.throws(format('select public.start_game(%L)', f.game_id), 'players_not_ready', 'valid deadline, player 2 not ready');
end
$body$);

select tests.run('ag', 'past deadline_at, before the cron: every RPC treats the game as ended (complete/increment/undo game_not_active, newcomers game_ended, peeks say ended, set_deadline game_not_in_lobby, play_again allowed); the cron then ends it at the deadline; expires_at never moves', $body$
declare
  f tests.fixture;
  v_user uuid;
  v_deadline timestamptz;
  v_expires timestamptz;
  v_game public.games;
  v_member public.players;
begin
  f := tests.make_game(2, true, '[{"position": 4, "target_count": 2}]');
  select expires_at into v_expires from public.games where id = f.game_id;
  perform tests.start_game(f);
  perform tests.login(f.users[2]);
  perform public.complete_square(f.game_id, 0);
  perform tests.is(to_jsonb(public.peek_game(f.join_code)) ->> 'status', 'active', 'live before the deadline');

  perform tests.logout();
  v_deadline := tests.pass_deadline(f.game_id, interval '3 minutes');

  perform tests.login(f.users[2]);
  perform tests.throws(format('select public.complete_square(%L, 1)', f.game_id), 'game_not_active', 'complete');
  perform tests.throws(format('select public.increment_square(%L, 4, gen_random_uuid())', f.game_id), 'game_not_active', 'increment');
  perform tests.throws(format('select public.undo_completion(%L, 0)', f.game_id), 'game_not_active', 'undo');
  perform tests.is(to_jsonb(public.peek_game(f.join_code)) ->> 'status', 'ended', 'peek_game: ended');
  v_member := public.join_game(f.join_code, 'Player 2');
  perform tests.is(v_member.id, f.players[2], 'a member still gets their row back');
  perform tests.login_anon();
  perform tests.is(to_jsonb(public.peek_game_public(f.join_code)) ->> 'status', 'ended', 'peek_game_public: ended');
  perform tests.logout();
  v_user := tests.new_user();
  perform tests.login(v_user);
  perform tests.throws(format('select public.join_game(%L, ''Late'')', f.join_code), 'game_ended', 'newcomer');
  perform tests.login(f.users[1]);
  perform tests.throws(format('select public.set_deadline(%L, now() + interval ''1 hour'')', f.game_id), 'game_not_in_lobby', 'set_deadline');

  -- The cron backstop: ended at the deadline, not at the run.
  perform tests.login_service();
  perform tests.is(public.auto_end_due_games(), 1, 'cron ends it');
  perform tests.logout();
  select * into v_game from public.games where id = f.game_id;
  perform tests.is(v_game.status, 'ended'::public.game_status, 'status ended');
  perform tests.is(v_game.ended_at, v_deadline, 'ended_at = deadline_at');
  perform tests.is(v_game.deadline_at, v_deadline, 'deadline kept');
  perform tests.is(v_game.expires_at, v_expires, 'expires_at unchanged (30 days from creation)');

  -- Ended: the rematch is open to members.
  perform tests.login(f.users[2]);
  v_game := public.play_again(f.game_id);
  perform tests.is(v_game.status, 'lobby'::public.game_status, 'rematch lobby');
  perform tests.is(v_game.deadline_at, now() + interval '24 hours', 'rematch deadline 24 hours out');
end
$body$);

select tests.run('ah', 'deadline schema: exact games columns (the fixed 24 h end column is gone) and indexes; deadline_at not null and after created_at; deadline_extended_at only on started games; status/timestamp rule without the old end column; partial index on active deadlines', $body$
declare
  f tests.fixture;
begin
  perform tests.is(
    (select array_agg(column_name::text order by column_name) from information_schema.columns
     where table_schema = 'public' and table_name = 'games'),
    array['created_at', 'deadline_at', 'deadline_extended_at', 'ended_at', 'expires_at', 'free_center',
      'host_user_id', 'id', 'join_code', 'name', 'next_game_id', 'next_join_code', 'started_at', 'status'],
    'games columns: deadline_at / deadline_extended_at in, the old end column out');
  perform tests.is(
    (select is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'games' and column_name = 'deadline_at'),
    'NO', 'deadline_at not null');
  perform tests.is(
    (select is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'games' and column_name = 'deadline_extended_at'),
    'YES', 'deadline_extended_at nullable');
  perform tests.is(
    (select array_agg(indexname::text order by indexname) from pg_indexes where schemaname = 'public' and tablename = 'games'),
    array['games_deadline_at_active_idx', 'games_expires_at_idx', 'games_host_user_id_idx', 'games_join_code_key',
      'games_next_game_id_idx', 'games_pkey'],
    'games indexes: the old end-time index replaced by games_deadline_at_active_idx');
  perform tests.is(
    (select pg_get_expr(i.indpred, i.indrelid) from pg_index i where i.indexrelid = 'public.games_deadline_at_active_idx'::regclass),
    '(status = ''active''::game_status)', 'partial index on active games');
  perform tests.is(
    (select array_agg(a.attname::text) from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey)
     where i.indexrelid = 'public.games_deadline_at_active_idx'::regclass),
    array['deadline_at'], 'indexes deadline_at');

  -- Members read the new columns like the rest of the row.
  f := tests.make_game(2);
  perform tests.login(f.users[2]);
  perform tests.is(
    (select format('%s|%s', deadline_at = created_at + interval '24 hours', deadline_extended_at) from public.games where id = f.game_id),
    't|', 'member reads deadline_at / deadline_extended_at');

  -- Integrity as postgres (bypassing the RPCs).
  perform tests.logout();
  perform tests.throws(format('update public.games set deadline_at = null where id = %L', f.game_id), '23502', 'deadline_at null');
  perform tests.throws(format('update public.games set deadline_at = created_at where id = %L', f.game_id), '23514', 'deadline_at = created_at');
  perform tests.throws(format('update public.games set deadline_extended_at = now() where id = %L', f.game_id), '23514', 'extension on a lobby');
  perform tests.throws(format('update public.games set status = ''active'' where id = %L', f.game_id), '23514', 'active without started_at');
  perform tests.throws(format('update public.games set ended_at = now() where id = %L', f.game_id), '23514', 'lobby with ended_at');
  perform tests.start_game(f);
  perform tests.is((select status from public.games where id = f.game_id), 'active'::public.game_status, 'active without a fixed end column');
  perform tests.throws(format('update public.games set status = ''ended'' where id = %L', f.game_id), '23514', 'ended without ended_at');
end
$body$);
