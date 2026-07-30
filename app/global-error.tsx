'use client';

// Last-resort error boundary: a crashed dashboard during an event must offer
// a one-tap recovery, not a white screen. Also reports the error so /health
// shows it later.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  try {
    void fetch('/api/client-errors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `render crash: ${error.message}${error.digest ? ` (${error.digest})` : ''}`,
        stack: error.stack,
        url: typeof window !== 'undefined' ? window.location.pathname : null,
      }),
      keepalive: true,
    });
  } catch {
    /* never block the recovery UI */
  }
  return (
    <html lang="en">
      <body style={{ background: '#0b1220', color: '#e5e7eb', fontFamily: 'system-ui, sans-serif' }}>
        <div style={{ maxWidth: 420, margin: '20vh auto', padding: 24, textAlign: 'center' }}>
          <h1 style={{ fontSize: 20, fontWeight: 700 }}>Something broke</h1>
          <p style={{ color: '#64748b', fontSize: 14, margin: '12px 0 20px' }}>
            The error was logged. Reload to keep working — if this repeats, check /health for the stack.
          </p>
          <button
            onClick={() => reset()}
            style={{
              background: '#fbbf24', color: '#111', border: 0, borderRadius: 8,
              padding: '10px 20px', fontWeight: 600, cursor: 'pointer', marginRight: 8,
            }}
          >
            Try again
          </button>
          <button
            onClick={() => window.location.assign('/dashboard')}
            style={{
              background: 'transparent', color: '#e5e7eb', border: '1px solid #1f2937',
              borderRadius: 8, padding: '10px 20px', fontWeight: 600, cursor: 'pointer',
            }}
          >
            Dashboard
          </button>
        </div>
      </body>
    </html>
  );
}
