// Subscriber address/ZIP geocoding.
//
// Strategy:
//   1. If a full street address is available, hit the Census `/onelineaddress`
//      geocoder — it returns precise rooftop-ish coordinates AND the county
//      FIPS in a single round-trip. Free, no API key, no rate limit at our
//      scale.
//   2. Otherwise (or if Census doesn't match), fall back to ZIP centroid via
//      zippopotam.us, then resolve county via api.weather.gov/points.
//
// Either path is good enough for storm-polygon audience resolution; the
// address path is preferred because it lets us draw small polygons around
// a single house and still hit the subscriber.

export type Geocoded = {
  lat: number;
  lng: number;
  countyFips: string | null;
  /** human-readable label of where the match came from — surfaced in UI. */
  source: 'address' | 'zip';
  matchedAddress?: string;
};

export async function geocodeSubscriber(opts: {
  address?: string | null;
  zip?: string | null;
}): Promise<Geocoded | null> {
  if (opts.address) {
    const hit = await geocodeAddress(opts.address);
    if (hit) return hit;
  }
  if (opts.zip) {
    const hit = await geocodeZip(opts.zip);
    if (hit) return hit;
  }
  return null;
}

async function geocodeAddress(address: string): Promise<Geocoded | null> {
  try {
    const url = new URL('https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress');
    url.searchParams.set('address', address);
    url.searchParams.set('benchmark', 'Public_AR_Current');
    url.searchParams.set('vintage', 'Current_Current');
    url.searchParams.set('format', 'json');
    url.searchParams.set('layers', 'Counties');

    const res = await fetch(url, {
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      result?: {
        addressMatches?: Array<{
          matchedAddress?: string;
          coordinates?: { x?: number; y?: number };
          geographies?: { Counties?: Array<{ GEOID?: string }> };
        }>;
      };
    };
    const m = data.result?.addressMatches?.[0];
    if (!m?.coordinates) return null;
    const lng = Number(m.coordinates.x);
    const lat = Number(m.coordinates.y);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const countyFips = m.geographies?.Counties?.[0]?.GEOID ?? null;
    return {
      lat,
      lng,
      countyFips,
      source: 'address',
      matchedAddress: m.matchedAddress,
    };
  } catch {
    return null;
  }
}

async function geocodeZip(zip: string): Promise<Geocoded | null> {
  let lat: number | null = null;
  let lng: number | null = null;
  try {
    const z5 = zip.slice(0, 5);
    const r = await fetch(`https://api.zippopotam.us/us/${encodeURIComponent(z5)}`, {
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
    if (!r.ok) return null;
    const d = (await r.json()) as {
      places?: Array<{ latitude?: string; longitude?: string }>;
    };
    const place = d.places?.[0];
    if (!place) return null;
    const plat = Number(place.latitude);
    const plng = Number(place.longitude);
    if (!Number.isFinite(plat) || !Number.isFinite(plng)) return null;
    lat = plat;
    lng = plng;
  } catch {
    return null;
  }

  let countyFips: string | null = null;
  try {
    const ua = process.env.NWS_USER_AGENT ?? 'midsouthwx';
    const r = await fetch(
      `https://api.weather.gov/points/${lat.toFixed(4)},${lng.toFixed(4)}`,
      {
        headers: { 'user-agent': ua, accept: 'application/geo+json' },
        cache: 'no-store',
      },
    );
    if (r.ok) {
      const d = (await r.json()) as { properties?: { county?: string } };
      const url = d.properties?.county;
      if (url) {
        const m = url.match(/\/county\/([A-Z]{2})([A-Z])(\d{3})$/);
        if (m) {
          const stateFips = STATE_ABBR_TO_FIPS[m[1]];
          if (stateFips) countyFips = `${stateFips}${m[3]}`;
        }
      }
    }
  } catch {
    // NWS down — keep going; polygon match via location still works.
  }

  return { lat, lng, countyFips, source: 'zip' };
}

const STATE_ABBR_TO_FIPS: Record<string, string> = {
  AL: '01', AK: '02', AZ: '04', AR: '05', CA: '06', CO: '08', CT: '09',
  DE: '10', DC: '11', FL: '12', GA: '13', HI: '15', ID: '16', IL: '17',
  IN: '18', IA: '19', KS: '20', KY: '21', LA: '22', ME: '23', MD: '24',
  MA: '25', MI: '26', MN: '27', MS: '28', MO: '29', MT: '30', NE: '31',
  NV: '32', NH: '33', NJ: '34', NM: '35', NY: '36', NC: '37', ND: '38',
  OH: '39', OK: '40', OR: '41', PA: '42', RI: '44', SC: '45', SD: '46',
  TN: '47', TX: '48', UT: '49', VT: '50', VA: '51', WA: '53', WV: '54',
  WI: '55', WY: '56', PR: '72',
};
