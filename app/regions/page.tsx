import Link from 'next/link';
import { supabaseServer } from '@/lib/supabase/server';
import DashShell from '@/components/DashShell';
import { deleteRegion } from './actions';

export const dynamic = 'force-dynamic';

const KIND_LABEL: Record<string, string> = {
  county: 'County',
  zone: 'NWS zone',
  custom_polygon: 'Custom polygon',
};

export default async function RegionsPage() {
  const supa = supabaseServer();

  const [{ data: regions }, { data: memberships }] = await Promise.all([
    supa
      .from('regions')
      .select('id, name, kind, county_fips, ugc_code, created_at')
      .order('kind')
      .order('name'),
    supa.from('subscriber_regions').select('region_id'),
  ]);

  const counts: Record<string, number> = {};
  for (const m of memberships ?? []) counts[m.region_id] = (counts[m.region_id] ?? 0) + 1;

  return (
    <DashShell
      title="Regions"
      actions={<Link href="/regions/new" className="btn">New region</Link>}
    >
      <p className="text-sm text-wx-mute">
        Counties and forecast zones used by the NWS dispatcher to route alerts. Subscriber
        memberships refresh automatically when geometry or <code className="text-xs">county_fips</code> changes
        (trigger <code className="text-xs">regions_after_change</code>).
        Bulk-import counties or zones with <code className="text-xs">scripts/import-regions.mjs</code>.
      </p>

      {!regions?.length ? (
        <section className="card p-5 space-y-3">
          <p className="text-sm">No regions yet. To bootstrap Mid-South coverage:</p>
          <pre className="text-xs bg-wx-ink p-3 rounded overflow-x-auto">
{`node scripts/import-regions.mjs --counties 47,28,05
node scripts/import-regions.mjs --zones TN,MS,AR`}
          </pre>
          <p className="text-xs text-wx-mute">
            See <code>scripts/regions-backfill.md</code> for details.
          </p>
        </section>
      ) : (
        <section className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-wx-mute border-b border-wx-line">
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Kind</th>
                <th className="px-4 py-2">FIPS / UGC</th>
                <th className="px-4 py-2">Subscribers</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-wx-line">
              {regions.map((r) => (
                <tr key={r.id}>
                  <td className="px-4 py-2">
                    <Link href={`/regions/${r.id}`} className="text-wx-accent">
                      {r.name}
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-wx-mute">
                    {KIND_LABEL[r.kind] ?? r.kind}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-wx-mute">
                    {r.county_fips ?? r.ugc_code ?? '—'}
                  </td>
                  <td className="px-4 py-2">{counts[r.id] ?? 0}</td>
                  <td className="px-4 py-2 text-right">
                    <form action={deleteRegion} className="inline">
                      <input type="hidden" name="id" value={r.id} />
                      <button
                        type="submit"
                        className="text-xs text-wx-danger underline"
                      >
                        Delete
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </DashShell>
  );
}
