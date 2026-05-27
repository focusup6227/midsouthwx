'use client';

import { useState, useTransition, useEffect, useMemo, useRef } from 'react';
import { previewAudience, sendAndRedirect, draftWithAI, type AudienceSpecT, type DraftTone } from './actions';
import { sendTestAlertAndRedirect } from './test-actions';
import { uploadComposeMedia } from './media-actions';
import { templateHasVariables, TEMPLATE_VARIABLES } from '@/lib/templates/fill';

type Template = {
  id: string;
  name: string;
  category: string | null;
  hazard: string | null;
  body_md: string;
  default_quick_replies: { label: string; data: string }[] | null;
};
type Named = { id: string; name: string };
type Sub = { id: string; display_name: string; telegram_chat_id: number | null };

type Kind = 'all' | 'regions' | 'groups' | 'subscribers' | 'geometry';

// F5: standard Y/N buttons attached when "Safety check-in" is on. The data
// codes (`safe` / `help`) are what telegram-webhook keys off — `help` flips
// is_distress on the inbound reply — and what checkin_rollups counts. Keep
// in sync with both.
const SAFETY_CHECKIN_BUTTONS: { label: string; data: string }[] = [
  { label: "✅ I'm safe", data: 'safe' },
  { label: '🆘 Need help', data: 'help' },
];

export default function ComposeForm({
  templates,
  groups,
  regions,
  subscribers,
  initialGeometry,
  initialHazard,
  initialBody,
}: {
  templates: Template[];
  groups: Named[];
  regions: (Named & { kind: string })[];
  subscribers: Sub[];
  initialGeometry?: any;
  initialHazard?: string | null;
  initialBody?: string | null;
}) {
  const [templateId, setTemplateId] = useState<string>('');
  const [body, setBody] = useState(initialBody ?? '');
  const [kind, setKind] = useState<Kind>('all');
  const [ids, setIds] = useState<Set<string>>(new Set());
  const [quickReplies, setQuickReplies] = useState<{ label: string; data: string }[]>([]);
  // F5: when true, message goes out with source='checkin' and the standard
  // safe/help buttons attached. Auto-flips on when a category='checkin'
  // template is selected; operator can also toggle directly on any message.
  const [checkinMode, setCheckinMode] = useState(false);
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
  const [media, setMedia] = useState<{ url: string; type: 'animation' | 'photo' | 'video' | 'document' } | null>(null);
  const [mediaUploading, setMediaUploading] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const mediaInputRef = useRef<HTMLInputElement | null>(null);

  const showTemplateVars = useMemo(() => templateHasVariables(body), [body]);

  useEffect(() => {
    if (initialGeometry) {
      setKind('geometry');
      setGeometry(initialGeometry);
    }
  }, [initialGeometry]);

  // F1: when /compose is opened from a warning row, auto-select the first
  // template tagged with the warning's hazard. Manual override is one click
  // in the template dropdown so this is a soft default, not a lock.
  useEffect(() => {
    if (!initialHazard || templateId) return;
    const match = templates.find((t) => t.hazard === initialHazard);
    if (match) applyTemplate(match.id);
    // applyTemplate is stable enough — we only want to run this once at mount
    // when both inputs are first known.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialHazard, templates]);

  const applyTemplate = (id: string) => {
    setTemplateId(id);
    if (!id) return;
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    setBody(t.body_md);
    // F5: if it's a check-in template, force the standard buttons so the
    // rollup query's safe/help/other partitioning stays meaningful — and
    // toggle the section so the operator sees what mode they're in.
    if (t.category === 'checkin') {
      setCheckinMode(true);
      setQuickReplies(SAFETY_CHECKIN_BUTTONS);
    } else {
      setQuickReplies(t.default_quick_replies ?? []);
    }
  };

  // F5: flipping the toggle directly rewrites quick_replies so the form
  // mirrors what subscribers will see. Flipping off only clears if the
  // current buttons are the standard ones — preserves any custom buttons
  // the operator added before turning the toggle on.
  const setCheckinModeAndButtons = (next: boolean) => {
    setCheckinMode(next);
    if (next) {
      setQuickReplies(SAFETY_CHECKIN_BUTTONS);
    } else {
      const isStandard =
        quickReplies.length === SAFETY_CHECKIN_BUTTONS.length &&
        quickReplies.every((q, i) => q.data === SAFETY_CHECKIN_BUTTONS[i].data);
      if (isStandard) setQuickReplies([]);
    }
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
    startTransition(async () => {
      try {
        await sendAndRedirect({
          body_md: body,
          audience_spec: buildSpec(),
          quick_replies: quickReplies,
          template_id: templateId || null,
          // F5: an explicit toggle now drives the source flag, not the
          // template category — the operator can attach a check-in to any
          // alert (e.g., a polygon-targeted tornado warning composed from
          // /radar) without first picking a template.
          source: checkinMode ? 'checkin' : 'manual',
          template_vars: showTemplateVars ? templateVars : undefined,
          media,
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

        <div className="pt-2 border-t border-wx-line space-y-2">
          <div className="flex items-center justify-between">
            <label className="block text-xs uppercase tracking-wide text-wx-mute">Attachment (optional)</label>
            {media && (
              <button
                type="button"
                onClick={() => { setMedia(null); setMediaError(null); if (mediaInputRef.current) mediaInputRef.current.value = ''; }}
                className="text-xs text-wx-mute hover:text-wx-danger"
              >
                Remove
              </button>
            )}
          </div>
          {media ? (
            <div className="flex items-center gap-3 rounded border border-wx-line bg-wx-ink/40 p-2">
              {media.type === 'photo' || media.type === 'animation' ? (
                <img src={media.url} alt="" className="h-16 w-16 rounded object-cover" />
              ) : (
                <span className="inline-flex h-16 w-16 items-center justify-center rounded bg-wx-card text-xs text-wx-mute">
                  {media.type}
                </span>
              )}
              <div className="min-w-0 text-xs">
                <div className="truncate text-wx-fg">{media.url.split('/').pop()}</div>
                <div className="text-wx-mute">Sent as Telegram {media.type}. Body becomes the caption.</div>
              </div>
            </div>
          ) : (
            <label className={`flex items-center gap-3 ${mediaUploading ? 'opacity-50' : 'cursor-pointer'}`}>
              <span className="btn-ghost text-sm">{mediaUploading ? 'Uploading…' : 'Choose GIF / image / video'}</span>
              <input
                ref={mediaInputRef}
                type="file"
                accept="image/gif,image/png,image/jpeg,image/webp,video/mp4,video/quicktime"
                className="hidden"
                disabled={mediaUploading}
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  setMediaError(null);
                  setMediaUploading(true);
                  try {
                    const fd = new FormData();
                    fd.set('file', file);
                    const res = await uploadComposeMedia(fd);
                    if (res.ok) setMedia({ url: res.url, type: res.type });
                    else setMediaError(res.error);
                  } catch (err) {
                    setMediaError(err instanceof Error ? err.message : String(err));
                  } finally {
                    setMediaUploading(false);
                    if (mediaInputRef.current) mediaInputRef.current.value = '';
                  }
                }}
              />
              <span className="text-xs text-wx-mute">GIF, PNG/JPG, MP4 (max 50 MB)</span>
            </label>
          )}
          {mediaError && <p className="text-xs text-wx-danger">{mediaError}</p>}
        </div>
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
        <label className="flex items-center justify-between cursor-pointer select-none">
          <div>
            <div className="text-xs uppercase tracking-wide text-wx-mute font-semibold">Safety check-in</div>
            <div className="text-[11.5px] text-wx-mute mt-0.5">
              Adds <span className="font-mono">✅ I&apos;m safe</span> / <span className="font-mono">🆘 Need help</span>{' '}
              buttons. Responses appear on{' '}
              <a href="/checkins" className="text-wx-accent underline">/checkins</a>.
            </div>
          </div>
          <button
            type="button"
            onClick={() => setCheckinModeAndButtons(!checkinMode)}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition shrink-0 ${checkinMode ? 'bg-wx-accent' : 'bg-wx-line'}`}
            aria-pressed={checkinMode}
          >
            <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition ${checkinMode ? 'translate-x-4.5' : 'translate-x-0.5'}`} />
          </button>
        </label>
        <div className="flex items-center justify-between pt-1 border-t border-wx-line">
          <label className="text-xs uppercase tracking-wide text-wx-mute">Quick replies</label>
          <button
            type="button"
            className="btn-ghost text-sm"
            onClick={() => setQuickReplies([...quickReplies, { label: '', data: '' }])}
            disabled={checkinMode}
            title={checkinMode ? 'Disabled while safety check-in is on' : ''}
          >
            + Add
          </button>
        </div>
        {checkinMode ? (
          <p className="text-[11.5px] text-wx-mute">
            Standard buttons are locked while safety check-in is on. Turn it off above to customize.
          </p>
        ) : null}
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
                  disabled={checkinMode}
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
                  disabled={checkinMode}
                  onChange={(e) => {
                    const next = [...quickReplies];
                    next[i] = { ...next[i], data: e.target.value };
                    setQuickReplies(next);
                  }}
                />
                <button
                  type="button"
                  className="btn-ghost disabled:opacity-40 disabled:cursor-not-allowed"
                  disabled={checkinMode}
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
        <button
          type="button"
          className="btn-ghost"
          disabled={pending || !body.trim()}
          onClick={() => {
            setError(null);
            startTransition(async () => {
              try {
                await sendTestAlertAndRedirect({ body_md: body, media });
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              }
            });
          }}
          title="Send to your own subscriber row only — full pipeline, no fan-out"
        >
          {pending ? 'Sending…' : '🧪 Test to me'}
        </button>
        <button type="button" className="btn" onClick={onSend} disabled={pending}>
          {pending ? 'Sending…' : 'Send now'}
        </button>
      </div>
    </div>
  );
}
