'use client';

import { useState, useTransition } from 'react';
import { addLogEntry } from './actions';

// F14: textarea + tag chips + severity radio + optional geographic point.
// Keep keyboard-first: Cmd/Ctrl+Enter submits so an operator typing during
// a moving event can flush an entry without reaching for the mouse.

const SEVERITIES = ['info', 'warning', 'critical'] as const;
type Severity = (typeof SEVERITIES)[number];

export default function LogAddForm() {
  const [body, setBody] = useState('');
  const [tagInput, setTagInput] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [severity, setSeverity] = useState<Severity>('info');
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function commitTag() {
    const t = tagInput.trim().toLowerCase();
    if (!t) return;
    setTags((prev) => (prev.includes(t) ? prev : [...prev, t].slice(0, 12)));
    setTagInput('');
  }

  function submit() {
    setError(null);
    const text = body.trim();
    if (!text) {
      setError('Body required.');
      return;
    }
    startTransition(async () => {
      const res = await addLogEntry({ body: text, tags, severity });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setBody('');
      setTags([]);
      setSeverity('info');
    });
  }

  return (
    <div className="space-y-2">
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            submit();
          }
        }}
        placeholder="What just happened? (Cmd/Ctrl+Enter to submit)"
        rows={3}
        className="w-full px-3 py-2 rounded border border-wx-line bg-wx-ink text-sm font-mono resize-none"
      />

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5 flex-1 min-w-[200px]">
          <input
            type="text"
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                commitTag();
              } else if (e.key === 'Backspace' && !tagInput && tags.length > 0) {
                setTags((prev) => prev.slice(0, -1));
              }
            }}
            placeholder="add tag…"
            className="px-2 py-1 rounded border border-wx-line bg-wx-ink text-xs w-32"
          />
          {tags.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTags((prev) => prev.filter((x) => x !== t))}
              className="px-2 py-0.5 rounded-full text-[11px] border border-wx-accent text-wx-accent bg-wx-accent/10 hover:bg-wx-accent/20"
              title="Click to remove"
            >
              #{t} ×
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1 text-[10px]">
          {SEVERITIES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSeverity(s)}
              className={`px-2 py-1 rounded border font-mono uppercase tracking-wider ${
                severity === s
                  ? s === 'critical'
                    ? 'border-red-400/70 bg-red-500/20 text-red-200'
                    : s === 'warning'
                    ? 'border-amber-400/70 bg-amber-500/20 text-amber-200'
                    : 'border-wx-accent bg-wx-accent/10 text-wx-accent'
                  : 'border-wx-line text-wx-mute hover:text-wx-fg'
              }`}
            >
              {s}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={submit}
          disabled={pending || !body.trim()}
          className="px-3 py-1.5 rounded bg-wx-accent text-black text-xs font-semibold disabled:opacity-50 hover:bg-wx-accent/90"
        >
          {pending ? 'Saving…' : 'Add entry'}
        </button>
      </div>

      {error ? (
        <div className="text-[11px] text-red-300">{error}</div>
      ) : null}
    </div>
  );
}
