'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { createRegion, updateRegion } from './actions';
import GeometryPreview from './GeometryPreview';

type Initial = {
  id?: string;
  name?: string;
  kind?: 'county' | 'zone' | 'custom_polygon';
  county_fips?: string | null;
  ugc_code?: string | null;
};

export default function RegionForm({
  initial,
  existingGeometry,
}: {
  initial?: Initial;
  existingGeometry?: GeoJSON.Geometry | null;
}) {
  const action = initial?.id ? updateRegion : createRegion;
  const [kind, setKind] = useState<Initial['kind']>(initial?.kind ?? 'county');
  const [geojson, setGeojson] = useState('');

  const parsed = useMemo(() => parseGeojson(geojson), [geojson]);
  const previewGeometry = parsed.geometry ?? existingGeometry ?? null;

  return (
    <form action={action} className="card p-5 space-y-4">
      {initial?.id ? <input type="hidden" name="id" value={initial.id} /> : null}

      <label className="block">
        <span className="block text-xs uppercase tracking-wide text-wx-mute mb-1">Name</span>
        <input
          name="name"
          required
          className="input"
          defaultValue={initial?.name ?? ''}
          placeholder="Shelby County TN"
        />
      </label>

      <label className="block">
        <span className="block text-xs uppercase tracking-wide text-wx-mute mb-1">Kind</span>
        <select
          name="kind"
          className="input"
          value={kind}
          onChange={(e) => setKind(e.target.value as Initial['kind'])}
        >
          <option value="county">County</option>
          <option value="zone">NWS forecast zone</option>
          <option value="custom_polygon">Custom polygon</option>
        </select>
      </label>

      <div className="grid sm:grid-cols-2 gap-4">
        <label className="block">
          <span className="block text-xs uppercase tracking-wide text-wx-mute mb-1">
            County FIPS {kind === 'county' ? <span className="text-wx-danger">*</span> : null}
          </span>
          <input
            name="county_fips"
            className="input font-mono"
            placeholder="47157"
            defaultValue={initial?.county_fips ?? ''}
          />
        </label>
        <label className="block">
          <span className="block text-xs uppercase tracking-wide text-wx-mute mb-1">
            UGC code {kind === 'zone' ? <span className="text-wx-danger">*</span> : null}
          </span>
          <input
            name="ugc_code"
            className="input font-mono"
            placeholder="TNZ088"
            defaultValue={initial?.ugc_code ?? ''}
          />
        </label>
      </div>

      <label className="block">
        <span className="block text-xs uppercase tracking-wide text-wx-mute mb-1">
          Geometry (GeoJSON)
          {kind === 'custom_polygon' ? <span className="text-wx-danger"> *</span> : ' (optional)'}
        </span>
        <textarea
          name="geojson"
          rows={6}
          className="input font-mono text-xs"
          placeholder='{"type":"Polygon","coordinates":[[[...]]]}'
          value={geojson}
          onChange={(e) => setGeojson(e.target.value)}
        />
        <p className="text-xs text-wx-mute mt-1">
          Paste a GeoJSON <code>Feature</code>, <code>Polygon</code>, or <code>MultiPolygon</code>.
          For edits, leave blank to keep the existing geometry. Coordinates must be WGS84 (lng, lat).
        </p>
        {geojson.trim() && parsed.error ? (
          <p className="mt-1 text-xs text-wx-danger">{parsed.error}</p>
        ) : null}
      </label>

      <GeometryPreview
        geometry={previewGeometry}
        label={
          parsed.geometry
            ? 'Preview (pasted)'
            : existingGeometry
              ? 'Preview (current)'
              : 'Preview'
        }
      />

      <div className="flex justify-end gap-2">
        <Link href="/regions" className="btn-ghost">Cancel</Link>
        <button type="submit" className="btn">
          {initial?.id ? 'Save changes' : 'Create region'}
        </button>
      </div>
    </form>
  );
}

function parseGeojson(raw: string): { geometry: GeoJSON.Geometry | null; error: string | null } {
  const trimmed = raw.trim();
  if (!trimmed) return { geometry: null, error: null };
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return { geometry: null, error: 'Not valid JSON.' };
  }
  const extract = (v: unknown): GeoJSON.Geometry | null => {
    if (!v || typeof v !== 'object') return null;
    const obj = v as { type?: string; geometry?: unknown; features?: unknown };
    if (obj.type === 'Feature' && obj.geometry) return extract(obj.geometry);
    if (
      obj.type === 'FeatureCollection' &&
      Array.isArray(obj.features) &&
      obj.features.length === 1
    ) {
      return extract((obj.features[0] as { geometry?: unknown }).geometry);
    }
    if (
      obj.type === 'Polygon' ||
      obj.type === 'MultiPolygon' ||
      obj.type === 'Point' ||
      obj.type === 'LineString' ||
      obj.type === 'MultiLineString' ||
      obj.type === 'MultiPoint' ||
      obj.type === 'GeometryCollection'
    ) {
      return v as GeoJSON.Geometry;
    }
    return null;
  };
  const geometry = extract(value);
  if (!geometry) {
    return { geometry: null, error: 'Could not find a geometry in the pasted JSON.' };
  }
  return { geometry, error: null };
}
