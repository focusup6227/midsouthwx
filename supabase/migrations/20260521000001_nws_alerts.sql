-- v3 NWS: alerts storage, auto rules, dispatcher helpers (scheduled_messages unchanged).

create type public.nws_status as enum (
  'new',
  'dispatched',
  'superseded',
  'cancelled',
  'expired',
  'skipped'
);

create type public.rule_mode as enum ('auto', 'review', 'ignore');

create table public.nws_alerts (
  id uuid primary key default gen_random_uuid(),
  nws_id text not null unique,
  event text not null,
  severity text,
  certainty text,
  urgency text,
  headline text,
  description text,
  instruction text,
  area_desc text,
  ugc_codes text[],
  same_codes text[],
  polygon geography(MultiPolygon, 4326),
  sent_at timestamptz,
  effective timestamptz,
  expires_at timestamptz,
  status public.nws_status not null default 'new',
  references_ids text[],
  raw jsonb,
  ingested_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text
);

create index nws_polygon_gix on public.nws_alerts using gist (polygon)
  where polygon is not null;
create index nws_status_idx on public.nws_alerts (status, ingested_at desc);
create index nws_new_idx on public.nws_alerts (ingested_at)
  where status = 'new';

create table public.auto_alert_rules (
  id uuid primary key default gen_random_uuid(),
  event_pattern text not null,
  min_severity text,
  mode public.rule_mode not null default 'review',
  region_filter jsonb,
  template_id uuid references public.templates(id) on delete set null,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.messages
  add constraint messages_nws_alert_fk
  foreign key (nws_alert_id) references public.nws_alerts(id) on delete set null;

alter table public.nws_alerts enable row level security;
alter table public.auto_alert_rules enable row level security;

create policy "op nws_alerts_select"
  on public.nws_alerts for select
  using (public.is_operator());

create policy "op auto_alert_rules_all"
  on public.auto_alert_rules for all
  using (public.is_operator())
  with check (public.is_operator());

--- Upsert one GeoJSON Feature (jsonb) from api.weather.gov; sets status new on insert.
create or replace function public.nws_upsert_geojson_feature(p_feature jsonb)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_nws_id text := coalesce(
    p_feature#>>'{properties,id}',
    p_feature->'properties'->>'@id'
  );
  v_event text := coalesce(p_feature#>>'{properties,event}', 'Unknown');
  v_geom jsonb := p_feature->'geometry';
  v_poly geography(MultiPolygon, 4326);
  v_g geometry;
  refs text := p_feature#>>'{properties,references}';
  v_status public.nws_status := 'new';
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
      -- Point/Line etc.: no polygon matching
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
    raw
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
    p_feature
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
    ingested_at = now(),
    status = case
      when nws_alerts.status in ('dispatched', 'skipped', 'superseded')
      then nws_alerts.status
      when excluded.raw#>>'{properties,messageType}' = 'Cancel'
      then 'cancelled'::public.nws_status
      else excluded.status
    end;
end$$;

revoke all on function public.nws_upsert_geojson_feature(jsonb) from public;
revoke all on function public.nws_upsert_geojson_feature(jsonb) from anon, authenticated;
grant execute on function public.nws_upsert_geojson_feature(jsonb) to service_role;

--- Mark referenced alert URLs as superseded (match tail id or full nws_id).
create or replace function public.nws_mark_references_superseded(p_reference_urls text[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  u text;
  tail text;
begin
  if p_reference_urls is null then
    return;
  end if;
  foreach u in array p_reference_urls
  loop
    if u is null or length(trim(u)) = 0 then
      continue;
    end if;
    tail := (regexp_match(trim(u), '([^/]+)$'))[1];
    update public.nws_alerts na
    set status = 'superseded'
    where na.nws_id = trim(u)
       or na.nws_id = tail
       or na.nws_id like '%' || tail;
  end loop;
end$$;

revoke all on function public.nws_mark_references_superseded(text[]) from public;
revoke all on function public.nws_mark_references_superseded(text[]) from anon, authenticated;
grant execute on function public.nws_mark_references_superseded(text[]) to service_role;

--- PLANNED §6: polygon intersection OR (no polygon) SAME + UGC via regions; optional region_filter.
create or replace function public.nws_alert_audience(
  p_alert_id uuid,
  p_region_filter jsonb default null
)
returns table (subscriber_id uuid)
language sql
stable
security definer
set search_path = public, extensions
as $$
  with a as (
    select *
    from public.nws_alerts
    where id = p_alert_id
  ),
  region_ids as (
    select r::uuid as id
    from jsonb_array_elements_text(coalesce(p_region_filter->'region_ids', '[]'::jsonb)) as r
    where coalesce(jsonb_array_length(coalesce(p_region_filter->'region_ids', '[]'::jsonb)), 0) > 0
  ),
  geo_matched as (
    select distinct s.id as sid
    from public.subscribers s
    cross join a
    where s.status = 'active'
      and (
        (a.polygon is not null and s.location is not null and st_intersects(s.location, a.polygon))
        or (
          a.polygon is null
          and (
            (
              a.same_codes is not null
              and cardinality(a.same_codes) > 0
              and s.county_fips is not null
              and (
                s.county_fips = any(a.same_codes)
                or exists (
                  select 1 from unnest(a.same_codes) as scode
                  where right(regexp_replace(scode, '[^0-9]', '', 'g'), 5) = s.county_fips
                     or regexp_replace(scode, '[^0-9]', '', 'g') = replace(s.county_fips, ' ', '')
                )
              )
            )
            or (
              a.ugc_codes is not null
              and cardinality(a.ugc_codes) > 0
              and exists (
                select 1
                from public.subscriber_regions sr
                join public.regions reg on reg.id = sr.region_id
                where sr.subscriber_id = s.id
                  and reg.ugc_code is not null
                  and exists (
                    select 1 from unnest(a.ugc_codes) as zone_url
                    where reg.ugc_code = zone_url
                       or zone_url like '%/' || reg.ugc_code
                  )
              )
            )
          )
        )
      )
  ),
  filtered as (
    select g.sid
    from geo_matched g
    where not exists (select 1 from region_ids limit 1)
       or exists (
         select 1
         from public.subscriber_regions sr
         join region_ids ri on sr.region_id = ri.id
         where sr.subscriber_id = g.sid
       )
  )
  select f.sid as subscriber_id from filtered f;
$$;

revoke all on function public.nws_alert_audience(uuid, jsonb) from public;
revoke all on function public.nws_alert_audience(uuid, jsonb) from anon, authenticated;
grant execute on function public.nws_alert_audience(uuid, jsonb) to service_role;

--- Atomically claim alerts pending dispatch (status = new).
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
  raw jsonb
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
      na.raw
  )
  select * from claimed;
end$$;

revoke all on function public.claim_nws_alert_batch(int, text, int) from public;
revoke all on function public.claim_nws_alert_batch(int, text, int) from anon, authenticated;
grant execute on function public.claim_nws_alert_batch(int, text, int) to service_role;

create or replace function public.nws_finish_dispatch(
  p_alert_id uuid,
  p_status public.nws_status
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.nws_alerts
  set status = p_status,
      locked_at = null,
      locked_by = null
  where id = p_alert_id;
end$$;

revoke all on function public.nws_finish_dispatch(uuid, public.nws_status) from public;
revoke all on function public.nws_finish_dispatch(uuid, public.nws_status) from anon, authenticated;
grant execute on function public.nws_finish_dispatch(uuid, public.nws_status) to service_role;
