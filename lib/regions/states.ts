// US state lookups used by the regions UI + import paths.
// County FIPS use 2-digit numeric prefix; UGC codes use the 2-letter postal abbr.

export const FIPS_TO_ABBR: Record<string, string> = {
  '01': 'AL', '02': 'AK', '04': 'AZ', '05': 'AR', '06': 'CA', '08': 'CO',
  '09': 'CT', '10': 'DE', '11': 'DC', '12': 'FL', '13': 'GA', '15': 'HI',
  '16': 'ID', '17': 'IL', '18': 'IN', '19': 'IA', '20': 'KS', '21': 'KY',
  '22': 'LA', '23': 'ME', '24': 'MD', '25': 'MA', '26': 'MI', '27': 'MN',
  '28': 'MS', '29': 'MO', '30': 'MT', '31': 'NE', '32': 'NV', '33': 'NH',
  '34': 'NJ', '35': 'NM', '36': 'NY', '37': 'NC', '38': 'ND', '39': 'OH',
  '40': 'OK', '41': 'OR', '42': 'PA', '44': 'RI', '45': 'SC', '46': 'SD',
  '47': 'TN', '48': 'TX', '49': 'UT', '50': 'VT', '51': 'VA', '53': 'WA',
  '54': 'WV', '55': 'WI', '56': 'WY',
};

export const ABBR_TO_FIPS: Record<string, string> = Object.fromEntries(
  Object.entries(FIPS_TO_ABBR).map(([fips, abbr]) => [abbr, fips]),
);

export function stateFromCountyFips(fips: string | null | undefined): string | null {
  if (!fips || fips.length < 2) return null;
  return FIPS_TO_ABBR[fips.slice(0, 2)] ?? null;
}

export function stateFromUgc(ugc: string | null | undefined): string | null {
  if (!ugc || ugc.length < 2) return null;
  const prefix = ugc.slice(0, 2).toUpperCase();
  return prefix in ABBR_TO_FIPS ? prefix : null;
}

export function regionState(r: {
  kind: string;
  county_fips?: string | null;
  ugc_code?: string | null;
}): string | null {
  if (r.kind === 'county') return stateFromCountyFips(r.county_fips);
  if (r.kind === 'zone') return stateFromUgc(r.ugc_code);
  return null;
}
