'use client';

import { useEffect, useMemo, useState } from 'react';
import { generateScriptAction, updateControlAction } from './actions';
import { saveScript, clearScript, scriptToPrompterText } from '@/lib/broadcast/script-store';
import type { BroadcastScript } from '@/lib/ai/broadcast-script';
import type { OverlayControl } from '@/lib/broadcast/data';

function fmtSecs(s: number): string {
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return m > 0 ? `${m}m ${r}s` : `${r}s`;
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        } catch {
          /* clipboard blocked */
        }
      }}
      className="btn-ghost text-[11px] px-2 py-1"
    >
      {done ? '✓ Copied' : label}
    </button>
  );
}

function Toggle({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm ${on ? 'border-wx-accent text-wx-fg' : 'border-wx-line text-wx-mute'}`}
    >
      <span className={`inline-block h-3.5 w-3.5 rounded-full ${on ? 'bg-wx-accent' : 'bg-wx-line'}`} />
      {label}
    </button>
  );
}

type OverlayCfg = { brand: string; title: string; subtitle: string; accent: string };

const DEFAULT_CONTROL: OverlayControl = {
  brand: 'MID-SOUTH WX',
  accent: '#fbbf24',
  lower_third_title: '',
  lower_third_subtitle: 'Severe Weather Briefing',
  lower_third_visible: false,
  bug_visible: true,
  ticker_visible: true,
};

export default function BroadcastConsole() {
  const [origin, setOrigin] = useState('');
  const [mode, setMode] = useState<'live' | 'recorded'>('recorded');
  const [minutes, setMinutes] = useState(3);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [script, setScript] = useState<BroadcastScript | null>(null);

  const [cfg, setCfg] = useState<OverlayCfg>({
    brand: 'MID-SOUTH WX',
    title: 'Tyler Dixon',
    subtitle: 'Severe Weather Briefing',
    accent: '#fbbf24',
  });
  const [thumbHeadline, setThumbHeadline] = useState('');
  const [thumbBust, setThumbBust] = useState(0);
  const [standbyMins, setStandbyMins] = useState(5);

  // Live overlay control (mirrors the broadcast_control row).
  const [liveMode, setLiveMode] = useState(false);
  const [control, setControl] = useState<OverlayControl>(DEFAULT_CONTROL);
  const [ctlSavedAt, setCtlSavedAt] = useState<string | null>(null);
  const [ctlError, setCtlError] = useState<string | null>(null);

  // Radar capture preset config.
  const [radarProduct, setRadarProduct] = useState('composite');
  const [radarSpc, setRadarSpc] = useState(false);
  const [radarLsr, setRadarLsr] = useState(true);

  useEffect(() => setOrigin(window.location.origin), []);

  // Seed the live-control panel from the current row once on mount.
  useEffect(() => {
    let alive = true;
    fetch('/api/broadcast/state', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => { if (alive && j?.control) setControl(j.control as OverlayControl); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  // Optimistically apply a control change locally, then persist it. brand +
  // accent ride along from the overlay config so they stay in one place.
  async function pushControl(patch: Partial<OverlayControl>) {
    const next = { ...control, ...patch, brand: cfg.brand, accent: cfg.accent };
    setControl(next);
    setCtlError(null);
    const res = await updateControlAction({ ...patch, brand: cfg.brand, accent: cfg.accent });
    if (!res.ok) setCtlError(res.error);
    else { setControl(res.control); setCtlSavedAt(new Date().toLocaleTimeString()); }
  }

  async function onGenerate() {
    setBusy(true);
    setError(null);
    try {
      const res = await generateScriptAction({ mode, target_minutes: minutes, user_note: note });
      if (!res.ok) {
        setError(res.error);
      } else {
        setScript(res.script);
        saveScript(res.script, res.generated_at);
        if (res.script.thumbnail_headline) setThumbHeadline(res.script.thumbnail_headline);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Generation failed');
    } finally {
      setBusy(false);
    }
  }

  // In live mode the overlays follow the control panel below, so append &live=1
  // and let the DB row supply the text/visibility.
  const overlayUrl = (path: string, params: Record<string, string>) => {
    const p = { ...params, ...(liveMode ? { live: '1' } : {}) };
    const qs = new URLSearchParams(p).toString();
    return `${origin}/broadcast/overlay/${path}${qs ? `?${qs}` : ''}`;
  };

  const sceneUrl = (path: string, params: Record<string, string>) => {
    const qs = new URLSearchParams(params).toString();
    return `${origin}/broadcast/scene/${path}${qs ? `?${qs}` : ''}`;
  };

  const overlays = [
    {
      name: 'Lower third', desc: 'Name + title plate, bottom corner.',
      url: overlayUrl('lower-third', { title: cfg.title, subtitle: cfg.subtitle, brand: cfg.brand, accent: cfg.accent }),
    },
    { name: 'Alert ticker', desc: 'Scrolling crawl of active warnings/watches, auto-refreshing.', url: overlayUrl('ticker', { accent: cfg.accent }) },
    { name: 'Corner bug', desc: 'Brand, live CT clock, Day-1 risk + warning/watch counts.', url: overlayUrl('bug', { brand: cfg.brand, accent: cfg.accent, pos: 'top-right' }) },
    { name: 'Breaking takeover', desc: 'Auto-shows a full-frame red takeover when a tornado warning is active; invisible otherwise.', url: overlayUrl('breaking', { events: 'tornado' }) },
  ];

  const scenes = [
    {
      name: 'Standby', desc: 'Full-frame “Starting soon” with a countdown.',
      url: sceneUrl('standby', { brand: cfg.brand, accent: cfg.accent, in: String(standbyMins) }),
    },
    { name: 'Be right back', desc: 'Intermission card.', url: sceneUrl('brb', { brand: cfg.brand, accent: cfg.accent }) },
    { name: 'Outro', desc: 'Sign-off / thanks-for-watching card.', url: sceneUrl('outro', { brand: cfg.brand, accent: cfg.accent }) },
    { name: 'Headlines board', desc: 'Live SPC Day 1-3, watch/warning counts + alert list.', url: sceneUrl('headlines', { brand: cfg.brand, accent: cfg.accent }) },
  ];

  const thumbUrl = useMemo(() => {
    const qs = new URLSearchParams();
    if (thumbHeadline.trim()) qs.set('headline', thumbHeadline.trim());
    if (thumbBust) qs.set('v', String(thumbBust));
    const s = qs.toString();
    return `/cards/broadcast-thumb${s ? `?${s}` : ''}`;
  }, [thumbHeadline, thumbBust]);

  // Radar in clean capture mode (hide=1) with broadcast-safe layers. Subscriber
  // pins are forced OFF (sub=0) — never show subscriber locations on air. This
  // opens in your logged-in browser to screen-capture (the radar isn't public).
  const radarCaptureUrl = `${origin}/radar?` + new URLSearchParams({
    hide: '1', sub: '0', p: radarProduct, nws: '1', tr: '1', pills: '1',
    spc: radarSpc ? '1' : '0', lsr: radarLsr ? '1' : '0',
  }).toString();

  const fullScript = script ? scriptToPrompterText(script) : '';

  return (
    <div className="space-y-6">
      {/* ───────────── 1. Script generator ───────────── */}
      <section className="card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">1 · AI broadcast script</h2>
          <span className="text-[11px] text-wx-mute">Built from live SPC · AFD · alerts · LSRs</span>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-[11px] text-wx-mute mb-1">Mode</label>
            <div className="flex rounded-md border border-wx-line overflow-hidden">
              {(['recorded', 'live'] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={`px-3 py-1.5 text-sm capitalize ${mode === m ? 'bg-wx-accent text-black font-semibold' : 'text-wx-mute'}`}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-[11px] text-wx-mute mb-1">Target length</label>
            <div className="flex items-center gap-2">
              <input
                type="number" min={1} max={20} value={minutes}
                onChange={(e) => setMinutes(Number(e.target.value))}
                className="input w-20"
              />
              <span className="text-sm text-wx-mute">min</span>
            </div>
          </div>
          <div className="flex-1 min-w-[220px]">
            <label className="block text-[11px] text-wx-mute mb-1">Presenter note (optional)</label>
            <input
              value={note} onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. emphasize the evening tornado window"
              className="input w-full"
            />
          </div>
          <button onClick={onGenerate} disabled={busy} className="btn">
            {busy ? 'Generating…' : script ? 'Regenerate' : 'Generate script'}
          </button>
        </div>

        {error ? <div className="text-wx-danger text-sm">{error}</div> : null}

        {script ? (
          <div className="space-y-4 pt-1">
            {script.summary ? (
              <p className="text-sm text-wx-fg/80 italic">{script.summary}</p>
            ) : null}

            {/* YouTube package */}
            <div className="rounded-lg border border-wx-line p-3 space-y-3">
              <div className="text-xs uppercase tracking-wider text-wx-mute font-semibold">YouTube package</div>
              <div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] text-wx-mute">Title ({script.title.length}/100)</span>
                  <CopyButton text={script.title} />
                </div>
                <div className="text-sm font-semibold">{script.title}</div>
              </div>
              <div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] text-wx-mute">Description</span>
                  <CopyButton text={script.description} />
                </div>
                <p className="text-sm text-wx-fg/85 whitespace-pre-wrap">{script.description}</p>
              </div>
              <div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] text-wx-mute">Tags</span>
                  <CopyButton text={script.tags.join(', ')} />
                </div>
                <div className="flex flex-wrap gap-1 mt-1">
                  {script.tags.map((t) => (
                    <span key={t} className="rounded bg-wx-line/40 px-2 py-0.5 text-[11px] text-wx-fg/80">{t}</span>
                  ))}
                </div>
              </div>
            </div>

            {/* Rundown / segments */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="text-xs uppercase tracking-wider text-wx-mute font-semibold">Rundown</div>
                <div className="flex items-center gap-2">
                  <CopyButton text={fullScript} label="Copy full script" />
                  <a href="/broadcast/teleprompter" target="_blank" rel="noreferrer" className="btn-ghost text-[11px] px-2 py-1">
                    ▶ Teleprompter
                  </a>
                </div>
              </div>
              {script.segments.map((seg, i) => (
                <div key={i} className="rounded-lg border border-wx-line p-3">
                  <div className="flex items-baseline justify-between gap-2">
                    <div className="text-sm font-semibold">{i + 1}. {seg.name}</div>
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-mono text-wx-mute">{fmtSecs(seg.est_seconds)}</span>
                      <CopyButton text={seg.script} />
                    </div>
                  </div>
                  {seg.talking_points.length > 0 ? (
                    <ul className="mt-2 list-disc pl-5 text-[12px] text-wx-fg/70 space-y-0.5">
                      {seg.talking_points.map((p, j) => <li key={j}>{p}</li>)}
                    </ul>
                  ) : null}
                  <p className="mt-2 text-sm text-wx-fg/90 whitespace-pre-wrap">{seg.script}</p>
                </div>
              ))}
              <div className="text-[11px] text-wx-mute">
                Total runtime ≈ {fmtSecs(script.segments.reduce((a, s) => a + (s.est_seconds || 0), 0))}.{' '}
                <button onClick={() => { clearScript(); setScript(null); }} className="hover:text-wx-fg underline">Clear</button>
              </div>
            </div>
          </div>
        ) : (
          <p className="text-[12px] text-wx-mute">
            Generates a spoken script + YouTube title/description/tags from the current weather data.
            Always review and edit before recording — nothing is published automatically, and it is an
            outlook, not an official warning.
          </p>
        )}
      </section>

      {/* ───────────── 2. OBS overlays ───────────── */}
      <section className="card p-4 space-y-3">
        <h2 className="text-sm font-semibold">2 · OBS overlays (browser sources)</h2>
        <p className="text-[12px] text-wx-mute">
          Add each as a <span className="text-wx-fg">Browser Source</span> in OBS at your canvas size (e.g. 1920×1080),
          tick “Shutdown source when not visible” off so the alert ticker keeps polling. These show only public
          NWS data and the text you set below.{liveMode ? ' Live mode is on — these URLs follow the Live control panel.' : ''}
        </p>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <label className="text-[11px] text-wx-mute">Brand
            <input value={cfg.brand} onChange={(e) => setCfg({ ...cfg, brand: e.target.value })} className="input w-full mt-1" />
          </label>
          <label className="text-[11px] text-wx-mute">Lower-third name
            <input value={cfg.title} onChange={(e) => setCfg({ ...cfg, title: e.target.value })} className="input w-full mt-1" />
          </label>
          <label className="text-[11px] text-wx-mute">Subtitle
            <input value={cfg.subtitle} onChange={(e) => setCfg({ ...cfg, subtitle: e.target.value })} className="input w-full mt-1" />
          </label>
          <label className="text-[11px] text-wx-mute">Accent
            <input type="color" value={cfg.accent} onChange={(e) => setCfg({ ...cfg, accent: e.target.value })} className="mt-1 h-9 w-full rounded border border-wx-line bg-transparent" />
          </label>
        </div>

        {overlays.map((o) => (
          <div key={o.name} className="rounded-lg border border-wx-line p-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="text-sm font-semibold">{o.name}</div>
                <div className="text-[11px] text-wx-mute">{o.desc}</div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <a href={o.url} target="_blank" rel="noreferrer" className="btn-ghost text-[11px] px-2 py-1">Preview</a>
                <CopyButton text={o.url} label="Copy URL" />
              </div>
            </div>
            <code className="mt-2 block break-all rounded bg-wx-ink/60 px-2 py-1 text-[10px] text-wx-mute">{o.url || '…'}</code>
          </div>
        ))}
      </section>

      {/* ───────────── 3. Live control ───────────── */}
      <section className="card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">3 · Live control</h2>
          <Toggle on={liveMode} onClick={() => setLiveMode((v) => !v)} label={liveMode ? 'Live mode ON' : 'Live mode OFF'} />
        </div>
        <p className="text-[12px] text-wx-mute">
          Drive the overlays on air without touching OBS. Turn on <span className="text-wx-fg">Live mode</span>
          {' '}(the overlay URLs above pick up <code className="text-wx-fg">&live=1</code>), then edit here — changes
          reach the overlays within ~5s. The lower third, bug, and ticker honor these toggles.
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-[11px] text-wx-mute">Lower-third line 1
            <input
              value={control.lower_third_title}
              onChange={(e) => setControl({ ...control, lower_third_title: e.target.value })}
              onBlur={(e) => pushControl({ lower_third_title: e.target.value })}
              placeholder="Tyler Dixon"
              className="input w-full mt-1"
            />
          </label>
          <label className="text-[11px] text-wx-mute">Lower-third line 2
            <input
              value={control.lower_third_subtitle}
              onChange={(e) => setControl({ ...control, lower_third_subtitle: e.target.value })}
              onBlur={(e) => pushControl({ lower_third_subtitle: e.target.value })}
              placeholder="Severe Weather Briefing"
              className="input w-full mt-1"
            />
          </label>
        </div>

        <div className="flex flex-wrap gap-2">
          <Toggle on={control.lower_third_visible} onClick={() => pushControl({ lower_third_visible: !control.lower_third_visible })} label="Lower third" />
          <Toggle on={control.bug_visible} onClick={() => pushControl({ bug_visible: !control.bug_visible })} label="Corner bug" />
          <Toggle on={control.ticker_visible} onClick={() => pushControl({ ticker_visible: !control.ticker_visible })} label="Ticker" />
        </div>

        <div className="text-[11px] text-wx-mute">
          {ctlError ? <span className="text-wx-danger">{ctlError}</span> : ctlSavedAt ? `Saved ${ctlSavedAt}.` : 'Changes save automatically.'}
          {' '}Brand &amp; accent come from the overlay config above.
        </div>
      </section>

      {/* ───────────── 4. Full-frame scenes ───────────── */}
      <section className="card p-4 space-y-3">
        <h2 className="text-sm font-semibold">4 · Full-frame scenes</h2>
        <p className="text-[12px] text-wx-mute">
          Opaque, full-screen pages to use as a dedicated OBS scene or to screen-record directly —
          standby, intermission, sign-off, and a live headlines board. They share the brand and
          accent set above and auto-update from public NWS data.
        </p>

        <label className="flex items-center gap-2 text-[11px] text-wx-mute">
          Standby countdown
          <input
            type="number" min={0} max={120} value={standbyMins}
            onChange={(e) => setStandbyMins(Number(e.target.value))}
            className="input w-20"
          />
          minutes from open
        </label>

        {scenes.map((o) => (
          <div key={o.name} className="rounded-lg border border-wx-line p-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="text-sm font-semibold">{o.name}</div>
                <div className="text-[11px] text-wx-mute">{o.desc}</div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <a href={o.url} target="_blank" rel="noreferrer" className="btn-ghost text-[11px] px-2 py-1">Preview</a>
                <CopyButton text={o.url} label="Copy URL" />
              </div>
            </div>
            <code className="mt-2 block break-all rounded bg-wx-ink/60 px-2 py-1 text-[10px] text-wx-mute">{o.url || '…'}</code>
          </div>
        ))}
      </section>

      {/* ───────────── 5. Radar capture preset ───────────── */}
      <section className="card p-4 space-y-3">
        <h2 className="text-sm font-semibold">5 · Radar capture</h2>
        <p className="text-[12px] text-wx-mute">
          Opens the radar in clean capture mode (chrome hidden) with broadcast-safe layers for
          screen-recording or a window-capture in OBS. <span className="text-wx-fg">Subscriber pins are forced off.</span>
          {' '}It opens in this logged-in browser — the radar isn’t a public page.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-[11px] text-wx-mute">Product
            <select value={radarProduct} onChange={(e) => setRadarProduct(e.target.value)} className="input mt-1 block">
              <option value="composite">Composite reflectivity</option>
              <option value="reflectivity">Base reflectivity</option>
              <option value="velocity">Velocity</option>
              <option value="satellite">Satellite</option>
            </select>
          </label>
          <Toggle on={radarSpc} onClick={() => setRadarSpc((v) => !v)} label="SPC outlook" />
          <Toggle on={radarLsr} onClick={() => setRadarLsr((v) => !v)} label="Storm reports" />
          <a href={radarCaptureUrl} target="_blank" rel="noreferrer" className="btn text-sm">Open capture view</a>
          <CopyButton text={radarCaptureUrl} label="Copy URL" />
        </div>
        <code className="block break-all rounded bg-wx-ink/60 px-2 py-1 text-[10px] text-wx-mute">{radarCaptureUrl}</code>
      </section>

      {/* ───────────── 6. Thumbnail ───────────── */}
      <section className="card p-4 space-y-3">
        <h2 className="text-sm font-semibold">6 · YouTube thumbnail</h2>
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex-1 min-w-[220px]">
            <label className="block text-[11px] text-wx-mute mb-1">Headline (big text)</label>
            <input
              value={thumbHeadline} onChange={(e) => setThumbHeadline(e.target.value)}
              placeholder="SEVERE RISK FRIDAY"
              className="input w-full"
            />
          </div>
          <button onClick={() => setThumbBust(Date.now())} className="btn-ghost text-sm">Refresh data</button>
          <a href={`${thumbUrl}${thumbUrl.includes('?') ? '&' : '?'}download=1`} className="btn text-sm">↓ Download 1280×720</a>
        </div>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={thumbUrl}
          alt="Thumbnail preview"
          className="w-full max-w-xl rounded-lg border border-wx-line"
          style={{ aspectRatio: '16 / 9' }}
        />
        <p className="text-[11px] text-wx-mute">SPC Day-1 risk + active warnings over the Mid-South map. Leave headline blank to auto-label from the risk.</p>
      </section>
    </div>
  );
}
