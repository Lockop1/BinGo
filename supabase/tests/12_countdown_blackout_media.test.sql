-- Start countdown, end reasons (incl. blackout) and media after the end
-- (migration 20261027173644_countdown_blackout_post_game_media).

select tests.run('al', 'countdown / end_reason schema: both columns nullable, read by members; end_reason only host / deadline / blackout and set exactly when status = ended; countdown_ends_at only on started games and never before the start', $body$
declare
  f tests.fixture;
  v_game public.games;
begin
  perform tests.is(
    (select string_agg(column_name || ':' || data_type || ':' || is_nullable, ',' order by column_name)
     from information_schema.columns
     where table_schema = 'public' and table_name = 'games' and column_name in ('countdown_ends_at', 'end_reason')),
    'countdown_ends_at:timestamp with time zone:YES,end_reason:text:YES',
    'columns and types');

  f := tests.make_game(2);
  perform tests.login(f.users[2]);
  select gm.* into v_game from public.games gm where gm.id = f.game_id;
  perform tests.ok(v_game.countdown_ends_at is null and v_game.end_reason is null, 'lobby: no countdown, no end reason');

  -- Lobby: no countdown, no end reason.
  perform tests.logout();
  perform tests.throws(format('update public.games set countdown_ends_at = now() where id = %L', f.game_id), '23514', 'countdown on a lobby');
  perform tests.throws(format('update public.games set end_reason = ''host'' where id = %L', f.game_id), '23514', 'end reason on a lobby');

  perform tests.start_game(f, false);
  perform tests.throws(format('update public.games set countdown_ends_at = started_at - interval ''1 second'' where id = %L', f.game_id), '23514', 'countdown before the start');
  perform tests.throws(format('update public.games set end_reason = ''host'' where id = %L', f.game_id), '23514', 'end reason on a live game');
  perform tests.throws(format('update public.games set status = ''ended'', ended_at = now() where id = %L', f.game_id), '23514', 'ended without a reason');
  perform tests.throws(format('update public.games set status = ''ended'', ended_at = now(), end_reason = ''bored'' where id = %L', f.game_id), '23514', 'unknown reason');
  update public.games set status = 'ended', ended_at = now(), end_reason = 'blackout' where id = f.game_id;
  perform tests.throws(format('update public.games set end_reason = null where id = %L', f.game_id), '23514', 'ended, reason removed');

  -- Members read both (the games SELECT grant covers every column).
  perform tests.login(f.users[2]);
  perform tests.is((select end_reason from public.games where id = f.game_id), 'blackout', 'member reads end_reason');
  perform tests.ok((select countdown_ends_at from public.games where id = f.game_id) is not null, 'member reads countdown_ends_at');
end
$body$);

select tests.run('am', 'start countdown: start_game sets countdown_ends_at = started_at + 5 s; until then complete/increment/undo raise countdown_in_progress (after game_not_found / game_not_active, before invalid_position); allowed once it passes; end_game / extend_deadline are not held up; a play_again rematch starts with no countdown', $body$
declare
  f tests.fixture;
  g tests.fixture;
  v_game public.games;
  v_new public.games;
  v_result public.square_result;
  v_outsider uuid;
begin
  f := tests.make_game(2, true, '[{"position": 3, "label": "Count to 3", "target_count": 3}]'::jsonb);
  perform tests.login(f.users[1]);
  perform public.set_ready(f.game_id, true);
  perform tests.login(f.users[2]);
  perform public.set_ready(f.game_id, true);
  perform tests.login(f.users[1]);
  v_game := public.start_game(f.game_id);
  perform tests.is(v_game.status, 'active'::public.game_status, 'active at once');
  perform tests.is(v_game.started_at, now(), 'started now');
  perform tests.is(v_game.countdown_ends_at, now() + interval '5 seconds', 'countdown ends 5 seconds later');
  perform tests.is(v_game.end_reason, null::text, 'no end reason');
  perform tests.is((select completed_at from public.squares where game_id = f.game_id and position = 12), now(), 'free center completed at the start');

  -- During the countdown: every completion RPC waits, for host and player alike.
  perform tests.login(f.users[2]);
  perform tests.throws(format('select public.complete_square(%L, 0)', f.game_id), 'countdown_in_progress', 'complete during the countdown');
  perform tests.throws(format('select public.increment_square(%L, 3, gen_random_uuid())', f.game_id), 'countdown_in_progress', 'increment during the countdown');
  perform tests.throws(format('select public.undo_completion(%L, 12)', f.game_id), 'countdown_in_progress', 'undo during the countdown');
  perform tests.login(f.users[1]);
  perform tests.throws(format('select public.complete_square(%L, 0)', f.game_id), 'countdown_in_progress', 'host complete during the countdown');
  -- Check order: before invalid_position / is_counter / not_counter.
  perform tests.throws(format('select public.complete_square(%L, 99)', f.game_id), 'countdown_in_progress', 'countdown before invalid_position');
  perform tests.throws(format('select public.complete_square(%L, 3)', f.game_id), 'countdown_in_progress', 'countdown before is_counter');
  perform tests.throws(format('select public.increment_square(%L, 0, null)', f.game_id), 'countdown_in_progress', 'countdown before not_counter');
  perform tests.throws(format('select public.undo_completion(%L, null)', f.game_id), 'countdown_in_progress', 'countdown before invalid_position (undo)');
  -- ...and after membership.
  perform tests.logout();
  v_outsider := tests.new_user();
  perform tests.login(v_outsider);
  perform tests.throws(format('select public.complete_square(%L, 0)', f.game_id), 'game_not_found', 'outsider: game_not_found first');
  perform tests.logout();
  perform tests.is((select count(*) from public.squares where game_id = f.game_id and completed_at is not null), 1::bigint, 'nothing but the free center');
  perform tests.is((select count(*) from public.square_increments where game_id = f.game_id), 0::bigint, 'no +1 logged');

  -- The host can still extend (live) during the countdown.
  perform tests.login(f.users[1]);
  v_game := public.extend_deadline(f.game_id, v_game.deadline_at + interval '1 hour');
  perform tests.ok(v_game.deadline_extended_at is not null, 'extend during the countdown');

  -- Countdown over: everything goes through.
  perform tests.logout();
  perform tests.pass_countdown(f.game_id);
  perform tests.login(f.users[2]);
  v_result := public.complete_square(f.game_id, 0);
  perform tests.ok(v_result.applied, 'complete after the countdown');
  v_result := public.increment_square(f.game_id, 3, gen_random_uuid());
  perform tests.is(v_result.current_count, 1, 'increment after the countdown');
  v_result := public.undo_completion(f.game_id, 0);
  perform tests.ok(v_result.applied, 'undo after the countdown');

  -- An overdue game in its countdown is over: game_not_active wins.
  g := tests.make_game(1);
  perform tests.start_game(g, false);
  perform tests.pass_deadline(g.game_id);
  perform tests.login(g.users[1]);
  perform tests.throws(format('select public.complete_square(%L, 0)', g.game_id), 'game_not_active', 'game_not_active before countdown_in_progress');
  perform tests.throws(format('select public.undo_completion(%L, 0)', g.game_id), 'game_not_active', 'undo: game_not_active first');

  -- The host may end during the countdown; the rematch is a fresh lobby without one.
  g := tests.make_game(2);
  perform tests.start_game(g, false);
  perform tests.login(g.users[1]);
  v_game := public.end_game(g.game_id);
  perform tests.is(v_game.status, 'ended'::public.game_status, 'ended during the countdown');
  perform tests.is(v_game.end_reason, 'host', 'by the host');
  perform tests.ok(v_game.countdown_ends_at is not null, 'the ended game keeps its countdown stamp');
  perform tests.login(g.users[2]);
  v_new := public.play_again(g.game_id);
  perform tests.is(v_new.status, 'lobby'::public.game_status, 'rematch is a lobby');
  perform tests.is(v_new.countdown_ends_at, null::timestamptz, 'rematch: no countdown');
  perform tests.is(v_new.end_reason, null::text, 'rematch: no end reason');
end
$body$);

select tests.run('an', 'blackout via complete_square: the completion of the last open square returns its square_result (applied) and ends the game in the same transaction (ended_at = now(), end_reason blackout); earlier completions do not; afterwards undo / complete give game_not_active, end_game returns it unchanged, newcomers get game_ended; without a free center all 25 squares are needed', $body$
declare
  f tests.fixture;
  g tests.fixture;
  v_result public.square_result;
  v_game public.games;
  v_outsider uuid;
  p integer;
begin
  f := tests.make_game(2);
  perform tests.start_game(f);
  -- 23 of the 24 open squares (the free center is already done), alternating players.
  foreach p in array array[0,1,2,3,4,5,6,7,8,9,10,11,13,14,15,16,17,18,19,20,21,22,23] loop
    perform tests.login(f.users[1 + p % 2]);
    v_result := public.complete_square(f.game_id, p);
    perform tests.ok(v_result.applied, 'completed ' || p);
  end loop;
  perform tests.logout();
  perform tests.is((select status from public.games where id = f.game_id), 'active'::public.game_status, '24/25: still live');

  -- The 25th square: Player 2 (users[2]) crosses off position 24.
  perform tests.login(f.users[2]);
  v_result := public.complete_square(f.game_id, 24);
  perform tests.ok(v_result.applied, 'last completion applied');
  perform tests.is(v_result.position, 24::smallint, 'the result is the square');
  perform tests.is(v_result.completed_by_player_id, f.players[2], 'credited to the caller');
  perform tests.is(v_result.completed_at, now(), 'completed now');

  select gm.* into v_game from public.games gm where gm.id = f.game_id;
  perform tests.is(v_game.status, 'ended'::public.game_status, 'blackout ended the game');
  perform tests.is(v_game.end_reason, 'blackout', 'end_reason = blackout');
  perform tests.is(v_game.ended_at, v_result.completed_at, 'ended in the same transaction as the completion');
  perform tests.is(v_game.deadline_at > now(), true, 'well before the deadline');

  -- The board is final.
  perform tests.throws(format('select public.undo_completion(%L, 24)', f.game_id), 'game_not_active', 'undo after the blackout (completer)');
  perform tests.login(f.users[1]);
  perform tests.throws(format('select public.undo_completion(%L, 24)', f.game_id), 'game_not_active', 'undo after the blackout (host)');
  perform tests.throws(format('select public.complete_square(%L, 24)', f.game_id), 'game_not_active', 'complete after the blackout');
  perform tests.throws(format('select public.extend_deadline(%L, now() + interval ''30 hours'')', f.game_id), 'game_not_active', 'extend after the blackout');
  v_game := public.end_game(f.game_id);
  perform tests.is(v_game.end_reason, 'blackout', 'end_game on a blackout game: unchanged');
  perform tests.is(v_game.ended_at, v_result.completed_at, 'ended_at unchanged');
  perform tests.logout();
  v_outsider := tests.new_user();
  perform tests.login(v_outsider);
  perform tests.throws(format('select public.join_game(%L, ''Late'')', f.join_code), 'game_ended', 'newcomer after the blackout');

  -- No free center: the 24th completion is not a blackout, the 25th is.
  g := tests.make_game(1, false);
  perform tests.start_game(g);
  perform tests.login(g.users[1]);
  for p in 0..23 loop
    perform public.complete_square(g.game_id, p);
  end loop;
  perform tests.is((select status from public.games where id = g.game_id), 'active'::public.game_status, '24/25 without a free center: live');
  v_result := public.complete_square(g.game_id, 24);
  perform tests.ok(v_result.applied, '25th applied');
  perform tests.is((select end_reason from public.games where id = g.game_id), 'blackout', '25/25: blackout');

  -- A completion that was already there (applied = false) is never a blackout trigger by itself,
  -- and an undo + re-complete before the end works as usual.
  g := tests.make_game(1);
  perform tests.start_game(g);
  perform tests.login(g.users[1]);
  for p in 0..23 loop
    if p <> 12 then
      perform public.complete_square(g.game_id, p);
    end if;
  end loop;
  perform public.undo_completion(g.game_id, 0);
  v_result := public.complete_square(g.game_id, 1);
  perform tests.ok(not v_result.applied, 'already completed: applied = false');
  perform tests.is((select status from public.games where id = g.game_id), 'active'::public.game_status, 'two open squares: live');
  perform public.complete_square(g.game_id, 0);
  perform tests.is((select status from public.games where id = g.game_id), 'active'::public.game_status, 'one open square: live');
  perform public.complete_square(g.game_id, 24);
  perform tests.is((select end_reason from public.games where id = g.game_id), 'blackout', 'then the blackout');
end
$body$);

select tests.run('ao', 'blackout via increment_square: with every other square done, +1s below the target leave the game live; the +1 that reaches the target completes the counter, credits the caller and ends the game (end_reason blackout) in the same call; a later +1 or undo gets game_not_active', $body$
declare
  f tests.fixture;
  v_result public.square_result;
  v_game public.games;
  p integer;
begin
  f := tests.make_game(2, true, '[{"position": 7, "label": "Collect 3 signatures", "target_count": 3}]'::jsonb);
  perform tests.start_game(f);
  perform tests.login(f.users[1]);
  for p in 0..24 loop
    if p not in (7, 12) then
      perform public.complete_square(f.game_id, p);
    end if;
  end loop;
  perform tests.is((select status from public.games where id = f.game_id), 'active'::public.game_status, 'only the counter left: live');

  perform tests.login(f.users[2]);
  v_result := public.increment_square(f.game_id, 7, gen_random_uuid());
  perform tests.is(v_result.current_count, 1, '1/3');
  perform tests.login(f.users[1]);
  v_result := public.increment_square(f.game_id, 7, gen_random_uuid());
  perform tests.is(v_result.current_count, 2, '2/3');
  perform tests.logout();
  perform tests.is((select status from public.games where id = f.game_id), 'active'::public.game_status, '2/3: still live');

  perform tests.login(f.users[2]);
  v_result := public.increment_square(f.game_id, 7, gen_random_uuid());
  perform tests.ok(v_result.applied, 'the third +1 applied');
  perform tests.is(v_result.current_count, 3, '3/3');
  perform tests.is(v_result.completed_by_player_id, f.players[2], 'credited to whoever hit the target');
  perform tests.ok(v_result.completed_at is not null, 'counter completed');

  select gm.* into v_game from public.games gm where gm.id = f.game_id;
  perform tests.is(v_game.status, 'ended'::public.game_status, 'blackout ended the game');
  perform tests.is(v_game.end_reason, 'blackout', 'end_reason = blackout');
  perform tests.is(v_game.ended_at, v_result.completed_at, 'in the same transaction');

  perform tests.throws(format('select public.increment_square(%L, 7, gen_random_uuid())', f.game_id), 'game_not_active', '+1 after the blackout');
  perform tests.throws(format('select public.undo_completion(%L, 7)', f.game_id), 'game_not_active', 'undo after the blackout');
  perform tests.logout();
  perform tests.is((select count(*) from public.square_increments where game_id = f.game_id), 3::bigint, 'three +1s logged');
end
$body$);

select tests.run('ap', 'end reasons: end_game records host (live or lobby) and deadline for an overdue game (ended_at = deadline_at); auto_end_due_games records deadline; an idempotent end_game keeps the first reason; play_again works on any ended game', $body$
declare
  f tests.fixture;
  v_game public.games;
  v_deadline timestamptz;
begin
  -- Live game, ended by the host.
  f := tests.make_game(2);
  perform tests.start_game(f);
  perform tests.login(f.users[1]);
  v_game := public.end_game(f.game_id);
  perform tests.is(v_game.end_reason, 'host', 'live game: host');
  perform tests.is(v_game.ended_at, now(), 'ended now');
  perform tests.is((public.end_game(f.game_id)).end_reason, 'host', 'idempotent end_game keeps the reason');
  perform tests.login(f.users[2]);
  perform tests.is((public.play_again(f.game_id)).status, 'lobby'::public.game_status, 'rematch from a host-ended game');

  -- Lobby closed by the host.
  f := tests.make_game(2);
  perform tests.login(f.users[1]);
  v_game := public.end_game(f.game_id);
  perform tests.is(v_game.end_reason, 'host', 'lobby: host');

  -- Live past its deadline, ended by the host before the cron: the deadline ended it.
  f := tests.make_game(1);
  perform tests.start_game(f);
  v_deadline := tests.pass_deadline(f.game_id, interval '3 minutes');
  perform tests.login(f.users[1]);
  v_game := public.end_game(f.game_id);
  perform tests.is(v_game.end_reason, 'deadline', 'overdue: deadline');
  perform tests.is(v_game.ended_at, v_deadline, 'at the deadline');

  -- The cron.
  f := tests.make_game(2);
  perform tests.start_game(f);
  v_deadline := tests.pass_deadline(f.game_id, interval '2 minutes');
  perform tests.login_service();
  perform tests.ok(public.auto_end_due_games() >= 1, 'cron ended at least this game');
  perform tests.logout();
  select gm.* into v_game from public.games gm where gm.id = f.game_id;
  perform tests.is(v_game.end_reason, 'deadline', 'cron: deadline');
  perform tests.is(v_game.ended_at, v_deadline, 'cron: at the deadline');
  perform tests.login(f.users[1]);
  perform tests.is((public.end_game(f.game_id)).end_reason, 'deadline', 'end_game after the cron keeps deadline');
  perform tests.logout();
  perform tests.is(
    (select count(*) from public.games where status = 'ended' and end_reason is null), 0::bigint,
    'no ended game without a reason');
end
$body$);

select tests.run('aq', 'register_media after the end: own completed squares until expires_at; anyone''s completed square only within 10 minutes of ended_at (deadline_at for an overdue game), then not_allowed (after square_not_completed; a repeat of an existing registration still returns its row); live games unchanged; storage uploads stay open (can_upload_game_media unchanged)', $body$
declare
  f tests.fixture;
  g tests.fixture;
  v_media public.media;
  v_grace public.media;
  v_sql constant text := 'insert into storage.objects (bucket_id, name, owner, owner_id) values (''game-media'', %L, %L, %L)';
begin
  f := tests.make_game(3);
  perform tests.start_game(f);
  perform tests.login(f.users[2]);
  perform public.complete_square(f.game_id, 0);
  perform tests.login(f.users[3]);
  perform public.complete_square(f.game_id, 1);

  -- Live: any member, any completed square (incl. the free center and someone else's).
  perform tests.login(f.users[2]);
  perform tests.ok((public.register_media(f.game_id, 1, f.game_id || '/1/live.jpg', 'photo')).id is not null, 'live: another player''s square');
  perform tests.ok((public.register_media(f.game_id, 12, f.game_id || '/12/live.jpg', 'photo')).id is not null, 'live: free center');

  -- Ended just now (the host): within the grace, anyone's completed square.
  perform tests.login(f.users[1]);
  perform public.end_game(f.game_id);
  perform tests.login(f.users[2]);
  v_media := public.register_media(f.game_id, 0, f.game_id || '/0/own.jpg', 'photo');
  perform tests.is(v_media.player_id, f.players[2], 'ended: own square');
  v_grace := public.register_media(f.game_id, 1, f.game_id || '/1/grace.jpg', 'photo');
  perform tests.is(v_grace.square_id, (select id from public.squares where game_id = f.game_id and position = 1), 'ended: another player''s square within the grace');
  perform tests.ok((public.register_media(f.game_id, 12, f.game_id || '/12/grace.jpg', 'photo')).id is not null, 'ended: free center within the grace');

  -- 9 minutes after the end: still in the grace.
  perform tests.logout();
  perform tests.pass_end(f.game_id, interval '9 minutes 59 seconds');
  perform tests.login(f.users[2]);
  perform tests.ok((public.register_media(f.game_id, 1, f.game_id || '/1/late-grace.jpg', 'video')).id is not null, 'just inside the grace');

  -- 11 minutes after the end: own squares only.
  perform tests.logout();
  perform tests.pass_end(f.game_id, interval '11 minutes');
  perform tests.login(f.users[2]);
  perform tests.throws(format('select public.register_media(%1$L, 1, %1$L || ''/1/after.jpg'', ''photo'')', f.game_id), 'not_allowed', 'another player''s square after the grace');
  perform tests.throws(format('select public.register_media(%1$L, 12, %1$L || ''/12/after.jpg'', ''photo'')', f.game_id), 'not_allowed', 'free center after the grace (completed by nobody)');
  perform tests.ok((public.register_media(f.game_id, 0, f.game_id || '/0/own-after.jpg', 'photo')).id is not null, 'own square after the grace');
  perform tests.is((public.register_media(f.game_id, 1, f.game_id || '/1/grace.jpg', 'photo')).id, v_grace.id, 'a repeat of a grace registration still returns its row');
  -- Check order: square_not_completed before not_allowed; invalid_kind / invalid_storage_path / invalid_position before both.
  perform tests.throws(format('select public.register_media(%1$L, 2, %1$L || ''/2/open.jpg'', ''photo'')', f.game_id), 'square_not_completed', 'open square after the grace');
  perform tests.throws(format('select public.register_media(%1$L, 1, %1$L || ''/1/x.gif'', ''gif'')', f.game_id), 'invalid_kind', 'invalid_kind first');
  perform tests.throws(format('select public.register_media(%L, 1, ''elsewhere/x.jpg'', ''photo'')', f.game_id), 'invalid_storage_path', 'invalid_storage_path first');
  perform tests.throws(format('select public.register_media(%1$L, 99, %1$L || ''/1/x.jpg'', ''photo'')', f.game_id), 'invalid_position', 'invalid_position first');
  -- The completer of square 1 still can; so can the host for their own squares only.
  perform tests.login(f.users[3]);
  perform tests.ok((public.register_media(f.game_id, 1, f.game_id || '/1/mine.jpg', 'photo')).id is not null, 'the completer, after the grace');
  perform tests.login(f.users[1]);
  perform tests.throws(format('select public.register_media(%1$L, 0, %1$L || ''/0/host.jpg'', ''photo'')', f.game_id), 'not_allowed', 'host: not their square after the grace');

  -- Storage uploads are still open until expiry (register_media is the gate).
  perform tests.login(f.users[2]);
  execute format(v_sql, f.game_id || '/1/after-upload.jpg', f.users[2], f.users[2]);
  perform tests.ok(public.can_upload_game_media(f.game_id), 'can_upload_game_media: ended, before expiry');

  -- Past the album expiry: game_expired, even for your own square.
  perform tests.logout();
  update public.games
  set created_at = now() - interval '31 days', expires_at = now() - interval '1 day'
  where id = f.game_id;
  perform tests.login(f.users[2]);
  perform tests.throws(format('select public.register_media(%1$L, 0, %1$L || ''/0/expired.jpg'', ''photo'')', f.game_id), 'game_expired', 'own square past expiry');
  perform tests.ok(not public.can_upload_game_media(f.game_id), 'no uploads past expiry');

  -- Live past its deadline (before the cron): the deadline is the end.
  g := tests.make_game(2);
  perform tests.start_game(g);
  perform tests.login(g.users[1]);
  perform public.complete_square(g.game_id, 0);
  perform tests.logout();
  perform tests.pass_deadline(g.game_id, interval '5 minutes');
  perform tests.login(g.users[2]);
  perform tests.ok((public.register_media(g.game_id, 0, g.game_id || '/0/grace.jpg', 'photo')).id is not null, 'overdue: within 10 minutes of the deadline');
  perform tests.logout();
  perform tests.pass_deadline(g.game_id, interval '12 minutes');
  perform tests.login(g.users[2]);
  perform tests.throws(format('select public.register_media(%1$L, 0, %1$L || ''/0/late.jpg'', ''photo'')', g.game_id), 'not_allowed', 'overdue: past the grace');
  perform tests.login(g.users[1]);
  perform tests.ok((public.register_media(g.game_id, 0, g.game_id || '/0/own.jpg', 'photo')).id is not null, 'overdue: own square');
end
$body$);

select tests.run('ar', 'blackout and media: an upload for the square that finished the board (someone else''s) registers right after the blackout; the blackout game can be rematched', $body$
declare
  f tests.fixture;
  p integer;
  v_new public.games;
begin
  f := tests.make_game(2);
  perform tests.start_game(f);
  perform tests.login(f.users[1]);
  for p in 0..23 loop
    if p <> 12 then
      perform public.complete_square(f.game_id, p);
    end if;
  end loop;
  perform tests.login(f.users[2]);
  perform public.complete_square(f.game_id, 24);
  perform tests.is((select end_reason from public.games where id = f.game_id), 'blackout', 'blackout');
  -- The host's photo of Player 2's winning square, in flight at the blackout.
  perform tests.login(f.users[1]);
  perform tests.ok((public.register_media(f.game_id, 24, f.game_id || '/24/winner.jpg', 'photo')).id is not null, 'host registers on the winning square');
  v_new := public.play_again(f.game_id);
  perform tests.is(v_new.status, 'lobby'::public.game_status, 'rematch after a blackout');
  perform tests.is(v_new.end_reason, null::text, 'rematch: no end reason');
end
$body$);
