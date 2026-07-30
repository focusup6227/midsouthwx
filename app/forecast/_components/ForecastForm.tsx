'use client';

import '@/lib/mapbox/patch-remove-source';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Map, { Source, Layer, type MapRef, type MapMouseEvent } from 'react-map-gl';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { Sparkles, Trash2, Check, X, Wand2, History } from 'lucide-react';
import { mapboxAccessToken, mapboxStyleUrl } from '@/lib/supabase/env';
import { supabaseBrowser } from '@/lib/supabase/client';
import {
  saveForecast,
  draftForecast,
  previewForecastContext,
  recentForecastAreas,
  hazardSkillSummary,
  type SituationPreview,
  type RecentArea,
  type HazardSkill,
} from '../actions';

// Hazard catalog mirrors compose page (app/compose/page.tsx:44). When we
// hand off to /compose later only one hazard maps to a template, but the
// forecast record can carry several.
const HAZARDS = [
  { key: 'tornado', label: 'Tornado', tint: 'text-red-400' },
  { key: 'severe', label: 'Severe TS', tint: 'text-orange-400' },
  { key: 'flood', label: 'Flood', tint: 'text-emerald-400' },
  { key: 'wind', label: 'Wind', tint: 'text-purple-400' },
  { key: 'winter', label: 'Winter', tint: 'text-sky-400' },
  { key: 'heat', label: 'Heat', tint: 'text-amber-400' },
] as const;
type HazardKey = (typeof HAZARDS)[number]['key'];

// Default window: now → +12 h. 12 h is long enough for a single convective
// outlook and short enough that the verification cron has a tight bound to
// score against.
function defaultWindow(): { from: string; to: string } {
  const now = new Date();
  const later = new Date(now.getTime() + 12 * 3600 * 1000);
  return { from: toLocalInput(now), to: toLocalInput(later) };
}

// HTML's <input type="datetime-local"> wants 'YYYY-MM-DDTHH:MM' with no tz.
function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(s: string): string {
  // datetime-local has no tz; assume operator's local tz and convert to ISO.
  return new Date(s).toISOString();
}

type Props = {
  initialArea: GeoJSON.Polygon | null;
};

const POLY_FILL_PAINT = { 'fill-color': '#fbbf24', 'fill-opacity': 0.18 };
const POLY_LINE_PAINT = { 'line-color': '#fbbf24', 'line-width': 2 };
const DRAW_VERTEX_PAINT = { 'circle-color': '#fbbf24', 'circle-radius': 5, 'circle-stroke-color': '#0b1220', 'circle-stroke-width': 2 };

export default function ForecastForm({ initialArea }: Props) {
  const router = useRouter();
  const token = mapboxAccessToken();
  const styleUrl = mapboxStyleUrl();
  useEffect(() => { if (token) mapboxgl.accessToken = token; }, [token]);

  const mapRef = useRef<MapRef>(null);

  // Draw state — mirrors app/radar/RadarView.tsx (drawMode + polygonPoints,
  // closing the ring on Complete). We only need the polygon mode here; the
  // forecast feature doesn't use circle / snap / pick-site.
  const [polygon, setPolygon] = useState<GeoJSON.Polygon | null>(initialArea);
  const [points, setPoints] = useState<[number, number][]>([]);
  const [drawing, setDrawing] = useState<boolean>(!initialArea);

  // Form fields
  const [title, setTitle] = useState<string>('');
  const [hazards, setHazards] = useState<Set<HazardKey>>(new Set());
  const [confidence, setConfidence] = useState<'' | 'low' | 'moderate' | 'high'>('');
  const initialWindow = useMemo(defaultWindow, []);
  const [validFrom, setValidFrom] = useState<string>(initialWindow.from);
  const [validUntil, setValidUntil] = useState<string>(initialWindow.to);
  const [discussion, setDiscussion] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // AI draft state. aiDraft + aiSourceRefs are persisted with the row when
  // the operator saves, so we keep them in sync with whichever values the
  // operator hasn't edited away. Once they save the row, this all goes into
  // ai_draft / source_refs jsonb columns for audit.
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [aiDraft, setAiDraft] = useState<unknown | null>(null);
  const [aiSourceRefs, setAiSourceRefs] = useState<Record<string, unknown> | null>(null);
  const aiActive = aiDraft !== null;

  // Draft-time context: situation snapshot + live audience reach for the
  // drawn polygon, recent areas for carry-forward, 90-day per-hazard skill.
  const [situation, setSituation] = useState<SituationPreview | null>(null);
  const [situationLoading, setSituationLoading] = useState(false);
  const [audience, setAudience] = useState<{ total: number; tn: number; ms: number; ar: number } | null>(null);
  const [recentAreas, setRecentAreas] = useState<RecentArea[]>([]);
  const [skill, setSkill] = useState<Record<string, HazardSkill>>({});

  useEffect(() => {
    let cancelled = false;
    void hazardSkillSummary().then((s) => { if (!cancelled) setSkill(s); }).catch(() => {});
    if (!initialArea) {
      void recentForecastAreas().then((a) => { if (!cancelled) setRecentAreas(a); }).catch(() => {});
    }
    return () => { cancelled = true; };
  }, [initialArea]);

  // Refresh situation + audience whenever the polygon changes (debounced —
  // Redraw → Complete cycles shouldn't stack requests).
  useEffect(() => {
    if (!polygon) {
      setSituation(null);
      setAudience(null);
      return;
    }
    let cancelled = false;
    setSituationLoading(true);
    const t = setTimeout(async () => {
      const supa = supabaseBrowser();
      const [sit, aud] = await Promise.all([
        previewForecastContext({ area: polygon }).catch(() => null),
        supa
          .rpc('resolve_audience_breakdown', {
            spec: { geometry: { type: 'Polygon', coordinates: polygon.coordinates } },
          })
          .then(
            (r) => (r.error ? null : (r.data as { total?: number; tn?: number; ms?: number; ar?: number })),
            () => null,
          ),
      ]);
      if (cancelled) return;
      setSituation(sit);
      setAudience(
        aud
          ? { total: Number(aud.total ?? 0), tn: Number(aud.tn ?? 0), ms: Number(aud.ms ?? 0), ar: Number(aud.ar ?? 0) }
          : null,
      );
      setSituationLoading(false);
    }, 350);
    return () => { cancelled = true; clearTimeout(t); };
  }, [polygon]);

  const loadArea = (a: RecentArea) => {
    setPolygon(a.area);
    setPoints([]);
    setDrawing(false);
    const ring = a.area.coordinates[0] ?? [];
    let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
    for (const [lng, lat] of ring) {
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
    mapRef.current?.getMap()?.fitBounds([[minLng, minLat], [maxLng, maxLat]], { padding: 60, duration: 500 });
  };

  // Warn before the tab/window closes with unsaved work. "Dirty" = anything
  // the operator actively produced (typed text, drawn polygon, AI draft) —
  // the prefilled valid window alone doesn't count. Cleared once saving
  // starts so the post-save router.push doesn't trip it.
  const dirty =
    !saving &&
    (title.trim().length > 0 ||
      discussion.trim().length > 0 ||
      hazards.size > 0 ||
      aiDraft !== null ||
      points.length > 0 ||
      (polygon !== null && polygon !== initialArea));
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  const toggleHazard = (h: HazardKey) => {
    setHazards((prev) => {
      const next = new Set(prev);
      if (next.has(h)) next.delete(h);
      else next.add(h);
      return next;
    });
  };

  const onMapClick = useCallback((e: MapMouseEvent) => {
    if (!drawing) return;
    const { lng, lat } = e.lngLat;
    setPoints((pts) => [...pts, [lng, lat]]);
  }, [drawing]);

  const completePolygon = () => {
    if (points.length < 3) {
      setError('Polygon needs at least 3 vertices.');
      return;
    }
    const ring = [...points, points[0]];
    setPolygon({ type: 'Polygon', coordinates: [ring] });
    setPoints([]);
    setDrawing(false);
    setError(null);
  };

  const restartDraw = () => {
    setPolygon(null);
    setPoints([]);
    setDrawing(true);
  };

  const undoPoint = () => setPoints((pts) => pts.slice(0, -1));

  // Fly to the initial area on mount so the operator sees their drawn polygon
  // straight away. Cheap and stable since initialArea never changes.
  useEffect(() => {
    if (!initialArea || initialArea.coordinates.length === 0) return;
    const ring = initialArea.coordinates[0];
    let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
    for (const [lng, lat] of ring) {
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
    const map = mapRef.current?.getMap();
    if (!map) return;
    map.fitBounds([[minLng, minLat], [maxLng, maxLat]], { padding: 60, duration: 600 });
  }, [initialArea]);

  // Live geojson sources for the in-progress polygon and the completed one.
  const inProgressGeo: GeoJSON.FeatureCollection = useMemo(() => {
    if (!drawing || points.length === 0) {
      return { type: 'FeatureCollection', features: [] };
    }
    const features: GeoJSON.Feature[] = points.map((p, i) => ({
      type: 'Feature',
      id: i,
      geometry: { type: 'Point', coordinates: p },
      properties: {},
    }));
    if (points.length >= 2) {
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: points },
        properties: {},
      });
    }
    return { type: 'FeatureCollection', features };
  }, [drawing, points]);

  const polygonGeo: GeoJSON.FeatureCollection = useMemo(() => {
    if (!polygon) return { type: 'FeatureCollection', features: [] };
    return {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: polygon, properties: {} }],
    };
  }, [polygon]);

  const canSave =
    title.trim().length > 0 &&
    hazards.size > 0 &&
    polygon !== null &&
    validFrom.length > 0 &&
    validUntil.length > 0;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!polygon) { setError('Draw the forecast area first.'); return; }
    if (hazards.size === 0) { setError('Pick at least one hazard.'); return; }
    const validFromIso = fromLocalInput(validFrom);
    const validUntilIso = fromLocalInput(validUntil);
    if (new Date(validUntilIso) <= new Date(validFromIso)) {
      setError('Valid-until must be after valid-from.');
      return;
    }
    setSaving(true);
    try {
      const { id } = await saveForecast({
        title: title.trim(),
        hazards: Array.from(hazards),
        confidence: confidence === '' ? null : confidence,
        valid_from: validFromIso,
        valid_until: validUntilIso,
        discussion: discussion.trim() || null,
        area: polygon,
        ai_draft: aiDraft,
        source_refs: aiSourceRefs,
      });
      router.push(`/forecast/${id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save forecast.');
      setSaving(false);
    }
  };

  const runAiDraft = async () => {
    setDraftError(null);
    if (!polygon) { setDraftError('Draw the forecast area first.'); return; }
    const validFromIso = fromLocalInput(validFrom);
    const validUntilIso = fromLocalInput(validUntil);
    if (new Date(validUntilIso) <= new Date(validFromIso)) {
      setDraftError('Set a valid time window before drafting.');
      return;
    }
    setDrafting(true);
    try {
      const result = await draftForecast({
        area: polygon,
        valid_from: validFromIso,
        valid_until: validUntilIso,
        hazards_hint: Array.from(hazards) as HazardKey[],
        user_note: discussion.trim() || null,
      });
      // Title only gets seeded when the operator hasn't typed anything
      // themselves — otherwise their wording wins and the AI just supplies
      // hazards/confidence/discussion. Discussion always overwrites because
      // it's the part the operator most commonly wants drafted.
      if (!title.trim()) setTitle(result.draft.headline);
      setHazards(new Set(result.draft.hazards as HazardKey[]));
      setConfidence(result.draft.confidence);
      setDiscussion(result.draft.discussion_md);
      setAiDraft(result.ai_draft);
      setAiSourceRefs(result.source_refs as unknown as Record<string, unknown>);
    } catch (err) {
      setDraftError(err instanceof Error ? err.message : 'AI draft failed.');
    } finally {
      setDrafting(false);
    }
  };

  const clearAiDraft = () => {
    setAiDraft(null);
    setAiSourceRefs(null);
  };

  return (
    <form onSubmit={onSubmit} className="grid gap-4 lg:grid-cols-[1fr_360px]">
      <div className="relative h-[60vh] min-h-[420px] overflow-hidden rounded-lg border border-wx-line">
        {token ? (
          <Map
            ref={mapRef}
            mapboxAccessToken={token}
            mapStyle={styleUrl}
            initialViewState={{ longitude: -89.8, latitude: 35.0, zoom: 6 }}
            onClick={onMapClick}
            cursor={drawing ? 'crosshair' : 'grab'}
            attributionControl
          >
            {polygon && (
              <Source id="forecast-polygon" type="geojson" data={polygonGeo}>
                <Layer id="forecast-polygon-fill" type="fill" paint={POLY_FILL_PAINT} />
                <Layer id="forecast-polygon-line" type="line" paint={POLY_LINE_PAINT} />
              </Source>
            )}
            {drawing && (
              <Source id="forecast-draw" type="geojson" data={inProgressGeo}>
                <Layer id="forecast-draw-line" type="line" filter={['==', ['geometry-type'], 'LineString']} paint={POLY_LINE_PAINT} />
                <Layer id="forecast-draw-vertex" type="circle" filter={['==', ['geometry-type'], 'Point']} paint={DRAW_VERTEX_PAINT} />
              </Source>
            )}
          </Map>
        ) : (
          <div className="flex h-full items-center justify-center bg-wx-card text-sm text-wx-mute">
            Map unavailable — NEXT_PUBLIC_MAPBOX_TOKEN is not set.
          </div>
        )}

        <div className="absolute left-3 top-3 max-w-[260px] rounded-lg border border-wx-line bg-wx-card/95 p-3 text-xs backdrop-blur">
          {drawing ? (
            <>
              <div className="font-semibold uppercase tracking-wider text-[10px] text-wx-mute">Draw area</div>
              <div className="mt-1 text-wx-fg">
                Click to add vertices. {points.length} placed · {points.length >= 3 ? 'ready to close' : 'need ≥3'}.
              </div>
              {points.length === 0 && recentAreas.length > 0 ? (
                <div className="mt-2 space-y-1">
                  <div className="text-[10px] uppercase tracking-wider text-wx-mute">or reuse an area</div>
                  {recentAreas.slice(0, 3).map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => loadArea(a)}
                      className="flex w-full items-center gap-1.5 rounded-md border border-wx-line px-2 py-1 text-left text-[11px] text-wx-fg hover:border-wx-accent"
                      title={new Date(a.created_at).toLocaleString()}
                    >
                      <History size={11} className="shrink-0 text-wx-mute" />
                      <span className="truncate">{a.title}</span>
                    </button>
                  ))}
                </div>
              ) : null}
              <div className="mt-2 flex gap-1.5">
                <button
                  type="button"
                  onClick={completePolygon}
                  disabled={points.length < 3}
                  className="inline-flex items-center gap-1 rounded-md bg-wx-accent px-2 py-1 text-[11px] font-semibold text-black disabled:bg-wx-line disabled:text-wx-mute"
                >
                  <Check size={12} /> Complete
                </button>
                <button
                  type="button"
                  onClick={undoPoint}
                  disabled={points.length === 0}
                  className="inline-flex items-center gap-1 rounded-md border border-wx-line px-2 py-1 text-[11px] text-wx-mute hover:text-wx-fg disabled:opacity-40"
                >
                  Undo
                </button>
                <button
                  type="button"
                  onClick={() => { setPoints([]); }}
                  className="inline-flex items-center gap-1 rounded-md border border-wx-line px-2 py-1 text-[11px] text-wx-mute hover:text-wx-fg"
                >
                  <X size={12} />
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="font-semibold uppercase tracking-wider text-[10px] text-wx-mute">Area</div>
              <div className="mt-1 text-wx-fg">
                Polygon · {polygon ? polygon.coordinates[0].length - 1 : 0} vertices
              </div>
              {audience ? (
                <div className="mt-1 text-[11px]">
                  <span className="font-bold text-wx-accent">{audience.total}</span>{' '}
                  <span className="text-wx-mute">
                    subscriber{audience.total === 1 ? '' : 's'} reached
                    {audience.total > 0 ? ` · TN ${audience.tn} · MS ${audience.ms} · AR ${audience.ar}` : ''}
                  </span>
                </div>
              ) : situationLoading ? (
                <div className="mt-1 text-[11px] text-wx-mute">counting audience…</div>
              ) : null}
              <button
                type="button"
                onClick={restartDraw}
                className="mt-2 inline-flex items-center gap-1 rounded-md border border-wx-line px-2 py-1 text-[11px] text-wx-mute hover:text-wx-fg"
              >
                <Trash2 size={12} /> Redraw
              </button>
            </>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-lg border border-wx-line bg-wx-card p-4">
        {polygon ? (
          <div className="rounded-md border border-wx-line bg-wx-ink/50 p-2.5 text-[11.5px]">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="font-semibold uppercase tracking-wider text-[10px] text-wx-mute">
                Situation in area
              </span>
              {situationLoading ? (
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-wx-accent" />
              ) : null}
            </div>
            {situation ? (
              <div className="space-y-1.5">
                <div className="flex flex-wrap gap-1.5">
                  {situation.spc.map((d) => (
                    <span
                      key={d.day}
                      className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${
                        d.overlap.some((l) => ['MDT', 'HIGH'].includes(l))
                          ? 'border-red-500/60 text-red-300'
                          : d.overlap.some((l) => ['SLGT', 'ENH'].includes(l))
                            ? 'border-orange-500/60 text-orange-300'
                            : 'border-wx-line text-wx-mute'
                      }`}
                      title={`SPC Day ${d.day} — area overlaps: ${d.overlap.join(', ') || 'none'}`}
                    >
                      D{d.day} {d.overlap.length ? d.overlap[d.overlap.length - 1] : d.label ?? '—'}
                    </span>
                  ))}
                  <span className="rounded border border-wx-line px-1.5 py-0.5 font-mono text-[10px] text-wx-mute">
                    {situation.alerts_total} alert{situation.alerts_total === 1 ? '' : 's'} · {situation.lsr_total} LSR
                  </span>
                </div>
                {(situation.extended.some((d) => d.label) || situation.thunder) ? (
                  <div className="font-mono text-[10px] text-wx-mute">
                    {situation.extended.some((d) => d.label) ? (
                      <>
                        D4-8:{' '}
                        {situation.extended
                          .filter((d) => d.label)
                          .map((d) => `D${d.day} ${d.label}`)
                          .join(' · ')}
                      </>
                    ) : null}
                    {situation.thunder ? (
                      <span className={situation.thunder.max >= 50 ? 'text-wx-accent' : ''}>
                        {situation.extended.some((d) => d.label) ? ' · ' : ''}
                        thunder {situation.thunder.max}%
                        {situation.thunder.peak_at
                          ? ` @ ${new Date(situation.thunder.peak_at).toLocaleTimeString([], { hour: 'numeric' })}`
                          : ''}
                      </span>
                    ) : null}
                  </div>
                ) : null}
                {situation.afd?.synopsis ? (
                  <details>
                    <summary className="cursor-pointer text-wx-mute">
                      AFD {situation.afd.wfo ?? ''} synopsis
                    </summary>
                    <p className="mt-1 max-h-28 overflow-y-auto whitespace-pre-wrap text-wx-fg/85 wx-scroll">
                      {situation.afd.synopsis}
                    </p>
                  </details>
                ) : null}
                {situation.alerts.length > 0 ? (
                  <ul className="space-y-0.5 text-wx-fg/85">
                    {situation.alerts.map((a, i) => (
                      <li key={i} className="truncate" title={a.headline ?? ''}>
                        · {a.event}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {situation.suggested.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-1.5 border-t border-wx-line pt-1.5">
                    <span className="text-[10px] uppercase tracking-wider text-wx-mute">Suggested:</span>
                    {situation.suggested.map((h) => (
                      <button
                        key={h}
                        type="button"
                        onClick={() => setHazards((prev) => new Set(prev).add(h as HazardKey))}
                        disabled={hazards.has(h as HazardKey)}
                        className="rounded border border-wx-accent/60 px-1.5 py-0.5 text-[10px] font-semibold text-wx-accent hover:bg-wx-accent/10 disabled:border-wx-line disabled:text-wx-mute"
                        title="Add this hazard (from SPC overlap / active alerts / recent reports)"
                      >
                        + {h}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : situationLoading ? (
              <p className="text-wx-mute">Reading SPC · AFD · alerts · LSRs…</p>
            ) : (
              <p className="text-wx-mute">Situation data unavailable.</p>
            )}
          </div>
        ) : null}

        <label className="flex flex-col gap-1 text-xs">
          <span className="font-semibold uppercase tracking-wider text-wx-mute">Title</span>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={120}
            placeholder="e.g. Severe potential, Mid-South 4–10 PM"
            className="rounded-md border border-wx-line bg-wx-ink px-2.5 py-1.5 text-sm text-wx-fg outline-none focus:border-wx-accent"
          />
        </label>

        <fieldset className="flex flex-col gap-1.5 text-xs">
          <span className="font-semibold uppercase tracking-wider text-wx-mute">Hazards</span>
          <div className="grid grid-cols-2 gap-1.5">
            {HAZARDS.map((h) => {
              const on = hazards.has(h.key);
              return (
                <button
                  key={h.key}
                  type="button"
                  onClick={() => toggleHazard(h.key)}
                  className={`flex items-center justify-between rounded-md border px-2 py-1.5 text-left text-[11.5px] ${
                    on
                      ? 'border-wx-accent bg-wx-accent/10 text-wx-fg'
                      : 'border-wx-line text-wx-mute hover:text-wx-fg'
                  }`}
                  aria-pressed={on}
                >
                  <span className={on ? h.tint : ''}>{h.label}</span>
                  {on ? <Check size={12} /> : null}
                </button>
              );
            })}
          </div>
          {(() => {
            // 90-day track record for the selected hazards — calibrate the
            // confidence pick against how these calls have actually verified.
            const rows = Array.from(hazards)
              .map((h) => ({ h, s: skill[h] }))
              .filter((r): r is { h: HazardKey; s: HazardSkill } => Boolean(r.s));
            if (rows.length === 0) return null;
            return (
              <div className="mt-0.5 font-mono text-[10px] text-wx-mute">
                90d:{' '}
                {rows.map(({ h, s }, i) => (
                  <span key={h} title={`${s.hits} hits · ${s.misses} misses · ${s.false_alarms} false alarms`}>
                    {i > 0 ? ' · ' : ''}
                    {h} POD {s.pod != null ? Math.round(s.pod * 100) + '%' : '—'} FAR{' '}
                    {s.far != null ? Math.round(s.far * 100) + '%' : '—'}
                  </span>
                ))}
              </div>
            );
          })()}
        </fieldset>

        <label className="flex flex-col gap-1 text-xs">
          <span className="font-semibold uppercase tracking-wider text-wx-mute">Confidence</span>
          <select
            value={confidence}
            onChange={(e) => setConfidence(e.target.value as typeof confidence)}
            className="rounded-md border border-wx-line bg-wx-ink px-2.5 py-1.5 text-sm text-wx-fg outline-none focus:border-wx-accent"
          >
            <option value="">—</option>
            <option value="low">Low</option>
            <option value="moderate">Moderate</option>
            <option value="high">High</option>
          </select>
        </label>

        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-semibold uppercase tracking-wider text-wx-mute">Valid from</span>
            <input
              type="datetime-local"
              value={validFrom}
              onChange={(e) => setValidFrom(e.target.value)}
              className="rounded-md border border-wx-line bg-wx-ink px-2 py-1.5 text-sm text-wx-fg outline-none focus:border-wx-accent"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-semibold uppercase tracking-wider text-wx-mute">Valid until</span>
            <input
              type="datetime-local"
              value={validUntil}
              onChange={(e) => setValidUntil(e.target.value)}
              className="rounded-md border border-wx-line bg-wx-ink px-2 py-1.5 text-sm text-wx-fg outline-none focus:border-wx-accent"
            />
          </label>
        </div>

        <label className="flex flex-col gap-1 text-xs">
          <span className="font-semibold uppercase tracking-wider text-wx-mute">Discussion</span>
          <textarea
            value={discussion}
            onChange={(e) => setDiscussion(e.target.value)}
            rows={6}
            maxLength={8000}
            placeholder="Free-text reasoning, source data, timing notes…"
            className="rounded-md border border-wx-line bg-wx-ink px-2.5 py-1.5 text-sm text-wx-fg outline-none focus:border-wx-accent"
          />
        </label>

        {aiActive ? (
          <div className="flex items-center justify-between gap-2 rounded-md border border-fuchsia-700 bg-fuchsia-500/10 px-2.5 py-1.5 text-[11.5px] text-fuchsia-200">
            <span>
              <span className="font-semibold uppercase tracking-wider text-[10px]">AI draft</span>
              <span className="ml-1 text-fuchsia-300/80">— operator review required before saving.</span>
            </span>
            <button
              type="button"
              onClick={clearAiDraft}
              className="text-fuchsia-300/80 hover:text-fuchsia-100"
              aria-label="Discard AI draft attribution"
              title="Discard AI draft attribution"
            >
              <X size={12} />
            </button>
          </div>
        ) : null}

        {draftError ? (
          <div className="rounded-md border border-red-500 bg-red-500/10 px-2.5 py-1.5 text-[11.5px] text-red-200">
            {draftError}
          </div>
        ) : null}

        {error ? (
          <div className="rounded-md border border-red-500 bg-red-500/10 px-2.5 py-1.5 text-[11.5px] text-red-200">
            {error}
          </div>
        ) : null}

        <div className="mt-1 flex flex-col gap-2">
          <button
            type="button"
            onClick={runAiDraft}
            disabled={!polygon || drafting || saving}
            className="inline-flex items-center justify-center gap-2 rounded-lg border border-fuchsia-700 bg-fuchsia-500/10 py-2 text-sm font-semibold text-fuchsia-200 hover:bg-fuchsia-500/20 disabled:opacity-40"
          >
            <Wand2 size={14} /> {drafting ? 'Drafting…' : aiActive ? 'Re-draft with AI' : 'AI draft'}
          </button>
          <button
            type="submit"
            disabled={!canSave || saving || drafting}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-wx-accent py-2 text-sm font-semibold text-black hover:bg-amber-300 disabled:bg-wx-line disabled:text-wx-mute"
          >
            <Sparkles size={14} /> {saving ? 'Saving…' : 'Save forecast'}
          </button>
        </div>
      </div>
    </form>
  );
}
