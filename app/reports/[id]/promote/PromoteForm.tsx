'use client';

import Link from 'next/link';
import { useState } from 'react';

const RADII = [10, 25, 50, 100];

export default function PromoteForm({
  id,
  defaultBody,
  action,
}: {
  id: string;
  defaultBody: string;
  action: (formData: FormData) => Promise<void>;
}) {
  const [radius, setRadius] = useState(25);
  const [body, setBody] = useState(defaultBody);
  const [pending, setPending] = useState(false);

  return (
    <form
      action={async (fd) => {
        setPending(true);
        try {
          await action(fd);
        } finally {
          setPending(false);
        }
      }}
      className="space-y-4"
    >
      <input type="hidden" name="id" value={id} />

      <div>
        <label className="text-xs uppercase tracking-wider text-wx-mute font-semibold block mb-1">
          Audience radius
        </label>
        <div className="flex flex-wrap gap-2">
          {RADII.map((km) => (
            <button
              type="button"
              key={km}
              onClick={() => setRadius(km)}
              className={
                'px-3 py-1 rounded-full text-xs border ' +
                (radius === km
                  ? 'bg-wx-accent/15 border-wx-accent text-wx-accent'
                  : 'border-wx-line text-wx-mute hover:text-wx-fg')
              }
            >
              {km} km
            </button>
          ))}
        </div>
        <input type="hidden" name="radius_km" value={radius} />
        <p className="text-[11px] text-wx-mute mt-1">
          Subscribers with a current pin inside this circle will receive the broadcast.
        </p>
      </div>

      <div>
        <label className="text-xs uppercase tracking-wider text-wx-mute font-semibold block mb-1">
          Message
        </label>
        <textarea
          name="body_md"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={8}
          required
          className="w-full bg-wx-card border border-wx-line rounded-md p-3 text-sm font-mono leading-snug"
        />
        <p className="text-[11px] text-wx-mute mt-1">
          {body.length} chars · sent as plain Telegram text (no Markdown).
        </p>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          className="btn"
          disabled={pending || !body.trim()}
        >
          {pending ? 'Sending…' : 'Send broadcast'}
        </button>
        <Link href="/reports" className="btn-ghost text-sm">Cancel</Link>
      </div>
    </form>
  );
}
