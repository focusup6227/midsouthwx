'use client';

import { useEffect, useRef } from 'react';
import { useSWRConfig } from 'swr';
import { supabaseBrowser } from '@/lib/supabase/client';
import {
  STORM_REPORTS_KEY,
  STORM_REPORT_CLUSTERS_KEY,
} from '@/app/radar/_hooks/useRadarData';

// Two-tier ping for live event mode. Subscribes to Realtime on
// telegram_storm_reports:
//   - INSERT  → soft tick (single 0.08s sine click) every new pin.
//   - UPDATE with cluster_paged_at flipping non-null → louder ~1s chime
//     (two-tone, no TTS). Dedup'd per row id so multiple nearby rows
//     getting stamped in the same RPC don't fire a swarm.
//
// Both also mutate the radar SWR cache so the map repaints without
// waiting for the 60 s poll. Mute toggle persisted in localStorage; the
// component still pushes data refreshes regardless of mute state so the
// visuals stay live even when sound is off.

const MUTE_KEY = 'midsouthwx:reports-audio-muted';

function isMuted(): boolean {
  if (typeof window === 'undefined') return false;
  try { return window.localStorage.getItem(MUTE_KEY) === '1'; } catch { return false; }
}

function audioCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor = window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    const ctx = new Ctor();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch { return null; }
}

/** Soft single-click tick — easy to ignore during calm conditions. */
function playTick() {
  if (isMuted()) return;
  const ctx = audioCtx();
  if (!ctx) return;
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = 1320; // E6 — bright, short, doesn't read as alarm.
  osc.connect(gain);
  gain.connect(ctx.destination);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.18, now + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);
  osc.start(now);
  osc.stop(now + 0.1);
  setTimeout(() => ctx.close().catch(() => undefined), 200);
}

/** Cluster-fire chime — two ascending tones, ~1s. Loud enough to grab
 *  attention but distinct from the EAS-style PDS chime so the operator
 *  can hear "spotter cluster" vs "tornado emergency" separately. */
function playClusterChime() {
  if (isMuted()) return;
  const ctx = audioCtx();
  if (!ctx) return;
  const now = ctx.currentTime;
  const gain = ctx.createGain();
  gain.connect(ctx.destination);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.32, now + 0.05);
  gain.gain.setValueAtTime(0.32, now + 0.9);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.0);

  const o1 = ctx.createOscillator();
  const o2 = ctx.createOscillator();
  o1.type = 'triangle';
  o2.type = 'triangle';
  o1.frequency.value = 660;  // E5
  o2.frequency.value = 988;  // B5  — fifth above, dyad reads as "incident"
  o1.connect(gain);
  o2.connect(gain);
  o1.start(now);
  o1.stop(now + 0.45);
  o2.start(now + 0.45);
  o2.stop(now + 1.0);
  setTimeout(() => ctx.close().catch(() => undefined), 1200);
}

type StormReportRow = {
  id?: string;
  cluster_paged_at?: string | null;
};

export default function StormReportAudio() {
  const tickedRef = useRef<Set<string>>(new Set());
  const chimedRef = useRef<Set<string>>(new Set());
  const lastChimeAtRef = useRef<number>(0);
  const { mutate } = useSWRConfig();

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const supa = supabaseBrowser();
    const channel = supa
      .channel('storm-reports-live')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'telegram_storm_reports' },
        (payload) => {
          const row = payload.new as StormReportRow;
          // Trigger a refetch so new pins land on the map immediately.
          void mutate(STORM_REPORTS_KEY);
          if (!row?.id || tickedRef.current.has(row.id)) return;
          tickedRef.current.add(row.id);
          if (tickedRef.current.size > 200) {
            const first = tickedRef.current.values().next().value;
            if (first) tickedRef.current.delete(first);
          }
          playTick();
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'telegram_storm_reports' },
        (payload) => {
          const row = payload.new as StormReportRow;
          // Status changes, etc. — keep the map fresh either way.
          void mutate(STORM_REPORTS_KEY);
          void mutate(STORM_REPORT_CLUSTERS_KEY);
          if (!row?.id || !row.cluster_paged_at) return;
          if (chimedRef.current.has(row.id)) return;
          chimedRef.current.add(row.id);
          if (chimedRef.current.size > 200) {
            const first = chimedRef.current.values().next().value;
            if (first) chimedRef.current.delete(first);
          }
          // Multiple rows in the same cluster get stamped in one RPC; coalesce
          // to a single chime per ~3 s.
          const now = Date.now();
          if (now - lastChimeAtRef.current < 3000) return;
          lastChimeAtRef.current = now;
          playClusterChime();
        },
      )
      .subscribe();

    return () => {
      supa.removeChannel(channel);
    };
  }, [mutate]);

  return null;
}
