import { SEVERE_WEATHER_SYSTEM, TONE_PROMPTS } from './prompts';
import { z } from 'zod';

const DraftOutput = z.object({
  body_md: z.string().min(1),
  quick_replies: z.array(z.object({ label: z.string(), data: z.string() })).nullable(),
});

export type DraftInput = {
  context: 'nws' | 'thread' | 'raw';
  tone: 'urgent-calm' | 'technical' | 'brief';
  sourceText: string;
};

export async function generateDraft(input: DraftInput): Promise<z.infer<typeof DraftOutput>> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error('DEEPSEEK_API_KEY is not configured');
  }

  const toneText = TONE_PROMPTS[input.tone] ?? TONE_PROMPTS['urgent-calm'];
  const userPrompt = `${toneText}\n\nSource context (${input.context}):\n${input.sourceText}\n\nReturn ONLY the JSON object.`;

  const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      temperature: 0.3,
      messages: [
        { role: 'system', content: SEVERE_WEATHER_SYSTEM },
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

  let parsed: any;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('AI returned invalid JSON');
  }

  return DraftOutput.parse(parsed);
}
