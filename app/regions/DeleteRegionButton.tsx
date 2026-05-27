'use client';

import { useTransition } from 'react';
import { deleteRegion } from './actions';

export default function DeleteRegionButton({
  id,
  name,
  subscriberCount,
  variant = 'inline',
}: {
  id: string;
  name: string;
  subscriberCount: number;
  variant?: 'inline' | 'button';
}) {
  const [pending, start] = useTransition();

  function onClick() {
    const warn =
      subscriberCount > 0
        ? `Delete region "${name}"? ${subscriberCount} subscriber match${
            subscriberCount === 1 ? '' : 'es'
          } will be unlinked.`
        : `Delete region "${name}"?`;
    if (!confirm(warn)) return;
    const fd = new FormData();
    fd.set('id', id);
    start(async () => {
      try {
        await deleteRegion(fd);
      } catch (e) {
        alert(e instanceof Error ? e.message : String(e));
      }
    });
  }

  if (variant === 'button') {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className="btn-ghost text-sm text-wx-danger border-wx-danger/40"
      >
        {pending ? 'Deleting…' : 'Delete region'}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      className="text-xs text-wx-danger underline disabled:opacity-50"
    >
      {pending ? 'Deleting…' : 'Delete'}
    </button>
  );
}
