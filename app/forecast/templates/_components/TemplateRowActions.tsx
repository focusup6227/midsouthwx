'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import {
  deleteForecastTemplate,
  fireForecastTemplateNow,
  setForecastTemplateEnabled,
} from '../actions';

export default function TemplateRowActions({
  id,
  enabled,
}: { id: string; enabled: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const run = (fn: () => Promise<unknown>) => () => {
    startTransition(async () => {
      try {
        await fn();
        router.refresh();
      } catch (e) {
        alert(e instanceof Error ? e.message : 'failed');
      }
    });
  };

  return (
    <div className="flex gap-2 shrink-0">
      <button
        type="button"
        className="btn-ghost text-xs"
        disabled={pending}
        onClick={run(() => setForecastTemplateEnabled(id, !enabled))}
      >
        {pending ? '…' : enabled ? 'Pause' : 'Resume'}
      </button>
      <button
        type="button"
        className="btn-ghost text-xs text-sky-300"
        disabled={pending}
        onClick={run(async () => {
          const { forecast_id } = await fireForecastTemplateNow(id);
          router.push(`/forecast/${forecast_id}`);
        })}
      >
        {pending ? '…' : 'Fire now'}
      </button>
      <button
        type="button"
        className="btn-ghost text-xs text-wx-danger"
        disabled={pending}
        onClick={() => {
          if (!confirm('Delete this template? In-flight draft forecasts are not affected.')) return;
          run(() => deleteForecastTemplate(id))();
        }}
      >
        Delete
      </button>
    </div>
  );
}
