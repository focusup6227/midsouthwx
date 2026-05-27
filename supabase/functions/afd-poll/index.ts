// Poll the latest Area Forecast Discussion for each Mid-South WFO and upsert
// into public.nws_afd. AFDs are usually published ~4×/day per office; running
// every 30 minutes (cron) catches updates without thrashing api.weather.gov.
//
// Requires secrets:
//   NWS_USER_AGENT      — contact string per api.weather.gov policy
//   CRON_INVOKER_JWT    — optional bearer token gate for cron invocations
//
// Mirrors the spc-poll pattern (single-shot, no self-reschedule). Failures on
// one WFO don't abort the rest.

import { serviceClient, json, withHealthLog } from './supabase.ts';
import { summarizePendingAfds } from './summarize.ts';

declare const EdgeRuntime: { waitUntil: (p: Promise<unknown>) => void };

// Mid-South + adjacent WFOs whose AFDs the operator regularly references.
// Edit here to add more offices (e.g., HUN, BMX) — keeping a fixed list keeps
// the poll bounded and matches how the operator uses AFDs in practice.
const WFOS = [
  'MEG', // Memphis, TN
  'LZK', // Little Rock, AR
  'JAN', // Jackson, MS
  'OHX', // Nashville, TN
  'MOB', // Mobile, AL / coastal MS
  'HUN', // Huntsville, AL
  'PAH', // Paducah, KY/IL/MO/IN
];

type ProductListItem = {
  '@id'?: string;
  id?: string;
  issuanceTime?: string;
  productCode?: string;
};

type ProductDoc = {
  '@id'?: string;
  id?: string;
  productCode?: string;
  productText?: string;
  issuanceTime?: string;
  issuingOffice?: string;
};

type FetchResult = { wfo: string; ok: boolean; product_id?: string; error?: string };

Deno.serve(withHealthLog('afd-poll', async (req) => {
  if (req.method !== 'POST' && req.method !== 'GET') return json({ ok: false }, 405);

  const cronJwt = Deno.env.get('CRON_INVOKER_JWT');
  if (cronJwt) {
    const auth = req.headers.get('Authorization');
    if (auth !== `Bearer ${cronJwt}`) {
      return json({ ok: false, error: 'unauthorized' }, 401);
    }
  }

  const ua = Deno.env.get('NWS_USER_AGENT');
  if (!ua?.trim()) return json({ ok: false, error: 'NWS_USER_AGENT secret missing' }, 500);

  const supa = serviceClient();
  const results: FetchResult[] = [];

  // Sequential per-WFO to stay polite. Each WFO is two HTTP calls (list + doc)
  // so 7 WFOs ≈ 14 calls per run. Total wall-time ~6-10s in practice.
  for (const wfo of WFOS) {
    try {
      const listUrl = `https://api.weather.gov/products/types/AFD/locations/${wfo}`;
      const listRes = await fetch(listUrl, {
        headers: { 'User-Agent': ua, Accept: 'application/ld+json, application/json' },
        signal: AbortSignal.timeout(20_000),
      });
      if (!listRes.ok) {
        results.push({ wfo, ok: false, error: `list HTTP ${listRes.status}` });
        continue;
      }
      const list = (await listRes.json()) as { '@graph'?: ProductListItem[] };
      const latest = list['@graph']?.[0];
      if (!latest) {
        results.push({ wfo, ok: false, error: 'no products in list' });
        continue;
      }
      const productId = latest['@id'] ?? latest.id;
      if (!productId) {
        results.push({ wfo, ok: false, error: 'product has no id' });
        continue;
      }

      const docRes = await fetch(productId, {
        headers: { 'User-Agent': ua, Accept: 'application/ld+json, application/json' },
        signal: AbortSignal.timeout(20_000),
      });
      if (!docRes.ok) {
        results.push({ wfo, ok: false, error: `doc HTTP ${docRes.status}` });
        continue;
      }
      const doc = (await docRes.json()) as ProductDoc;
      const text = doc.productText?.trim();
      const issuanceTime = doc.issuanceTime ?? latest.issuanceTime;
      if (!text || !issuanceTime) {
        results.push({ wfo, ok: false, error: 'missing productText or issuanceTime' });
        continue;
      }

      const parsed = parseAfdSections(text);
      const { error } = await supa.rpc('nws_afd_upsert', {
        p_wfo: wfo,
        p_product_id: productId,
        p_issued_at: issuanceTime,
        p_text: text,
        p_synopsis: parsed.synopsis,
        p_short_term: parsed.shortTerm,
        p_long_term: parsed.longTerm,
        p_aviation: parsed.aviation,
        p_raw: doc as unknown as Record<string, unknown>,
      });
      if (error) {
        results.push({ wfo, ok: false, error: error.message });
        continue;
      }
      results.push({ wfo, ok: true, product_id: productId });
    } catch (e) {
      results.push({ wfo, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  const okCount = results.filter((r) => r.ok).length;

  // Fire-and-forget AI summary pass. New AFD rows (just upserted with
  // ai_summary=null) get a 2-sentence digest written back. Wrapped in
  // EdgeRuntime.waitUntil so a slow DeepSeek call doesn't extend the poll
  // response time. Failures are silent and self-heal on the next run.
  try {
    EdgeRuntime.waitUntil(summarizePendingAfds(supa));
  } catch {
    // Local dev may not expose EdgeRuntime.waitUntil — ignore.
  }

  return json({ ok: okCount > 0, results });
}));

// AFDs have section headers like ".SYNOPSIS...", ".SHORT TERM /HEADER/...", etc.,
// ending at the literal "&&" delimiter. Capture each section's body; section
// names are uppercase and may include /annotations/ in the header line.
function parseAfdSections(text: string): {
  synopsis: string | null;
  shortTerm: string | null;
  longTerm: string | null;
  aviation: string | null;
} {
  const sections = new Map<string, string>();
  // Split into chunks at lines that start with a dot-prefixed uppercase header
  // (e.g., ".SYNOPSIS...", ".SHORT TERM /HEADER/...").
  const lines = text.split(/\r?\n/);
  let currentName: string | null = null;
  let buffer: string[] = [];

  const flush = () => {
    if (!currentName) return;
    const body = buffer.join('\n').trim();
    if (body) sections.set(currentName, body);
    buffer = [];
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    // Section break delimiter — flush and clear.
    if (line === '&&') {
      flush();
      currentName = null;
      continue;
    }
    const header = line.match(/^\.([A-Z][A-Z0-9 /-]*?)\.\.\.(.*)$/);
    if (header) {
      flush();
      // Strip /.../ annotations from the header so ".SHORT TERM /THROUGH MON/..."
      // and ".SHORT TERM /THROUGH SAT/..." both bucket under "SHORT TERM".
      currentName = header[1]
        .replace(/\s*\/[^/]*\//g, '')
        .trim()
        .toUpperCase();
      // Some AFD headers contain content on the same line after "...".
      const tail = header[2].trim();
      if (tail) buffer.push(tail);
      continue;
    }
    if (currentName) buffer.push(line);
  }
  flush();

  const pick = (...names: string[]): string | null => {
    for (const n of names) {
      const body = sections.get(n);
      if (body) return body;
    }
    return null;
  };

  return {
    synopsis:  pick('SYNOPSIS', 'KEY MESSAGES', 'DISCUSSION'),
    shortTerm: pick('SHORT TERM', 'NEAR TERM'),
    longTerm:  pick('LONG TERM', 'EXTENDED'),
    aviation:  pick('AVIATION'),
  };
}
