// NWP / forecast model overlay catalog. Source priority is "what actually
// works via a public CORS-enabled WMS today" — see Phase 3 research notes:
//
//   - HRRR Composite Reflectivity → IEM (raw HRRR output)
//   - NDFD Temperature, Wind → nowCOAST (NWS-blended, derived from HRRR/NAM/GFS)
//   - WPC QPF → mapservices.weather.noaa.gov (forecaster-blended precip)
//
// Raw NAM / GFS / GEFS aren't accessible via public WMS — they'd need
// server-side GRIB2 rendering. They're surfaced in the UI as `disabled: true`
// so the operator knows the gap.

export type ModelOverlayKey =
  | 'hrrr_refc'
  | 'ndfd_temp'
  | 'ndfd_wind'
  | 'ndfd_wind_gust'
  | 'ndfd_dewpoint'
  | 'ndfd_rh'
  | 'ndfd_sky'
  | 'wpc_qpf';

export type ModelOverlayMeta = {
  id: ModelOverlayKey;
  label: string;     // long form, used in inspector
  short: string;     // short form, used on buttons
  source: string;    // "HRRR (IEM)", "NDFD (nowCOAST)", "WPC (NOAA)"
  attribution: string;
  // Forecast hour range. End is inclusive. step is in hours.
  hours: { min: number; max: number; step: number; default: number };
  // Build a Mapbox raster tile URL template for the given forecast hour.
  // Each provider has a different scheme:
  //   - IEM HRRR: per-fhour layer name "refd_HHMM" (minutes, 15-min steps)
  //   - nowCOAST: TIME=ISO dimension on a fixed layer
  //   - WPC QPF:  numeric layer id maps to accumulation window
  tileUrl: (hour: number) => string;
  // Label shown above the time stepper.
  hourLabel: (hour: number) => string;
  // Static palette legend for the inspector (text labels, no swatches).
  legend: string;
};

export type DisabledModel = {
  id: string;
  label: string;
  why: string;
};

export const DISABLED_MODELS: DisabledModel[] = [
  { id: 'nam',  label: 'NAM',  why: 'Public WMS unavailable — needs renderer service to ingest GRIB2.' },
  { id: 'gfs',  label: 'GFS',  why: 'Public WMS unavailable — needs renderer service to ingest GRIB2.' },
  { id: 'gefs', label: 'GEFS', why: 'Ensemble plumes require vector rendering — not raster WMS.' },
];

// IEM HRRR: layers refd_0000..refd_1080 (forecast minutes, 15-min increments).
// Latest available run is published ~HH+50min. Cadence 15min.
function iemHrrrUrl(forecastHour: number): string {
  const minutes = String(Math.max(0, Math.min(1080, Math.round(forecastHour * 60)))).padStart(4, '0');
  const layer = `refd_${minutes}`;
  return (
    'https://mesonet.agron.iastate.edu/cgi-bin/wms/hrrr/refd.cgi'
    + '?service=WMS&version=1.1.1&request=GetMap'
    + `&layers=${layer}&styles=`
    + '&format=image/png&transparent=true'
    + '&srs=EPSG:3857&bbox={bbox-epsg-3857}&width=512&height=512'
  );
}

// nowCOAST NDFD: TIME dimension is forecast valid time.
// We compute valid time = now (rounded down to top of hour) + forecastHour.
function nowcoastNdfdUrl(layer: string, forecastHour: number): string {
  // Round to the most recent past hour so requests align to the published
  // grid; the WMS interpolates internally if needed.
  const t = new Date();
  t.setMinutes(0, 0, 0);
  t.setHours(t.getHours() + forecastHour);
  const iso = t.toISOString().replace(/\.\d{3}Z$/, 'Z');
  return (
    `https://nowcoast.noaa.gov/geoserver/${layer.split('/')[0]}/wms`
    + '?service=WMS&version=1.3.0&request=GetMap'
    + `&layers=${layer.split('/')[1]}&styles=`
    + '&format=image/png&transparent=true'
    + `&time=${encodeURIComponent(iso)}`
    + '&crs=EPSG:3857&bbox={bbox-epsg-3857}&width=512&height=512'
  );
}

// WPC QPF: ArcGIS MapServer WMS bridge. Layer IDs encode the accumulation
// window. We expose just the 6-hour-window steps:
//   1 = 00-06h, 2 = 06-12h, 3 = 12-18h, ... 12 = 66-72h.
function wpcQpfUrl(forecastHour: number): string {
  // forecastHour selects the START of a 6h window. Clamp to 0..66.
  const start = Math.max(0, Math.min(66, Math.round(forecastHour / 6) * 6));
  const layerId = String(start / 6 + 1);
  return (
    'https://mapservices.weather.noaa.gov/vector/services/precip/wpc_qpf/MapServer/WMSServer'
    + '?service=WMS&version=1.3.0&request=GetMap'
    + `&layers=${layerId}&styles=`
    + '&format=image/png&transparent=true'
    + '&crs=EPSG:3857&bbox={bbox-epsg-3857}&width=512&height=512'
  );
}

export const MODEL_OVERLAYS: Record<ModelOverlayKey, ModelOverlayMeta> = {
  hrrr_refc: {
    id: 'hrrr_refc',
    label: 'HRRR · Composite Reflectivity',
    short: 'HRRR REFC',
    source: 'HRRR via IEM',
    attribution: '© Iowa State Mesonet / NOAA HRRR',
    hours: { min: 0, max: 18, step: 1, default: 1 },
    tileUrl: iemHrrrUrl,
    hourLabel: (h) => `F+${h.toString().padStart(2, '0')}h`,
    legend: 'dBZ: 5 · 20 · 35 · 50 · 65 (HRRR run, latest)',
  },
  ndfd_temp: {
    id: 'ndfd_temp',
    label: 'NDFD · 2 m Temperature',
    short: 'NDFD TEMP',
    source: 'NDFD via nowCOAST',
    attribution: '© NWS NDFD',
    hours: { min: 0, max: 168, step: 3, default: 12 },
    tileUrl: (h) => nowcoastNdfdUrl('ndfd_temperature/conus_air_temperature', h),
    hourLabel: (h) => `valid +${h}h`,
    legend: 'NDFD blended (HRRR/NAM/GFS) · Kelvin shaded',
  },
  ndfd_wind: {
    id: 'ndfd_wind',
    label: 'NDFD · 10 m Wind',
    short: 'NDFD WIND',
    source: 'NDFD via nowCOAST',
    attribution: '© NWS NDFD',
    hours: { min: 0, max: 168, step: 3, default: 12 },
    tileUrl: (h) => nowcoastNdfdUrl('ndfd_wind/conus_wind_speed', h),
    hourLabel: (h) => `valid +${h}h`,
    legend: 'NDFD blended · knots shaded',
  },
  // Forecast wind gust (NDFD). Operationally useful for HWO / wind-advisory
  // decisions where sustained wind alone undershoots the threat.
  ndfd_wind_gust: {
    id: 'ndfd_wind_gust',
    label: 'NDFD · Wind Gust',
    short: 'NDFD GUST',
    source: 'NDFD via nowCOAST',
    attribution: '© NWS NDFD',
    hours: { min: 0, max: 168, step: 3, default: 12 },
    tileUrl: (h) => nowcoastNdfdUrl('ndfd_wind/conus_wind_gust', h),
    hourLabel: (h) => `valid +${h}h`,
    legend: 'NDFD blended · gust kt shaded',
  },
  ndfd_dewpoint: {
    id: 'ndfd_dewpoint',
    label: 'NDFD · 2 m Dewpoint',
    short: 'NDFD Td',
    source: 'NDFD via nowCOAST',
    attribution: '© NWS NDFD',
    hours: { min: 0, max: 168, step: 3, default: 6 },
    tileUrl: (h) => nowcoastNdfdUrl('ndfd_moisture/conus_dewpoint_temperature', h),
    hourLabel: (h) => `valid +${h}h`,
    legend: 'NDFD blended · °F-shaded moisture',
  },
  ndfd_rh: {
    id: 'ndfd_rh',
    label: 'NDFD · Relative Humidity',
    short: 'NDFD RH',
    source: 'NDFD via nowCOAST',
    attribution: '© NWS NDFD',
    hours: { min: 0, max: 168, step: 3, default: 6 },
    tileUrl: (h) => nowcoastNdfdUrl('ndfd_moisture/conus_relative_humidity', h),
    hourLabel: (h) => `valid +${h}h`,
    legend: 'NDFD blended · %',
  },
  ndfd_sky: {
    id: 'ndfd_sky',
    label: 'NDFD · Sky Cover',
    short: 'NDFD SKY',
    source: 'NDFD via nowCOAST',
    attribution: '© NWS NDFD',
    hours: { min: 0, max: 168, step: 3, default: 6 },
    tileUrl: (h) => nowcoastNdfdUrl('ndfd_sky/conus_total_sky_cover', h),
    hourLabel: (h) => `valid +${h}h`,
    legend: 'NDFD blended · % cloud cover',
  },
  wpc_qpf: {
    id: 'wpc_qpf',
    label: 'WPC · QPF (6-hr accum)',
    short: 'WPC QPF',
    source: 'WPC via NOAA MapServer',
    attribution: '© NWS WPC',
    hours: { min: 0, max: 66, step: 6, default: 6 },
    tileUrl: wpcQpfUrl,
    hourLabel: (h) => `${h}-${h + 6}h accum`,
    legend: 'inches, 6-hour window',
  },
};
