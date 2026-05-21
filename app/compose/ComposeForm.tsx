'use client';

import { useState, useTransition, useEffect, useMemo } from 'react';
import { previewAudience, sendAndRedirect, draftWithAI, type AudienceSpecT, type DraftTone } from './actions';
import { templateHasVariables, TEMPLATE_VARIABLES } from '@/lib/templates/fill';

type Template = {
  id: string;
  name: string;
  category: string | null;
  body_md: string;
  default_quick_replies: { label: string; data: string }[] | null;
};
type Named = { id: string; name: string };
type Sub = { id: string; display_name: string; telegram_chat_id: number | null };

type Kind = 'all' | 'regions' | 'groups' | 'subscribers' | 'geometry';

export default function ComposeForm({
  templates,
  groups,
  regions,
  subscribers,
  initialGeometry,
}: {
  templates: Template[];
  groups: Named[];
  regions: (Named & { kind: string })[];
  subscribers: Sub[];
  initialGeometry?: any;
}) {
  const [templateId, setTemplateId] = useState<string>('');
  const [body, setBody] = useState('');
  const [kind, setKind] = useState<Kind>('all');
  const [ids, setIds] = useState<Set<string>>(new Set());
  const [quickReplies, setQuickReplies] = useState<{ label: string; data: string }[]>([]);
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [geometry, setGeometry] = useState<any>(initialGeometry ?? null);
  const [aiTone, setAiTone] = useState<DraftTone>('urgent-calm');
  const [aiPending, setAiPending] = useState(false);
  const [templateVars, setTemplateVars] = useState<Record<string, string>>({
    headline: '',
    event: '',
    area_desc: '',
    expires_at: '',
  });

  const showTemplateVars = useMemo(() => templateHasVariables(body), [body]);

  useEffect(() => {
    if (initialGeometry) {
      setKind('geometry');
      setGeometry(initialGeometry);
    }
  }, [initialGeometry]);

  const applyTemplate = (id: string) => {
    setTemplateId(id);
    if (!id) return;
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    setBody(t.body_md);
    setQuickReplies(t.default_quick_replies ?? []);
  };

  const onAIDraft = (sourceText?: string) => {
    const text = sourceText || body || 'Recent NWS alert or situation summary';
    setAiPending(true);
    setError(null);
    startTransition(async () => {
      try {
        const res = await draftWithAI({ context: 'raw', tone: aiTone, sourceText: text });
        setBody(res.body_md);
        if (res.quick_replies) setQuickReplies(res.quick_replies);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'AI draft failed');
      } finally {
        setAiPending(false);
      }
    });
  };

  const buildSpec = (): AudienceSpecT => {
    if (kind === 'all') return { all: true };
    if (kind === 'groups') return { groups: [...ids] };
    if (kind === 'regions') return { regions: [...ids] };
    if (kind === 'geometry' && geometry) return { geometry };
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
    if (kind !== 'all' && kind !== 'geometry' && ids.size === 0) {
      setError('Select at least one ' + kind.slice(0, -1));
      return;
    }
    if (kind === 'geometry' && !geometry) {
      setError('No area selected from radar');
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
          template_vars: showTemplateVars ? templateVars : undefined,
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
        <div className="flex items-center justify-between">
          <label className="block text-xs uppercase tracking-wide text-wx-mute">Body</label>
          <div className="flex items-center gap-2">
            <select
              className="input text-xs py-0.5"
              value={aiTone}
              onChange={(e) => setAiTone(e.target.value as DraftTone)}
            >
              <option value="urgent-calm">Urgent but calm</option>
              <option value="technical">Technical</option>
              <option value="brief">Brief</option>
            </select>
            <button
              type="button"
              className="btn-ghost text-xs"
              onClick={() => onAIDraft()}
              disabled={aiPending || pending}
            >
              {aiPending ? 'Drafting…' : 'AI Draft'}
            </button>
          </div>
        </div>
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
        {showTemplateVars ? (
          <div className="grid gap-2 sm:grid-cols-2 pt-2 border-t border-wx-line">
            <p className="sm:col-span-2 text-xs text-wx-mute">Template variables</p>
            {TEMPLATE_VARIABLES.map((v) => (
              <label key={v.key} className="block text-xs">
                <span className="text-wx-mute">{v.label} ({'{{' + v.key + '}}'})</span>
                <input
                  className="input mt-1"
                  value={templateVars[v.key] ?? ''}
                  placeholder={v.placeholder}
                  onChange={(e) =>
                    setTemplateVars((prev) => ({ ...prev, [v.key]: e.target.value }))
                  }
                />
              </label>
            ))}
          </div>
        ) : null}
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
          {(['all', 'groups', 'regions', 'subscribers', 'geometry'] as Kind[]).map((k) => (
            <label key={k} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                checked={kind === k}
                onChange={() => {
                  setKind(k);
                  setIds(new Set());
                  setPreviewCount(null);
                  if (k !== 'geometry') setGeometry(null);
                }}
              />
              {k === 'all' ? 'All active' : k === 'geometry' ? 'Radar area' : k[0].toUpperCase() + k.slice(1)}
            </label>
          ))}
        </div>

        {kind === 'geometry' && geometry && (
          <div className="text-xs bg-blue-50 border border-blue-200 rounded p-2 text-blue-700">
            Targeting area selected on the radar map. Users inside the circle/polygon will receive this alert.
          </div>
        )}

        {kind !== 'all' && kind !== 'geometry' && (
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
