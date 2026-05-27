#!/usr/bin/env node
// Wider lens: all messages Tyler has received in the last 24h, with full
// body + the linked nws_alerts area_desc/event so we can tell whether the
// "New Orleans" alert was really for his area (just with NO area_desc) or
// whether the dispatcher mis-routed it.

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

const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

// Look up Tyler's full UUID
const { data: subRow } = await supa
  .from('subscribers')
  .select('id')
  .ilike('display_name', 'Tyler%')
  .maybeSingle();
const TYLER_UUID = subRow?.id;
if (!TYLER_UUID) { console.error('Could not find Tyler'); process.exit(1); }
console.log(`Tyler uuid: ${TYLER_UUID}\n`);

// Every outbound row for Tyler in the last 24h, joined back to message + alert
const { data: q } = await supa
  .from('outbound_queue')
  .select('id, message_id, status, sent_at, last_error')
  .eq('subscriber_id', TYLER_UUID)
  .gte('sent_at', since)
  .order('sent_at', { ascending: false });

const msgIds = [...new Set((q ?? []).map(r => r.message_id))];
const { data: msgs } = msgIds.length
  ? await supa
      .from('messages')
      .select('id, body_md, source, status, nws_alert_id, created_at')
      .in('id', msgIds)
  : { data: [] };
const msgById = new Map((msgs ?? []).map(m => [m.id, m]));

const alertIds = [...new Set((msgs ?? []).map(m => m.nws_alert_id).filter(Boolean))];
const { data: alerts } = alertIds.length
  ? await supa
      .from('nws_alerts')
      .select('id, event, area_desc, headline, severity, status, raw')
      .in('id', alertIds)
  : { data: [] };
const alertById = new Map((alerts ?? []).map(a => [a.id, a]));

console.log(`=== Everything Tyler received in the last 24h (${q?.length ?? 0} sends) ===\n`);
for (const row of q ?? []) {
  const m = msgById.get(row.message_id);
  const a = m?.nws_alert_id ? alertById.get(m.nws_alert_id) : null;
  console.log(`---`);
  console.log(`outbound #${row.id}  sent ${row.sent_at}`);
  console.log(`  message: ${m?.id?.slice(0, 8)}  source=${m?.source}  status=${m?.status}`);
  if (a) {
    console.log(`  alert event: "${a.event}"`);
    console.log(`  alert area_desc: ${a.area_desc}`);
    console.log(`  alert headline: ${a.headline}`);
    console.log(`  alert severity: ${a.severity}  alert status: ${a.status}`);
    // Sender / WFO info from raw
    const props = a.raw?.properties ?? {};
    console.log(`  sender: ${props.sender ?? props.senderName ?? '?'}  senderName: ${props.senderName ?? '?'}`);
  } else if (m?.source === 'recap') {
    console.log(`  (event recap, no single nws_alert_id)`);
  }
  console.log(`  body_md preview:`);
  console.log('    ' + (m?.body_md ?? '').split('\n').slice(0, 8).join('\n    '));
}

// For every severe-weather warning involving Louisiana, what was the
// audience? If recipients=0, the system correctly excluded Tyler. If >0
// and includes Tyler, that's a routing bug.
console.log('\n\n=== Louisiana / Gulf-area warnings — did audience include Tyler? ===');
const { data: tor } = await supa
  .from('nws_alerts')
  .select('id, event, area_desc, status')
  .ilike('area_desc', '%LA%')
  .gte('ingested_at', since)
  .order('ingested_at', { ascending: false })
  .limit(30);
for (const a of tor ?? []) {
  const { data: aud, error: audErr } = await supa.rpc('nws_alert_audience', {
    p_alert_id: a.id,
    p_region_filter: null,
  });
  if (audErr) { console.log(`  ${a.id.slice(0, 8)} ERROR: ${audErr.message}`); continue; }
  const includesTyler = (aud ?? []).some(r => r.subscriber_id === TYLER_UUID);
  const tag = includesTyler ? '⚠️  TYLER INCLUDED' : '✓ Tyler excluded';
  console.log(`  ${a.id.slice(0, 8)}  ${a.event}  status=${a.status}  ${tag}  area="${(a.area_desc ?? '').slice(0, 70)}"`);
}

console.log('\n=== Jackson, MS warnings — did audience include Tyler? ===');
const { data: jx } = await supa
  .from('nws_alerts')
  .select('id, event, area_desc, status')
  .ilike('area_desc', '%Jackson%MS%')
  .gte('ingested_at', since)
  .order('ingested_at', { ascending: false })
  .limit(20);
for (const a of jx ?? []) {
  const { data: aud } = await supa.rpc('nws_alert_audience', {
    p_alert_id: a.id,
    p_region_filter: null,
  });
  const includesTyler = (aud ?? []).some(r => r.subscriber_id === TYLER_UUID);
  const tag = includesTyler ? '⚠️  TYLER INCLUDED' : '✓ Tyler excluded';
  console.log(`  ${a.id.slice(0, 8)}  ${a.event}  status=${a.status}  recipients=${(aud ?? []).length}  ${tag}  area="${(a.area_desc ?? '').slice(0, 70)}"`);
}
