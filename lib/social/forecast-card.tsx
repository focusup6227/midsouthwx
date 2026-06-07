// Branded social graphic for an operator forecast, rendered to PNG by
// `next/og` (Satori) in app/f/[token]/card/route.ts. Returns a plain React
// element tree — Satori only understands inline styles + flexbox, so there is
// no Tailwind here; the colors mirror tailwind.config.ts `wx.*` and the
// hazard tints from app/f/[token]/page.tsx. Sized 1080×1350 (Facebook 4:5
// portrait), which posts large in-feed and crops cleanly to the 1.91:1 link
// card if the URL is shared instead of the image.

export type ForecastCardData = {
  title: string;
  hazards: string[];
  confidence: string | null;
  status: string;
  validFrom: string;
  validUntil: string;
  discussion: string | null;
  verification?: {
    warnings_in_area?: number;
    lsrs_in_area?: number;
    hazard_match?: boolean;
  } | null;
};

const ACCENT = '#fbbf24';
const INK = '#0b1220';
const LINE = '#1f2937';
const FG = '#e5e7eb';
const MUTE = '#94a3b8';
const BODY = '#cbd5e1';

// Hazard chip colors, mirroring HAZARD_TINT in app/f/[token]/page.tsx.
const HAZARD_COLOR: Record<string, { bg: string; fg: string; border: string }> = {
  tornado: { bg: 'rgba(239,68,68,0.16)', fg: '#fca5a5', border: 'rgba(185,28,28,0.65)' },
  severe: { bg: 'rgba(249,115,22,0.16)', fg: '#fdba74', border: 'rgba(194,65,12,0.65)' },
  flood: { bg: 'rgba(16,185,129,0.16)', fg: '#6ee7b7', border: 'rgba(4,120,87,0.65)' },
  wind: { bg: 'rgba(139,92,246,0.16)', fg: '#c4b5fd', border: 'rgba(109,40,217,0.65)' },
  winter: { bg: 'rgba(56,189,248,0.16)', fg: '#7dd3fc', border: 'rgba(2,132,199,0.65)' },
  heat: { bg: 'rgba(251,191,36,0.16)', fg: '#fcd34d', border: 'rgba(180,83,9,0.65)' },
};

// Top-stripe accent follows the most attention-worthy hazard present.
const HAZARD_PRIORITY = ['tornado', 'severe', 'wind', 'flood', 'winter', 'heat'];
function hazardAccent(hazards: string[]): string {
  for (const h of HAZARD_PRIORITY) {
    if (hazards.includes(h)) return HAZARD_COLOR[h].fg;
  }
  return ACCENT;
}

function fmt(iso: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function truncate(s: string, max: number): string {
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

// Collapse runs of blank lines and clamp to a length that fills — but doesn't
// overflow — the body area at our font size, cutting on a word boundary.
function prepDiscussion(raw: string | null, max = 760): string | null {
  if (!raw) return null;
  const collapsed = raw.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!collapsed) return null;
  if (collapsed.length <= max) return collapsed;
  const cut = collapsed.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${cut.slice(0, lastSpace > max - 100 ? lastSpace : max).trimEnd()}…`;
}

export function forecastCardElement(d: ForecastCardData) {
  const hazards = (d.hazards ?? []).filter(Boolean);
  const accent = hazardAccent(hazards);
  const discussion = prepDiscussion(d.discussion);
  const title = truncate(d.title || 'Forecast', 90);
  const isClosed = d.status === 'closed';
  const v = d.verification;

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
        padding: '66px 64px 56px',
        position: 'relative',
      }}
    >
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 12, backgroundColor: accent }} />

      {/* Brand row */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div
          style={{
            display: 'flex',
            fontSize: 30,
            fontWeight: 700,
            letterSpacing: 4,
            color: ACCENT,
            textTransform: 'uppercase',
          }}
        >
          Mid-South WX
        </div>
        <div
          style={{
            display: 'flex',
            fontSize: 20,
            fontWeight: 600,
            letterSpacing: 2,
            color: MUTE,
            textTransform: 'uppercase',
            border: `1px solid ${LINE}`,
            borderRadius: 999,
            padding: '7px 18px',
          }}
        >
          {isClosed ? 'Closed forecast' : 'Issued forecast'}
        </div>
      </div>

      {/* Title */}
      <div style={{ display: 'flex', marginTop: 46, fontSize: 68, fontWeight: 700, lineHeight: 1.08, color: FG }}>
        {title}
      </div>

      {/* Hazard chips */}
      {hazards.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', marginTop: 30 }}>
          {hazards.map((h) => {
            const c = HAZARD_COLOR[h] ?? { bg: 'rgba(100,116,139,0.16)', fg: MUTE, border: LINE };
            return (
              <div
                key={h}
                style={{
                  display: 'flex',
                  fontSize: 24,
                  fontWeight: 600,
                  letterSpacing: 2,
                  textTransform: 'uppercase',
                  color: c.fg,
                  backgroundColor: c.bg,
                  border: `1px solid ${c.border}`,
                  borderRadius: 999,
                  padding: '8px 22px',
                  marginRight: 14,
                  marginBottom: 14,
                }}
              >
                {h}
              </div>
            );
          })}
        </div>
      ) : null}

      {/* Meta */}
      <div style={{ display: 'flex', flexDirection: 'column', marginTop: 26 }}>
        {d.confidence ? (
          <div style={{ display: 'flex', fontSize: 25, color: MUTE }}>{`Confidence: ${d.confidence}`}</div>
        ) : null}
        <div style={{ display: 'flex', fontSize: 25, color: MUTE, marginTop: 8 }}>
          {`Valid ${fmt(d.validFrom)} → ${fmt(d.validUntil)} CT`}
        </div>
      </div>

      <div style={{ display: 'flex', height: 1, backgroundColor: LINE, marginTop: 34, marginBottom: 34 }} />

      {/* Discussion fills the remaining height and clips gracefully */}
      <div
        style={{
          display: 'flex',
          flex: 1,
          fontSize: 31,
          lineHeight: 1.5,
          color: BODY,
          whiteSpace: 'pre-wrap',
          overflow: 'hidden',
        }}
      >
        {discussion ?? 'No written discussion was included with this forecast.'}
      </div>

      {/* Footer */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderTop: `1px solid ${LINE}`,
          paddingTop: 24,
          marginTop: 24,
        }}
      >
        <div style={{ display: 'flex', maxWidth: 760, fontSize: 22, color: MUTE }}>
          {isClosed && v
            ? `Verification — warnings: ${v.warnings_in_area ?? 0} · spotter reports: ${v.lsrs_in_area ?? 0} · hazard match: ${v.hazard_match ? 'yes' : 'no'}`
            : 'Operator forecast · authoritative warnings come from your local NWS WFO.'}
        </div>
        <div style={{ display: 'flex', fontSize: 26, fontWeight: 700, color: ACCENT }}>midsouthwx.app</div>
      </div>
    </div>
  );
}
