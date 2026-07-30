-- SPC Days 4-8 extended outlooks. Same table/upsert as Days 1-3; the
-- extended product is probabilistic (15%/30% polygons) so highest_label for
-- those rows carries the probability string instead of a categorical label.
-- spc-poll now fetches day{4..8}prob.lyr.geojson alongside days 1-3.

alter table public.spc_outlooks
  drop constraint if exists spc_outlooks_day_number_check;
alter table public.spc_outlooks
  add constraint spc_outlooks_day_number_check check (day_number between 1 and 8);

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
  if p_day_number not between 1 and 8 then return; end if;

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
