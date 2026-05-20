'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { inviteOperatorAction } from './invite-actions';
import type { InviteOperatorState } from './invite-state';

const initial: InviteOperatorState = { ok: false, error: null };

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn" disabled={pending}>
      {pending ? 'Sending…' : 'Send invite'}
    </button>
  );
}

export default function InviteOperatorForm() {
  const [state, formAction] = useFormState(inviteOperatorAction, initial);

  return (
    <form action={formAction} className="space-y-3">
      <div className="flex flex-col sm:flex-row gap-3 sm:items-end">
        <label className="block flex-1 text-sm">
          <span className="text-wx-mute">Email</span>
          <input
            name="email"
            type="email"
            required
            autoComplete="email"
            placeholder="colleague@example.com"
            className="mt-1 w-full input"
          />
        </label>
        <SubmitButton />
      </div>
      {state.ok ? (
        <p className="text-sm text-wx-ok">Invite sent. They will receive an email with a link to join.</p>
      ) : null}
      {state.error ? <p className="text-sm text-wx-danger">{state.error}</p> : null}
    </form>
  );
}
