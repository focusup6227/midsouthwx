import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Send } from 'lucide-react';
import DashShell from '@/components/DashShell';
import { supabaseServer } from '@/lib/supabase/server';
import { composeFromForecast } from '../actions';
import Scorecard from './_components/Scorecard';

export const dynamic = 'force-dynamic';

type ForecastDetail = {
  id: string;
  title: string;
  hazards: string[] | null;
  confidence: string | null;
  status: string;
  valid_from: string;
  valid_until: string;
  discussion: string | null;
  source_refs: unknown;
  ai_draft: unknown;
  verification: unknown;
  created_at: string;
  updated_at: string;
};

function fmt(dt: string): string {
  try {
    return new Date(dt).toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch {
    return dt;
  }
}

export default async function ForecastDetailPage({ params }: { params: { id: string } }) {
  const supa = supabaseServer();
  const { data, error } = await supa
    .from('forecasts')
    .select('id, title, hazards, confidence, status, valid_from, valid_until, discussion, source_refs, ai_draft, verification, created_at, updated_at')
    .eq('id', params.id)
    .single();
  if (error || !data) return notFound();
  const f = data as ForecastDetail;

  // Bind the id into the server action so the submit button can fire it
  // without a client wrapper. composeFromForecast() redirects on success.
  const sendAction = composeFromForecast.bind(null, f.id);

  return (
    <DashShell
      title={f.title}
      width="normal"
      backHref="/forecast"
      actions={
        <form action={sendAction}>
          <button
            type="submit"
            className="inline-flex items-center gap-2 rounded-lg bg-wx-accent px-3 py-1.5 text-sm font-semibold text-black hover:bg-amber-300"
          >
            <Send size={14} /> Send to subscribers
          </button>
        </form>
      }
    >
      <div className="grid gap-4 md:grid-cols-[1fr_200px]">
        <div className="space-y-3 rounded-lg border border-wx-line bg-wx-card p-4">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="rounded-full border border-amber-700 bg-amber-500/10 px-2 py-[1px] text-[10px] font-semibold uppercase tracking-wider text-amber-300">
              {f.status}
            </span>
            {(f.hazards ?? []).map((h) => (
              <span key={h} className="rounded border border-wx-line bg-wx-ink px-1.5 py-[1px] text-[10px] uppercase tracking-wider text-wx-mute">
                {h}
              </span>
            ))}
            {f.confidence ? (
              <span className="text-wx-mute">confidence: <span className="text-wx-fg">{f.confidence}</span></span>
            ) : null}
          </div>
          <div className="text-sm text-wx-mute">
            Valid <span className="text-wx-fg">{fmt(f.valid_from)}</span> → <span className="text-wx-fg">{fmt(f.valid_until)}</span>
          </div>
          {f.discussion ? (
            <div className="whitespace-pre-wrap rounded-md border border-wx-line bg-wx-ink p-3 text-sm text-wx-fg">
              {f.discussion}
            </div>
          ) : (
            <div className="rounded-md border border-dashed border-wx-line bg-wx-ink/30 p-3 text-xs text-wx-mute">
              No discussion text recorded.
            </div>
          )}
        </div>

        <aside className="space-y-3 text-xs text-wx-mute">
          <div className="rounded-lg border border-wx-line bg-wx-card p-3">
            <div className="font-semibold uppercase tracking-wider text-[10px]">Created</div>
            <div className="mt-0.5 text-wx-fg">{fmt(f.created_at)}</div>
          </div>
          <Scorecard
            forecastId={f.id}
            verification={(f.verification as Parameters<typeof Scorecard>[0]['verification']) ?? null}
            validUntil={f.valid_until}
          />
          <div className="rounded-lg border border-wx-line bg-wx-card p-3">
            <div className="font-semibold uppercase tracking-wider text-[10px]">AI draft</div>
            <div className="mt-0.5">
              {f.ai_draft ? (
                <span className="text-wx-fg">Stored ({Object.keys(f.ai_draft as Record<string, unknown>).length} keys)</span>
              ) : (
                <span className="text-wx-mute">No AI draft attached.</span>
              )}
            </div>
          </div>
          <Link href="/forecast" className="block text-center text-wx-accent">All forecasts →</Link>
        </aside>
      </div>
    </DashShell>
  );
}
