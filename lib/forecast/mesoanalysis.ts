// SPC Mesoscale Analysis raster catalog.
//
// URL contract: https://www.spc.noaa.gov/exper/mesoanalysis/<sector>/<field>/<field>.gif
// Verified live (returns 200 + image/gif of meaningful size, ~30-100 KB):
//   - 17 fields below × 6 sectors. CAPE family uses 4-character codes
//     (mucp/sbcp/mlcp), NOT the long names (mucape/sbcape/mlcape) — those
//     return 403 from S3.
//   - SPC updates every ~30 minutes during the day.
//
// Off-list field codes that exist on SPC pages but return 403 from S3 today:
//   lftx, esrh, stp1/stp2, mucn/sbcn/mlcn (CIN), lr0/lr3/lr5 (lapse rates),
//   sfcoa, t2/td2, lcl. They might come back; check via curl and re-add.
//
// CORS: `<img>` cross-origin loads always succeed. We don't try to extract
// pixels from these — pure visual reference.

export type MesoanalysisSector = {
  code: string;     // s10, s19, s20, etc.
  label: string;    // human name for the picker
};

// Sector codes copied off SPC's sector map. s19 is the Mid-South — the home
// AOR — so it's the default. Other sectors let the operator zoom out for a
// synoptic look or check a neighboring region during long-track systems.
export const MESO_SECTORS: MesoanalysisSector[] = [
  { code: 's19', label: 'Mid-South (TN/MS/AR)' },
  { code: 's18', label: 'Southeast' },
  { code: 's17', label: 'Lower MS Valley' },
  { code: 's16', label: 'Southern Plains' },
  { code: 's20', label: 'Ohio Valley' },
  { code: 's12', label: 'CONUS / Synoptic' },
];

export type MesoanalysisField = {
  code: string;
  label: string;
  group: 'thermo' | 'kinematic' | 'composite' | 'synoptic';
  note?: string;
};

// Grouping mirrors how an operator reads the SPC page: synoptic for the
// big picture, thermo for instability, kinematic for shear/SRH, composite
// for the gestalt parameters that bundle thermo + shear.
export const MESO_FIELDS: MesoanalysisField[] = [
  // Synoptic / surface
  { code: 'pmsl',  label: 'Mean Sea Level Pressure',         group: 'synoptic' },
  { code: 'ttd',   label: 'Temperature & Dewpoint',          group: 'synoptic', note: 'T over Td, °F' },

  // Thermodynamic (instability)
  { code: 'sbcp',  label: 'Surface-Based CAPE',              group: 'thermo' },
  { code: 'mlcp',  label: 'Mixed-Layer CAPE',                group: 'thermo' },
  { code: 'mucp',  label: 'Most-Unstable CAPE',              group: 'thermo' },
  { code: 'muli',  label: 'Most-Unstable Lifted Index',      group: 'thermo' },

  // Kinematic (shear / helicity)
  { code: 'shr1',  label: '0-1 km Bulk Shear',               group: 'kinematic' },
  { code: 'shr3',  label: '0-3 km Bulk Shear',               group: 'kinematic' },
  { code: 'shr6',  label: '0-6 km Bulk Shear',               group: 'kinematic' },
  { code: 'eshr',  label: 'Effective Bulk Shear',            group: 'kinematic' },
  { code: 'srh1',  label: '0-1 km Storm-Relative Helicity',  group: 'kinematic' },
  { code: 'srh3',  label: '0-3 km Storm-Relative Helicity',  group: 'kinematic' },

  // Composite parameters
  { code: 'ehi1',  label: 'Energy Helicity Index 0-1 km',    group: 'composite' },
  { code: 'ehi3',  label: 'Energy Helicity Index 0-3 km',    group: 'composite' },
  { code: 'scp',   label: 'Supercell Composite Parameter',   group: 'composite' },
  { code: 'stpc',  label: 'Sig Tornado Parameter (eff)',     group: 'composite' },
  { code: 'sigh',  label: 'Significant Hail Parameter',      group: 'composite' },
];

export function mesoUrl(sectorCode: string, fieldCode: string, cacheKey?: number): string {
  const bust = cacheKey ? `?_t=${cacheKey}` : '';
  return `https://www.spc.noaa.gov/exper/mesoanalysis/${sectorCode}/${fieldCode}/${fieldCode}.gif${bust}`;
}

export const MESO_DEFAULT_SECTOR = 's19';
export const MESO_DEFAULT_FIELD = 'sbcp';
