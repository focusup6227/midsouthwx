-- v2 scheduling: scheduled_messages + worker RPCs (no NWS tables).

create type public.schedule_status as enum ('pending', 'sent', 'cancelled', 'skipped', 'failed');

create table public.scheduled_messages (
  id uuid primary key default gen_random_uuid(),
  body_md text not null,
  audience_spec jsonb not null,
  scheduled_for timestamptz not null,
  rrule text,
  next_run_at timestamptz,
  send_window_minutes int not null default 15,
  status public.schedule_status not null default 'pending',
  template_id uuid references public.templates(id) on delete set null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  dispatch_attempts int not null default 0
);

create index sched_due_idx on public.scheduled_messages (next_run_at)
  where status = 'pending';

alter table public.scheduled_messages enable row level security;

create policy "op sched"
  on public.scheduled_messages
  for all
  using (public.is_operator())
  with check (public.is_operator());

--- Keep next_run_at aligned with scheduled_for on insert / material edits.
create or replace function private.scheduled_messages_default_next_run()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    if new.status = 'pending' and new.next_run_at is null then
      new.next_run_at := new.scheduled_for;
    end if;
  elsif tg_op = 'UPDATE' then
    if new.status = 'pending'
       and (
         new.scheduled_for is distinct from old.scheduled_for
         or new.rrule is distinct from old.rrule
       ) then
      new.next_run_at := new.scheduled_for;
      new.dispatch_attempts := 0;
      new.last_error := null;
    end if;
  end if;
  return new;
end$$;

create trigger scheduled_messages_next_run
before insert or update on public.scheduled_messages
for each row execute function private.scheduled_messages_default_next_run();

--- Atomically claim due schedules (service_role / Edge Functions).
create or replace function public.claim_scheduled_batch(
  p_limit int,
  p_locked_by text,
  p_lock_ttl_sec int
)
returns table (
  id uuid,
  body_md text,
  audience_spec jsonb,
  scheduled_for timestamptz,
  rrule text,
  template_id uuid,
  created_by uuid,
  send_window_minutes int,
  dispatch_attempts int,
  next_run_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
begin
  return query
  with claimable as (
    select sm.id
    from public.scheduled_messages sm
    where sm.status = 'pending'
      and sm.next_run_at <= v_now
      and (sm.locked_at is null or sm.locked_at < v_now - make_interval(secs => p_lock_ttl_sec))
    order by sm.next_run_at
    limit p_limit
    for update of sm skip locked
  ),
  claimed as (
    update public.scheduled_messages sm
    set locked_at = v_now,
        locked_by = p_locked_by
    from claimable c
    where sm.id = c.id
    returning
      sm.id,
      sm.body_md,
      sm.audience_spec,
      sm.scheduled_for,
      sm.rrule,
      sm.template_id,
      sm.created_by,
      sm.send_window_minutes,
      sm.dispatch_attempts,
      sm.next_run_at
  )
  select * from claimed;
end$$;

revoke all on function public.claim_scheduled_batch(int, text, int) from public;
revoke all on function public.claim_scheduled_batch(int, text, int) from anon, authenticated;
grant execute on function public.claim_scheduled_batch(int, text, int) to service_role;

--- Same as enqueue_message but callable by service_role (Edge dispatcher / future NWS worker).
create or replace function public.enqueue_message_system(p_message_id uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_spec jsonb;
  v_count int;
begin
  select audience_spec into v_spec from public.messages where id = p_message_id;
  if v_spec is null then
    raise exception 'message not found';
  end if;

  insert into public.outbound_queue (message_id, subscriber_id)
  select p_message_id, ra.subscriber_id
  from public.resolve_audience(v_spec) ra
  on conflict (message_id, subscriber_id) do nothing;

  select count(*)::int into v_count
  from public.outbound_queue
  where message_id = p_message_id;

  update public.messages
  set status = 'queued',
      recipient_count = v_count
  where id = p_message_id;

  return v_count;
end$$;

revoke all on function public.enqueue_message_system(uuid) from public;
revoke all on function public.enqueue_message_system(uuid) from anon, authenticated;
grant execute on function public.enqueue_message_system(uuid) to service_role;
