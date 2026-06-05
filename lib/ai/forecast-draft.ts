import { z } from 'zod';
import { FORECAST_DRAFT_SYSTEM } from './prompts';
import type { ConvectiveSummary } from '@/lib/forecast/open-meteo';
import type { SevereSample } from '@/lib/forecast/severe-sample';

// Hazards the form supports. The model is constrained to a subset of these;
// any value outside the enum is dropped during zod parse.
const FORECAST_HAZARDS = ['tornado', 'severe', 'flood', 'wind', 'winter', 'heat'] as const;

const DraftOutput = z.object({
  headline: z.string().min(1).max(140),
  discussion_md: z.string().min(1).max(8000),
  hazards: z.array(z.enum(FORECAST_HAZARDS)).default([]),
  confidence: z.enum(['low', 'moderate', 'high']),
});

export type ForecastDraft = z.infer<typeof DraftOutput>;

// Source-data shape from public.forecast_context(area, hours). Kept loose
// (jsonb) — we don't re-validate the snapshot from PostgREST here; the
// model is the consumer.
export type ForecastContext = {
  area_centroid?: { type: 'Point'; coordinates: [number, number] };
  spc?: Array<{
    day_number?: number;
    highest_label?: string | null;
    issued_at?: string | null;
    valid_from?: string | null;
    valid_until?: string | null;
  }>;
  afd?: {
    wfo?: string | null;
    issued_at?: string | null;
    synopsis?: string | null;
    short_term?: string | null;
    ai_summary?: string | null;
  } | null;
  alerts?: Array<{
    event?: string | null;
    headline?: string | null;
    ai_summary?: string | null;
    severity?: string | null;
    effective?: string | null;
    expires_at?: string | null;
  }>;
  lsrs?: Array<{
    event?: string | null;
    hazard?: string | null;
    magnitude?: string | null;
    location?: string | null;
    occurred_at?: string | null;
  }>;
  // Quantitative thermodynamics sampled at the area centroid over the valid
  // window (see lib/forecast/open-meteo.ts). Optional — null when the sample
  // failed, so older drafts and text-only fallbacks still parse.
  thermo?: ConvectiveSummary | null;
  // HRRR kinematic ingredients (SRH/shear/CAPE/CIN) at the centroid from the
  // renderer's /sample-point. Optional — null when the renderer is unreachable.
  severe?: SevereSample | null;
};

export type ForecastDraftInput = {
  context: ForecastContext;
  valid_from: string;
  valid_until: string;
  hazards_hint: string[];     // hazards the operator selected before drafting (may be []);
  user_note?: string;          // optional operator scratch text appended to the prompt
};

export async function generateForecastDraft(
  input: ForecastDraftInput,
): Promise<{ draft: ForecastDraft; raw: unknown; prompt: string }> {
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
      // Slightly cooler than the alert writer (0.3 in lib/ai/draft.ts) — a
      // forecast discussion should be measured, not punchy. Still nonzero
      // so we don't get robotic templating.
      temperature: 0.2,
      messages: [
        { role: 'system', content: FORECAST_DRAFT_SYSTEM },
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

  const draft = DraftOutput.parse(parsed);
  return { draft, raw: parsed, prompt: userPrompt };
}

function buildPrompt(input: ForecastDraftInput): string {
  const { context, valid_from, valid_until, hazards_hint, user_note } = input;
  const lines: string[] = [];

  lines.push(`Window: ${valid_from} → ${valid_until} (UTC).`);
  if (context.area_centroid?.coordinates) {
    const [lng, lat] = context.area_centroid.coordinates;
    lines.push(`Area centroid: ${lat.toFixed(2)}°N, ${lng.toFixed(2)}°W.`);
  }
  if (hazards_hint.length > 0) {
    lines.push(`Operator pre-selected hazards (these are HINTS, drop any the data doesn't support): ${hazards_hint.join(', ')}.`);
  } else {
    lines.push(`Operator did not pre-select any hazards — choose hazards based on the data.`);
  }

  lines.push('');
  lines.push('## SPC convective outlook (regional)');
  if (context.spc && context.spc.length > 0) {
    for (const d of context.spc) {
      lines.push(`- Day ${d.day_number}: highest risk ${d.highest_label ?? 'n/a'}; valid ${d.valid_from ?? '?'} → ${d.valid_until ?? '?'}; issued ${d.issued_at ?? '?'}.`);
    }
  } else {
    lines.push('- No outlook data available.');
  }

  lines.push('');
  lines.push('## Latest NWS AFD');
  if (context.afd) {
    lines.push(`WFO ${context.afd.wfo ?? '?'} · issued ${context.afd.issued_at ?? '?'}`);
    if (context.afd.ai_summary) lines.push(`Summary: ${context.afd.ai_summary}`);
    if (context.afd.synopsis) lines.push(`Synopsis: ${truncate(context.afd.synopsis, 800)}`);
    if (context.afd.short_term) lines.push(`Short term: ${truncate(context.afd.short_term, 800)}`);
  } else {
    lines.push('- No AFD on file.');
  }

  lines.push('');
  lines.push('## Active NWS alerts intersecting the area');
  if (context.alerts && context.alerts.length > 0) {
    for (const a of context.alerts.slice(0, 12)) {
      const sev = a.severity ? ` [${a.severity}]` : '';
      lines.push(`- ${a.event ?? 'Alert'}${sev} — ${truncate(a.ai_summary || a.headline || '', 240)} (eff ${a.effective ?? '?'}, exp ${a.expires_at ?? '?'})`);
    }
  } else {
    lines.push('- No active alerts in the area.');
  }

  lines.push('');
  lines.push('## Recent LSRs in the area (past 24h)');
  if (context.lsrs && context.lsrs.length > 0) {
    for (const r of context.lsrs.slice(0, 24)) {
      lines.push(`- ${r.occurred_at ?? '?'} · ${r.event ?? '?'}${r.magnitude ? ` (${r.magnitude})` : ''}${r.location ? ` near ${r.location}` : ''}`);
    }
  } else {
    lines.push('- No LSRs reported in the area in the past 24h.');
  }

  lines.push('');
  lines.push('## Model thermodynamics (area centroid, valid window)');
  if (context.thermo) {
    const t = context.thermo;
    lines.push(`Source: ${t.source}.`);
    if (t.peak_cape) {
      lines.push(`- Peak CAPE: ${t.peak_cape.value} J/kg at ${t.peak_cape.at}${t.cin_at_peak != null ? ` (CIN ${t.cin_at_peak} J/kg at that hour)` : ''}.`);
    }
    if (t.min_lifted_index) {
      lines.push(`- Most unstable Lifted Index: ${t.min_lifted_index.value} at ${t.min_lifted_index.at}.`);
    }
    if (t.trace.length) {
      const trace = t.trace
        .map((s) => `${s.t.slice(5, 16)} CAPE ${s.cape ?? '—'}/CIN ${s.cin ?? '—'}/LI ${s.li ?? '—'}`)
        .join('; ');
      lines.push(`- Trace (~6 h): ${trace}.`);
    }
    lines.push('Cite these instability numbers where relevant.');
  } else {
    lines.push('- No model thermodynamic sample available; reason from the SPC outlook, AFD, and reports above.');
  }

  lines.push('');
  lines.push('## HRRR severe-storm ingredients (area centroid, current analysis)');
  if (context.severe && (context.severe.sbcape != null || context.severe.srh_0_1km != null)) {
    const s = context.severe;
    const fmt = (v: number | null, u: string) => (v == null ? 'n/a' : `${v}${u}`);
    lines.push(`Source: ${s.model}${s.valid_time ? ` valid ${s.valid_time}` : ''}.`);
    lines.push(`- SBCAPE ${fmt(s.sbcape, ' J/kg')} · SBCIN ${fmt(s.sbcin, ' J/kg')}`);
    lines.push(`- 0-1 km SRH ${fmt(s.srh_0_1km, ' m2/s2')} · 0-3 km SRH ${fmt(s.srh_0_3km, ' m2/s2')}`);
    lines.push(`- 0-1 km bulk shear ${fmt(s.shear_0_1km_kt, ' kt')} · 0-6 km bulk shear ${fmt(s.shear_0_6km_kt, ' kt')}`);
    lines.push('Use these to calibrate organized-severe / tornado wording: meaningful 0-6km shear (>=35 kt) with adequate CAPE supports organized/supercell potential; strong 0-1km SRH (>=150 m2/s2) raises low-level rotation/tornado concern. Low values argue against organized severe regardless of outlook tone.');
  } else {
    lines.push('- No HRRR kinematic sample available; hedge organized-severe/tornado wording on the SPC outlook + AFD rather than asserting shear/SRH-driven potential.');
  }

  if (user_note && user_note.trim()) {
    lines.push('');
    lines.push('## Operator note');
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
