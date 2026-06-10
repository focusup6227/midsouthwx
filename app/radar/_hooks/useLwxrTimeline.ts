'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// LibreWxR timeline + playback state machine, extracted from RadarView.
// Owns the 2-minute index poll, the past/nowcast frame list, the current
// frame / play / speed state, the playback driver (with dwell-at-NOW pause),
// timeline scrubbing, and the playback keyboard shortcuts.

export type LibreWxRFrame = { time: number; path: string };
export type LibreWxRIndex = {
  host: string;
  radar: { past: LibreWxRFrame[]; nowcast: LibreWxRFrame[] };
  satellite: { infrared: LibreWxRFrame[] };
};

export type PlaybackSpeed = '0.5x' | '1x' | '2x' | '4x';

const LIBREWXR_INDEX_URL = 'https://api.librewxr.net/public/weather-maps.json';

export function useLwxrTimeline(lwxrSubject: 'radar' | 'satellite' | null) {
  const useLibreWxR = lwxrSubject !== null;

  const [lwxrIndex, setLwxrIndex] = useState<LibreWxRIndex | null>(null);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<PlaybackSpeed>('1x');

  // Pull the LibreWxR index every 2 min so new past frames appear in the
  // timeline as they're published.
  const lwxrIndexLoadedRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch(LIBREWXR_INDEX_URL, { cache: 'no-store' });
        const j = (await r.json()) as LibreWxRIndex;
        if (cancelled) return;
        if (j?.host && j?.radar) {
          // On the first successful fetch, pin `frame` to the latest past
          // frame in the SAME batched update as setLwxrIndex. Otherwise the
          // first render mounts a lazy window around frame=0 (oldest), the
          // pin effect then bumps frame to lwxrPastCount-1, and the window
          // has to remount — racing tile loads and producing a blank map
          // until the user advances the timeline.
          if (!lwxrIndexLoadedRef.current) {
            lwxrIndexLoadedRef.current = true;
            const pastLen = j.radar.past?.length ?? 0;
            if (pastLen > 0) setFrame(pastLen - 1);
          }
          setLwxrIndex(j);
        }
      } catch {/* ignore */}
    };
    load();
    const id = setInterval(load, 120_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const lwxrAllFrames = useMemo<LibreWxRFrame[]>(() => {
    if (!useLibreWxR || !lwxrIndex) return [];
    if (lwxrSubject === 'satellite') return [...(lwxrIndex.satellite?.infrared ?? [])];
    return [...(lwxrIndex.radar?.past ?? []), ...(lwxrIndex.radar?.nowcast ?? [])];
  }, [useLibreWxR, lwxrSubject, lwxrIndex]);
  // For satellite there is no nowcast — every frame is "past", so the live
  // cursor sits at the final frame.
  const lwxrPastCount = useMemo(() => {
    if (!useLibreWxR || !lwxrIndex) return 0;
    if (lwxrSubject === 'satellite') return lwxrIndex.satellite?.infrared?.length ?? 0;
    return lwxrIndex.radar?.past?.length ?? 0;
  }, [useLibreWxR, lwxrSubject, lwxrIndex]);
  const totalFrames = useLibreWxR ? Math.max(1, lwxrAllFrames.length) : 1;

  // Pin frame to the latest past frame whenever the frame list changes (e.g.
  // a new past frame just arrived, or the user switched away from LibreWxR).
  const prevTotal = useRef(0);
  useEffect(() => {
    if (!useLibreWxR) {
      setFrame(0);
      setPlaying(false);
      return;
    }
    if (lwxrPastCount && prevTotal.current !== totalFrames) {
      setFrame(Math.max(0, lwxrPastCount - 1));
      prevTotal.current = totalFrames;
    }
  }, [useLibreWxR, lwxrPastCount, totalFrames]);

  // Playback driver. Uses setTimeout so the dwell-at-NOW pause is variable per
  // frame; re-runs whenever frame changes, which is cheap and predictable.
  useEffect(() => {
    if (!playing || !useLibreWxR || totalFrames <= 1) return;
    const baseMs = { '0.5x': 800, '1x': 400, '2x': 220, '4x': 110 }[speed] ?? 400;
    // Pause briefly when we land on the most-recent observed frame so the
    // viewer can read the "now" state before the loop continues into nowcast
    // (or wraps back to the oldest past frame).
    const dwell = frame === lwxrPastCount - 1 ? Math.max(baseMs * 4, 1400) : baseMs;
    const id = setTimeout(() => {
      setFrame((f) => (f + 1) % totalFrames);
    }, dwell);
    return () => clearTimeout(id);
  }, [playing, speed, useLibreWxR, totalFrames, lwxrPastCount, frame]);

  // ── Scrub + keyboard ─────────────────────────────────────────────────
  const trackRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const [hoverFrame, setHoverFrame] = useState<number | null>(null);

  const scrubAtClientX = useCallback((clientX: number): number | null => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return null;
    const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
    return Math.round((x / rect.width) * Math.max(0, totalFrames - 1));
  }, [totalFrames]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      const f = scrubAtClientX(e.clientX);
      if (f != null) setFrame(f);
    };
    const onUp = () => { draggingRef.current = false; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [scrubAtClientX]);

  // Keyboard shortcuts. Skipped when focus is on an input so the opacity
  // slider, etc. keep working.
  useEffect(() => {
    if (!useLibreWxR || totalFrames <= 1) return;
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement | null;
      const tag = tgt?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tgt?.isContentEditable) return;
      if (e.code === 'Space') {
        e.preventDefault();
        setPlaying((p) => !p);
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        setPlaying(false);
        setFrame((f) => Math.max(0, f - 1));
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        setPlaying(false);
        setFrame((f) => Math.min(totalFrames - 1, f + 1));
      } else if (e.code === 'Home') {
        e.preventDefault();
        setPlaying(false);
        setFrame(0);
      } else if (e.code === 'End') {
        e.preventDefault();
        setPlaying(false);
        setFrame(totalFrames - 1);
      } else if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        setPlaying(false);
        setFrame(Math.max(0, lwxrPastCount - 1));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [useLibreWxR, totalFrames, lwxrPastCount]);

  return {
    lwxrIndex,
    lwxrAllFrames,
    lwxrPastCount,
    totalFrames,
    frame,
    setFrame,
    playing,
    setPlaying,
    speed,
    setSpeed,
    hoverFrame,
    setHoverFrame,
    trackRef,
    draggingRef,
    scrubAtClientX,
  };
}
