/** SPC Mesoscale Discussions — not in api.weather.gov/alerts/active; NOAA MapServer feed. */

const SPC_MD_QUERY =
  'https://mapservices.weather.noaa.gov/vector/rest/services/outlooks/spc_mesoscale_discussion/MapServer/0/query'
  + '?where=1%3D1&outFields=name%2Cpopupinfo%2Cfolderpath%2Cidp_ingestdate&f=geojson'
  + '&resultRecordCount=50';

type SpcMdProps = {
  name?: string;
  popupinfo?: string;
  folderpath?: string;
  idp_ingestdate?: number;
};

export function nwsIdFromAlertFeature(feature: Record<string, unknown>): string | null {
  const props = feature.properties as Record<string, unknown> | undefined;
  const id =
    (typeof props?.id === 'string' && props.id.trim()) ||
    (typeof feature.id === 'string' && feature.id.trim()) ||
    (typeof props?.['@id'] === 'string' && props['@id'].trim()) ||
    null;
  return id;
}

function parseMdExpiresUtc(folderpath: string | undefined): string | null {
  if (!folderpath) return null;
  const m = folderpath.match(/Active\s+Till\s+(\d{2})(\d{2})\s+UTC/i);
  if (!m) return null;
  const hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  const now = new Date();
  let d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hh, mm, 0));
  if (d.getTime() < now.getTime() - 60_000) {
    d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, hh, mm, 0));
  }
  return d.toISOString();
}

function spcMdNwsId(name: string): string {
  const slug = name.trim().replace(/\s+/g, '-');
  return `spc:${slug}`;
}

/** Convert MapServer MD features into NWS-style GeoJSON features for nws_upsert_geojson_feature. */
export function spcMdToNwsFeatures(
  fc: { features?: Record<string, unknown>[] },
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const now = new Date().toISOString();

  for (const f of fc.features ?? []) {
    const geom = f.geometry as { type?: string } | null | undefined;
    if (!geom || (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon')) continue;

    const props = (f.properties ?? {}) as SpcMdProps;
    const name = (props.name ?? '').trim();
    if (!name) continue;

    const nwsId = spcMdNwsId(name);
    const ends = parseMdExpiresUtc(props.folderpath) ?? new Date(Date.now() + 2 * 3600_000).toISOString();
    const link = props.popupinfo?.trim() ?? '';
    const folder = props.folderpath?.trim() ?? '';

    out.push({
      type: 'Feature',
      id: nwsId,
      geometry: geom,
      properties: {
        id: nwsId,
        '@id': nwsId,
        event: 'Mesoscale Discussion',
        severity: 'Moderate',
        certainty: 'Possible',
        urgency: 'Expected',
        headline: folder ? `${name} · ${folder}` : name,
        description: link
          ? `SPC Mesoscale Discussion. ${link}`
          : 'SPC Mesoscale Discussion.',
        areaDesc: name,
        sent: now,
        effective: now,
        ends,
        messageType: 'Alert',
        status: 'Actual',
      },
    });
  }

  return out;
}

export async function fetchSpcMesoscaleDiscussions(): Promise<Record<string, unknown>[]> {
  try {
    const res = await fetch(SPC_MD_QUERY, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error('spc-md fetch', res.status, await res.text().then((t) => t.slice(0, 300)));
      return [];
    }
    const data = (await res.json()) as { features?: Record<string, unknown>[] };
    return spcMdToNwsFeatures(data);
  } catch (e) {
    console.error('spc-md fetch failed', e);
    return [];
  }
}
