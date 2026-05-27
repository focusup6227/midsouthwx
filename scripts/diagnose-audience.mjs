#!/usr/bin/env node
// Diagnose why a particular subscriber got (or didn't get) a particular alert.
// Pulls the subscriber's location/county, the last day of tornado warnings,
// and for each warning the audience the dispatcher would have used.

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

console.log('=== Subscribers (active) ===');
const { data: subs, error: subErr } = await supa
  .from('subscribers')
  .select('id, display_name, status, zip, county_fips, telegram_chat_id, home_address')
  .eq('status', 'active');
if (subErr) { console.error(subErr); process.exit(1); }
for (const s of subs ?? []) {
  console.log(`  ${s.id.slice(0, 8)}  ${s.display_name}  zip=${s.zip}  county_fips=${s.county_fips ?? 'NULL'}  chat=${s.telegram_chat_id ?? 'unenrolled'}`);
  if (s.home_address) console.log(`    home: ${s.home_address}`);
}

// Subscriber location: county_fips above is the audience-matching key; we
// don't need WKT here since nws_alert_audience does the geo work.

console.log('\n=== Recent Tornado Warnings (last 24h) ===');
const { data: warns, error: warnErr } = await supa
  .from('nws_alerts')
  .select('id, nws_id, event, area_desc, status, ingested_at, expires_at')
  .eq('event', 'Tornado Warning')
  .gte('ingested_at', since)
  .order('ingested_at', { ascending: false })
  .limit(20);
if (warnErr) { console.error(warnErr); process.exit(1); }
console.log(`  ${warns?.length ?? 0} warnings`);

console.log('\n=== Audience the dispatcher would have used (region_filter=null) ===');
for (const w of warns ?? []) {
  const { data: aud, error: audErr } = await supa.rpc('nws_alert_audience', {
    p_alert_id: w.id,
    p_region_filter: null,
  });
  if (audErr) { console.log(`  ${w.id.slice(0, 8)} ERROR: ${audErr.message}`); continue; }
  const n = (aud ?? []).length;
  const truncatedArea = (w.area_desc ?? '').slice(0, 70);
  console.log(`  ${w.id.slice(0, 8)}  status=${w.status}  recipients=${n}  area="${truncatedArea}"`);
}

console.log('\n=== Dispatched messages tied to those warnings ===');
const warnIds = (warns ?? []).map(w => w.id);
if (warnIds.length) {
  const { data: msgs } = await supa
    .from('messages')
    .select('id, status, source, nws_alert_id, recipient_count, created_at')
    .in('nws_alert_id', warnIds)
    .order('created_at', { ascending: false });
  for (const m of msgs ?? []) {
    const w = warns.find(x => x.id === m.nws_alert_id);
    console.log(`  msg ${m.id.slice(0, 8)}  status=${m.status}  source=${m.source}  recipients=${m.recipient_count}  alert="${(w?.area_desc ?? '').slice(0, 50)}"`);
  }
}

console.log('\n=== outbound_queue entries for those messages (delivered to whom?) ===');
if (warnIds.length) {
  const { data: msgs2 } = await supa
    .from('messages')
    .select('id')
    .in('nws_alert_id', warnIds);
  const msgIds = (msgs2 ?? []).map(m => m.id);
  if (msgIds.length) {
    const { data: q } = await supa
      .from('outbound_queue')
      .select('id, message_id, subscriber_id, status, sent_at, last_error')
      .in('message_id', msgIds);
    for (const row of q ?? []) {
      const subShort = row.subscriber_id?.slice(0, 8);
      console.log(`  q#${row.id}  msg=${row.message_id.slice(0, 8)}  sub=${subShort}  status=${row.status}  sent_at=${row.sent_at ?? '—'}  err=${row.last_error ?? ''}`);
    }
  }
}
