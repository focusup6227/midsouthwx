import DashShell from '@/components/DashShell';
import BulkImportForm from './BulkImportForm';

export const dynamic = 'force-dynamic';

export default function BulkImportPage() {
  return (
    <DashShell title="Bulk import regions" backHref="/regions" width="normal">
      <p className="text-sm text-wx-mute">
        Idempotent — re-running updates existing rows (matched on{' '}
        <code className="text-xs">county_fips</code> or <code className="text-xs">ugc_code</code>).
        The <code className="text-xs">regions_after_change</code> trigger refreshes
        subscriber matching automatically.
      </p>
      <BulkImportForm />
    </DashShell>
  );
}
