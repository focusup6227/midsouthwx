// Daily forecast social card: a row of NWS forecast periods (Today / Tonight /
// next days) with icon, temperature, conditions, wind and precip — TV-style,
// postable every morning. Rendered by next/og (Satori) in app/cards/daily.

export type DailyPeriod = {
  name: string;
  temp: number | null;
  unit: string;
  isDay: boolean;
  shortForecast: string;
  windText: string;
  popText: string;
  iconUrl: string | null;
};

export type DailyCardData = {
  place: string;
  updatedText: string | null;
  periods: DailyPeriod[];
};

const ACCENT = '#fbbf24';
const INK = '#0b1220';
const CARD = '#111827';
const LINE = '#1f2937';
const FG = '#e5e7eb';
const MUTE = '#94a3b8';

// Warm/cool tint for the temperature number.
function tempColor(t: number | null): string {
  if (t == null) return FG;
  if (t >= 90) return '#fb7185';
  if (t >= 75) return '#fbbf24';
  if (t >= 55) return '#e5e7eb';
  if (t >= 35) return '#7dd3fc';
  return '#93c5fd';
}

export function dailyCardElement(d: DailyCardData) {
  const periods = d.periods.slice(0, 5);
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
        padding: '64px 56px 56px',
        position: 'relative',
      }}
    >
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 12, backgroundColor: ACCENT }} />

      {/* Header */}
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', fontSize: 30, fontWeight: 700, letterSpacing: 4, color: ACCENT, textTransform: 'uppercase' }}>
          Mid-South WX
        </div>
        <div style={{ display: 'flex', fontSize: 20, fontWeight: 600, letterSpacing: 3, color: MUTE, textTransform: 'uppercase', border: `1px solid ${LINE}`, borderRadius: 999, padding: '7px 18px' }}>
          Daily Forecast
        </div>
      </div>

      <div style={{ display: 'flex', marginTop: 40, fontSize: 64, fontWeight: 700, color: FG }}>{d.place}</div>
      {d.updatedText ? (
        <div style={{ display: 'flex', fontSize: 24, color: MUTE, marginTop: 8 }}>{d.updatedText}</div>
      ) : null}

      <div style={{ display: 'flex', height: 1, backgroundColor: LINE, marginTop: 30, marginBottom: 4 }} />

      {/* Period tiles */}
      <div style={{ display: 'flex', flex: 1, flexDirection: 'row', alignItems: 'stretch' }}>
        {periods.length === 0 ? (
          <div style={{ display: 'flex', flex: 1, alignItems: 'center', justifyContent: 'center', fontSize: 30, color: MUTE }}>
            Forecast temporarily unavailable
          </div>
        ) : (
          periods.map((p, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                flex: 1,
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'flex-start',
                padding: '24px 10px',
                margin: '18px 6px',
                backgroundColor: CARD,
                border: `1px solid ${LINE}`,
                borderRadius: 18,
              }}
            >
              <div style={{ display: 'flex', fontSize: 24, fontWeight: 600, letterSpacing: 1, color: MUTE, textTransform: 'uppercase', textAlign: 'center' }}>
                {p.name}
              </div>
              {p.iconUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={p.iconUrl} width={104} height={104} style={{ borderRadius: 14, marginTop: 16, marginBottom: 14 }} alt="" />
              ) : (
                <div style={{ display: 'flex', width: 104, height: 104, marginTop: 16, marginBottom: 14 }} />
              )}
              <div style={{ display: 'flex', fontSize: 56, fontWeight: 700, color: tempColor(p.temp) }}>
                {p.temp == null ? '—' : `${p.temp}°`}
              </div>
              <div style={{ display: 'flex', fontSize: 21, lineHeight: 1.25, color: FG, marginTop: 10, textAlign: 'center' }}>
                {p.shortForecast}
              </div>
              <div style={{ display: 'flex', fontSize: 19, color: MUTE, marginTop: 12, textAlign: 'center' }}>{p.windText}</div>
              <div style={{ display: 'flex', fontSize: 19, color: '#7dd3fc', marginTop: 4 }}>{p.popText}</div>
            </div>
          ))
        )}
      </div>

      {/* Footer */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderTop: `1px solid ${LINE}`,
          paddingTop: 22,
          marginTop: 12,
        }}
      >
        <div style={{ display: 'flex', fontSize: 21, color: MUTE }}>Source: National Weather Service</div>
        <div style={{ display: 'flex', fontSize: 26, fontWeight: 700, color: ACCENT }}>midsouthwx.app</div>
      </div>
    </div>
  );
}
