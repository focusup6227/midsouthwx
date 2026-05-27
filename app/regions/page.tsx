import Link from 'next/link';
import { supabaseServer } from '@/lib/supabase/server';
import DashShell from '@/components/DashShell';
import RegionsList, { type RegionRow } from './RegionsList';

export const dynamic = 'force-dynamic';

export default async function RegionsPage() {
  const supa = supabaseServer();

  const [{ data: regions }, { data: memberships }, { data: withGeom }] = await Promise.all([
    supa
      .from('regions')
      .select('id, name, kind, county_fips, ugc_code, created_at')
      .order('name'),
    supa.from('subscriber_regions').select('region_id'),
    supa.from('regions').select('id').not('geometry', 'is', null),
  ]);

  const counts: Record<string, number> = {};
  for (const m of memberships ?? []) counts[m.region_id] = (counts[m.region_id] ?? 0) + 1;

  const geomSet = new Set((withGeom ?? []).map((r) => r.id));

  const rows: RegionRow[] = (regions ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    county_fips: r.county_fips,
    ugc_code: r.ugc_code,
    has_geometry: geomSet.has(r.id),
  }));

  return (
    <DashShell
      title="Regions"
      actions={
        <>
          <Link href="/regions/import" className="btn-ghost text-sm">Bulk import</Link>
          <Link href="/regions/new" className="btn">New region</Link>
        </>
      }
      width="wide"
    >
      <p className="text-sm text-wx-mute">
        Counties and forecast zones used by the NWS dispatcher to route alerts. Subscriber
        memberships refresh automatically when geometry or <code className="text-xs">county_fips</code> changes
        (trigger <code className="text-xs">regions_after_change</code>).
      </p>

      {rows.length === 0 ? (
        <section className="card p-5 space-y-3">
          <p className="text-sm">No regions yet.</p>
          <p className="text-sm">
            <Link href="/regions/import" className="text-wx-accent">
              Bulk-import counties or NWS zones →
            </Link>
          </p>
          <p className="text-xs text-wx-mute">
            Or run <code>node scripts/import-regions.mjs --counties 47,28,05</code> from a shell.
          </p>
        </section>
      ) : (
        <RegionsList regions={rows} counts={counts} />
      )}
    </DashShell>
  );
}
