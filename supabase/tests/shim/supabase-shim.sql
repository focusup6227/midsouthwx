-- Minimal stand-ins for the Supabase platform surfaces the migrations touch,
-- so the full migration chain applies to a vanilla Postgres (16+) with only
-- postgis + pgtap installed. Used by scripts/test-db.sh; never deployed.
--
-- Shimmed: roles (anon/authenticated/service_role), auth.users + auth.uid(),
-- storage.buckets/objects, the supabase_realtime publication, and stub
-- cron/net schemas (pg_cron + pg_net aren't installable everywhere; the
-- migrations only register schedules, they never execute the commands).

-- Roles ---------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator nologin;
  end if;
end$$;

grant usage on schema public to anon, authenticated, service_role;

-- auth ----------------------------------------------------------------------
create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key,
  email text,
  created_at timestamptz default now()
);

-- Tests impersonate a user with: set local app.test_uid = '<uuid>';
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('app.test_uid', true), '')::uuid;
$$;

-- storage -------------------------------------------------------------------
create schema if not exists storage;

create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz default now()
);

create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text,
  owner uuid,
  metadata jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
alter table storage.objects enable row level security;
grant all on storage.objects, storage.buckets to service_role;

-- cron (pg_cron stub) ---------------------------------------------------------
create schema if not exists cron;

create table if not exists cron.job (
  jobid bigint generated always as identity primary key,
  jobname text unique,
  schedule text not null,
  command text not null,
  active boolean not null default true
);

create or replace function cron.schedule(job_name text, schedule text, command text)
returns bigint
language plpgsql
as $$
declare
  v_id bigint;
begin
  insert into cron.job (jobname, schedule, command)
  values (job_name, schedule, command)
  on conflict (jobname) do update
    set schedule = excluded.schedule, command = excluded.command
  returning jobid into v_id;
  return v_id;
end$$;

create or replace function cron.schedule(schedule text, command text)
returns bigint
language sql
as $$
  select cron.schedule(md5(command), schedule, command);
$$;

create or replace function cron.unschedule(job_name text)
returns boolean
language sql
as $$
  with del as (delete from cron.job where jobname = job_name returning 1)
  select count(*) > 0 from del;
$$;

-- net (pg_net stub) -----------------------------------------------------------
create schema if not exists net;

create or replace function net.http_post(
  url text,
  headers jsonb default '{}'::jsonb,
  body jsonb default '{}'::jsonb,
  timeout_milliseconds int default 5000
)
returns bigint
language sql
as $$
  select 0::bigint;
$$;

-- realtime ------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end$$;
