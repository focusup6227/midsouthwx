'use client';

import { useState, useTransition } from 'react';
import { refreshSubscriberLocation, type RefreshLocationResult } from './actions';

type Props = {
  id: string;
  hasLocation: boolean;
  hasAddress: boolean;
  hasZip: boolean;
};

export default function LocationCard({ id, hasLocation, hasAddress, hasZip }: Props) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<RefreshLocationResult | null>(null);

  const canGeocode = hasAddress || hasZip;

  const run = () =>
    startTransition(async () => {
      setResult(null);
      const r = await refreshSubscriberLocation(id);
      setResult(r);
    });

  return (
    <section className="card p-5 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-semibold">Location</h2>
        {hasLocation ? (
          <span className="text-xs px-2 py-0.5 rounded-full border border-wx-ok/40 text-wx-ok">
            geocoded
          </span>
        ) : (
          <span className="text-xs px-2 py-0.5 rounded-full border border-wx-danger/40 text-wx-danger">
            missing
          </span>
        )}
      </div>

      {!hasLocation ? (
        <p className="text-sm text-wx-mute">
          No coordinates on file — radar polygon and circle alerts won&apos;t reach this subscriber
          until you geocode them.
        </p>
      ) : (
        <p className="text-sm text-wx-mute">
          Coordinates set. Re-run if the home address changed.
        </p>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          className="btn-ghost text-sm"
          onClick={run}
          disabled={pending || !canGeocode}
          title={canGeocode ? 'Re-geocode from address/ZIP' : 'No address or ZIP on file'}
        >
          {pending ? 'Geocoding…' : hasLocation ? 'Refresh location' : 'Geocode now'}
        </button>
      </div>

      {result?.ok ? (
        <div className="text-sm space-y-1 border-t border-wx-line pt-3">
          <p className="text-wx-ok">
            ✓ Updated via {result.source === 'address' ? 'street address' : 'ZIP centroid'}.
          </p>
          {result.matchedAddress ? (
            <p className="text-xs text-wx-mute">Matched: {result.matchedAddress}</p>
          ) : null}
          <p className="text-xs font-mono text-wx-mute">
            {result.lat.toFixed(5)}, {result.lng.toFixed(5)}
            {result.countyFips ? ` · FIPS ${result.countyFips}` : ''}
          </p>
        </div>
      ) : null}
      {result && !result.ok ? (
        <p className="text-sm text-wx-danger border-t border-wx-line pt-3">{result.error}</p>
      ) : null}
    </section>
  );
}
