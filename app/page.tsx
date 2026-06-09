import Link from 'next/link';
import { Fraunces, Archivo, IBM_Plex_Mono } from 'next/font/google';

const display = Fraunces({
  subsets: ['latin'],
  style: ['normal', 'italic'],
  variable: '--font-display',
});
const sans = Archivo({ subsets: ['latin'], variable: '--font-sans' });
const mono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-mono',
});

export const revalidate = 300;

/** Live count of active NWS alerts across the tri-state area. Best-effort —
 *  the page renders a static fallback line if the API is slow or down. */
async function activeAlertCount(): Promise<number | null> {
  try {
    const res = await fetch(
      'https://api.weather.gov/alerts/active?area=TN,MS,AR',
      {
        headers: { 'user-agent': 'MidSouthWX landing page' },
        signal: AbortSignal.timeout(3500),
        next: { revalidate: 300 },
      },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { features?: unknown[] };
    return Array.isArray(data.features) ? data.features.length : null;
  } catch {
    return null;
  }
}

const STEPS = [
  {
    n: '01',
    title: 'Tell us where you are',
    body: 'A ZIP code is enough. Share a precise pin if you want warnings matched to your exact rooftop instead of the nearest town.',
  },
  {
    n: '02',
    title: 'Link Telegram',
    body: 'One tap opens a chat with the Mid-South WX bot. Press Start and you’re confirmed — no new app to learn if you already have Telegram.',
  },
  {
    n: '03',
    title: 'Get warned',
    body: 'When the National Weather Service draws a warning polygon that includes your location, a message lands in your DMs. No noise from storms that miss you.',
  },
] as const;

const FEATURES = [
  {
    tag: 'TOR',
    tagClass: 'text-red-400 border-red-500/40',
    title: 'Tornado Warnings',
    body: 'The one that matters most. Storm-based polygons, not county-wide blasts — if you’re in the path, you hear about it.',
  },
  {
    tag: 'SVR',
    tagClass: 'text-wx-accent border-wx-accent/40',
    title: 'Severe Thunderstorms',
    body: 'Damaging wind and large hail warnings for your location, with the details that matter pulled out of the NWS wall of text.',
  },
  {
    tag: 'FFW',
    tagClass: 'text-emerald-400 border-emerald-500/40',
    title: 'Flash Flooding',
    body: 'Flash flood warnings and emergencies as they’re issued. The Mid-South’s quietest killer, treated with the same urgency.',
  },
  {
    tag: 'CHK',
    tagClass: 'text-sky-400 border-sky-500/40',
    title: 'After-Storm Check-ins',
    body: 'When dangerous weather clears your area, you get a check-in. Reply that you’re OK — or say you need help, and the operator sees the address you left on file.',
  },
] as const;

export default async function MarketingHome() {
  const alerts = await activeAlertCount();

  return (
    <main
      className={`lp min-h-screen ${display.variable} ${sans.variable} ${mono.variable}`}
    >
      <div className="lp-grain" aria-hidden />

      {/* ───────────────────────── header ───────────────────────── */}
      <header className="relative z-10 max-w-6xl mx-auto px-6 pt-6 flex items-center justify-between">
        <div className="lp-mono text-sm font-semibold tracking-[0.2em] text-wx-fg">
          MID-SOUTH<span className="text-wx-accent">WX</span>
        </div>
        <nav className="flex items-center gap-6 text-sm">
          <a href="#how" className="hidden sm:block text-wx-mute hover:text-wx-fg transition-colors">
            How it works
          </a>
          <a href="#alerts" className="hidden sm:block text-wx-mute hover:text-wx-fg transition-colors">
            What you get
          </a>
          <Link href="/signup" className="lp-cta px-4 py-2 text-sm">
            Sign up
          </Link>
        </nav>
      </header>

      {/* ───────────────────────── hero ───────────────────────── */}
      <section className="relative overflow-hidden">
        <div className="lp-aurora" aria-hidden />
        <div
          className="lp-scope hidden md:block"
          aria-hidden
          style={{ width: 720, height: 720, right: '-180px', top: '-80px' }}
        />

        <div className="relative z-10 max-w-6xl mx-auto px-6 pt-20 pb-24 md:pt-28 md:pb-32">
          <p
            className="lp-mono lp-rise text-xs sm:text-sm text-wx-accent tracking-[0.18em] flex items-center gap-3"
            style={{ animationDelay: '0.05s' }}
          >
            <span className="lp-live" aria-hidden />
            {alerts !== null
              ? `LIVE · ${alerts} ACTIVE NWS ALERT${alerts === 1 ? '' : 'S'} · TN / MS / AR`
              : 'WATCHING THE NWS FEED · TN / MS / AR'}
          </p>

          <h1
            className="lp-display lp-rise mt-6 text-5xl sm:text-6xl md:text-7xl font-semibold leading-[1.04] max-w-3xl"
            style={{ animationDelay: '0.15s' }}
          >
            The warning finds you{' '}
            <em className="text-wx-accent">before</em> the storm does.
          </h1>

          <p
            className="lp-rise mt-7 text-lg text-wx-mute max-w-xl leading-relaxed"
            style={{ animationDelay: '0.3s' }}
          >
            Mid-South WX watches every National Weather Service alert for the
            Memphis metro and surrounding counties, matches warning polygons
            against your exact location, and sends you a Telegram message when
            one includes you. A real person is on the radar — not just a
            script.
          </p>

          <div
            className="lp-rise mt-10 flex flex-wrap items-center gap-4"
            style={{ animationDelay: '0.45s' }}
          >
            <Link href="/signup" className="lp-cta px-7 py-3.5 text-base">
              Sign up for alerts
            </Link>
            <a href="#how" className="lp-ghost px-7 py-3.5 text-base">
              How it works
            </a>
          </div>

          <dl
            className="lp-mono lp-rise mt-16 grid grid-cols-1 sm:grid-cols-3 gap-x-8 gap-y-5 max-w-2xl text-xs"
            style={{ animationDelay: '0.6s' }}
          >
            {[
              ['STORM-BASED POLYGONS', 'your location, not your whole county'],
              ['AROUND THE CLOCK', 'the NWS feed is polled continuously'],
              ['HUMAN IN THE LOOP', 'an operator watching the radar'],
            ].map(([k, v]) => (
              <div key={k}>
                <dt className="text-wx-fg font-semibold tracking-[0.14em]">{k}</dt>
                <dd className="mt-1 text-wx-mute tracking-normal">{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <div className="lp-line max-w-6xl mx-auto" />

      {/* ───────────────────────── how it works ───────────────────────── */}
      <section id="how" className="relative z-10 max-w-6xl mx-auto px-6 py-24">
        <p className="lp-mono text-xs text-wx-accent tracking-[0.18em]">HOW IT WORKS</p>
        <h2 className="lp-display mt-3 text-3xl sm:text-4xl font-semibold">
          Three steps, about two minutes.
        </h2>

        <ol className="mt-12 grid grid-cols-1 md:grid-cols-3 gap-5">
          {STEPS.map((s) => (
            <li key={s.n} className="lp-card p-7">
              <span className="lp-display text-4xl text-wx-accent/80 italic">
                {s.n}
              </span>
              <h3 className="mt-4 text-lg font-semibold">{s.title}</h3>
              <p className="mt-2 text-sm text-wx-mute leading-relaxed">{s.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <div className="lp-line max-w-6xl mx-auto" />

      {/* ───────────────────────── what you get ───────────────────────── */}
      <section id="alerts" className="relative z-10 max-w-6xl mx-auto px-6 py-24">
        <p className="lp-mono text-xs text-wx-accent tracking-[0.18em]">WHAT LANDS IN YOUR DMS</p>
        <h2 className="lp-display mt-3 text-3xl sm:text-4xl font-semibold max-w-2xl">
          Only the weather that can hurt you.
        </h2>

        <div className="mt-12 grid grid-cols-1 sm:grid-cols-2 gap-5">
          {FEATURES.map((f) => (
            <div key={f.tag} className="lp-card p-7">
              <span
                className={`lp-mono inline-block text-[11px] font-semibold tracking-[0.14em] border rounded px-2 py-0.5 ${f.tagClass}`}
              >
                {f.tag}
              </span>
              <h3 className="mt-4 text-lg font-semibold">{f.title}</h3>
              <p className="mt-2 text-sm text-wx-mute leading-relaxed">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      <div className="lp-line max-w-6xl mx-auto" />

      {/* ───────────────────────── closing CTA ───────────────────────── */}
      <section className="relative z-10 max-w-6xl mx-auto px-6 py-24 text-center">
        <h2 className="lp-display text-4xl sm:text-5xl font-semibold leading-tight max-w-2xl mx-auto">
          Built for the Mid-South.{' '}
          <em className="text-wx-accent">Watching when you can&apos;t.</em>
        </h2>
        <p className="mt-5 text-wx-mute max-w-lg mx-auto">
          Memphis metro, West Tennessee, North Mississippi, East Arkansas. Free
          to sign up — all you need is Telegram.
        </p>
        <Link href="/signup" className="lp-cta inline-block mt-9 px-8 py-4 text-base">
          Sign up for alerts
        </Link>
      </section>

      {/* ───────────────────────── footer ───────────────────────── */}
      <footer className="relative z-10 border-t border-wx-line">
        <div className="max-w-6xl mx-auto px-6 py-10 flex flex-col sm:flex-row gap-6 sm:items-center justify-between">
          <div>
            <div className="lp-mono text-xs font-semibold tracking-[0.2em]">
              MID-SOUTH<span className="text-wx-accent">WX</span>
            </div>
            <p className="mt-3 text-xs text-wx-mute max-w-md leading-relaxed">
              Alert data comes from the National Weather Service. This service
              is a supplement — not a replacement — for Wireless Emergency
              Alerts, NOAA Weather Radio, and local sirens. Always have more
              than one way to receive warnings.
            </p>
          </div>
          <Link
            href="/login"
            className="text-xs text-wx-mute hover:text-wx-fg transition-colors shrink-0"
          >
            Operator sign-in →
          </Link>
        </div>
      </footer>
    </main>
  );
}
