'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { loadScript, scriptToPrompterText, type StoredScript } from '@/lib/broadcast/script-store';

// Full-screen auto-scrolling teleprompter. Reads the script the console saved
// to localStorage. Controls: space = play/pause, ↑/↓ = speed, +/- = font size,
// M = mirror (for a beam-splitter glass), R/Home = rewind, Esc = controls.
export default function TeleprompterPage() {
  const [stored, setStored] = useState<StoredScript | null>(null);
  const [text, setText] = useState('');
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(60); // px/sec
  const [fontSize, setFontSize] = useState(48);
  const [mirror, setMirror] = useState(false);
  const [showControls, setShowControls] = useState(true);

  const scrollRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  const lastTs = useRef<number | null>(null);
  const carry = useRef(0); // sub-pixel scroll accumulator

  useEffect(() => {
    const s = loadScript();
    setStored(s);
    if (s) setText(scriptToPrompterText(s.script));
  }, []);

  // rAF-driven smooth scroll while playing.
  useEffect(() => {
    if (!playing) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      lastTs.current = null;
      return;
    }
    const step = (ts: number) => {
      const el = scrollRef.current;
      if (el) {
        if (lastTs.current != null) {
          const dt = (ts - lastTs.current) / 1000;
          carry.current += speed * dt;
          const whole = Math.floor(carry.current);
          if (whole > 0) {
            el.scrollTop += whole;
            carry.current -= whole;
          }
          if (el.scrollTop + el.clientHeight >= el.scrollHeight - 1) {
            setPlaying(false);
            return;
          }
        }
        lastTs.current = ts;
      }
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [playing, speed]);

  const rewind = useCallback(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    carry.current = 0;
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      switch (e.key) {
        case ' ': e.preventDefault(); setPlaying((p) => !p); break;
        case 'ArrowUp': e.preventDefault(); setSpeed((s) => Math.min(300, s + 10)); break;
        case 'ArrowDown': e.preventDefault(); setSpeed((s) => Math.max(10, s - 10)); break;
        case '+': case '=': setFontSize((f) => Math.min(120, f + 4)); break;
        case '-': case '_': setFontSize((f) => Math.max(20, f - 4)); break;
        case 'm': case 'M': setMirror((m) => !m); break;
        case 'r': case 'R': case 'Home': rewind(); break;
        case 'Escape': setShowControls((c) => !c); break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rewind]);

  return (
    <div className="fixed inset-0 bg-black text-white">
      {/* Reading guide line across the upper third */}
      <div className="pointer-events-none absolute inset-x-0 top-[28%] z-10 border-t-2 border-amber-400/50" />
      <div className="pointer-events-none absolute left-2 top-[28%] z-10 -translate-y-1/2 text-amber-400 text-2xl">▶</div>

      <div
        ref={scrollRef}
        className="h-full w-full overflow-y-scroll scroll-smooth px-[8vw] py-[40vh]"
        style={{ transform: mirror ? 'scaleX(-1)' : undefined }}
      >
        {text ? (
          <div
            className="mx-auto max-w-[1100px] whitespace-pre-wrap font-semibold leading-[1.45] tracking-wide"
            style={{ fontSize }}
          >
            {text}
          </div>
        ) : (
          <div className="mx-auto max-w-[700px] text-center" style={{ transform: mirror ? 'scaleX(-1)' : undefined }}>
            <div className="text-3xl font-bold">No script loaded</div>
            <p className="mt-4 text-white/60">
              Generate a script in the broadcast console, then return here. The teleprompter reads
              whatever the console last saved on this device.
            </p>
            <Link href="/broadcast" className="mt-6 inline-block rounded-md bg-amber-400 px-5 py-2.5 font-semibold text-black">
              Open broadcast console
            </Link>
          </div>
        )}
      </div>

      {showControls ? (
        <div
          className="absolute inset-x-0 bottom-0 z-20 flex flex-wrap items-center justify-center gap-3 bg-black/80 px-4 py-3 backdrop-blur"
          style={{ transform: 'none' }}
        >
          <button
            onClick={() => setPlaying((p) => !p)}
            className="rounded-md bg-amber-400 px-5 py-2 font-bold text-black"
          >
            {playing ? '⏸ Pause' : '▶ Play'}
          </button>
          <button onClick={rewind} className="rounded-md border border-white/20 px-3 py-2 text-sm">⤒ Top</button>

          <label className="flex items-center gap-2 text-sm">
            Speed
            <input type="range" min={10} max={300} step={5} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} />
            <span className="w-12 font-mono text-xs text-white/70">{speed}px/s</span>
          </label>

          <label className="flex items-center gap-2 text-sm">
            Size
            <input type="range" min={20} max={120} step={2} value={fontSize} onChange={(e) => setFontSize(Number(e.target.value))} />
            <span className="w-10 font-mono text-xs text-white/70">{fontSize}</span>
          </label>

          <button
            onClick={() => setMirror((m) => !m)}
            className={`rounded-md border px-3 py-2 text-sm ${mirror ? 'border-amber-400 text-amber-400' : 'border-white/20'}`}
          >
            Mirror
          </button>

          <span className="text-xs text-white/40">
            space=play · ↑↓=speed · ±=size · M=mirror · R=top · Esc=hide
          </span>
          <Link href="/broadcast" className="text-xs text-white/50 hover:text-white">← Console</Link>
          {stored ? (
            <span className="text-xs text-white/30">saved {new Date(stored.savedAt).toLocaleTimeString()}</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
