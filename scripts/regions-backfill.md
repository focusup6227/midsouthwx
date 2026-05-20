# Regions backfill (Mid-South)

Subscribers route by polygon intersection (`subscribers.location`), county FIPS (`subscribers.county_fips`), and UGC zones linked via `subscriber_regions` → `regions`. For NWS alerts that carry polygon geometry, overlap matching works without regions. For SAME / forecast-zone codes in alert payloads, `regions` rows must exist with matching `ugc_code` (suffix form like `TNZ088`) or county rows with `kind = 'county'` and `county_fips`.

## Operational notes

- After inserting `regions`, triggers refresh `subscriber_regions` for affected subscribers (`private.refresh_subscriber_regions`).
- Prefer authoritative geometries from Census TIGER / ZCTA or NWS forecast zone GeoJSON where available.

## Suggested sources

- **County boundaries**: US Census cartographic boundary or TIGER/Line; join `STATEFP||COUNTYFP` → 5-digit `county_fips`.
- **NWS forecast zones**: API lists such as `https://api.weather.gov/zones/forecast` (paginated); geometry + `UGC` code.

## Minimal SQL shape

```sql
-- Example: county row (geometry must be valid for geography cast)
insert into public.regions (name, kind, county_fips, ugc_code, geometry)
values (
  'Shelby County TN',
  'county',
  '47157',
  null,
  ST_Multi(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($county_geojson), 4326)))::geography
);

-- Example: forecast zone (UGC suffix only in ugc_code column)
insert into public.regions (name, kind, county_fips, ugc_code, geometry)
values (
  'Memphis TN',
  'forecast',
  null,
  'TNZ088',
  ST_Multi(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($zone_geojson), 4326)))::geography
);
```

Replace `$county_geojson` / `$zone_geojson` with actual GeoJSON strings from your import pipeline.

## Workflow

1. Pick target counties / zones for Mid-South coverage.
2. Fetch geometries once; store in version control as GeoJSON if small enough, or run a one-off Node/Python script that POSTs to Supabase with service role (not committed).
3. Load via `INSERT ... ON CONFLICT` if you add a unique key; otherwise delete duplicates manually before production traffic.
