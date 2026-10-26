-- Privacy boundaries: RLS, table privileges, function privileges, probing.

select tests.run('a', 'non-member cannot read the game, players, squares, media or storage objects; peek_game returns only name/status/player_count/free_center', $body$
declare
  f tests.fixture;
  v_outsider uuid;
  v_preview jsonb;
begin
  f := tests.make_game(2);
  perform tests.start_game(f);

  -- The host completes a square, uploads an object and registers it.
  perform tests.login(f.users[1]);
  perform public.complete_square(f.game_id, 0);
  insert into storage.objects (bucket_id, name, owner, owner_id)
  values ('game-media', f.game_id || '/0/a.jpg', f.users[1], f.users[1]::text);
  perform public.register_media(f.game_id, 0, f.game_id || '/0/a.jpg', 'photo');

  -- Sanity: a member sees all of it.
  perform tests.is((select count(*) from public.games where id = f.game_id), 1::bigint, 'member sees game');
  perform tests.is((select count(*) from public.players where game_id = f.game_id), 2::bigint, 'member sees players');
  perform tests.is((select count(*) from public.squares where game_id = f.game_id), 25::bigint, 'member sees squares');
  perform tests.is((select count(*) from public.media where game_id = f.game_id), 1::bigint, 'member sees media');
  perform tests.is((select count(*) from storage.objects where bucket_id = 'game-media'), 1::bigint, 'member sees object');

  perform tests.logout();
  v_outsider := tests.new_user();
  perform tests.login(v_outsider);

  perform tests.is((select count(*) from public.games), 0::bigint, 'outsider sees no games');
  perform tests.is((select count(*) from public.games where id = f.game_id), 0::bigint, 'outsider cannot select game by id');
  perform tests.is((select count(*) from public.games where join_code = f.join_code), 0::bigint, 'outsider cannot select game by code');
  perform tests.is((select count(*) from public.players), 0::bigint, 'outsider sees no players');
  perform tests.is((select count(*) from public.squares), 0::bigint, 'outsider sees no squares');
  perform tests.is((select count(*) from public.media), 0::bigint, 'outsider sees no media');
  perform tests.is((select count(*) from storage.objects), 0::bigint, 'outsider sees no storage objects');
  perform tests.is(public.is_game_member(f.game_id), false, 'is_game_member false for outsider');
  perform tests.is(public.is_game_host(f.game_id), false, 'is_game_host false for outsider');

  v_preview := to_jsonb(public.peek_game(f.join_code));
  perform tests.is(
    (select array_agg(k order by k) from jsonb_object_keys(v_preview) as k),
    array['free_center', 'name', 'player_count', 'status'],
    'peek_game returns exactly name/status/player_count/free_center'
  );
  perform tests.is(v_preview ->> 'name', 'Test game', 'peek name');
  perform tests.is(v_preview ->> 'status', 'active', 'peek status');
  perform tests.is((v_preview ->> 'player_count')::int, 2, 'peek player_count');
  perform tests.is((v_preview ->> 'free_center')::boolean, true, 'peek free_center');
  perform tests.is(
    to_jsonb(public.peek_game(lower(f.join_code))) ->> 'name', 'Test game',
    'peek_game is case-insensitive'
  );

  -- Peeking does not make the caller a member.
  perform tests.is((select count(*) from public.games), 0::bigint, 'still no games after peek');
end
$body$);

select tests.run('b', 'authenticated (and anon) cannot insert/update/delete/truncate any table directly: permission denied, not just RLS-filtered', $body$
declare
  f tests.fixture;
  t text;
begin
  f := tests.make_game(2);
  perform tests.start_game(f);

  perform tests.login(f.users[1]);
  foreach t in array array['games', 'players', 'squares', 'media'] loop
    perform tests.denied(format('insert into public.%I default values', t), 'insert into ' || t);
    perform tests.denied(format('update public.%I set id = id', t), 'update ' || t);
    perform tests.denied(format('delete from public.%I', t), 'delete from ' || t);
    perform tests.denied(format('truncate public.%I cascade', t), 'truncate ' || t);
  end loop;
  -- Even a member editing their own game's rows is refused.
  perform tests.denied(
    format('update public.games set status = %L where id = %L', 'ended', f.game_id),
    'host cannot update own game directly');
  perform tests.denied(
    format('update public.squares set completed_at = now() where game_id = %L', f.game_id),
    'member cannot complete squares directly');

  perform tests.login_anon();
  foreach t in array array['games', 'players', 'squares', 'media'] loop
    perform tests.denied(format('select count(*) from public.%I', t), 'anon select ' || t);
    perform tests.denied(format('insert into public.%I default values', t), 'anon insert ' || t);
  end loop;

  perform tests.logout();
  foreach t in array array['games', 'players', 'squares', 'media'] loop
    perform tests.is(has_table_privilege('authenticated', 'public.' || t, 'SELECT'), true, 'authenticated SELECT ' || t);
    perform tests.is(
      has_table_privilege('authenticated', 'public.' || t, 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      false, 'authenticated has no write privilege on ' || t);
    perform tests.is(
      has_table_privilege('anon', 'public.' || t, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      false, 'anon has no privilege on ' || t);
  end loop;
  -- The counter action log is internal to increment_square: no client privilege at all.
  perform tests.is(
    has_table_privilege('authenticated', 'public.square_increments', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
    false, 'authenticated has no privilege on square_increments');
  perform tests.is(
    has_table_privilege('anon', 'public.square_increments', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
    false, 'anon has no privilege on square_increments');
  perform tests.login(f.users[1]);
  perform tests.denied('select count(*) from public.square_increments', 'member select square_increments');
  perform tests.denied('delete from public.square_increments', 'member delete square_increments');
  perform tests.login_anon();
  perform tests.denied('select count(*) from public.square_increments', 'anon select square_increments');
end
$body$);

select tests.run('c', 'member can select the full player list, squares and game (no RLS recursion)', $body$
declare
  f tests.fixture;
begin
  f := tests.make_game(4);
  perform tests.login(f.users[3]);
  perform tests.is((select count(*) from public.players where game_id = f.game_id), 4::bigint, 'all 4 players visible');
  perform tests.is((select count(*) from public.players), 4::bigint, 'unfiltered player select works');
  perform tests.is(
    (select array_agg(p.color order by p.color) from public.players p),
    array[0, 1, 2, 3]::smallint[], 'colors visible');
  perform tests.is((select count(*) from public.squares where game_id = f.game_id), 25::bigint, '25 squares visible');
  perform tests.is((select count(*) from public.games), 1::bigint, 'game visible');
  perform tests.is(
    (select count(*) from public.players p join public.games g on g.id = p.game_id),
    4::bigint, 'players join games works');
  perform tests.is(public.is_game_member(f.game_id), true, 'is_game_member true');
  perform tests.is(public.is_game_host(f.game_id), false, 'is_game_host false for non-host');
end
$body$);

select tests.run('n', 'anon executes exactly one function (peek_game_public), PUBLIC none; authenticated/service_role execute exactly the intended ones', $body$
declare
  v_fn record;
  v_unexpected text;
  v_stmt text;
begin
  -- Catalog check over every non-extension function in public, so a future
  -- migration that forgets its REVOKE fails this test.
  for v_fn in
    select p.oid, p.oid::regprocedure::text as sig
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and not exists (
        select 1 from pg_depend d
        where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'
      )
  loop
    -- peek_game_public is the one deliberate exception (link previews have no session).
    perform tests.is(
      has_function_privilege('anon', v_fn.oid, 'EXECUTE'), v_fn.sig = 'peek_game_public(text)',
      'anon EXECUTE ' || v_fn.sig);
    perform tests.ok(
      not exists (select 1 from aclexplode(coalesce(
        (select proacl from pg_proc where oid = v_fn.oid),
        acldefault('f', (select proowner from pg_proc where oid = v_fn.oid)))) a
        where a.grantee = 0),
      'PUBLIC has no EXECUTE on ' || v_fn.sig);
  end loop;

  select string_agg(sig, ', ' order by sig) into v_unexpected
  from (
    select p.oid::regprocedure::text as sig
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and has_function_privilege('anon', p.oid, 'EXECUTE')
      and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
  ) x;
  perform tests.is(v_unexpected, 'peek_game_public(text)', 'anon executes only peek_game_public');

  select string_agg(sig, ', ') into v_unexpected
  from (
    select p.oid::regprocedure::text as sig
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
    except
    select unnest(array[
      'create_game(text,text,boolean,jsonb,timestamp with time zone)', 'join_game(text,text)', 'peek_game(text)',
      'set_ready(uuid,boolean)', 'update_square(uuid,integer,text,text,integer)',
      'set_free_center(uuid,boolean)', 'start_game(uuid)', 'complete_square(uuid,integer)',
      'increment_square(uuid,integer,uuid)', 'undo_completion(uuid,integer)', 'end_game(uuid)',
      'register_media(uuid,integer,text,text)', 'leave_game(uuid)', 'remove_player(uuid,uuid)',
      'peek_game_public(text)', 'play_again(uuid)',
      'set_deadline(uuid,timestamp with time zone)', 'extend_deadline(uuid,timestamp with time zone)',
      'is_game_member(uuid)', 'is_game_host(uuid)',
      'safe_uuid(text)', 'can_upload_game_media(uuid)'
    ])
  ) x;
  perform tests.is(v_unexpected, null, 'authenticated executes only the intended functions');

  select string_agg(sig, ', ') into v_unexpected
  from (
    select p.oid::regprocedure::text as sig
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and has_function_privilege('service_role', p.oid, 'EXECUTE')
      and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
  ) x;
  perform tests.is(v_unexpected, 'auto_end_due_games()', 'service_role executes only auto_end_due_games');

  -- Internal helpers live in schema private, which no API role can even use.
  perform tests.is(
    has_schema_privilege('anon', 'private', 'USAGE') or has_schema_privilege('authenticated', 'private', 'USAGE')
      or has_schema_privilege('service_role', 'private', 'USAGE'),
    false, 'no API role has USAGE on schema private');
  for v_fn in select p.oid, p.oid::regprocedure::text as sig from pg_proc p where p.pronamespace = 'private'::regnamespace loop
    perform tests.is(
      has_function_privilege('anon', v_fn.oid, 'EXECUTE') or has_function_privilege('authenticated', v_fn.oid, 'EXECUTE')
        or has_function_privilege('service_role', v_fn.oid, 'EXECUTE'),
      false, 'no API role executes ' || v_fn.sig);
  end loop;
  perform tests.ok((select count(*) from pg_proc where pronamespace = 'private'::regnamespace) = 5, 'five private helpers');

  -- And actually calling every RPC as anon is refused, except the public peek.
  perform tests.login_anon();
  perform tests.throws($q$select public.peek_game_public('ABCDEFGH')$q$, 'game_not_found', 'anon may peek publicly');
  foreach v_stmt in array array[
    $q$select public.create_game('x', 'y', true, '[]'::jsonb)$q$,
    $q$select public.join_game('ABCDEFGH', 'x')$q$,
    $q$select public.peek_game('ABCDEFGH')$q$,
    $q$select public.set_ready(gen_random_uuid(), true)$q$,
    $q$select public.update_square(gen_random_uuid(), 0, 'x', '', 1)$q$,
    $q$select public.set_free_center(gen_random_uuid(), true)$q$,
    $q$select public.start_game(gen_random_uuid())$q$,
    $q$select public.complete_square(gen_random_uuid(), 0)$q$,
    $q$select public.increment_square(gen_random_uuid(), 0)$q$,
    $q$select public.undo_completion(gen_random_uuid(), 0)$q$,
    $q$select public.end_game(gen_random_uuid())$q$,
    $q$select public.register_media(gen_random_uuid(), 0, 'x/y', 'photo')$q$,
    $q$select public.leave_game(gen_random_uuid())$q$,
    $q$select public.remove_player(gen_random_uuid(), gen_random_uuid())$q$,
    $q$select public.play_again(gen_random_uuid())$q$,
    $q$select public.set_deadline(gen_random_uuid(), now() + interval '1 hour')$q$,
    $q$select public.extend_deadline(gen_random_uuid(), now() + interval '1 hour')$q$,
    $q$select public.create_game('x', 'y', true, '[]'::jsonb, now() + interval '1 hour')$q$,
    $q$select public.auto_end_due_games()$q$,
    $q$select public.is_game_member(gen_random_uuid())$q$,
    $q$select public.is_game_host(gen_random_uuid())$q$,
    $q$select public.safe_uuid('x')$q$,
    $q$select public.can_upload_game_media(gen_random_uuid())$q$
  ] loop
    perform tests.denied(v_stmt, 'anon: ' || v_stmt);
  end loop;
end
$body$);

select tests.run('o', 'non-member gets game_not_found from every game-scoped RPC, identical to a nonexistent game', $body$
declare
  f tests.fixture;
  v_outsider uuid;
  v_target uuid;
  v_stmt text;
begin
  f := tests.make_game(2);
  perform tests.start_game(f);
  perform tests.login(f.users[1]);
  perform public.complete_square(f.game_id, 0);

  perform tests.logout();
  v_outsider := tests.new_user();
  perform tests.login(v_outsider);

  foreach v_target in array array[f.game_id, gen_random_uuid()] loop
    foreach v_stmt in array array[
      'select public.set_ready(%L, true)',
      'select public.update_square(%L, 0, ''x'', '''', 1)',
      'select public.set_free_center(%L, false)',
      'select public.start_game(%L)',
      'select public.complete_square(%L, 1)',
      'select public.increment_square(%L, 1)',
      'select public.undo_completion(%L, 0)',
      'select public.end_game(%L)',
      'select public.register_media(%1$L, 0, %1$L || ''/0/x.jpg'', ''photo'')',
      'select public.increment_square(%L, 1, gen_random_uuid())',
      'select public.leave_game(%L)',
      'select public.remove_player(%L, gen_random_uuid())',
      'select public.play_again(%L)',
      'select public.set_deadline(%L, now() + interval ''1 hour'')',
      'select public.extend_deadline(%L, now() + interval ''25 hours'')'
    ] loop
      perform tests.throws(format(v_stmt, v_target), 'game_not_found', format(v_stmt, v_target));
    end loop;
  end loop;
  perform tests.throws($q$select public.set_ready(null, true)$q$, 'game_not_found', 'null game id');
  perform tests.throws($q$select public.join_game('ZZZZZZZZ', 'Eve')$q$, 'game_not_found', 'join unknown code');
  perform tests.throws($q$select public.peek_game('ZZZZZZZZ')$q$, 'game_not_found', 'peek unknown code');
  perform tests.throws($q$select public.peek_game('not a code at all')$q$, 'game_not_found', 'peek garbage');

  -- Nothing changed for the members.
  perform tests.logout();
  perform tests.is((select status from public.games where id = f.game_id), 'active'::public.game_status, 'game still active');
  perform tests.is((select count(*) from public.players where game_id = f.game_id), 2::bigint, 'still 2 players');
end
$body$);

select tests.run('u', 'every RPC raises not_authenticated without a JWT subject', $body$
declare
  v_stmt text;
begin
  perform tests.login_without_sub();
  foreach v_stmt in array array[
    $q$select public.create_game('x', 'y', true, '[]'::jsonb)$q$,
    $q$select public.join_game('ABCDEFGH', 'x')$q$,
    $q$select public.peek_game('ABCDEFGH')$q$,
    $q$select public.set_ready(gen_random_uuid(), true)$q$,
    $q$select public.update_square(gen_random_uuid(), 0, 'x', '', 1)$q$,
    $q$select public.set_free_center(gen_random_uuid(), true)$q$,
    $q$select public.start_game(gen_random_uuid())$q$,
    $q$select public.complete_square(gen_random_uuid(), 0)$q$,
    $q$select public.increment_square(gen_random_uuid(), 0)$q$,
    $q$select public.undo_completion(gen_random_uuid(), 0)$q$,
    $q$select public.end_game(gen_random_uuid())$q$,
    $q$select public.register_media(gen_random_uuid(), 0, 'x/y', 'photo')$q$,
    $q$select public.increment_square(gen_random_uuid(), 0, gen_random_uuid())$q$,
    $q$select public.leave_game(gen_random_uuid())$q$,
    $q$select public.remove_player(gen_random_uuid(), gen_random_uuid())$q$,
    $q$select public.play_again(gen_random_uuid())$q$,
    $q$select public.create_game('x', 'y', true, '[]'::jsonb, now() + interval '1 hour')$q$,
    $q$select public.set_deadline(gen_random_uuid(), now() + interval '1 hour')$q$,
    $q$select public.extend_deadline(gen_random_uuid(), now() + interval '1 hour')$q$
  ] loop
    perform tests.throws(v_stmt, 'not_authenticated', v_stmt);
  end loop;
  -- The public peek needs no subject at all (unknown code: plain game_not_found).
  perform tests.throws($q$select public.peek_game_public('ABCDEFGH')$q$, 'game_not_found', 'peek_game_public without a subject');
  perform tests.is((select count(*) from public.games), 0::bigint, 'no rows visible without a subject');
end
$body$);

select tests.run('s', 'schema invariants: RLS on, select-only policies, explicit service_role table privileges, realtime publication + replica identity, private bucket, definer RPCs with pinned search_path', $body$
declare
  v_bad text;
  v_bucket storage.buckets;
begin
  select string_agg(c.relname, ', ') into v_bad
  from pg_class c
  where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and not c.relrowsecurity;
  perform tests.is(v_bad, null, 'RLS enabled on every public table');

  select string_agg(format('%s.%s(%s)', tablename, policyname, cmd), ', ') into v_bad
  from pg_policies
  where schemaname = 'public' and (cmd <> 'SELECT' or roles <> array['authenticated']::name[]);
  perform tests.is(v_bad, null, 'public policies are SELECT-only for authenticated');

  perform tests.is(
    (select count(*) from pg_policies where schemaname = 'public'), 4::bigint,
    'one policy per client-readable table (square_increments has none)');

  -- The cleanup cron (service_role) needs CRUD on every app table; the
  -- migrations state it instead of relying on Supabase's default privileges.
  select string_agg(t, ', ') into v_bad
  from unnest(array['games', 'players', 'squares', 'media', 'square_increments']) as t
  where not (
    has_table_privilege('service_role', 'public.' || t, 'SELECT')
    and has_table_privilege('service_role', 'public.' || t, 'INSERT')
    and has_table_privilege('service_role', 'public.' || t, 'UPDATE')
    and has_table_privilege('service_role', 'public.' || t, 'DELETE')
  );
  perform tests.is(v_bad, null, 'service_role holds select/insert/update/delete on every app table');
  perform tests.is(
    (select array_agg(c.relname::text order by c.relname) from pg_class c
     where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')),
    array['games', 'media', 'players', 'square_increments', 'squares'], 'the five app tables');

  select string_agg(c.relname, ', ') into v_bad
  from pg_class c
  where c.oid in ('public.games'::regclass, 'public.players'::regclass, 'public.squares'::regclass, 'public.media'::regclass)
    and c.relreplident <> 'f';
  perform tests.is(v_bad, null, 'replica identity full');

  perform tests.is(
    (select array_agg(tablename::text order by tablename) from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public'),
    array['games', 'media', 'players', 'squares'], 'tables in supabase_realtime');

  select * into v_bucket from storage.buckets where id = 'game-media';
  perform tests.is(v_bucket.public, false, 'bucket is private');
  perform tests.is(v_bucket.file_size_limit, 52428800::bigint, 'bucket size limit');
  perform tests.is(v_bucket.allowed_mime_types,
    array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'video/mp4', 'video/quicktime', 'video/webm'],
    'bucket mime types');

  perform tests.is(
    (select array_agg(cmd::text order by cmd) from pg_policies
     where schemaname = 'storage' and tablename = 'objects' and policyname like 'game_media_%'),
    array['DELETE', 'INSERT', 'SELECT'], 'storage policies: select/insert/delete, no update');

  -- Every RPC and helper is SECURITY DEFINER (except pure helpers) and pins search_path.
  select string_agg(p.oid::regprocedure::text, ', ') into v_bad
  from pg_proc p
  where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
    and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
    and not coalesce('search_path=public, pg_temp' = any (p.proconfig), false);
  perform tests.is(v_bad, null, 'search_path pinned on every public/private function');

  select string_agg(p.proname, ', ') into v_bad
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and p.proname in ('create_game', 'join_game', 'peek_game', 'set_ready', 'update_square',
      'set_free_center', 'start_game', 'complete_square', 'increment_square', 'undo_completion',
      'end_game', 'register_media', 'leave_game', 'remove_player', 'auto_end_due_games',
      'peek_game_public', 'play_again', 'set_deadline', 'extend_deadline',
      'is_game_member', 'is_game_host', 'can_upload_game_media')
    and not p.prosecdef;
  perform tests.is(v_bad, null, 'RPCs and membership helpers are SECURITY DEFINER');
end
$body$);
