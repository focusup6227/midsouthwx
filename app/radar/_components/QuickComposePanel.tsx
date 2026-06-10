'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Send, X } from 'lucide-react';
import { sendNow, type AudienceSpecT } from '@/app/compose/actions';

// Slide-over send panel for radar area selections. The old flow opened
// /compose in a new tab — 5-7 interactions and a full context switch away
// from the map. This keeps the radar visible and matches the NowcastPanel's
// "see it, send it" speed for the drawn-area path. Full compose remains one
// click away for templates, media, and check-ins.

const PRESETS: { label: string; body: string }[] = [
  {
    label: 'Tornado heads-up',
    body: '⚠️ Heads-up: rotation is being monitored near your area. Be ready to shelter quickly if a warning is issued. Watch local NWS alerts closely.',
  },
  {
    label: 'Severe storm',
    body: '⛈️ A strong storm is approaching your area — damaging wind and hail are possible. Move indoors and stay away from windows.',
  },
  {
    label: 'Flooding',
    body: '🌊 Flash flooding is possible in your area over the next few hours. Never drive through flooded roads — turn around, don’t drown.',
  },
  {
    label: 'All clear',
    body: '✅ The threat has passed for your area. Reply here if you have damage to report or need assistance.',
  },
];

type Props = {
  spec: AudienceSpecT;
  count: number | null;
  onClose: () => void;
  onSent?: (id: string, count: number) => void;
};

export default function QuickComposePanel({ spec, count, onClose, onSent }: Props) {
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ id: string; count: number } | null>(null);

  async function onSend() {
    if (!body.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      const res = await sendNow({
        body_md: body.trim(),
        audience_spec: spec,
        quick_replies: [],
        template_id: null,
        source: 'manual',
      });
      setSent(res);
      onSent?.(res.id, res.count);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Send failed');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="absolute inset-y-0 right-0 z-40 flex w-full max-w-[380px] flex-col border-l border-wx-line bg-wx-card/95 p-4 shadow-2xl backdrop-blur">
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wider text-wx-mute">
          Quick send · {count ?? '—'} in area
        </div>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-8 w-8 items-center justify-center text-wx-mute hover:text-wx-fg"
          aria-label="Close quick send"
        >
          <X size={16} />
        </button>
      </div>

      {sent ? (
        <div className="mt-4 space-y-3">
          <div className="rounded-lg border border-emerald-700 bg-emerald-500/10 p-3 text-sm text-emerald-300">
            ✓ Sent to {sent.count} subscriber{sent.count === 1 ? '' : 's'}.
          </div>
          <div className="flex gap-2">
            <Link href={`/alerts/${sent.id}`} target="_blank" className="btn-ghost text-xs px-2 py-1.5">
              View delivery →
            </Link>
            <button type="button" onClick={onClose} className="btn text-xs px-3 py-1.5">
              Done
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => setBody(p.body)}
                className="rounded-full border border-wx-line bg-wx-ink px-2.5 py-1 text-[11px] text-wx-mute hover:border-wx-accent hover:text-wx-fg"
              >
                {p.label}
              </button>
            ))}
          </div>

          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Message to everyone inside the drawn area…"
            rows={6}
            autoFocus
            className="input mt-3 w-full flex-none resize-y text-sm"
            maxLength={3500}
          />

          {error ? <div className="mt-2 text-xs text-wx-danger">{error}</div> : null}

          <button
            type="button"
            onClick={onSend}
            disabled={sending || !body.trim() || (count ?? 0) === 0}
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-wx-accent py-2 text-sm font-semibold text-black hover:bg-amber-300 disabled:opacity-50"
          >
            <Send size={14} /> {sending ? 'Sending…' : `Send to ${count ?? '—'} now`}
          </button>
          <p className="mt-2 text-[11px] text-wx-mute">
            Plain manual send — rings through quiet hours. Templates, media and
            check-ins live in full compose.
          </p>
        </>
      )}
    </div>
  );
}
