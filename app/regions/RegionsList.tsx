'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import KindBadge from './KindBadge';
import DeleteRegionButton from './DeleteRegionButton';
import { regionState } from '@/lib/regions/states';

export type RegionRow = {
  id: string;
  name: string;
  kind: 'county' | 'zone' | 'custom_polygon' | string;
  county_fips: string | null;
  ugc_code: string | null;
  has_geometry: boolean;
};

type Props = {
  regions: RegionRow[];
  counts: Record<string, number>;
};

type KindFilter = 'all' | 'county' | 'zone' | 'custom_polygon';

const NO_STATE = '—';

export default function RegionsList({ regions, counts }: Props) {
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState<KindFilter>('all');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return regions.filter((r) => {
      if (kind !== 'all' && r.kind !== kind) return false;
      if (!q) return true;
      return (
        r.name.toLowerCase().includes(q) ||
        (r.county_fips ?? '').toLowerCase().includes(q) ||
        (r.ugc_code ?? '').toLowerCase().includes(q)
      );
    });
  }, [regions, search, kind]);

  const grouped = useMemo(() => {
    const map = new Map<string, RegionRow[]>();
    for (const r of filtered) {
      const key = regionState(r) ?? NO_STATE;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(r);
    }
    return Array.from(map.entries())
      .map(([state, rows]) => ({
        state,
        rows: rows.sort((a, b) => a.name.localeCompare(b.name)),
      }))
      .sort((a, b) => {
        if (a.state === NO_STATE) return 1;
        if (b.state === NO_STATE) return -1;
        return a.state.localeCompare(b.state);
      });
  }, [filtered]);

  const totals = useMemo(() => {
    const t = { all: 0, county: 0, zone: 0, custom_polygon: 0 } as Record<string, number>;
    for (const r of regions) {
      t.all++;
      t[r.kind] = (t[r.kind] ?? 0) + 1;
    }
    return t;
  }, [regions]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name, FIPS, or UGC…"
          className="input sm:max-w-sm"
        />
        <div className="flex flex-wrap gap-1.5 text-sm">
          <FilterChip active={kind === 'all'} onClick={() => setKind('all')}>
            All <span className="text-wx-mute">({totals.all})</span>
          </FilterChip>
          <FilterChip active={kind === 'county'} onClick={() => setKind('county')}>
            Counties <span className="text-wx-mute">({totals.county ?? 0})</span>
          </FilterChip>
          <FilterChip active={kind === 'zone'} onClick={() => setKind('zone')}>
            Zones <span className="text-wx-mute">({totals.zone ?? 0})</span>
          </FilterChip>
          <FilterChip active={kind === 'custom_polygon'} onClick={() => setKind('custom_polygon')}>
            Custom <span className="text-wx-mute">({totals.custom_polygon ?? 0})</span>
          </FilterChip>
        </div>
      </div>

      {filtered.length === 0 ? (
        <p className="text-sm text-wx-mute">No regions match.</p>
      ) : (
        <div className="space-y-3">
          {grouped.map(({ state, rows }) => {
            const isCollapsed = collapsed[state];
            return (
              <section key={state} className="card overflow-hidden">
                <button
                  type="button"
                  onClick={() => setCollapsed((c) => ({ ...c, [state]: !c[state] }))}
                  className="flex w-full items-center justify-between gap-3 border-b border-wx-line px-4 py-2 text-left hover:bg-wx-ink/40"
                >
                  <span className="font-semibold">
                    {state === NO_STATE ? 'Unassigned / custom' : state}
                  </span>
                  <span className="text-xs text-wx-mute">
                    {rows.length} region{rows.length === 1 ? '' : 's'} ·{' '}
                    {isCollapsed ? '▸' : '▾'}
                  </span>
                </button>
                {!isCollapsed && (
                  <ul className="divide-y divide-wx-line">
                    {rows.map((r) => (
                      <li
                        key={r.id}
                        className="flex flex-wrap items-center gap-3 px-4 py-2 text-sm"
                      >
                        <Link href={`/regions/${r.id}`} className="min-w-0 flex-1 text-wx-accent">
                          <span className="block truncate">{r.name}</span>
                        </Link>
                        <KindBadge kind={r.kind} />
                        <span className="font-mono text-xs text-wx-mute">
                          {r.county_fips ?? r.ugc_code ?? '—'}
                        </span>
                        {!r.has_geometry && (
                          <span
                            className="text-[10px] uppercase tracking-wide text-wx-danger"
                            title="No geometry — polygon alerts and the map won't find this region"
                          >
                            no geom
                          </span>
                        )}
                        <Link
                          href={`/subscribers?region=${r.id}`}
                          className="text-xs text-wx-mute hover:text-wx-fg"
                          title="View subscribers in this region"
                        >
                          {counts[r.id] ?? 0} sub{(counts[r.id] ?? 0) === 1 ? '' : 's'}
                        </Link>
                        <DeleteRegionButton
                          id={r.id}
                          name={r.name}
                          subscriberCount={counts[r.id] ?? 0}
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

function FilterChip({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`btn-ghost text-sm ${active ? 'border-wx-accent text-wx-accent' : ''}`}
    >
      {children}
    </button>
  );
}
