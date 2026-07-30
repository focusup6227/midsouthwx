'use client';

import { useRef, useState, useTransition, type ReactNode } from 'react';
import { toast } from './toast';

export type ActionResult = { ok?: boolean; error?: string } | void;

type Props = {
  action: (formData: FormData) => Promise<ActionResult>;
  /** Toast shown when the action resolves without an error. */
  successMessage?: string;
  /** window.confirm text; submit aborts if the operator cancels. */
  confirmMessage?: string;
  /** Clear the form after a successful submit (for "create" forms). */
  resetOnSuccess?: boolean;
  className?: string;
  children: ReactNode;
};

/**
 * Form wrapper for server actions that return { ok } | { error }. Disables
 * inputs while pending, shows the error inline AND as a toast, and toasts on
 * success — replaces the fire-and-forget <form action={...}> pattern that
 * swallowed failures.
 */
export default function ActionForm({
  action,
  successMessage,
  confirmMessage,
  resetOnSuccess = false,
  className,
  children,
}: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <form
      ref={formRef}
      className={className}
      onSubmit={(e) => {
        e.preventDefault();
        if (confirmMessage && !window.confirm(confirmMessage)) return;
        const fd = new FormData(e.currentTarget);
        setError(null);
        startTransition(async () => {
          const res = await action(fd);
          if (res && 'error' in res && res.error) {
            setError(res.error);
            toast.error(res.error);
          } else {
            if (successMessage) toast.success(successMessage);
            if (resetOnSuccess) formRef.current?.reset();
          }
        });
      }}
    >
      <fieldset disabled={pending} className="contents">
        {children}
      </fieldset>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-wx-danger sm:col-span-2">
          {error}
        </p>
      ) : null}
    </form>
  );
}
