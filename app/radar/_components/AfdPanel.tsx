'use client';

import { useState } from 'react';
import { X } from 'lucide-react';
import { useAfd, type AfdItem } from '../_hooks/useRadarData';

const WFO_LABEL: Record<string, string> = {
  MEG: 'Memphis',
  LZK: 'Little Rock',
  JAN: 'Jackson',
  OHX: 'Nashville',
  MOB: 'Mobile',
  HUN: 'Huntsville',
  PAH: 'Paducah',
};

export default function AfdPanel() {
  const { data } = useAfd();
  const items = data?.items ?? [];
  const [open, setOpen] = useState<AfdItem | null>(null);

  if (items.length === 0) {
    return (
      <div className="text-[10.5px] text-wx-mute">
        No AFDs ingested yet. <code className="text-xs">afd-poll</code> runs every 30 min.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      {items.map((item) => {
        const issued = new Date(item.issued_at);
        const ageH = (Date.now() - issued.getTime()) / 3_600_000;
        const ageLabel =
          ageH < 1 ? `${Math.round(ageH * 60)}m` : `${ageH.toFixed(ageH < 10 ? 1 : 0)}h`;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => setOpen(item)}
            className="text-left flex items-center justify-between gap-2 p-2 rounded-lg bg-wx-ink border border-wx-line hover:border-wx-accent transition"
            title={`Issued ${issued.toLocaleString()}`}
          >
            <div className="min-w-0">
              <div className="text-[11px] font-semibold text-wx-fg">
                {item.wfo}
                <span className="ml-1.5 text-wx-mute font-normal">
                  · {WFO_LABEL[item.wfo] ?? ''}
                </span>
              </div>
              {/* AI digest first when present — it's a 2-sentence "what's
                  the forecaster worried about" — otherwise fall back to the
                  raw synopsis. */}
              {item.ai_summary ? (
                <p className="text-[10px] text-wx-fg/90 mt-0.5 line-clamp-3">{item.ai_summary}</p>
              ) : item.synopsis ? (
                <p className="text-[10px] text-wx-mute mt-0.5 line-clamp-2">{item.synopsis}</p>
              ) : null}
            </div>
            <span className="text-[10px] text-wx-mute whitespace-nowrap">{ageLabel} ago</span>
          </button>
        );
      })}

      {open ? <AfdModal item={open} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

function AfdModal({ item, onClose }: { item: AfdItem; onClose: () => void }) {
  const issued = new Date(item.issued_at);
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-2xl max-h-[80vh] overflow-hidden rounded-xl bg-wx-card border border-wx-line shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-3 border-b border-wx-line px-4 py-3">
          <div>
            <div className="text-sm font-semibold">
              {item.wfo} — {WFO_LABEL[item.wfo] ?? ''} Area Forecast Discussion
            </div>
            <div className="text-[11px] text-wx-mute mt-0.5">
              Issued {issued.toLocaleString()}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-wx-mute hover:text-wx-fg"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto wx-scroll px-4 py-3 space-y-4 text-[12.5px]">
          {item.ai_summary ? (
            <section className="rounded border border-wx-accent/40 bg-wx-accent/5 px-3 py-2">
              <div className="text-[10px] uppercase tracking-wider text-wx-accent font-semibold mb-1">
                AI digest
              </div>
              <p className="whitespace-pre-wrap text-wx-fg">{item.ai_summary}</p>
            </section>
          ) : null}
          {item.synopsis ? <Section label="Synopsis" body={item.synopsis} /> : null}
          {item.short_term ? <Section label="Short term" body={item.short_term} /> : null}
          {item.long_term ? <Section label="Long term" body={item.long_term} /> : null}
          {item.aviation ? <Section label="Aviation" body={item.aviation} /> : null}
          <details className="text-[11px]">
            <summary className="cursor-pointer text-wx-mute hover:text-wx-fg">
              Full raw text
            </summary>
            <pre className="mt-2 max-h-80 overflow-y-auto whitespace-pre-wrap rounded bg-wx-ink p-3 text-[11px] text-wx-fg/85 wx-scroll">
              {item.text}
            </pre>
          </details>
        </div>
      </div>
    </div>
  );
}

function Section({ label, body }: { label: string; body: string }) {
  return (
    <section>
      <div className="text-[10px] uppercase tracking-wider text-wx-mute font-semibold mb-1">
        {label}
      </div>
      <p className="whitespace-pre-wrap text-wx-fg/90">{body}</p>
    </section>
  );
}
