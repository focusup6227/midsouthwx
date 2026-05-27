// One-off: re-run nws_mark_references_superseded over the active backlog.
// Pre-fix nws-poll skipped every NWS-array `references` field, so every
// continuation/update alert still has its predecessors active even though
// NWS told us to retire them. This walks the still-active rows that have a
// non-empty references array and asks the existing RPC to do its job.
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync('/Users/tylerdixon/Desktop/midsouthwx-main/.env.local', 'utf8')
    .split('\n').filter((l) => l && l.includes('=') && !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]; }),
);
const supa = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const PAGE = 500;
let from = 0;
let totalRows = 0;
let totalUrls = 0;
let totalFailures = 0;

while (true) {
  const { data, error } = await supa
    .from('nws_alerts')
    .select('id, raw')
    .in('status', ['new', 'dispatched', 'skipped'])
    .order('ingested_at', { ascending: false })
    .range(from, from + PAGE - 1);
  if (error) { console.error(error); process.exit(1); }
  if (!data || data.length === 0) break;

  for (const row of data) {
    const refs = row.raw?.properties?.references;
    let urls = [];
    if (Array.isArray(refs)) {
      urls = refs
        .map((r) => (typeof r === 'string' ? r : r?.['@id'] || r?.identifier))
        .filter((u) => typeof u === 'string' && u.length > 0);
    } else if (typeof refs === 'string' && refs.trim()) {
      urls = refs.trim().split(/\s+/).filter(Boolean);
    }
    if (!urls.length) continue;
    totalRows++;
    const { error: rpcErr } = await supa.rpc('nws_mark_references_superseded', {
      p_reference_urls: urls,
    });
    if (rpcErr) {
      console.error('supersede failed for', row.id, rpcErr.message);
      totalFailures++;
    } else {
      totalUrls += urls.length;
    }
  }

  if (data.length < PAGE) break;
  from += PAGE;
}

// Sanity: count of newly superseded rows.
const { count, error: countErr } = await supa
  .from('nws_alerts')
  .select('id', { count: 'exact', head: true })
  .eq('status', 'superseded');
if (countErr) console.error(countErr);

console.log(`processed active rows with references: ${totalRows}`);
console.log(`supersede RPC calls (one per row):     ${totalRows - totalFailures}`);
console.log(`reference URLs passed:                 ${totalUrls}`);
console.log(`failures:                              ${totalFailures}`);
console.log(`total nws_alerts now in superseded:    ${count}`);
