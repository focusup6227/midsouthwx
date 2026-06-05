// GOES-East (GOES-19) + GOES-West (GOES-18) satellite imagery catalog.
//
// Source: NOAA NESDIS STAR static sector JPEGs (cdn.star.nesdis.noaa.gov).
// Single "latest" image per satellite+sector+band → plain <img> (no Mapbox),
// matching the model/mesoanalysis panels. Covers water vapor (B08/09/10),
// clean IR (B13), visible (B02), GeoColor, Air Mass. ~5–15 min cadence.

export type SatBand = { key: string; label: string; group: 'Clouds' | 'Water vapor' | 'RGB' };
export type SatSector = { key: string; label: string; conus?: boolean };
export type SatSatellite = { key: string; label: string; goes: string; defaultSector: string; sectors: SatSector[] };

export const SAT_BANDS: SatBand[] = [
  { key: 'GEOCOLOR', label: 'GeoColor', group: 'RGB' },
  { key: '02', label: 'Visible (B02)', group: 'Clouds' },
  { key: '13', label: 'Clean IR (B13)', group: 'Clouds' },
  { key: '08', label: 'Upper WV (B08)', group: 'Water vapor' },
  { key: '09', label: 'Mid WV (B09)', group: 'Water vapor' },
  { key: '10', label: 'Lower WV (B10)', group: 'Water vapor' },
  { key: 'AirMass', label: 'Air Mass RGB', group: 'RGB' },
];

export const SAT_SATELLITES: SatSatellite[] = [
  {
    key: 'east', label: 'GOES-East', goes: 'GOES19', defaultSector: 'smv',
    sectors: [
      { key: 'smv', label: 'Mid-South (S. Miss Valley)' },
      { key: 'se', label: 'Southeast' },
      { key: 'umv', label: 'Upper Miss Valley' },
      { key: 'sp', label: 'Southern Plains' },
      { key: 'CONUS', label: 'CONUS', conus: true },
    ],
  },
  {
    key: 'west', label: 'GOES-West', goes: 'GOES18', defaultSector: 'CONUS',
    sectors: [
      { key: 'CONUS', label: 'CONUS (West)', conus: true },
      { key: 'psw', label: 'Pacific SW' },
      { key: 'pnw', label: 'Pacific NW' },
    ],
  },
];

export const SAT_DEFAULT_BAND = 'GEOCOLOR';

const STAR_BASE = 'https://cdn.star.nesdis.noaa.gov';

export function satSatellite(key: string): SatSatellite {
  return SAT_SATELLITES.find((s) => s.key === key) ?? SAT_SATELLITES[0];
}

export function satImageUrl(satKey: string, sector: string, band: string, cacheKey?: number): string {
  const sat = satSatellite(satKey);
  const sec = sat.sectors.find((x) => x.key === sector) ?? sat.sectors[0];
  const bust = cacheKey ? `?_t=${cacheKey}` : '';
  if (sec.conus) {
    return `${STAR_BASE}/${sat.goes}/ABI/CONUS/${band}/1250x750.jpg${bust}`;
  }
  return `${STAR_BASE}/${sat.goes}/ABI/SECTOR/${sec.key}/${band}/1200x1200.jpg${bust}`;
}

export function satStarPage(satKey: string, sector: string, band: string): string {
  const sat = satSatellite(satKey);
  const sec = sat.sectors.find((x) => x.key === sector) ?? sat.sectors[0];
  const g = sat.goes === 'GOES19' ? 'G19' : 'G18';
  return sec.conus
    ? `https://www.star.nesdis.noaa.gov/GOES/conus_band.php?sat=${g}&band=${band}`
    : `https://www.star.nesdis.noaa.gov/GOES/sector_band.php?sat=${g}&sector=${sec.key}&band=${band}`;
}
