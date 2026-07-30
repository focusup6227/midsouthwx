'use client';

import type { ProductKey } from './radar-products';
import { PRODUCTS } from './radar-products';

// Horizontal color ramps matching the vertical strips on the collapsed
// inspector rail (RadarView ~line 4250) — one place to read what the colors
// on the map actually mean without opening the inspector.
const LEGENDS: Record<ProductKey, { gradient: string; left: string; mid?: string; right: string }> = {
  composite: {
    gradient: 'linear-gradient(90deg,#3b82f6 0%,#22d3ee 15%,#10b981 30%,#84cc16 45%,#facc15 60%,#f97316 75%,#ef4444 88%,#d946ef 100%)',
    left: '5', mid: '40', right: '75+ dBZ',
  },
  reflectivity: {
    gradient: 'linear-gradient(90deg,#3b82f6 0%,#22d3ee 15%,#10b981 30%,#84cc16 45%,#facc15 60%,#f97316 75%,#ef4444 88%,#d946ef 100%)',
    left: '5', mid: '40', right: '75+ dBZ',
  },
  velocity: {
    gradient: 'linear-gradient(90deg,#16a34a 0%,#22d3ee 25%,#e5e7eb 50%,#fb7185 75%,#b91c1c 100%)',
    left: 'inbound', mid: '0', right: 'outbound',
  },
  sw: {
    gradient: 'linear-gradient(90deg,#111827 0%,#1e3a8a 12%,#0ea5e9 25%,#10b981 38%,#facc15 50%,#f97316 62%,#ef4444 75%,#d946ef 100%)',
    left: '0', mid: '8', right: '16 m/s',
  },
  correlation: {
    gradient: 'linear-gradient(90deg,#1f2937 0%,#4b5563 30%,#6b7280 60%,#fbbf24 85%,#ef4444 100%)',
    left: '0.2', mid: '0.8', right: '1.0 ρhv',
  },
  zdr: {
    gradient: 'linear-gradient(90deg,#5b21b6 0%,#6b7280 25%,#9ca3af 33%,#22d3ee 42%,#10b981 50%,#84cc16 58%,#facc15 67%,#f97316 75%,#ef4444 83%,#fbcfe8 100%)',
    left: '−4', mid: '+2', right: '+8 dB',
  },
  kdp: {
    gradient: 'linear-gradient(90deg,#4b5563 0%,#1f2937 17%,#0ea5e9 25%,#10b981 33%,#84cc16 50%,#facc15 67%,#f97316 83%,#ec4899 100%)',
    left: '−1', mid: '+1.5', right: '+4 °/km',
  },
  rotation: {
    gradient: 'linear-gradient(90deg,#1e1b4b 0%,#6d28d9 40%,#d946ef 70%,#fde047 100%)',
    left: 'weak', right: 'strong',
  },
  satellite: {
    gradient: 'linear-gradient(90deg,#0f172a 0%,#475569 35%,#cbd5e1 70%,#f8fafc 100%)',
    left: 'warm', right: 'cold tops',
  },
};

/** Compact always-on color-scale legend for the active radar product. */
export default function ProductLegend({ product }: { product: ProductKey }) {
  const l = LEGENDS[product];
  if (!l) return null;
  return (
    <div className="w-44 rounded-lg border border-wx-line bg-wx-card/95 px-2.5 py-1.5 backdrop-blur-sm shadow-lg">
      <div className="mb-1 flex items-center justify-between">
        <span className="font-mono text-[9px] font-semibold tracking-wider text-wx-mute">
          {PRODUCTS[product].short}
        </span>
        <span className="truncate pl-2 text-[9px] text-wx-mute">{PRODUCTS[product].label}</span>
      </div>
      <div className="h-2 rounded-sm" style={{ background: l.gradient }} />
      <div className="mt-0.5 flex justify-between font-mono text-[9px] text-wx-mute">
        <span>{l.left}</span>
        {l.mid ? <span>{l.mid}</span> : null}
        <span>{l.right}</span>
      </div>
    </div>
  );
}
