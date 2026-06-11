// Single shared copy of the helper previously duplicated under every Edge
// Function's folder (Edge deploy bundles could only include files from the
// function's own directory — the worker has no such restriction).
import { createClient } from '@supabase/supabase-js';
import { env } from './env.ts';

export function serviceClient() {
  const url = env('SUPABASE_URL')!;
  const key = env('SUPABASE_SERVICE_ROLE_KEY')!;
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
