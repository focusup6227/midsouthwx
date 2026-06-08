import { z } from 'zod';
import { BROADCAST_SCRIPT_SYSTEM } from './prompts';

// Source snapshot fed to the broadcast scriptwriter. Mirrors the shape of
// public.daily_briefing_snapshot() (see app/broadcast/actions.ts), kept loose
// because the model is the consumer — we don't re-validate PostgREST jsonb.
export type BroadcastContext = {
  generated_at?: string;
  spc?: Record<string, { highest_label?: string | null; issued_at?: string | null; valid_from?: string | null; valid_until?: string | null }>;
  afds?: Array<{ wfo?: string; issued_at?: string; synopsis?: string | null }>;
  hwos?: Array<{ event?: string; headline?: string | null; area_desc?: string | null; effective?: string | null; expires_at?: string | null }>;
  alerts?: Array<{ event?: string | null; area_desc?: string | null; severity?: string | null; headline?: string | null; expires_at?: string | null }>;
  lsrs?: Array<{ event?: string | null; magnitude?: string | null; location?: string | null; occurred_at?: string | null }>;
  warnings_count?: number;
  watches_count?: number;
};

export type BroadcastScriptInput = {
  context: BroadcastContext;
  /** "live" (going live now) or "recorded" (pre-recording a segment). Nudges pacing. */
  mode: 'live' | 'recorded';
  /** Rough target length in minutes; the model paces segments to fit. */
  target_minutes: number;
  /** Optional operator scratch note appended to the prompt. */
  user_note?: string;
};

const Segment = z.object({
  name: z.string().min(1),
  est_seconds: z.number().nonnegative().max(3600).default(60),
  talking_points: z.array(z.string()).default([]),
  script: z.string().default(''),
});

const ScriptOutput = z.object({
  title: z.string().min(1).max(140),
  description: z.string().min(1).max(5000),
  tags: z.array(z.string()).default([]),
  thumbnail_headline: z.string().min(1).max(60),
  summary: z.string().default(''),
  segments: z.array(Segment).min(1),
});

export type BroadcastScript = z.infer<typeof ScriptOutput>;

export async function generateBroadcastScript(
  input: BroadcastScriptInput,
): Promise<{ script: BroadcastScript; raw: unknown; prompt: string }> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error('DEEPSEEK_API_KEY is not configured');
  }

  const userPrompt = buildPrompt(input);

  const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      // A touch warmer than the forecast writer (0.2) so the spoken script
      // reads naturally, but cool enough to stay anchored to the data.
      temperature: 0.4,
      messages: [
        { role: 'system', content: BROADCAST_SCRIPT_SYSTEM },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_object' },
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`DeepSeek error: ${resp.status} ${err}`);
  }

  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('No content from AI');

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('AI returned invalid JSON');
  }

  const script = ScriptOutput.parse(parsed);
  return { script, raw: parsed, prompt: userPrompt };
}

function buildPrompt(input: BroadcastScriptInput): string {
  const { context: c, mode, target_minutes, user_note } = input;
  const lines: string[] = [];

  lines.push(
    `Produce a ${mode === 'live' ? 'LIVE go-to-air' : 'pre-recorded'} severe-weather briefing script.`,
  );
  lines.push(`Target runtime: about ${target_minutes} minute(s). Pace segment est_seconds to roughly sum to that.`);
  lines.push(`Today is ${c.generated_at ?? new Date().toISOString()} (briefing snapshot time).`);

  lines.push('');
  lines.push('## SPC convective outlook (Day 1-3, regional)');
  const days = c.spc ? Object.entries(c.spc).sort(([a], [b]) => Number(a) - Number(b)) : [];
  if (days.length > 0) {
    for (const [d, day] of days) {
      lines.push(
        `- Day ${d}: highest risk ${day?.highest_label ?? 'none'}; valid ${day?.valid_from ?? '?'} -> ${day?.valid_until ?? '?'}.`,
      );
    }
  } else {
    lines.push('- No SPC outlook on file.');
  }

  lines.push('');
  lines.push(`## Active alerts (counts: ${c.warnings_count ?? 0} warning(s), ${c.watches_count ?? 0} watch(es))`);
  if (c.alerts && c.alerts.length > 0) {
    for (const a of c.alerts.slice(0, 16)) {
      const sev = a.severity ? ` [${a.severity}]` : '';
      lines.push(`- ${a.event ?? 'Alert'}${sev}: ${truncate(a.headline || a.area_desc || '', 220)}`);
    }
  } else {
    lines.push('- No active warnings or watches right now.');
  }

  lines.push('');
  lines.push('## Hazardous Weather Outlooks');
  if (c.hwos && c.hwos.length > 0) {
    for (const h of c.hwos.slice(0, 4)) {
      lines.push(`- ${h.headline ?? h.event ?? 'HWO'}: ${truncate(h.area_desc || '', 220)}`);
    }
  } else {
    lines.push('- None active.');
  }

  lines.push('');
  lines.push('## Latest NWS Area Forecast Discussions (last 24h, by WFO)');
  if (c.afds && c.afds.length > 0) {
    for (const a of c.afds.slice(0, 6)) {
      lines.push(`- ${a.wfo ?? '?'} (${a.issued_at ?? '?'}): ${truncate(a.synopsis || '', 600)}`);
    }
  } else {
    lines.push('- No AFDs on file.');
  }

  lines.push('');
  lines.push('## Recent local storm reports (past 24h)');
  if (c.lsrs && c.lsrs.length > 0) {
    for (const r of c.lsrs.slice(0, 20)) {
      lines.push(
        `- ${r.occurred_at ?? '?'} ${r.event ?? '?'}${r.magnitude ? ` (${r.magnitude})` : ''}${r.location ? ` near ${r.location}` : ''}`,
      );
    }
  } else {
    lines.push('- No storm reports in the past 24h.');
  }

  if (user_note && user_note.trim()) {
    lines.push('');
    lines.push('## Presenter note (incorporate if it fits the data)');
    lines.push(user_note.trim().slice(0, 600));
  }

  lines.push('');
  lines.push('Return ONLY the JSON object specified by the system prompt. No prose, no fences.');

  return lines.join('\n');
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}
