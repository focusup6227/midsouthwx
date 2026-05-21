import DashShell from '@/components/DashShell';
import RadarView from './RadarView';

export const dynamic = 'force-dynamic';

export default function RadarPage() {
  return (
    <DashShell width="full" bare>
      <RadarView />
    </DashShell>
  );
}
