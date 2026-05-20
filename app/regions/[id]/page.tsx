import { notFound } from 'next/navigation';
import { supabaseServer } from '@/lib/supabase/server';
import DashShell from '@/components/DashShell';
import RegionForm from '../RegionForm';

export const dynamic = 'force-dynamic';

export default async function EditRegionPage({ params }: { params: { id: string } }) {
  const supa = supabaseServer();
  const { data: region } = await supa
    .from('regions')
    .select('id, name, kind, county_fips, ugc_code, created_at')
    .eq('id', params.id)
    .maybeSingle();
  if (!region) notFound();

  const { count: subscriberCount } = await supa
    .from('subscriber_regions')
    .select('*', { count: 'exact', head: true })
    .eq('region_id', region.id);

  return (
    <DashShell title={`Edit · ${region.name}`} backHref="/regions" width="narrow">
      <p className="text-xs text-wx-mute">
        {subscriberCount ?? 0} subscriber{(subscriberCount ?? 0) === 1 ? '' : 's'} match this region.
      </p>
      <RegionForm
        initial={{
          id: region.id,
          name: region.name,
          kind: region.kind as 'county' | 'zone' | 'custom_polygon',
          county_fips: region.county_fips,
          ugc_code: region.ugc_code,
        }}
      />
    </DashShell>
  );
}
