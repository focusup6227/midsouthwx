'use client';

import { useState, useTransition } from 'react';
import { setPassword } from './actions';

export default function PasswordForm() {
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    if (pw !== pw2) {
      setMsg({ type: 'err', text: 'Passwords do not match' });
      return;
    }
    const fd = new FormData();
    fd.append('password', pw);
    startTransition(async () => {
      const res = await setPassword(fd);
      if ('error' in res) {
        setMsg({ type: 'err', text: res.error });
      } else {
        setMsg({ type: 'ok', text: 'Password updated' });
        setPw('');
        setPw2('');
      }
    });
  };

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <label className="block">
        <span className="block text-xs uppercase tracking-wide text-wx-mute mb-1">New password</span>
        <input
          className="input"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
          value={pw}
          onChange={(e) => setPw(e.target.value)}
        />
      </label>
      <label className="block">
        <span className="block text-xs uppercase tracking-wide text-wx-mute mb-1">Confirm</span>
        <input
          className="input"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
          value={pw2}
          onChange={(e) => setPw2(e.target.value)}
        />
      </label>
      {msg && (
        <p className={msg.type === 'ok' ? 'text-wx-ok text-sm' : 'text-wx-danger text-sm'}>
          {msg.text}
        </p>
      )}
      <div className="flex justify-end">
        <button className="btn" type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Set password'}
        </button>
      </div>
    </form>
  );
}
