// GOES-East (GOES-19) satellite imagery catalog for the forecast workflow.
//
// Source: NOAA NESDIS STAR static sector JPEGs (cdn.star.nesdis.noaa.gov).
// Unlike the tile layers in /radar/RadarView.tsx (which need a Mapbox instance),
// STAR serves a single "latest" image per sector+band — so the workflow's
// SatellitePanel can show it as a plain <img>, matching the model/mesoanalysis
// panels. Covers water vapor (B08/09/10), clean IR (B13), visible (B02), and
// GeoColor. ~5–15 min cadence.

export type SatBand = { key: string; label: string; group: 'Clouds' | 'Water vapor' | 'RGB' };
export type SatSector = { key: string; label: string; conus?: boolean };

export const SAT_BANDS: SatBand[] = [
  { key: 'GEOCOLOR', label: 'GeoColor', group: 'RGB' },
  { key: '02', label: 'Visible (B02)', group: 'Clouds' },
  { key: '13', label: 'Clean IR (B13)', group: 'Clouds' },
  { key: '08', label: 'Upper WV (B08)', group: 'Water vapor' },
  { key: '09', label: 'Mid WV (B09)', group: 'Water vapor' },
  { key: '10', label: 'Lower WV (B10)', group: 'Water vapor' },
  { key: 'AirMass', label: 'Air Mass RGB', group: 'RGB' },
];

export const SAT_SECTORS: SatSector[] = [
  { key: 'smv', label: 'Mid-South (S. Miss Valley)' },
  { key: 'se', label: 'Southeast' },
  { key: 'umv', label: 'Upper Miss Valley' },
  { key: 'sp', label: 'Southern Plains' },
  { key: 'CONUS', label: 'CONUS', conus: true },
];

export const SAT_DEFAULT_SECTOR = 'smv';
export const SAT_DEFAULT_BAND = 'GEOCOLOR';

const STAR_BASE = 'https://cdn.star.nesdis.noaa.gov/GOES19/ABI';

export function satImageUrl(sector: string, band: string, cacheKey?: number): string {
  const bust = cacheKey ? `?_t=${cacheKey}` : '';
  const s = SAT_SECTORS.find((x) => x.key === sector);
  if (s?.conus) {
    // CONUS uses a different path + native aspect ratio.
    return `${STAR_BASE}/CONUS/${band}/1250x750.jpg${bust}`;
  }
  return `${STAR_BASE}/SECTOR/${sector}/${band}/1200x1200.jpg${bust}`;
}

export function satStarPage(sector: string, band: string): string {
  const s = SAT_SECTORS.find((x) => x.key === sector);
  return s?.conus
    ? `https://www.star.nesdis.noaa.gov/GOES/conus_band.php?sat=G19&band=${band}`
    : `https://www.star.nesdis.noaa.gov/GOES/sector_band.php?sat=G19&sector=${sector}&band=${band}`;
}
