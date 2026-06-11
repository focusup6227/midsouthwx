// Shim for Supabase Edge Runtime's EdgeRuntime.waitUntil. In a long-lived
// worker process there is no request lifetime to extend — "keep this promise
// alive past the response" reduces to fire-and-forget with error logging.
export const EdgeRuntime = {
  waitUntil(p: Promise<unknown>): void {
    void p.catch((e) => console.error('[background]', e));
  },
};
