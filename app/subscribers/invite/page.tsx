import DashShell from '@/components/DashShell';
import InviteSubscriberForm from './InviteSubscriberForm';

export const dynamic = 'force-dynamic';

export default function InviteSubscriberPage() {
  return (
    <DashShell title="Invite subscriber" backHref="/subscribers" width="narrow">
      <p className="text-sm text-wx-mute">
        Pre-create a subscriber and email them a Telegram activation link. They
        stay <strong>pending</strong> until they tap Start in Telegram, which links
        their chat and flips them to <strong>active</strong>.
      </p>

      <InviteSubscriberForm />
    </DashShell>
  );
}
