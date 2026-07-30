'use client';

import { useEffect, useRef, useState } from 'react';
import type { Level2Overlay } from './useLevel2Data';

// Hi-res site loop: list recent Level II volumes, then prefetch a PNG render
// for each (oldest → newest, sequentially — the renderer caps concurrent
// renders and every frame after the first visit is a storage-cache hit).
// Frames always use the PNG path: a 6-frame GeoJSON loop would be 50+ MB.

export type LoopFrame = {
  scanTime: string;
  imageUrl: string;
  bounds: Level2Overlay['bounds'];
};

const MAX_LOOP_FRAMES = 6;

export function useLevel2Loop({
  enabled,
  site,
  product,
  sweepIndex,
  composite,
  stormUV,
}: {
  enabled: boolean;
  site: string | null;
  product: string;
  sweepIndex: number;
  composite: boolean;
  stormUV: { u: number; v: number } | null;
}) {
  const [frames, setFrames] = useState<LoopFrame[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bump to force a re-list (used by the periodic refresh).
  const [refreshTick, setRefreshTick] = useState(0);
  const framesRef = useRef<Map<string, LoopFrame>>(new Map());

  useEffect(() => {
    if (!enabled || !site) {
      setFrames([]);
      setProgress(null);
      setError(null);
      framesRef.current.clear();
      return;
    }
    let cancelled = false;
    const abort = new AbortController();

    (async () => {
      try {
        const vr = await fetch(`/api/radar/level2/${site}/volumes?window=45`, {
          cache: 'no-store',
          signal: abort.signal,
        });
        const vBody = (await vr.json()) as {
          error?: string;
          volumes?: { key: string; scan_time: string }[];
        };
        if (cancelled) return;
        if (vBody.error || !vBody.volumes?.length) {
          setError(vBody.error ?? 'no_volumes');
          return;
        }
        setError(null);
        const vols = vBody.volumes.slice(-MAX_LOOP_FRAMES);
        setProgress({ done: 0, total: vols.length });

        // Newest first so the freshest frame is usable immediately, then
        // backfill history. Sequential to stay inside the renderer's
        // concurrency cap without starving live single-frame renders.
        const ordered = [...vols].reverse();
        let done = 0;
        for (const v of ordered) {
          if (cancelled) return;
          const have = framesRef.current.get(v.scan_time);
          if (have) {
            done++;
            setProgress({ done, total: vols.length });
            continue;
          }
          try {
            const qs =
              `product=${product}&format=png&sweep_index=${sweepIndex}` +
              (composite ? '&composite=1' : '') +
              `&volume_key=${encodeURIComponent(v.key)}` +
              (product === 'srm' && stormUV ? `&storm_u=${stormUV.u}&storm_v=${stormUV.v}` : '');
            const r = await fetch(`/api/radar/level2/${site}?${qs}`, {
              cache: 'no-store',
              signal: abort.signal,
            });
            const data = (await r.json()) as Level2Overlay & { error?: string };
            if (cancelled) return;
            if (!data.error && data.image_url) {
              framesRef.current.set(v.scan_time, {
                scanTime: data.scan_time ?? v.scan_time,
                imageUrl: data.image_url,
                bounds: data.bounds,
              });
              // Decode ahead of playback so keyed source remounts don't flash.
              const img = new Image();
              img.src = data.image_url;
            }
          } catch {
            /* skip failed frame — a 5-frame loop still loops */
          }
          done++;
          if (!cancelled) {
            setProgress({ done, total: vols.length });
            setFrames(
              [...framesRef.current.values()].sort((a, b) =>
                a.scanTime.localeCompare(b.scanTime),
              ),
            );
          }
        }
      } catch (e: any) {
        if (!cancelled && e?.name !== 'AbortError') setError('renderer_unreachable');
      }
    })();

    return () => {
      cancelled = true;
      abort.abort();
    };
  }, [enabled, site, product, sweepIndex, composite, stormUV, refreshTick]);

  // Reset the accumulated frames when the render parameters change — a KDP
  // frame must not appear inside a reflectivity loop.
  useEffect(() => {
    framesRef.current.clear();
    setFrames([]);
  }, [site, product, sweepIndex, composite, stormUV]);

  // Poll for new volumes while the loop is open.
  useEffect(() => {
    if (!enabled || !site) return;
    const id = setInterval(() => setRefreshTick((t) => t + 1), 120_000);
    return () => clearInterval(id);
  }, [enabled, site]);

  return { frames, progress, error };
}
