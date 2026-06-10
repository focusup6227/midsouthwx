import type { Metadata } from 'next';
import Link from 'next/link';
import { supabaseAdmin } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Forecasts · MidSouthWX',
  description: 'Mid-South WX operator forecasts — probabilistic severe-weather outlooks for the Memphis-area region.',
  alternates: { types: { 'application/rss+xml': '/f/rss.xml' } },
};

// Public forecast index: every forecast the operator has shared (public_token
// set) that has reached issued/closed. Same access contract as /f/<token> —
// the admin client dodges operator-only RLS, and the token+status filter is
// the actual access control. Drafts and unshared forecasts never appear.
type Row = {
  title: string;
  hazards: string[] | null;
  confidence: string | null;
  status: string;
  valid_from: string;
  valid_until: string;
  public_token: string;
  verification: { hazard_match?: boolean } | null;
};

function fmt(dt: string): string {
  try {
    return new Date(dt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch { return dt; }
}

const HAZARD_TINT: Record<string, string> = {
  tornado: 'text-red-300 border-red-700/60 bg-red-500/10',
  severe:  'text-orange-300 border-orange-700/60 bg-orange-500/10',
  flood:   'text-emerald-300 border-emerald-700/60 bg-emerald-500/10',
  wind:    'text-violet-300 border-violet-700/60 bg-violet-500/10',
  winter:  'text-sky-300 border-sky-700/60 bg-sky-500/10',
  heat:    'text-amber-300 border-amber-700/60 bg-amber-500/10',
};

function ForecastRow({ f }: { f: Row }) {
  const verified = f.status === 'closed' ? f.verification?.hazard_match : undefined;
  return (
    <li>
      <Link
        href={`/f/${f.public_token}`}
        className="block rounded-lg border border-wx-line bg-wx-card p-4 hover:border-wx-accent transition-colors"
      >
        <div className="flex items-baseline justify-between gap-3">
          <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">{f.title}</span>
          {verified !== undefined ? (
            <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
              verified ? 'bg-emerald-500/15 text-emerald-300' : 'bg-wx-ink text-wx-mute'
            }`}>
              {verified ? 'verified' : 'did not verify'}
            </span>
          ) : (
            <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-300">
              active
            </span>
          )}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          {(f.hazards ?? []).map((h) => (
            <span
              key={h}
              className={
                'rounded-full border px-2 py-[1px] text-[10px] font-semibold uppercase tracking-wider ' +
                (HAZARD_TINT[h] ?? 'border-wx-line bg-wx-card text-wx-mute')
              }
            >
              {h}
            </span>
          ))}
          <span className="text-[11px] font-mono text-wx-mute">
            {fmt(f.valid_from)} → {fmt(f.valid_until)}
          </span>
          {f.confidence ? (
            <span className="text-[11px] text-wx-mute">· {f.confidence} confidence</span>
          ) : null}
        </div>
      </Link>
    </li>
  );
}

export default async function PublicForecastIndex() {
  const admin = supabaseAdmin();
  const { data } = await admin
    .from('forecasts')
    .select('title, hazards, confidence, status, valid_from, valid_until, public_token, verification')
    .not('public_token', 'is', null)
    .in('status', ['issued', 'closed'])
    .order('valid_from', { ascending: false })
    .limit(50);
  const rows = (data ?? []) as Row[];

  const now = Date.now();
  const active = rows.filter((f) => new Date(f.valid_until).getTime() >= now);
  const past = rows.filter((f) => new Date(f.valid_until).getTime() < now);

  return (
    <main className="min-h-screen bg-wx-ink text-wx-fg">
      <div className="mx-auto max-w-3xl px-5 py-8 space-y-6">
        <header className="space-y-1">
          <div className="text-[11px] uppercase tracking-wider text-wx-mute font-semibold">Mid-South WX</div>
          <h1 className="text-2xl font-bold">Forecasts</h1>
          <p className="text-sm text-wx-mute">
            Operator-issued severe-weather outlooks for the Mid-South. Closed forecasts are scored
            against NWS warnings and spotter reports.{' '}
            <a href="/f/rss.xml" className="text-wx-accent hover:underline">RSS</a>
          </p>
          {process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME ? (
            <a
              href={`https://t.me/${process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME}`}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-block rounded-lg border border-wx-accent/50 bg-wx-accent/10 px-4 py-2 text-sm font-semibold text-wx-accent hover:bg-wx-accent/20"
            >
              ⚡ Get alerts free on Telegram
            </a>
          ) : null}
        </header>

        {rows.length === 0 ? (
          <p className="text-sm text-wx-mute">No published forecasts yet — check back during the next active stretch.</p>
        ) : (
          <>
            {active.length > 0 ? (
              <section className="space-y-2">
                <h2 className="text-[11px] uppercase tracking-wider text-wx-mute font-semibold">Active</h2>
                <ul className="space-y-2">
                  {active.map((f) => <ForecastRow key={f.public_token} f={f} />)}
                </ul>
              </section>
            ) : null}

            {past.length > 0 ? (
              <section className="space-y-2">
                <h2 className="text-[11px] uppercase tracking-wider text-wx-mute font-semibold">Past forecasts</h2>
                <ul className="space-y-2">
                  {past.map((f) => <ForecastRow key={f.public_token} f={f} />)}
                </ul>
              </section>
            ) : null}
          </>
        )}

        <footer className="text-[11px] text-wx-mute pt-3">
          Operator forecasts, not official products. Authoritative warnings come from your local NWS WFO.
          In an emergency, call 911. <Link href="/" className="hover:text-wx-fg">midsouthwx.app</Link>
        </footer>
      </div>
    </main>
  );
}
