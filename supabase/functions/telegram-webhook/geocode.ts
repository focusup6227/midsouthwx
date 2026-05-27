// Deno copy of the Next-side geocoder so the Telegram bot can move the
// subscriber's map pin when /where is used. Same Census `/onelineaddress`
// endpoint with a ZIP fallback. Public, no API key.

export type Geocoded = {
  lat: number;
  lng: number;
  countyFips: string | null;
  matchedAddress?: string;
};

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
function bearingToCompass(deg: number): string {
  const d = ((deg % 360) + 360) % 360;
  return COMPASS[Math.round(d / 45) % 8];
}

/** Reverse-geocode to an LSR-style relative location, e.g. "3 NE Bartlett, TN".
 *  Uses api.weather.gov/points which embeds a relativeLocation block tuned
 *  for storm-report context (nearest gazetteer place + distance + bearing).
 *  Returns null on any failure — callers fall back to raw lat/lon. */
export async function reverseGeocodeRelative(
  lat: number,
  lon: number,
  userAgent: string,
): Promise<string | null> {
  try {
    const url = `https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`;
    const res = await fetch(url, {
      headers: { 'user-agent': userAgent, accept: 'application/geo+json' },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      properties?: {
        relativeLocation?: {
          properties?: {
            city?: string;
            state?: string;
            distance?: { value?: number; unitCode?: string };
            bearing?: { value?: number };
          };
        };
      };
    };
    const r = data.properties?.relativeLocation?.properties;
    if (!r?.city) return null;
    const meters = r.distance?.value ?? 0;
    const miles = Math.round(meters / 1609.344);
    const compass = r.bearing?.value != null ? bearingToCompass(r.bearing.value) : '';
    const head = miles > 0 && compass ? `${miles} ${compass} ` : '';
    return `${head}${r.city}${r.state ? `, ${r.state}` : ''}`;
  } catch {
    return null;
  }
}

export async function geocodeAddress(address: string): Promise<Geocoded | null> {
  try {
    const url = new URL('https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress');
    url.searchParams.set('address', address);
    url.searchParams.set('benchmark', 'Public_AR_Current');
    url.searchParams.set('vintage', 'Current_Current');
    url.searchParams.set('format', 'json');
    url.searchParams.set('layers', 'Counties');

    const res = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
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
    return {
      lat,
      lng,
      countyFips: m.geographies?.Counties?.[0]?.GEOID ?? null,
      matchedAddress: m.matchedAddress,
    };
  } catch {
    return null;
  }
}
