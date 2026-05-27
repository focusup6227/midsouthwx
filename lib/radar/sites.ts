// NEXRAD WSR-88D radar sites for the CONUS. Source: NWS Radar Operations
// Center station list (coordinates are the antenna positions to within ~0.05°,
// which is plenty for fly-to and proximity sort). When the renderer or NCEP
// GeoServer talks Level II / WMS, the site is identified by its ICAO code.
//
// If you ever want Alaska / Hawaii / Puerto Rico / Guam, add them here and
// the UI picks them up automatically.

export type RadarSite = {
  code: string;
  name: string;
  state: string;
  center: [number, number]; // [lon, lat]
  zoom: number;
};

export const NEXRAD_SITES: RadarSite[] = [
  // Alabama
  { code: 'KBMX', name: 'Birmingham',          state: 'AL', center: [-86.77, 33.17], zoom: 7.5 },
  { code: 'KEOX', name: 'Fort Rucker',         state: 'AL', center: [-85.46, 31.46], zoom: 7.5 },
  { code: 'KHTX', name: 'Huntsville (Hytop)',  state: 'AL', center: [-86.08, 34.93], zoom: 7.5 },
  { code: 'KMOB', name: 'Mobile',              state: 'AL', center: [-88.24, 30.68], zoom: 7.5 },
  { code: 'KMXX', name: 'Maxwell AFB',         state: 'AL', center: [-85.79, 32.54], zoom: 7.5 },

  // Arizona
  { code: 'KEMX', name: 'Tucson',              state: 'AZ', center: [-110.63, 31.89], zoom: 7.5 },
  { code: 'KFSX', name: 'Flagstaff',           state: 'AZ', center: [-111.20, 34.57], zoom: 7.5 },
  { code: 'KIWA', name: 'Phoenix',             state: 'AZ', center: [-111.67, 33.29], zoom: 7.5 },
  { code: 'KYUX', name: 'Yuma',                state: 'AZ', center: [-114.66, 32.50], zoom: 7.5 },

  // Arkansas
  { code: 'KLZK', name: 'Little Rock',         state: 'AR', center: [-92.26, 34.84], zoom: 7.5 },
  { code: 'KSRX', name: 'Fort Smith (Western)', state: 'AR', center: [-94.36, 35.29], zoom: 7.5 },

  // California
  { code: 'KBBX', name: 'Beale AFB',           state: 'CA', center: [-121.63, 39.50], zoom: 7.5 },
  { code: 'KBHX', name: 'Eureka',              state: 'CA', center: [-124.29, 40.50], zoom: 7.5 },
  { code: 'KDAX', name: 'Sacramento',          state: 'CA', center: [-121.68, 38.50], zoom: 7.5 },
  { code: 'KEYX', name: 'Edwards AFB',         state: 'CA', center: [-117.56, 35.10], zoom: 7.5 },
  { code: 'KHNX', name: 'San Joaquin / Hanford', state: 'CA', center: [-119.63, 36.31], zoom: 7.5 },
  { code: 'KMUX', name: 'San Francisco',       state: 'CA', center: [-121.90, 37.16], zoom: 7.5 },
  { code: 'KNKX', name: 'San Diego',           state: 'CA', center: [-117.04, 32.92], zoom: 7.5 },
  { code: 'KSOX', name: 'Santa Ana',           state: 'CA', center: [-117.64, 33.82], zoom: 7.5 },
  { code: 'KVBX', name: 'Vandenberg',          state: 'CA', center: [-120.40, 34.84], zoom: 7.5 },
  { code: 'KVTX', name: 'Los Angeles',         state: 'CA', center: [-119.18, 34.41], zoom: 7.5 },

  // Colorado
  { code: 'KCYS', name: 'Cheyenne',            state: 'WY', center: [-104.81, 41.15], zoom: 7.5 },
  { code: 'KFTG', name: 'Denver',              state: 'CO', center: [-104.55, 39.78], zoom: 7.5 },
  { code: 'KGJX', name: 'Grand Junction',      state: 'CO', center: [-108.21, 39.06], zoom: 7.5 },
  { code: 'KPUX', name: 'Pueblo',              state: 'CO', center: [-104.18, 38.46], zoom: 7.5 },

  // Delaware
  { code: 'KDOX', name: 'Dover AFB',           state: 'DE', center: [-75.44, 38.83], zoom: 7.5 },

  // Florida
  { code: 'KAMX', name: 'Miami',               state: 'FL', center: [-80.41, 25.61], zoom: 7.5 },
  { code: 'KBYX', name: 'Key West',            state: 'FL', center: [-81.70, 24.60], zoom: 7.5 },
  { code: 'KEVX', name: 'Eglin AFB',           state: 'FL', center: [-85.92, 30.56], zoom: 7.5 },
  { code: 'KJAX', name: 'Jacksonville',        state: 'FL', center: [-81.70, 30.48], zoom: 7.5 },
  { code: 'KMLB', name: 'Melbourne',           state: 'FL', center: [-80.65, 28.11], zoom: 7.5 },
  { code: 'KTBW', name: 'Tampa Bay',           state: 'FL', center: [-82.40, 27.71], zoom: 7.5 },
  { code: 'KTLH', name: 'Tallahassee',         state: 'FL', center: [-84.33, 30.40], zoom: 7.5 },

  // Georgia
  { code: 'KFFC', name: 'Atlanta',             state: 'GA', center: [-84.57, 33.36], zoom: 7.5 },
  { code: 'KJGX', name: 'Robins AFB',          state: 'GA', center: [-83.35, 32.68], zoom: 7.5 },
  { code: 'KVAX', name: 'Moody AFB',           state: 'GA', center: [-83.00, 30.89], zoom: 7.5 },

  // Idaho
  { code: 'KCBX', name: 'Boise',               state: 'ID', center: [-116.24, 43.49], zoom: 7.5 },
  { code: 'KSFX', name: 'Pocatello',           state: 'ID', center: [-112.69, 43.11], zoom: 7.5 },

  // Illinois
  { code: 'KILX', name: 'Lincoln',             state: 'IL', center: [-89.34, 40.15], zoom: 7.5 },
  { code: 'KLOT', name: 'Chicago / Romeoville', state: 'IL', center: [-88.08, 41.60], zoom: 7.5 },

  // Indiana
  { code: 'KIND', name: 'Indianapolis',        state: 'IN', center: [-86.28, 39.71], zoom: 7.5 },
  { code: 'KIWX', name: 'North Webster',       state: 'IN', center: [-85.70, 41.36], zoom: 7.5 },
  { code: 'KVWX', name: 'Evansville (Owensville)', state: 'IN', center: [-87.72, 38.26], zoom: 7.5 },

  // Iowa
  { code: 'KDMX', name: 'Des Moines',          state: 'IA', center: [-93.72, 41.73], zoom: 7.5 },
  { code: 'KDVN', name: 'Davenport',           state: 'IA', center: [-90.58, 41.61], zoom: 7.5 },

  // Kansas
  { code: 'KDDC', name: 'Dodge City',          state: 'KS', center: [-99.97, 37.76], zoom: 7.5 },
  { code: 'KGLD', name: 'Goodland',            state: 'KS', center: [-101.70, 39.37], zoom: 7.5 },
  { code: 'KICT', name: 'Wichita',             state: 'KS', center: [-97.44, 37.65], zoom: 7.5 },
  { code: 'KTWX', name: 'Topeka',              state: 'KS', center: [-96.23, 38.99], zoom: 7.5 },

  // Kentucky
  { code: 'KHPX', name: 'Fort Campbell',       state: 'KY', center: [-87.29, 36.74], zoom: 7.5 },
  { code: 'KJKL', name: 'Jackson',             state: 'KY', center: [-83.31, 37.59], zoom: 7.5 },
  { code: 'KLVX', name: 'Louisville',          state: 'KY', center: [-85.94, 37.98], zoom: 7.5 },
  { code: 'KPAH', name: 'Paducah',             state: 'KY', center: [-88.77, 37.07], zoom: 7.5 },

  // Louisiana
  { code: 'KLCH', name: 'Lake Charles',        state: 'LA', center: [-93.22, 30.13], zoom: 7.5 },
  { code: 'KLIX', name: 'New Orleans',         state: 'LA', center: [-89.83, 30.34], zoom: 7.5 },
  { code: 'KPOE', name: 'Fort Polk',           state: 'LA', center: [-92.98, 31.16], zoom: 7.5 },
  { code: 'KSHV', name: 'Shreveport',          state: 'LA', center: [-93.84, 32.45], zoom: 7.5 },

  // Maine
  { code: 'KCBW', name: 'Caribou',             state: 'ME', center: [-67.81, 46.04], zoom: 7.5 },
  { code: 'KGYX', name: 'Portland',            state: 'ME', center: [-70.26, 43.89], zoom: 7.5 },

  // Massachusetts
  { code: 'KBOX', name: 'Boston',              state: 'MA', center: [-71.14, 41.96], zoom: 7.5 },

  // Michigan
  { code: 'KAPX', name: 'Gaylord',             state: 'MI', center: [-84.72, 44.91], zoom: 7.5 },
  { code: 'KDTX', name: 'Detroit',             state: 'MI', center: [-83.47, 42.70], zoom: 7.5 },
  { code: 'KGRR', name: 'Grand Rapids',        state: 'MI', center: [-85.55, 42.89], zoom: 7.5 },
  { code: 'KMQT', name: 'Marquette',           state: 'MI', center: [-87.55, 46.53], zoom: 7.5 },

  // Minnesota
  { code: 'KDLH', name: 'Duluth',              state: 'MN', center: [-92.21, 46.84], zoom: 7.5 },
  { code: 'KMPX', name: 'Minneapolis',         state: 'MN', center: [-93.57, 44.85], zoom: 7.5 },

  // Mississippi
  { code: 'KDGX', name: 'Jackson',             state: 'MS', center: [-89.98, 32.28], zoom: 7.5 },
  { code: 'KGWX', name: 'Columbus AFB',        state: 'MS', center: [-88.33, 33.90], zoom: 7.5 },

  // Missouri
  { code: 'KEAX', name: 'Kansas City',         state: 'MO', center: [-94.26, 38.81], zoom: 7.5 },
  { code: 'KLSX', name: 'St. Louis',           state: 'MO', center: [-90.68, 38.70], zoom: 7.5 },
  { code: 'KSGF', name: 'Springfield',         state: 'MO', center: [-93.40, 37.24], zoom: 7.5 },

  // Montana
  { code: 'KBLX', name: 'Billings',            state: 'MT', center: [-108.61, 45.85], zoom: 7.5 },
  { code: 'KGGW', name: 'Glasgow',             state: 'MT', center: [-106.62, 48.21], zoom: 7.5 },
  { code: 'KMSX', name: 'Missoula',            state: 'MT', center: [-114.00, 47.04], zoom: 7.5 },
  { code: 'KTFX', name: 'Great Falls',         state: 'MT', center: [-111.39, 47.46], zoom: 7.5 },

  // Nebraska
  { code: 'KLNX', name: 'North Platte',        state: 'NE', center: [-100.58, 41.96], zoom: 7.5 },
  { code: 'KOAX', name: 'Omaha',               state: 'NE', center: [-96.37, 41.32], zoom: 7.5 },
  { code: 'KUEX', name: 'Hastings',            state: 'NE', center: [-98.44, 40.32], zoom: 7.5 },

  // Nevada
  { code: 'KESX', name: 'Las Vegas',           state: 'NV', center: [-114.89, 35.70], zoom: 7.5 },
  { code: 'KLRX', name: 'Elko',                state: 'NV', center: [-116.80, 40.74], zoom: 7.5 },
  { code: 'KRGX', name: 'Reno',                state: 'NV', center: [-119.46, 39.75], zoom: 7.5 },

  // New Jersey
  { code: 'KDIX', name: 'Philadelphia (Mt Holly)', state: 'NJ', center: [-74.41, 39.94], zoom: 7.5 },

  // New Mexico
  { code: 'KABX', name: 'Albuquerque',         state: 'NM', center: [-106.82, 35.15], zoom: 7.5 },
  { code: 'KFDX', name: 'Cannon AFB',          state: 'NM', center: [-103.62, 34.63], zoom: 7.5 },
  { code: 'KHDX', name: 'Holloman AFB',        state: 'NM', center: [-106.12, 33.08], zoom: 7.5 },

  // New York
  { code: 'KBGM', name: 'Binghamton',          state: 'NY', center: [-75.99, 42.20], zoom: 7.5 },
  { code: 'KBUF', name: 'Buffalo',             state: 'NY', center: [-78.74, 42.95], zoom: 7.5 },
  { code: 'KENX', name: 'Albany',              state: 'NY', center: [-74.06, 42.59], zoom: 7.5 },
  { code: 'KOKX', name: 'New York City',       state: 'NY', center: [-72.86, 40.87], zoom: 7.5 },
  { code: 'KTYX', name: 'Fort Drum (Montague)', state: 'NY', center: [-75.68, 43.76], zoom: 7.5 },

  // North Carolina
  { code: 'KLTX', name: 'Wilmington',          state: 'NC', center: [-78.43, 33.99], zoom: 7.5 },
  { code: 'KMHX', name: 'Morehead City',       state: 'NC', center: [-76.88, 34.78], zoom: 7.5 },
  { code: 'KRAX', name: 'Raleigh',             state: 'NC', center: [-78.49, 35.66], zoom: 7.5 },

  // North Dakota
  { code: 'KBIS', name: 'Bismarck',            state: 'ND', center: [-100.76, 46.77], zoom: 7.5 },
  { code: 'KMBX', name: 'Minot AFB',           state: 'ND', center: [-100.86, 48.39], zoom: 7.5 },
  { code: 'KMVX', name: 'Grand Forks',         state: 'ND', center: [-97.33, 47.53], zoom: 7.5 },

  // Ohio
  { code: 'KCLE', name: 'Cleveland',           state: 'OH', center: [-81.86, 41.41], zoom: 7.5 },
  { code: 'KILN', name: 'Wilmington',          state: 'OH', center: [-83.82, 39.42], zoom: 7.5 },

  // Oklahoma
  { code: 'KFDR', name: 'Frederick (Altus)',   state: 'OK', center: [-98.98, 34.36], zoom: 7.5 },
  { code: 'KINX', name: 'Tulsa',               state: 'OK', center: [-95.56, 36.18], zoom: 7.5 },
  { code: 'KTLX', name: 'Oklahoma City',       state: 'OK', center: [-97.28, 35.33], zoom: 7.5 },
  { code: 'KVNX', name: 'Vance AFB',           state: 'OK', center: [-98.13, 36.74], zoom: 7.5 },

  // Oregon
  { code: 'KMAX', name: 'Medford',             state: 'OR', center: [-122.72, 42.08], zoom: 7.5 },
  { code: 'KPDT', name: 'Pendleton',           state: 'OR', center: [-118.85, 45.69], zoom: 7.5 },
  { code: 'KRTX', name: 'Portland',            state: 'OR', center: [-122.96, 45.71], zoom: 7.5 },

  // Pennsylvania
  { code: 'KCCX', name: 'State College',       state: 'PA', center: [-78.00, 40.92], zoom: 7.5 },
  { code: 'KPBZ', name: 'Pittsburgh',          state: 'PA', center: [-80.22, 40.53], zoom: 7.5 },

  // South Carolina
  { code: 'KCAE', name: 'Columbia',            state: 'SC', center: [-81.12, 33.95], zoom: 7.5 },
  { code: 'KCLX', name: 'Charleston',          state: 'SC', center: [-81.04, 32.66], zoom: 7.5 },
  { code: 'KGSP', name: 'Greer',               state: 'SC', center: [-82.22, 34.88], zoom: 7.5 },

  // South Dakota
  { code: 'KABR', name: 'Aberdeen',            state: 'SD', center: [-98.41, 45.46], zoom: 7.5 },
  { code: 'KFSD', name: 'Sioux Falls',         state: 'SD', center: [-96.73, 43.59], zoom: 7.5 },
  { code: 'KUDX', name: 'Rapid City',          state: 'SD', center: [-102.83, 44.13], zoom: 7.5 },

  // Tennessee
  { code: 'KMRX', name: 'Morristown',          state: 'TN', center: [-83.40, 36.17], zoom: 7.5 },
  { code: 'KNQA', name: 'Memphis',             state: 'TN', center: [-89.87, 35.34], zoom: 7.5 },
  { code: 'KOHX', name: 'Nashville',           state: 'TN', center: [-86.56, 36.25], zoom: 7.5 },

  // Texas
  { code: 'KAMA', name: 'Amarillo',            state: 'TX', center: [-101.71, 35.23], zoom: 7.5 },
  { code: 'KBRO', name: 'Brownsville',         state: 'TX', center: [-97.42, 25.92], zoom: 7.5 },
  { code: 'KCRP', name: 'Corpus Christi',      state: 'TX', center: [-97.51, 27.78], zoom: 7.5 },
  { code: 'KDFX', name: 'Del Rio (Laughlin)',  state: 'TX', center: [-100.28, 29.27], zoom: 7.5 },
  { code: 'KDYX', name: 'Dyess AFB',           state: 'TX', center: [-99.25, 32.54], zoom: 7.5 },
  { code: 'KEPZ', name: 'El Paso',             state: 'TX', center: [-106.70, 31.87], zoom: 7.5 },
  { code: 'KEWX', name: 'Austin / San Antonio', state: 'TX', center: [-98.03, 29.70], zoom: 7.5 },
  { code: 'KFWS', name: 'Dallas / Fort Worth', state: 'TX', center: [-97.30, 32.57], zoom: 7.5 },
  { code: 'KGRK', name: 'Fort Hood',           state: 'TX', center: [-97.38, 30.72], zoom: 7.5 },
  { code: 'KHGX', name: 'Houston',             state: 'TX', center: [-95.08, 29.47], zoom: 7.5 },
  { code: 'KLBB', name: 'Lubbock',             state: 'TX', center: [-101.81, 33.65], zoom: 7.5 },
  { code: 'KMAF', name: 'Midland / Odessa',    state: 'TX', center: [-102.19, 31.94], zoom: 7.5 },
  { code: 'KSJT', name: 'San Angelo',          state: 'TX', center: [-100.49, 31.37], zoom: 7.5 },

  // Utah
  { code: 'KICX', name: 'Cedar City',          state: 'UT', center: [-112.86, 37.59], zoom: 7.5 },
  { code: 'KMTX', name: 'Salt Lake City',      state: 'UT', center: [-112.45, 41.26], zoom: 7.5 },

  // Vermont
  { code: 'KCXX', name: 'Burlington',          state: 'VT', center: [-73.17, 44.51], zoom: 7.5 },

  // Virginia
  { code: 'KAKQ', name: 'Wakefield',           state: 'VA', center: [-77.01, 36.98], zoom: 7.5 },
  { code: 'KFCX', name: 'Roanoke',             state: 'VA', center: [-80.27, 37.02], zoom: 7.5 },
  { code: 'KLWX', name: 'Sterling / DC',       state: 'VA', center: [-77.48, 38.98], zoom: 7.5 },

  // Washington
  { code: 'KATX', name: 'Seattle',             state: 'WA', center: [-122.50, 48.19], zoom: 7.5 },
  { code: 'KOTX', name: 'Spokane',             state: 'WA', center: [-117.63, 47.68], zoom: 7.5 },

  // West Virginia
  { code: 'KRLX', name: 'Charleston',          state: 'WV', center: [-81.72, 38.31], zoom: 7.5 },

  // Wisconsin
  { code: 'KARX', name: 'La Crosse',           state: 'WI', center: [-91.19, 43.82], zoom: 7.5 },
  { code: 'KGRB', name: 'Green Bay',           state: 'WI', center: [-88.11, 44.50], zoom: 7.5 },
  { code: 'KMKX', name: 'Milwaukee',           state: 'WI', center: [-88.55, 42.97], zoom: 7.5 },

  // Wyoming
  { code: 'KRIW', name: 'Riverton',            state: 'WY', center: [-108.48, 43.07], zoom: 7.5 },
];

export const NEXRAD_SITES_BY_CODE: Record<string, RadarSite> = Object.fromEntries(
  NEXRAD_SITES.map((s) => [s.code, s]),
);

export const NEXRAD_CODES: string[] = NEXRAD_SITES.map((s) => s.code);

/** Haversine distance in km between two [lon, lat] points. */
export function distanceKm(a: [number, number], b: [number, number]): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function nearestSites(
  center: [number, number],
  limit = 10,
): RadarSite[] {
  return [...NEXRAD_SITES]
    .map((s) => ({ s, d: distanceKm(center, s.center) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, limit)
    .map((x) => x.s);
}

// Fuzzy ordered subsequence match. Returns 0 if query chars aren't all
// present in `target` in order, else a score that's higher when the matched
// characters are tightly packed. Caps below word-prefix scores so it never
// outranks a clean hit.
function fuzzySubseqScore(q: string, target: string): number {
  let qi = 0;
  let lastIdx = -1;
  let gaps = 0;
  for (let i = 0; i < target.length && qi < q.length; i++) {
    if (target[i] === q[qi]) {
      if (lastIdx >= 0) gaps += i - lastIdx - 1;
      lastIdx = i;
      qi++;
    }
  }
  if (qi < q.length) return 0;
  return Math.max(0, 80 - gaps);
}

// Tiny Levenshtein for typo tolerance ('memphsi' → Memphis). 155 sites × short
// strings means we don't need anything fancier.
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  const m = a.length, n = b.length;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + cost);
      prev = tmp;
    }
  }
  return dp[n];
}

export function searchSites(query: string, limit = 20): RadarSite[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const scored = NEXRAD_SITES.map((s) => {
    const code = s.code.toLowerCase();
    const name = s.name.toLowerCase();
    const state = s.state.toLowerCase();
    const words = name.split(/[\s/,()]+/).filter(Boolean);

    let score = 0;
    if (code === q) score = 1000;
    else if (name === q) score = 900;
    else if (code.startsWith(q)) score = 700;
    else if (name.startsWith(q)) score = 600;
    else if (words.some((w) => w.startsWith(q))) score = 500;
    else if (code.includes(q)) score = 300;
    else if (name.includes(q)) score = 250;
    else if (state === q) score = 200;
    else {
      const subseq = fuzzySubseqScore(q, `${name} ${code}`);
      let levScore = 0;
      if (q.length >= 4) {
        let best = Infinity;
        for (const w of words) {
          if (Math.abs(w.length - q.length) > 2) continue;
          const d = levenshtein(q, w);
          if (d < best) best = d;
        }
        if (best <= 2) levScore = (3 - best) * 60;
      }
      score = Math.max(subseq, levScore);
    }

    return { s, score };
  });

  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.s);
}
