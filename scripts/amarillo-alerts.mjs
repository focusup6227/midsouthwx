// One-off: pull active alerts around Amarillo/Canyon/Hereford and show whether
// they reference each other. Reads .env.local for service-role creds.
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync('/Users/tylerdixon/Desktop/midsouthwx-main/.env.local', 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')];
    }),
);

const supa = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

// Counties in the screenshot: Potter (Amarillo), Randall (Canyon), Deaf Smith
// (Hereford), Carson, Armstrong, Donley, Wheeler, Gray (Pampa).
const COUNTY_RX =
  /(Potter|Randall|Deaf Smith|Carson|Armstrong|Donley|Wheeler|Gray|Hutchinson|Roberts|Hemphill|Hall|Briscoe|Castro|Parmer|Swisher|Oldham), TX/i;

const { data, error } = await supa
  .from('nws_alerts')
  .select('id, nws_id, event, status, severity, effective, expires_at, area_desc, raw, ingested_at')
  .in('event', [
    'Severe Thunderstorm Warning',
    'Tornado Warning',
    'Special Weather Statement',
    'Severe Weather Statement',
  ])
  .gte('expires_at', new Date().toISOString())
  .order('ingested_at', { ascending: false })
  .limit(200);

if (error) {
  console.error(error);
  process.exit(1);
}

const hits = (data ?? []).filter((r) => COUNTY_RX.test(r.area_desc ?? ''));
console.log(`active alerts touching screenshot area: ${hits.length}`);
console.log('');

for (const r of hits) {
  const refs = r.raw?.properties?.references;
  const refList = Array.isArray(refs) ? refs : refs ? [refs] : [];
  const refIds = refList
    .map((x) => (typeof x === 'string' ? x : x?.['@id'] || x?.identifier))
    .filter(Boolean);
  console.log(`─ ${r.event} [${r.status}]`);
  console.log(`  id:        ${r.id}`);
  console.log(`  nws_id:    ${r.nws_id}`);
  console.log(`  effective: ${r.effective}`);
  console.log(`  expires:   ${r.expires_at}`);
  console.log(`  severity:  ${r.severity}`);
  console.log(`  area:      ${(r.area_desc ?? '').slice(0, 180)}`);
  console.log(`  refs:      ${refIds.length ? refIds.join('  ') : '(none)'}`);
  console.log(`  msg_type:  ${r.raw?.properties?.messageType ?? '-'}`);
  console.log(`  ingested:  ${r.ingested_at}`);
  console.log('');
}
