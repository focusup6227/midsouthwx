'use client';

import { useState } from 'react';
import { supabasePublishableKey } from '@/lib/supabase/env';

export default function SignupPage() {
  const [form, setForm] = useState({
    display_name: '',
    zip: '',
    address: '',
    email: '',
    phone: '',
  });
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [result, setResult] = useState<{ deeplink: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function requestLocation() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        setCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () =>
        setError('Could not get location — that is fine, ZIP will be used.'),
      { enableHighAccuracy: true, timeout: 8000 },
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const url = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/signup`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        apikey: supabasePublishableKey(),
      },
      body: JSON.stringify({
        ...form,
        lat: coords?.lat,
        lng: coords?.lng,
      }),
    });
    const data = await res.json();
    setLoading(false);
    if (!data.ok) {
      setError(data.error ?? 'Sign-up failed');
      return;
    }
    setResult({ deeplink: data.deeplink });
  }

  if (result) {
    return (
      <main className="min-h-screen flex items-center justify-center px-6">
        <div className="card p-8 max-w-md w-full text-center space-y-4">
          <h1 className="text-xl font-semibold">One more step</h1>
          <p className="text-wx-mute">
            Open Telegram and tap <b>Start</b> in the chat with our bot. That confirms your sign-up.
          </p>
          <a href={result.deeplink} className="btn block">
            Open Telegram
          </a>
          <p className="text-xs text-wx-mute">
            If the button doesn&apos;t open Telegram, copy this link:
            <br />
            <span className="break-all">{result.deeplink}</span>
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen flex items-center justify-center px-6 py-10">
      <form
        onSubmit={submit}
        className="card p-8 max-w-md w-full space-y-4"
      >
        <h1 className="text-2xl font-semibold">Sign up for severe weather alerts</h1>
        <p className="text-wx-mute text-sm">
          Alerts come through Telegram. You will get a link to open the bot after submitting.
        </p>

        <label className="block">
          <span className="text-sm">Your name</span>
          <input
            required
            value={form.display_name}
            onChange={(e) => setForm((f) => ({ ...f, display_name: e.target.value }))}
            className="input mt-1"
          />
        </label>

        <label className="block">
          <span className="text-sm">ZIP code</span>
          <input
            required
            inputMode="numeric"
            pattern="\d{5}"
            value={form.zip}
            onChange={(e) => setForm((f) => ({ ...f, zip: e.target.value }))}
            className="input mt-1"
          />
        </label>

        <label className="block">
          <span className="text-sm">Home address</span>
          <textarea
            required
            rows={2}
            placeholder="Street, city, state — used by responders if you ever signal distress"
            value={form.address}
            onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))}
            className="input mt-1"
          />
          <p className="text-xs text-wx-mute mt-1">
            Only shown to the operator. If you&apos;re ever not home, send{' '}
            <code>/where &lt;address&gt;</code> to the bot to update your current location.
          </p>
        </label>

        <details className="text-sm">
          <summary className="cursor-pointer text-wx-mute">Optional: email + phone</summary>
          <div className="mt-2 space-y-2">
            <input
              type="email"
              placeholder="email"
              value={form.email}
              onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
              className="input"
            />
            <input
              type="tel"
              placeholder="phone"
              value={form.phone}
              onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
              className="input"
            />
          </div>
        </details>

        <div className="text-sm">
          <button
            type="button"
            onClick={requestLocation}
            className="btn-ghost w-full"
          >
            {coords ? '✓ Precise location attached' : 'Share precise location (optional)'}
          </button>
          <p className="text-xs text-wx-mute mt-1">
            Precise location lets us match storm-based warning polygons. You can skip it; ZIP is enough.
          </p>
        </div>

        {error ? <p className="text-wx-danger text-sm">{error}</p> : null}

        <button type="submit" disabled={loading} className="btn w-full">
          {loading ? 'Sending…' : 'Sign me up'}
        </button>
      </form>
    </main>
  );
}
