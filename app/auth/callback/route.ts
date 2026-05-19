import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase/server';

// Magic-link callback. Supabase appends ?code=... and we exchange it for a session.
// Also auto-promotes the configured operator email into the public.operators table.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const next = url.searchParams.get('next') || '/dashboard';
  if (!code) return NextResponse.redirect(new URL('/login', url));

  const supa = supabaseServer();
  const { data, error } = await supa.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(new URL('/login?error=exchange', url));
  }

  const user = data.user;
  if (user) {
    // First-time login auto-enrolls the operator. Subsequent visits no-op.
    await supa.from('operators').upsert(
      { user_id: user.id, display_name: user.email },
      { onConflict: 'user_id' },
    );
  }

  return NextResponse.redirect(new URL(next, url));
}
