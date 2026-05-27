'use client';

import { useEffect, useRef } from 'react';
import { supabaseBrowser } from '@/lib/supabase/client';
import { classifyAlertSeverity } from '@/lib/nws/display';

// Mounted once in DashShell. Listens to nws_alerts INSERT/UPDATE via
// Realtime and, when a Particularly Dangerous Situation or Tornado
// Emergency lands, plays a synthesized two-tone alert via WebAudio AND
// posts a system Notification (browser permission willing) so the
// operator gets paged even when the tab is backgrounded.
//
// Deduped by alert ID via a ref-held Set so a single PDS update doesn't
// fire on every Realtime UPDATE event (NWS often republishes the same
// alert several times as VTEC parameters refresh).
//
// Operator opt-in: a one-time button on the dashboard requests browser
// Notification permission. Without permission we still play the WebAudio
// tone, which is the more important channel for an operator watching the
// screen anyway.

const STORAGE_KEY = 'midsouthwx:audio-armed';

function playAlertTone(): Promise<void> {
  return new Promise<void>((resolve) => {
    try {
      // Lazy-construct so we honor the "user gesture before AudioContext"
      // browser rule — the operator's first dashboard interaction is enough
      // to unlock it. If the context is still suspended, resume() the start.
      const AudioCtx =
        typeof window !== 'undefined'
          ? (window.AudioContext ||
              (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
          : null;
      if (!AudioCtx) { resolve(); return; }
      const ctx = new AudioCtx();
      if (ctx.state === 'suspended') void ctx.resume();

      const now = ctx.currentTime;
      // Two-tone EAS-style sweep: 853 Hz then 960 Hz, ~0.7s each. Loud but
      // bounded — gain capped at 0.35 so it won't blow out laptop speakers.
      const toneOne = ctx.createOscillator();
      const toneTwo = ctx.createOscillator();
      const gain = ctx.createGain();
      toneOne.type = 'sine';
      toneTwo.type = 'sine';
      toneOne.frequency.value = 853;
      toneTwo.frequency.value = 960;
      toneOne.connect(gain);
      toneTwo.connect(gain);
      gain.connect(ctx.destination);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.35, now + 0.05);
      gain.gain.setValueAtTime(0.35, now + 1.4);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.5);
      toneOne.start(now);
      toneOne.stop(now + 0.7);
      toneTwo.start(now + 0.7);
      toneTwo.stop(now + 1.4);
      // Best-effort cleanup so the context doesn't leak across the session.
      setTimeout(() => {
        ctx.close().catch(() => undefined);
        resolve();
      }, 1600);
    } catch {
      // Audio is best-effort; the visual badge + Notification API still fire.
      resolve();
    }
  });
}

/** Speak the alert classification using the Web Speech API so an operator
 *  can identify the threat without looking at the screen. Fires right after
 *  the EAS-style tone finishes so they don't fight for the audio bus. */
function speakAlert(phrase: string) {
  try {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    // Cancel any in-flight utterance so a rapid second alert doesn't queue
    // up behind the first one — the freshest threat is the relevant one.
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(phrase);
    // Slightly slower + slightly louder than defaults: the words need to be
    // intelligible across a room, not blend with the ambient.
    utter.rate = 0.95;
    utter.pitch = 1.0;
    utter.volume = 1.0;
    // Repeat the phrase once for redundancy. Single utterance is easy to
    // miss if the operator is mid-conversation when it fires.
    utter.onend = () => {
      try {
        const repeat = new SpeechSynthesisUtterance(phrase);
        repeat.rate = 0.95;
        repeat.pitch = 1.0;
        repeat.volume = 1.0;
        window.speechSynthesis.speak(repeat);
      } catch {
        // ignore
      }
    };
    window.speechSynthesis.speak(utter);
  } catch {
    // Speech is best-effort; the tone + visual badge + Notification still fire.
  }
}

function postNotification(title: string, body: string) {
  try {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    const n = new Notification(title, {
      body,
      tag: 'midsouthwx-pds',
      // Replace any prior PDS notification with this latest one — operators
      // shouldn't accumulate a stack of stale popups during an outbreak.
      renotify: true,
      requireInteraction: true,
    } as NotificationOptions);
    // Auto-dismiss after 30s in case the operator doesn't click; the
    // requireInteraction flag keeps it sticky until then on Chrome.
    setTimeout(() => n.close(), 30_000);
  } catch {
    // Permission revoked mid-session or unsupported browser; ignore.
  }
}

type AlertRow = {
  id: string;
  event: string | null;
  area_desc: string | null;
  raw: unknown;
};

export default function SevereAlertAudio() {
  const firedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (typeof window === 'undefined') return;
    // Audio is armed only after the operator clicks somewhere (any click)
    // because most browsers refuse AudioContext.start() before a user
    // gesture. We don't need to know *which* click — just that the page
    // has had one. Persist across reload so the operator isn't pestered.
    const armed = () => sessionStorage.setItem(STORAGE_KEY, '1');
    window.addEventListener('click', armed, { once: true });

    const supa = supabaseBrowser();
    const channel = supa
      .channel('severe-alert-audio')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'nws_alerts' },
        (payload) => maybeFire(payload.new as AlertRow),
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'nws_alerts' },
        (payload) => maybeFire(payload.new as AlertRow),
      )
      .subscribe();

    function maybeFire(row: AlertRow | null) {
      if (!row?.id) return;
      const flags = classifyAlertSeverity(row.raw, row.event);
      if (!flags.any) return;
      if (firedRef.current.has(row.id)) return;
      firedRef.current.add(row.id);
      // Cap the dedup set so a long-lived session doesn't grow it without
      // bound. 200 fits any plausible event sequence.
      if (firedRef.current.size > 200) {
        const first = firedRef.current.values().next().value;
        if (first) firedRef.current.delete(first);
      }
      const title = flags.isTornadoEmergency
        ? 'TORNADO EMERGENCY'
        : 'Particularly Dangerous Situation';
      const body = [row.event, row.area_desc].filter(Boolean).join(' · ');
      // Spoken phrase: short, unambiguous, no NWS jargon. "New Tornado
      // Emergency" for the absolute worst class, "New PDS warning" for
      // Particularly Dangerous Situation (operator-requested phrasing).
      const phrase = flags.isTornadoEmergency
        ? 'New Tornado Emergency'
        : 'New PDS warning';
      // Run the tone first, then speak when it finishes — TTS and the
      // oscillator share the audio output on most platforms, so chaining
      // makes both intelligible.
      void playAlertTone().then(() => speakAlert(phrase));
      postNotification(title, body || 'New high-severity NWS alert ingested.');
    }

    return () => {
      window.removeEventListener('click', armed);
      supa.removeChannel(channel);
    };
  }, []);

  return null;
}
