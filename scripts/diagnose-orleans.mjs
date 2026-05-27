#!/usr/bin/env node
// Look for any message ever sent to Tyler whose body or linked alert
// references New Orleans / Louisiana, in case a manual send or a recap
// mixed in non-local geographic text.

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const env = {};
for (const line of readFileSync(resolve(here, '..', '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^"|"$/g, '');
}
const supa = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const TYLER_UUID = 'e209c80e-6682-42ee-a77e-fb0ced488b97';

// Every message sent to Tyler, full body
const { data: q } = await supa
  .from('outbound_queue')
  .select('id, message_id, sent_at, status')
  .eq('subscriber_id', TYLER_UUID)
  .eq('status', 'sent')
  .order('sent_at', { ascending: false })
  .limit(50);

const msgIds = [...new Set((q ?? []).map(r => r.message_id))];
const { data: msgs } = msgIds.length
  ? await supa
      .from('messages')
      .select('id, body_md, source, nws_alert_id, created_at')
      .in('id', msgIds)
  : { data: [] };
const msgById = new Map((msgs ?? []).map(m => [m.id, m]));

const alertIds = [...new Set((msgs ?? []).map(m => m.nws_alert_id).filter(Boolean))];
const { data: alerts } = alertIds.length
  ? await supa
      .from('nws_alerts')
      .select('id, event, area_desc, headline')
      .in('id', alertIds)
  : { data: [] };
const alertById = new Map((alerts ?? []).map(a => [a.id, a]));

console.log(`Searching ${q?.length ?? 0} messages Tyler received...\n`);
const NEEDLE = /orleans|louisiana|\bLA\b|jefferson|plaquemines|lafourche/i;
let matches = 0;
for (const row of q ?? []) {
  const m = msgById.get(row.message_id);
  const a = m?.nws_alert_id ? alertById.get(m.nws_alert_id) : null;
  const haystack = [
    m?.body_md ?? '',
    a?.area_desc ?? '',
    a?.event ?? '',
    a?.headline ?? '',
  ].join(' || ');
  if (NEEDLE.test(haystack)) {
    matches++;
    console.log(`MATCH outbound #${row.id} sent ${row.sent_at}`);
    console.log(`  message ${m?.id?.slice(0, 8)} source=${m?.source}`);
    if (a) console.log(`  alert: event="${a.event}" area_desc="${a.area_desc}"`);
    console.log(`  body:\n    ${(m?.body_md ?? '').split('\n').join('\n    ')}`);
    console.log();
  }
}
if (matches === 0) {
  console.log('No message Tyler received contains Orleans/Louisiana/LA/Jefferson/Plaquemines/Lafourche.');
  console.log('\nShowing ALL 50 most recent message bodies (truncated) so we can spot what he might be referring to:\n');
  for (const row of q ?? []) {
    const m = msgById.get(row.message_id);
    const a = m?.nws_alert_id ? alertById.get(m.nws_alert_id) : null;
    const firstLine = (m?.body_md ?? '').split('\n')[0].slice(0, 100);
    const areaPart = a ? `[${a.event} · ${a.area_desc}]` : `[${m?.source}]`;
    console.log(`  ${row.sent_at?.slice(0, 19)}  ${areaPart}  ${firstLine}`);
  }
}
