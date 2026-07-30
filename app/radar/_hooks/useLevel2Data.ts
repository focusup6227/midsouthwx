'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

// On-demand Level II (Py-ART) rendering pipeline, extracted from RadarView.
// Owns the fetch → retry/backoff → localStorage-pointer cache → gzip GeoJSON
// decompression flow for /api/radar/level2, plus the sweep/elevation
// resolution that depends on the returned overlay metadata.

export type SweepInfo = { index: number; elevation_deg: number };

export type Level2Overlay = {
  geojson_url?: string | null;
  image_url?: string | null;
  // Quantized value-grid sidecar for PNG renders (gzipped uint8; 0 = no data,
  // 1..255 spans vmin..vmax on the same bounds/mercator grid as the PNG).
  // Sampled client-side for the pointer readout.
  values_url?: string | null;
  values_w?: number | null;
  values_h?: number | null;
  bounds: { north: number; south: number; east: number; west: number };
  scan_time: string;
  cached: boolean;
  render_ms?: number;
  available_sweeps: SweepInfo[];
  sweep_index: number | null;
  feature_count: number | null;
  vmin: number;
  vmax: number;
};

export type Level2Product = 'refl' | 'vel' | 'srm' | 'sw' | 'cc' | 'zdr' | 'kdp';

export const LEVEL2_MAX_ATTEMPTS = 3;

export function useLevel2Data({
  enabled,
  site,
  product,
  selectedElevation,
  usePng,
  stormUV = null,
}: {
  enabled: boolean;
  site: string | null;
  product: Level2Product;
  selectedElevation: number | 'composite';
  usePng: boolean;
  /** Storm motion (m/s east/north) — forwarded for product 'srm'. */
  stormUV?: { u: number; v: number } | null;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Retry attempt number for the current Level II fetch (0 = first try). Lets
  // the inspector show "Warming renderer · 2/3" during the 4s/8s/12s backoff
  // schedule instead of going silent.
  const [attempt, setAttempt] = useState(0);
  const [overlay, setOverlay] = useState<Level2Overlay | null>(null);
  const [geojson, setGeojson] = useState<any>(null);

  // PNG-mode pointer readout: download the value-grid sidecar once per render
  // (content-addressed URL → browser HTTP cache) and sample it on hover.
  const [valueGrid, setValueGrid] = useState<{ data: Uint8Array; w: number; h: number } | null>(null);
  useEffect(() => {
    setValueGrid(null);
    if (!overlay?.values_url || !overlay.values_w || !overlay.values_h) return;
    const { values_url, values_w, values_h } = overlay;
    let cancelled = false;
    const abort = new AbortController();
    (async () => {
      try {
        const r = await fetch(values_url, { cache: 'force-cache', signal: abort.signal });
        if (cancelled || !r.ok || !r.body) return;
        const decompressed = r.body.pipeThrough(new DecompressionStream('gzip'));
        const buf = await new Response(decompressed).arrayBuffer();
        if (cancelled) return;
        const data = new Uint8Array(buf);
        if (data.length !== values_w * values_h) return;
        setValueGrid({ data, w: values_w, h: values_h });
      } catch {
        /* sidecar is best-effort — the hover readout just shows "—" */
      }
    })();
    return () => { cancelled = true; abort.abort(); };
  }, [overlay]);

  // Map a lng/lat to a raw product value via the sidecar. Row mapping is
  // uniform in mercator-y (matching how Mapbox warps the image and how the
  // renderer laid out the grid); columns are linear in longitude.
  const sampleValue = useCallback((lng: number, lat: number): number | null => {
    if (!valueGrid || !overlay) return null;
    const { north, south, east, west } = overlay.bounds;
    if (lat > north || lat < south || lng < west || lng > east) return null;
    const mercY = (deg: number) => Math.log(Math.tan(Math.PI / 4 + (deg * Math.PI) / 360));
    const yN = mercY(north);
    const yS = mercY(south);
    const col = Math.round(((lng - west) / (east - west)) * (valueGrid.w - 1));
    const row = Math.round(((yN - mercY(lat)) / (yN - yS)) * (valueGrid.h - 1));
    if (row < 0 || row >= valueGrid.h || col < 0 || col >= valueGrid.w) return null;
    const q = valueGrid.data[row * valueGrid.w + col];
    if (q === 0) return null;
    return overlay.vmin + ((q - 1) / 254) * (overlay.vmax - overlay.vmin);
  }, [valueGrid, overlay]);

  const availableSweeps = useMemo(
    () => overlay?.available_sweeps ?? [],
    [overlay],
  );
  const isComposite = selectedElevation === 'composite';
  const resolvedSweepIndex = useMemo(() => {
    if (isComposite) return 0;
    if (!availableSweeps.length) return 0;
    let best = 0, bestDiff = Infinity;
    for (const s of availableSweeps) {
      const d = Math.abs(s.elevation_deg - (selectedElevation as number));
      if (d < bestDiff) { bestDiff = d; best = s.index; }
    }
    return best;
  }, [availableSweeps, selectedElevation, isComposite]);

  useEffect(() => {
    if (!enabled || !site) {
      setOverlay(null);
      setGeojson(null);
      setError(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setGeojson(null);
    setError(null);
    setAttempt(0);

    const RETRY_DELAYS = [4000, 8000, 12000];
    const format = usePng ? 'png' : 'geojson';
    // Track every pending retry timeout so a fast site/product switch cancels
    // them instead of letting them fire and queue stale fetches at the
    // renderer.
    const pendingTimeouts = new Set<ReturnType<typeof setTimeout>>();
    const abort = new AbortController();

    // localStorage-cached pointer to the last successful render for this
    // (site, product, sweep, composite, format) combo. The cached entry has
    // the overlay metadata (bounds, vmin/vmax, sweeps, etc.) plus the
    // geojson_url / image_url — content-addressed by scan_time so the URL
    // always serves the exact bytes we rendered last time. Fetching it pulls
    // straight from the browser's HTTP cache (immutable, never expires) so
    // revisits paint in <1s while the fresh /api/radar/level2 call runs in
    // parallel and replaces the data once the latest scan finishes rendering.
    const srmQs = product === 'srm' && stormUV ? `&storm_u=${stormUV.u}&storm_v=${stormUV.v}` : '';
    const cacheKey = `radar:l2:${site}:${product}:${resolvedSweepIndex}:${isComposite ? 1 : 0}:${format}${srmQs}`;
    try {
      const raw = typeof window !== 'undefined' ? window.localStorage.getItem(cacheKey) : null;
      if (raw) {
        const cached = JSON.parse(raw) as { overlay?: Level2Overlay };
        const ov = cached.overlay;
        if (ov && (ov.image_url || ov.geojson_url)) {
          setOverlay(ov);
          if (format === 'geojson' && ov.geojson_url) {
            (async () => {
              try {
                const r = await fetch(ov.geojson_url!, { cache: 'force-cache', signal: abort.signal });
                if (cancelled || !r.ok || !r.body) return;
                const decompressed = r.body.pipeThrough(new DecompressionStream('gzip'));
                const text = await new Response(decompressed).text();
                const gj = JSON.parse(text);
                if (cancelled) return;
                // Only apply the cached GeoJSON if a fresh fetch hasn't beat
                // us to it — preserves the latest scan when both finish.
                setGeojson((prev: any) => prev ?? gj);
              } catch {
                /* cache miss / parse failure / aborted — fall through to live fetch */
              }
            })();
          }
        }
      }
    } catch {
      /* localStorage unavailable (private mode etc) — skip silently */
    }

    const schedule = (fn: () => void, ms: number) => {
      const t = setTimeout(() => {
        pendingTimeouts.delete(t);
        if (!cancelled) fn();
      }, ms);
      pendingTimeouts.add(t);
    };

    const load = async (attemptNo = 0): Promise<void> => {
      if (cancelled) return;
      setLoading(true);

      try {
        const url = `/api/radar/level2/${site}`
          + `?product=${product}`
          + `&format=${format}`
          + `&sweep_index=${resolvedSweepIndex}`
          + (isComposite ? '&composite=1' : '')
          + srmQs;
        const res = await fetch(url, { cache: 'no-store', signal: abort.signal });
        const data = await res.json();
        if (cancelled) return;

        if (data.error) {
          // Only retry transient causes. renderer_not_configured (env vars
          // missing) and renderer_unreachable (Fly down / DNS) won't fix
          // themselves on the 4-8-12s schedule, and retrying them piles up
          // open connections and starves /api/radar/warnings et al with
          // ERR_INSUFFICIENT_RESOURCES.
          const transient =
            data.error === 'renderer_waking' || data.error === 'renderer_timeout';
          if (transient && attemptNo < RETRY_DELAYS.length) {
            setError('renderer_waking');
            setAttempt(attemptNo + 1);
            schedule(() => load(attemptNo + 1), RETRY_DELAYS[attemptNo]);
            return;
          }
          setError(data.error);
          setOverlay(null);
          setGeojson(null);
          return;
        }

        setOverlay(data as Level2Overlay);
        setError(null);
        try {
          // Persist the pointer (metadata + URL) so next visit can re-render
          // instantly from the browser HTTP cache. Bytes themselves stay in
          // the HTTP cache — only the small JSON metadata lives in localStorage.
          window.localStorage.setItem(cacheKey, JSON.stringify({ overlay: data, savedAt: Date.now() }));
        } catch {
          /* over quota / private mode — best-effort */
        }

        if (format === 'png') {
          // PNG path: nothing else to download — the renderer URL is a public
          // PNG, Mapbox image source handles the rest.
          setGeojson(null);
          return;
        }

        if (!data.geojson_url) throw new Error('renderer returned no geojson_url');
        const gjRes = await fetch(data.geojson_url, { cache: 'default', signal: abort.signal });
        if (!gjRes.ok) throw new Error(`geojson fetch ${gjRes.status}`);
        if (!gjRes.body) throw new Error('geojson response has no body');
        const decompressed = gjRes.body.pipeThrough(new DecompressionStream('gzip'));
        const text = await new Response(decompressed).text();
        const gj = JSON.parse(text);
        if (cancelled) return;
        setGeojson(gj);
      } catch (err: any) {
        if (cancelled || err?.name === 'AbortError') return;
        if (attemptNo < RETRY_DELAYS.length) {
          setError('renderer_waking');
          schedule(() => load(attemptNo + 1), RETRY_DELAYS[attemptNo]);
          return;
        }
        setError('renderer_unreachable');
        setGeojson(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    // Debounce the initial fetch by 150 ms so rapid product/sweep/site clicks
    // collapse into a single request. The loading indicator is set on the
    // leading edge so the UI still feels responsive while the timer is armed.
    setLoading(true);
    const debounceT = setTimeout(() => { void load(); }, 150);
    const id = setInterval(() => load(0), 300_000);
    return () => {
      cancelled = true;
      clearTimeout(debounceT);
      clearInterval(id);
      pendingTimeouts.forEach(clearTimeout);
      pendingTimeouts.clear();
      abort.abort();
    };
  }, [enabled, site, product, resolvedSweepIndex, isComposite, usePng, stormUV]);

  return {
    overlay,
    geojson,
    loading,
    error,
    attempt,
    maxAttempts: LEVEL2_MAX_ATTEMPTS,
    availableSweeps,
    isComposite,
    resolvedSweepIndex,
    sampleValue,
  };
}
