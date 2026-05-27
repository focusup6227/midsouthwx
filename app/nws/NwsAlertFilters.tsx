import Link from 'next/link';
import { NWS_SEVERITIES, NWS_STATUSES } from '@/lib/nws/display';

export type NwsListFilters = {
  status: string | null;
  severity: string | null;
  q: string | null;
  activeOnly: boolean;
};

function buildHref(next: Partial<NwsListFilters>): string {
  const p = new URLSearchParams();
  const merged: NwsListFilters = {
    status: next.status !== undefined ? next.status : null,
    severity: next.severity !== undefined ? next.severity : null,
    q: next.q !== undefined ? next.q : null,
    activeOnly: next.activeOnly ?? false,
  };
  if (merged.status) p.set('status', merged.status);
  if (merged.severity) p.set('severity', merged.severity);
  if (merged.q) p.set('q', merged.q);
  if (merged.activeOnly) p.set('active', '1');
  const qs = p.toString();
  return qs ? `/nws?${qs}` : '/nws';
}

type Props = {
  filters: NwsListFilters;
  statusCounts: Map<string, number>;
  totalAlerts: number;
};

export default function NwsAlertFilters({ filters, statusCounts, totalAlerts }: Props) {
  const hasFilters =
    !!filters.status || !!filters.severity || !!filters.q || filters.activeOnly;

  return (
    <div className="space-y-3">
      <form method="get" action="/nws" className="flex flex-wrap items-end gap-3">
        {filters.status ? <input type="hidden" name="status" value={filters.status} /> : null}
        {filters.activeOnly ? <input type="hidden" name="active" value="1" /> : null}
        <label className="block text-sm min-w-[10rem] flex-1">
          <span className="text-wx-mute text-xs">Search event, headline, area</span>
          <input
            name="q"
            className="mt-1 w-full input"
            placeholder="e.g. Tornado Warning"
            defaultValue={filters.q ?? ''}
          />
        </label>
        <label className="block text-sm">
          <span className="text-wx-mute text-xs">Severity</span>
          <select name="severity" className="mt-1 input" defaultValue={filters.severity ?? ''}>
            <option value="">Any</option>
            {NWS_SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn">
          Apply
        </button>
        {hasFilters ? (
          <Link href="/nws" className="text-sm text-wx-accent self-center">
            Clear filters
          </Link>
        ) : null}
      </form>

      <div className="flex flex-wrap items-center gap-1 text-xs">
        <Link
          href={buildHref({
            status: null,
            severity: filters.severity,
            q: filters.q,
            activeOnly: false,
          })}
          className={`px-2 py-1 rounded border ${
            !filters.status && !filters.activeOnly
              ? 'border-wx-accent text-wx-accent'
              : 'border-wx-line text-wx-mute hover:text-wx-fg'
          }`}
        >
          all ({totalAlerts})
        </Link>
        <Link
          href={buildHref({
            status: 'new',
            severity: filters.severity,
            q: filters.q,
            activeOnly: true,
          })}
          className={`px-2 py-1 rounded border ${
            filters.activeOnly
              ? 'border-wx-accent text-wx-accent'
              : 'border-wx-line text-wx-mute hover:text-wx-fg'
          }`}
        >
          actionable ({statusCounts.get('new') ?? 0})
        </Link>
        {NWS_STATUSES.map((s) => (
          <Link
            key={s}
            href={buildHref({
              status: s,
              severity: filters.severity,
              q: filters.q,
              activeOnly: false,
            })}
            className={`px-2 py-1 rounded border ${
              filters.status === s && !filters.activeOnly
                ? 'border-wx-accent text-wx-accent'
                : 'border-wx-line text-wx-mute hover:text-wx-fg'
            }`}
          >
            {s} ({statusCounts.get(s) ?? 0})
          </Link>
        ))}
      </div>
    </div>
  );
}
