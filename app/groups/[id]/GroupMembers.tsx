'use client';

import { useMemo, useState, useTransition } from 'react';
import { addMember, removeMember } from '../actions';

type Member = { id: string; display_name: string; status: string; telegram_chat_id: number | null };

export default function GroupMembers({
  groupId,
  members,
  candidates,
}: {
  groupId: string;
  members: Member[];
  candidates: Member[];
}) {
  const [query, setQuery] = useState('');
  const [pending, startTransition] = useTransition();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return candidates.slice(0, 20);
    return candidates.filter((s) => s.display_name.toLowerCase().includes(q)).slice(0, 20);
  }, [candidates, query]);

  return (
    <>
      <section className="card p-5 space-y-3">
        <h2 className="font-semibold">Add member</h2>
        <input
          className="input"
          placeholder="Search subscribers…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query && filtered.length === 0 && (
          <p className="text-wx-mute text-sm">No matches.</p>
        )}
        {filtered.length > 0 && (
          <div className="space-y-1">
            {filtered.map((s) => (
              <div key={s.id} className="flex items-center justify-between gap-2 text-sm">
                <span>
                  {s.display_name}
                  <span className="text-wx-mute ml-2">{s.status}</span>
                  {!s.telegram_chat_id && <span className="text-wx-mute ml-2">(unlinked)</span>}
                </span>
                <button
                  className="btn-ghost text-sm"
                  disabled={pending}
                  onClick={() => startTransition(() => addMember(groupId, s.id))}
                >
                  Add
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="card p-5 space-y-3">
        <h2 className="font-semibold">Members ({members.length})</h2>
        {members.length === 0 ? (
          <p className="text-wx-mute text-sm">No members yet.</p>
        ) : (
          <div className="space-y-1">
            {members.map((m) => (
              <div key={m.id} className="flex items-center justify-between gap-2 text-sm">
                <span>
                  {m.display_name}
                  <span className="text-wx-mute ml-2">{m.status}</span>
                  {!m.telegram_chat_id && <span className="text-wx-mute ml-2">(unlinked)</span>}
                </span>
                <button
                  className="btn-ghost text-sm"
                  disabled={pending}
                  onClick={() => startTransition(() => removeMember(groupId, m.id))}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
