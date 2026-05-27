// F2: AI summarizer for new NWS warnings. Called from index.ts after the
// upsert loop, wrapped in EdgeRuntime.waitUntil so it doesn't block the poll
// response.
//
// Design notes:
//   - DeepSeek for the one-liner — same provider as the operator-facing
//     /compose AI draft (see lib/ai/draft.ts on the Next.js side).
//   - Sync-and-forget: only summarize rows with ai_summary IS NULL so a
//     missed run self-heals on the next poll.
//   - Bounded per-call concurrency (CONCURRENCY) and per-batch cap
//     (MAX_BATCH) so a sudden flood of warnings doesn't melt the API key.
//   - Failures are swallowed silently (left null). The radar UI falls back to
//     `headline ?? truncate(description, 140)` per the F2 design.

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';

const SYSTEM_PROMPT =
  'You write one-sentence severe weather alert summaries for a public ' +
  'safety dashboard. Style: plain English, present tense, under 140 ' +
  'characters, no preamble, no quotes. Lead with the hazard + location + ' +
  'window if known. Never invent details not in the source.';

const MAX_BATCH = 8;
const CONCURRENCY = 3;
const SOURCE_MAX_CHARS = 4000;

type Row = {
  id: string;
  event: string;
  headline: string | null;
  description: string | null;
  area_desc: string | null;
  expires_at: string | null;
};

function buildUserPrompt(row: Row): string {
  // Trim description aggressively — NWS bodies are often boilerplate-heavy
  // and we just need the key hazard + scope, not the precaution checklist.
  const desc = (row.description ?? '').slice(0, SOURCE_MAX_CHARS);
  return [
    `Event: ${row.event}`,
    row.area_desc ? `Area: ${row.area_desc}` : null,
    row.expires_at ? `Until: ${row.expires_at}` : null,
    row.headline ? `Headline: ${row.headline}` : null,
    desc ? `Body:\n${desc}` : null,
    '',
    'Return ONLY the summary sentence. No JSON, no prefix.',
  ]
    .filter(Boolean)
    .join('\n');
}

async function callDeepSeek(apiKey: string, userPrompt: string): Promise<string | null> {
  const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      temperature: 0.2,
      max_tokens: 80,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    }),
    // Polls run every 30s — don't let a slow API stall ingest indefinitely.
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) {
    console.error('summarize: DeepSeek HTTP', resp.status);
    return null;
  }
  const data = await resp.json();
  const content: string | undefined = data?.choices?.[0]?.message?.content;
  if (!content) return null;
  // Strip quote marks and surrounding whitespace; DeepSeek sometimes wraps.
  const cleaned = content.trim().replace(/^["']+|["']+$/g, '').trim();
  if (!cleaned) return null;
  return cleaned.length > 280 ? cleaned.slice(0, 280) : cleaned;
}

async function summarizeRow(
  apiKey: string,
  supa: SupabaseClient,
  row: Row,
): Promise<boolean> {
  try {
    const summary = await callDeepSeek(apiKey, buildUserPrompt(row));
    if (!summary) return false;
    const { error } = await supa
      .from('nws_alerts')
      .update({ ai_summary: summary })
      .eq('id', row.id);
    if (error) {
      console.error('summarize: update failed', row.id, error.message);
      return false;
    }
    return true;
  } catch (e) {
    console.error('summarize: row failed', row.id, e);
    return false;
  }
}

/**
 * Pulls up to MAX_BATCH warning-category alerts that don't have an
 * ai_summary yet, summarizes each, and writes the result back. Bounded
 * concurrency keeps DeepSeek + Postgres load predictable. Designed to be
 * fire-and-forget inside EdgeRuntime.waitUntil.
 */
export async function summarizePendingWarnings(
  supa: SupabaseClient,
): Promise<{ attempted: number; succeeded: number }> {
  const apiKey = Deno.env.get('DEEPSEEK_API_KEY');
  if (!apiKey) return { attempted: 0, succeeded: 0 };

  // Warning-category only — "Warning" or "Emergency" in the event text, never
  // statements/discussions/watches/advisories. Order by most recent so a
  // tornado warning that just dropped gets summarized before older flood
  // warnings.
  const { data, error } = await supa
    .from('nws_alerts')
    .select('id, event, headline, description, area_desc, expires_at')
    .is('ai_summary', null)
    .or('event.ilike.%Warning%,event.ilike.%Emergency%')
    .gte('expires_at', new Date().toISOString())
    .order('ingested_at', { ascending: false })
    .limit(MAX_BATCH);

  if (error) {
    console.error('summarize: select failed', error.message);
    return { attempted: 0, succeeded: 0 };
  }

  const rows = (data ?? []) as Row[];
  if (rows.length === 0) return { attempted: 0, succeeded: 0 };

  // Simple bounded-concurrency runner — process the queue with at most
  // CONCURRENCY in-flight requests at a time.
  let succeeded = 0;
  let cursor = 0;
  const workers: Promise<void>[] = [];
  const next = async (): Promise<void> => {
    while (cursor < rows.length) {
      const row = rows[cursor++];
      const ok = await summarizeRow(apiKey, supa, row);
      if (ok) succeeded++;
    }
  };
  for (let i = 0; i < Math.min(CONCURRENCY, rows.length); i++) {
    workers.push(next());
  }
  await Promise.all(workers);

  return { attempted: rows.length, succeeded };
}
