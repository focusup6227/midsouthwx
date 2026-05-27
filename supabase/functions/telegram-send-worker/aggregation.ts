// Outbreak aggregation: during a multi-warning window (typical convective
// outbreak), a single subscriber can sit inside the polygons of 3+ active
// warnings issued seconds apart. Pinging them N times is noisy and trains
// silence behavior. Instead we group all eligible warnings claimed in the
// same batch into ONE summary message per subscriber and mark the rest as
// sent in a single bulk UPDATE.
//
// Eligibility (per subscriber × per row):
//   - message_source = 'nws'
//   - NOT a Tornado Emergency — those always stand alone
//   - subscriber didn't opt out (alert_preferences.aggregate_warnings ≠ false)
//
// Hazard ranking decides which event drives the safety check-in buttons on
// the aggregated message: tornado > severe > flood > marine > other.

import type { AlertContext } from './index.ts';
import { formatImpactPrefix, timeToImpact, type StormMotion } from './impact.ts';

type HazardRank = 0 | 1 | 2 | 3 | 4;

const HAZARD_RANK_LABELS: Record<HazardRank, string> = {
  4: 'tornado',
  3: 'severe',
  2: 'flood',
  1: 'marine',
  0: 'other',
};

function hazardRank(event: string | null): HazardRank {
  if (!event) return 0;
  const e = event.toLowerCase();
  if (e.includes('tornado')) return 4;
  if (e.includes('severe thunderstorm') || e.includes('hail')) return 3;
  if (e.includes('flash flood') || e.includes('flood')) return 2;
  if (e.includes('marine')) return 1;
  return 0;
}

export function hazardKindOf(event: string | null): string {
  return HAZARD_RANK_LABELS[hazardRank(event)];
}

function hazardEmoji(event: string | null): string {
  switch (hazardRank(event)) {
    case 4: return '🌪️';
    case 3: return '⛈';
    case 2: return '💧';
    case 1: return '🌊';
    default: return '⚠️';
  }
}

export function isTornadoEmergency(event: string | null): boolean {
  if (!event) return false;
  return /tornado\s+emergency/i.test(event);
}

/** Aggregation opt-out lives in alert_preferences.aggregate_warnings; default
 *  is true (aggregate) when the key is missing entirely. */
export function subscriberWantsAggregation(prefs: unknown): boolean {
  if (!prefs || typeof prefs !== 'object') return true;
  const v = (prefs as Record<string, unknown>).aggregate_warnings;
  if (v === undefined || v === null) return true;
  return Boolean(v);
}

export type AggregationMember<R> = {
  row: R;
  context: AlertContext | undefined;
};

export type AggregationGroup<R> = {
  subscriberId: string;
  members: AggregationMember<R>[];
  /** The member whose row holds the lead message_id (drives buttons + the
   *  actual telegram_message_id captured in delivery_logs). Chosen as the
   *  highest-hazard row in the group. */
  lead: AggregationMember<R>;
};

/**
 * Group eligible rows by subscriber into aggregation groups of size ≥ 2.
 * Returns the set of row IDs marked for aggregation (to be filtered out of
 * the single-send loop) and the groups themselves.
 */
export function planAggregation<R extends {
  id: number;
  subscriber_id: string;
  message_source: string;
  nws_event: string | null;
  alert_preferences: unknown;
}>(
  rows: R[],
  contexts: Map<string, AlertContext>,
  getMessageId: (row: R) => string,
): { groups: AggregationGroup<R>[]; aggregatedRowIds: Set<number> } {
  // Bucket eligible rows by subscriber. Ineligible rows fall straight through
  // to the single-send loop and are never returned here.
  const eligibleBySub = new Map<string, R[]>();
  for (const row of rows) {
    if (row.message_source !== 'nws') continue;
    if (isTornadoEmergency(row.nws_event)) continue;
    if (!subscriberWantsAggregation(row.alert_preferences)) continue;
    const arr = eligibleBySub.get(row.subscriber_id) ?? [];
    arr.push(row);
    eligibleBySub.set(row.subscriber_id, arr);
  }

  const groups: AggregationGroup<R>[] = [];
  const aggregatedRowIds = new Set<number>();

  for (const [subscriberId, subRows] of eligibleBySub) {
    if (subRows.length < 2) continue; // Single warning — no merging.

    const members: AggregationMember<R>[] = subRows.map((row) => ({
      row,
      context: contexts.get(getMessageId(row)),
    }));

    // Lead = highest hazard rank; ties broken by earliest claimed (lowest id).
    members.sort((a, b) => {
      const dr = hazardRank(b.row.nws_event) - hazardRank(a.row.nws_event);
      if (dr !== 0) return dr;
      return a.row.id - b.row.id;
    });
    const lead = members[0];

    groups.push({ subscriberId, members, lead });
    for (const m of members) aggregatedRowIds.add(m.row.id);
  }

  return { groups, aggregatedRowIds };
}

/**
 * Render the aggregated message body. Each warning gets one line with hazard
 * emoji + event + county + (optional) closest-approach minutes.
 *
 * Output is plain text + light emoji — passed through the same
 * mdToTelegramHtml the single-send path uses, so any future HTML escaping
 * applies uniformly.
 */
export function formatAggregatedBody<R extends {
  nws_event: string | null;
  subscriber_lon: number | null;
  subscriber_lat: number | null;
}>(
  members: AggregationMember<R>[],
): string {
  // Sort lines by hazard rank desc (most urgent first) — operator-style
  // reading order so the subscriber sees the worst thing on top.
  const sorted = [...members].sort(
    (a, b) => hazardRank(b.row.nws_event) - hazardRank(a.row.nws_event),
  );

  const header = `⚠️ ${sorted.length} active warnings near you`;
  const lines = sorted.map((m) => {
    const event = m.row.nws_event ?? 'Weather Alert';
    const emoji = hazardEmoji(m.row.nws_event);
    const where = m.context?.areaDesc ? ` — ${shortenArea(m.context.areaDesc)}` : '';

    let etaSuffix = '';
    const motion: StormMotion | null = m.context?.motion ?? null;
    if (
      motion &&
      m.row.subscriber_lon != null &&
      m.row.subscriber_lat != null
    ) {
      const impact = timeToImpact(motion, {
        lon: m.row.subscriber_lon,
        lat: m.row.subscriber_lat,
      });
      if (impact) {
        const prefix = formatImpactPrefix(impact);
        if (prefix) {
          // formatImpactPrefix returns a trailing "\n\n". Strip and reuse
          // just the relevant numbers in parentheses for the aggregated line.
          etaSuffix = ` (~${Math.max(1, Math.round(impact.minutes))} min ${impact.bearingFromSub})`;
        }
      }
    }

    return `${emoji} ${event}${where}${etaSuffix}`;
  });

  return [header, '', ...lines, '', 'Reply ✅ or 🆘 below.'].join('\n');
}

/** NWS area_desc can be a long semicolon-joined list of counties. Keep the
 *  first 2 for the aggregated line so the message stays scannable. */
function shortenArea(areaDesc: string): string {
  const parts = areaDesc.split(/;|,/).map((s) => s.trim()).filter(Boolean);
  if (parts.length <= 2) return parts.join(', ');
  return `${parts.slice(0, 2).join(', ')} +${parts.length - 2}`;
}
