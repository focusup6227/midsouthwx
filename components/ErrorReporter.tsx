'use client';

import { useEffect } from 'react';

// Global browser-error reporter. Ships uncaught errors + unhandled rejections
// to /api/client-errors, capped and deduped per pageload so a render loop
// can't flood the table.
const MAX_REPORTS_PER_LOAD = 5;

export default function ErrorReporter() {
  useEffect(() => {
    let sent = 0;
    const seen = new Set<string>();

    const report = (message: string, stack?: string) => {
      if (sent >= MAX_REPORTS_PER_LOAD) return;
      const key = message.slice(0, 120);
      if (seen.has(key)) return;
      seen.add(key);
      sent++;
      try {
        void fetch('/api/client-errors', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message, stack, url: window.location.pathname }),
          keepalive: true,
        });
      } catch {
        /* reporting must never throw */
      }
    };

    const onError = (e: ErrorEvent) => {
      report(e.message || 'unknown error', e.error?.stack);
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      const r = e.reason;
      report(
        r instanceof Error ? `unhandledrejection: ${r.message}` : `unhandledrejection: ${String(r).slice(0, 300)}`,
        r instanceof Error ? r.stack : undefined,
      );
    };

    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);

  return null;
}
