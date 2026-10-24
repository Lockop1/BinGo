-- Rematch (play_again) and the public, session-less game preview (peek_game_public).

select tests.run('y', 'peek_game_public: works as anon, without a subject and for a non-member; returns only name/status/player_count/free_center like peek_game; game_not_found for unknown, malformed and expired codes', $body$
declare
  f tests.fixture;
  v_outsider uuid;
  v_preview jsonb;
  v_stmt text;
begin
  f := tests.make_game(3, false);

  -- anon: no session at all (what a link-preview crawler has).
  perform tests.login_anon();
  v_preview := to_jsonb(public.peek_game_public(f.join_code));
  perform tests.is(
    (select array_agg(k order by k) from jsonb_object_keys(v_preview) as k),
    array['free_center', 'name', 'player_count', 'status'],
    'exactly name/status/player_count/free_center'
  );
  perform tests.is(v_preview ->> 'name', 'Test game', 'name');
  perform tests.is(v_preview ->> 'status', 'lobby', 'status');
  perform tests.is((v_preview ->> 'player_count')::int, 3, 'player_count');
  perform tests.is((v_preview ->> 'free_center')::boolean, false, 'free_center');
  perform tests.is(
    to_jsonb(public.peek_game_public(lower(substr(f.join_code, 1, 4)) || '-' || substr(f.join_code, 5))) ->> 'name',
    'Test game', 'same code normalisation as join_game (lower case, separators)');
  -- Executing the peek grants nothing else: anon still has no table access or other RPCs.
  perform tests.denied('select count(*) from public.games', 'anon still cannot select games');
  perform tests.denied(format('select public.peek_game(%L)', f.join_code), 'anon still cannot peek_game');

  foreach v_stmt in array array[
    $q$select public.peek_game_public('ZZZZZZZZ')$q$,
    $q$select public.peek_game_public('')$q$,
    $q$select public.peek_game_public(null)$q$,
    $q$select public.peek_game_public('ABCD')$q$,
    format('select public.peek_game_public(%L)', f.join_code || 'X'),
    $q$select public.peek_game_public(repeat('A', 10000))$q$,
    $q$select public.peek_game_public('not a code at all')$q$
  ] loop
    perform tests.throws(v_stmt, 'game_not_found', v_stmt);
  end loop;

  -- Authenticated but no JWT subject: same answer.
  perform tests.login_without_sub();
  perform tests.is(to_jsonb(public.peek_game_public(f.join_code)) ->> 'name', 'Test game', 'no subject');

  -- A signed-in non-member gets exactly what peek_game gives, and stays a non-member.
  perform tests.logout();
  v_outsider := tests.new_user();
  perform tests.login(v_outsider);
  perform tests.is(to_jsonb(public.peek_game_public(f.join_code)), to_jsonb(public.peek_game(f.join_code)), 'same as peek_game');
  perform tests.is((select count(*) from public.games), 0::bigint, 'peeking does not make the caller a member');

  -- Effective status: active, then overdue (ended before the cron), then ended.
  perform tests.start_game(f);
  perform tests.login_anon();
  perform tests.is(to_jsonb(public.peek_game_public(f.join_code)) ->> 'status', 'active', 'active');
  perform tests.logout();
  update public.games set auto_end_at = now() - interval '1 minute' where id = f.game_id;
  perform tests.login_anon();
  perform tests.is(to_jsonb(public.peek_game_public(f.join_code)) ->> 'status', 'ended', 'overdue reads as ended');
  perform tests.login(f.users[1]);
  perform public.end_game(f.game_id);
  perform tests.login_anon();
  perform tests.is(to_jsonb(public.peek_game_public(f.join_code)) ->> 'status', 'ended', 'ended');

  -- Expired (past expires_at, not yet deleted by the cron): unknown to the public peek.
  perform tests.logout();
  update public.games
  set created_at = now() - interval '31 days', expires_at = now() - interval '1 day'
  where id = f.game_id;
  perform tests.login_anon();
  perform tests.throws(format('select public.peek_game_public(%L)', f.join_code), 'game_not_found', 'expired game (anon)');
  perform tests.login(v_outsider);
  perform tests.throws(format('select public.peek_game_public(%L)', f.join_code), 'game_not_found', 'expired game (authenticated)');
end
$body$);

select tests.run('z', 'play_again: members of an ended or overdue game only (lobby/active: game_not_ended); a new lobby with the same name, free_center and board (counts, completions and media reset), hosted by the caller as player 0 under their old name; the old row points at it', $body$
declare
  f tests.fixture;
  g tests.fixture;
  v_outsider uuid;
  v_new public.games;
  v_bad text;
begin
  f := tests.make_game(3, true, '[
    {"position": 0, "label": "Sing", "details": "Karaoke counts"},
    {"position": 4, "label": "Collect signatures", "details": "From strangers", "target_count": 3},
    {"position": 7, "label": "Wave", "target_count": 2},
    {"position": 24, "label": "Last one"}
  ]');

  -- Not over yet: lobby, then active, for any member (host included).
  perform tests.login(f.users[2]);
  perform tests.throws(format('select public.play_again(%L)', f.game_id), 'game_not_ended', 'lobby');
  perform tests.login(f.users[1]);
  perform tests.throws(format('select public.play_again(%L)', f.game_id), 'game_not_ended', 'lobby (host)');

  perform tests.start_game(f);
  perform tests.login(f.users[1]);
  perform tests.throws(format('select public.play_again(%L)', f.game_id), 'game_not_ended', 'active (host)');
  perform tests.login(f.users[3]);
  perform tests.throws(format('select public.play_again(%L)', f.game_id), 'game_not_ended', 'active (player)');

  -- Some play: a completion, a finished counter, a half counter, a photo.
  perform tests.login(f.users[2]);
  perform public.complete_square(f.game_id, 0);
  perform public.increment_square(f.game_id, 7, gen_random_uuid());
  perform public.increment_square(f.game_id, 7, gen_random_uuid());
  perform public.increment_square(f.game_id, 4, gen_random_uuid());
  perform public.register_media(f.game_id, 0, f.game_id || '/0/a.jpg', 'photo');

  -- Non-members (and unknown games) get game_not_found, never game_not_ended.
  perform tests.logout();
  v_outsider := tests.new_user();
  perform tests.login(v_outsider);
  perform tests.throws(format('select public.play_again(%L)', f.game_id), 'game_not_found', 'non-member');
  perform tests.throws(format('select public.play_again(%L)', gen_random_uuid()), 'game_not_found', 'unknown game');
  perform tests.throws('select public.play_again(null)', 'game_not_found', 'null game id');

  -- Overdue (active past auto_end_at, cron not run yet) counts as ended. A
  -- non-host player starts the rematch.
  perform tests.logout();
  update public.games set auto_end_at = now() - interval '1 minute' where id = f.game_id;
  perform tests.login(f.users[2]);
  v_new := public.play_again(f.game_id);

  perform tests.ok(v_new.id <> f.game_id, 'a different game');
  perform tests.is(v_new.status, 'lobby'::public.game_status, 'new game is a lobby');
  perform tests.is(v_new.name, 'Test game', 'same name');
  perform tests.is(v_new.free_center, true, 'same free_center');
  perform tests.is(v_new.host_user_id, f.users[2], 'the caller hosts it');
  perform tests.ok(v_new.join_code ~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$', 'fresh join code format');
  perform tests.ok(v_new.join_code <> f.join_code, 'a new join code');
  perform tests.is(v_new.expires_at, v_new.created_at + interval '30 days', 'expires_at = created_at + 30 days');
  perform tests.ok(v_new.started_at is null and v_new.auto_end_at is null and v_new.ended_at is null, 'no timestamps yet');
  perform tests.ok(v_new.next_game_id is null and v_new.next_join_code is null, 'no rematch of the rematch yet');

  -- The caller is its only player: color 0, not ready, their old display name.
  perform tests.is(
    (select string_agg(format('%s|%s|%s|%s', p.user_id, p.display_name, p.color, p.is_ready), ',') from public.players p where p.game_id = v_new.id),
    format('%s|Player 2|0|f', f.users[2]), 'caller is player 0 under their old name, not ready');
  perform tests.is((select count(*) from public.games where id = v_new.id), 1::bigint, 'the host reads the new game');

  -- The board, square by square: content copied, play state reset.
  perform tests.is((select count(*) from public.squares where game_id = v_new.id), 25::bigint, '25 squares');
  select string_agg(format('%s: %s', o.position, n.label), ', ') into v_bad
  from public.squares o
  join public.squares n on n.game_id = v_new.id and n.position = o.position
  where o.game_id = f.game_id
    and o.position <> 12
    and (n.label, n.details, n.target_count) is distinct from (o.label, o.details, o.target_count);
  perform tests.is(v_bad, null, 'labels, details and targets copied by position');
  perform tests.is(
    (select format('%s|%s|%s', label, details, target_count) from public.squares where game_id = v_new.id and position = 4),
    'Collect signatures|From strangers|3', 'counter square copied');
  perform tests.is(
    (select count(*) from public.squares
     where game_id = v_new.id and (current_count <> 0 or completed_at is not null or completed_by_player_id is not null)),
    0::bigint, 'counts reset, nothing completed (not even the center)');
  perform tests.is((select label from public.squares where game_id = v_new.id and position = 12), '',
    'the free center labelled FREE at start is blank again');
  perform tests.is((select count(*) from public.media where game_id = v_new.id), 0::bigint, 'no media');

  -- The old game: pointer set, everything else untouched.
  perform tests.logout();
  perform tests.is((select next_game_id from public.games where id = f.game_id), v_new.id, 'old row: next_game_id');
  perform tests.is((select next_join_code from public.games where id = f.game_id), v_new.join_code, 'old row: next_join_code');
  perform tests.is((select status from public.games where id = f.game_id), 'active'::public.game_status, 'old status untouched (cron flips it)');
  perform tests.is(
    (select count(*) from public.squares where game_id = f.game_id and completed_at is not null), 3::bigint,
    'old completions kept (center, square 0, counter 7)');
  perform tests.is((select current_count from public.squares where game_id = f.game_id and position = 4), 1, 'old half counter kept');
  perform tests.is((select count(*) from public.media where game_id = f.game_id), 1::bigint, 'old media kept');
  perform tests.is((select count(*) from public.players where game_id = f.game_id), 3::bigint, 'old players kept');

  -- A game ended from the lobby (never started) is ended too. free_center off:
  -- a center someone labelled FREE keeps its label, and free_center stays off.
  g := tests.make_game(2, false, '[{"position": 12, "label": "FREE", "details": "Literally"}]');
  perform tests.login(g.users[1]);
  perform public.end_game(g.game_id);
  perform tests.login(g.users[2]);
  v_new := public.play_again(g.game_id);
  perform tests.is(v_new.free_center, false, 'free_center off copied');
  perform tests.is(
    (select format('%s|%s', label, details) from public.squares where game_id = v_new.id and position = 12),
    'FREE|Literally', 'a labelled center without free space is copied as is');
  perform tests.is(v_new.host_user_id, g.users[2], 'any member may start it');
end
$body$);

select tests.run('aa', 'play_again is idempotent per old game: later calls by any old member return the same new game; old members read next_join_code from the old row but not the new game; they join it by that code under their name; a deleted rematch is replaced', $body$
declare
  f tests.fixture;
  v_outsider uuid;
  v_new public.games;
  v_again public.games;
  v_player public.players;
  v_old_code text;
begin
  f := tests.make_game(3, true, '[{"position": 3, "label": "Dance"}]');
  perform tests.start_game(f);
  perform tests.login(f.users[1]);
  perform public.end_game(f.game_id);

  perform tests.login(f.users[3]);
  perform tests.is(
    (select format('%s|%s', next_game_id, next_join_code) from public.games where id = f.game_id), '|',
    'no rematch yet');

  perform tests.login(f.users[2]);
  v_new := public.play_again(f.game_id);
  v_again := public.play_again(f.game_id);
  perform tests.is(v_again.id, v_new.id, 'same caller again: the same game');
  perform tests.is(v_again.join_code, v_new.join_code, 'same code');

  perform tests.login(f.users[1]);
  v_again := public.play_again(f.game_id);
  perform tests.is(v_again.id, v_new.id, 'the old host: the same game');
  perform tests.is(v_again.host_user_id, f.users[2], 'the first caller stays host');

  perform tests.logout();
  perform tests.is(
    (select count(*) from public.games where host_user_id = any (f.users)), 2::bigint,
    'one rematch only (old game + new game)');
  perform tests.is((select count(*) from public.players where game_id = v_new.id), 1::bigint,
    'a repeat call does not join anyone');

  -- Another old member: sees the pointer on the old row, cannot read the new game.
  perform tests.login(f.users[3]);
  perform tests.is((select next_join_code from public.games where id = f.game_id), v_new.join_code, 'old member reads next_join_code');
  perform tests.is((select next_game_id from public.games where id = f.game_id), v_new.id, 'old member reads next_game_id');
  perform tests.is((select count(*) from public.games where id = v_new.id), 0::bigint, 'non-member of the new game cannot read it');
  perform tests.is((select count(*) from public.players where game_id = v_new.id), 0::bigint, 'nor its players');
  perform tests.is((select count(*) from public.squares where game_id = v_new.id), 0::bigint, 'nor its squares');
  perform tests.is(to_jsonb(public.peek_game(v_new.join_code)) ->> 'player_count', '1', 'peek shows the waiting host');

  -- One tap: join by the code under the name from the old game.
  v_player := public.join_game(
    (select next_join_code from public.games where id = f.game_id),
    (select display_name from public.players where game_id = f.game_id and user_id = f.users[3]));
  perform tests.is(v_player.game_id, v_new.id, 'joined the new game');
  perform tests.is(v_player.display_name, 'Player 3', 'under the old name');
  perform tests.is(v_player.color, 1::smallint, 'next free color');
  perform tests.is((select count(*) from public.games where id = v_new.id), 1::bigint, 'now reads the new game');
  perform tests.is((select count(*) from public.squares where game_id = v_new.id and label = 'Dance'), 1::bigint, 'and its board');
  perform tests.is((public.play_again(f.game_id)).id, v_new.id, 'still the same rematch');

  -- Outsiders never see the pointer.
  perform tests.logout();
  v_outsider := tests.new_user();
  perform tests.login(v_outsider);
  perform tests.is((select count(*) from public.games where next_join_code is not null), 0::bigint, 'outsider sees no pointer');

  -- The rematch is gone (deleted): the foreign key clears next_game_id and the
  -- next call makes a fresh rematch that replaces the stale code.
  perform tests.logout();
  v_old_code := v_new.join_code;
  delete from public.games where id = v_new.id;
  perform tests.is((select next_game_id from public.games where id = f.game_id), null::uuid, 'pointer cleared by the foreign key');
  perform tests.login(f.users[1]);
  v_again := public.play_again(f.game_id);
  perform tests.ok(v_again.id <> v_new.id, 'a fresh rematch');
  perform tests.is(v_again.host_user_id, f.users[1], 'hosted by this caller');
  perform tests.logout();
  perform tests.is(
    (select format('%s|%s', next_game_id, next_join_code) from public.games where id = f.game_id),
    format('%s|%s', v_again.id, v_again.join_code), 'pointer and code replaced');
  perform tests.ok(v_again.join_code <> v_old_code, 'new code');

  -- The cleanup cron deletes expired games in one statement: old and new together is fine.
  delete from public.games where id in (f.game_id, v_again.id);
  perform tests.is((select count(*) from public.games where id in (f.game_id, v_again.id)), 0::bigint, 'both deleted');
end
$body$);
