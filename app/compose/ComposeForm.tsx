'use client';

import { useState, useTransition } from 'react';
import { previewAudience, sendAndRedirect, type AudienceSpecT } from './actions';

type Template = {
  id: string;
  name: string;
  category: string | null;
  body_md: string;
  default_quick_replies: { label: string; data: string }[] | null;
};
type Named = { id: string; name: string };
type Sub = { id: string; display_name: string; telegram_chat_id: number | null };

type Kind = 'all' | 'regions' | 'groups' | 'subscribers';

export default function ComposeForm({
  templates,
  groups,
  regions,
  subscribers,
}: {
  templates: Template[];
  groups: Named[];
  regions: (Named & { kind: string })[];
  subscribers: Sub[];
}) {
  const [templateId, setTemplateId] = useState<string>('');
  const [body, setBody] = useState('');
  const [kind, setKind] = useState<Kind>('all');
  const [ids, setIds] = useState<Set<string>>(new Set());
  const [quickReplies, setQuickReplies] = useState<{ label: string; data: string }[]>([]);
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const applyTemplate = (id: string) => {
    setTemplateId(id);
    if (!id) return;
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    setBody(t.body_md);
    setQuickReplies(t.default_quick_replies ?? []);
  };

  const buildSpec = (): AudienceSpecT => {
    if (kind === 'all') return { all: true };
    if (kind === 'groups') return { groups: [...ids] };
    if (kind === 'regions') return { regions: [...ids] };
    return { subscribers: [...ids] };
  };

  const toggleId = (id: string) => {
    const next = new Set(ids);
    next.has(id) ? next.delete(id) : next.add(id);
    setIds(next);
    setPreviewCount(null);
  };

  const onPreview = () => {
    setError(null);
    startTransition(async () => {
      try {
        const n = await previewAudience(buildSpec());
        setPreviewCount(n);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  };

  const onSend = () => {
    setError(null);
    if (!body.trim()) {
      setError('Body cannot be empty');
      return;
    }
    if (kind !== 'all' && ids.size === 0) {
      setError('Select at least one ' + kind.slice(0, -1));
      return;
    }
    const isCheckin = templates.find((t) => t.id === templateId)?.category === 'checkin';
    startTransition(async () => {
      try {
        await sendAndRedirect({
          body_md: body,
          audience_spec: buildSpec(),
          quick_replies: quickReplies,
          template_id: templateId || null,
          source: isCheckin ? 'checkin' : 'manual',
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  };

  const checkinTpl = templates.find((t) => t.category === 'checkin');
  const optionList: { id: string; label: string }[] =
    kind === 'groups'
      ? groups.map((g) => ({ id: g.id, label: g.name }))
      : kind === 'regions'
        ? regions.map((r) => ({ id: r.id, label: `${r.name} (${r.kind})` }))
        : kind === 'subscribers'
          ? subscribers.map((s) => ({
              id: s.id,
              label: `${s.display_name}${s.telegram_chat_id ? '' : ' (unlinked)'}`,
            }))
          : [];

  return (
    <div className="space-y-5">
      <section className="card p-5 space-y-3">
        <label className="block text-xs uppercase tracking-wide text-wx-mute">Template</label>
        <div className="flex gap-2 flex-wrap">
          <select
            className="input max-w-xs"
            value={templateId}
            onChange={(e) => applyTemplate(e.target.value)}
          >
            <option value="">— blank —</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          {checkinTpl ? (
            <button
              type="button"
              className="btn-ghost"
              onClick={() => applyTemplate(checkinTpl.id)}
            >
              Family check-in
            </button>
          ) : null}
        </div>
      </section>

      <section className="card p-5 space-y-3">
        <label className="block text-xs uppercase tracking-wide text-wx-mute">Body</label>
        <textarea
          className="input"
          rows={6}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Plain text or **markdown**…"
        />
        <p className="text-xs text-wx-mute">
          Supports **bold**, *italic*, `code`, and [links](https://example.com). Rendered as Telegram HTML.
        </p>
      </section>

      <section className="card p-5 space-y-3">
        <div className="flex items-center justify-between">
          <label className="text-xs uppercase tracking-wide text-wx-mute">Quick replies</label>
          <button
            type="button"
            className="btn-ghost text-sm"
            onClick={() => setQuickReplies([...quickReplies, { label: '', data: '' }])}
          >
            + Add
          </button>
        </div>
        {quickReplies.length === 0 ? (
          <p className="text-wx-mute text-sm">No quick replies. Subscribers can still reply with text.</p>
        ) : (
          <div className="space-y-2">
            {quickReplies.map((qr, i) => (
              <div key={i} className="flex gap-2">
                <input
                  className="input"
                  placeholder="Label (shown on button)"
                  value={qr.label}
                  onChange={(e) => {
                    const next = [...quickReplies];
                    next[i] = { ...next[i], label: e.target.value };
                    setQuickReplies(next);
                  }}
                />
                <input
                  className="input"
                  placeholder="Data (callback code)"
                  value={qr.data}
                  onChange={(e) => {
                    const next = [...quickReplies];
                    next[i] = { ...next[i], data: e.target.value };
                    setQuickReplies(next);
                  }}
                />
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => setQuickReplies(quickReplies.filter((_, j) => j !== i))}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="card p-5 space-y-3">
        <label className="block text-xs uppercase tracking-wide text-wx-mute">Audience</label>
        <div className="flex flex-wrap gap-3">
          {(['all', 'groups', 'regions', 'subscribers'] as Kind[]).map((k) => (
            <label key={k} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                checked={kind === k}
                onChange={() => {
                  setKind(k);
                  setIds(new Set());
                  setPreviewCount(null);
                }}
              />
              {k === 'all' ? 'All active' : k[0].toUpperCase() + k.slice(1)}
            </label>
          ))}
        </div>

        {kind !== 'all' && (
          <div className="max-h-56 overflow-auto border border-wx-line rounded-lg p-2 space-y-1">
            {optionList.length === 0 ? (
              <p className="text-wx-mute text-sm p-2">No {kind} yet.</p>
            ) : (
              optionList.map((o) => (
                <label key={o.id} className="flex items-center gap-2 text-sm p-1">
                  <input
                    type="checkbox"
                    checked={ids.has(o.id)}
                    onChange={() => toggleId(o.id)}
                  />
                  {o.label}
                </label>
              ))
            )}
          </div>
        )}

        <div className="flex items-center gap-3 pt-1">
          <button
            type="button"
            className="btn-ghost"
            onClick={onPreview}
            disabled={pending}
          >
            Preview audience
          </button>
          {previewCount !== null && (
            <span className="text-sm">
              <strong>{previewCount}</strong> recipient{previewCount === 1 ? '' : 's'}
            </span>
          )}
        </div>
      </section>

      {error && (
        <div className="card p-3 border-wx-danger text-wx-danger text-sm">{error}</div>
      )}

      <div className="flex justify-end gap-2">
        <button type="button" className="btn" onClick={onSend} disabled={pending}>
          {pending ? 'Sending…' : 'Send now'}
        </button>
      </div>
    </div>
  );
}
