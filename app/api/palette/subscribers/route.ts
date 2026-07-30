import { NextRequest, NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

// Subscriber lookup for the command palette. RLS makes this operator-only:
// non-operators get zero rows back.
export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get('q') ?? '').trim();
  if (q.length < 2) return NextResponse.json({ subscribers: [] });

  const supabase = supabaseServer();
  const { data, error } = await supabase
    .from('subscribers')
    .select('id, display_name, status, zip, telegram_chat_id')
    .or(`display_name.ilike.%${q.replace(/[%_,]/g, '')}%,zip.like.${q.replace(/[^0-9]/g, '') || '~'}%`)
    .limit(8);

  if (error) return NextResponse.json({ subscribers: [] });
  return NextResponse.json({
    subscribers: (data ?? []).map((s) => ({
      id: s.id,
      name: s.display_name,
      status: s.status,
      zip: s.zip,
      linked: Boolean(s.telegram_chat_id),
    })),
  });
}
