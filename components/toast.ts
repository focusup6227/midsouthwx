'use client';

// Tiny global toast store — no context provider needed so server components
// (DashShell) can mount <Toaster /> once while any client component fires
// toasts via the exported helpers.

export type Toast = {
  id: number;
  kind: 'success' | 'error' | 'info';
  message: string;
};

type Listener = (toasts: Toast[]) => void;

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<Listener>();

function emit() {
  for (const l of listeners) l(toasts);
}

function push(kind: Toast['kind'], message: string, ttlMs: number) {
  const id = nextId++;
  toasts = [...toasts, { id, kind, message }];
  emit();
  window.setTimeout(() => dismissToast(id), ttlMs);
  return id;
}

export function dismissToast(id: number) {
  if (!toasts.some((t) => t.id === id)) return;
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

export const toast = {
  success: (message: string) => push('success', message, 4000),
  info: (message: string) => push('info', message, 4000),
  // Errors stick around longer — the operator may be mid-scroll.
  error: (message: string) => push('error', message, 8000),
};

export function subscribeToasts(listener: Listener): () => void {
  listeners.add(listener);
  listener(toasts);
  return () => {
    listeners.delete(listener);
  };
}
