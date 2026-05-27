import Link from 'next/link';
import { notFound } from 'next/navigation';
import { supabaseServer } from '@/lib/supabase/server';
import DashShell from '@/components/DashShell';
import RegionForm from '../RegionForm';
import KindBadge from '../KindBadge';
import DeleteRegionButton from '../DeleteRegionButton';

export const dynamic = 'force-dynamic';

type AutoAlertRule = {
  id: string;
  event_pattern: string;
  mode: string;
  enabled: boolean;
  region_filter: { region_ids?: string[] } | null;
};

export default async function EditRegionPage({ params }: { params: { id: string } }) {
  const supa = supabaseServer();
  const { data: region } = await supa
    .from('regions')
    .select('id, name, kind, county_fips, ugc_code, created_at')
    .eq('id', params.id)
    .maybeSingle();
  if (!region) notFound();

  const [{ count: subscriberCount }, { data: feature }, { data: allRules }] = await Promise.all([
    supa
      .from('subscriber_regions')
      .select('*', { count: 'exact', head: true })
      .eq('region_id', region.id),
    supa.rpc('region_one_geojson', { p_id: region.id }),
    supa
      .from('auto_alert_rules')
      .select('id, event_pattern, mode, enabled, region_filter')
      .not('region_filter', 'is', null)
      .returns<AutoAlertRule[]>(),
  ]);

  const existingGeometry =
    feature && typeof feature === 'object' && 'geometry' in feature
      ? ((feature as { geometry: GeoJSON.Geometry }).geometry)
      : null;

  const rules = (allRules ?? []).filter((r) =>
    (r.region_filter?.region_ids ?? []).includes(region.id),
  );

  const count = subscriberCount ?? 0;

  return (
    <DashShell title={region.name} backHref="/regions" width="narrow">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <KindBadge kind={region.kind} />
        <span className="font-mono text-xs text-wx-mute">
          {region.county_fips ?? region.ugc_code ?? '—'}
        </span>
        <Link
          href={`/subscribers?region=${region.id}`}
          className="text-wx-mute hover:text-wx-fg"
        >
          {count} subscriber{count === 1 ? '' : 's'} →
        </Link>
        <div className="ml-auto">
          <DeleteRegionButton
            id={region.id}
            name={region.name}
            subscriberCount={count}
            variant="button"
          />
        </div>
      </div>

      <RegionForm
        initial={{
          id: region.id,
          name: region.name,
          kind: region.kind as 'county' | 'zone' | 'custom_polygon',
          county_fips: region.county_fips,
          ugc_code: region.ugc_code,
        }}
        existingGeometry={existingGeometry}
      />

      <section className="card p-5 space-y-2">
        <div className="text-xs uppercase tracking-wide text-wx-mute">
          Auto-alert rules referencing this region
        </div>
        {rules.length === 0 ? (
          <p className="text-sm text-wx-mute">No rules.</p>
        ) : (
          <ul className="divide-y divide-wx-line text-sm">
            {rules.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <div className="truncate font-mono text-xs">{r.event_pattern}</div>
                  <div className="text-xs text-wx-mute">
                    mode: {r.mode}
                    {!r.enabled ? ' · disabled' : ''}
                  </div>
                </div>
                <Link href="/nws#rules" className="text-xs text-wx-accent">
                  Edit on /nws →
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </DashShell>
  );
}
