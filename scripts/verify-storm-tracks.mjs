// Verify the new eventMotionDescription parser would produce tracks for the
// active warning backlog before pushing the lib change to Vercel.
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
const env = Object.fromEntries(
  readFileSync('/Users/tylerdixon/Desktop/midsouthwx-main/.env.local', 'utf8')
    .split('\n').filter((l) => l && l.includes('=') && !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i+1).trim().replace(/^['"]|['"]$/g, '')]; }),
);
const supa = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const EMD_RE = /\.\.\.\s*(\d+(?:\.\d+)?)\s*DEG\s*\.\.\.\s*(\d+(?:\.\d+)?)\s*KT\s*\.\.\.\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/i;
const paramStrings = (v) => Array.isArray(v) ? v.map(String) : typeof v === 'string' ? [v] : [];

const { data } = await supa
  .from('nws_alerts')
  .select('event, area_desc, raw')
  .in('status', ['new', 'dispatched', 'skipped'])
  .gte('expires_at', new Date().toISOString())
  .limit(500);

let warningEvents = 0, withEmd = 0, parsable = 0;
const samples = [];
for (const r of data ?? []) {
  const e = (r.event ?? '').toLowerCase();
  if (!(e.includes('warning') || e.includes('emergency') || e.includes('special marine'))) continue;
  warningEvents++;
  const emd = r.raw?.properties?.parameters?.eventMotionDescription;
  if (!emd) continue;
  withEmd++;
  for (const s of paramStrings(emd)) {
    const m = s.match(EMD_RE);
    if (m) {
      parsable++;
      if (samples.length < 5) {
        samples.push({
          event: r.event,
          area: (r.area_desc ?? '').slice(0, 60),
          deg: parseFloat(m[1]), kts: parseFloat(m[2]),
          lat: parseFloat(m[3]), lon: parseFloat(m[4]),
          raw: s,
        });
      }
      break;
    }
  }
}

console.log(`warning/emergency events:           ${warningEvents}`);
console.log(`  with eventMotionDescription:      ${withEmd}`);
console.log(`  parseable (track will render):    ${parsable}`);
console.log('');
console.log('samples:');
for (const s of samples) console.log(JSON.stringify(s));
