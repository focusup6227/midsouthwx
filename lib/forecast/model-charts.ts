// UI catalog for the Models data viewer. Mirrors the server catalog in
// _renderer/model_render.py (MODELS / FIELDS / REGIONS) so the select menus and
// the forecast-hour slider render without a round-trip to the (possibly cold)
// renderer. Keep this in sync with model_render.py if fields/models change.

export type ModelFieldDef = {
  key: string;
  label: string;
  unit: string;
  group: string; // UI grouping: Surface / Upper air / Convective / Moisture & precip
  min_fhr: number; // some fields (precip accum) are undefined at F000
};

export const FIELD_GROUPS = ['Surface', 'Upper air', 'Convective', 'Moisture & precip'] as const;

export type ModelDef = {
  key: string;
  label: string;
  fhr_max: number;
  fhr_step: number;
  fields: ModelFieldDef[];
};

export type RegionDef = { key: string; label: string };

const F = {
  // Surface
  t2m: { key: 't2m', label: '2 m Temperature', unit: '°F', group: 'Surface', min_fhr: 0 },
  dewp2m: { key: 'dewp2m', label: '2 m Dewpoint', unit: '°F', group: 'Surface', min_fhr: 0 },
  wind10m: { key: 'wind10m', label: '10 m Wind', unit: 'kt', group: 'Surface', min_fhr: 0 },
  mslp: { key: 'mslp', label: 'MSLP', unit: 'hPa', group: 'Surface', min_fhr: 0 },
  // Upper air
  jet250: { key: 'jet250', label: '250 hPa Jet', unit: 'kt', group: 'Upper air', min_fhr: 0 },
  vort500: { key: 'vort500', label: '500 hPa Vort + Height', unit: '×10⁻⁵ s⁻¹', group: 'Upper air', min_fhr: 0 },
  hgt500: { key: 'hgt500', label: '500 hPa Height', unit: 'dam', group: 'Upper air', min_fhr: 0 },
  omega700: { key: 'omega700', label: '700 hPa Omega', unit: 'Pa/s', group: 'Upper air', min_fhr: 0 },
  rh700: { key: 'rh700', label: '700 hPa RH', unit: '%', group: 'Upper air', min_fhr: 0 },
  t850: { key: 't850', label: '850 hPa Temp', unit: '°C', group: 'Upper air', min_fhr: 0 },
  thetae850: { key: 'thetae850', label: '850 hPa θe + wind', unit: 'K', group: 'Upper air', min_fhr: 0 },
  // Convective
  cape: { key: 'cape', label: 'Surface CAPE', unit: 'J/kg', group: 'Convective', min_fhr: 0 },
  li: { key: 'li', label: 'Lifted Index', unit: '°C', group: 'Convective', min_fhr: 0 },
  refc: { key: 'refc', label: 'Composite reflectivity', unit: 'dBZ', group: 'Convective', min_fhr: 0 },
  // Moisture & precip
  pwat: { key: 'pwat', label: 'Precipitable Water', unit: 'in', group: 'Moisture & precip', min_fhr: 0 },
  apcp: { key: 'apcp', label: 'Accum precip', unit: 'in', group: 'Moisture & precip', min_fhr: 1 },
} satisfies Record<string, ModelFieldDef>;

const GFS_NAM_FIELDS = [
  F.t2m, F.dewp2m, F.wind10m, F.mslp,
  F.jet250, F.vort500, F.hgt500, F.omega700, F.rh700, F.t850, F.thetae850,
  F.cape, F.li, F.pwat, F.apcp,
];

export const MODEL_CATALOG: { models: ModelDef[]; regions: RegionDef[] } = {
  models: [
    { key: 'gfs', label: 'GFS 0.25°', fhr_max: 84, fhr_step: 3, fields: GFS_NAM_FIELDS },
    { key: 'nam', label: 'NAM 12 km', fhr_max: 60, fhr_step: 3, fields: GFS_NAM_FIELDS },
    { key: 'hrrr', label: 'HRRR 3 km', fhr_max: 18, fhr_step: 1, fields: [F.t2m, F.dewp2m, F.wind10m, F.refc, F.cape] },
  ],
  regions: [
    { key: 'midsouth', label: 'Mid-South' },
    { key: 'southeast', label: 'Southeast' },
    { key: 'splains', label: 'Southern Plains' },
    { key: 'ohvalley', label: 'Ohio Valley' },
    { key: 'conus', label: 'CONUS' },
  ],
};

export function modelDef(key: string): ModelDef | undefined {
  return MODEL_CATALOG.models.find((m) => m.key === key);
}

export function modelField(modelKey: string, fieldKey: string): ModelFieldDef | undefined {
  return modelDef(modelKey)?.fields.find((f) => f.key === fieldKey);
}
