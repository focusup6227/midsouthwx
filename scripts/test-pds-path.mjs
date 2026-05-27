#!/usr/bin/env node
// One-shot test harness for the PDS / Tornado Emergency code path.
//
// Phase 1 (safe): inspects current auto_alert_rules and active alerts so the
// operator can see whether running phase 2 risks triggering real Telegram
// sends. Phase 2 (--insert) inserts a synthetic nws_alerts row with PDS
// markers; whether it actually pages subscribers depends on the rule set.

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const envFile = resolve(here, '..', '.env.local');
const env = {};
for (const line of readFileSync(envFile, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^"|"$/g, '');
}

const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}

const supa = createClient(url, key, { auth: { persistSession: false } });

const mode = process.argv[2] ?? 'inspect';

async function inspect() {
  console.log('=== auto_alert_rules (enabled) ===');
  const { data: rules, error: rulesErr } = await supa
    .from('auto_alert_rules')
    .select('id, event_pattern, min_severity, mode, region_filter, template_id, enabled')
    .eq('enabled', true)
    .order('created_at');
  if (rulesErr) { console.error(rulesErr); return; }
  if (!rules?.length) {
    console.log('  (none enabled — dispatcher will skip any synthetic alert)');
  } else {
    for (const r of rules) {
      console.log(`  • pattern="${r.event_pattern}" min_sev=${r.min_severity ?? 'any'} mode=${r.mode} template=${r.template_id ? 'set' : 'NULL'}`);
    }
  }

  console.log('\n=== auto_send_at column present? ===');
  const { error: colErr } = await supa.from('messages').select('id, auto_send_at').limit(1);
  console.log(colErr ? `  ERROR: ${colErr.message}` : '  yes ✓');

  console.log('\n=== promote_auto_send_messages RPC present? ===');
  try {
    const { error: rpcErr } = await supa.rpc('promote_auto_send_messages');
    console.log(rpcErr ? `  ERROR: ${rpcErr.message}` : '  yes ✓ (no-op call: nothing pending to promote right now)');
  } catch (e) { console.log(`  ERROR: ${e.message}`); }

  console.log('\n=== nws_status_counts RPC present? ===');
  const { data: counts, error: countsErr } = await supa.rpc('nws_status_counts');
  if (countsErr) console.log(`  ERROR: ${countsErr.message}`);
  else console.log('  ' + counts.map(c => `${c.status}=${c.count}`).join('  '));

  console.log('\n=== Latest tornado-warning alerts (real data, not modified) ===');
  const { data: tor, error: torErr } = await supa
    .from('nws_alerts')
    .select('id, nws_id, event, severity, status, ingested_at')
    .ilike('event', 'tornado warning%')
    .order('ingested_at', { ascending: false })
    .limit(3);
  if (torErr) console.log(`  ERROR: ${torErr.message}`);
  else if (!tor?.length) console.log('  (no tornado warnings in DB)');
  else for (const a of tor) console.log(`  • ${a.id.slice(0, 8)} ${a.event} status=${a.status} ${a.ingested_at}`);

  console.log('\nNext: run with `--insert-readonly` to inject a synthetic PDS row that no rule will match (zero subscribers), or `--patch-existing <alert_id>` to add PDS markers to an existing alert.');
}

const SYNTHETIC_EVENT = 'PDS Test Tornado Warning'; // unlikely to match any pattern
const SYNTHETIC_NWS_ID = 'test:pds-' + Date.now();

async function insertReadonly() {
  // Synthetic row with PDS markers in raw.properties.parameters. Event name
  // is deliberately weird so no operator rule will match (dispatcher will
  // finish-skipped). The /nws page should still render the PDS badge and
  // the SevereAlertAudio component should play the tone on Realtime INSERT.
  const now = new Date();
  const expires = new Date(now.getTime() + 30 * 60 * 1000);
  const row = {
    nws_id: SYNTHETIC_NWS_ID,
    event: SYNTHETIC_EVENT,
    severity: 'Extreme',
    headline: 'PDS TEST — synthetic alert, ignore',
    description: 'Synthetic Particularly Dangerous Situation row inserted by scripts/test-pds-path.mjs. No real hazard.',
    area_desc: 'TEST AREA',
    effective: now.toISOString(),
    expires_at: expires.toISOString(),
    status: 'new',
    raw: {
      type: 'Feature',
      properties: {
        id: SYNTHETIC_NWS_ID,
        event: SYNTHETIC_EVENT,
        severity: 'Extreme',
        headline: 'PDS TEST — synthetic alert, ignore',
        description: 'PARTICULARLY DANGEROUS SITUATION (synthetic). Do not act on.',
        parameters: {
          tornadoDamageThreat: ['CONSIDERABLE'],
          eventMotionDescription: null,
        },
      },
    },
  };
  console.log(`Inserting synthetic alert nws_id=${SYNTHETIC_NWS_ID} ...`);
  const { data, error } = await supa.from('nws_alerts').insert(row).select('id, nws_id, event').single();
  if (error) { console.error(error); process.exit(1); }
  console.log(`  inserted id=${data.id}`);
  console.log('\nReload /nws — you should see:');
  console.log('  • A red pulsing TOR EMERGENCY or PDS badge on this alert');
  console.log('  • The SevereAlertAudio component plays the two-tone beep (if you clicked once on the page first)');
  console.log('  • A system Notification (if you granted permission)');
  console.log('\nWhen you are done verifying, run: node scripts/test-pds-path.mjs --cleanup');
}

async function patchExisting(id) {
  if (!id) { console.error('Usage: --patch-existing <alert_id>'); process.exit(1); }
  const { data: cur, error: e1 } = await supa
    .from('nws_alerts')
    .select('id, event, raw')
    .eq('id', id)
    .single();
  if (e1) { console.error(e1); process.exit(1); }
  const raw = cur.raw ?? { type: 'Feature', properties: {} };
  raw.properties = raw.properties ?? {};
  raw.properties.parameters = raw.properties.parameters ?? {};
  // Stash the prior value so we can restore on cleanup.
  raw.__test_prior_tornadoDamageThreat = raw.properties.parameters.tornadoDamageThreat ?? null;
  raw.properties.parameters.tornadoDamageThreat = ['CONSIDERABLE'];
  const { error: e2 } = await supa.from('nws_alerts').update({ raw }).eq('id', id);
  if (e2) { console.error(e2); process.exit(1); }
  console.log(`Patched ${id} — added tornadoDamageThreat=["CONSIDERABLE"] to raw.properties.parameters.`);
  console.log('Reload /nws — the alert should now show a PDS badge.');
  console.log('Restore with: --unpatch ' + id);
}

async function unpatch(id) {
  if (!id) { console.error('Usage: --unpatch <alert_id>'); process.exit(1); }
  const { data: cur, error: e1 } = await supa
    .from('nws_alerts')
    .select('id, raw')
    .eq('id', id)
    .single();
  if (e1) { console.error(e1); process.exit(1); }
  const raw = cur.raw ?? {};
  if (!('__test_prior_tornadoDamageThreat' in raw)) {
    console.log('  (no test marker found; nothing to revert)');
    return;
  }
  const prior = raw.__test_prior_tornadoDamageThreat;
  if (prior == null) {
    delete raw.properties?.parameters?.tornadoDamageThreat;
  } else {
    raw.properties.parameters.tornadoDamageThreat = prior;
  }
  delete raw.__test_prior_tornadoDamageThreat;
  const { error: e2 } = await supa.from('nws_alerts').update({ raw }).eq('id', id);
  if (e2) { console.error(e2); process.exit(1); }
  console.log(`Restored ${id} — removed test PDS marker.`);
}

async function cleanup() {
  // Delete the synthetic rows AND any messages/queue rows the dispatcher
  // may have created in case they were processed.
  const { data: rows } = await supa
    .from('nws_alerts')
    .select('id, nws_id')
    .like('nws_id', 'test:pds-%');
  if (!rows?.length) { console.log('No synthetic rows to clean up.'); return; }
  const alertIds = rows.map(r => r.id);
  console.log(`Cleaning up ${rows.length} synthetic alert(s) + any derived messages...`);
  const { data: msgs } = await supa.from('messages').select('id').in('nws_alert_id', alertIds);
  if (msgs?.length) {
    const msgIds = msgs.map(m => m.id);
    await supa.from('outbound_queue').delete().in('message_id', msgIds);
    await supa.from('delivery_logs').delete().in('message_id', msgIds);
    await supa.from('messages').delete().in('id', msgIds);
    console.log(`  removed ${msgIds.length} message(s) and their queue/logs`);
  }
  await supa.from('nws_alerts').delete().in('id', alertIds);
  console.log('  done.');
}

async function verifyAlertRow() {
  const { data, error } = await supa
    .from('nws_alerts')
    .select('id, nws_id, event, status, raw')
    .like('nws_id', 'test:pds-%')
    .order('ingested_at', { ascending: false })
    .limit(1);
  if (error || !data?.length) { console.log('  no synthetic row found'); return null; }
  const row = data[0];
  const params = row.raw?.properties?.parameters ?? {};
  console.log(`  id=${row.id.slice(0, 8)} status=${row.status} tornadoDamageThreat=${JSON.stringify(params.tornadoDamageThreat)}`);
  return row;
}

async function testAutoSendPromote() {
  // Find or insert a synthetic alert to associate messages with.
  let row = await verifyAlertRow();
  if (!row) {
    console.log('  no synthetic alert — inserting one first...');
    await insertReadonly();
    row = await verifyAlertRow();
    if (!row) throw new Error('failed to create synthetic alert');
  }

  // Insert a pending_approval message with empty audience + past
  // auto_send_at. Empty audience means enqueue_message_system will create
  // zero outbound_queue rows — no Telegram sends, no risk.
  const body = 'PDS TEST — synthetic message, do not send. Auto-promote test only.';
  const pastSendAt = new Date(Date.now() - 1000).toISOString();
  console.log(`\nInserting synthetic pending_approval message with auto_send_at=${pastSendAt} (past) ...`);
  const { data: msg, error: insErr } = await supa
    .from('messages')
    .insert({
      body_md: body,
      body_rendered: body,
      source: 'nws',
      status: 'pending_approval',
      audience_spec: { subscribers: [] }, // empty — no real sends possible
      nws_alert_id: row.id,
      recipient_count: 0,
      auto_send_at: pastSendAt,
    })
    .select('id, status, auto_send_at')
    .single();
  if (insErr) { console.error('  insert failed', insErr); return; }
  console.log(`  created message id=${msg.id.slice(0, 8)} status=${msg.status} auto_send_at=${msg.auto_send_at}`);

  console.log('\nCalling promote_auto_send_messages() ...');
  const { data: promoted, error: rpcErr } = await supa.rpc('promote_auto_send_messages');
  if (rpcErr) { console.error('  RPC failed', rpcErr); return; }
  console.log(`  promoted ${Array.isArray(promoted) ? promoted.length : 0} message(s): ${JSON.stringify(promoted)}`);

  const { data: after, error: e2 } = await supa
    .from('messages')
    .select('id, status, auto_send_at, sent_at')
    .eq('id', msg.id)
    .single();
  if (e2) { console.error(e2); return; }
  console.log(`\nAfter-promotion state: status=${after.status} auto_send_at=${after.auto_send_at ?? 'cleared ✓'} sent_at=${after.sent_at ?? '—'}`);

  // Show outbound rows (should be zero since audience was empty).
  const { count } = await supa
    .from('outbound_queue')
    .select('id', { count: 'exact', head: true })
    .eq('message_id', msg.id);
  console.log(`outbound_queue rows for this message: ${count ?? 0} (expected 0 — audience was empty)`);

  console.log('\nVerdict:');
  if (after.status !== 'pending_approval' && after.auto_send_at === null && (count ?? 0) === 0) {
    console.log('  ✅ PASS — auto_send_at flow is wired correctly end-to-end.');
  } else {
    console.log('  ⚠️  Check the after-state above; expected status=queued|sent, auto_send_at=null, outbound=0.');
  }
  console.log('\nCleanup pending: run `node scripts/test-pds-path.mjs --cleanup`');
}

switch (mode) {
  case 'inspect': await inspect(); break;
  case '--inspect': await inspect(); break;
  case '--insert-readonly': await insertReadonly(); break;
  case '--patch-existing': await patchExisting(process.argv[3]); break;
  case '--unpatch': await unpatch(process.argv[3]); break;
  case '--test-promote': await testAutoSendPromote(); break;
  case '--cleanup': await cleanup(); break;
  default:
    console.error('Unknown mode. Use: inspect | --insert-readonly | --patch-existing <id> | --unpatch <id> | --test-promote | --cleanup');
    process.exit(1);
}
