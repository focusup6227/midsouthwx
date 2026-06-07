// Severe-weather outlook social card: SPC Day-1 categorical risk + active
// warning outlines over a Mapbox dark basemap, with a big risk badge and an
// active-warning summary. Rendered by next/og (Satori) in app/cards/outlook.
// The basemap is an <img> (Satori fetches it) and the polygons are a projected
// <svg> overlay sized to match — see lib/social/geo.ts.

export type OverlayPath = {
  d: string;
  fill: string;
  stroke: string;
  strokeWidth: number;
};

export type OutlookCardData = {
  heroUrl: string | null;
  heroW: number;
  heroH: number;
  paths: OverlayPath[];
  riskLabel: string;
  riskColor: string;
  validText: string;
  warningSummary: string;
  issuedText: string | null;
};

const ACCENT = '#fbbf24';
const INK = '#0b1220';
const CARD = '#111827';
const LINE = '#1f2937';
const FG = '#e5e7eb';
const MUTE = '#94a3b8';

export function outlookCardElement(d: OutlookCardData) {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: INK,
        color: FG,
        fontFamily: 'Inter',
        position: 'relative',
      }}
    >
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 12, backgroundColor: d.riskColor }} />

      {/* Header */}
      <div style={{ display: 'flex', flexDirection: 'column', padding: '54px 56px 22px' }}>
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', fontSize: 30, fontWeight: 700, letterSpacing: 4, color: ACCENT, textTransform: 'uppercase' }}>
            Mid-South WX
          </div>
          <div style={{ display: 'flex', fontSize: 20, fontWeight: 600, letterSpacing: 3, color: MUTE, textTransform: 'uppercase', border: `1px solid ${LINE}`, borderRadius: 999, padding: '7px 18px' }}>
            Severe Outlook
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', marginTop: 22 }}>
          <div
            style={{
              display: 'flex',
              fontSize: 40,
              fontWeight: 700,
              letterSpacing: 1,
              textTransform: 'uppercase',
              color: '#0b1220',
              backgroundColor: d.riskColor,
              borderRadius: 14,
              padding: '12px 26px',
            }}
          >
            {d.riskLabel}
          </div>
        </div>
      </div>

      {/* Map hero with projected overlay */}
      <div style={{ display: 'flex', position: 'relative', width: d.heroW, height: d.heroH }}>
        {d.heroUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={d.heroUrl} width={d.heroW} height={d.heroH} style={{ position: 'absolute', top: 0, left: 0 }} alt="" />
        ) : (
          <div style={{ display: 'flex', position: 'absolute', top: 0, left: 0, width: d.heroW, height: d.heroH, backgroundColor: CARD }} />
        )}
        <svg
          width={d.heroW}
          height={d.heroH}
          viewBox={`0 0 ${d.heroW} ${d.heroH}`}
          style={{ position: 'absolute', top: 0, left: 0 }}
        >
          {d.paths.map((p, i) => (
            <path key={i} d={p.d} fill={p.fill} stroke={p.stroke} strokeWidth={p.strokeWidth} strokeLinejoin="round" />
          ))}
        </svg>
      </div>

      {/* Body */}
      <div style={{ display: 'flex', flex: 1, flexDirection: 'column', justifyContent: 'center', padding: '26px 56px' }}>
        <div style={{ display: 'flex', fontSize: 34, fontWeight: 600, color: FG }}>{d.warningSummary}</div>
        <div style={{ display: 'flex', fontSize: 26, color: MUTE, marginTop: 12 }}>{d.validText}</div>
        {d.issuedText ? (
          <div style={{ display: 'flex', fontSize: 22, color: MUTE, marginTop: 6 }}>{d.issuedText}</div>
        ) : null}
      </div>

      {/* Footer */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderTop: `1px solid ${LINE}`,
          padding: '22px 56px 30px',
        }}
      >
        <div style={{ display: 'flex', maxWidth: 760, fontSize: 21, color: MUTE }}>
          SPC categorical outlook · authoritative warnings come from your local NWS WFO.
        </div>
        <div style={{ display: 'flex', fontSize: 26, fontWeight: 700, color: ACCENT }}>midsouthwx.app</div>
      </div>
    </div>
  );
}
