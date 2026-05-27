/** SPC Mesoscale Discussions — not in api.weather.gov/alerts/active; NOAA MapServer feed. */

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';

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

function mdNumberFromName(name: string): number | null {
  const m = name.match(/(\d{1,5})\s*$/);
  if (!m) return null;
  return parseInt(m[1], 10);
}

/** Pull the raw product text out of the SPC MD HTML page (wrapped in <pre>). */
function extractPreText(html: string): string | null {
  const m = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
  if (!m) return null;
  return m[1]
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** Trim AWIPS header + LAT/LON footer so the operator sees just the prose. */
function cleanSpcMdText(raw: string): string {
  let t = raw.replace(/\r/g, '');
  const startIdx = t.search(/Mesoscale Discussion\s+\d/);
  if (startIdx > 0) t = t.slice(startIdx);
  const latLonIdx = t.search(/^LAT\.{3}LON/m);
  if (latLonIdx > -1) t = t.slice(0, latLonIdx);
  return t.replace(/\n\s*\$\$\s*$/, '').trim();
}

async function fetchSpcMdText(num: number): Promise<string | null> {
  const padded = String(num).padStart(4, '0');
  const url = `https://www.spc.noaa.gov/products/md/md${padded}.html`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;
    const html = await res.text();
    const pre = extractPreText(html);
    if (!pre) return null;
    return cleanSpcMdText(pre);
  } catch (e) {
    console.error('spc-md fetchText', num, e);
    return null;
  }
}

/**
 * Map SPC mesoscale-discussion concern + watch-issuance probability to the
 * standard NWS severity buckets so the radar UI can tint MDs by how
 * threatening they are, not just "purple = MD". Folderpath gives the
 * primary concern (e.g. "Concerning Tornado Watch 0250"); the body text adds
 * the watch-issuance probability when no watch is in effect yet.
 */
function classifyMdSeverity(folderpath: string, text: string | null): string {
  const fp = (folderpath ?? '').toLowerCase();
  const txt = (text ?? '').toLowerCase();

  const probMatch = txt.match(/probability of (?:tornado(?:es)?|severe|watch) (?:issuance|tornadoes)[.\s]+(\d{1,3})\s*percent/);
  const prob = probMatch ? parseInt(probMatch[1], 10) : null;

  const concernsTornadoWatch =
    fp.includes('tornado watch') ||
    /concerning[\s.]*tornado watch/.test(txt) ||
    /tornado watch likely/.test(txt);
  const concernsSevereWatch =
    fp.includes('severe thunderstorm watch') ||
    /concerning[\s.]*severe thunderstorm watch/.test(txt) ||
    /severe thunderstorm watch\s+(?:likely|possible)/.test(txt);
  const concernsSeverePotential =
    fp.includes('severe potential') ||
    /concerning[\s.]*severe potential/.test(txt);
  const concernsWinter = /snow|winter|ice|freezing|sleet|blizzard/.test(fp);

  if (concernsTornadoWatch) return prob != null && prob >= 60 ? 'Extreme' : 'Severe';
  if (concernsSevereWatch) return prob != null && prob >= 60 ? 'Severe' : 'Moderate';
  if (concernsSeverePotential) return 'Moderate';
  if (concernsWinter) return 'Minor';
  return 'Moderate';
}

type CachedMd = { description: string | null; severity: string | null };

/** Convert MapServer MD features into NWS-style GeoJSON features for nws_upsert_geojson_feature. */
export async function spcMdToNwsFeatures(
  fc: { features?: Record<string, unknown>[] },
  cache: Map<string, CachedMd>,
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  const now = new Date().toISOString();

  // Resolve text in parallel — fetches are independent and there are usually
  // only a handful of active MDs at once. Cached rows skip the SPC fetch.
  const work = (fc.features ?? []).map(async (f) => {
    const geom = f.geometry as { type?: string } | null | undefined;
    if (!geom || (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon')) return null;

    const props = (f.properties ?? {}) as SpcMdProps;
    const name = (props.name ?? '').trim();
    if (!name) return null;

    const nwsId = spcMdNwsId(name);
    const ends = parseMdExpiresUtc(props.folderpath) ?? new Date(Date.now() + 2 * 3600_000).toISOString();
    const folder = props.folderpath?.trim() ?? '';
    const num = mdNumberFromName(name);
    // Construct a clean canonical URL from the MD number rather than using
    // popupinfo, which the MapServer returns as raw HTML (<a href=...>...</a>)
    // and reads like noise in the <pre> Description block on /nws/<id>.
    const link = num != null
      ? `https://www.spc.noaa.gov/products/md/md${String(num).padStart(4, '0')}.html`
      : '';

    // MD text is invariant once issued, so reuse cached prose when present.
    // The "just a link" placeholder we used to store is ~50 chars; anything
    // longer must already be the real product body.
    const cached = cache.get(nwsId);
    const cachedFullText =
      cached?.description && cached.description.length > 200 ? cached.description : null;

    let body: string | null = cachedFullText;
    if (!body && num != null) {
      body = await fetchSpcMdText(num);
    }

    const severity = classifyMdSeverity(folder, body);

    const description = body
      ? (link ? `${body}\n\n— ${link}` : body)
      : (link ? `SPC Mesoscale Discussion. ${link}` : 'SPC Mesoscale Discussion.');

    return {
      type: 'Feature',
      id: nwsId,
      geometry: geom,
      properties: {
        id: nwsId,
        '@id': nwsId,
        event: 'Mesoscale Discussion',
        severity,
        certainty: 'Possible',
        urgency: 'Expected',
        headline: folder ? `${name} · ${folder}` : name,
        description,
        areaDesc: name,
        sent: now,
        effective: now,
        ends,
        messageType: 'Alert',
        status: 'Actual',
      },
    } as Record<string, unknown>;
  });

  const results = await Promise.all(work);
  for (const r of results) {
    if (r) out.push(r);
  }
  return out;
}

export async function fetchSpcMesoscaleDiscussions(
  supa: SupabaseClient,
): Promise<Record<string, unknown>[]> {
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

    // Pre-flight: ask the DB what we already have for these MDs so we can
    // skip re-fetching invariant product text on every minute-by-minute poll.
    const ids: string[] = [];
    for (const f of data.features ?? []) {
      const name = ((f.properties as SpcMdProps | undefined)?.name ?? '').trim();
      if (name) ids.push(spcMdNwsId(name));
    }
    const cache = new Map<string, CachedMd>();
    if (ids.length > 0) {
      const { data: rows, error } = await supa
        .from('nws_alerts')
        .select('nws_id, description, severity')
        .in('nws_id', ids);
      if (error) {
        console.error('spc-md cache lookup', error.message);
      } else {
        for (const r of rows ?? []) {
          cache.set(r.nws_id as string, {
            description: (r.description as string | null) ?? null,
            severity: (r.severity as string | null) ?? null,
          });
        }
      }
    }

    return await spcMdToNwsFeatures(data, cache);
  } catch (e) {
    console.error('spc-md fetch failed', e);
    return [];
  }
}
