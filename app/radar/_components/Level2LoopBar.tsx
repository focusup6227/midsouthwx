'use client';

import { useEffect, useState } from 'react';
import { Play, Pause, Film, Layers3 } from 'lucide-react';
import type { LoopFrame } from '../_hooks/useLevel2Loop';
import type { SweepInfo } from '../_hooks/useLevel2Data';

export type StormMotion = { speedKt: number; fromDeg: number } | null;

/**
 * Bottom-center control bar for Level II products: hi-res time loop
 * (play/scrub the last ~6 volumes), tilt sweep animation, and the SRM
 * storm-motion setting for velocity.
 */
export default function Level2LoopBar({
  scanTimeLabel,
  loopEnabled,
  setLoopEnabled,
  frames,
  progress,
  loopError,
  frameIdx,
  setFrameIdx,
  playing,
  setPlaying,
  availableSweeps,
  selectedElevation,
  setSelectedElevation,
  isVelocity,
  stormMotion,
  setStormMotion,
  probeEnabled,
  setProbeEnabled,
  probeReady,
}: {
  scanTimeLabel: string | null;
  loopEnabled: boolean;
  setLoopEnabled: (v: boolean) => void;
  frames: LoopFrame[];
  progress: { done: number; total: number } | null;
  loopError: string | null;
  frameIdx: number;
  setFrameIdx: (v: number | ((prev: number) => number)) => void;
  playing: boolean;
  setPlaying: (v: boolean | ((prev: boolean) => boolean)) => void;
  availableSweeps: SweepInfo[];
  selectedElevation: number | 'composite';
  setSelectedElevation: (v: number | 'composite') => void;
  isVelocity: boolean;
  stormMotion: StormMotion;
  setStormMotion: (v: StormMotion) => void;
  probeEnabled: boolean;
  setProbeEnabled: (v: boolean) => void;
  probeReady: number;
}) {
  const [tiltPlaying, setTiltPlaying] = useState(false);
  const [srmOpen, setSrmOpen] = useState(false);
  const [speedInput, setSpeedInput] = useState(stormMotion?.speedKt ?? 30);
  const [dirInput, setDirInput] = useState(stormMotion?.fromDeg ?? 240);

  // Time-loop playback: ~1.6 fps reads well for 4-6 min volume spacing.
  useEffect(() => {
    if (!playing || frames.length < 2) return;
    const id = setInterval(() => {
      setFrameIdx((f) => (f + 1) % frames.length);
    }, 600);
    return () => clearInterval(id);
  }, [playing, frames.length, setFrameIdx]);

  // Tilt sweep: cycle through elevations low→high. First cycle renders cold
  // (seconds per tilt); after that every tilt is cached and it animates.
  useEffect(() => {
    if (!tiltPlaying || availableSweeps.length < 2) return;
    const elevs = availableSweeps.map((s) => s.elevation_deg);
    const id = setInterval(() => {
      const cur = typeof selectedElevation === 'number' ? selectedElevation : elevs[0];
      let idx = 0,
        best = Infinity;
      elevs.forEach((e, i) => {
        const d = Math.abs(e - cur);
        if (d < best) {
          best = d;
          idx = i;
        }
      });
      setSelectedElevation(elevs[(idx + 1) % elevs.length]);
    }, 1500);
    return () => clearInterval(id);
  }, [tiltPlaying, availableSweeps, selectedElevation, setSelectedElevation]);

  const activeFrame = frames[frameIdx];
  const frameLabel = activeFrame
    ? new Date(activeFrame.scanTime).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : null;
  const loading = loopEnabled && progress != null && progress.done < progress.total;

  return (
    <div className="absolute bottom-2 md:bottom-4 left-1/2 -translate-x-1/2 z-30 w-[min(560px,calc(100vw-16px))]">
      <div className="bg-wx-card/95 backdrop-blur-sm border border-wx-line rounded-xl px-3 py-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px]">
        <button
          type="button"
          onClick={() => {
            setLoopEnabled(!loopEnabled);
            setPlaying(false);
          }}
          className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 font-semibold ${
            loopEnabled ? 'border-wx-accent text-wx-accent bg-wx-accent/10' : 'border-wx-line text-wx-mute hover:text-wx-fg'
          }`}
          title="Loop the last ~45 minutes of Level II volumes"
        >
          <Film size={12} />
          Loop
        </button>

        {loopEnabled ? (
          <>
            <button
              type="button"
              onClick={() => setPlaying((p) => !p)}
              disabled={frames.length < 2}
              className="w-7 h-7 rounded-md bg-wx-accent text-black grid place-items-center disabled:opacity-40"
              title={playing ? 'Pause loop' : 'Play loop'}
            >
              {playing ? <Pause size={12} /> : <Play size={12} />}
            </button>
            {frames.length > 1 ? (
              <input
                type="range"
                min={0}
                max={frames.length - 1}
                value={Math.min(frameIdx, frames.length - 1)}
                onChange={(e) => {
                  setPlaying(false);
                  setFrameIdx(Number(e.target.value));
                }}
                className="wx-slider w-28 md:w-40"
                aria-label="Loop frame"
              />
            ) : null}
            <span className="font-mono tabular-nums text-wx-fg">
              {loading
                ? `building ${progress!.done}/${progress!.total}…`
                : loopError
                  ? <span className="text-wx-danger">loop unavailable</span>
                  : frameLabel
                    ? `${frameLabel} · ${Math.min(frameIdx + 1, frames.length)}/${frames.length}`
                    : '—'}
            </span>
          </>
        ) : (
          <span className="font-mono text-wx-mute">{scanTimeLabel ?? '—'}</span>
        )}

        <span className="mx-1 hidden h-4 w-px bg-wx-line md:block" aria-hidden />

        <button
          type="button"
          onClick={() => setTiltPlaying((v) => !v)}
          disabled={availableSweeps.length < 2 || selectedElevation === 'composite'}
          className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 font-semibold disabled:opacity-40 ${
            tiltPlaying ? 'border-sky-400 text-sky-300 bg-sky-500/10' : 'border-wx-line text-wx-mute hover:text-wx-fg'
          }`}
          title="Animate through elevation tilts (first cycle renders each tilt; smooth once cached)"
        >
          <Layers3 size={12} />
          Tilt {tiltPlaying ? `· ${typeof selectedElevation === 'number' ? selectedElevation.toFixed(1) : ''}°` : 'sweep'}
        </button>

        <button
          type="button"
          onClick={() => setProbeEnabled(!probeEnabled)}
          className={`hidden md:inline-flex rounded-md border px-2 py-1 font-semibold ${
            probeEnabled ? 'border-wx-accent text-wx-accent bg-wx-accent/10' : 'border-wx-line text-wx-mute hover:text-wx-fg'
          }`}
          title="Multi-product cursor probe: sample refl + velocity + CC together on hover"
        >
          Probe{probeEnabled ? ` ${probeReady}/3` : ''}
        </button>

        {isVelocity ? (
          <div className="relative">
            <button
              type="button"
              onClick={() => setSrmOpen((v) => !v)}
              className={`rounded-md border px-2 py-1 font-semibold ${
                stormMotion ? 'border-emerald-400 text-emerald-300 bg-emerald-500/10' : 'border-wx-line text-wx-mute hover:text-wx-fg'
              }`}
              title="Storm-relative mode: subtract storm motion from velocity"
            >
              SRM{stormMotion ? ` ${stormMotion.speedKt}kt/${stormMotion.fromDeg}°` : ' off'}
            </button>
            {srmOpen ? (
              <div className="absolute bottom-full left-0 mb-1.5 w-52 rounded-lg border border-wx-line bg-wx-card p-2.5 shadow-xl space-y-2">
                <div className="panel-title">Storm motion</div>
                <label className="flex items-center justify-between gap-2">
                  <span className="text-wx-mute">Speed (kt)</span>
                  <input
                    type="number"
                    min={5}
                    max={80}
                    value={speedInput}
                    onChange={(e) => setSpeedInput(Number(e.target.value))}
                    className="input w-16 px-1.5 py-0.5 text-[11px]"
                  />
                </label>
                <label className="flex items-center justify-between gap-2">
                  <span className="text-wx-mute">From (°)</span>
                  <input
                    type="number"
                    min={0}
                    max={360}
                    value={dirInput}
                    onChange={(e) => setDirInput(Number(e.target.value))}
                    className="input w-16 px-1.5 py-0.5 text-[11px]"
                  />
                </label>
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    className="btn text-[11px] px-2 py-1 flex-1"
                    onClick={() => {
                      setStormMotion({
                        speedKt: Math.min(80, Math.max(5, speedInput || 30)),
                        fromDeg: ((dirInput % 360) + 360) % 360,
                      });
                      setSrmOpen(false);
                    }}
                  >
                    Apply
                  </button>
                  <button
                    type="button"
                    className="btn-ghost text-[11px] px-2 py-1"
                    onClick={() => {
                      setStormMotion(null);
                      setSrmOpen(false);
                    }}
                  >
                    Off
                  </button>
                </div>
                <p className="text-[10px] leading-snug text-wx-mute">
                  Typical supercell motion is ~240° at 25–35 kt. SRM makes weak
                  rotation visible inside fast-moving storms.
                </p>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
