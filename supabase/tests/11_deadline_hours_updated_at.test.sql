-- Deadline caps in elapsed hours under any session time zone (P22),
-- games.updated_at (P23) and no rename of a member after the deadline (P28).
-- now() is fixed for a whole test (the transaction start) and cannot be moved
-- to a DST night, so the time-zone test uses DST nights that lie ahead of it:
-- New York's next fall back / spring forward (searched, so any run date works)
-- for the extension cap, and POSIX-rule zones whose change is 3 days from now()
-- for the now()-relative 7-day cap. `set local` / set_config(..., true) are
-- undone with the test's subtransaction.

select tests.run('ai', 'deadline caps are elapsed time under any session time zone: in New York across the fall back and spring forward, extend_deadline takes current + 24 h (never a 23 h / 25 h calendar day) and a deadline of now + 7 × 24 h + 1 h is refused while now + 168 h is accepted; with a DST change inside the next 7 days, create_game / set_deadline accept up to now + 168 h 10 min and refuse anything later (never a 167 h / 169 h calendar week); the 9-minute minimum holds', $body$
declare
  f tests.fixture;
  g tests.fixture;
  v_host uuid;
  v_game public.games;
  v_fall timestamptz;
  v_spring timestamptz;
  v_day date;
  v_n integer;
  v_other integer;
begin
  -- The premise, on New York's 2026 DST nights: a calendar day / week is not
  -- 24 / 168 hours there, while hour intervals are exact.
  set local timezone = 'America/New_York';
  perform tests.is('2026-10-31 12:00Z'::timestamptz + interval '1 day', '2026-11-01 13:00Z'::timestamptz, 'NY fall back (Nov 1): 1 day = 25 h');
  perform tests.is('2026-10-31 12:00Z'::timestamptz + interval '24 hours', '2026-11-01 12:00Z'::timestamptz, 'NY fall back: 24 hours = 24 h');
  perform tests.is('2026-03-07 17:00Z'::timestamptz + interval '1 day', '2026-03-08 16:00Z'::timestamptz, 'NY spring forward (Mar 8): 1 day = 23 h');
  perform tests.is('2026-03-07 17:00Z'::timestamptz + interval '24 hours', '2026-03-08 17:00Z'::timestamptz, 'NY spring forward: 24 hours = 24 h');
  perform tests.is('2026-10-26 12:00Z'::timestamptz + interval '7 days', '2026-11-02 13:00Z'::timestamptz, 'NY: a calendar week across the fall back = 169 h');
  perform tests.is('2026-10-26 12:00Z'::timestamptz + interval '168 hours', '2026-11-02 12:00Z'::timestamptz, 'NY: 168 hours = 168 h');

  -- extend_deadline in New York, on the next DST nights after now(): a game
  -- whose deadline is the first hour from which "+ 1 day" crosses the change.
  select min(gs.t) into v_fall
  from generate_series(date_trunc('hour', now()) + interval '1 hour', now() + interval '400 days', interval '1 hour') as gs(t)
  where gs.t + interval '1 day' > gs.t + interval '24 hours';
  select min(gs.t) into v_spring
  from generate_series(date_trunc('hour', now()) + interval '1 hour', now() + interval '400 days', interval '1 hour') as gs(t)
  where gs.t + interval '1 day' < gs.t + interval '24 hours';
  perform tests.ok(v_fall is not null and v_spring is not null, 'found the next New York fall back and spring forward');
  perform tests.is(v_fall + interval '1 day', v_fall + interval '25 hours', 'premise: from this deadline a calendar day is 25 h');
  perform tests.is(v_spring + interval '1 day', v_spring + interval '23 hours', 'premise: from this deadline a calendar day is 23 h');

  -- Fall back: 25 h is refused, 24 h + 1 min too, 24 h exactly is the cap.
  f := tests.make_game(1);
  perform tests.start_game(f);
  update public.games set deadline_at = v_fall where id = f.game_id;
  perform tests.login(f.users[1]);
  perform tests.throws(format('select public.extend_deadline(%L, %L::timestamptz + interval ''1 day'')', f.game_id, v_fall), 'invalid_deadline', 'NY fall back: + 1 calendar day (25 h) refused');
  perform tests.throws(format('select public.extend_deadline(%L, %L::timestamptz + interval ''24 hours 1 minute'')', f.game_id, v_fall), 'invalid_deadline', 'NY fall back: + 24 h 1 min refused');
  v_game := public.extend_deadline(f.game_id, v_fall + interval '24 hours');
  perform tests.is(extract(epoch from v_game.deadline_at - v_fall), 86400::numeric, 'NY fall back: + 24 h accepted, exactly 86400 s later');

  -- Spring forward: + 24 h is allowed (a calendar day there is only 23 h).
  g := tests.make_game(1);
  perform tests.start_game(g);
  update public.games set deadline_at = v_spring where id = g.game_id;
  perform tests.login(g.users[1]);
  perform tests.throws(format('select public.extend_deadline(%L, %L::timestamptz + interval ''24 hours 1 minute'')', g.game_id, v_spring), 'invalid_deadline', 'NY spring forward: + 24 h 1 min refused');
  v_game := public.extend_deadline(g.game_id, v_spring + interval '24 hours');
  perform tests.is(extract(epoch from v_game.deadline_at - v_spring), 86400::numeric, 'NY spring forward: + 24 h accepted (more than the 23 h calendar day)');
  perform tests.logout();

  -- The now()-relative window in New York itself: 7 × 24 h + 1 h is refused
  -- and 168 h accepted, whatever DST does this week (on a fall-back week the
  -- old calendar-week bound, 169 h 10 min, took the first).
  v_host := tests.new_user();
  perform tests.login(v_host);
  perform tests.throws($q$select public.create_game('G', 'Host', deadline_at => now() + interval '169 hours')$q$, 'invalid_deadline', 'NY: create_game now + 7 × 24 h + 1 h refused');
  v_game := public.create_game('New York', 'Host', deadline_at => now() + interval '168 hours');
  perform tests.is(v_game.deadline_at, now() + interval '168 hours', 'NY: create_game now + 168 h accepted');
  perform tests.throws(format('select public.set_deadline(%L, now() + interval ''169 hours'')', v_game.id), 'invalid_deadline', 'NY: set_deadline now + 7 × 24 h + 1 h refused');
  perform tests.is((public.set_deadline(v_game.id, now() + interval '168 hours 10 minutes')).deadline_at, now() + interval '168 hours 10 minutes', 'NY: set_deadline now + 168 h 10 min (the slack bound) accepted');
  perform tests.logout();

  -- The now()-relative window, in zones whose DST change is 3 days from now()
  -- (POSIX rule "STD offset DST, start/time, end/time" with zero-based days of
  -- the year; the other change is half a year away).
  v_day := (now() at time zone 'UTC')::date + 3;
  v_n := extract(doy from v_day)::integer - 1;
  v_other := (v_n + 180) % 365;
  v_host := tests.new_user();

  -- Clocks go back in 3 days: a calendar week from now is 169 hours.
  perform set_config('timezone', format('XST5XDT,%s/2,%s/2', v_other, v_n), true);
  perform tests.is(now() + interval '7 days', now() + interval '169 hours', 'premise: fall-back zone, a calendar week = 169 h');
  perform tests.login(v_host);
  v_game := public.create_game('Fall back', 'Host', deadline_at => now() + interval '168 hours 10 minutes');
  perform tests.is(v_game.deadline_at, now() + interval '168 hours 10 minutes', 'fall-back zone: now + 168 h 10 min (the slack bound) accepted');
  perform tests.throws($q$select public.create_game('G', 'Host', deadline_at => now() + interval '168 hours 11 minutes')$q$, 'invalid_deadline', 'fall-back zone: create_game now + 168 h 11 min refused');
  perform tests.throws($q$select public.create_game('G', 'Host', deadline_at => now() + interval '169 hours 5 minutes')$q$, 'invalid_deadline', 'fall-back zone: create_game now + 7 d 1 h 5 min refused');
  perform tests.throws($q$select public.create_game('G', 'Host', deadline_at => now() + interval '7 days 10 minutes')$q$, 'invalid_deadline', 'fall-back zone: create_game now + a calendar week + 10 min (169 h 10 min) refused');
  perform tests.throws(format('select public.set_deadline(%L, now() + interval ''168 hours 11 minutes'')', v_game.id), 'invalid_deadline', 'fall-back zone: set_deadline now + 168 h 11 min refused');
  v_game := public.set_deadline(v_game.id, now() + interval '168 hours');
  perform tests.is(v_game.deadline_at, now() + interval '168 hours', 'fall-back zone: set_deadline now + 168 h accepted');

  -- Clocks go forward in 3 days: a calendar week from now is 167 hours.
  perform set_config('timezone', format('XST5XDT,%s/2,%s/2', v_n, v_other), true);
  perform tests.is(now() + interval '7 days', now() + interval '167 hours', 'premise: spring-forward zone, a calendar week = 167 h');
  v_game := public.create_game('Spring forward', 'Host', deadline_at => now() + interval '168 hours');
  perform tests.is(v_game.deadline_at, now() + interval '168 hours', 'spring-forward zone: now + 168 h (7 days) accepted');
  v_game := public.create_game('Spring forward', 'Host', deadline_at => now() + interval '168 hours 10 minutes');
  perform tests.is(v_game.deadline_at, now() + interval '168 hours 10 minutes', 'spring-forward zone: now + 168 h 10 min accepted');
  v_game := public.set_deadline(v_game.id, now() + interval '168 hours 5 minutes');
  perform tests.is(v_game.deadline_at, now() + interval '168 hours 5 minutes', 'spring-forward zone: set_deadline now + 168 h 5 min accepted');
  perform tests.throws($q$select public.create_game('G', 'Host', deadline_at => now() + interval '168 hours 11 minutes')$q$, 'invalid_deadline', 'spring-forward zone: now + 168 h 11 min refused');

  -- The minimum is minutes, in any zone.
  v_game := public.create_game('Soon', 'Host', deadline_at => now() + interval '9 minutes');
  perform tests.is(v_game.deadline_at, now() + interval '9 minutes', 'now + 9 min (the slack minimum) accepted');
  perform tests.throws($q$select public.create_game('G', 'Host', deadline_at => now() + interval '8 minutes 59 seconds')$q$, 'invalid_deadline', 'now + 8 min 59 s refused');
end
$body$);

select tests.run('aj', 'games.updated_at: not null, = created_at on insert; strictly increases across set_deadline, set_free_center, start_game, extend_deadline, end_game, play_again (old row) and the cron, carried by every RPC result; refused calls and an idempotent end_game leave it alone; any UPDATE stamps it, even one that changes nothing or writes an old value; members read it; trigger, replica identity and privileges as for squares', $body$
declare
  f tests.fixture;
  g tests.fixture;
  v_game public.games;
  v_rematch public.games;
  v_prev timestamptz;
  v_stamp timestamptz;
begin
  -- Schema.
  perform tests.is(
    (select format('%s|%s', is_nullable, column_default) from information_schema.columns
     where table_schema = 'public' and table_name = 'games' and column_name = 'updated_at'),
    'NO|now()', 'updated_at not null default now()');
  perform tests.is(
    (select array_agg(t.tgname::text) from pg_trigger t where t.tgrelid = 'public.games'::regclass and not t.tgisinternal),
    array['games_set_updated_at'], 'one user trigger on games');
  perform tests.is(
    (select format('%s|%s', t.tgfoid::regproc, t.tgtype) from pg_trigger t where t.tgname = 'games_set_updated_at'),
    -- tgtype 19 = ROW (1) + BEFORE (2) + UPDATE (16), like squares_set_updated_at.
    'set_updated_at|19', 'before update for each row, public.set_updated_at()');
  perform tests.is(
    (select t.tgtype from pg_trigger t where t.tgname = 'squares_set_updated_at'),
    19::smallint, 'same trigger shape as squares');
  perform tests.is((select relreplident::text from pg_class where oid = 'public.games'::regclass), 'f', 'replica identity full kept');
  perform tests.ok(
    exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'games'),
    'games still in the Realtime publication');
  perform tests.ok(has_column_privilege('authenticated', 'public.games', 'updated_at', 'SELECT'), 'authenticated may select updated_at');
  perform tests.ok(
    not has_table_privilege('authenticated', 'public.games', 'INSERT')
    and not has_table_privilege('authenticated', 'public.games', 'UPDATE')
    and not has_table_privilege('authenticated', 'public.games', 'DELETE')
    and not has_column_privilege('authenticated', 'public.games', 'updated_at', 'UPDATE'),
    'authenticated still cannot write games');
  perform tests.ok(not has_table_privilege('anon', 'public.games', 'SELECT'), 'anon still cannot read games');

  -- Insert: the column default, i.e. the creating transaction's now().
  f := tests.make_game(2);
  select * into v_game from public.games where id = f.game_id;
  perform tests.is(v_game.updated_at, v_game.created_at, 'new game: updated_at = created_at');
  v_prev := v_game.updated_at;

  -- Every RPC that writes the row stamps it, and its result carries the stamp.
  perform tests.login(f.users[1]);
  v_game := public.set_deadline(f.game_id, now() + interval '3 hours');
  perform tests.ok(v_game.updated_at > v_prev, 'set_deadline stamps');
  perform tests.is((select updated_at from public.games where id = f.game_id), v_game.updated_at, 'the RPC result carries the stored stamp');
  v_prev := v_game.updated_at;
  v_game := public.set_free_center(f.game_id, false);
  perform tests.ok(v_game.updated_at > v_prev, 'set_free_center stamps');
  v_prev := v_game.updated_at;

  -- A refused call changes nothing.
  perform tests.throws(format('select public.set_deadline(%L, now() + interval ''1 minute'')', f.game_id), 'invalid_deadline', 'refused set_deadline');
  perform tests.throws(format('select public.start_game(%L)', f.game_id), 'players_not_ready', 'refused start');
  perform tests.is((select updated_at from public.games where id = f.game_id), v_prev, 'refused calls leave updated_at alone');

  perform public.set_ready(f.game_id, true);
  perform tests.login(f.users[2]);
  perform public.set_ready(f.game_id, true);
  perform tests.login(f.users[1]);
  v_game := public.start_game(f.game_id);
  perform tests.ok(v_game.updated_at > v_prev, 'start_game stamps');
  v_prev := v_game.updated_at;

  v_game := public.extend_deadline(f.game_id, v_game.deadline_at + interval '1 hour');
  perform tests.ok(v_game.updated_at > v_prev, 'extend_deadline stamps');
  v_prev := v_game.updated_at;
  perform tests.throws(format('select public.extend_deadline(%L, null)', f.game_id), 'already_extended', 'second extension');
  perform tests.is((select updated_at from public.games where id = f.game_id), v_prev, 'refused extension leaves updated_at alone');

  -- Square and player writes do not touch the games row.
  perform public.complete_square(f.game_id, 0);
  perform tests.is((select updated_at from public.games where id = f.game_id), v_prev, 'a completion does not stamp the game');

  v_game := public.end_game(f.game_id);
  perform tests.ok(v_game.updated_at > v_prev, 'end_game stamps');
  v_prev := v_game.updated_at;
  v_game := public.end_game(f.game_id);
  perform tests.is(v_game.updated_at, v_prev, 'end_game on an ended game: unchanged row, same stamp');

  -- play_again stamps the old row (next_game_id / next_join_code); the rematch starts fresh.
  perform tests.login(f.users[2]);
  v_rematch := public.play_again(f.game_id);
  perform tests.is(v_rematch.updated_at, v_rematch.created_at, 'rematch: updated_at = created_at');
  select updated_at into v_stamp from public.games where id = f.game_id;
  perform tests.ok(v_stamp > v_prev, 'play_again stamps the old row');
  v_prev := v_stamp;

  -- Members read it like the rest of the row.
  perform tests.is((select updated_at from public.games where id = f.game_id), v_prev, 'member reads updated_at');

  -- Any UPDATE stamps clock_timestamp(): a no-op update, or one writing an old value.
  perform tests.logout();
  update public.games set name = name where id = f.game_id returning updated_at into v_stamp;
  perform tests.ok(v_stamp > v_prev, 'an update that changes nothing still stamps');
  v_prev := v_stamp;
  update public.games set updated_at = '2000-01-01' where id = f.game_id returning updated_at into v_stamp;
  perform tests.ok(v_stamp > v_prev, 'an explicit (old) updated_at is overridden by the clock');
  v_prev := v_stamp;

  -- Deleting the rematch nulls the pointer (a foreign-key update): stamped too.
  delete from public.games where id = v_rematch.id;
  select updated_at into v_stamp from public.games where id = f.game_id;
  perform tests.ok(v_stamp > v_prev, 'the on-delete-set-null of next_game_id stamps');

  -- The cron backstop stamps the games it ends.
  g := tests.make_game(1);
  perform tests.start_game(g);
  perform tests.pass_deadline(g.game_id);
  select updated_at into v_prev from public.games where id = g.game_id;
  perform tests.login_service();
  perform tests.is(public.auto_end_due_games(), 1, 'cron ends the overdue game');
  perform tests.logout();
  perform tests.ok((select updated_at from public.games where id = g.game_id) > v_prev, 'auto_end_due_games stamps');
end
$body$);

select tests.run('ak', 'join_game by an existing member: renames while the game is live or in the lobby (even a lobby past its deadline), but never once it is effectively ended (active past the deadline before the cron, ended, or past its album expiry): the row comes back unchanged; newcomers still get game_ended', $body$
declare
  f tests.fixture;
  g tests.fixture;
  v_user uuid;
  v_player public.players;
begin
  f := tests.make_game(2);
  perform tests.start_game(f);

  -- Live: a member's join_game refreshes the name.
  perform tests.login(f.users[2]);
  v_player := public.join_game(f.join_code, 'Bobby Live');
  perform tests.is(v_player.display_name, 'Bobby Live', 'live game: renamed');

  -- Past the deadline, before the cron: the row comes back, the name stays.
  perform tests.logout();
  perform tests.pass_deadline(f.game_id);
  perform tests.is((select status from public.games where id = f.game_id), 'active'::public.game_status, 'still active in the table');
  perform tests.login(f.users[2]);
  v_player := public.join_game(f.join_code, 'Bobby');
  perform tests.is(v_player.id, f.players[2], 'overdue game: the member gets their row');
  perform tests.is(v_player.display_name, 'Bobby Live', 'overdue game: not renamed');
  perform tests.login(f.users[1]);
  v_player := public.join_game(f.join_code, 'Hosty');
  perform tests.is(v_player.display_name, 'Player 1', 'overdue game: the host is not renamed either');
  perform tests.logout();
  perform tests.is(
    (select array_agg(display_name order by color) from public.players where game_id = f.game_id),
    array['Player 1', 'Bobby Live'], 'stored names unchanged');
  v_user := tests.new_user();
  perform tests.login(v_user);
  perform tests.throws(format('select public.join_game(%L, ''Late'')', f.join_code), 'game_ended', 'overdue game: newcomer refused');

  -- After the cron: still not renamed (as for any ended game).
  perform tests.login_service();
  perform public.auto_end_due_games();
  perform tests.login(f.users[2]);
  perform tests.is((public.join_game(f.join_code, 'Bobby')).display_name, 'Bobby Live', 'ended game: not renamed');

  -- A lobby past its deadline is still a lobby: members may rename.
  g := tests.make_game(2);
  perform tests.pass_deadline(g.game_id);
  perform tests.login(g.users[2]);
  perform tests.is((public.join_game(g.join_code, 'Lobby Lou')).display_name, 'Lobby Lou', 'lobby past its deadline: renamed');

  -- Past the album expiry (the cron deletes it soon): no rename, newcomers refused.
  perform tests.logout();
  update public.games
  set created_at = now() - interval '31 days', expires_at = now() - interval '1 day'
  where id = g.game_id;
  perform tests.login(g.users[2]);
  v_player := public.join_game(g.join_code, 'Expired Ed');
  perform tests.is(v_player.display_name, 'Lobby Lou', 'expired game: not renamed');
  perform tests.logout();
  v_user := tests.new_user();
  perform tests.login(v_user);
  perform tests.throws(format('select public.join_game(%L, ''Late'')', g.join_code), 'game_ended', 'expired game: newcomer refused');
end
$body$);
