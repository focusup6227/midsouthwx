'use client';

import { useMemo, useState, useTransition } from 'react';
import {
  previewAudienceSchedule,
  createScheduleAndRedirect,
  updateScheduleAndRedirect,
  type AudienceSpecT,
} from './actions';

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

function toDatetimeLocalValue(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function audienceKind(spec: AudienceSpecT): Kind {
  if (spec.all) return 'all';
  if (spec.groups?.length) return 'groups';
  if (spec.regions?.length) return 'regions';
  if (spec.subscribers?.length) return 'subscribers';
  return 'all';
}

function idsFromSpec(spec: AudienceSpecT, kind: Kind): Set<string> {
  if (kind === 'groups') return new Set(spec.groups ?? []);
  if (kind === 'regions') return new Set(spec.regions ?? []);
  if (kind === 'subscribers') return new Set(spec.subscribers ?? []);
  return new Set();
}

function recurrenceFromRrule(rrule: string | null): 'none' | 'weekly' {
  if (!rrule?.trim()) return 'none';
  return /FREQ=WEEKLY/i.test(rrule) ? 'weekly' : 'none';
}

export default function ScheduleForm({
  templates,
  groups,
  regions,
  subscribers,
  scheduleId,
  initial,
}: {
  templates: Template[];
  groups: Named[];
  regions: (Named & { kind: string })[];
  subscribers: Sub[];
  scheduleId?: string;
  initial?: {
    body_md: string;
    audience_spec: AudienceSpecT;
    template_id: string | null;
    scheduled_for: string;
    rrule: string | null;
  };
}) {
  const inferredKind = initial ? audienceKind(initial.audience_spec) : 'all';
  const [templateId, setTemplateId] = useState<string>(initial?.template_id ?? '');
  const [body, setBody] = useState(initial?.body_md ?? '');
  const [kind, setKind] = useState<Kind>(inferredKind);
  const [ids, setIds] = useState<Set<string>>(() =>
    initial ? idsFromSpec(initial.audience_spec, inferredKind) : new Set(),
  );
  const [scheduledLocal, setScheduledLocal] = useState(() =>
    initial ? toDatetimeLocalValue(initial.scheduled_for) : '',
  );
  const [recurrence, setRecurrence] = useState<'none' | 'weekly'>(() =>
    recurrenceFromRrule(initial?.rrule ?? null),
  );
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const applyTemplate = (id: string) => {
    setTemplateId(id);
    if (!id) return;
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    setBody(t.body_md);
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
        const n = await previewAudienceSchedule(buildSpec());
        setPreviewCount(n);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  };

  const onSubmit = () => {
    setError(null);
    if (!body.trim()) {
      setError('Body cannot be empty');
      return;
    }
    if (!scheduledLocal.trim()) {
      setError('Pick a date and time');
      return;
    }
    const scheduledIso = new Date(scheduledLocal).toISOString();
    if (Number.isNaN(Date.parse(scheduledIso))) {
      setError('Invalid date/time');
      return;
    }
    if (kind !== 'all' && ids.size === 0) {
      setError('Select at least one ' + kind.slice(0, -1));
      return;
    }

    const payload = {
      body_md: body,
      audience_spec: buildSpec(),
      template_id: templateId || null,
      scheduled_for_iso: scheduledIso,
      recurrence,
    };

    startTransition(async () => {
      try {
        if (scheduleId) {
          await updateScheduleAndRedirect(scheduleId, payload);
        } else {
          await createScheduleAndRedirect(payload);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  };

  const optionList: { id: string; label: string }[] = useMemo(() => {
    if (kind === 'groups') return groups.map((g) => ({ id: g.id, label: g.name }));
    if (kind === 'regions') return regions.map((r) => ({ id: r.id, label: `${r.name} (${r.kind})` }));
    if (kind === 'subscribers') {
      return subscribers.map((s) => ({
        id: s.id,
        label: `${s.display_name}${s.telegram_chat_id ? '' : ' (unlinked)'}`,
      }));
    }
    return [];
  }, [kind, groups, regions, subscribers]);

  const checkinTpl = templates.find((t) => t.category === 'checkin');

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
            <button type="button" className="btn-ghost" onClick={() => applyTemplate(checkinTpl.id)}>
              Family check-in
            </button>
          ) : null}
        </div>
        <p className="text-xs text-wx-mute">
          Quick-reply buttons come from the template when you send (same as compose).
        </p>
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
      </section>

      <section className="card p-5 space-y-3">
        <label className="block text-xs uppercase tracking-wide text-wx-mute">First send time</label>
        <input
          type="datetime-local"
          className="input max-w-xs"
          value={scheduledLocal}
          onChange={(e) => setScheduledLocal(e.target.value)}
        />
      </section>

      <section className="card p-5 space-y-3">
        <label className="block text-xs uppercase tracking-wide text-wx-mute">Recurrence</label>
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="radio"
              checked={recurrence === 'none'}
              onChange={() => setRecurrence('none')}
            />
            One time
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              checked={recurrence === 'weekly'}
              onChange={() => setRecurrence('weekly')}
            />
            Weekly (same day/time, UTC anchor from first send)
          </label>
        </div>
      </section>

      <section className="card p-5 space-y-3">
        <label className="text-xs uppercase tracking-wide text-wx-mute">Audience</label>
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
                  <input type="checkbox" checked={ids.has(o.id)} onChange={() => toggleId(o.id)} />
                  {o.label}
                </label>
              ))
            )}
          </div>
        )}

        <div className="flex items-center gap-3 pt-1">
          <button type="button" className="btn-ghost" onClick={onPreview} disabled={pending}>
            Preview audience
          </button>
          {previewCount !== null && (
            <span className="text-sm">
              <strong>{previewCount}</strong> recipient{previewCount === 1 ? '' : 's'}
            </span>
          )}
        </div>
      </section>

      {error && <div className="card p-3 border-wx-danger text-wx-danger text-sm">{error}</div>}

      <div className="flex justify-end gap-2">
        <button type="button" className="btn" onClick={onSubmit} disabled={pending}>
          {pending ? 'Saving…' : scheduleId ? 'Save schedule' : 'Create schedule'}
        </button>
      </div>
    </div>
  );
}
