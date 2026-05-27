export const NWS_STATUSES = [
  'new',
  'dispatched',
  'skipped',
  'superseded',
  'cancelled',
  'expired',
] as const;

export type NwsStatus = (typeof NWS_STATUSES)[number];

export const NWS_SEVERITIES = ['Extreme', 'Severe', 'Moderate', 'Minor', 'Unknown'] as const;

export const SEVERITY_TONE: Record<string, string> = {
  Extreme: 'bg-wx-danger text-black',
  Severe: 'bg-orange-500/90 text-black',
  Moderate: 'bg-yellow-500/80 text-black',
  Minor: 'bg-blue-500/70 text-white',
  Unknown: 'bg-wx-line text-wx-mute',
};

export const STATUS_TONE: Record<string, string> = {
  new: 'bg-wx-accent/20 text-wx-accent',
  dispatched: 'bg-wx-ok/20 text-wx-ok',
  skipped: 'bg-wx-line text-wx-mute',
  superseded: 'bg-wx-line text-wx-mute line-through',
  cancelled: 'bg-wx-line text-wx-mute',
  expired: 'bg-wx-line text-wx-mute',
};

export function relTime(iso: string | null, opts: { future?: boolean } = {}): string {
  if (!iso) return '—';
  const ms = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(ms);
  const m = Math.round(abs / 60000);
  const h = Math.round(abs / 3600000);
  const d = Math.round(abs / 86400000);
  let v: string;
  if (m < 1) v = 'just now';
  else if (m < 60) v = `${m}m`;
  else if (h < 24) v = `${h}h`;
  else v = `${d}d`;
  if (opts.future) return ms < 0 ? `expired ${v} ago` : `in ${v}`;
  return ms <= 0 ? `${v} ago` : `in ${v}`;
}

export function fmtTs(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

export function nwsApiUrl(nwsId: string): string {
  return nwsId.startsWith('http')
    ? nwsId
    : `https://api.weather.gov/alerts/${encodeURIComponent(nwsId)}`;
}

/** Strip characters that break PostgREST filter strings. */
export function sanitizeSearchQ(q: string): string {
  return q.replace(/[%_,]/g, ' ').trim().slice(0, 120);
}

/**
 * Detect Particularly Dangerous Situation (PDS) and Tornado Emergency
 * markers in an NWS alert's `raw.properties.parameters` block. NWS encodes
 * these as VTEC parameters; PDS appears in `tornadoDamageThreat` /
 * `damageThreat` as 'considerable' or 'destructive', and Tornado Emergency
 * appears as `tornadoDamageThreat = 'catastrophic'` OR a literal
 * "TORNADO EMERGENCY" string in the headline/description.
 *
 * Tornado Emergency is the rarest, highest-severity tornado warning class
 * (only used when the public is in imminent danger from a confirmed strong/
 * violent tornado). PDS is one rung below: confirmed tornado, considerable
 * damage threat. Both warrant distinct visual + audio treatment.
 */
export type AlertSeverityFlag = {
  isPds: boolean;
  isTornadoEmergency: boolean;
  /** Convenience: either flag is set. */
  any: boolean;
};

type RawAlertProps = {
  properties?: {
    parameters?: Record<string, unknown> | null;
    headline?: string | null;
    description?: string | null;
  } | null;
};

function readParameter(params: Record<string, unknown> | null | undefined, key: string): string | null {
  if (!params) return null;
  const raw = params[key];
  // NWS encodes parameters as arrays: { tornadoDamageThreat: ["CONSIDERABLE"] }
  if (Array.isArray(raw)) {
    const v = raw.find((x) => typeof x === 'string') as string | undefined;
    return v ? v.toLowerCase() : null;
  }
  if (typeof raw === 'string') return raw.toLowerCase();
  return null;
}

export function classifyAlertSeverity(raw: unknown, eventName?: string | null): AlertSeverityFlag {
  const props = (raw as RawAlertProps | null | undefined)?.properties ?? null;
  const params = props?.parameters ?? null;
  const headline = (props?.headline ?? '').toLowerCase();
  const description = (props?.description ?? '').toLowerCase();
  const evt = (eventName ?? '').toLowerCase();

  const torDamage = readParameter(params, 'tornadoDamageThreat');
  const damageThreat = readParameter(params, 'damageThreat');

  // Tornado Emergency: catastrophic damage threat, OR explicit literal in
  // headline/description, OR the event itself names it.
  const isTornadoEmergency =
    torDamage === 'catastrophic' ||
    /\btornado emergency\b/.test(headline) ||
    /\btornado emergency\b/.test(description) ||
    /\btornado emergency\b/.test(evt);

  // PDS: considerable or destructive damage threat on a tornado, OR explicit
  // "PARTICULARLY DANGEROUS SITUATION" marker. Tornado Emergency is strictly
  // higher than PDS, but they're not mutually exclusive in display — we treat
  // TorE as the most-severe and report both flags so callers can decide.
  const isPds =
    torDamage === 'considerable' ||
    torDamage === 'destructive' ||
    damageThreat === 'considerable' ||
    damageThreat === 'destructive' ||
    /particularly dangerous situation/.test(headline) ||
    /particularly dangerous situation/.test(description);

  return { isPds, isTornadoEmergency, any: isPds || isTornadoEmergency };
}
