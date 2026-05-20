import DashShell from '@/components/DashShell';
import RegionForm from '../RegionForm';

export const dynamic = 'force-dynamic';

export default function NewRegionPage() {
  return (
    <DashShell title="New region" backHref="/regions" width="narrow">
      <RegionForm />
    </DashShell>
  );
}
