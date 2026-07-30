'use client';

import { useCallback, useEffect, useState } from 'react';

// Multi-product cursor probe: fetch the PNG value-grid sidecars for
// refl + vel + cc at the current site/sweep and sample all three on hover —
// interrogation-level info ("52 dBZ · −48 kt in · CC 0.72") with no clicks.
// Renders are storage-cached, so after the first activation this costs three
// small gzipped grid downloads per scan.

type Grid = {
  data: Uint8Array;
  w: number;
  h: number;
  bounds: { north: number; south: number; east: number; west: number };
  vmin: number;
  vmax: number;
};

export type ProbeProduct = 'refl' | 'vel' | 'cc';
export type ProbeSample = Partial<Record<ProbeProduct, number>>;

const PROBE_PRODUCTS: ProbeProduct[] = ['refl', 'vel', 'cc'];

export function useMultiProbe({
  enabled,
  site,
  sweepIndex,
  composite,
}: {
  enabled: boolean;
  site: string | null;
  sweepIndex: number;
  composite: boolean;
}) {
  const [grids, setGrids] = useState<Partial<Record<ProbeProduct, Grid>>>({});
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!enabled || !site) {
      setGrids({});
      return;
    }
    let cancelled = false;
    const abort = new AbortController();
    (async () => {
      for (const p of PROBE_PRODUCTS) {
        try {
          const qs = `product=${p}&format=png&sweep_index=${sweepIndex}${composite ? '&composite=1' : ''}`;
          const r = await fetch(`/api/radar/level2/${site}?${qs}`, {
            cache: 'no-store',
            signal: abort.signal,
          });
          const data = await r.json();
          if (cancelled) return;
          if (data.error || !data.values_url || !data.values_w || !data.values_h) continue;
          const vr = await fetch(data.values_url, { cache: 'force-cache', signal: abort.signal });
          if (!vr.ok || !vr.body) continue;
          const buf = await new Response(
            vr.body.pipeThrough(new DecompressionStream('gzip')),
          ).arrayBuffer();
          if (cancelled) return;
          const arr = new Uint8Array(buf);
          if (arr.length !== data.values_w * data.values_h) continue;
          setGrids((prev) => ({
            ...prev,
            [p]: {
              data: arr,
              w: data.values_w,
              h: data.values_h,
              bounds: data.bounds,
              vmin: data.vmin ?? 0,
              vmax: data.vmax ?? 1,
            },
          }));
        } catch {
          /* per-product best-effort */
        }
      }
    })();
    return () => {
      cancelled = true;
      abort.abort();
    };
  }, [enabled, site, sweepIndex, composite, tick]);

  // Track new scans while the probe is on.
  useEffect(() => {
    if (!enabled || !site) return;
    const id = setInterval(() => setTick((t) => t + 1), 300_000);
    return () => clearInterval(id);
  }, [enabled, site]);

  const sampleAll = useCallback(
    (lng: number, lat: number): ProbeSample => {
      const out: ProbeSample = {};
      const mercY = (deg: number) => Math.log(Math.tan(Math.PI / 4 + (deg * Math.PI) / 360));
      for (const p of PROBE_PRODUCTS) {
        const g = grids[p];
        if (!g) continue;
        const { north, south, east, west } = g.bounds;
        if (lat > north || lat < south || lng < west || lng > east) continue;
        const yN = mercY(north);
        const yS = mercY(south);
        const col = Math.round(((lng - west) / (east - west)) * (g.w - 1));
        const row = Math.round(((yN - mercY(lat)) / (yN - yS)) * (g.h - 1));
        if (row < 0 || row >= g.h || col < 0 || col >= g.w) continue;
        const q = g.data[row * g.w + col];
        if (q === 0) continue;
        out[p] = g.vmin + ((q - 1) / 254) * (g.vmax - g.vmin);
      }
      return out;
    },
    [grids],
  );

  const ready = PROBE_PRODUCTS.filter((p) => grids[p]).length;
  return { sampleAll, ready };
}
