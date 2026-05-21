'use client';

import { useState, useTransition } from 'react';
import { runNwsDispatcher, runNwsPoll } from './actions';

type ResultLine = { ts: string; label: string; msg: string; ok: boolean };

export default function RunButtons() {
  const [pending, startTransition] = useTransition();
  const [log, setLog] = useState<ResultLine[]>([]);

  function run(label: 'Poll' | 'Dispatch', fn: typeof runNwsPoll) {
    startTransition(async () => {
      const res = await fn();
      const ok = 'ok' in res;
      const msg = ok
        ? JSON.stringify(res.result)
        : res.error;
      setLog((prev) => [
        { ts: new Date().toLocaleTimeString(), label, msg, ok },
        ...prev,
      ].slice(0, 6));
    });
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn"
          disabled={pending}
          onClick={() => run('Poll', runNwsPoll)}
        >
          {pending ? 'Running…' : 'Poll NWS now'}
        </button>
        <button
          type="button"
          className="btn-ghost"
          disabled={pending}
          onClick={() => run('Dispatch', runNwsDispatcher)}
        >
          {pending ? 'Running…' : 'Run dispatcher now'}
        </button>
      </div>
      {log.length > 0 ? (
        <ul className="text-xs text-wx-mute space-y-1 font-mono">
          {log.map((l, i) => (
            <li
              key={i}
              className={l.ok ? 'text-wx-fg/80' : 'text-wx-danger'}
            >
              <span className="text-wx-mute">{l.ts}</span>{' '}
              <strong>{l.label}:</strong> {l.msg}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
