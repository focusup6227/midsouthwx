import { supabaseServer } from '@/lib/supabase/server';
import ComposeForm from './ComposeForm';
import DashShell from '@/components/DashShell';

export const dynamic = 'force-dynamic';

// Accepts any of:
//   { type: 'circle', center: [lng, lat], radius_km: 5 }
//   { type: 'polygon'|'Polygon', coordinates: ring }            // single ring shorthand
//   { type: 'Polygon', coordinates: [ring, ...] }               // canonical GeoJSON
//   { type: 'MultiPolygon', coordinates: [[ring,...], ...] }
// and returns the canonical GeoJSON shape resolve_audience expects.
function normalizeGeometry(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const g = raw as { type?: unknown; coordinates?: unknown };
  const t = String(g.type ?? '').toLowerCase();
  if (t === 'circle') return raw;
  if (t === 'polygon') {
    const coords = g.coordinates;
    const isNestedRings =
      Array.isArray(coords) &&
      Array.isArray(coords[0]) &&
      Array.isArray((coords as unknown[][])[0]?.[0]);
    return {
      type: 'Polygon',
      coordinates: isNestedRings ? coords : [coords],
    };
  }
  if (t === 'multipolygon') return { ...raw, type: 'MultiPolygon' };
  return raw;
}

export default async function ComposePage({
  searchParams,
}: {
  searchParams: { geo?: string };
}) {
  const supa = supabaseServer();

  const [templatesRes, groupsRes, regionsRes, subsRes] = await Promise.all([
    supa.from('templates').select('id, name, category, body_md, default_quick_replies').order('name'),
    supa.from('custom_groups').select('id, name').order('name'),
    supa.from('regions').select('id, name, kind').order('name'),
    supa
      .from('subscribers')
      .select('id, display_name, telegram_chat_id')
      .eq('status', 'active')
      .order('display_name'),
  ]);

  let initialGeometry: unknown = null;
  if (searchParams.geo) {
    try {
      initialGeometry = normalizeGeometry(JSON.parse(searchParams.geo));
    } catch {
      // Malformed geo param — ignore; operator can re-select from /radar.
    }
  }

  return (
    <DashShell title="New alert" width="narrow">
      <ComposeForm
        templates={templatesRes.data ?? []}
        groups={groupsRes.data ?? []}
        regions={regionsRes.data ?? []}
        subscribers={subsRes.data ?? []}
        initialGeometry={initialGeometry}
      />
    </DashShell>
  );
}
