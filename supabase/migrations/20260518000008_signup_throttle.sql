-- 0008 — per-IP signup throttle. Replaces Turnstile.

create table public.signup_attempts (
  id bigserial primary key,
  ip text not null,
  created_at timestamptz default now()
);
create index signup_attempts_ip_idx on public.signup_attempts (ip, created_at desc);

alter table public.signup_attempts enable row level security;
-- No policies: only service_role (Edge Function) ever touches this.

-- Atomic "may this IP sign up right now?" — inserts the attempt and returns
-- whether the caller is over the limit. Cap: 5 attempts per IP per hour.
create or replace function public.try_signup_attempt(p_ip text, p_max int default 5)
returns table(allowed boolean, recent_count int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  insert into public.signup_attempts (ip) values (p_ip);
  select count(*) into v_count
  from public.signup_attempts
  where ip = p_ip
    and created_at > now() - interval '1 hour';
  return query select (v_count <= p_max) as allowed, v_count as recent_count;
end$$;

revoke all on function public.try_signup_attempt(text, int) from public, anon, authenticated;
grant execute on function public.try_signup_attempt(text, int) to service_role;

-- Daily cleanup so the table doesn't grow forever.
select cron.schedule(
  'signup-attempts-prune',
  '17 4 * * *',
  $$ delete from public.signup_attempts where created_at < now() - interval '7 days'; $$
);
