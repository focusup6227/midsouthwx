// AI summarizer for newly ingested Area Forecast Discussions. Same pattern
// as the warnings summarizer in nws-poll: pulls AFD rows missing ai_summary,
// asks DeepSeek for a 2-sentence digest of what the forecaster is worried
// about over the next 24h, writes the result back. Fire-and-forget so a slow
// API never blocks the poll response.

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';

const SYSTEM_PROMPT =
  'You write two-sentence summaries of NWS Area Forecast Discussions for a ' +
  'severe-weather operator. Style: plain English, present tense, lead with ' +
  'the most actionable hazard in the next 24 hours (severe storms, hail, ' +
  'flooding, winter precip, etc.), then add timing or confidence. Skip ' +
  'routine weather. Under 280 characters total. Never invent details.';

const MAX_BATCH = 8;
const CONCURRENCY = 3;
const SOURCE_MAX_CHARS = 3500;

type Row = {
  id: string;
  wfo: string;
  synopsis: string | null;
  short_term: string | null;
  long_term: string | null;
};

function buildUserPrompt(row: Row): string {
  const parts: string[] = [`WFO: ${row.wfo}`];
  if (row.synopsis) parts.push(`Synopsis: ${row.synopsis.slice(0, SOURCE_MAX_CHARS)}`);
  if (row.short_term) parts.push(`Short term: ${row.short_term.slice(0, SOURCE_MAX_CHARS)}`);
  // Long-term is less important for operator-facing TL;DR — include only if
  // we still have headroom.
  if (row.long_term && (parts.join('\n').length < 2500)) {
    parts.push(`Long term: ${row.long_term.slice(0, 1500)}`);
  }
  parts.push('', 'Return ONLY the summary. No JSON, no prefix.');
  return parts.join('\n');
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
      max_tokens: 140,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) {
    console.error('afd summarize: DeepSeek HTTP', resp.status);
    return null;
  }
  const data = await resp.json();
  const content: string | undefined = data?.choices?.[0]?.message?.content;
  if (!content) return null;
  const cleaned = content.trim().replace(/^["']+|["']+$/g, '').trim();
  if (!cleaned) return null;
  return cleaned.length > 560 ? cleaned.slice(0, 560) : cleaned;
}

async function summarizeRow(
  apiKey: string,
  supa: SupabaseClient,
  row: Row,
): Promise<boolean> {
  try {
    const summary = await callDeepSeek(apiKey, buildUserPrompt(row));
    if (!summary) return false;
    const { error } = await supa.from('nws_afd').update({ ai_summary: summary }).eq('id', row.id);
    if (error) {
      console.error('afd summarize: update failed', row.id, error.message);
      return false;
    }
    return true;
  } catch (e) {
    console.error('afd summarize: row failed', row.id, e);
    return false;
  }
}

/** Summarize up to MAX_BATCH AFDs missing ai_summary. Bounded concurrency so
 *  a burst of WFO updates doesn't fan out into a DeepSeek tantrum. */
export async function summarizePendingAfds(
  supa: SupabaseClient,
): Promise<{ attempted: number; succeeded: number }> {
  const apiKey = Deno.env.get('DEEPSEEK_API_KEY');
  if (!apiKey) return { attempted: 0, succeeded: 0 };

  const { data, error } = await supa
    .from('nws_afd')
    .select('id, wfo, synopsis, short_term, long_term')
    .is('ai_summary', null)
    .order('issued_at', { ascending: false })
    .limit(MAX_BATCH);
  if (error) {
    console.error('afd summarize: select failed', error.message);
    return { attempted: 0, succeeded: 0 };
  }
  const rows = (data ?? []) as Row[];
  if (rows.length === 0) return { attempted: 0, succeeded: 0 };

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
