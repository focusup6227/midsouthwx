import { supabaseServer } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Latest AFD per WFO. nws_afd is partial-indexed (wfo, issued_at desc) so the
// distinct-on path is cheap; we just bring back the most recent row per WFO.
// Parsed sections are returned alongside the raw text so the inspector card
// can show synopsis/short_term/long_term without re-parsing on the client.
export async function GET() {
  const supa = supabaseServer();
  const { data, error } = await supa
    .from('nws_afd')
    .select('id, wfo, product_id, issued_at, synopsis, short_term, long_term, aviation, ai_summary, text')
    .order('wfo')
    .order('issued_at', { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const latestPerWfo = new Map<
    string,
    {
      id: string;
      wfo: string;
      product_id: string;
      issued_at: string;
      synopsis: string | null;
      short_term: string | null;
      long_term: string | null;
      aviation: string | null;
      ai_summary: string | null;
      text: string;
    }
  >();
  for (const row of data ?? []) {
    if (!latestPerWfo.has(row.wfo)) latestPerWfo.set(row.wfo, row);
  }

  const items = Array.from(latestPerWfo.values()).sort((a, b) => a.wfo.localeCompare(b.wfo));

  return NextResponse.json({ items }, {
    headers: { 'Cache-Control': 'private, max-age=60' },
  });
}
