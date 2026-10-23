-- Media rows (register_media) and storage.objects policies for bucket game-media.
-- storage.objects here is the shim's stub table with RLS enabled; inserting as
-- `authenticated` with owner/owner_id = the caller mirrors what the Supabase
-- storage server does for an upload.

select tests.run('l', 'register_media rejects paths outside the game folder and non-members; storage uploads succeed only into the member''s own game folder', $body$
declare
  f tests.fixture;
  g tests.fixture;
  v_media public.media;
  v_again public.media;
  v_n integer;
  v_sql constant text := 'insert into storage.objects (bucket_id, name, owner, owner_id) values (''game-media'', %L, %L, %L)';
  v_path text;
begin
  f := tests.make_game(2);
  g := tests.make_game(1);

  -- Lobby: no uploads, no media.
  perform tests.login(f.users[2]);
  perform tests.throws(format('select public.register_media(%1$L, 0, %1$L || ''/0/a.jpg'', ''photo'')', f.game_id), 'game_not_started', 'register in lobby');
  perform tests.rls_denied(format(v_sql, f.game_id || '/0/lobby.jpg', f.users[2], f.users[2]), 'upload in lobby');

  perform tests.start_game(f);
  perform tests.start_game(g);

  perform tests.login(f.users[2]);
  perform tests.throws(format('select public.register_media(%1$L, 0, %1$L || ''/0/a.jpg'', ''photo'')', f.game_id), 'square_not_completed', 'square not completed');
  perform public.complete_square(f.game_id, 0);

  -- Paths outside '<game_id>/...' are refused.
  foreach v_path in array array[
    g.game_id || '/0/a.jpg',
    'a.jpg',
    f.game_id::text,
    f.game_id || '/',
    f.game_id || '//a.jpg',
    f.game_id || '/0/../../' || g.game_id || '/a.jpg',
    f.game_id || '/.hidden',
    f.game_id || 'x/a.jpg',
    upper(f.game_id::text) || '/0/a.jpg',
    f.game_id || '/' || repeat('a', 480)
  ] loop
    perform tests.throws(format('select public.register_media(%L, 0, %L, ''photo'')', f.game_id, v_path), 'invalid_storage_path', 'path ' || v_path);
  end loop;
  perform tests.throws(format('select public.register_media(%L, 0, null, ''photo'')', f.game_id), 'invalid_storage_path', 'null path');
  perform tests.throws(format('select public.register_media(%1$L, 0, %1$L || ''/0/a.gif'', ''gif'')', f.game_id), 'invalid_kind', 'bad kind');
  perform tests.throws(format('select public.register_media(%1$L, 30, %1$L || ''/0/a.jpg'', ''photo'')', f.game_id), 'invalid_position', 'bad position');

  -- Success, and idempotent for the same player/square/path.
  v_media := public.register_media(f.game_id, 0, f.game_id || '/0/p2.jpg', 'photo');
  perform tests.is(v_media.game_id, f.game_id, 'media game');
  perform tests.is(v_media.player_id, f.players[2], 'media player = caller');
  perform tests.is(v_media.square_id, (select id from public.squares where game_id = f.game_id and position = 0), 'media square');
  perform tests.is(v_media.kind, 'photo'::public.media_kind, 'media kind');
  v_again := public.register_media(f.game_id, 0, f.game_id || '/0/p2.jpg', 'photo');
  perform tests.is(v_again.id, v_media.id, 'register_media is idempotent');
  perform tests.throws(format('select public.register_media(%L, 12, %L, ''photo'')', f.game_id, f.game_id || '/0/p2.jpg'), 'invalid_storage_path', 'same path on another square');
  perform tests.ok((public.register_media(f.game_id, 12, f.game_id || '/12/v.mp4', 'video')).kind = 'video', 'video on the free center');

  perform tests.login(f.users[1]);
  perform tests.throws(format('select public.register_media(%L, 0, %L, ''photo'')', f.game_id, f.game_id || '/0/p2.jpg'), 'invalid_storage_path', 'path owned by another player');

  -- Non-member.
  perform tests.login(g.users[1]);
  perform tests.throws(format('select public.register_media(%1$L, 0, %1$L || ''/0/x.jpg'', ''photo'')', f.game_id), 'game_not_found', 'non-member register');

  -- storage.objects INSERT: own game folder only, as yourself only.
  perform tests.login(f.users[2]);
  execute format(v_sql, f.game_id || '/0/p2.jpg', f.users[2], f.users[2]);
  perform tests.rls_denied(format(v_sql, g.game_id || '/0/x.jpg', f.users[2], f.users[2]), 'upload into another game folder');
  perform tests.rls_denied(format(v_sql, f.game_id || '/0/fake.jpg', f.users[1], f.users[1]), 'upload as another user');
  perform tests.rls_denied(format(v_sql, 'not-a-uuid/x.jpg', f.users[2], f.users[2]), 'non-uuid folder (no cast error)');
  perform tests.rls_denied(format(v_sql, 'loose.jpg', f.users[2], f.users[2]), 'no folder');

  perform tests.login(f.users[1]);
  execute format(v_sql, f.game_id || '/0/host.jpg', f.users[1], f.users[1]);

  perform tests.login(g.users[1]);
  perform tests.is((select count(*) from storage.objects), 0::bigint, 'other game host sees no objects of game f');
  execute format(v_sql, g.game_id || '/1/g.jpg', g.users[1], g.users[1]);
  perform tests.is((select count(*) from storage.objects), 1::bigint, 'sees own game object only');

  perform tests.login(f.users[2]);
  perform tests.is((select count(*) from storage.objects), 2::bigint, 'member sees both objects of game f only');

  -- No UPDATE policy: updates touch nothing.
  update storage.objects set name = name || '.bak' where bucket_id = 'game-media';
  get diagnostics v_n = row_count;
  perform tests.is(v_n, 0, 'no object updates');

  -- DELETE: not someone else's (unless host); own is fine.
  delete from storage.objects where name = f.game_id || '/0/host.jpg';
  get diagnostics v_n = row_count;
  perform tests.is(v_n, 0, 'member cannot delete host object');

  perform tests.login(f.users[1]);
  delete from storage.objects where name = f.game_id || '/0/p2.jpg';
  get diagnostics v_n = row_count;
  perform tests.is(v_n, 1, 'host deletes a player object');

  perform tests.login(f.users[2]);
  execute format(v_sql, f.game_id || '/0/p2b.jpg', f.users[2], f.users[2]);
  delete from storage.objects where name = f.game_id || '/0/p2b.jpg';
  get diagnostics v_n = row_count;
  perform tests.is(v_n, 1, 'owner deletes own object');

  perform tests.login(g.users[1]);
  delete from storage.objects where name = f.game_id || '/0/host.jpg';
  get diagnostics v_n = row_count;
  perform tests.is(v_n, 0, 'outsider cannot delete');

  -- Ended (within expiry): uploads and media still allowed for the recap.
  perform tests.login(f.users[1]);
  perform public.end_game(f.game_id);
  perform tests.login(f.users[2]);
  execute format(v_sql, f.game_id || '/0/after-end.jpg', f.users[2], f.users[2]);
  perform tests.ok((public.register_media(f.game_id, 0, f.game_id || '/0/after-end.jpg', 'photo')).id is not null, 'media after end');

  -- Expired: no more uploads or media.
  perform tests.logout();
  update public.games
  set created_at = now() - interval '31 days', expires_at = now() - interval '1 day'
  where id = f.game_id;
  perform tests.login(f.users[2]);
  perform tests.rls_denied(format(v_sql, f.game_id || '/0/expired.jpg', f.users[2], f.users[2]), 'upload after expiry');
  perform tests.throws(format('select public.register_media(%1$L, 0, %1$L || ''/0/expired.jpg'', ''photo'')', f.game_id), 'game_expired', 'register after expiry');
end
$body$);
