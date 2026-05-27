// Minimal copy of the shared service-client + json + withHealthLog helper.
// Mirrors supabase/functions/nws-dispatcher/supabase.ts so the deploy bundle
// is self-contained (Edge Function uploads don't follow parent imports).

import { createClient } from 'jsr:@supabase/supabase-js@2';

export function serviceClient() {
  const url = Deno.env.get('SUPABASE_URL')!;
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST,OPTIONS',
      'access-control-allow-headers': 'content-type,authorization,apikey',
    },
  });

export function withHealthLog<F extends (req: Request) => Promise<Response>>(
  name: string,
  handler: F,
): F {
  return (async (req: Request) => {
    const start = performance.now();
    let ok = true;
    let result: unknown = null;
    let errorMsg: string | null = null;
    let response: Response | null = null;
    try {
      response = await handler(req);
      try {
        const body = await response.clone().json();
        if (body && typeof body.ok === 'boolean') ok = body.ok;
        const s = JSON.stringify(body);
        result = s.length > 1000 ? { _truncated: true, _len: s.length, _preview: s.slice(0, 400) } : body;
      } catch {/* non-JSON body, leave defaults */}
      return response;
    } catch (e) {
      ok = false;
      errorMsg = e instanceof Error ? e.message : String(e);
      throw e;
    } finally {
      const duration_ms = Math.round(performance.now() - start);
      const url = Deno.env.get('SUPABASE_URL');
      const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
      if (url && key) {
        await fetch(`${url}/rest/v1/rpc/log_function_run`, {
          method: 'POST',
          headers: {
            apikey: key,
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            p_name: name,
            p_ok: ok,
            p_duration_ms: duration_ms,
            p_result: result,
            p_error: errorMsg,
          }),
        }).catch(() => {/* swallow */});
      }
    }
  }) as F;
}
