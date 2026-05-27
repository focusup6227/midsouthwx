// Deno copy of the Next-side geocoder so the Telegram bot can move the
// subscriber's map pin when /where is used. Same Census `/onelineaddress`
// endpoint with a ZIP fallback. Public, no API key.

export type Geocoded = {
  lat: number;
  lng: number;
  countyFips: string | null;
  matchedAddress?: string;
};

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
