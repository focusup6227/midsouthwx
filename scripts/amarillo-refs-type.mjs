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
  .select('nws_id, raw')
  .eq('id', '2859a535-30ad-457e-98c8-a328ed2a8c3e')
  .single();
const refs = data.raw?.properties?.references;
console.log('typeof references:', typeof refs);
console.log('isArray:          ', Array.isArray(refs));
console.log('JSON:             ', JSON.stringify(refs, null, 2).slice(0, 600));
