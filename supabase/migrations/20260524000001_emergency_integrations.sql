-- Emergency integration endpoints for outbound webhooks (EMA, CodeRED, county systems, etc.)
-- Read-only ingest can reuse/extend nws_alerts with a source column if needed later.

create table public.integration_endpoints (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  url text not null,
  secret text,                    -- for HMAC signing the payload
  severity_threshold text,        -- e.g. 'Severe' or null for all
  enabled boolean not null default true,
  created_at timestamptz default now()
);

alter table public.integration_endpoints enable row level security;
create policy "op endpoints" on public.integration_endpoints
  for all using (public.is_operator()) with check (public.is_operator());

-- Optional: track external deliveries
create table public.external_delivery_logs (
  id bigserial primary key,
  endpoint_id uuid references public.integration_endpoints(id) on delete set null,
  message_id uuid references public.messages(id) on delete cascade,
  status text,
  response jsonb,
  occurred_at timestamptz default now()
);
alter table public.external_delivery_logs enable row level security;
create policy "op ext logs" on public.external_delivery_logs
  for select using (public.is_operator());
