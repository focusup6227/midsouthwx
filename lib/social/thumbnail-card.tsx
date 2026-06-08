// YouTube thumbnail card (16:9, 1280×720): a full-bleed Mid-South map hero
// with SPC categorical risk + active warning outlines, a dark scrim, and a big
// punchy headline. Rendered by next/og (Satori) in app/cards/broadcast-thumb.
// Same projected-<svg>-over-<img> technique as the outlook card.

import type { OverlayPath } from './outlook-card';

export type ThumbCardData = {
  heroUrl: string | null;
  heroW: number;
  heroH: number;
  paths: OverlayPath[];
  headline: string;
  riskLabel: string;
  riskColor: string;
  dateText: string;
  brand: string;
};

const INK = '#0b1220';
const FG = '#f8fafc';

export function thumbnailCardElement(d: ThumbCardData) {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        position: 'relative',
        backgroundColor: INK,
        color: FG,
        fontFamily: 'Inter',
      }}
    >
      {/* Map hero with projected SPC/warning overlay, full-bleed */}
      <div style={{ display: 'flex', position: 'absolute', top: 0, left: 0, width: d.heroW, height: d.heroH }}>
        {d.heroUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={d.heroUrl} width={d.heroW} height={d.heroH} style={{ position: 'absolute', top: 0, left: 0 }} alt="" />
        ) : (
          <div style={{ display: 'flex', width: d.heroW, height: d.heroH, backgroundColor: '#111827' }} />
        )}
        <svg width={d.heroW} height={d.heroH} viewBox={`0 0 ${d.heroW} ${d.heroH}`} style={{ position: 'absolute', top: 0, left: 0 }}>
          {d.paths.map((p, i) => (
            <path key={i} d={p.d} fill={p.fill} stroke={p.stroke} strokeWidth={p.strokeWidth} strokeLinejoin="round" />
          ))}
        </svg>
      </div>

      {/* Bottom scrim so the headline stays legible over any basemap */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          height: 460,
          backgroundImage: 'linear-gradient(180deg, rgba(11,18,32,0) 0%, rgba(11,18,32,0.55) 45%, rgba(11,18,32,0.95) 100%)',
          display: 'flex',
        }}
      />

      {/* Top row: brand + risk badge */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '34px 44px',
        }}
      >
        <div style={{ display: 'flex', fontSize: 34, fontWeight: 700, letterSpacing: 4, color: '#fbbf24', textTransform: 'uppercase' }}>
          {d.brand}
        </div>
        <div
          style={{
            display: 'flex',
            fontSize: 30,
            fontWeight: 700,
            letterSpacing: 1,
            textTransform: 'uppercase',
            color: '#0b1220',
            backgroundColor: d.riskColor,
            borderRadius: 12,
            padding: '10px 22px',
          }}
        >
          {d.riskLabel}
        </div>
      </div>

      {/* Headline block, bottom-left */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          display: 'flex',
          flexDirection: 'column',
          padding: '0 50px 46px',
        }}
      >
        <div style={{ display: 'flex', width: 80, height: 10, backgroundColor: d.riskColor, borderRadius: 6, marginBottom: 18 }} />
        <div
          style={{
            display: 'flex',
            fontSize: 86,
            fontWeight: 700,
            lineHeight: 1.02,
            letterSpacing: -1,
            maxWidth: 1120,
            textShadow: '0 4px 24px rgba(0,0,0,0.6)',
          }}
        >
          {d.headline}
        </div>
        <div style={{ display: 'flex', fontSize: 30, fontWeight: 600, color: '#cbd5e1', marginTop: 14 }}>
          {d.dateText}
        </div>
      </div>
    </div>
  );
}
