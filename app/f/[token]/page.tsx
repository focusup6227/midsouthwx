import Link from 'next/link';
import { notFound } from 'next/navigation';
import { supabaseAdmin } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

type Forecast = {
  id: string;
  title: string;
  hazards: string[] | null;
  confidence: string | null;
  status: string;
  valid_from: string;
  valid_until: string;
  discussion: string | null;
  verification: unknown;
  created_at: string;
};

function fmt(dt: string): string {
  try {
    return new Date(dt).toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
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

// Anon route — uses supabaseAdmin to dodge the operator-only RLS on the
// forecast row indirectly. The public_token check on the row + status filter
// is the actual access control.
export default async function PublicForecastPage({ params }: { params: { token: string } }) {
  const admin = supabaseAdmin();
  const { data, error } = await admin
    .from('forecasts')
    .select('id, title, hazards, confidence, status, valid_from, valid_until, discussion, verification, created_at, public_token')
    .eq('public_token', params.token)
    .in('status', ['issued', 'closed'])
    .maybeSingle();
  if (error || !data) return notFound();
  const f = data as Forecast;

  const verification = f.verification as null | {
    lsrs_in_area?: number;
    warnings_in_area?: number;
    hazard_match?: boolean;
    skill?: { csi?: number | null; pod?: number | null; far?: number | null };
  };

  return (
    <main className="min-h-screen bg-wx-ink text-wx-fg">
      <div className="mx-auto max-w-3xl px-5 py-8 space-y-6">
        <header className="space-y-2">
          <div className="text-[11px] uppercase tracking-wider text-wx-mute font-semibold">
            Mid-South WX · {f.status === 'closed' ? 'Closed forecast' : 'Issued forecast'}
          </div>
          <h1 className="text-2xl font-bold">{f.title}</h1>
          <div className="flex flex-wrap items-center gap-2">
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
            {f.confidence ? (
              <span className="text-xs text-wx-mute">
                confidence: <span className="text-wx-fg">{f.confidence}</span>
              </span>
            ) : null}
          </div>
          <div className="text-xs font-mono text-wx-mute">
            valid {fmt(f.valid_from)} → {fmt(f.valid_until)}
          </div>
        </header>

        {f.discussion ? (
          <section className="rounded-lg border border-wx-line bg-wx-card p-5">
            <div className="whitespace-pre-wrap leading-relaxed text-[15px]">
              {f.discussion}
            </div>
          </section>
        ) : (
          <p className="text-wx-mute italic text-sm">No written discussion was included with this forecast.</p>
        )}

        {f.status === 'closed' && verification ? (
          <section className="rounded-lg border border-wx-line bg-wx-card p-5 space-y-3">
            <div className="text-[11px] uppercase tracking-wider text-wx-mute font-semibold">
              Verification
            </div>
            <div className="grid grid-cols-3 gap-2">
              <Stat label="Warnings in area" value={verification.warnings_in_area ?? 0} />
              <Stat label="Spotter reports" value={verification.lsrs_in_area ?? 0} />
              <Stat
                label="Hazard match"
                value={verification.hazard_match ? 'yes' : 'no'}
                tint={verification.hazard_match ? 'text-emerald-300' : 'text-wx-mute'}
              />
            </div>
            {verification.skill ? (
              <div className="grid grid-cols-3 gap-2 mt-2">
                <Stat label="CSI" value={fmtScore(verification.skill.csi)} />
                <Stat label="POD" value={fmtScore(verification.skill.pod)} />
                <Stat label="FAR" value={fmtScore(verification.skill.far)} />
              </div>
            ) : null}
            <div className="text-[10px] text-wx-mute pt-1">
              CSI: critical success index · POD: probability of detection · FAR: false alarm ratio.
              Scored from NWS warnings + spotter ground truth inside the forecast area &amp; window.
            </div>
          </section>
        ) : null}

        <footer className="text-[11px] text-wx-mute pt-3">
          Operator forecast. Authoritative warnings come from your local NWS WFO. In an emergency, call 911.{' '}
          <Link href="/" className="hover:text-wx-fg">midsouthwx.com</Link>
        </footer>
      </div>
    </main>
  );
}

function Stat({ label, value, tint }: { label: string; value: string | number; tint?: string }) {
  return (
    <div className="rounded border border-wx-line bg-wx-ink p-2">
      <div className="text-[9px] uppercase tracking-wider text-wx-mute">{label}</div>
      <div className={`text-lg font-semibold ${tint ?? ''}`}>{value}</div>
    </div>
  );
}

function fmtScore(n: number | null | undefined): string {
  if (n == null) return '—';
  return n.toFixed(2);
}
