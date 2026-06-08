// Public, unauthenticated state feed for the OBS broadcast overlays. An OBS
// browser source is a headless Chromium with no operator session cookie, so
// this route (and /broadcast/overlay/*) are on the middleware public allowlist.
// It exposes ONLY public NWS products (active warning/watch headlines + counts
// + SPC Day-1 risk) read with the service role — never subscriber data.

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { gatherBroadcastState } from '@/lib/broadcast/data';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const client = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  try {
    const state = await gatherBroadcastState(client);
    const res = NextResponse.json(state);
    // Short edge cache; overlays poll ~30s and the underlying data updates on
    // the NWS poller's cadence, so a few seconds of staleness is fine.
    res.headers.set('Cache-Control', 'public, s-maxage=15, stale-while-revalidate=60');
    return res;
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'state error', items: [], warnings_count: 0, watches_count: 0, day1_label: null, generated_at: new Date().toISOString() },
      { status: 200 },
    );
  }
}
