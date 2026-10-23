-- =============================================================================
-- LOCAL-ONLY SHIM. Emulates the parts of a hosted Supabase project that the
-- migrations and SQL tests rely on, so they can run against a plain Postgres
-- 16 cluster (no Docker). NEVER apply this to a real Supabase project.
--
-- Apply order for a fresh local database:
--   1. (optional) GoTrue's own migrations, if running the local auth server
--   2. this file (idempotent; auth.users is created only if absent)
--   3. supabase/migrations/*.sql in filename order
-- =============================================================================

-- Roles -----------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator login noinherit password 'postgres';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    create role supabase_auth_admin login noinherit createrole password 'postgres';
  end if;
end
$$;

grant anon, authenticated, service_role to authenticator;
grant anon, authenticated, service_role to postgres;

create extension if not exists pgcrypto;
create schema if not exists extensions;

-- Supabase default privileges on public: everything is granted to the API
-- roles unless a migration revokes it. Emulating this is what makes the
-- "explicit GRANTs matching RLS verbs" rule testable.
grant usage on schema public to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;

-- auth schema -----------------------------------------------------------------
create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

-- Minimal auth.users. If GoTrue's migrations already created the real table
-- this is a no-op.
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  aud text,
  role text,
  email text,
  is_anonymous boolean not null default false,
  raw_app_meta_data jsonb,
  raw_user_meta_data jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create or replace function auth.jwt() returns jsonb
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;

create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(
    coalesce(
      current_setting('request.jwt.claim.sub', true),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    ),
    ''
  )::uuid
$$;

create or replace function auth.role() returns text
language sql stable as $$
  select nullif(
    coalesce(
      current_setting('request.jwt.claim.role', true),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
    ),
    ''
  )::text
$$;

grant execute on function auth.uid(), auth.jwt(), auth.role() to anon, authenticated, service_role;

-- storage schema stub ---------------------------------------------------------
create schema if not exists storage;
grant usage on schema storage to anon, authenticated, service_role;

create table if not exists storage.buckets (
  id text primary key,
  name text not null unique,
  owner uuid,
  owner_id text,
  public boolean default false,
  avif_autodetection boolean default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text,
  owner uuid,
  owner_id text,
  metadata jsonb,
  user_metadata jsonb,
  version text,
  path_tokens text[] generated always as (string_to_array(name, '/')) stored,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  last_accessed_at timestamptz default now()
);

alter table storage.buckets enable row level security;
alter table storage.objects enable row level security;

-- Hosted Supabase grants all on storage tables to the API roles; RLS governs.
grant all on storage.buckets, storage.objects to anon, authenticated, service_role;

create or replace function storage.foldername(name text) returns text[]
language plpgsql immutable as $$
declare _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return _parts[1 : array_length(_parts, 1) - 1];
end
$$;

create or replace function storage.filename(name text) returns text
language plpgsql immutable as $$
declare _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return _parts[array_length(_parts, 1)];
end
$$;

create or replace function storage.extension(name text) returns text
language plpgsql immutable as $$
declare _parts text[]; _filename text;
begin
  select string_to_array(name, '/') into _parts;
  select _parts[array_length(_parts, 1)] into _filename;
  return reverse(split_part(reverse(_filename), '.', 1));
end
$$;

grant execute on function storage.foldername(text), storage.filename(text), storage.extension(text)
  to anon, authenticated, service_role;

-- realtime publication --------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end
$$;
