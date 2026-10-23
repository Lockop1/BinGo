-- =============================================================================
-- Storage: private bucket `game-media` and its storage.objects policies.
--
-- Object names are '<game_id>/<anything>' (the client uses
-- '<game_id>/<position>/<uuid>.<ext>'). The first folder decides which game
-- an object belongs to; non-uuid folders never match any game.
--
-- Hosted Supabase already gives the API roles their privileges on the storage
-- tables and enables RLS on them; this migration leaves both alone and only
-- adds the bucket row and policies.
-- No UPDATE policy: objects are immutable (so clients must not use upsert).
-- Media is served only through short-lived signed URLs (createSignedUrl),
-- which requires the SELECT policy below, i.e. game membership.
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'game-media',
  'game-media',
  false,
  52428800,
  array[
    'image/jpeg', 'image/png', 'image/webp', 'image/heic',
    'video/mp4', 'video/quicktime', 'video/webm'
  ]
)
on conflict (id) do nothing;

-- True when the caller is a player of the game and the game accepts uploads:
-- status active or ended (including an active game past auto_end_at), and
-- not yet expired.
create function public.can_upload_game_media(game_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.games g
    join public.players p on p.game_id = g.id
    where g.id = can_upload_game_media.game_id
      and p.user_id = auth.uid()
      and g.status in ('active', 'ended')
      and g.expires_at > now()
  );
$$;

revoke all on function public.can_upload_game_media(uuid) from public, anon, authenticated, service_role;
grant execute on function public.can_upload_game_media(uuid) to authenticated;

-- Members of the game may read (and therefore sign URLs for) its objects.
create policy game_media_select_members on storage.objects
  for select to authenticated
  using (
    bucket_id = 'game-media'
    and public.is_game_member(public.safe_uuid((storage.foldername(name))[1]))
  );

-- Members may upload into their own game's folder while uploads are open,
-- and only as themselves (the storage server sets owner/owner_id from the JWT).
create policy game_media_insert_members on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'game-media'
    and coalesce(owner_id, owner::text) = (select auth.uid()::text)
    and public.can_upload_game_media(public.safe_uuid((storage.foldername(name))[1]))
  );

-- The uploader (still a member) or the game's host may delete an object.
create policy game_media_delete_owner_or_host on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'game-media'
    and (
      (
        coalesce(owner_id, owner::text) = (select auth.uid()::text)
        and public.is_game_member(public.safe_uuid((storage.foldername(name))[1]))
      )
      or public.is_game_host(public.safe_uuid((storage.foldername(name))[1]))
    )
  );
