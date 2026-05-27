-- F7 (SPC convective outlooks): stash the latest Day 1 / Day 2 / Day 3
-- categorical convective outlook from the Storm Prediction Center
-- (https://www.spc.noaa.gov/products/outlook/dayNotlk_cat.lyr.geojson).
-- Each outlook is one GeoJSON FeatureCollection with risk-band polygons —
-- we just keep the whole document per day, replacing on refetch. The /radar
-- map renders the polygons as a toggleable layer so the operator can see
-- "what's expected over the next 0–72h" alongside live radar + warnings.
--
-- One row per day_number (1, 2, 3). Re-fetches overwrite the row; no
-- history kept — SPC's own archive lives at spc.noaa.gov.

create table if not exists public.spc_outlooks (
  day_number smallint primary key check (day_number between 1 and 3),
  geojson jsonb not null,
  feature_count integer not null default 0,
  issued_at timestamptz,
  valid_from timestamptz,
  valid_until timestamptz,
  forecaster text,
  highest_label text,
  fetched_at timestamptz not null default now()
);

alter table public.spc_outlooks enable row level security;

create policy "op spc_outlooks_select"
  on public.spc_outlooks for select
  using (public.is_operator());

-- Order risk bands so we can extract the "highest" present level. SPC uses
-- short labels: TSTM (thunder), MRGL (marginal), SLGT (slight), ENH
-- (enhanced), MDT (moderate), HIGH. The DN integer in feature properties
-- ranks them ascending; we mirror that with a stable function so the radar
-- inspector can headline "Day 1 — highest risk: MDT".
create or replace function public.spc_label_rank(p_label text)
returns integer
language sql
immutable
as $$
  select case upper(coalesce(p_label, ''))
    when 'TSTM' then 1
    when 'MRGL' then 2
    when 'SLGT' then 3
    when 'ENH'  then 4
    when 'MDT'  then 5
    when 'HIGH' then 6
    else 0
  end;
$$;

revoke all on function public.spc_label_rank(text) from public, anon;
grant execute on function public.spc_label_rank(text) to authenticated, service_role;

-- Idempotent upsert called from supabase/functions/spc-poll. The edge fn
-- passes the raw GeoJSON FeatureCollection + day number; we extract the
-- summary fields from the first feature's properties (SPC populates issue/
-- valid/expire identically across all features in an outlook).
create or replace function public.spc_outlooks_upsert(
  p_day_number integer,
  p_geojson jsonb
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_features jsonb := coalesce(p_geojson->'features', '[]'::jsonb);
  v_first jsonb := v_features->0;
  v_props jsonb := coalesce(v_first->'properties', '{}'::jsonb);
  v_highest text;
begin
  if p_day_number not between 1 and 3 then return; end if;

  -- Best label across all features (alphabetical-by-rank fallback to NULL).
  select label into v_highest
  from (
    select coalesce(f->'properties'->>'LABEL', '') as label
    from jsonb_array_elements(v_features) as f
  ) labels
  where label <> ''
  order by public.spc_label_rank(label) desc
  limit 1;

  insert into public.spc_outlooks (
    day_number, geojson, feature_count, issued_at, valid_from, valid_until,
    forecaster, highest_label, fetched_at
  ) values (
    p_day_number,
    p_geojson,
    jsonb_array_length(v_features),
    nullif(v_props->>'ISSUE_ISO', '')::timestamptz,
    nullif(v_props->>'VALID_ISO', '')::timestamptz,
    nullif(v_props->>'EXPIRE_ISO', '')::timestamptz,
    nullif(v_props->>'FORECASTER', ''),
    v_highest,
    now()
  )
  on conflict (day_number) do update set
    geojson       = excluded.geojson,
    feature_count = excluded.feature_count,
    issued_at     = excluded.issued_at,
    valid_from    = excluded.valid_from,
    valid_until   = excluded.valid_until,
    forecaster    = excluded.forecaster,
    highest_label = excluded.highest_label,
    fetched_at    = excluded.fetched_at;
end;
$$;

revoke all on function public.spc_outlooks_upsert(integer, jsonb) from public, anon;
grant execute on function public.spc_outlooks_upsert(integer, jsonb) to service_role;
