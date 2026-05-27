'use client';

import { Suspense, useState } from 'react';
import Image from 'next/image';
import { useRouter, useSearchParams } from 'next/navigation';
import { safeRedirectPath } from '@/lib/auth/redirect';
import { supabaseBrowser } from '@/lib/supabase/client';

type Mode = 'password' | 'magiclink';

function LoginForm() {
  const router = useRouter();
  const search = useSearchParams();
  const next = safeRedirectPath(search.get('next'));

  const [mode, setMode] = useState<Mode>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const supa = supabaseBrowser();

    if (mode === 'password') {
      const { error } = await supa.auth.signInWithPassword({ email, password });
      setLoading(false);
      if (error) {
        setError(error.message);
        return;
      }
      router.replace(next);
      router.refresh();
      return;
    }

    const { error } = await supa.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
        shouldCreateUser: false,
      },
    });
    setLoading(false);
    if (error) setError(error.message);
    else setSent(true);
  }

  if (sent) {
    return (
      <main className="min-h-screen flex items-center justify-center px-6">
        <div className="card p-8 max-w-md w-full text-center space-y-2">
          <h1 className="text-xl font-semibold">Check your email</h1>
          <p className="text-wx-mute">
            We sent a sign-in link to <b>{email}</b>. Tap it on this device.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen flex items-center justify-center px-6">
      <form onSubmit={submit} className="card p-8 max-w-md w-full space-y-4">
        <div className="flex flex-col items-center gap-2">
          <Image src="/icons/logo.png" alt="MidSouthWX logo" width={96} height={96} priority className="rounded-full" />
          <h1 className="text-2xl font-semibold">Operator sign-in</h1>
        </div>

        <div className="flex gap-2 text-sm">
          <button
            type="button"
            className={`btn-ghost flex-1 ${mode === 'password' ? 'border-wx-accent text-wx-accent' : ''}`}
            onClick={() => { setMode('password'); setError(null); }}
          >
            Password
          </button>
          <button
            type="button"
            className={`btn-ghost flex-1 ${mode === 'magiclink' ? 'border-wx-accent text-wx-accent' : ''}`}
            onClick={() => { setMode('magiclink'); setError(null); }}
          >
            Magic link
          </button>
        </div>

        <input
          type="email"
          required
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="input"
        />

        {mode === 'password' && (
          <input
            type="password"
            required
            autoComplete="current-password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="input"
          />
        )}

        {error ? <p className="text-wx-danger text-sm">{error}</p> : null}

        <button type="submit" disabled={loading} className="btn w-full">
          {loading
            ? mode === 'password' ? 'Signing in…' : 'Sending…'
            : mode === 'password' ? 'Sign in' : 'Email me a sign-in link'}
        </button>

        {mode === 'password' && (
          <p className="text-xs text-wx-mute text-center">
            Forgot your password?{' '}
            <button
              type="button"
              className="text-wx-accent underline"
              onClick={() => { setMode('magiclink'); setError(null); }}
            >
              Sign in by email
            </button>{' '}
            and reset from <a className="text-wx-accent underline" href="/settings">Settings</a>.
          </p>
        )}
      </form>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen flex items-center justify-center px-6 text-wx-mute text-sm">
          Loading…
        </main>
      }
    >
      <LoginForm />
    </Suspense>
  );
}
