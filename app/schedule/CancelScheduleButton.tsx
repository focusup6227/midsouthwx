'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { cancelSchedule } from './actions';

export default function CancelScheduleButton({ id }: { id: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <button
      type="button"
      className="btn-ghost text-sm text-wx-danger"
      disabled={pending}
      onClick={() => {
        if (!confirm('Cancel this schedule? It will not fire again.')) return;
        startTransition(async () => {
          await cancelSchedule(id);
          router.refresh();
        });
      }}
    >
      {pending ? '…' : 'Cancel'}
    </button>
  );
}
