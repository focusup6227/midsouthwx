import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
const env = Object.fromEntries(
  readFileSync('/Users/tylerdixon/Desktop/midsouthwx-main/.env.local', 'utf8')
    .split('\n').filter((l) => l && l.includes('=') && !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i+1).trim().replace(/^['"]|['"]$/g, '')]; }),
);
const supa = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const { data } = await supa
  .from('nws_alerts')
  .select('event, raw')
  .eq('event', 'Severe Thunderstorm Warning')
  .in('status', ['new', 'dispatched', 'skipped'])
  .gte('expires_at', new Date().toISOString())
  .limit(1);
const row = data?.[0];
if (!row) { console.log('no active SVR found'); process.exit(0); }
const props = row.raw?.properties ?? {};
console.log('top-level property keys:', Object.keys(props).sort());
console.log('');
console.log('parameters keys:        ', Object.keys(props.parameters ?? {}).sort());
console.log('');
console.log('parameters JSON:');
console.log(JSON.stringify(props.parameters, null, 2));
