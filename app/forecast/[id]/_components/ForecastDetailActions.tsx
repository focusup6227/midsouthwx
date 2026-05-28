'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Send, MessageSquare, Save } from 'lucide-react';
import { broadcastForecast, composeFromForecast } from '../../actions';
import { createForecastTemplateFromForecast } from '../../templates/actions';

type Hazard = string;

export default function ForecastDetailActions({
  id,
  status,
  alreadyBroadcast,
  broadcastMessageId,
  hazards,
  confidence,
}: {
  id: string;
  status: string;
  alreadyBroadcast: boolean;
  broadcastMessageId: string | null;
  hazards: Hazard[];
  confidence: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [showTemplate, setShowTemplate] = useState(false);
  const [tplName, setTplName] = useState(
    confidence ? `Morning outlook (${confidence})` : 'Morning outlook',
  );
  const [tplCadence, setTplCadence] = useState<'daily' | 'weekly'>('daily');
  const [tplHour, setTplHour] = useState(11);
  const [tplWindow, setTplWindow] = useState(12);
  const [error, setError] = useState<string | null>(null);

  const run = (fn: () => Promise<unknown>) => () => {
    setError(null);
    startTransition(async () => {
      try {
        await fn();
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'failed');
      }
    });
  };

  return (
    <div className="flex flex-wrap gap-2 items-start">
      {alreadyBroadcast && broadcastMessageId ? (
        <a
          href={`/m/${broadcastMessageId}`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-2 rounded-lg border border-emerald-700 bg-emerald-500/10 px-3 py-1.5 text-sm font-semibold text-emerald-300 hover:bg-emerald-500/20"
        >
          <Send size={14} /> View broadcast
        </a>
      ) : (
        <button
          type="button"
          disabled={pending}
          className="inline-flex items-center gap-2 rounded-lg bg-wx-accent px-3 py-1.5 text-sm font-semibold text-black hover:bg-amber-300 disabled:opacity-50"
          onClick={() => {
            if (!confirm('Broadcast this forecast to every subscriber whose pin sits inside the polygon? This sends a Telegram message immediately.')) return;
            run(() => broadcastForecast(id))();
          }}
        >
          <Send size={14} /> {pending ? 'Broadcasting…' : 'Broadcast now'}
        </button>
      )}

      <button
        type="button"
        disabled={pending}
        className="inline-flex items-center gap-2 rounded-lg border border-wx-line bg-wx-card px-3 py-1.5 text-sm hover:border-wx-mute"
        onClick={() => startTransition(() => composeFromForecast(id))}
      >
        <MessageSquare size={14} /> Edit in compose
      </button>

      <button
        type="button"
        disabled={pending}
        className="inline-flex items-center gap-2 rounded-lg border border-wx-line bg-wx-card px-3 py-1.5 text-sm hover:border-wx-mute"
        onClick={() => setShowTemplate((v) => !v)}
      >
        <Save size={14} /> {showTemplate ? 'Cancel' : 'Save as template'}
      </button>

      {showTemplate ? (
        <div className="basis-full bg-wx-card border border-wx-line rounded-lg p-3 space-y-2 mt-1">
          <div className="text-[11px] uppercase tracking-wider text-wx-mute font-semibold">
            New template — reuses this forecast&apos;s area &amp; hazards
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <label className="space-y-1">
              <div className="text-wx-mute">Name</div>
              <input
                value={tplName}
                onChange={(e) => setTplName(e.target.value)}
                className="w-full bg-wx-ink border border-wx-line rounded px-2 py-1"
              />
            </label>
            <label className="space-y-1">
              <div className="text-wx-mute">Cadence</div>
              <select
                value={tplCadence}
                onChange={(e) => setTplCadence(e.target.value as 'daily' | 'weekly')}
                className="w-full bg-wx-ink border border-wx-line rounded px-2 py-1"
              >
                <option value="daily">daily</option>
                <option value="weekly">weekly</option>
              </select>
            </label>
            <label className="space-y-1">
              <div className="text-wx-mute">Hour (UTC)</div>
              <input
                type="number"
                min={0}
                max={23}
                value={tplHour}
                onChange={(e) => setTplHour(Math.max(0, Math.min(23, parseInt(e.target.value, 10) || 0)))}
                className="w-full bg-wx-ink border border-wx-line rounded px-2 py-1"
              />
            </label>
            <label className="space-y-1">
              <div className="text-wx-mute">Window (h)</div>
              <input
                type="number"
                min={1}
                max={168}
                value={tplWindow}
                onChange={(e) => setTplWindow(Math.max(1, Math.min(168, parseInt(e.target.value, 10) || 1)))}
                className="w-full bg-wx-ink border border-wx-line rounded px-2 py-1"
              />
            </label>
          </div>
          <div className="flex gap-2 items-center">
            <button
              type="button"
              disabled={pending || !tplName.trim()}
              className="btn-ghost text-xs text-sky-300"
              onClick={run(async () => {
                await createForecastTemplateFromForecast({
                  source_forecast_id: id,
                  name: tplName.trim(),
                  cadence: tplCadence,
                  hour_of_day: tplHour,
                  window_hours: tplWindow,
                });
                setShowTemplate(false);
              })}
            >
              {pending ? 'Saving…' : 'Save template'}
            </button>
            <a
              href="/forecast/templates"
              className="btn-ghost text-xs"
            >
              Manage templates
            </a>
          </div>
        </div>
      ) : null}

      {error ? <div className="basis-full text-[11px] text-wx-danger">{error}</div> : null}

      <span className="basis-full text-[10px] text-wx-mute pl-1">
        Status: <span className="text-wx-fg">{status}</span>
      </span>
    </div>
  );
}
