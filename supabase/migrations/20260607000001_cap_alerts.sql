-- LibreWxR CAP alerts: parallel ingestion alongside nws_alerts.
--
-- LibreWxR proxies NWS for US locations + adds global WMO CAP coverage. Its
-- payload shape differs enough from api.weather.gov that we store it in its
-- own table:
--   - no structured `event` (we regex-parse from `title`)
--   - no urgency / certainty
--   - `regions` is freeform text (not UGC zone codes)
--   - `uri` plays the role of `nws_id` for dedup
--
-- Lifecycle is identical to nws_alerts (new -> dispatched -> ...) so we reuse
-- the existing `public.nws_status` enum.

create table public.cap_alerts (
  id uuid primary key default gen_random_uuid(),
  uri text not null unique,
  title text,
  parsed_event text,
  severity text,
  description text,
  regions text,
  polygon geography(MultiPolygon, 4326),
  sent_at timestamptz,
  expires_at timestamptz,
  status public.nws_status not null default 'new',
  raw jsonb,
  ingested_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text
);

create index cap_polygon_gix on public.cap_alerts using gist (polygon)
  where polygon is not null;
create index cap_status_idx on public.cap_alerts (status, ingested_at desc);
create index cap_new_idx on public.cap_alerts (ingested_at)
  where status = 'new';

alter table public.cap_alerts enable row level security;

create policy "op cap_alerts_select"
  on public.cap_alerts for select
  using (public.is_operator());

-- Upsert one LibreWxR alert Feature into cap_alerts. Mirrors
-- nws_upsert_geojson_feature but adapted for LibreWxR's CAP shape.
create or replace function public.cap_upsert_feature(p_feature jsonb)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_uri text := nullif(trim(p_feature#>>'{properties,uri}'), '');
  v_title text := nullif(trim(p_feature#>>'{properties,title}'), '');
  v_severity text := nullif(trim(p_feature#>>'{properties,severity}'), '');
  v_description text := nullif(p_feature#>>'{properties,description}', '');
  v_regions text;
  v_time_epoch numeric := nullif(p_feature#>>'{properties,time}', '')::numeric;
  v_expires_epoch numeric := nullif(p_feature#>>'{properties,expires}', '')::numeric;
  v_sent timestamptz := case when v_time_epoch is not null then to_timestamp(v_time_epoch) else null end;
  v_expires timestamptz := case when v_expires_epoch is not null then to_timestamp(v_expires_epoch) else null end;
  v_parsed_event text;
  v_geom jsonb := p_feature->'geometry';
  v_g geometry;
  v_poly geography(MultiPolygon, 4326);
begin
  if v_uri is null then return; end if;

  -- LibreWxR `regions` is a JSON array of comma-separated region strings.
  -- Flatten to a single delimited string for easy display + searching.
  if jsonb_typeof(p_feature#>'{properties,regions}') = 'array' then
    select string_agg(value, ' | ') into v_regions
    from jsonb_array_elements_text(p_feature#>'{properties,regions}') as t(value);
  else
    v_regions := nullif(p_feature#>>'{properties,regions}', '');
  end if;

  -- Title format: "<Event Name> issued <time> until <time> by <office>"
  -- Extract the event name so auto_alert_rules (which match on event text)
  -- can still apply. Falls back to first 64 chars of title.
  v_parsed_event := substring(v_title from '^(.+?)\s+(?:issued|in effect|for|until|expires)');
  if v_parsed_event is null or length(trim(v_parsed_event)) = 0 then
    v_parsed_event := nullif(left(coalesce(v_title, ''), 64), '');
  end if;

  if v_geom is not null and v_geom != 'null'::jsonb and v_geom->>'type' is not null then
    v_g := st_setsrid(st_geomfromgeojson(v_geom::text), 4326);
    if v_g is null then
      v_poly := null;
    elsif st_geometrytype(v_g) = 'ST_Polygon' then
      v_poly := st_multi(v_g)::geography;
    elsif st_geometrytype(v_g) = 'ST_MultiPolygon' then
      v_poly := v_g::geography;
    else
      v_poly := null;
    end if;
  end if;

  insert into public.cap_alerts (
    uri, title, parsed_event, severity, description, regions,
    polygon, sent_at, expires_at, raw
  )
  values (
    v_uri, v_title, v_parsed_event, v_severity, v_description, v_regions,
    v_poly, v_sent, v_expires, p_feature
  )
  on conflict (uri) do update set
    title = excluded.title,
    parsed_event = excluded.parsed_event,
    severity = excluded.severity,
    description = excluded.description,
    regions = excluded.regions,
    polygon = excluded.polygon,
    sent_at = excluded.sent_at,
    expires_at = excluded.expires_at,
    raw = excluded.raw,
    ingested_at = now(),
    -- Preserve terminal statuses on re-poll; otherwise let the row stay new.
    status = case
      when cap_alerts.status in ('dispatched', 'skipped', 'superseded') then cap_alerts.status
      else excluded.status
    end;
end$$;

revoke all on function public.cap_upsert_feature(jsonb) from public;
revoke all on function public.cap_upsert_feature(jsonb) from anon, authenticated;
grant execute on function public.cap_upsert_feature(jsonb) to service_role;
