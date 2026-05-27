-- Operator-authored forecasts ("outlooks"). The dashboard is reactive today
-- (NWS warnings + AFD + SPC outlooks come in, we send them out). This table
-- shifts it upstream: the operator draws an area, picks hazards + a time
-- window, writes a discussion (optionally AI-drafted), and saves the record.
-- The "Send to subscribers" path on /forecast hands off to the existing
-- /compose flow — no new Telegram pipeline.
--
-- Phase-1 columns; later phases attach via:
--   ai_draft    — raw model response from lib/ai/forecast-draft.ts
--   verification — jsonb populated by an hourly pg_cron job that scores the
--                  forecast against nws_alerts + nws_storm_reports inside
--                  the area and [valid_from, valid_until] window.
-- See plan: /Users/tylerdixon/.claude/plans/optimized-coalescing-melody.md

create table if not exists public.forecasts (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null default auth.uid()
    references public.operators(user_id) on delete cascade,
  title text not null,
  hazards text[] not null default '{}',                       -- ['tornado','severe','flood','wind','winter','heat']
  confidence text check (confidence in ('low','moderate','high')),
  area geography(MultiPolygon, 4326) not null,
  valid_from timestamptz not null,
  valid_until timestamptz not null,
  discussion text,
  source_refs jsonb not null default '{}'::jsonb,             -- {spc:..., afd:..., alerts:[…], lsrs:[…]}
  ai_draft jsonb,                                              -- raw model response, for audit
  status text not null default 'draft'
    check (status in ('draft','issued','closed','ai_draft')),
  verification jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Cheap invariant: a forecast must have a window > 0 seconds. Without this
  -- the verification cron could score a zero-width interval and the &&
  -- tstzrange overlap test on nws_alerts gets fiddly.
  constraint forecasts_window_chk check (valid_until > valid_from)
);

create index if not exists forecasts_area_gix
  on public.forecasts using gist (area);
create index if not exists forecasts_valid_until_idx
  on public.forecasts (valid_until);
create index if not exists forecasts_operator_created_idx
  on public.forecasts (operator_id, created_at desc);

alter table public.forecasts enable row level security;

-- Mirror every other public.* table: operators see/edit everything, anon and
-- authenticated-non-operator roles see nothing. Multi-operator scoping is
-- intentionally NOT enforced here — operators are a small trusted set; if
-- that ever changes, restrict to operator_id = auth.uid().
create policy "op forecasts_all"
  on public.forecasts for all
  using (public.is_operator())
  with check (public.is_operator());

-- supabase-js can't speak PostGIS geography directly, so this RPC wraps the
-- conversion from GeoJSON jsonb → geography(MultiPolygon, 4326). Same pattern
-- as nws_alerts_upsert in 20260521000001_nws_alerts.sql.
create or replace function public.forecast_create(
  p_title       text,
  p_hazards     text[],
  p_confidence  text,
  p_area        jsonb,
  p_valid_from  timestamptz,
  p_valid_until timestamptz,
  p_discussion  text default null,
  p_source_refs jsonb default '{}'::jsonb,
  p_ai_draft    jsonb default null,
  p_status      text default 'draft'
) returns uuid
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_g geometry;
  v_area geography;
  v_id uuid;
begin
  if not public.is_operator() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_area is null or p_area->>'type' is null then
    raise exception 'area is required';
  end if;

  v_g := st_setsrid(st_geomfromgeojson(p_area::text), 4326);
  if v_g is null then
    raise exception 'invalid GeoJSON area';
  end if;
  if st_geometrytype(v_g) = 'ST_Polygon' then
    v_area := st_multi(v_g)::geography;
  elsif st_geometrytype(v_g) = 'ST_MultiPolygon' then
    v_area := v_g::geography;
  else
    raise exception 'area must be Polygon or MultiPolygon, got %', st_geometrytype(v_g);
  end if;

  insert into public.forecasts (
    title, hazards, confidence, area, valid_from, valid_until,
    discussion, source_refs, ai_draft, status
  ) values (
    p_title, coalesce(p_hazards, '{}'), p_confidence, v_area, p_valid_from, p_valid_until,
    nullif(p_discussion, ''), coalesce(p_source_refs, '{}'::jsonb), p_ai_draft, coalesce(p_status, 'draft')
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.forecast_create(text, text[], text, jsonb, timestamptz, timestamptz, text, jsonb, jsonb, text) from public, anon;
grant execute on function public.forecast_create(text, text[], text, jsonb, timestamptz, timestamptz, text, jsonb, jsonb, text) to authenticated, service_role;

-- Read-side helper: return forecast.area as GeoJSON so the detail page can
-- render the polygon without a second round-trip. Operators only; RLS on the
-- base table still applies because this is security invoker.
create or replace function public.forecast_area_geojson(p_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select st_asgeojson(f.area)::jsonb
  from public.forecasts f
  where f.id = p_id;
$$;

revoke all on function public.forecast_area_geojson(uuid) from public, anon;
grant execute on function public.forecast_area_geojson(uuid) to authenticated, service_role;
