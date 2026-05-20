import { supabaseAdmin } from '@/lib/supabase/server'; // or server action context

type NotifyPayload = {
  message_id: string;
  body: string;
  audience_count: number;
  severity?: string;
  source: string;
};

export async function notifyExternalEndpoints(payload: NotifyPayload) {
  // In a real impl, fetch enabled endpoints from DB, sign with secret, POST, log to external_delivery_logs
  // For now this is a stub that can be called from sendNow or nws-dispatcher after enqueue.
  console.log('[external-notify] stub', payload);
  // Example: await fetch(endpoint.url, { method: 'POST', body: JSON.stringify({...}), headers: { 'X-Signature': hmac } })
}
