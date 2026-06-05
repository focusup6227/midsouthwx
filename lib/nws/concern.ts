// Concern type — *what an alert is about*, as opposed to *how severe* it is.
//
// Watches and warnings carry their concern in the event string ("Tornado
// Watch" vs "Severe Thunderstorm Watch"), so classifyNwsEvent's hazard kind is
// already the concern. Mesoscale Discussions are all event="Mesoscale
// Discussion" with the actual concern buried in the product body — so for MDs
// we classify from the discussion text. This lets the radar tint an MD/watch
// polygon by tornado vs severe vs winter vs fire vs flood at a glance, which is
// what an operator triages on during an event.

export type ConcernType =
  | 'tornado'
  | 'severe'
  | 'flood'
  | 'winter'
  | 'fire'
  | 'wind'
  | 'other';

// Map colors, shared by the map paint expression and the inspector chips so the
// two never drift. Tuned to read distinctly on the dark basemap.
export const CONCERN_COLORS: Record<ConcernType, string> = {
  tornado: '#ef4444', // red — highest urgency
  severe: '#f59e0b', // amber — severe convective
  flood: '#10b981', // green — hydro
  winter: '#818cf8', // indigo — winter wx
  fire: '#fb923c', // orange — fire weather
  wind: '#38bdf8', // sky — non-convective wind
  other: '#d946ef', // fuchsia — generic MD (matches legacy discussion tint)
};

export const CONCERN_LABELS: Record<ConcernType, string> = {
  tornado: 'Tornado',
  severe: 'Severe',
  flood: 'Flood',
  winter: 'Winter',
  fire: 'Fire wx',
  wind: 'Wind',
  other: 'General',
};

/**
 * Classify an MD's concern from its product text. Ordered by triage priority:
 * tornado first (a severe MD that also mentions tornado potential is a tornado
 * concern), then the mutually-distinct hydro / fire / winter buckets, then
 * generic severe-convective, else "other".
 */
export function classifyMdConcernType(text: string | null): ConcernType {
  const t = (text ?? '').toLowerCase();
  if (!t) return 'other';
  if (/tornado/.test(t)) return 'tornado';
  if (/flash flood|flooding|excessive rain|heavy rain|rainfall/.test(t)) return 'flood';
  if (/fire weather|red flag|critical fire|fire wx|low (?:rh|humidity)/.test(t)) return 'fire';
  if (/snow|winter|ice(?!\s*free)|freezing|sleet|blizzard|wintry/.test(t)) return 'winter';
  if (/severe|thunderstorm|hail|damaging wind|wind gust|derecho|squall/.test(t)) return 'severe';
  return 'other';
}

/**
 * Unified concern classifier for any radar alert. Non-MD alerts use the event
 * string (already the concern); MDs fall back to the discussion body. `text` is
 * only needed for MDs — pass the stored description.
 */
export function classifyConcernType(event: string, text?: string | null): ConcernType {
  const e = (event ?? '').toLowerCase();
  if (e.includes('mesoscale discussion')) return classifyMdConcernType(text ?? null);
  if (e.includes('tornado')) return 'tornado';
  if (e.includes('severe thunderstorm') || e.includes('hail')) return 'severe';
  if (e.includes('flood')) return 'flood';
  if (e.includes('fire') || e.includes('red flag')) return 'fire';
  if (e.includes('winter') || e.includes('ice') || e.includes('blizzard') || e.includes('freeze') || e.includes('snow')) {
    return 'winter';
  }
  if (e.includes('wind') || e.includes('gale')) return 'wind';
  return 'other';
}
