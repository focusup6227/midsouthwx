-- VTEC-aware dedup for nws_alerts. Parses the alert's first P-VTEC string
-- (raw.properties.parameters.VTEC[0]) into a stable event key
-- "<office>.<phenomenon>.<significance>.<ETN>" and exposes the VTEC action
-- (NEW / CON / EXT / EXA / EXB / UPG / CAN / EXP / COR) plus the CAP
-- messageType so nws-dispatcher can suppress duplicate broadcasts for the
-- same VTEC event and skip cancellations outright.

alter table public.nws_alerts
  add column if not exists vtec_event_key text,
  add column if not exists vtec_action text,
  add column if not exists message_type text;

create or replace function public.parse_vtec_event_key(p_raw jsonb)
returns text
language sql
immutable
as $$
  with v as (
    select trim(both '/' from coalesce(p_raw#>>'{properties,parameters,VTEC,0}', '')) as s
  ),
  parts as (
    select string_to_array(s, '.') as a from v where length(s) > 0
  )
  select case
    when cardinality(a) >= 6 then a[3] || '.' || a[4] || '.' || a[5] || '.' || a[6]
    else null
  end
  from parts;
$$;

create or replace function public.parse_vtec_action(p_raw jsonb)
returns text
language sql
immutable
as $$
  with v as (
    select trim(both '/' from coalesce(p_raw#>>'{properties,parameters,VTEC,0}', '')) as s
  ),
  parts as (
    select string_to_array(s, '.') as a from v where length(s) > 0
  )
  select case when cardinality(a) >= 2 then a[2] else null end
  from parts;
$$;

update public.nws_alerts
set
  vtec_event_key = public.parse_vtec_event_key(raw),
  vtec_action    = public.parse_vtec_action(raw),
  message_type   = nullif(raw#>>'{properties,messageType}', '')
where raw is not null;

-- Lookup index for the dispatcher's "was this VTEC event already dispatched?"
-- check. Partial on status='dispatched' keeps the index tiny.
create index if not exists nws_alerts_vtec_event_key_dispatched_idx
  on public.nws_alerts (vtec_event_key)
  where status = 'dispatched' and vtec_event_key is not null;

-- Replace the upserter to populate the new columns. Body identical to the
-- 20260530000004 version other than the three additional fields and the
-- corresponding columns in the ON CONFLICT update list.
create or replace function public.nws_upsert_geojson_feature(p_feature jsonb)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_nws_id text := coalesce(
    nullif(trim(p_feature#>>'{properties,id}'), ''),
    nullif(trim(p_feature->>'id'), ''),
    nullif(trim(p_feature->'properties'->>'@id'), '')
  );
  v_event text := coalesce(p_feature#>>'{properties,event}', 'Unknown');
  v_geom jsonb := p_feature->'geometry';
  v_poly geography(MultiPolygon, 4326);
  v_g geometry;
  refs text := p_feature#>>'{properties,references}';
  v_status public.nws_status := 'new';
  v_vtec_event_key text := public.parse_vtec_event_key(p_feature);
  v_vtec_action text := public.parse_vtec_action(p_feature);
  v_message_type text := nullif(p_feature#>>'{properties,messageType}', '');
begin
  if coalesce(p_feature#>>'{properties,messageType}', '') = 'Cancel' then
    v_status := 'cancelled';
  end if;

  if v_nws_id is null or length(trim(v_nws_id)) = 0 then
    return;
  end if;

  if v_geom is not null and v_geom != 'null'::jsonb and v_geom->>'type' is not null then
    v_g := st_setsrid(st_geomfromgeojson(v_geom::text), 4326);
    if v_g is null then
      v_poly := null;
    elsif st_geometrytype(v_g) = 'STPolygon' then
      v_poly := st_multi(v_g)::geography;
    elsif st_geometrytype(v_g) = 'STMultiPolygon' then
      v_poly := v_g::geography;
    else
      v_poly := null;
    end if;
  else
    v_poly := null;
  end if;

  insert into public.nws_alerts (
    nws_id,
    event,
    severity,
    certainty,
    urgency,
    headline,
    description,
    instruction,
    area_desc,
    ugc_codes,
    same_codes,
    polygon,
    sent_at,
    effective,
    expires_at,
    status,
    references_ids,
    raw,
    vtec_event_key,
    vtec_action,
    message_type
  )
  values (
    v_nws_id,
    v_event,
    nullif(p_feature#>>'{properties,severity}', ''),
    nullif(p_feature#>>'{properties,certainty}', ''),
    nullif(p_feature#>>'{properties,urgency}', ''),
    nullif(p_feature#>>'{properties,headline}', ''),
    nullif(p_feature#>>'{properties,description}', ''),
    nullif(p_feature#>>'{properties,instruction}', ''),
    nullif(p_feature#>>'{properties,areaDesc}', ''),
    case
      when p_feature#>'{properties,affectedZones}' is not null
      then array(select jsonb_array_elements_text(p_feature#>'{properties,affectedZones}'))
      else null
    end,
    case
      when p_feature#>'{properties,geocode,SAME}' is not null
      then array(select jsonb_array_elements_text(p_feature#>'{properties,geocode,SAME}'))
      else null
    end,
    v_poly,
    (nullif(p_feature#>>'{properties,sent}', ''))::timestamptz,
    (nullif(p_feature#>>'{properties,effective}', ''))::timestamptz,
    (nullif(p_feature#>>'{properties,ends}', ''))::timestamptz,
    v_status,
    case
      when refs is not null and length(trim(refs)) > 0
      then regexp_split_to_array(trim(refs), '\s+')
      else null
    end,
    p_feature,
    v_vtec_event_key,
    v_vtec_action,
    v_message_type
  )
  on conflict (nws_id) do update set
    event = excluded.event,
    severity = excluded.severity,
    certainty = excluded.certainty,
    urgency = excluded.urgency,
    headline = excluded.headline,
    description = excluded.description,
    instruction = excluded.instruction,
    area_desc = excluded.area_desc,
    ugc_codes = excluded.ugc_codes,
    same_codes = excluded.same_codes,
    polygon = excluded.polygon,
    sent_at = excluded.sent_at,
    effective = excluded.effective,
    expires_at = excluded.expires_at,
    references_ids = excluded.references_ids,
    raw = excluded.raw,
    vtec_event_key = excluded.vtec_event_key,
    vtec_action = excluded.vtec_action,
    message_type = excluded.message_type,
    ingested_at = now(),
    status = case
      when nws_alerts.status in ('dispatched', 'skipped', 'superseded')
      then nws_alerts.status
      when excluded.raw#>>'{properties,messageType}' = 'Cancel'
      then 'cancelled'::public.nws_status
      else excluded.status
    end;
end$$;

-- Replace claim function so the dispatcher receives the VTEC fields without
-- a second per-alert SELECT. DROP first: Postgres rejects CREATE OR REPLACE
-- when the return column list changes (42P13).
drop function if exists public.claim_nws_alert_batch(int, text, int);

create or replace function public.claim_nws_alert_batch(
  p_limit int,
  p_locked_by text,
  p_lock_ttl_sec int
)
returns table (
  id uuid,
  nws_id text,
  event text,
  severity text,
  headline text,
  description text,
  instruction text,
  area_desc text,
  expires_at timestamptz,
  raw jsonb,
  message_type text,
  vtec_event_key text,
  vtec_action text
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
    select na.id
    from public.nws_alerts na
    where na.status = 'new'
      and (na.locked_at is null or na.locked_at < v_now - make_interval(secs => p_lock_ttl_sec))
    order by na.ingested_at
    limit p_limit
    for update of na skip locked
  ),
  claimed as (
    update public.nws_alerts na
    set locked_at = v_now,
        locked_by = p_locked_by
    from claimable c
    where na.id = c.id
    returning
      na.id,
      na.nws_id,
      na.event,
      na.severity,
      na.headline,
      na.description,
      na.instruction,
      na.area_desc,
      na.expires_at,
      na.raw,
      na.message_type,
      na.vtec_event_key,
      na.vtec_action
  )
  select * from claimed;
end$$;

revoke all on function public.claim_nws_alert_batch(int, text, int) from public, anon, authenticated;
grant execute on function public.claim_nws_alert_batch(int, text, int) to service_role;

-- "Has any other nws_alerts row for the same VTEC event already been
-- dispatched?" Used by nws-dispatcher to skip CON/EXT/EXA/EXB/COR follow-up
-- CAPs after the operator has already broadcast (or auto-sent) the NEW.
create or replace function public.nws_vtec_event_already_dispatched(
  p_vtec_event_key text,
  p_exclude_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.nws_alerts
    where vtec_event_key = p_vtec_event_key
      and id <> p_exclude_id
      and status = 'dispatched'
  );
$$;

revoke all on function public.nws_vtec_event_already_dispatched(text, uuid) from public, anon, authenticated;
grant execute on function public.nws_vtec_event_already_dispatched(text, uuid) to service_role;
