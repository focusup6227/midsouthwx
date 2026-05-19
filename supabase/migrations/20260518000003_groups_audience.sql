-- 0003 — custom groups + the shared audience-resolution function

create table public.custom_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  created_at timestamptz default now()
);

create table public.group_memberships (
  group_id uuid references public.custom_groups(id) on delete cascade,
  subscriber_id uuid references public.subscribers(id) on delete cascade,
  added_at timestamptz default now(),
  primary key (group_id, subscriber_id)
);
create index group_memberships_sub_idx on public.group_memberships(subscriber_id);

alter table public.custom_groups enable row level security;
alter table public.group_memberships enable row level security;
create policy "op groups" on public.custom_groups
  for all using (public.is_operator()) with check (public.is_operator());
create policy "op group memberships" on public.group_memberships
  for all using (public.is_operator()) with check (public.is_operator());

-- Single source of truth for "given an audience spec, who actually gets the message?"
-- Called from both the dashboard preview and the server action that fills outbound_queue.
-- audience_spec shape:
--   {"all": true}                                    → all active subscribers
--   {"regions": [uuid,...]}                          → union of region members
--   {"groups":  [uuid,...]}                          → union of group members
--   {"subscribers": [uuid,...]}                      → explicit list
--   Any combination is allowed; result is de-duped (DISTINCT).
create or replace function public.resolve_audience(spec jsonb)
returns table(subscriber_id uuid)
language sql
stable
as $$
  with
    explicit_subs as (
      select (value)::uuid as id
      from jsonb_array_elements_text(coalesce(spec->'subscribers', '[]'::jsonb))
    ),
    region_ids as (
      select (value)::uuid as id
      from jsonb_array_elements_text(coalesce(spec->'regions', '[]'::jsonb))
    ),
    group_ids as (
      select (value)::uuid as id
      from jsonb_array_elements_text(coalesce(spec->'groups', '[]'::jsonb))
    )
  select distinct s.id
  from public.subscribers s
  where s.status = 'active'
    and (
      coalesce((spec->>'all')::boolean, false) = true
      or s.id in (select id from explicit_subs)
      or exists (
        select 1 from public.subscriber_regions sr
        where sr.subscriber_id = s.id and sr.region_id in (select id from region_ids)
      )
      or exists (
        select 1 from public.group_memberships gm
        where gm.subscriber_id = s.id and gm.group_id in (select id from group_ids)
      )
    );
$$;

revoke all on function public.resolve_audience(jsonb) from public, anon;
grant execute on function public.resolve_audience(jsonb) to authenticated, service_role;
