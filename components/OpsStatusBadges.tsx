'use client';

import Link from 'next/link';
import useSWR from 'swr';
import { supabaseBrowser } from '@/lib/supabase/client';

// Global attention badges: NWS messages awaiting approval and unhandled
// distress replies. Rendered in the header on every page (and floating over
// the radar's compact layout) so the operator never has to be on /nws or
// /inbox to know something needs them. Renders nothing when both are zero —
// quiet days stay quiet.
//
// "Unhandled distress" = is_distress reply with no read_at; opening the
// thread marks it read, which clears the badge.

async function fetchOpsStatus() {
  const supa = supabaseBrowser();
  const [pending, distress] = await Promise.all([
    supa
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending_approval'),
    supa
      .from('replies')
      .select('id', { count: 'exact', head: true })
      .eq('is_distress', true)
      .is('read_at', null),
  ]);
  return {
    pendingNws: pending.count ?? 0,
    distress: distress.count ?? 0,
  };
}

export default function OpsStatusBadges({ floating = false }: { floating?: boolean }) {
  const { data } = useSWR('ops-status-badges', fetchOpsStatus, {
    refreshInterval: 30_000,
    revalidateOnFocus: true,
  });

  const pendingNws = data?.pendingNws ?? 0;
  const distress = data?.distress ?? 0;
  if (pendingNws === 0 && distress === 0) return null;

  const wrap = floating
    ? 'tallmd:hidden fixed top-3 right-[6.5rem] z-[60] flex items-center gap-1.5'
    : 'flex items-center gap-1.5';

  return (
    <div className={wrap}>
      {distress > 0 ? (
        <Link
          href="/inbox"
          className="inline-flex animate-pulse items-center gap-1 rounded-full bg-wx-danger px-2.5 py-1 text-[11px] font-bold text-white shadow-lg"
          title={`${distress} unhandled distress repl${distress === 1 ? 'y' : 'ies'} — open inbox`}
        >
          🆘 {distress}
        </Link>
      ) : null}
      {pendingNws > 0 ? (
        <Link
          href="/nws"
          className="inline-flex items-center gap-1 rounded-full border border-amber-500 bg-amber-500/20 px-2.5 py-1 text-[11px] font-bold text-amber-300 shadow-lg"
          title={`${pendingNws} NWS alert${pendingNws === 1 ? '' : 's'} awaiting approval`}
        >
          NWS {pendingNws}
        </Link>
      ) : null}
    </div>
  );
}
