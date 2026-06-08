import Link from 'next/link';
import DashShell from '@/components/DashShell';
import BroadcastConsole from './BroadcastConsole';

export const dynamic = 'force-dynamic';

export default function BroadcastPage() {
  return (
    <DashShell
      title="Broadcast"
      width="wide"
      actions={
        <div className="flex gap-2">
          <Link href="/broadcast/teleprompter" target="_blank" className="btn-ghost text-sm">Teleprompter</Link>
          <Link href="/briefing" className="btn-ghost text-sm">Briefing</Link>
          <Link href="/radar" className="btn-ghost text-sm">Radar</Link>
        </div>
      }
    >
      <p className="text-wx-mute text-sm">
        Tools for putting together a weather video — for OBS live streams or pre-recorded uploads.
        Draft a spoken script and YouTube package from the live data, grab OBS overlay browser
        sources, run the teleprompter, and pull a thumbnail. Everything stays a draft you review
        before you go on air.
      </p>
      <BroadcastConsole />
    </DashShell>
  );
}
