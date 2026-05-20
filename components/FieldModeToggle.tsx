'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';

export default function FieldModeToggle({ active }: { active: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function toggle() {
    if (active) {
      document.cookie = 'field-mode=; Path=/; Max-Age=0; SameSite=Lax';
    } else {
      document.cookie = `field-mode=1; Path=/; Max-Age=${60 * 60 * 24 * 365}; SameSite=Lax`;
    }
    startTransition(() => router.refresh());
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={pending}
      aria-pressed={active}
      className={
        'text-xs px-2.5 py-1 rounded border ' +
        (active
          ? 'bg-wx-accent text-black border-wx-accent'
          : 'border-wx-line text-wx-mute hover:text-wx-fg')
      }
      title={active ? 'Field mode on — tap to exit' : 'Field mode off — tap to enter'}
    >
      {active ? 'Field mode: on' : 'Field mode'}
    </button>
  );
}
