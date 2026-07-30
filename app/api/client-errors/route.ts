import { NextRequest, NextResponse } from 'next/server';
import { supabaseServer, supabaseAdmin } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

// Browser error sink. Session-gated (operator dashboard only), service-role
// insert so no table grants leak to authenticated. Payload sizes are clamped
// server-side — never trust a crashing client to be polite.
export async function POST(req: NextRequest) {
  const supa = supabaseServer();
  const { data: userRes } = await supa.auth.getUser();
  if (!userRes.user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let body: { message?: unknown; stack?: unknown; url?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'bad_json' }, { status: 400 });
  }
  const message = String(body.message ?? '').slice(0, 500).trim();
  if (!message) return NextResponse.json({ error: 'empty' }, { status: 400 });

  const { error } = await supabaseAdmin().from('client_errors').insert({
    message,
    stack: body.stack ? String(body.stack).slice(0, 4000) : null,
    url: body.url ? String(body.url).slice(0, 500) : null,
    user_agent: (req.headers.get('user-agent') ?? '').slice(0, 300) || null,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
