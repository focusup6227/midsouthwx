-- Area Forecast Discussion storage. One row per published AFD product. Pulled
-- per WFO by the afd-poll edge function (every 30 min, after each WFO's typical
-- ~4×/day update schedule). Only operators can read; ingestion runs as
-- service_role and bypasses RLS.

create table public.nws_afd (
  id           uuid primary key default gen_random_uuid(),
  wfo          text not null,
  product_id   text not null unique,
  issued_at    timestamptz not null,
  text         text not null,
  synopsis     text,
  short_term   text,
  long_term    text,
  aviation     text,
  raw          jsonb,
  fetched_at   timestamptz not null default now()
);

create index nws_afd_wfo_issued_idx on public.nws_afd (wfo, issued_at desc);
create index nws_afd_issued_idx     on public.nws_afd (issued_at desc);

alter table public.nws_afd enable row level security;

create policy "op nws_afd_select"
  on public.nws_afd for select
  using (public.is_operator());

-- Upsert helper for the edge function. Keyed on product_id (NWS guarantees
-- uniqueness). Returns the inserted/updated id.
create or replace function public.nws_afd_upsert(
  p_wfo        text,
  p_product_id text,
  p_issued_at  timestamptz,
  p_text       text,
  p_synopsis   text,
  p_short_term text,
  p_long_term  text,
  p_aviation   text,
  p_raw        jsonb
) returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_id uuid;
begin
  insert into public.nws_afd (
    wfo, product_id, issued_at, text, synopsis, short_term, long_term, aviation, raw
  ) values (
    p_wfo, p_product_id, p_issued_at, p_text, p_synopsis, p_short_term, p_long_term, p_aviation, p_raw
  )
  on conflict (product_id) do update set
    text        = excluded.text,
    synopsis    = excluded.synopsis,
    short_term  = excluded.short_term,
    long_term   = excluded.long_term,
    aviation    = excluded.aviation,
    raw         = excluded.raw,
    fetched_at  = now()
  returning id into v_id;
  return v_id;
end$$;

revoke all on function public.nws_afd_upsert(text, text, timestamptz, text, text, text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.nws_afd_upsert(text, text, timestamptz, text, text, text, text, text, jsonb)
  to service_role;

-- Weekly prune of AFDs older than 30d. AFDs are reference text — operator only
-- ever needs the most recent few per WFO. Keeps the table small.
select cron.schedule(
  'nws-afd-prune',
  '15 4 * * *',
  $$ delete from public.nws_afd where issued_at < now() - interval '30 days'; $$
);
