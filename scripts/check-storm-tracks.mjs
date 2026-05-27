// Probe: how many currently-visible warnings (status: new/dispatched/skipped)
// actually carry storm motion + location parameters NWS uses to build a track?
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync('/Users/tylerdixon/Desktop/midsouthwx-main/.env.local', 'utf8')
    .split('\n').filter((l) => l && l.includes('=') && !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]; }),
);
const supa = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const { data } = await supa
  .from('nws_alerts')
  .select('id, event, status, area_desc, raw')
  .in('status', ['new', 'dispatched', 'skipped'])
  .gte('expires_at', new Date().toISOString())
  .limit(500);

let total = 0;
let warningEvents = 0;
let hasLoc = 0;
let hasMotion = 0;
let hasBoth = 0;
const examples = [];

for (const r of data ?? []) {
  total++;
  const e = (r.event ?? '').toLowerCase();
  if (!(e.includes('warning') || e.includes('emergency') || e.includes('special marine'))) continue;
  warningEvents++;
  const params = r.raw?.properties?.parameters;
  const loc = params?.stormLocation;
  const mot = params?.stormMotion;
  if (loc) hasLoc++;
  if (mot) hasMotion++;
  if (loc && mot) {
    hasBoth++;
    if (examples.length < 3) {
      examples.push({
        event: r.event,
        status: r.status,
        area: (r.area_desc ?? '').slice(0, 80),
        stormLocation: loc,
        stormMotion: mot,
      });
    }
  }
}

console.log(`active alerts:                          ${total}`);
console.log(`  of which warning/emergency events:    ${warningEvents}`);
console.log(`    with stormLocation parameter:       ${hasLoc}`);
console.log(`    with stormMotion parameter:         ${hasMotion}`);
console.log(`    with BOTH (track will render):      ${hasBoth}`);
console.log('');
for (const ex of examples) {
  console.log(JSON.stringify(ex, null, 2));
  console.log('---');
}
