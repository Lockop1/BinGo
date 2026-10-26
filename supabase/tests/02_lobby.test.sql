-- Lobby rules: host-only actions, readiness, square editing, joining, creation.

select tests.run('d', 'non-host member cannot start_game, end_game or set_free_center (not_host)', $body$
declare
  f tests.fixture;
  v_game public.games;
begin
  f := tests.make_game(3);
  perform tests.login(f.users[2]);
  perform public.set_ready(f.game_id, true);
  perform tests.login(f.users[3]);
  perform public.set_ready(f.game_id, true);

  perform tests.login(f.users[2]);
  perform tests.throws(format('select public.start_game(%L)', f.game_id), 'not_host', 'start in lobby');
  perform tests.throws(format('select public.end_game(%L)', f.game_id), 'not_host', 'end in lobby');
  perform tests.throws(format('select public.set_free_center(%L, false)', f.game_id), 'not_host', 'free center');

  -- The host can toggle the free center in the lobby.
  perform tests.login(f.users[1]);
  v_game := public.set_free_center(f.game_id, false);
  perform tests.is(v_game.free_center, false, 'host turned free center off');
  perform tests.throws(format('select public.set_free_center(%L, null)', f.game_id), 'invalid_argument', 'null enabled');
  perform public.set_ready(f.game_id, true);
  perform public.start_game(f.game_id);

  perform tests.login(f.users[3]);
  perform tests.throws(format('select public.end_game(%L)', f.game_id), 'not_host', 'end while active');
  perform tests.throws(format('select public.set_free_center(%L, true)', f.game_id), 'not_host', 'free center while active');

  perform tests.logout();
  select * into v_game from public.games where id = f.game_id;
  perform tests.is(v_game.status, 'active'::public.game_status, 'game still active');
  perform tests.is(v_game.free_center, false, 'free center unchanged');

  -- Host: free center is lobby-only.
  perform tests.login(f.users[1]);
  perform tests.throws(format('select public.set_free_center(%L, true)', f.game_id), 'game_not_in_lobby', 'host toggles after start');
end
$body$);

select tests.run('e', 'start_game fails until every player (host included) is ready, then sets active/started_at (the deadline stays as set) and completes the free center', $body$
declare
  f tests.fixture;
  f2 tests.fixture;
  f3 tests.fixture;
  v_game public.games;
  v_sq public.squares;
begin
  f := tests.make_game(3);

  perform tests.login(f.users[1]);
  perform tests.throws(format('select public.start_game(%L)', f.game_id), 'players_not_ready', 'nobody ready');
  perform public.set_ready(f.game_id, true);
  perform tests.throws(format('select public.start_game(%L)', f.game_id), 'players_not_ready', 'only host ready');

  perform tests.login(f.users[2]);
  perform public.set_ready(f.game_id, true);
  perform tests.login(f.users[3]);
  perform public.set_ready(f.game_id, true);
  perform public.set_ready(f.game_id, false);
  perform tests.throws(format('select public.set_ready(%L, null)', f.game_id), 'invalid_argument', 'null ready');

  perform tests.login(f.users[1]);
  perform public.set_ready(f.game_id, false);
  perform tests.throws(format('select public.start_game(%L)', f.game_id), 'players_not_ready', 'host and player 3 not ready');
  perform public.set_ready(f.game_id, true);
  perform tests.throws(format('select public.start_game(%L)', f.game_id), 'players_not_ready', 'player 3 un-readied');

  perform tests.login(f.users[3]);
  perform public.set_ready(f.game_id, true);

  perform tests.login(f.users[1]);
  v_game := public.set_deadline(f.game_id, now() + interval '5 hours');
  v_game := public.start_game(f.game_id);
  perform tests.is(v_game.status, 'active'::public.game_status, 'status active');
  perform tests.ok(v_game.started_at is not null, 'started_at set');
  perform tests.is(v_game.deadline_at, now() + interval '5 hours', 'start keeps the host''s deadline');
  perform tests.is(v_game.deadline_extended_at, null::timestamptz, 'not extended');
  perform tests.is(v_game.ended_at, null::timestamptz, 'ended_at null');

  select * into v_sq from public.squares where game_id = f.game_id and position = 12;
  perform tests.ok(v_sq.completed_at is not null, 'free center completed');
  perform tests.is(v_sq.completed_by_player_id, null::uuid, 'free center completed by nobody');
  perform tests.is(v_sq.current_count, v_sq.target_count, 'free center count = target');
  perform tests.is(v_sq.label, 'FREE', 'blank free center labelled FREE');
  perform tests.is(
    (select count(*) from public.squares where game_id = f.game_id and completed_at is not null),
    1::bigint, 'only the center is completed');

  perform tests.throws(format('select public.start_game(%L)', f.game_id), 'game_not_in_lobby', 'start twice');
  perform tests.throws(format('select public.set_ready(%L, false)', f.game_id), 'game_not_in_lobby', 'ready after start');

  -- A labelled center keeps its label; free_center = false leaves it open.
  f2 := tests.make_game(1, true, '[{"position": 12, "label": "Hug a stranger"}]');
  perform tests.start_game(f2);
  select * into v_sq from public.squares where game_id = f2.game_id and position = 12;
  perform tests.is(v_sq.label, 'Hug a stranger', 'labelled center keeps label');
  perform tests.ok(v_sq.completed_at is not null, 'labelled free center completed');

  f3 := tests.make_game(1, false);
  perform tests.start_game(f3);
  select * into v_sq from public.squares where game_id = f3.game_id and position = 12;
  perform tests.is(v_sq.completed_at, null::timestamptz, 'no free center when disabled');
  perform tests.is(v_sq.label, '', 'center label untouched when disabled');
end
$body$);

select tests.run('f', 'update_square works in lobby for any player (trim, validation, last write wins) and fails after start', $body$
declare
  f tests.fixture;
  v_sq public.squares;
  v_before timestamptz;
begin
  f := tests.make_game(2);

  perform tests.login(f.users[2]);
  v_sq := public.update_square(f.game_id, 7, '   Sing   a   song  ', E'  On a\nstage  ', 1);
  perform tests.is(v_sq.label, 'Sing a song', 'label trimmed and collapsed');
  perform tests.is(v_sq.details, E'On a\nstage', 'details trimmed');
  perform tests.is(v_sq.position, 7::smallint, 'position');

  -- Last write wins (host overwrites the player's edit).
  perform tests.login(f.users[1]);
  v_sq := public.update_square(f.game_id, 7, 'Collect signatures', null, 15);
  perform tests.is(v_sq.label, 'Collect signatures', 'second write wins');
  perform tests.is(v_sq.details, '', 'null details -> empty');
  perform tests.is(v_sq.target_count, 15, 'target count');
  perform tests.is(v_sq.current_count, 0, 'current count stays 0');
  v_sq := public.update_square(f.game_id, 7, null, null, null);
  perform tests.is(v_sq.label, '', 'null label -> empty');
  perform tests.is(v_sq.target_count, 1, 'null target -> 1');

  v_sq := public.update_square(f.game_id, 8, repeat('x', 40), repeat('y', 200), 99);
  perform tests.is(char_length(v_sq.label) + char_length(v_sq.details) + v_sq.target_count, 40 + 200 + 99, 'max lengths ok');
  perform tests.throws(format('select public.update_square(%L, 8, %L, '''', 1)', f.game_id, repeat('x', 41)), 'label_too_long', '41-char label');
  perform tests.throws(format('select public.update_square(%L, 8, ''ok'', %L, 1)', f.game_id, repeat('y', 201)), 'details_too_long', '201-char details');
  perform tests.throws(format('select public.update_square(%L, 8, ''ok'', '''', 0)', f.game_id), 'invalid_target_count', 'target 0');
  perform tests.throws(format('select public.update_square(%L, 8, ''ok'', '''', 100)', f.game_id), 'invalid_target_count', 'target 100');
  perform tests.throws(format('select public.update_square(%L, 25, ''ok'', '''', 1)', f.game_id), 'invalid_position', 'position 25');
  perform tests.throws(format('select public.update_square(%L, -1, ''ok'', '''', 1)', f.game_id), 'invalid_position', 'position -1');
  perform tests.throws(format('select public.update_square(%L, null, ''ok'', '''', 1)', f.game_id), 'invalid_position', 'position null');

  -- updated_at trigger: every UPDATE stamps clock_timestamp(), even one that
  -- tries to write an old value, and successive updates strictly increase it.
  perform tests.logout();
  update public.squares set updated_at = '2000-01-01' where game_id = f.game_id and position = 9
  returning updated_at into v_before;
  perform tests.ok(v_before >= now(), 'trigger overrides explicit updated_at');
  perform tests.login(f.users[2]);
  v_sq := public.update_square(f.game_id, 9, 'Dance', '', 1);
  perform tests.ok(v_sq.updated_at > v_before, 'update_square bumps updated_at');

  perform tests.start_game(f);
  perform tests.login(f.users[2]);
  perform tests.throws(format('select public.update_square(%L, 7, ''Late edit'', '''', 1)', f.game_id), 'game_not_in_lobby', 'player edit after start');
  perform tests.login(f.users[1]);
  perform tests.throws(format('select public.update_square(%L, 7, ''Late edit'', '''', 1)', f.game_id), 'game_not_in_lobby', 'host edit after start');
  perform public.end_game(f.game_id);
  perform tests.throws(format('select public.update_square(%L, 7, ''Late edit'', '''', 1)', f.game_id), 'game_not_in_lobby', 'edit after end');

  perform tests.logout();
  perform tests.is((select label from public.squares where game_id = f.game_id and position = 7), '', 'square unchanged after start');
end
$body$);

select tests.run('h', 'join_game: 10 players get distinct colors, 11th gets game_full; ended games rejected; idempotent for members; late joiners allowed', $body$
declare
  f tests.fixture;
  g tests.fixture;
  v_user uuid;
  v_dash uuid;
  v_dash_player public.players;
  v_player public.players;
  v_again public.players;
begin
  f := tests.make_game(10);
  perform tests.is(
    (select array_agg(color order by color) from public.players where game_id = f.game_id),
    array[0, 1, 2, 3, 4, 5, 6, 7, 8, 9]::smallint[], '10 distinct colors 0-9');
  perform tests.is(
    (select array_agg(color order by joined_at, color) from public.players where game_id = f.game_id),
    array[0, 1, 2, 3, 4, 5, 6, 7, 8, 9]::smallint[], 'lowest free color assigned in join order');

  v_user := tests.new_user();
  perform tests.login(v_user);
  perform tests.throws(format('select public.join_game(%L, ''Eleven'')', f.join_code), 'game_full', '11th player');
  perform tests.is(to_jsonb(public.peek_game(f.join_code)) ->> 'player_count', '10', 'peek shows full game');

  -- Idempotent for an existing member, even when full; refreshes the name.
  perform tests.login(f.users[4]);
  v_player := public.join_game(f.join_code, 'Player 4');
  v_again := public.join_game(lower(f.join_code), '  Renamed  Four ');
  perform tests.is(v_again.id, v_player.id, 'same player row');
  perform tests.is(v_again.color, v_player.color, 'same color');
  perform tests.is(v_again.display_name, 'Renamed Four', 'display name refreshed');
  perform tests.is((select count(*) from public.players where game_id = f.game_id), 10::bigint, 'still 10 players');

  -- Code input is case-insensitive and ignores separators.
  g := tests.make_game(1);
  perform tests.logout();
  v_dash := tests.new_user();
  perform tests.login(v_dash);
  v_dash_player := public.join_game(lower(substr(g.join_code, 1, 4)) || '-' || substr(g.join_code, 5), 'Dash');
  perform tests.is(v_dash_player.color, 1::smallint, 'joined via lower-case dashed code');
  perform public.set_ready(g.game_id, true);
  perform tests.throws($q$select public.join_game('ZZZZZZZZ', 'Nobody')$q$, 'game_not_found', 'unknown code');
  perform tests.throws(format('select public.join_game(%L, ''   '')', g.join_code), 'invalid_display_name', 'blank name');
  perform tests.throws(format('select public.join_game(%L, %L)', g.join_code, repeat('n', 25)), 'invalid_display_name', '25-char name');

  -- Late joiner into an active game.
  perform tests.start_game(g);
  perform tests.logout();
  v_user := tests.new_user();
  perform tests.login(v_user);
  v_player := public.join_game(g.join_code, 'Late Larry');
  perform tests.is(v_player.color, 2::smallint, 'late joiner gets next color');
  perform tests.is(v_player.is_ready, false, 'late joiner not ready');
  perform tests.is((select status from public.games where id = g.game_id), 'active'::public.game_status, 'game still active');
  perform tests.ok((public.complete_square(g.game_id, 3)).applied, 'late joiner can complete squares');

  -- Ended game: newcomers rejected, members still get their row back.
  perform tests.login(g.users[1]);
  perform public.end_game(g.game_id);
  perform tests.logout();
  v_user := tests.new_user();
  perform tests.login(v_user);
  perform tests.throws(format('select public.join_game(%L, ''Too Late'')', g.join_code), 'game_ended', 'join ended game');
  perform tests.is(to_jsonb(public.peek_game(g.join_code)) ->> 'status', 'ended', 'peek shows ended');
  perform tests.login(v_dash);
  v_again := public.join_game(g.join_code, 'New Name');
  perform tests.is(v_again.id, v_dash_player.id, 'member rejoin of ended game returns their row');
  perform tests.is(v_again.display_name, 'Dash', 'name not changed once ended');
end
$body$);

select tests.run('r', 'create_game: validation, 25 squares with blanks filled, host is player color 0, join code format, expiry = created_at + 30 days, default deadline = +24 hours', $body$
declare
  v_host uuid;
  v_game public.games;
  v_codes text[] := array[]::text[];
  v_cases text[];
begin
  v_host := tests.new_user();
  perform tests.login(v_host);

  v_game := public.create_game('  Friday   Night ', 'Host', squares => '[
    {"position": 0, "label": "Sing", "details": "Karaoke"},
    {"position": 24, "label": "Wave", "target_count": 5},
    {"position": 3, "label": null, "details": null, "target_count": null}
  ]'::jsonb);
  perform tests.is(v_game.name, 'Friday Night', 'name normalized');
  perform tests.is(v_game.status, 'lobby'::public.game_status, 'lobby');
  perform tests.is(v_game.free_center, true, 'free center defaults on');
  perform tests.is(v_game.host_user_id, v_host, 'caller is host');
  perform tests.ok(v_game.join_code ~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$', 'join code format');
  perform tests.is(v_game.expires_at, v_game.created_at + interval '30 days', 'expires_at = created_at + 30 days');
  perform tests.ok(v_game.started_at is null and v_game.ended_at is null, 'no timestamps yet');
  perform tests.is(v_game.deadline_at, v_game.created_at + interval '24 hours', 'no deadline given: created_at + 24 hours');
  perform tests.is(v_game.deadline_extended_at, null::timestamptz, 'not extended');

  perform tests.is((select count(*) from public.squares where game_id = v_game.id), 25::bigint, '25 squares');
  perform tests.is(
    (select array_agg(position order by position) from public.squares where game_id = v_game.id),
    (select array_agg(i::smallint order by i) from generate_series(0, 24) i), 'positions 0-24');
  perform tests.is((select label || '|' || details || '|' || target_count from public.squares where game_id = v_game.id and position = 0), 'Sing|Karaoke|1', 'square 0');
  perform tests.is((select label || '|' || target_count from public.squares where game_id = v_game.id and position = 24), 'Wave|5', 'square 24');
  perform tests.is((select count(*) from public.squares where game_id = v_game.id and label = '' and details = '' and target_count = 1), 23::bigint, 'blank squares');
  perform tests.is(
    (select format('%s|%s|%s', display_name, color, is_ready) from public.players where game_id = v_game.id),
    'Host|0|f', 'host player row');

  -- Validation: (statement, expected error) pairs.
  v_cases := array[
    $q$select public.create_game('', 'Host')$q$, 'invalid_name',
    $q$select public.create_game(repeat('n', 61), 'Host')$q$, 'invalid_name',
    $q$select public.create_game(null, 'Host')$q$, 'invalid_name',
    $q$select public.create_game('Game', '  ')$q$, 'invalid_display_name',
    $q$select public.create_game('Game', repeat('h', 25))$q$, 'invalid_display_name',
    $q$select public.create_game('Game', 'Host', true, '{}'::jsonb)$q$, 'invalid_squares',
    $q$select public.create_game('Game', 'Host', true, (select jsonb_agg(jsonb_build_object('position', i % 25)) from generate_series(0, 25) i))$q$, 'invalid_squares',
    $q$select public.create_game('Game', 'Host', true, '[1]'::jsonb)$q$, 'invalid_squares',
    $q$select public.create_game('Game', 'Host', true, '[{"label": "no position"}]'::jsonb)$q$, 'invalid_squares',
    $q$select public.create_game('Game', 'Host', true, '[{"position": "1"}]'::jsonb)$q$, 'invalid_squares',
    $q$select public.create_game('Game', 'Host', true, '[{"position": 25}]'::jsonb)$q$, 'invalid_squares',
    $q$select public.create_game('Game', 'Host', true, '[{"position": 1.5}]'::jsonb)$q$, 'invalid_squares',
    $q$select public.create_game('Game', 'Host', true, '[{"position": 2}, {"position": 2}]'::jsonb)$q$, 'invalid_squares',
    $q$select public.create_game('Game', 'Host', true, '[{"position": 2, "label": 7}]'::jsonb)$q$, 'invalid_squares',
    $q$select public.create_game('Game', 'Host', true, jsonb_build_array(jsonb_build_object('position', 2, 'label', repeat('x', 41))))$q$, 'label_too_long',
    $q$select public.create_game('Game', 'Host', true, jsonb_build_array(jsonb_build_object('position', 2, 'details', repeat('x', 201))))$q$, 'details_too_long',
    $q$select public.create_game('Game', 'Host', true, '[{"position": 2, "target_count": 0}]'::jsonb)$q$, 'invalid_target_count',
    $q$select public.create_game('Game', 'Host', true, '[{"position": 2, "target_count": 100}]'::jsonb)$q$, 'invalid_target_count',
    $q$select public.create_game('Game', 'Host', true, '[{"position": 2, "target_count": "3"}]'::jsonb)$q$, 'invalid_target_count'
  ];
  for i in 1..array_length(v_cases, 1) / 2 loop
    perform tests.throws(v_cases[2 * i - 1], v_cases[2 * i], v_cases[2 * i - 1]);
  end loop;

  -- Join codes are unique and drawn from the unambiguous alphabet.
  for i in 1..150 loop
    v_codes := v_codes || (public.create_game('Bulk ' || i, 'Host')).join_code;
  end loop;
  perform tests.is((select count(distinct c) from unnest(v_codes) c), 150::bigint, '150 distinct codes');
  perform tests.ok(
    not exists (select 1 from unnest(v_codes) c where c ~ '[01IO]' or char_length(c) <> 8),
    'no ambiguous characters');
end
$body$);

select tests.run('w', 'leave_game: a member leaves the lobby (row gone, color freed for the next joiner); the host cannot leave; no leaving after start; non-members get game_not_found', $body$
declare
  f tests.fixture;
  v_user uuid;
  v_player public.players;
begin
  f := tests.make_game(3);

  -- Player 2 (color 1) leaves.
  perform tests.login(f.users[2]);
  perform tests.is(public.leave_game(f.game_id), true, 'leave returns true');
  perform tests.logout();
  perform tests.ok(not exists (select 1 from public.players where id = f.players[2]), 'players row deleted');
  perform tests.is((select count(*) from public.players where game_id = f.game_id), 2::bigint, '2 players left');
  perform tests.is(
    (select array_agg(color order by color) from public.players where game_id = f.game_id),
    array[0, 2]::smallint[], 'color 1 is free again');

  -- The leaver is no longer a member: no reads, no RPCs, no second leave.
  perform tests.login(f.users[2]);
  perform tests.is((select count(*) from public.games where id = f.game_id), 0::bigint, 'leaver cannot read the game');
  perform tests.throws(format('select public.leave_game(%L)', f.game_id), 'game_not_found', 'second leave');
  perform tests.throws(format('select public.set_ready(%L, true)', f.game_id), 'game_not_found', 'leaver set_ready');

  -- The next joiner reuses the freed color.
  perform tests.logout();
  v_user := tests.new_user();
  perform tests.login(v_user);
  v_player := public.join_game(f.join_code, 'Newcomer');
  perform tests.is(v_player.color, 1::smallint, 'next joiner gets the freed color');

  -- The leaver may come back through the link like anyone else.
  perform tests.login(f.users[2]);
  v_player := public.join_game(f.join_code, 'Back again');
  perform tests.is(v_player.color, 3::smallint, 'leaver rejoins as a new player');
  perform tests.is(v_player.is_ready, false, 'rejoined player is not ready');

  -- The host cannot leave (they end the game instead).
  perform tests.login(f.users[1]);
  perform tests.throws(format('select public.leave_game(%L)', f.game_id), 'host_cannot_leave', 'host leave');
  perform tests.ok(exists (select 1 from public.players where id = f.players[1]), 'host row intact');

  -- Outsiders and unknown games look the same.
  perform tests.logout();
  v_user := tests.new_user();
  perform tests.login(v_user);
  perform tests.throws(format('select public.leave_game(%L)', f.game_id), 'game_not_found', 'outsider leave');
  perform tests.throws(format('select public.leave_game(%L)', gen_random_uuid()), 'game_not_found', 'unknown game');
  perform tests.throws('select public.leave_game(null)', 'game_not_found', 'null game');

  -- Lobby only: once started nobody can leave (status is checked before the host rule).
  f := tests.make_game(2);
  perform tests.start_game(f);
  perform tests.login(f.users[2]);
  perform tests.throws(format('select public.leave_game(%L)', f.game_id), 'game_not_in_lobby', 'leave after start');
  perform tests.login(f.users[1]);
  perform tests.throws(format('select public.leave_game(%L)', f.game_id), 'game_not_in_lobby', 'host leave after start');
  perform public.end_game(f.game_id);
  perform tests.login(f.users[2]);
  perform tests.throws(format('select public.leave_game(%L)', f.game_id), 'game_not_in_lobby', 'leave after end');
  perform tests.logout();
  perform tests.is((select count(*) from public.players where game_id = f.game_id), 2::bigint, 'both still players');
end
$body$);

select tests.run('x', 'remove_player: host only, lobby only, never self; unknown or foreign players get player_not_found; removing the only unready player unblocks start_game', $body$
declare
  f tests.fixture;
  g tests.fixture;
  v_game public.games;
begin
  f := tests.make_game(3);
  g := tests.make_game(2);

  -- A non-host member cannot remove anyone.
  perform tests.login(f.users[2]);
  perform tests.throws(format('select public.remove_player(%L, %L)', f.game_id, f.players[3]), 'not_host', 'member removes member');
  perform tests.throws(format('select public.remove_player(%L, %L)', f.game_id, f.players[1]), 'not_host', 'member removes host');

  -- The host cannot remove themselves, a stranger's id or another game's player.
  perform tests.login(f.users[1]);
  perform tests.throws(format('select public.remove_player(%L, %L)', f.game_id, f.players[1]), 'not_allowed', 'host removes self');
  perform tests.throws(format('select public.remove_player(%L, %L)', f.game_id, gen_random_uuid()), 'player_not_found', 'unknown player');
  perform tests.throws(format('select public.remove_player(%L, %L)', f.game_id, g.players[2]), 'player_not_found', 'other game''s player');
  perform tests.throws(format('select public.remove_player(%L, null)', f.game_id), 'player_not_found', 'null player');
  perform tests.logout();
  perform tests.ok(exists (select 1 from public.players where id = g.players[2]), 'other game''s player untouched');

  -- Everyone but player 3 is ready: Start is blocked by them.
  perform tests.login(f.users[1]);
  perform public.set_ready(f.game_id, true);
  perform tests.login(f.users[2]);
  perform public.set_ready(f.game_id, true);
  perform tests.login(f.users[1]);
  perform tests.throws(format('select public.start_game(%L)', f.game_id), 'players_not_ready', 'blocked by player 3');

  -- The host removes player 3: their row is gone and Start goes through.
  perform tests.is(public.remove_player(f.game_id, f.players[3]), true, 'remove returns true');
  perform tests.throws(format('select public.remove_player(%L, %L)', f.game_id, f.players[3]), 'player_not_found', 'remove twice');
  perform tests.logout();
  perform tests.ok(not exists (select 1 from public.players where id = f.players[3]), 'players row deleted');
  perform tests.login(f.users[3]);
  perform tests.is((select count(*) from public.players), 0::bigint, 'removed player can no longer read the game');
  perform tests.throws(format('select public.set_ready(%L, true)', f.game_id), 'game_not_found', 'removed player set_ready');
  perform tests.login(f.users[1]);
  v_game := public.start_game(f.game_id);
  perform tests.is(v_game.status, 'active'::public.game_status, 'start succeeds once the unready player is removed');

  -- Lobby only (checked after the host rule).
  perform tests.throws(format('select public.remove_player(%L, %L)', f.game_id, f.players[2]), 'game_not_in_lobby', 'host removes after start');
  perform tests.login(f.users[2]);
  perform tests.throws(format('select public.remove_player(%L, %L)', f.game_id, f.players[1]), 'not_host', 'member removes after start');

  -- Outsiders and unknown games look the same.
  perform tests.login(g.users[2]);
  perform tests.throws(format('select public.remove_player(%L, %L)', f.game_id, f.players[2]), 'game_not_found', 'outsider remove');
  perform tests.throws(format('select public.remove_player(%L, %L)', gen_random_uuid(), f.players[2]), 'game_not_found', 'unknown game');
  perform tests.logout();
  perform tests.is((select count(*) from public.players where game_id = f.game_id), 2::bigint, 'host and player 2 remain');
end
$body$);
