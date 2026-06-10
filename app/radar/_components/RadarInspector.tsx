'use client';

// The radar inspector — the expanded panel (desktop: 304px right rail;
// mobile: bottom sheet) with the legend header, the Threats/Layers/Source/
// Models tab bar, and the four tab panels. Extracted from RadarView; every
// piece of data is computed in RadarView and passed down as props — this
// component derives nothing on its own. The `!uiHidden && !selection &&
// !inspectorCollapsed` gate stays in RadarView; when mounted this renders
// unconditionally (mobile backdrop button + panel).

import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { MapRef } from 'react-map-gl';
import { Atom, ChevronRight, Search, Send, Target, X } from 'lucide-react';
import {
  NEXRAD_SITES,
  NEXRAD_SITES_BY_CODE,
  nearestSites,
  distanceKm,
  type RadarSite,
} from '@/lib/radar/sites';
import { alertTint, categoryBadge, type NwsRadarAlert } from '@/lib/nws/radar';
import {
  MODEL_OVERLAYS,
  DISABLED_MODELS,
  type ModelOverlayKey,
  type ModelOverlayMeta,
} from '@/lib/radar/models';
import AfdPanel from './AfdPanel';
import {
  PRODUCTS,
  GOES_SOURCES,
  DEFAULT_SITE_CODE,
  type GoesLegend,
  type GoesSourceId,
  type ProductKey,
  type SatSourceId,
} from './radar-products';
import type { Level2Overlay, SweepInfo } from '../_hooks/useLevel2Data';
import type { SpcDay } from '../_hooks/useRadarData';

// LibreWxR color schemes (color path param 1..9). Default 8 matches radar.weather.gov.
const LIBREWXR_COLOR_SCHEMES: { id: number; name: string }[] = [
  { id: 1, name: 'Black and White' },
  { id: 2, name: 'Original' },
  { id: 3, name: 'Universal Blue' },
  { id: 4, name: 'TITAN' },
  { id: 5, name: 'The Weather Channel' },
  { id: 6, name: 'Meteored' },
  { id: 7, name: 'NEXRAD Level III' },
  { id: 8, name: 'Dark Sky' },
  { id: 9, name: 'NWS Reflectivity' },
];

function formatElev(deg: number): string {
  return `${deg.toFixed(deg < 10 ? 1 : 0)}°`;
}

function CategoryCheckbox({
  label,
  tint,
  on,
  toggle,
  count,
}: {
  label: string;
  tint: string;
  on: boolean;
  toggle: () => void;
  count: number;
}) {
  return (
    <button
      type="button"
      onClick={toggle}
      className="flex items-center justify-between gap-1.5 text-left"
      aria-pressed={on}
    >
      <span className="flex items-center gap-1.5 min-w-0">
        <span
          className={`inline-flex h-3 w-3 items-center justify-center rounded border ${
            on ? 'border-wx-accent bg-wx-accent/20 text-wx-accent' : 'border-wx-line text-transparent'
          }`}
        >
          {on ? '✓' : ''}
        </span>
        <span className={on ? tint : 'text-wx-mute'}>{label}</span>
      </span>
      <span className="text-wx-mute font-mono">{count}</span>
    </button>
  );
}

// Inspector tab ids — RadarView holds the active-tab state and imports this.
export type InspectorTab = 'threats' | 'layers' | 'source' | 'models';

// Structural mirrors of shapes RadarView infers from its memos/state — kept
// here so props typecheck without RadarInspector importing from RadarView
// (which would be circular).
export type ProbSevereCell = {
  id: string;
  topType: string;
  topProb: number;
  severe: number;
  tor: number;
  hail: number;
  wind: number;
  readout: string;
  center: [number, number];
  me: number;
  ms: number;
};

export type ThreatBoardItem = {
  key: string;
  kind: 'warning' | 'probsevere' | 'couplet';
  score: number;
  badge: string;
  title: string;
  sub: string;
  dot: string;
  center: [number, number] | null;
  warning?: NwsRadarAlert;
  cell?: ProbSevereCell;
};

export type ProbSeverePopupState = {
  lng: number;
  lat: number;
  topType: string;
  topProb: number;
  severe: number;
  tor: number;
  hail: number;
  wind: number;
  readout: string;
  me: number;
  ms: number;
};

type LngLatView = { longitude: number; latitude: number };
type DrawMode = 'none' | 'polygon' | 'snap' | 'pick-site';
type LoadingLike = { isLoading: boolean };

export type RadarInspectorProps = {
  // Panel chrome + tabs
  setInspectorCollapsed: Dispatch<SetStateAction<boolean>>;
  inspectorTab: InspectorTab;
  setInspectorTab: Dispatch<SetStateAction<InspectorTab>>;
  mapRef: RefObject<MapRef>;

  // Legend header / source line
  effectiveProduct: ProductKey;
  satSource: SatSourceId;
  setSatSource: Dispatch<SetStateAction<SatSourceId>>;
  lwxrSubject: 'radar' | 'satellite' | null;
  useLibreWxR: boolean;
  useLevel2: boolean;
  useL2Png: boolean;
  isComposite: boolean;
  availableSweeps: SweepInfo[];
  resolvedSweepIndex: number;
  level2Loading: boolean;
  level2Error: string | null;
  level2Attempt: number;
  level2MaxAttempts: number;
  level2Overlay: Level2Overlay | null;

  // Threat board
  threatBoard: ThreatBoardItem[];
  setProbSeverePopup: Dispatch<SetStateAction<ProbSeverePopupState | null>>;

  // Source tab — LibreWxR / opacity / mode / site picker / split / Level II
  showArrows: boolean;
  setShowArrows: Dispatch<SetStateAction<boolean>>;
  colorScheme: number;
  setColorScheme: Dispatch<SetStateAction<number>>;
  opacity: number;
  setOpacity: Dispatch<SetStateAction<number>>;
  selectedSite: string | null;
  setSelectedSite: Dispatch<SetStateAction<string | null>>;
  siteQuery: string;
  setSiteQuery: Dispatch<SetStateAction<string>>;
  viewState: LngLatView;
  settledView: LngLatView;
  drawMode: DrawMode;
  setDrawMode: Dispatch<SetStateAction<DrawMode>>;
  recentSiteCodes: string[];
  pickerSites: RadarSite[];
  pickerCenter: [number, number] | null;
  splitProduct: ProductKey | null;
  setSplitProduct: Dispatch<SetStateAction<ProductKey | null>>;
  hiRes: boolean;
  setHiRes: Dispatch<SetStateAction<boolean>>;
  pngFallback: boolean;
  setPngFallback: Dispatch<SetStateAction<boolean>>;
  selectedElevation: number | 'composite';
  setSelectedElevation: Dispatch<SetStateAction<number | 'composite'>>;

  // Layers tab — overlay toggles + counts
  subsCount: number;
  showSubs: boolean;
  setShowSubs: Dispatch<SetStateAction<boolean>>;
  showCoverage: boolean;
  setShowCoverage: Dispatch<SetStateAction<boolean>>;
  warnings: NwsRadarAlert[];
  warningsLoading: boolean;
  displayWarnings: NwsRadarAlert[];
  scrubTimeMs: number | null;
  showNws: boolean;
  setShowNws: Dispatch<SetStateAction<boolean>>;
  catWarnings: boolean;
  setCatWarnings: Dispatch<SetStateAction<boolean>>;
  catWatches: boolean;
  setCatWatches: Dispatch<SetStateAction<boolean>>;
  catAdvisories: boolean;
  setCatAdvisories: Dispatch<SetStateAction<boolean>>;
  catDiscussions: boolean;
  setCatDiscussions: Dispatch<SetStateAction<boolean>>;
  stormTrackCount: number;
  showStormTracks: boolean;
  setShowStormTracks: Dispatch<SetStateAction<boolean>>;
  displayLsrGeo: GeoJSON.FeatureCollection;
  showLsr: boolean;
  setShowLsr: Dispatch<SetStateAction<boolean>>;
  displayStormReportsGeo: GeoJSON.FeatureCollection;
  showStormReports: boolean;
  setShowStormReports: Dispatch<SetStateAction<boolean>>;
  lightningGeo: GeoJSON.FeatureCollection;
  showLightning: boolean;
  setShowLightning: Dispatch<SetStateAction<boolean>>;
  coupletGeo: GeoJSON.FeatureCollection;
  coupletsSwr: LoadingLike;
  showCouplets: boolean;
  setShowCouplets: Dispatch<SetStateAction<boolean>>;
  probSevereDrawn: { count: number; max: number };
  probSevereSwr: LoadingLike;
  showProbSevere: boolean;
  setShowProbSevere: Dispatch<SetStateAction<boolean>>;
  probSevereTop: ProbSevereCell[];
  probSevereTrend: Record<string, { dProb: number; dFlash: number }>;
  mpingGeo: GeoJSON.FeatureCollection;
  mpingSwr: LoadingLike;
  showMping: boolean;
  setShowMping: Dispatch<SetStateAction<boolean>>;
  metarGeo: GeoJSON.FeatureCollection;
  metarSwr: LoadingLike;
  showMetar: boolean;
  setShowMetar: Dispatch<SetStateAction<boolean>>;
  trafficCamCount: number;
  showTrafficCams: boolean;
  setShowTrafficCams: Dispatch<SetStateAction<boolean>>;
  showZones: boolean;
  setShowZones: Dispatch<SetStateAction<boolean>>;
  mapPillSites: RadarSite[];
  showSitePills: boolean;
  setShowSitePills: Dispatch<SetStateAction<boolean>>;
  capWarningsGeo: GeoJSON.FeatureCollection;
  showCap: boolean;
  setShowCap: Dispatch<SetStateAction<boolean>>;
  spcDay: 1 | 2 | 3;
  setSpcDay: Dispatch<SetStateAction<1 | 2 | 3>>;
  spcDays: SpcDay[];
  activeSpc: SpcDay | null;
  showSpc: boolean;
  setShowSpc: Dispatch<SetStateAction<boolean>>;

  // Threats tab — active alerts list + selected warning card
  selectedWarning: NwsRadarAlert | null;
  setSelectedWarning: Dispatch<SetStateAction<NwsRadarAlert | null>>;
  composeUrlForWarning: (w: NwsRadarAlert) => string;
  composeUrlForWarningTrack: (w: NwsRadarAlert) => string | null;
  openWarningSounding: (w: NwsRadarAlert) => void;
  focusWarning: (w: NwsRadarAlert) => void;

  // Models tab
  modelOverlay: ModelOverlayKey | null;
  setModelOverlay: Dispatch<SetStateAction<ModelOverlayKey | null>>;
  activeModel: ModelOverlayMeta | null;
  modelHour: number;
  setModelHour: Dispatch<SetStateAction<number>>;
  modelOpacity: number;
  setModelOpacity: Dispatch<SetStateAction<number>>;

  // Pointer readout
  hoverPixel: { lng: number; lat: number; sample: number | null } | null;
  sampleLabel: string;
};

export default function RadarInspector({
  setInspectorCollapsed,
  inspectorTab,
  setInspectorTab,
  mapRef,
  effectiveProduct,
  satSource,
  setSatSource,
  lwxrSubject,
  useLibreWxR,
  useLevel2,
  useL2Png,
  isComposite,
  availableSweeps,
  resolvedSweepIndex,
  level2Loading,
  level2Error,
  level2Attempt,
  level2MaxAttempts,
  level2Overlay,
  threatBoard,
  setProbSeverePopup,
  showArrows,
  setShowArrows,
  colorScheme,
  setColorScheme,
  opacity,
  setOpacity,
  selectedSite,
  setSelectedSite,
  siteQuery,
  setSiteQuery,
  viewState,
  settledView,
  drawMode,
  setDrawMode,
  recentSiteCodes,
  pickerSites,
  pickerCenter,
  splitProduct,
  setSplitProduct,
  hiRes,
  setHiRes,
  pngFallback,
  setPngFallback,
  selectedElevation,
  setSelectedElevation,
  subsCount,
  showSubs,
  setShowSubs,
  showCoverage,
  setShowCoverage,
  warnings,
  warningsLoading,
  displayWarnings,
  scrubTimeMs,
  showNws,
  setShowNws,
  catWarnings,
  setCatWarnings,
  catWatches,
  setCatWatches,
  catAdvisories,
  setCatAdvisories,
  catDiscussions,
  setCatDiscussions,
  stormTrackCount,
  showStormTracks,
  setShowStormTracks,
  displayLsrGeo,
  showLsr,
  setShowLsr,
  displayStormReportsGeo,
  showStormReports,
  setShowStormReports,
  lightningGeo,
  showLightning,
  setShowLightning,
  coupletGeo,
  coupletsSwr,
  showCouplets,
  setShowCouplets,
  probSevereDrawn,
  probSevereSwr,
  showProbSevere,
  setShowProbSevere,
  probSevereTop,
  probSevereTrend,
  mpingGeo,
  mpingSwr,
  showMping,
  setShowMping,
  metarGeo,
  metarSwr,
  showMetar,
  setShowMetar,
  trafficCamCount,
  showTrafficCams,
  setShowTrafficCams,
  showZones,
  setShowZones,
  mapPillSites,
  showSitePills,
  setShowSitePills,
  capWarningsGeo,
  showCap,
  setShowCap,
  spcDay,
  setSpcDay,
  spcDays,
  activeSpc,
  showSpc,
  setShowSpc,
  selectedWarning,
  setSelectedWarning,
  composeUrlForWarning,
  composeUrlForWarningTrack,
  openWarningSounding,
  focusWarning,
  modelOverlay,
  setModelOverlay,
  activeModel,
  modelHour,
  setModelHour,
  modelOpacity,
  setModelOpacity,
  hoverPixel,
  sampleLabel,
}: RadarInspectorProps) {
  return (
          <>
            <button
              type="button"
              onClick={() => setInspectorCollapsed(true)}
              className="md:hidden absolute inset-0 z-10 bg-black/40 backdrop-blur-[1px]"
              aria-label="Close layers panel"
              tabIndex={-1}
            />
            <div className="absolute top-auto bottom-0 left-0 right-0 max-h-[75vh] rounded-t-2xl border-t border-x border-wx-line bg-wx-card overflow-y-auto p-4 pt-7 flex flex-col gap-[18px] z-20 wx-scroll md:top-4 md:bottom-auto md:left-auto md:right-4 md:w-[304px] md:max-h-[calc(100%-220px)] md:rounded-xl md:border">
            <button
              type="button"
              onClick={() => setInspectorCollapsed(true)}
              className="absolute top-1.5 right-1.5 w-6 h-6 inline-flex items-center justify-center rounded-md text-wx-mute hover:text-wx-fg hover:bg-wx-ink"
              aria-label="Collapse inspector"
              title="Collapse inspector"
            >
              <ChevronRight size={14} />
            </button>
            <div>
              <div className="flex items-center justify-between text-[10.5px] tracking-wider uppercase text-wx-mute font-semibold">
                <span>Legend · {PRODUCTS[effectiveProduct].short}</span>
                <span className="font-mono text-[10px] text-wx-mute">
                  {(() => {
                    if (effectiveProduct === 'satellite' && satSource !== 'lwxr') {
                      return `GOES-East · ${GOES_SOURCES[satSource as GoesSourceId]?.short ?? 'SAT'}`;
                    }
                    if (lwxrSubject === 'satellite') return 'CONUS · LibreWxR IR';
                    if (useLibreWxR) return 'CONUS · LibreWxR';
                    if (effectiveProduct === 'rotation') return 'MRMS · CONUS';
                    if (useLevel2) {
                      const tiltLabel = isComposite
                        ? 'COMP'
                        : (() => {
                            const s = availableSweeps.find((x) => x.index === resolvedSweepIndex);
                            return s ? formatElev(s.elevation_deg) : '—';
                          })();
                      if (effectiveProduct === 'correlation') return `Level II · ρhv · ${tiltLabel}`;
                      if (effectiveProduct === 'zdr') return `Level II · ZDR · ${tiltLabel}`;
                      if (effectiveProduct === 'kdp') return `Level II · KDP · ${tiltLabel}`;
                      return `Level II · ${tiltLabel}${useL2Png ? ' · PNG' : ''}`;
                    }
                    return selectedSite
                      ? (effectiveProduct === 'velocity' ? 'IEM · SRV 0.5°' : 'IEM · super-res 0.5°')
                      : 'CONUS · QCD';
                  })()}
                </span>
              </div>
              {(effectiveProduct === 'correlation' || effectiveProduct === 'zdr' || effectiveProduct === 'kdp') && selectedSite && (
                <p className="text-[10px] text-wx-mute mt-1">
                  {level2Loading && level2Attempt > 0 ? `Warming renderer · retry ${level2Attempt}/${level2MaxAttempts}…`
                    : level2Loading ? (effectiveProduct === 'zdr' ? 'Rendering differential reflectivity…' : effectiveProduct === 'kdp' ? 'Retrieving KDP from differential phase…' : 'Rendering correlation coefficient…')
                    : level2Error === 'renderer_not_configured' ? 'Renderer not configured (see .env.local)'
                    : level2Error === 'renderer_waking' ? `Renderer waking up · retry ${level2Attempt}/${level2MaxAttempts}…`
                    : (level2Error === 'renderer_unreachable' || level2Error === 'renderer_timeout') ? 'Renderer slow — retrying…'
                    : level2Error ? `${effectiveProduct === 'zdr' ? 'ZDR' : 'CC'} unavailable (${level2Error})`
                    : level2Overlay ? `Scan ${new Date(level2Overlay.scan_time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} UTC`
                    : 'Waiting for Level II render…'}
                </p>
              )}
              {(() => {
                const satLegend: GoesLegend | null = effectiveProduct === 'satellite'
                  ? (satSource === 'lwxr' ? 'ir' : (GOES_SOURCES[satSource as GoesSourceId]?.legend ?? 'ir'))
                  : null;
                const satGradient =
                  satLegend === 'wv'   ? 'bg-[linear-gradient(90deg,#4a2f1c_0%,#92602f_25%,#cfa66d_45%,#4ade80_65%,#3b82f6_100%)]'
                  : satLegend === 'rgb' ? 'bg-[linear-gradient(90deg,#1e1b4b_0%,#3b82f6_25%,#10b981_50%,#fbbf24_75%,#ef4444_100%)]'
                  : 'bg-[linear-gradient(90deg,#0f172a_0%,#475569_35%,#cbd5e1_70%,#f8fafc_100%)]';
                const satLabels =
                  satLegend === 'wv'   ? ['Dry', '·', '·', 'Moist']
                  : satLegend === 'rgb' ? ['RGB composite']
                  : ['Warm', '·', '·', 'Cold cloud tops'];
                return (
                  <>
                    <div className={`h-2.5 rounded-[3px] mt-1 ${effectiveProduct === 'velocity' ? 'bg-[linear-gradient(90deg,#16a34a_0%,#22d3ee_25%,#e5e7eb_50%,#fb7185_75%,#b91c1c_100%)]' : effectiveProduct === 'rotation' ? 'bg-[linear-gradient(90deg,#1e1b4b_0%,#6d28d9_40%,#d946ef_70%,#fde047_100%)]' : effectiveProduct === 'correlation' ? 'bg-[linear-gradient(90deg,#1f2937_0%,#4b5563_30%,#6b7280_60%,#fbbf24_85%,#ef4444_100%)]' : effectiveProduct === 'zdr' ? 'bg-[linear-gradient(90deg,#5b21b6_0%,#6b7280_25%,#9ca3af_33%,#22d3ee_42%,#10b981_50%,#84cc16_58%,#facc15_67%,#f97316_75%,#ef4444_83%,#fbcfe8_100%)]' : effectiveProduct === 'kdp' ? 'bg-[linear-gradient(90deg,#4b5563_0%,#1f2937_17%,#0ea5e9_25%,#10b981_33%,#84cc16_50%,#facc15_67%,#f97316_83%,#ec4899_100%)]' : effectiveProduct === 'satellite' ? satGradient : 'bg-[linear-gradient(90deg,#3b82f6_0%,#22d3ee_15%,#10b981_30%,#84cc16_45%,#facc15_60%,#f97316_75%,#ef4444_88%,#d946ef_100%)]'}`} />
                    <div className="flex justify-between text-[9.5px] font-mono text-wx-mute mt-1">
                      {effectiveProduct === 'velocity' && ['−64', '−32', '0', '+32', '+64 kts'].map(t => <span key={t}>{t}</span>)}
                      {effectiveProduct === 'rotation' && ['0', '0.005', '0.010', '0.015', '0.020 s⁻¹'].map(t => <span key={t}>{t}</span>)}
                      {effectiveProduct === 'correlation' && ['0.2', '0.5', '0.8', '0.95', '1.0'].map(t => <span key={t}>{t}</span>)}
                      {effectiveProduct === 'zdr' && ['−4', '0', '+2', '+4', '+8 dB'].map(t => <span key={t}>{t}</span>)}
                      {effectiveProduct === 'kdp' && ['−1', '0', '1', '2', '3', '5 °/km'].map(t => <span key={t}>{t}</span>)}
                      {effectiveProduct === 'satellite' && satLabels.map((t, i) => <span key={`${t}-${i}`}>{t}</span>)}
                      {(effectiveProduct === 'composite' || effectiveProduct === 'reflectivity') && ['5', '15', '25', '35', '45', '55', '65', '75 dBZ'].map(t => <span key={t}>{t}</span>)}
                    </div>
                  </>
                );
              })()}
            </div>

            {/* Inspector tab bar — one group at a time instead of a long scroll. */}
            <div className="flex gap-1">
              {([['threats', 'Threats'], ['layers', 'Layers'], ['source', 'Source'], ['models', 'Models']] as const).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setInspectorTab(key)}
                  aria-pressed={inspectorTab === key}
                  className={`flex-1 rounded-md px-2 py-1.5 text-[11px] font-semibold tracking-wide transition ${inspectorTab === key ? 'bg-wx-accent/15 text-wx-fg ring-1 ring-wx-accent' : 'text-wx-mute hover:text-wx-fg hover:bg-wx-ink'}`}
                >
                  {label}
                </button>
              ))}
            </div>

            {inspectorTab === 'threats' && (
            <div className="flex flex-col gap-2">
              <div className="text-[10.5px] tracking-wider uppercase text-wx-mute font-semibold">
                Threat board · {threatBoard.length}
              </div>
              {(
                threatBoard.length === 0 ? (
                  <p className="text-[10px] text-wx-mute">No active threats — quiet right now.</p>
                ) : (
                  <div className="flex flex-col gap-1 max-h-56 overflow-y-auto wx-scroll">
                    {threatBoard.map((th) => (
                      <button
                        key={th.key}
                        type="button"
                        onClick={() => {
                          if (th.center) {
                            mapRef.current?.flyTo({ center: th.center, zoom: th.kind === 'warning' ? 8.5 : 8, duration: 700 });
                          }
                          if (th.kind === 'warning' && th.warning) setSelectedWarning(th.warning);
                          if (th.kind === 'probsevere' && th.cell) {
                            const c = th.cell;
                            setProbSeverePopup({
                              lng: c.center[0], lat: c.center[1],
                              topType: c.topType, topProb: c.topProb,
                              severe: c.severe, tor: c.tor, hail: c.hail, wind: c.wind,
                              readout: c.readout, me: c.me, ms: c.ms,
                            });
                          }
                        }}
                        className="flex items-center gap-2 rounded-md border border-wx-line bg-wx-ink px-2 py-1.5 text-left hover:border-wx-accent"
                      >
                        <span className={`inline-block h-1.5 w-1.5 rounded-full ${th.dot} shrink-0`} />
                        <span className="w-6 shrink-0 text-[8px] font-semibold uppercase tracking-wider text-wx-mute">{th.badge}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[10.5px] font-medium text-wx-fg">{th.title}</span>
                          {th.sub ? <span className="block truncate text-[9px] text-wx-mute">{th.sub}</span> : null}
                        </span>
                      </button>
                    ))}
                  </div>
                )
              )}
            </div>
            )}

            {inspectorTab === 'source' && (
            <div className="flex flex-col gap-[18px]">
              {(<>

            {effectiveProduct === 'satellite' && (
              <div>
                <div className="text-[10.5px] tracking-wider uppercase text-wx-mute font-semibold mb-1">Satellite source</div>
                <select
                  value={satSource}
                  onChange={(e) => setSatSource(e.target.value as SatSourceId)}
                  className="w-full text-[11px] font-mono bg-wx-ink border border-wx-line rounded px-2 py-1 text-wx-fg"
                  title="Switch between LibreWxR's modeled IR (animated) and real GOES-East ABI bands (live single frame)"
                >
                  <option value="lwxr">LibreWxR IR · modeled · animated</option>
                  {(Object.keys(GOES_SOURCES) as GoesSourceId[]).map((id) => (
                    <option key={id} value={id}>{GOES_SOURCES[id].label}</option>
                  ))}
                </select>
                {satSource !== 'lwxr' && (() => {
                  const cfg = GOES_SOURCES[satSource as GoesSourceId];
                  const upstream = cfg?.provider === 'iem' ? 'Iowa State Mesonet' : 'NASA GIBS';
                  return (
                    <p className="text-[9.5px] text-wx-mute mt-1 leading-snug">
                      Live single frame via {upstream} · GOES-East ABI · ~10 min cadence
                    </p>
                  );
                })()}
              </div>
            )}

            {lwxrSubject === 'radar' && (
              <div>
                <div className="text-[10.5px] tracking-wider uppercase text-wx-mute font-semibold mb-1">LibreWxR</div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[10px] text-wx-mute">Motion arrows</span>
                  <button
                    onClick={() => setShowArrows((v) => !v)}
                    className={`relative inline-flex h-4 w-7 items-center rounded-full transition ${showArrows ? 'bg-amber-400' : 'bg-wx-line'}`}
                    aria-pressed={showArrows}
                    title={showArrows ? 'Hide storm-motion arrows' : 'Show storm-motion arrows'}
                  >
                    <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition ${showArrows ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
                  </button>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-wx-mute">Color scheme</span>
                  <select
                    value={colorScheme}
                    onChange={(e) => setColorScheme(parseInt(e.target.value, 10))}
                    className="text-[10px] font-mono bg-wx-ink border border-wx-line rounded px-1.5 py-0.5 text-wx-fg"
                    title="LibreWxR radar color scheme"
                  >
                    {LIBREWXR_COLOR_SCHEMES.map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10.5px] tracking-wider uppercase text-wx-mute font-semibold">Layer opacity</span>
                <span className="font-mono text-[11px] text-wx-fg">{opacity}%</span>
              </div>
              <input type="range" min={20} max={100} step={2} value={opacity} onChange={(e) => setOpacity(parseInt(e.target.value))} className="w-full" />
            </div>

            <div>
              <div className="text-[10.5px] tracking-wider uppercase text-wx-mute font-semibold mb-1">Mode</div>
              <div className="flex border border-wx-line rounded-lg overflow-hidden bg-wx-ink">
                <button onClick={() => { setSelectedSite(null); setSiteQuery(''); }} className={`flex-1 py-1.5 text-sm font-medium ${!selectedSite ? 'bg-wx-card text-wx-fg' : 'text-wx-mute'}`}>CONUS</button>
                <button
                  onClick={() => {
                    if (!selectedSite) {
                      const center: [number, number] = [viewState.longitude, viewState.latitude];
                      const nearest = nearestSites(center, 1)[0] ?? NEXRAD_SITES_BY_CODE[DEFAULT_SITE_CODE];
                      setSelectedSite(nearest.code);
                      mapRef.current?.flyTo({ center: nearest.center, zoom: nearest.zoom, duration: 700 });
                    }
                  }}
                  className={`flex-1 py-1.5 text-sm font-medium border-l border-wx-line ${selectedSite ? 'bg-wx-card text-wx-fg' : 'text-wx-mute'}`}
                >Single site</button>
              </div>
              {selectedSite && (
                <div className="mt-2 flex flex-col gap-1.5">
                  <div className="relative">
                    <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-wx-mute pointer-events-none" />
                    <input
                      type="text"
                      value={siteQuery}
                      onChange={(e) => setSiteQuery(e.target.value)}
                      placeholder="Search NEXRAD (KOHX, Nashville, TN…)"
                      className="w-full pl-7 pr-7 py-1.5 text-[11.5px] bg-wx-ink border border-wx-line rounded-md placeholder:text-wx-mute focus:border-wx-accent outline-none"
                    />
                    {siteQuery && (
                      <button
                        onClick={() => setSiteQuery('')}
                        className="absolute right-1.5 top-1/2 -translate-y-1/2 text-wx-mute hover:text-wx-fg"
                        title="Clear"
                      ><X size={11} /></button>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => setDrawMode((m) => (m === 'pick-site' ? 'none' : 'pick-site'))}
                    className={`flex items-center gap-1.5 px-2 py-1 rounded text-[10.5px] border ${drawMode === 'pick-site' ? 'bg-wx-accent text-black border-wx-accent' : 'bg-wx-ink/40 border-wx-line text-wx-mute hover:text-wx-fg'}`}
                    title="Click anywhere on the map to pick the nearest NEXRAD site"
                  >
                    <Target size={11} /> {drawMode === 'pick-site' ? 'Click the map…' : 'Pick by clicking map'}
                  </button>

                  {!siteQuery && recentSiteCodes.length > 0 && (
                    <>
                      <div className="text-[9.5px] uppercase tracking-wider text-wx-mute font-semibold">Recent</div>
                      <div className="grid grid-cols-1 gap-0.5">
                        {recentSiteCodes
                          .map((c) => NEXRAD_SITES_BY_CODE[c])
                          .filter((s): s is RadarSite => !!s)
                          .map((s) => {
                            const active = selectedSite === s.code;
                            return (
                              <button
                                key={`recent-${s.code}`}
                                onClick={() => {
                                  mapRef.current?.flyTo({ center: s.center, zoom: s.zoom, duration: 700 });
                                  setSelectedSite(s.code);
                                }}
                                className={`w-full text-left px-2 py-1 rounded text-[11.5px] flex items-center gap-2 transition ${active ? 'bg-wx-ink border border-wx-line text-wx-fg' : 'hover:bg-wx-ink/60 text-wx-mute hover:text-wx-fg'}`}
                              >
                                <span className="font-mono text-[10px] text-wx-accent w-[44px] flex-shrink-0">{s.code}</span>
                                <span className="flex-1 truncate">{s.name}</span>
                                <span className="text-[9.5px] font-mono text-wx-mute/70 flex-shrink-0">{s.state}</span>
                              </button>
                            );
                          })}
                      </div>
                    </>
                  )}
                  <div className="text-[9.5px] uppercase tracking-wider text-wx-mute font-semibold flex items-center justify-between">
                    <span>{siteQuery ? `Matches · ${pickerSites.length}` : 'Nearest sites'}</span>
                    <span className="font-mono text-wx-mute/70 normal-case tracking-normal">{NEXRAD_SITES.length} CONUS</span>
                  </div>
                  <div className="max-h-[220px] overflow-y-auto wx-scroll pr-0.5 -mr-0.5">
                    {pickerSites.length === 0 && (
                      <p className="text-[11px] text-wx-mute px-1 py-2">No matches — try a code (KTLX), city, or state code (OK).</p>
                    )}
                    <div className="grid grid-cols-1 gap-0.5">
                      {pickerSites.map((s) => {
                        const active = selectedSite === s.code;
                        const distanceFrom: [number, number] = pickerCenter ?? [settledView.longitude, settledView.latitude];
                        const km = distanceKm(distanceFrom, s.center);
                        return (
                          <button
                            key={s.code}
                            onClick={() => {
                              mapRef.current?.flyTo({ center: s.center, zoom: s.zoom, duration: 700 });
                              setSelectedSite(s.code);
                            }}
                            className={`w-full text-left px-2 py-1 rounded text-[11.5px] flex items-center gap-2 transition ${active ? 'bg-wx-ink border border-wx-line text-wx-fg' : 'hover:bg-wx-ink/60 text-wx-mute hover:text-wx-fg'}`}
                          >
                            <span className="font-mono text-[10px] text-wx-accent w-[44px] flex-shrink-0">{s.code}</span>
                            <span className="flex-1 truncate">{s.name}</span>
                            <span className="text-[9.5px] font-mono text-wx-mute/70 flex-shrink-0">{s.state} · {Math.round(km)}km</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}
              {selectedSite && (effectiveProduct === 'reflectivity' || effectiveProduct === 'velocity') && (
                <div className="pt-3 border-t border-wx-line mt-1">
                  <label className="flex items-center justify-between cursor-pointer">
                    <div>
                      <div className="text-[10.5px] tracking-wider uppercase text-wx-mute font-semibold">Split view</div>
                      <div className="text-[10px] text-wx-mute">
                        {effectiveProduct === 'reflectivity' ? 'BREF | SRV' : 'SRV | BREF'}
                      </div>
                    </div>
                    <button
                      onClick={() => {
                        if (splitProduct) {
                          setSplitProduct(null);
                        } else {
                          setSplitProduct(effectiveProduct === 'reflectivity' ? 'velocity' : 'reflectivity');
                        }
                      }}
                      className={`relative inline-flex h-5 w-9 items-center rounded-full transition ${splitProduct ? 'bg-wx-accent' : 'bg-wx-line'}`}
                      aria-pressed={!!splitProduct}
                    >
                      <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition ${splitProduct ? 'translate-x-4.5' : 'translate-x-0.5'}`} />
                    </button>
                  </label>
                  <label className="flex items-center justify-between cursor-pointer mt-2.5 pt-2.5 border-t border-wx-line/40">
                    <div>
                      <div className="text-[10.5px] tracking-wider uppercase text-wx-mute font-semibold">Hi-Res Level II</div>
                      <div className="text-[10px] text-wx-mute">Sharper single-site render</div>
                    </div>
                    <button
                      onClick={() => setHiRes(!hiRes)}
                      className={`relative inline-flex h-5 w-9 items-center rounded-full transition ${hiRes ? 'bg-wx-accent' : 'bg-wx-line'}`}
                      aria-pressed={hiRes}
                    >
                      <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition ${hiRes ? 'translate-x-4.5' : 'translate-x-0.5'}`} />
                    </button>
                  </label>
                  {hiRes && (
                    <>
                      <label className="flex items-center justify-between cursor-pointer mt-2.5 pt-2.5 border-t border-wx-line/40">
                        <div>
                          <div className="text-[10.5px] tracking-wider uppercase text-wx-mute font-semibold">Raster mode</div>
                          <div className="text-[10px] text-wx-mute">Fast PNG + pointer readout · off = polygons</div>
                        </div>
                        <button
                          onClick={() => setPngFallback(!pngFallback)}
                          className={`relative inline-flex h-5 w-9 items-center rounded-full transition ${pngFallback ? 'bg-wx-accent' : 'bg-wx-line'}`}
                          aria-pressed={pngFallback}
                        >
                          <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition ${pngFallback ? 'translate-x-4.5' : 'translate-x-0.5'}`} />
                        </button>
                      </label>
                      <div className="mt-2.5 pt-2.5 border-t border-wx-line/40">
                        <div className="flex items-center justify-between">
                          <div className="text-[10.5px] tracking-wider uppercase text-wx-mute font-semibold">Tilt</div>
                          <span className="font-mono text-[10px] text-wx-mute">
                            {(() => {
                              if (isComposite) return 'COMPOSITE';
                              const s = availableSweeps.find((x) => x.index === resolvedSweepIndex);
                              return s ? formatElev(s.elevation_deg) : '—';
                            })()}
                          </span>
                        </div>
                        <div className="grid grid-cols-4 gap-1 mt-1.5">
                          {[0.5, 0.9, 1.3, 1.8, 2.4, 3.1, 4.0].map((deg) => {
                            const active = !isComposite && selectedElevation === deg;
                            const haveData = availableSweeps.length > 0;
                            const nearest = haveData
                              ? availableSweeps.reduce((best, s) =>
                                  Math.abs(s.elevation_deg - deg) < Math.abs(best.elevation_deg - deg) ? s : best)
                              : null;
                            return (
                              <button
                                key={deg}
                                onClick={() => setSelectedElevation(deg)}
                                className={`px-1.5 py-1 rounded text-[10px] font-mono border transition ${active ? 'bg-wx-accent text-black border-wx-accent' : 'bg-wx-ink border-wx-line text-wx-mute hover:text-wx-fg'}`}
                                title={nearest ? `nearest sweep: ${formatElev(nearest.elevation_deg)} (idx ${nearest.index})` : 'awaiting volume metadata'}
                              >
                                {formatElev(deg)}
                              </button>
                            );
                          })}
                          <button
                            onClick={() => setSelectedElevation('composite')}
                            className={`col-span-4 px-1.5 py-1 rounded text-[10px] font-mono border transition ${isComposite ? 'bg-wx-accent text-black border-wx-accent' : 'bg-wx-ink border-wx-line text-wx-mute hover:text-wx-fg'}`}
                            title="Max reflectivity across all tilts"
                          >
                            COMPOSITE · ALL TILTS
                          </button>
                        </div>
                      </div>
                    </>
                  )}
                  {hiRes && level2Loading && (
                    <p className="text-[10px] text-wx-mute mt-1">
                      {level2Attempt > 0
                        ? `Warming renderer · retry ${level2Attempt}/${level2MaxAttempts}…`
                        : 'Rendering…'}
                    </p>
                  )}
                  {hiRes && level2Error === 'renderer_waking' && !level2Loading && (
                    <p className="text-[10px] text-amber-300/90 mt-1">
                      Renderer cold-start · retry {level2Attempt}/{level2MaxAttempts} in progress
                    </p>
                  )}
                  {hiRes && level2Error === 'renderer_not_configured' && <p className="text-[10px] text-wx-danger mt-1">Renderer not configured</p>}
                  {hiRes && level2Error === 'renderer_waking' && <p className="text-[10px] text-wx-mute mt-1">Renderer waking up…</p>}
                  {hiRes && (level2Error === 'renderer_unreachable' || level2Error === 'renderer_timeout') && <p className="text-[10px] text-wx-mute mt-1">Renderer slow — retrying…</p>}
                  {hiRes && level2Error && !['renderer_not_configured','renderer_waking','renderer_unreachable','renderer_timeout'].includes(level2Error) && <p className="text-[10px] text-wx-danger mt-1">Level II error: {level2Error}</p>}
                  {hiRes && level2Overlay && !level2Loading && (
                    <p className="text-[10px] text-wx-mute mt-1">
                      Scan {new Date(level2Overlay.scan_time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} UTC
                    </p>
                  )}
                </div>
              )}
            </div>

              </>)}
            </div>
            )}

            {inspectorTab === 'layers' && (
            <div className="flex flex-col gap-[18px]">
              {(<>

            <div>
              <div className="-mb-1 text-[9px] font-semibold uppercase tracking-[0.15em] text-wx-mute/70">
                Audience &amp; coverage
              </div>
              <div className="flex items-center justify-between mb-1">
                <div className="text-[10.5px] tracking-wider uppercase text-wx-mute font-semibold">
                  Subscribers · {subsCount}
                </div>
                <button
                  onClick={() => setShowSubs((v) => !v)}
                  className={`relative inline-flex h-4 w-7 items-center rounded-full transition ${showSubs ? 'bg-sky-400' : 'bg-wx-line'}`}
                  aria-pressed={showSubs}
                  title={showSubs ? 'Hide subscriber pins' : 'Show subscriber pins'}
                >
                  <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition ${showSubs ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
                </button>
              </div>
              <p className="text-[10px] text-wx-mute mb-2">
                {subsCount === 0
                  ? 'No active subscribers with a known location yet.'
                  : showSubs ? 'Cyan dots are active subscribers. Click a pin to open their profile.' : 'Pins hidden.'}
              </p>

              <div className="flex items-center justify-between mb-3">
                <div className="text-[10px] text-wx-mute">
                  Coverage heatmap{subsCount > 0 ? ` · dim = gap` : ''}
                </div>
                <button
                  onClick={() => setShowCoverage((v) => !v)}
                  className={`relative inline-flex h-4 w-7 items-center rounded-full transition ${showCoverage ? 'bg-emerald-400' : 'bg-wx-line'}`}
                  aria-pressed={showCoverage}
                  title={showCoverage ? 'Hide coverage heatmap' : 'Show coverage heatmap'}
                >
                  <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition ${showCoverage ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
                </button>
              </div>

              <div className="-mb-1 border-t border-wx-line/30 pt-2 text-[9px] font-semibold uppercase tracking-[0.15em] text-wx-mute/70">
                Alerts &amp; storm-scale
              </div>
              <div className="flex items-center justify-between mb-1">
                <div className="text-[10.5px] tracking-wider uppercase text-wx-mute font-semibold">
                  NWS alerts · {displayWarnings.length}
                  {scrubTimeMs != null && warnings.length !== displayWarnings.length
                    ? <span className="text-wx-mute font-normal normal-case"> / {warnings.length} loaded</span>
                    : null}
                  {warningsLoading ? <span className="text-wx-mute font-normal normal-case"> · updating</span> : null}
                </div>
                <button
                  onClick={() => setShowNws((v) => !v)}
                  className={`relative inline-flex h-4 w-7 items-center rounded-full transition ${showNws ? 'bg-amber-400' : 'bg-wx-line'}`}
                  aria-pressed={showNws}
                  title={showNws ? 'Hide NWS polygons' : 'Show NWS polygons'}
                >
                  <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition ${showNws ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
                </button>
              </div>
              {showNws && (
                <div className="grid grid-cols-2 gap-x-3 gap-y-1 mb-2 text-[10.5px]">
                  <CategoryCheckbox label="Warnings" tint="text-red-300" on={catWarnings}      toggle={() => setCatWarnings((v) => !v)}      count={warnings.filter((w) => ['warning'].includes(w.category)).length} />
                  <CategoryCheckbox label="Watches"  tint="text-yellow-200" on={catWatches}    toggle={() => setCatWatches((v) => !v)}        count={warnings.filter((w) => w.category === 'watch').length} />
                  <CategoryCheckbox label="Advisories" tint="text-violet-200" on={catAdvisories} toggle={() => setCatAdvisories((v) => !v)} count={warnings.filter((w) => w.category === 'advisory').length} />
                  <CategoryCheckbox label="SPC MDs"  tint="text-fuchsia-200" on={catDiscussions} toggle={() => setCatDiscussions((v) => !v)} count={warnings.filter((w) => w.category === 'discussion').length} />
                </div>
              )}
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] text-wx-mute">
                  Storm tracks · {stormTrackCount} storm{stormTrackCount === 1 ? '' : 's'}
                  {stormTrackCount === 0 ? ' (none with NWS motion data)' : ''}
                </span>
                <button
                  onClick={() => setShowStormTracks((v) => !v)}
                  className={`relative inline-flex h-4 w-7 items-center rounded-full transition ${showStormTracks ? 'bg-sky-400' : 'bg-wx-line'}`}
                  aria-pressed={showStormTracks}
                  title={showStormTracks ? 'Hide storm tracks' : 'Show storm tracks'}
                >
                  <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition ${showStormTracks ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
                </button>
              </div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] text-wx-mute">
                  Storm reports · {displayLsrGeo.features?.length ?? 0} (last 6h)
                </span>
                <button
                  onClick={() => setShowLsr((v) => !v)}
                  className={`relative inline-flex h-4 w-7 items-center rounded-full transition ${showLsr ? 'bg-red-400' : 'bg-wx-line'}`}
                  aria-pressed={showLsr}
                  title={showLsr ? 'Hide NWS storm reports' : 'Show NWS storm reports'}
                >
                  <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition ${showLsr ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
                </button>
              </div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] text-wx-mute">
                  Subscriber reports · {displayStormReportsGeo.features?.length ?? 0} (last 24h)
                </span>
                <button
                  onClick={() => setShowStormReports((v) => !v)}
                  className={`relative inline-flex h-4 w-7 items-center rounded-full transition ${showStormReports ? 'bg-red-400' : 'bg-wx-line'}`}
                  aria-pressed={showStormReports}
                  title={showStormReports ? 'Hide subscriber storm reports' : 'Show subscriber storm reports'}
                >
                  <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition ${showStormReports ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
                </button>
              </div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] text-wx-mute">
                  Lightning (GLM) · {lightningGeo.features.length} flash{lightningGeo.features.length === 1 ? '' : 'es'}
                </span>
                <button
                  onClick={() => setShowLightning((v) => !v)}
                  className={`relative inline-flex h-4 w-7 items-center rounded-full transition ${showLightning ? 'bg-yellow-400' : 'bg-wx-line'}`}
                  aria-pressed={showLightning}
                  title={showLightning ? 'Hide GOES-19 GLM lightning' : 'Show GOES-19 GLM lightning'}
                >
                  <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition ${showLightning ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
                </button>
              </div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] text-wx-mute">
                  Rotation IDs · {coupletGeo.features?.length ?? 0} active
                  {coupletsSwr.isLoading && showCouplets ? ' · updating' : ''}
                </span>
                <button
                  onClick={() => setShowCouplets((v) => !v)}
                  className={`relative inline-flex h-4 w-7 items-center rounded-full transition ${showCouplets ? 'bg-fuchsia-400' : 'bg-wx-line'}`}
                  aria-pressed={showCouplets}
                  title={showCouplets ? 'Hide NEXRAD velocity-couplet IDs' : 'Show NEXRAD velocity-couplet IDs'}
                >
                  <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition ${showCouplets ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
                </button>
              </div>
              {/* ProbSevere 3.0 — object-based ML severe probabilities. */}
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] text-wx-mute">
                  ProbSevere · {probSevereDrawn.count} cell{probSevereDrawn.count === 1 ? '' : 's'}
                  {probSevereDrawn.max >= 1 ? ` · max ${probSevereDrawn.max}%` : ''}
                  {showProbSevere && probSevereSwr.isLoading ? ' · updating' : ''}
                </span>
                <button
                  onClick={() => setShowProbSevere((v) => !v)}
                  className={`relative inline-flex h-4 w-7 items-center rounded-full transition ${showProbSevere ? 'bg-rose-500' : 'bg-wx-line'}`}
                  aria-pressed={showProbSevere}
                  title={showProbSevere ? 'Hide ProbSevere ML storm objects' : 'Show ProbSevere ML storm objects'}
                >
                  <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition ${showProbSevere ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
                </button>
              </div>
              {/* Ranked ProbSevere threats — tap a row to fly to the cell + open
                  its ML readout. Top-down triage instead of hunting polygons. */}
              {showProbSevere && probSevereTop.length > 0 && (
                <div className="mb-2 ml-0.5 space-y-1">
                  {probSevereTop.map((c) => {
                    const dot =
                      c.topType === 'tor' ? 'bg-red-500'
                      : c.topType === 'hail' ? 'bg-cyan-400'
                      : c.topType === 'wind' ? 'bg-blue-400'
                      : 'bg-amber-400';
                    const t = probSevereTrend[c.id];
                    const hot = !!t && (t.dProb >= 8 || t.dFlash >= 4);
                    // Tendency arrow from the probability delta since last scan.
                    const arrow = !t || Math.abs(t.dProb) < 1 ? null : t.dProb > 0 ? '▲' : '▼';
                    return (
                      <button
                        key={c.id || `${c.center[0]},${c.center[1]}`}
                        type="button"
                        onClick={() => {
                          mapRef.current?.flyTo({ center: c.center, zoom: 8, duration: 700 });
                          setProbSeverePopup({
                            lng: c.center[0], lat: c.center[1],
                            topType: c.topType, topProb: c.topProb,
                            severe: c.severe, tor: c.tor, hail: c.hail, wind: c.wind,
                            readout: c.readout,
                            me: c.me, ms: c.ms,
                          });
                        }}
                        className={`flex w-full items-center justify-between gap-2 rounded-md border px-2 py-1 text-left hover:border-wx-accent ${hot ? 'border-yellow-400/70 bg-yellow-400/10' : 'border-wx-line bg-wx-ink'}`}
                      >
                        <span className="flex items-center gap-1.5">
                          <span className={`inline-block h-1.5 w-1.5 rounded-full ${dot}`} />
                          <span className="font-mono text-[10.5px] font-semibold text-wx-fg">{c.topProb}%</span>
                          {arrow ? (
                            <span className={`text-[9px] ${t!.dProb > 0 ? 'text-rose-400' : 'text-sky-400'}`}>
                              {arrow}{Math.abs(t!.dProb)}
                            </span>
                          ) : null}
                          <span className="text-[9px] uppercase tracking-wider text-wx-mute">{c.topType}</span>
                          {hot ? <span className="text-[9px] font-semibold text-yellow-300">⚠ {t!.dProb >= 8 ? 'intensifying' : 'ltg jump'}</span> : null}
                        </span>
                        {c.id ? <span className="font-mono text-[9px] text-wx-mute">#{c.id.slice(-4)}</span> : null}
                      </button>
                    );
                  })}
                </div>
              )}
              <div className="-mb-1 border-t border-wx-line/30 pt-2 text-[9px] font-semibold uppercase tracking-[0.15em] text-wx-mute/70">
                Observations &amp; base
              </div>
              {/* F13: mPING crowdsource reports overlay. */}
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] text-wx-mute">
                  mPING reports · {mpingGeo.features?.length ?? 0} (last 3h)
                  {showMping && mpingSwr.isLoading ? ' · updating' : ''}
                </span>
                <button
                  onClick={() => setShowMping((v) => !v)}
                  className={`relative inline-flex h-4 w-7 items-center rounded-full transition ${showMping ? 'bg-orange-400' : 'bg-wx-line'}`}
                  aria-pressed={showMping}
                  title={showMping ? 'Hide mPING crowdsource reports' : 'Show mPING crowdsource reports'}
                >
                  <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition ${showMping ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
                </button>
              </div>
              {/* F12: METAR surface obs overlay. */}
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] text-wx-mute">
                  METAR obs · {metarGeo.features?.length ?? 0} stations
                  {showMetar && metarSwr.isLoading ? ' · updating' : ''}
                </span>
                <button
                  onClick={() => setShowMetar((v) => !v)}
                  className={`relative inline-flex h-4 w-7 items-center rounded-full transition ${showMetar ? 'bg-cyan-400' : 'bg-wx-line'}`}
                  aria-pressed={showMetar}
                  title={showMetar ? 'Hide METAR surface obs' : 'Show METAR surface obs'}
                >
                  <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition ${showMetar ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
                </button>
              </div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] text-wx-mute" title="TDOT SmartWay cameras — click a dot on the map for a live snapshot">
                  Traffic cams (TDOT) · {trafficCamCount}
                </span>
                <button
                  onClick={() => setShowTrafficCams((v) => !v)}
                  className={`relative inline-flex h-4 w-7 items-center rounded-full transition ${showTrafficCams ? 'bg-cyan-400' : 'bg-wx-line'}`}
                  aria-pressed={showTrafficCams}
                  title={showTrafficCams ? 'Hide TDOT traffic cameras' : 'Show TDOT traffic cameras'}
                >
                  <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition ${showTrafficCams ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
                </button>
              </div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] text-wx-mute">
                  NWS zones · forecast + fire
                </span>
                <button
                  onClick={() => setShowZones((v) => !v)}
                  className={`relative inline-flex h-4 w-7 items-center rounded-full transition ${showZones ? 'bg-slate-400' : 'bg-wx-line'}`}
                  aria-pressed={showZones}
                  title={showZones ? 'Hide NWS zone outlines' : 'Show NWS zone outlines'}
                >
                  <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition ${showZones ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
                </button>
              </div>

              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] text-wx-mute">
                  NEXRAD site pills · {mapPillSites.length}
                </span>
                <button
                  onClick={() => setShowSitePills((v) => !v)}
                  className={`relative inline-flex h-4 w-7 items-center rounded-full transition ${showSitePills ? 'bg-amber-400' : 'bg-wx-line'}`}
                  aria-pressed={showSitePills}
                  title={showSitePills ? 'Hide NEXRAD site pills (selected site still shown)' : 'Show NEXRAD site pills'}
                >
                  <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition ${showSitePills ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
                </button>
              </div>

              {/* LibreWxR CAP polygons — sky-blue dashed overlay, complementary
                  to the NWS warning layer. Use to spot-check what the CAP
                  pipeline catches relative to NWS. */}
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] text-wx-mute" title="Common Alerting Protocol feed via LibreWxR — cross-check against the NWS layer">
                  2nd-source alerts (CAP) · {capWarningsGeo.features.length}
                </span>
                <button
                  onClick={() => setShowCap((v) => !v)}
                  className={`relative inline-flex h-4 w-7 items-center rounded-full transition ${showCap ? 'bg-sky-400' : 'bg-wx-line'}`}
                  aria-pressed={showCap}
                  title={showCap ? 'Hide LibreWxR CAP polygons' : 'Show LibreWxR CAP polygons'}
                >
                  <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition ${showCap ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
                </button>
              </div>

              {/* F7: SPC convective outlook row + day picker. */}
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] text-wx-mute">
                  SPC outlook · Day {spcDay}
                  {activeSpc?.highest_label ? ` · ${activeSpc.highest_label}` : ''}
                </span>
                <button
                  onClick={() => setShowSpc((v) => !v)}
                  className={`relative inline-flex h-4 w-7 items-center rounded-full transition ${showSpc ? 'bg-orange-400' : 'bg-wx-line'}`}
                  aria-pressed={showSpc}
                  title={showSpc ? 'Hide SPC outlook' : 'Show SPC outlook'}
                >
                  <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition ${showSpc ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
                </button>
              </div>
              {showSpc && (
                <div className="mb-2">
                  <div className="flex gap-1 mb-1">
                    {([1, 2, 3] as const).map((d) => {
                      const row = spcDays.find((r) => r.day_number === d);
                      const label = row?.highest_label ?? '—';
                      const active = spcDay === d;
                      return (
                        <button
                          key={d}
                          onClick={() => setSpcDay(d)}
                          className={`flex-1 px-2 py-1 rounded text-[10px] font-mono border transition ${active ? 'bg-wx-ink border-orange-400 text-wx-fg' : 'bg-wx-ink/40 border-wx-line text-wx-mute hover:text-wx-fg'}`}
                          title={row?.valid_from ? `Valid ${new Date(row.valid_from).toLocaleString()}` : 'Outlook not yet available'}
                        >
                          Day {d} · {label}
                        </button>
                      );
                    })}
                  </div>
                  {activeSpc?.issued_at ? (
                    <div className="text-[9.5px] font-mono text-wx-mute">
                      Issued {new Date(activeSpc.issued_at).toLocaleString([], {
                        month: 'short',
                        day: 'numeric',
                        hour: 'numeric',
                        minute: '2-digit',
                      })}
                    </div>
                  ) : (
                    <div className="text-[9.5px] text-wx-mute">No outlook fetched yet for Day {spcDay}.</div>
                  )}
                </div>
              )}
            </div>

              </>)}
            </div>
            )}

            {inspectorTab === 'threats' && (
            <div className="border-t border-wx-line/40 pt-3 flex flex-col gap-[18px]">
              <div className="text-[10.5px] tracking-wider uppercase text-wx-mute font-semibold">Active alerts</div>
              {(<>

            <div>
              {selectedWarning && (() => {
                const tint = alertTint(selectedWarning.category, selectedWarning.hazard, selectedWarning.severity);
                return (
                <div className={`mb-3 p-3 rounded-lg bg-wx-ink border ${tint.border} ${tint.bg} space-y-1.5`}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className={`text-[11px] font-semibold ${tint.text}`}>{selectedWarning.event}</div>
                      {selectedWarning.ai_summary ? (
                        <p className="text-[10.5px] text-wx-fg/90 mt-0.5 line-clamp-3">
                          {selectedWarning.ai_summary}
                        </p>
                      ) : selectedWarning.headline ? (
                        <p className="text-[10.5px] text-wx-fg/85 mt-0.5 line-clamp-3">{selectedWarning.headline}</p>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      onClick={() => setSelectedWarning(null)}
                      className="text-wx-mute hover:text-wx-fg shrink-0"
                      aria-label="Clear selection"
                    >
                      <X size={14} />
                    </button>
                  </div>
                  <div className="text-[10px] text-wx-mute">
                    {categoryBadge(selectedWarning.category)} · {selectedWarning.severity ?? '—'} · until{' '}
                    {selectedWarning.expires_at
                      ? new Date(selectedWarning.expires_at).toLocaleString([], {
                          month: 'short',
                          day: 'numeric',
                          hour: 'numeric',
                          minute: '2-digit',
                        })
                      : '—'}
                  </div>
                  <div className="flex items-center justify-between gap-2 pt-1">
                    <a href={`/nws/${selectedWarning.id}`} className="text-[11px] text-wx-accent font-medium">
                      Full NWS detail →
                    </a>
                    <a
                      href={composeUrlForWarning(selectedWarning)}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-wx-accent text-black rounded-md text-[11px] font-semibold hover:bg-amber-300"
                      title="Send to subscribers in this polygon"
                    >
                      <Send size={11} /> Send to polygon
                    </a>
                  </div>
                  <button
                    type="button"
                    onClick={() => openWarningSounding(selectedWarning)}
                    className="mt-1 inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 border border-wx-line text-wx-fg hover:border-wx-accent hover:bg-wx-accent/5 rounded-md text-[11px] font-medium w-full"
                    title="Model Skew-T at this polygon's centroid — read the storm environment"
                  >
                    <Atom size={11} /> Environmental sounding
                  </button>
                  {selectedWarning.forecast_track && selectedWarning.in_path_count != null ? (
                    (() => {
                      const trackUrl = composeUrlForWarningTrack(selectedWarning);
                      if (!trackUrl) return null;
                      return (
                        <a
                          href={trackUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-1 inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 border border-amber-400/50 text-amber-300 hover:bg-amber-400/10 rounded-md text-[11px] font-semibold w-full"
                          title={`Send to ${selectedWarning.in_path_count} subscribers in the storm's projected ${selectedWarning.in_path_corridor_km ?? 8}km corridor`}
                        >
                          <Send size={11} />
                          Send to path · {selectedWarning.in_path_count} in {selectedWarning.in_path_corridor_km ?? 8}km
                        </a>
                      );
                    })()
                  ) : null}
                </div>
                );
              })()}
              <div className="flex flex-col gap-1 max-h-40 overflow-y-auto wx-scroll">
                {displayWarnings.slice(0, 12).map((w) => (
                  <div
                    key={w.id}
                    className={`flex items-center gap-2 p-2 rounded-lg bg-wx-ink border ${
                      selectedWarning?.id === w.id ? 'border-wx-accent' : 'border-wx-line'
                    } hover:border-wx-accent`}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedWarning(w);
                        focusWarning(w);
                      }}
                      className="flex items-center gap-2 flex-1 min-w-0 text-left"
                    >
                      <span
                        className={`px-1.5 py-0.5 text-[9px] rounded shrink-0 ${
                          w.category === 'warning' && w.hazard === 'tornado'
                            ? 'bg-red-500/20 text-red-300'
                            : w.category === 'warning' && w.hazard === 'severe'
                              ? 'bg-orange-500/20 text-orange-300'
                              : w.category === 'warning' && w.hazard === 'flood'
                                ? 'bg-emerald-500/20 text-emerald-300'
                                : w.category === 'watch'
                                  ? 'bg-yellow-500/20 text-yellow-200'
                                  : w.category === 'advisory'
                                    ? 'bg-violet-500/20 text-violet-200'
                                    : w.category === 'discussion' && w.severity === 'Extreme'
                                      ? 'bg-red-500/20 text-red-300'
                                      : w.category === 'discussion' && w.severity === 'Severe'
                                        ? 'bg-orange-500/20 text-orange-300'
                                        : w.category === 'discussion' && w.severity === 'Minor'
                                          ? 'bg-sky-500/20 text-sky-300'
                                          : w.category === 'discussion'
                                            ? 'bg-fuchsia-500/20 text-fuchsia-200'
                                            : 'bg-slate-500/20 text-slate-300'
                        }`}
                      >
                        {categoryBadge(w.category)}
                      </span>
                      <div className="min-w-0">
                        <div className="text-[11.5px] font-semibold truncate">{w.event}</div>
                        <div className="text-[10px] text-wx-mute truncate">
                          {w.area_desc ?? '—'} · until{' '}
                          {w.expires_at
                            ? new Date(w.expires_at).toLocaleTimeString([], {
                                hour: 'numeric',
                                minute: '2-digit',
                              })
                            : '—'}
                        </div>
                        {w.in_path_count != null && w.in_path_count > 0 ? (
                          <div className="text-[9.5px] mt-0.5 text-amber-300/90 font-mono">
                            ⟶ {w.in_path_count} in path
                            {w.in_path_corridor_km ? ` (${w.in_path_corridor_km}km)` : ''}
                          </div>
                        ) : null}
                      </div>
                    </button>
                    {w.category === 'warning' && (
                      <a
                        href={composeUrlForWarning(w)}
                        target="_blank"
                        rel="noreferrer"
                        className="shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-md text-wx-mute hover:text-wx-accent hover:bg-wx-accent/10"
                        title="Send to subscribers in this polygon"
                        aria-label={`Send to subscribers in ${w.event} polygon`}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Send size={12} />
                      </a>
                    )}
                  </div>
                ))}
                {displayWarnings.length === 0 && !warningsLoading && (
                  <p className="text-[11px] text-wx-mute">
                    {scrubTimeMs == null
                      ? 'No active NWS polygons with geometry right now.'
                      : 'No warnings were active at the scrubbed timestamp.'}
                  </p>
                )}
              </div>
              <div className="flex flex-wrap gap-2 mt-2 text-[9px] text-wx-mute">
                <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-red-500/60" /> Warning</span>
                <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-sm border border-yellow-400 border-dashed" /> Watch</span>
                <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-violet-400/40" /> Advisory</span>
                <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-fuchsia-500/50" /> SPC MD</span>
                <span className="inline-flex items-center gap-1 w-full mt-1">
                  <span className="w-4 h-0.5 bg-orange-400 rounded" /> Track
                  <span className="w-4 h-0.5 border-t border-dashed border-orange-400/80" /> 1h forecast
                </span>
              </div>
            </div>

              </>)}
            </div>
            )}

            {inspectorTab === 'models' && (
            <div className="flex flex-col gap-[18px]">
              {(<>

            <div>
              <div className="text-[10.5px] tracking-wider uppercase text-wx-mute font-semibold mb-1">
                Area Forecast Discussions
              </div>
              <AfdPanel />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <div className="text-[10.5px] tracking-wider uppercase text-wx-mute font-semibold">
                  Forecast overlay
                </div>
                {activeModel ? (
                  <button
                    type="button"
                    onClick={() => setModelOverlay(null)}
                    className="text-[10px] text-wx-mute hover:text-wx-fg"
                  >
                    Clear ✕
                  </button>
                ) : null}
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                {(Object.keys(MODEL_OVERLAYS) as ModelOverlayKey[]).map((k) => {
                  const m = MODEL_OVERLAYS[k];
                  const on = modelOverlay === k;
                  return (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setModelOverlay(on ? null : k)}
                      className={`text-left px-2 py-1.5 rounded border text-[10.5px] font-semibold transition ${
                        on
                          ? 'border-wx-accent bg-wx-accent/10 text-wx-accent'
                          : 'border-wx-line text-wx-mute hover:text-wx-fg'
                      }`}
                      title={m.label}
                    >
                      <div>{m.short}</div>
                      <div className="text-[9px] font-normal text-wx-mute mt-0.5">{m.source}</div>
                    </button>
                  );
                })}
                {DISABLED_MODELS.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    disabled
                    className="text-left px-2 py-1.5 rounded border border-wx-line text-[10.5px] font-semibold text-wx-mute opacity-40 cursor-not-allowed"
                    title={d.why}
                  >
                    <div>{d.label}</div>
                    <div className="text-[9px] font-normal text-wx-mute mt-0.5">no public WMS</div>
                  </button>
                ))}
              </div>

              {activeModel ? (
                <div className="mt-3 space-y-2">
                  <div className="flex items-center justify-between text-[10.5px]">
                    <span className="text-wx-mute">Hour</span>
                    <span className="font-mono text-wx-fg">{activeModel.hourLabel(modelHour)}</span>
                  </div>
                  <input
                    type="range"
                    min={activeModel.hours.min}
                    max={activeModel.hours.max}
                    step={activeModel.hours.step}
                    value={modelHour}
                    onChange={(e) => setModelHour(parseInt(e.target.value, 10))}
                    className="wx-slider"
                  />
                  <div className="flex items-center justify-between text-[10.5px]">
                    <span className="text-wx-mute">Opacity</span>
                    <span className="font-mono text-wx-fg">{modelOpacity}%</span>
                  </div>
                  <input
                    type="range"
                    min={20}
                    max={100}
                    step={2}
                    value={modelOpacity}
                    onChange={(e) => setModelOpacity(parseInt(e.target.value, 10))}
                    className="wx-slider"
                  />
                  <p className="text-[10px] text-wx-mute leading-snug">{activeModel.legend}</p>
                  <p className="text-[9.5px] text-wx-mute/80">{activeModel.attribution}</p>
                </div>
              ) : (
                <p className="mt-2 text-[10px] text-wx-mute">
                  Pick a model to overlay forecast guidance on the live radar. Cleared on next refresh.
                </p>
              )}
            </div>

              </>)}
            </div>
            )}

            <div className="border-t border-wx-line/40 pt-3">
              <div className="text-[10.5px] tracking-wider uppercase text-wx-mute font-semibold mb-1">Pointer</div>
              <div className="space-y-0.5 text-[11px] font-mono">
                <div className="flex justify-between"><span className="text-wx-mute">Lat</span><span>{hoverPixel ? hoverPixel.lat.toFixed(4) : '—'}</span></div>
                <div className="flex justify-between"><span className="text-wx-mute">Lon</span><span>{hoverPixel ? hoverPixel.lng.toFixed(4) : '—'}</span></div>
                <div className="flex justify-between"><span className="text-wx-mute">Sample</span><span className={hoverPixel && hoverPixel.sample != null ? 'text-wx-accent' : 'text-wx-mute'}>{sampleLabel}</span></div>
              </div>
            </div>
          </div>
          </>
  );
}
