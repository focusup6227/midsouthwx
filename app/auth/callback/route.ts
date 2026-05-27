import { NextResponse } from 'next/server';
import { safeRedirectPath } from '@/lib/auth/redirect';
import { supabaseAdmin, supabaseServer } from '@/lib/supabase/server';

function operatorEmailAllowed(email: string | undefined): boolean {
  if (!email) return false;
  const allowed = [
    ...(process.env.OPERATOR_EMAILS ?? '').split(','),
    process.env.OPERATOR_EMAIL ?? '',
  ]
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  return allowed.includes(email.toLowerCase());
}

// Magic-link callback. Supabase appends ?code=... and we exchange it for a session.
// Existing operators can sign in normally. First-time operator enrollment is
// restricted to explicitly allowlisted emails.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const next = safeRedirectPath(url.searchParams.get('next'));
  if (!code) return NextResponse.redirect(new URL('/login', url));

  const supa = supabaseServer();
  const { data, error } = await supa.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(new URL('/login?error=exchange', url));
  }

  const user = data.user;
  if (user) {
    const { data: existingOperator } = await supa
      .from('operators')
      .select('user_id')
      .eq('user_id', user.id)
      .maybeSingle();

    if (!existingOperator) {
      if (!operatorEmailAllowed(user.email)) {
        await supa.auth.signOut();
        return NextResponse.redirect(new URL('/login?error=not_operator', url));
      }

      const { error: upsertErr } = await supabaseAdmin().from('operators').upsert(
        { user_id: user.id, display_name: user.email },
        { onConflict: 'user_id' },
      );
      if (upsertErr) {
        console.error('operators upsert failed', upsertErr);
        const dest = new URL(next, url.origin);
        dest.searchParams.set('operator_enroll', 'failed');
        return NextResponse.redirect(dest);
      }
    }
  }

  return NextResponse.redirect(new URL(next, url.origin));
}
