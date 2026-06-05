// UI catalog for the Models data viewer. Mirrors the server catalog in
// _renderer/model_render.py (MODELS / FIELDS / REGIONS) so the select menus and
// the forecast-hour slider render without a round-trip to the (possibly cold)
// renderer. Keep this in sync with model_render.py if fields/models change.

export type ModelFieldDef = {
  key: string;
  label: string;
  unit: string;
  min_fhr: number; // some fields (precip accum) are undefined at F000
};

export type ModelDef = {
  key: string;
  label: string;
  fhr_max: number;
  fhr_step: number;
  fields: ModelFieldDef[];
};

export type RegionDef = { key: string; label: string };

const F = {
  t2m: { key: 't2m', label: '2 m Temperature', unit: '°F', min_fhr: 0 },
  mslp: { key: 'mslp', label: 'MSLP', unit: 'hPa', min_fhr: 0 },
  cape: { key: 'cape', label: 'Surface CAPE', unit: 'J/kg', min_fhr: 0 },
  apcp: { key: 'apcp', label: 'Accum precip', unit: 'in', min_fhr: 1 },
  hgt500: { key: 'hgt500', label: '500 hPa height', unit: 'dam', min_fhr: 0 },
  refc: { key: 'refc', label: 'Composite reflectivity', unit: 'dBZ', min_fhr: 0 },
} satisfies Record<string, ModelFieldDef>;

export const MODEL_CATALOG: { models: ModelDef[]; regions: RegionDef[] } = {
  models: [
    { key: 'gfs', label: 'GFS 0.25°', fhr_max: 84, fhr_step: 3, fields: [F.t2m, F.mslp, F.cape, F.apcp, F.hgt500] },
    { key: 'nam', label: 'NAM 12 km', fhr_max: 60, fhr_step: 3, fields: [F.t2m, F.mslp, F.cape, F.apcp] },
    { key: 'hrrr', label: 'HRRR 3 km', fhr_max: 18, fhr_step: 1, fields: [F.t2m, F.refc, F.cape] },
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
