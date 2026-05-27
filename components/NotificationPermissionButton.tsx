'use client';

import { useEffect, useState } from 'react';

// Tiny opt-in button that asks for Notification permission. Once granted
// the button hides itself. Denied users get a brief tooltip telling them
// how to re-enable. PDS / TorE alerts still play the WebAudio tone even
// without notification permission — this just gates the system popup.

type Perm = 'default' | 'granted' | 'denied' | 'unsupported';

function read(): Perm {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  return Notification.permission as Perm;
}

export default function NotificationPermissionButton() {
  const [perm, setPerm] = useState<Perm>('default');

  useEffect(() => {
    setPerm(read());
  }, []);

  if (perm === 'granted' || perm === 'unsupported') return null;

  if (perm === 'denied') {
    return (
      <span
        className="hidden rounded border border-wx-line px-2 py-1 text-[11px] text-wx-mute md:inline"
        title="Notifications were blocked. Re-enable in your browser settings to receive PDS / Tornado Emergency popups."
      >
        🔕 Alerts blocked
      </span>
    );
  }

  return (
    <button
      type="button"
      className="hidden rounded border border-wx-accent/60 bg-wx-accent/10 px-2 py-1 text-[11px] font-medium text-wx-accent hover:bg-wx-accent/20 md:inline"
      onClick={async () => {
        try {
          const result = await Notification.requestPermission();
          setPerm(result as Perm);
        } catch {
          // Permission flow varies by browser; just re-read whatever state we got.
          setPerm(read());
        }
      }}
    >
      🔔 Enable alerts
    </button>
  );
}
