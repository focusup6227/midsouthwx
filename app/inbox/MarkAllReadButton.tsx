'use client';

import { useTransition } from 'react';
import { markAllConversationsRead } from './actions';
import { toast } from '@/components/toast';

export default function MarkAllReadButton({ unreadConvos }: { unreadConvos: number }) {
  const [pending, startTransition] = useTransition();
  if (unreadConvos === 0) return null;
  return (
    <button
      type="button"
      className="btn-ghost text-sm"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const res = await markAllConversationsRead();
          if ('error' in res) toast.error(res.error);
          else toast.success(`Marked ${res.cleared} conversation${res.cleared === 1 ? '' : 's'} read`);
        })
      }
    >
      {pending ? 'Clearing…' : `Mark all read (${unreadConvos})`}
    </button>
  );
}
