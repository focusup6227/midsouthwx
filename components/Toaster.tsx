'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, AlertTriangle, Info, X } from 'lucide-react';
import { subscribeToasts, dismissToast, type Toast } from './toast';

const STYLES: Record<Toast['kind'], { border: string; icon: JSX.Element }> = {
  success: { border: 'border-wx-ok/60', icon: <CheckCircle2 size={16} className="shrink-0 text-wx-ok" /> },
  error: { border: 'border-wx-danger/60', icon: <AlertTriangle size={16} className="shrink-0 text-wx-danger" /> },
  info: { border: 'border-wx-accent/60', icon: <Info size={16} className="shrink-0 text-wx-accent" /> },
};

/** Global toast stack. Mounted once in DashShell; fire via toast.success/error/info. */
export default function Toaster() {
  const [items, setItems] = useState<Toast[]>([]);
  useEffect(() => subscribeToasts(setItems), []);

  if (items.length === 0) return null;
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-3 bottom-3 z-[90] flex flex-col items-center gap-2 sm:inset-x-auto sm:right-4 sm:bottom-4 sm:items-end"
    >
      {items.map((t) => {
        const s = STYLES[t.kind];
        return (
          <div
            key={t.id}
            role="status"
            className={`pointer-events-auto flex w-full max-w-sm items-start gap-2 rounded-lg border ${s.border} bg-wx-card px-3 py-2.5 text-sm text-wx-fg shadow-2xl`}
          >
            {s.icon}
            <span className="min-w-0 flex-1 break-words">{t.message}</span>
            <button
              type="button"
              onClick={() => dismissToast(t.id)}
              aria-label="Dismiss"
              className="shrink-0 text-wx-mute hover:text-wx-fg"
            >
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
