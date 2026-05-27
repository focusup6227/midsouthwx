'use client';

// Radar annotation overlay — geo-anchored "telestrator" tools for live
// cut-in or broadcast use. Tools: free pen, arrow, highlighted polygon /
// circle, text label. Annotations are stored as GeoJSON-equivalent shapes
// in (lng, lat) space so they stay locked to geography when the operator
// pans or zooms (TV-meteorologist style, not a screen-canvas whiteboard).
//
// Architecture:
//   useRadarAnnotations(mapRef, disabled)
//     → returns state + handlers + a single GeoJSON FeatureCollection ready
//       to feed into <Source>/<Layer>. Attaches mapbox event listeners
//       directly via map.on/off so the existing RadarView <Map> onClick /
//       onMouseMove handlers stay untouched. `disabled` lets the caller
//       force annotate-off when another mode (audience polygon, snap, pick
//       site) is active.
//   <AnnotationLayer geojson={...} /> — child of <Map>. Renders 5 layers.
//   <AnnotationToolbar {...state} /> — floating UI, positioned absolutely.
//
// Snapshot: capture the live Map canvas via `getCanvas().toDataURL()`.
// Requires `preserveDrawingBuffer: true` on the Map — set in RadarView so
// the canvas keeps its last frame's pixels available after WebGL flush.

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction, type RefObject } from 'react';
import { Source, Layer, type MapRef } from 'react-map-gl';
import type mapboxgl from 'mapbox-gl';
import {
  Pencil,
  ArrowUpRight,
  Hexagon,
  Circle as CircleIcon,
  Type as TypeIcon,
  Undo2,
  Trash2,
  Camera,
  Video,
  Square as StopIcon,
  X,
  ChevronUp,
  ChevronDown,
} from 'lucide-react';

// ────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────

export type AnnotateMode = 'none' | 'pen' | 'arrow' | 'polygon' | 'circle' | 'text';
export type AnnotateColor = string; // any CSS color; toolbar restricts choices

type LngLat = [number, number];

export type Annotation =
  | { id: string; kind: 'pen'; coords: LngLat[]; color: AnnotateColor; width: number }
  | { id: string; kind: 'arrow'; from: LngLat; to: LngLat; color: AnnotateColor; width: number }
  | { id: string; kind: 'polygon'; coords: LngLat[]; color: AnnotateColor }
  | { id: string; kind: 'circle'; center: LngLat; radiusKm: number; color: AnnotateColor }
  | { id: string; kind: 'text'; at: LngLat; text: string; color: AnnotateColor };

// ────────────────────────────────────────────────────────────────────────
// Geo math (small, no external deps)
// ────────────────────────────────────────────────────────────────────────

function haversineKm(a: LngLat, b: LngLat): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Project a point N km away from `from` on bearing `brgDeg` (0=N, 90=E). */
function destinationPoint(from: LngLat, brgDeg: number, distKm: number): LngLat {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const toDeg = (r: number) => (r * 180) / Math.PI;
  const φ1 = toRad(from[1]);
  const λ1 = toRad(from[0]);
  const θ = toRad(brgDeg);
  const δ = distKm / R;
  const φ2 = Math.asin(
    Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ),
  );
  const λ2 =
    λ1 +
    Math.atan2(
      Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
      Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2),
    );
  return [toDeg(λ2), toDeg(φ2)];
}

function bearingDeg(from: LngLat, to: LngLat): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const toDeg = (r: number) => (r * 180) / Math.PI;
  const φ1 = toRad(from[1]);
  const φ2 = toRad(to[1]);
  const Δλ = toRad(to[0] - from[0]);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function circlePolygon(center: LngLat, radiusKm: number, steps = 48): LngLat[] {
  if (radiusKm <= 0) return [center, center];
  const pts: LngLat[] = [];
  for (let i = 0; i <= steps; i++) {
    pts.push(destinationPoint(center, (i * 360) / steps, radiusKm));
  }
  return pts;
}

function arrowheadLines(from: LngLat, to: LngLat): LngLat[][] {
  // Two ~10% length lines off the tip, splayed ±25°.
  const segKm = Math.max(0.5, haversineKm(from, to) * 0.18);
  const brg = bearingDeg(from, to);
  const back1 = destinationPoint(to, (brg + 180 - 25 + 360) % 360, segKm);
  const back2 = destinationPoint(to, (brg + 180 + 25) % 360, segKm);
  return [
    [to, back1],
    [to, back2],
  ];
}

// ────────────────────────────────────────────────────────────────────────
// GeoJSON builder
// ────────────────────────────────────────────────────────────────────────

type LineFeature = GeoJSON.Feature<GeoJSON.LineString, { color: string; width: number }>;
type PolyFeature = GeoJSON.Feature<GeoJSON.Polygon, { color: string }>;
type TextFeature = GeoJSON.Feature<GeoJSON.Point, { text: string; color: string }>;

function buildGeoJson(
  finished: Annotation[],
  draft: Annotation | null,
  polygonInProgress: LngLat[],
): {
  lines: GeoJSON.FeatureCollection<GeoJSON.LineString, { color: string; width: number }>;
  polys: GeoJSON.FeatureCollection<GeoJSON.Polygon, { color: string }>;
  texts: GeoJSON.FeatureCollection<GeoJSON.Point, { text: string; color: string }>;
} {
  const lines: LineFeature[] = [];
  const polys: PolyFeature[] = [];
  const texts: TextFeature[] = [];

  const all = draft ? [...finished, draft] : finished;
  for (const a of all) {
    if (a.kind === 'pen' && a.coords.length >= 2) {
      lines.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: a.coords },
        properties: { color: a.color, width: a.width },
      });
    }
    if (a.kind === 'arrow') {
      lines.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [a.from, a.to] },
        properties: { color: a.color, width: a.width },
      });
      for (const seg of arrowheadLines(a.from, a.to)) {
        lines.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: seg },
          properties: { color: a.color, width: a.width },
        });
      }
    }
    if (a.kind === 'polygon' && a.coords.length >= 3) {
      const ring = [...a.coords, a.coords[0]];
      polys.push({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [ring] },
        properties: { color: a.color },
      });
    }
    if (a.kind === 'circle' && a.radiusKm > 0) {
      const ring = circlePolygon(a.center, a.radiusKm);
      polys.push({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [ring] },
        properties: { color: a.color },
      });
    }
    if (a.kind === 'text') {
      texts.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: a.at },
        properties: { text: a.text, color: a.color },
      });
    }
  }

  // In-progress polygon: show edges as guide lines, no fill until finished.
  if (polygonInProgress.length >= 2) {
    lines.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: polygonInProgress },
      properties: { color: '#fbbf24', width: 2 },
    });
  }

  return {
    lines: { type: 'FeatureCollection', features: lines },
    polys: { type: 'FeatureCollection', features: polys },
    texts: { type: 'FeatureCollection', features: texts },
  };
}

// ────────────────────────────────────────────────────────────────────────
// Hook
// ────────────────────────────────────────────────────────────────────────

const COLORS: AnnotateColor[] = [
  '#ef4444', // red
  '#f59e0b', // amber
  '#facc15', // yellow
  '#22c55e', // green
  '#06b6d4', // cyan
  '#ffffff', // white
];
const WIDTHS = [2, 4, 6] as const;

export type UseRadarAnnotations = ReturnType<typeof useRadarAnnotations>;

export function useRadarAnnotations(
  mapRef: RefObject<MapRef>,
  disabled: boolean,
) {
  const [mode, setMode] = useState<AnnotateMode>('none');
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [color, setColor] = useState<AnnotateColor>('#ef4444');
  const [width, setWidth] = useState<number>(4);
  const [draft, setDraft] = useState<Annotation | null>(null);
  const [polygonPts, setPolygonPts] = useState<LngLat[]>([]);

  // Refs mirror the draft + polygon state so the mouseup / dblclick
  // commit paths can read the latest value WITHOUT calling setAnnotations
  // from inside another setState updater. React 18 Strict Mode runs
  // updaters twice to detect impurities, and a setAnnotations() side
  // effect inside setDraft()/setPolygonPts() would double-fire, adding
  // each annotation twice in dev (hence the previous "counts in 2s"
  // bug). With refs we keep state updates pure.
  const draftRef = useRef<Annotation | null>(null);
  const polygonPtsRef = useRef<LngLat[]>([]);
  useEffect(() => { draftRef.current = draft; }, [draft]);
  useEffect(() => { polygonPtsRef.current = polygonPts; }, [polygonPts]);

  // Reset transient state whenever the mode changes or another tool kicks
  // in and disables us.
  useEffect(() => {
    if (mode === 'none' || disabled) {
      setDraft(null);
      // Keep polygonPts when mode flips between polygon ↔ pen so the
      // operator can come back and finish — but clear on full disable.
      if (disabled) setPolygonPts([]);
    }
  }, [mode, disabled]);

  // Attach native mapbox listeners for the active drawing mode. We use
  // map.on() instead of react-map-gl props because RadarView already
  // routes <Map onClick/onMouseMove> into its own draw flow, and stealing
  // those props would conflict with the existing audience polygon /
  // pick-site / snap behaviour.
  useEffect(() => {
    if (disabled || mode === 'none') return;
    const map = mapRef.current?.getMap();
    if (!map) return;

    const cleanups: (() => void)[] = [];

    const evToLngLat = (e: mapboxgl.MapMouseEvent): LngLat => [
      e.lngLat.lng,
      e.lngLat.lat,
    ];

    if (mode === 'pen' || mode === 'arrow' || mode === 'circle') {
      let dragging = false;
      const onDown = (e: mapboxgl.MapMouseEvent) => {
        const start = evToLngLat(e);
        dragging = true;
        if (mode === 'pen') {
          setDraft({ id: 'draft', kind: 'pen', coords: [start], color, width });
        } else if (mode === 'arrow') {
          setDraft({ id: 'draft', kind: 'arrow', from: start, to: start, color, width });
        } else {
          setDraft({ id: 'draft', kind: 'circle', center: start, radiusKm: 0, color });
        }
      };
      const onMove = (e: mapboxgl.MapMouseEvent) => {
        if (!dragging) return;
        const cur = evToLngLat(e);
        setDraft((d) => {
          if (!d) return d;
          if (d.kind === 'pen')
            return { ...d, coords: [...d.coords, cur] };
          if (d.kind === 'arrow') return { ...d, to: cur };
          if (d.kind === 'circle')
            return { ...d, radiusKm: haversineKm(d.center, cur) };
          return d;
        });
      };
      const onUp = () => {
        if (!dragging) return;
        dragging = false;
        // Read the latest draft from a ref so we can issue setAnnotations
        // outside any other state-updater closure (avoids Strict Mode
        // double-fire). Reject degenerate strokes (single-pixel taps).
        const d = draftRef.current;
        if (d) {
          const valid =
            (d.kind === 'pen' && d.coords.length >= 2) ||
            (d.kind === 'arrow' && haversineKm(d.from, d.to) > 0.1) ||
            (d.kind === 'circle' && d.radiusKm > 0.1);
          if (valid) {
            const committed = { ...d, id: cryptoRandomId() };
            setAnnotations((arr) => [...arr, committed]);
          }
        }
        setDraft(null);
      };
      map.on('mousedown', onDown);
      map.on('mousemove', onMove);
      map.on('mouseup', onUp);
      cleanups.push(() => {
        map.off('mousedown', onDown);
        map.off('mousemove', onMove);
        map.off('mouseup', onUp);
      });
    } else if (mode === 'polygon') {
      const onClick = (e: mapboxgl.MapMouseEvent) => {
        setPolygonPts((pts) => [...pts, evToLngLat(e)]);
      };
      const onDbl = () => {
        // Mapbox fires click before dblclick; finalize on dblclick. Read
        // the latest polygon vertices from a ref so the setAnnotations
        // call stays outside any other updater closure.
        const pts = polygonPtsRef.current;
        if (pts.length >= 3) {
          const committed: Annotation = {
            id: cryptoRandomId(),
            kind: 'polygon',
            coords: pts,
            color,
          };
          setAnnotations((arr) => [...arr, committed]);
        }
        setPolygonPts([]);
        setMode('none');
      };
      map.on('click', onClick);
      map.on('dblclick', onDbl);
      cleanups.push(() => {
        map.off('click', onClick);
        map.off('dblclick', onDbl);
      });
    } else if (mode === 'text') {
      const onClick = (e: mapboxgl.MapMouseEvent) => {
        // window.prompt is intentional — operator hands are on a single
        // input device; a popover would add a tap. Quick > pretty here.
        const text = window.prompt('Label text:');
        if (text && text.trim()) {
          setAnnotations((arr) => [
            ...arr,
            {
              id: cryptoRandomId(),
              kind: 'text',
              at: evToLngLat(e),
              text: text.trim(),
              color,
            },
          ]);
        }
        setMode('none');
      };
      // Once: the text tool drops a single label per activation.
      map.once('click', onClick);
      cleanups.push(() => {
        map.off('click', onClick);
      });
    }

    return () => cleanups.forEach((fn) => fn());
  }, [mode, color, width, disabled, mapRef]);

  const finishPolygon = useCallback(() => {
    if (polygonPts.length >= 3) {
      setAnnotations((arr) => [
        ...arr,
        { id: cryptoRandomId(), kind: 'polygon', coords: polygonPts, color },
      ]);
    }
    setPolygonPts([]);
    setMode('none');
  }, [polygonPts, color]);

  const undo = useCallback(() => {
    setAnnotations((arr) => arr.slice(0, -1));
    setPolygonPts([]);
    setDraft(null);
  }, []);

  const clearAll = useCallback(() => {
    setAnnotations([]);
    setDraft(null);
    setPolygonPts([]);
  }, []);

  const snapshot = useCallback(async (): Promise<string | null> => {
    const map = mapRef.current?.getMap();
    if (!map) return null;
    // Force one paint so any in-flight annotation lands on the buffer
    // before we read pixels.
    return new Promise((resolve) => {
      map.once('idle', () => {
        try {
          const url = map.getCanvas().toDataURL('image/png');
          resolve(url);
        } catch {
          resolve(null);
        }
      });
      map.triggerRepaint();
    });
  }, [mapRef]);

  // F11: animated capture. MediaRecorder reads from canvas.captureStream(),
  // which Mapbox supports because we boot the GL context with
  // `preserveDrawingBuffer: true` (see RadarView setup). MP4 is preferred so
  // the file drops cleanly into Telegram via sendVideo / compose-media; WebM
  // is the fallback on browsers without the h264 MIME registered.
  //
  // We force a triggerRepaint() each rAF tick while recording. Without that
  // the WebGL canvas can sit on the same frame between LibreWxR cycles, and
  // captureStream would emit duplicate pixels — annotations drawn DURING
  // recording would also stutter. The cost is one extra paint per ~16 ms
  // for the recording window, which is negligible against a normal radar
  // refresh.
  const [recording, setRecording] = useState<{ remainingMs: number; totalMs: number } | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordCleanupRef = useRef<(() => void) | null>(null);

  const stopRecording = useCallback(() => {
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') {
      try { rec.stop(); } catch { /* ignore */ }
    }
    if (recordCleanupRef.current) {
      recordCleanupRef.current();
      recordCleanupRef.current = null;
    }
    recorderRef.current = null;
    setRecording(null);
  }, []);

  const recordVideo = useCallback(async (durationMs: number): Promise<{ blob: Blob; ext: string } | null> => {
    const map = mapRef.current?.getMap();
    if (!map) return null;
    if (typeof MediaRecorder === 'undefined') {
      alert('Your browser does not support video recording (MediaRecorder).');
      return null;
    }
    const canvas = map.getCanvas() as HTMLCanvasElement;
    // Some older Safari builds expose captureStream as captureMediaStream.
    const captureStream =
      (canvas as any).captureStream?.bind(canvas) ??
      (canvas as any).captureMediaStream?.bind(canvas);
    if (typeof captureStream !== 'function') {
      alert('This browser cannot capture the radar canvas as a video stream.');
      return null;
    }
    const stream: MediaStream = captureStream(15);

    // Pick the best supported MIME type. Order matters — MP4 first because
    // Telegram's animation/video paths expect h264; WebM is the universal
    // fallback that still works as sendDocument.
    const candidates = [
      'video/mp4;codecs=h264',
      'video/mp4',
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
    ];
    const mimeType = candidates.find((t) => MediaRecorder.isTypeSupported(t));
    if (!mimeType) {
      stream.getTracks().forEach((t) => t.stop());
      alert('No supported video MIME type for recording on this browser.');
      return null;
    }
    const ext = mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';

    const chunks: BlobPart[] = [];
    const rec = new MediaRecorder(stream, {
      mimeType,
      // 5 Mbps is generous for radar (mostly flat color regions); the file
      // stays well under the 50 MB compose-media limit even at 30s.
      videoBitsPerSecond: 5_000_000,
    });
    recorderRef.current = rec;

    // Force continuous repaints so captureStream gets fresh pixels every
    // tick even when LibreWxR isn't cycling a new frame. rAF cancels in
    // the cleanup callback.
    let rafId = 0;
    const tick = () => {
      map.triggerRepaint();
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);

    // 250 ms timer drives the countdown UI without spamming setState.
    const start = Date.now();
    const tickInt = window.setInterval(() => {
      const elapsed = Date.now() - start;
      const remaining = Math.max(0, durationMs - elapsed);
      setRecording({ remainingMs: remaining, totalMs: durationMs });
    }, 250);

    const cleanup = () => {
      cancelAnimationFrame(rafId);
      clearInterval(tickInt);
      stream.getTracks().forEach((t) => t.stop());
    };
    recordCleanupRef.current = cleanup;

    return new Promise((resolve) => {
      rec.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
      rec.onstop = () => {
        cleanup();
        recordCleanupRef.current = null;
        recorderRef.current = null;
        setRecording(null);
        resolve({ blob: new Blob(chunks, { type: mimeType }), ext });
      };
      rec.onerror = () => {
        cleanup();
        recordCleanupRef.current = null;
        recorderRef.current = null;
        setRecording(null);
        resolve(null);
      };
      setRecording({ remainingMs: durationMs, totalMs: durationMs });
      rec.start(1000); // 1 s chunks — finalizing on stop yields one Blob
      window.setTimeout(() => {
        if (rec.state !== 'inactive') {
          try { rec.stop(); } catch { /* ignore */ }
        }
      }, durationMs);
    });
  }, [mapRef]);

  // Stop any in-flight recording on unmount so a route change doesn't leave
  // a dangling captureStream pinned to the GPU.
  useEffect(() => () => stopRecording(), [stopRecording]);

  const geojson = useMemo(
    () => buildGeoJson(annotations, draft, polygonPts),
    [annotations, draft, polygonPts],
  );

  const isActive = mode !== 'none';

  return {
    mode,
    setMode,
    color,
    setColor,
    width,
    setWidth,
    annotations,
    polygonPts,
    finishPolygon,
    undo,
    clearAll,
    snapshot,
    recordVideo,
    stopRecording,
    recording,
    geojson,
    isActive,
  };
}

function cryptoRandomId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `a-${Math.random().toString(36).slice(2, 10)}`;
  }
}

// ────────────────────────────────────────────────────────────────────────
// <AnnotationLayer /> — child of <Map>
// ────────────────────────────────────────────────────────────────────────

export function AnnotationLayer({
  geojson,
}: {
  geojson: UseRadarAnnotations['geojson'];
}) {
  return (
    <>
      <Source id="annot-poly" type="geojson" data={geojson.polys}>
        <Layer
          id="annot-poly-fill"
          type="fill"
          paint={{
            'fill-color': ['get', 'color'],
            'fill-opacity': 0.18,
          }}
        />
        <Layer
          id="annot-poly-outline"
          type="line"
          paint={{
            'line-color': ['get', 'color'],
            'line-width': 2.5,
            'line-opacity': 0.95,
          }}
        />
      </Source>
      <Source id="annot-line" type="geojson" data={geojson.lines}>
        <Layer
          id="annot-line-stroke"
          type="line"
          layout={{ 'line-cap': 'round', 'line-join': 'round' }}
          paint={{
            'line-color': ['get', 'color'],
            'line-width': ['get', 'width'],
            'line-opacity': 0.95,
          }}
        />
      </Source>
      <Source id="annot-text" type="geojson" data={geojson.texts}>
        <Layer
          id="annot-text-label"
          type="symbol"
          layout={{
            'text-field': ['get', 'text'],
            'text-size': 14,
            'text-anchor': 'top',
            'text-offset': [0, 0.4],
            'text-allow-overlap': true,
            'text-ignore-placement': true,
          }}
          paint={{
            'text-color': ['get', 'color'],
            'text-halo-color': '#000000',
            'text-halo-width': 1.5,
          }}
        />
      </Source>
    </>
  );
}

// ────────────────────────────────────────────────────────────────────────
// <AnnotationToolbar /> — floating UI
// ────────────────────────────────────────────────────────────────────────

type ToolButtonProps = {
  active: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
};

function ToolButton({ active, onClick, title, children }: ToolButtonProps) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className={`flex h-9 w-9 items-center justify-center rounded border text-sm ${
        active
          ? 'border-wx-accent bg-wx-accent text-black'
          : 'border-wx-line bg-wx-card text-wx-fg hover:bg-wx-ink'
      }`}
    >
      {children}
    </button>
  );
}

const TOOLBAR_OPEN_KEY = 'midsouthwx:annotate-toolbar-open';

export function AnnotationToolbar(props: UseRadarAnnotations) {
  const {
    mode,
    setMode,
    color,
    setColor,
    width,
    setWidth,
    polygonPts,
    finishPolygon,
    undo,
    clearAll,
    snapshot,
    recordVideo,
    stopRecording,
    recording,
    annotations,
  } = props;
  // F11: per-session record-duration preference. Persisted alongside the
  // toolbar's open state so the operator doesn't have to repick every
  // session during an active event.
  const [recordDuration, setRecordDuration] = useState<5 | 10 | 20 | 30>(10);

  // Open state persists in sessionStorage so the operator's preference
  // survives a router.refresh() during an active event but resets on a
  // fresh tab/session — the toolbar shouldn't surprise-open after a
  // browser restart.
  const [open, setOpen] = useState<boolean>(false);
  useEffect(() => {
    try {
      if (sessionStorage.getItem(TOOLBAR_OPEN_KEY) === '1') setOpen(true);
    } catch {
      // sessionStorage can throw in private mode — ignore.
    }
  }, []);
  useEffect(() => {
    try {
      sessionStorage.setItem(TOOLBAR_OPEN_KEY, open ? '1' : '0');
    } catch {
      // ignore
    }
  }, [open]);

  // Auto-open whenever a drawing mode goes active (operator likely opened
  // it intentionally; collapsing-while-drawing would hide the cancel
  // button mid-stroke).
  useEffect(() => {
    if (mode !== 'none') setOpen(true);
  }, [mode]);

  const toggle = (m: AnnotateMode) => setMode(mode === m ? 'none' : m);

  const onSnapshot = async () => {
    const url = await snapshot();
    if (!url) {
      alert('Could not capture the radar — try again in a moment.');
      return;
    }
    // Download. Broadcast-to-Telegram is a follow-up that needs server
    // upload + /compose pre-fill — see notes in code review report.
    const a = document.createElement('a');
    a.href = url;
    a.download = `radar-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  // F11: animated capture. While recording, the toolbar swaps the record
  // icon for a stop button + a live countdown so the operator knows to
  // hold the view steady. Output downloads as .mp4 when the browser
  // supports h264 (Chrome/Safari modern), else .webm.
  const onRecord = async () => {
    if (recording) {
      stopRecording();
      return;
    }
    const result = await recordVideo(recordDuration * 1000);
    if (!result) {
      alert('Could not record the radar — try again or use Snapshot for a still.');
      return;
    }
    const url = URL.createObjectURL(result.blob);
    try {
      const a = document.createElement('a');
      a.href = url;
      a.download = `radar-${new Date().toISOString().replace(/[:.]/g, '-')}.${result.ext}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } finally {
      // Defer revoke so the download has a chance to start.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  };

  const polygonInProgress = mode === 'polygon' && polygonPts.length > 0;
  const hasAnything = annotations.length > 0 || polygonInProgress;
  const isLive = mode !== 'none' || polygonInProgress;

  // Collapsed: single pill in the bottom-left with a small count badge.
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`pointer-events-auto absolute bottom-3 left-3 z-20 flex items-center gap-1.5 rounded-lg border bg-wx-card/95 px-2.5 py-1.5 text-xs shadow-lg backdrop-blur transition-colors ${
          isLive
            ? 'border-wx-accent text-wx-accent'
            : 'border-wx-line text-wx-mute hover:text-wx-fg'
        }`}
        aria-label="Open annotation toolbar"
        title="Annotation tools"
      >
        <Pencil size={14} />
        <span>Annotate</span>
        {annotations.length > 0 ? (
          <span className="rounded-full bg-wx-accent px-1.5 py-0.5 text-[10px] font-bold text-black">
            {annotations.length}
          </span>
        ) : null}
        <ChevronUp size={14} className="ml-0.5 opacity-70" />
      </button>
    );
  }

  return (
    <div className="pointer-events-auto absolute bottom-3 left-3 z-20 flex w-[210px] flex-col gap-2 rounded-lg border border-wx-line bg-wx-card/95 p-2 shadow-lg backdrop-blur">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold text-wx-mute">
          <Pencil size={12} />
          Annotate
          {annotations.length > 0 ? (
            <span className="ml-1 rounded-full bg-wx-accent px-1.5 py-0.5 text-[9px] font-bold text-black">
              {annotations.length}
            </span>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="flex h-6 w-6 items-center justify-center rounded text-wx-mute hover:bg-wx-ink hover:text-wx-fg"
          aria-label="Collapse annotation toolbar"
          title="Collapse"
        >
          <ChevronDown size={14} />
        </button>
      </div>

      <div className="flex items-center gap-1">
        <ToolButton active={mode === 'pen'} onClick={() => toggle('pen')} title="Free pen">
          <Pencil size={16} />
        </ToolButton>
        <ToolButton active={mode === 'arrow'} onClick={() => toggle('arrow')} title="Arrow">
          <ArrowUpRight size={16} />
        </ToolButton>
        <ToolButton active={mode === 'polygon'} onClick={() => toggle('polygon')} title="Polygon (click vertices, double-click to finish)">
          <Hexagon size={16} />
        </ToolButton>
        <ToolButton active={mode === 'circle'} onClick={() => toggle('circle')} title="Circle (click center, drag to radius)">
          <CircleIcon size={16} />
        </ToolButton>
        <ToolButton active={mode === 'text'} onClick={() => toggle('text')} title="Text label">
          <TypeIcon size={16} />
        </ToolButton>
      </div>

      <div className="flex items-center gap-1">
        {COLORS.map((c) => (
          <button
            key={c}
            type="button"
            title={c}
            aria-label={`Color ${c}`}
            onClick={() => setColor(c)}
            className={`h-6 w-6 rounded-full border-2 ${
              color === c ? 'border-wx-accent' : 'border-wx-line'
            }`}
            style={{ backgroundColor: c }}
          />
        ))}
      </div>

      <div className="flex items-center gap-1">
        {WIDTHS.map((w) => (
          <button
            key={w}
            type="button"
            title={`Width ${w}`}
            aria-label={`Width ${w}`}
            onClick={() => setWidth(w)}
            className={`flex h-7 flex-1 items-center justify-center rounded border text-[10px] ${
              width === w
                ? 'border-wx-accent bg-wx-accent text-black'
                : 'border-wx-line bg-wx-card text-wx-mute hover:text-wx-fg'
            }`}
          >
            <div
              className="rounded-full bg-current"
              style={{ height: w, width: 16 }}
            />
          </button>
        ))}
      </div>

      {polygonInProgress ? (
        <button
          type="button"
          onClick={finishPolygon}
          className="rounded border border-wx-accent bg-wx-accent/20 px-2 py-1 text-[11px] font-medium text-wx-accent hover:bg-wx-accent/30"
        >
          Finish polygon ({polygonPts.length} pts)
        </button>
      ) : null}

      <div className="flex items-center gap-1">
        <ToolButton active={false} onClick={undo} title="Undo last">
          <Undo2 size={16} />
        </ToolButton>
        <ToolButton active={false} onClick={clearAll} title="Clear all">
          <Trash2 size={16} />
        </ToolButton>
        <ToolButton active={false} onClick={onSnapshot} title="Snapshot (PNG)">
          <Camera size={16} />
        </ToolButton>
        <ToolButton
          active={!!recording}
          onClick={onRecord}
          title={recording ? 'Stop recording' : `Record ${recordDuration}s video`}
        >
          {recording ? <StopIcon size={14} /> : <Video size={16} />}
        </ToolButton>
        {mode !== 'none' ? (
          <ToolButton active={false} onClick={() => setMode('none')} title="Cancel">
            <X size={16} />
          </ToolButton>
        ) : null}
      </div>

      {/* F11: record-duration picker. Hidden during an active recording
          so the operator can't change the target mid-capture. */}
      {!recording ? (
        <div className="flex items-center gap-1">
          {([5, 10, 20, 30] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setRecordDuration(s)}
              className={`flex-1 px-1 py-0.5 rounded text-[9.5px] font-mono border transition ${
                recordDuration === s
                  ? 'bg-red-500/20 border-red-400/60 text-red-200'
                  : 'bg-wx-card border-wx-line text-wx-mute hover:text-wx-fg'
              }`}
              title={`Record ${s} seconds`}
            >
              {s}s
            </button>
          ))}
        </div>
      ) : (
        <div className="flex items-center gap-1.5 rounded border border-red-400/60 bg-red-500/10 px-2 py-1 text-[10px] font-mono text-red-200">
          <span className="inline-block h-2 w-2 rounded-full bg-red-400 animate-pulse" />
          <span className="flex-1">
            REC · {Math.ceil(recording.remainingMs / 1000)}s
          </span>
          <span className="text-red-300/70">
            {Math.round((1 - recording.remainingMs / recording.totalMs) * 100)}%
          </span>
        </div>
      )}

      {mode !== 'none' ? (
        <div className="rounded border border-wx-line bg-wx-ink/60 px-2 py-1 text-center text-[10px] text-wx-mute">
          {mode === 'pen' && 'Click and drag to draw'}
          {mode === 'arrow' && 'Click and drag from tail to tip'}
          {mode === 'polygon' && 'Click to add vertex · double-click to finish'}
          {mode === 'circle' && 'Click center · drag to set radius'}
          {mode === 'text' && 'Click anywhere to place label'}
        </div>
      ) : null}

      {hasAnything && mode === 'none' ? (
        <div className="text-center text-[10px] text-wx-mute">
          {annotations.length} annotation{annotations.length === 1 ? '' : 's'}
        </div>
      ) : null}
    </div>
  );
}

// Re-exports for the parent's State plumbing if it wants the setters.
export type { Dispatch, SetStateAction };
