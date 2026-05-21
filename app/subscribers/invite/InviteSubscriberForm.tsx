'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { useState } from 'react';
import Link from 'next/link';
import { inviteSubscriberAction } from './actions';
import { initialInviteState, type InviteSubscriberState } from './invite-state';

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn" disabled={pending}>
      {pending ? 'Inviting…' : 'Send invite'}
    </button>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn-ghost text-xs"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // clipboard may be unavailable on insecure origins; ignore.
        }
      }}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

function EmailBadge({ state }: { state: Extract<InviteSubscriberState, { kind: 'success' }> }) {
  if (state.emailStatus === 'sent') {
    return (
      <p className="text-sm text-wx-ok">
        ✓ Invite email sent to {state.email}.
      </p>
    );
  }
  if (state.emailStatus === 'unconfigured') {
    return (
      <div className="text-sm space-y-1">
        <p className="text-wx-mute">
          Email service not configured — copy the link below and send it yourself
          (text, email, in person, etc.).
        </p>
        <p className="text-xs text-wx-mute">
          To enable automatic email, set <code>RESEND_API_KEY</code> in your
          environment (get a free key at{' '}
          <a className="text-wx-accent" href="https://resend.com" target="_blank" rel="noreferrer">
            resend.com
          </a>
          ).
        </p>
      </div>
    );
  }
  return (
    <div className="text-sm space-y-1">
      <p className="text-wx-danger">
        Email send failed — copy the link below and deliver it manually.
      </p>
      {state.emailError ? (
        <p className="text-xs text-wx-mute font-mono break-all">{state.emailError}</p>
      ) : null}
    </div>
  );
}

export default function InviteSubscriberForm() {
  const [state, formAction] = useFormState(inviteSubscriberAction, initialInviteState);

  return (
    <div className="space-y-6">
      <form action={formAction} className="card p-5 space-y-4">
        <div className="grid sm:grid-cols-2 gap-4">
          <label className="block text-sm">
            <span className="text-wx-mute">Full name</span>
            <input
              name="display_name"
              required
              maxLength={120}
              autoComplete="name"
              className="mt-1 w-full input"
              placeholder="Pat Example"
            />
          </label>

          <label className="block text-sm">
            <span className="text-wx-mute">Email</span>
            <input
              name="email"
              type="email"
              required
              autoComplete="email"
              className="mt-1 w-full input"
              placeholder="pat@example.com"
            />
          </label>

          <label className="block text-sm">
            <span className="text-wx-mute">ZIP code</span>
            <input
              name="zip"
              required
              inputMode="numeric"
              pattern="\d{5}(-\d{4})?"
              className="mt-1 w-full input"
              placeholder="38103"
            />
          </label>

          <label className="block text-sm">
            <span className="text-wx-mute">Phone (optional)</span>
            <input
              name="phone"
              type="tel"
              autoComplete="tel"
              className="mt-1 w-full input"
              placeholder="901-555-1234"
            />
          </label>

          <label className="block text-sm sm:col-span-2">
            <span className="text-wx-mute">Home address (optional)</span>
            <textarea
              name="address"
              rows={2}
              className="mt-1 w-full input"
              placeholder="Street, city, state — only shown to the operator for safety checks"
            />
          </label>
        </div>

        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-wx-mute">
            Creates a pending subscriber with a 7-day Telegram activation link.
            They aren&apos;t active until they tap Start in Telegram.
          </p>
          <SubmitButton />
        </div>

        {state.kind === 'error' ? (
          <p className="text-sm text-wx-danger">{state.error}</p>
        ) : null}
      </form>

      {state.kind === 'success' ? (
        <section className="card p-5 space-y-4 border border-wx-ok/40">
          <div className="space-y-1">
            <h2 className="font-semibold">Invite created for {state.displayName}</h2>
            <p className="text-xs text-wx-mute">
              Expires {new Date(state.expiresAt).toLocaleString()} — about 7 days.
            </p>
          </div>

          <EmailBadge state={state} />

          <div className="space-y-2">
            <span className="text-xs uppercase tracking-wide text-wx-mute">
              Telegram activation link
            </span>
            <div className="flex items-stretch gap-2">
              <input
                readOnly
                value={state.deeplink}
                className="input flex-1 font-mono text-xs"
                onFocus={(e) => e.currentTarget.select()}
              />
              <CopyButton value={state.deeplink} />
            </div>
            <p className="text-xs text-wx-mute">
              Open Telegram and tap <strong>Start</strong> in the chat with our bot to activate.
            </p>
          </div>

          <div className="flex gap-2 pt-2 border-t border-wx-line">
            <Link href="/subscribers" className="btn-ghost text-sm">
              ← Back to subscribers
            </Link>
            <Link href="/subscribers/invite" className="btn-ghost text-sm">
              Invite another
            </Link>
          </div>
        </section>
      ) : null}
    </div>
  );
}
