'use client';

import { useState } from 'react';
import { createRegion, updateRegion } from './actions';

type Initial = {
  id?: string;
  name?: string;
  kind?: 'county' | 'zone' | 'custom_polygon';
  county_fips?: string | null;
  ugc_code?: string | null;
};

export default function RegionForm({ initial }: { initial?: Initial }) {
  const action = initial?.id ? updateRegion : createRegion;
  const [kind, setKind] = useState<Initial['kind']>(initial?.kind ?? 'county');

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
          rows={8}
          className="input font-mono text-xs"
          placeholder='{"type":"Polygon","coordinates":[[[...]]]}'
        />
        <p className="text-xs text-wx-mute mt-1">
          Paste a GeoJSON <code>Feature</code>, <code>Polygon</code>, or <code>MultiPolygon</code>.
          For edits, leave blank to keep the existing geometry. Coordinates must be WGS84 (lng, lat).
        </p>
      </label>

      <div className="flex justify-end gap-2">
        <button type="submit" className="btn">
          {initial?.id ? 'Save changes' : 'Create region'}
        </button>
      </div>
    </form>
  );
}
