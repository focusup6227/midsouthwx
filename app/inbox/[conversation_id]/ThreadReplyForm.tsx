'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { sendThreadReply } from './actions';

export default function ThreadReplyForm({
  conversationId,
  subscriberId,
  telegramLinked,
  subscriberStatus,
}: {
  conversationId: string;
  subscriberId: string;
  telegramLinked: boolean;
  subscriberStatus: string;
}) {
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const blocked =
    !telegramLinked ||
    subscriberStatus === 'unsubscribed' ||
    subscriberStatus === 'paused';

  let blockedHint: string | null = null;
  if (!telegramLinked) {
    blockedHint =
      'This subscriber has not completed Telegram /start. They must open the bot link from signup first.';
  } else if (subscriberStatus === 'unsubscribed') {
    blockedHint = 'Subscriber is unsubscribed.';
  } else if (subscriberStatus === 'paused') {
    blockedHint = 'Subscriber is paused — unpause on their profile before replying.';
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const text = body.trim();
    if (!text) return;

    startTransition(async () => {
      const res = await sendThreadReply(conversationId, text);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setBody('');
    });
  }

  return (
    <form onSubmit={onSubmit} className="card p-4 space-y-3">
      <label className="block text-sm font-medium" htmlFor="thread-reply">
        Reply
      </label>
      {blockedHint && (
        <p className="text-sm text-wx-mute">
          {blockedHint}{' '}
          <Link href={`/subscribers/${subscriberId}`} className="text-wx-accent underline">
            Subscriber profile
          </Link>
        </p>
      )}
      <textarea
        id="thread-reply"
        rows={3}
        className="input w-full resize-y min-h-[4.5rem]"
        placeholder={blocked ? 'Cannot send until Telegram is linked' : 'Type a message…'}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        disabled={pending || blocked}
        maxLength={4096}
      />
      {error && (
        <p className="text-sm text-wx-danger" role="alert">
          {error}
        </p>
      )}
      <div className="flex justify-end">
        <button type="submit" className="btn" disabled={pending || blocked || !body.trim()}>
          {pending ? 'Sending…' : 'Send'}
        </button>
      </div>
    </form>
  );
}
