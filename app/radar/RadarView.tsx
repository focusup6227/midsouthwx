'use client';

// Patches mapbox-gl 3.24's removeSource() to swallow a known terrain-race
// crash on Source unmount. Must run before any <Map> renders — keep this
// import at the very top of the module so it's evaluated first.
import '@/lib/mapbox/patch-remove-source';

import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import Map, { Source, Layer, Popup, type MapMouseEvent, type MapRef } from 'react-map-gl';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import {
  AnnotationLayer,
  AnnotationToolbar,
  useRadarAnnotations,
} from './_components/RadarAnnotations';
import { supabaseBrowser } from '@/lib/supabase/client';
import { mapboxAccessToken, mapboxStyleUrl } from '@/lib/supabase/env';
import {
  Wind, Satellite,
  Play, Pause, Trash2, Send, Target, X,
  ChevronLeft, ChevronDown, Eye, EyeOff, MousePointer2, Zap,
  PenTool, AlertTriangle,
} from 'lucide-react';
import {
  NEXRAD_SITES,
  NEXRAD_SITES_BY_CODE,
  nearestSites,
  searchSites,
  distanceKm,
  type RadarSite,
} from '@/lib/radar/sites';
import { alertTint, categoryBadge, geometryCentroid, nwsAlertPriority, shortNwsLocation, type NwsRadarAlert } from '@/lib/nws/radar';
import { STORM_TRACK_LINE_COLOR } from '@/lib/nws/storm-tracks';
import {
  useWarnings,
  useLsr,
  useSpc,
  useSubs,
  useCapWarnings,
  useLightning,
  useCouplets,
  useMetar,
  useMping,
  useStormReports,
  useStormReportClusters,
  useProbSevere,
  WARNINGS_KEY,
  STORM_REPORTS_KEY,
  STORM_REPORT_CLUSTERS_KEY,
} from './_hooks/useRadarData';
import { useSWRConfig } from 'swr';
import RadarInspector, { type InspectorTab } from './_components/RadarInspector';
import QuickComposePanel from './_components/QuickComposePanel';
import RecentSends from './_components/RecentSends';
import {
  PRODUCTS,
  GOES_SOURCES,
  satTileUrl,
  DEFAULT_SITE_CODE,
  type GoesSourceId,
  type ProductKey,
  type SatSourceId,
} from './_components/radar-products';
import {
  LsrCard,
  StormReportCard,
  MpingCard,
  MetarCard,
  CoupletCard,
  type SelectedLsr,
  type SelectedStormReport,
  type SelectedMping,
  type SelectedMetar,
  type SelectedCouplet,
} from './_components/SelectedEntityCards';
import { parseRadarUrl, useRadarUrlSync } from './_hooks/useRadarUrlState';
import { useLevel2Data } from './_hooks/useLevel2Data';
import { useLwxrTimeline, type LibreWxRFrame } from './_hooks/useLwxrTimeline';
import { MODEL_OVERLAYS, type ModelOverlayKey } from '@/lib/radar/models';
import {
  buildFillColorExpr,
  buildFillOpacityExpr,
  SEL_POLY_FILL_PAINT,
  SEL_POLY_LINE_PAINT,
  SPC_FILL_EXPR,
  SPC_LINE_EXPR,
  LSR_FILL_EXPR,
  STORM_REPORT_FILL_EXPR,
  LWXR_FRAME_PAINT,
  WARNING_FILL_PAINT,
  WARNING_LINE_PAINT,
  WARNING_LINE_WATCH_PAINT,
  WARNING_LINE_DISCUSSION_PAINT,
} from '@/lib/radar/layer-styles';

// PRODUCTS / GOES_SOURCES / satTileUrl / DEFAULT_SITE_CODE moved to
// ./_components/radar-products so RadarInspector can share them without a
// circular import.

const NCEP_WMS_URL = (workspace: string, layer: string, cacheKey: number) =>
  `https://opengeo.ncep.noaa.gov/geoserver/${workspace}/ows` +
  `?service=WMS&request=GetMap&version=1.3.0` +
  `&layers=${encodeURIComponent(layer)}&styles=` +
  `&format=image/png&transparent=true` +
  `&width=256&height=256&crs=EPSG:3857` +
  `&bbox={bbox-epsg-3857}` +
  `&_t=${cacheKey}`;

// IEM RIDGE single-site NEXRAD via the RIDGE WMS (layers=single = latest scan).
// IEM keeps these pre-rendered, so GetMap returns near-instantly — vs. the
// 30–90 s Py-ART Level II render — letting default single-site reflectivity/
// velocity paint immediately. PRODUCT CODES: IEM stopped rendering the legacy
// N0Q (base refl) / N0U (base vel) in 2023 — those return a stale 3-yr-old scan!
// The CURRENT live products are the super-res set:
//   N0B = super-res base reflectivity, N0S = storm-relative velocity.
// (N0Q/N0U kept in the type only as a reminder of what NOT to use.) Hi-res
// Level II (Py-ART) stays opt-in for true base velocity + dual-pol + sampling.
// `sector` is the 3-letter site id (ICAO minus leading K/P/T). Attribution: IEM.
const IEM_RIDGE_URL = (site: string, prod: 'N0B' | 'N0S', cacheKey: number) =>
  `https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/ridge.cgi` +
  `?service=WMS&request=GetMap&version=1.1.1` +
  `&layers=single&sector=${site.toUpperCase().slice(1)}&prod=${prod}&styles=` +
  `&format=image/png&transparent=true` +
  // 512px tiles: a full viewport is ~9 GetMaps instead of ~35, so IEM's CGI
  // doesn't shed the initial burst with 503s (it tolerates the smaller fan-out).
  `&width=512&height=512&srs=EPSG:3857` +
  `&bbox={bbox-epsg-3857}` +
  `&_t=${cacheKey}`;

const THREDDS_WMS_URL = (urlPath: string, layer: string, cacheKey: number) =>
  `https://thredds.ucar.edu/thredds/wms/${urlPath}` +
  `?service=WMS&request=GetMap&version=1.3.0` +
  `&layers=${encodeURIComponent(layer)}&styles=raster%2Fdefault` +
  `&format=image/png&transparent=true` +
  `&width=256&height=256&crs=EPSG:3857` +
  `&bbox={bbox-epsg-3857}` +
  `&_t=${cacheKey}`;

// LibreWxR Weather Maps API (drop-in for RainViewer v2). Returns 2h of past
// frames + nowcast. Default color scheme 9 = NWS Reflectivity (matches
// radar.weather.gov); 8 = Dark Sky. Operator picks via the dropdown — see
// LIBREWXR_COLOR_SCHEMES in ./_components/RadarInspector. Options "1_1" =
// smoothed + snow-aware. 512px
// tiles double the spatial resolution at the same z (max zoom 7), so imagery
// stays readable down to the city block at z~11. (The index URL itself lives
// in _hooks/useLwxrTimeline.)
const LIBREWXR_COLOR = 9;
const LIBREWXR_OPTS = '1_1';
const LIBREWXR_TILE_SIZE = 512;
const LIBREWXR_MAX_ZOOM = 7;

// Cap geographic map pills by zoom — kept aggressive so dense areas (TX, OK)
// don't carpet the map. Past z8 every site in view shows.
function mapPillCapForZoom(zoom: number): number {
  if (zoom >= 8) return Infinity;
  if (zoom >= 7) return 24;
  if (zoom >= 6) return 12;
  if (zoom >= 5) return 6;
  return 0;
}

function sitePillId(code: string): string {
  return code.replace(/^K/, '');
}

function sitePillLabel(site: RadarSite, zoom: number): string {
  const id = sitePillId(site.code);
  if (zoom >= 8) {
    const city = site.name.split(/[\s(/]/)[0];
    return `${id} · ${city}`;
  }
  return id;
}

type Selection = {
  type: 'circle';
  center: [number, number];
  radius_km: number;
} | {
  type: 'polygon';
  coordinates: number[][];
};

type NwsWarning = NwsRadarAlert;

type AudienceBreakdown = { total: number; tn: number; ms: number; ar: number; other: number };

// GLM lightning: each flash lives 2 min on screen. Opacity 1 at strike time,
// linearly to 0 at fadeMs. nowMs is rebound imperatively at 1 Hz below.
const LIGHTNING_FADE_MS = 120_000;
const LIGHTNING_BOLT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 36" width="48" height="72"><path d="M14 0 L0 22 L9 22 L7 36 L24 12 L13 12 L18 0 Z" fill="#fde047" stroke="#0b1220" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg>`;

// Small top-of-map banner shown on first load if any required env var is
// missing. Listed by name + short rationale so the operator knows what's
// broken without digging into logs. Dismiss is per-session (sessionStorage).
function EnvPreflightBanner({ items }: { items: string[] }) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  return (
    <div className="absolute top-4 left-1/2 -translate-x-1/2 z-30 max-w-[680px] px-3 py-2 rounded-lg border border-red-500 bg-red-500/15 backdrop-blur-sm shadow-lg text-red-200 text-[11.5px] flex items-start gap-3">
      <div className="flex-1 min-w-0">
        <div className="font-bold tracking-wider uppercase text-[10px] text-red-300">
          Radar environment incomplete
        </div>
        <ul className="mt-1 space-y-0.5 list-disc list-inside">
          {items.map((m, i) => (
            <li key={i} className="text-red-200/90">{m}</li>
          ))}
        </ul>
      </div>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="shrink-0 text-red-300 hover:text-red-200"
        aria-label="Dismiss"
      >
        <X size={14} />
      </button>
    </div>
  );
}

// F2: preferred order for the compose body seed when launching from a
// warning: AI summary → headline → truncated description → null. The radar
// warnings endpoint doesn't return description today, so headline is the
// realistic last resort.
function warningBodySeed(w: NwsRadarAlert): string | null {
  if (w.ai_summary && w.ai_summary.trim()) return w.ai_summary.trim();
  if (w.headline && w.headline.trim()) return w.headline.trim();
  return null;
}

type SpcDayInitial = {
  day_number: number;
  geojson: GeoJSON.FeatureCollection;
  issued_at: string | null;
  valid_from: string | null;
  valid_until: string | null;
  highest_label: string | null;
};

export type RadarViewProps = {
  initialSubsGeo?: GeoJSON.FeatureCollection;
  initialSpcDays?: SpcDayInitial[];
  initialWarnings?: {
    warnings: NwsRadarAlert[];
    geojson: GeoJSON.FeatureCollection;
    tracks: GeoJSON.FeatureCollection;
  };
  envWarnings?: string[];
};

export default function RadarView({ initialSubsGeo, initialSpcDays, initialWarnings, envWarnings }: RadarViewProps = {}) {
  // SWR-managed remote data. Dedupe, focus-revalidation off, retry-on-error
  // built in — replaces the manual polling effects + in-flight refs that
  // lived here before.
  const subsSwr = useSubs(initialSubsGeo);
  const subsGeo: any = subsSwr.data ?? { type: 'FeatureCollection', features: [] };
  const warningsSwr = useWarnings(initialWarnings);
  const warnings = (warningsSwr.data?.warnings ?? []) as NwsWarning[];
  const warningsGeo = (warningsSwr.data?.geojson ?? { type: 'FeatureCollection', features: [] }) as GeoJSON.FeatureCollection;
  const tracksGeo = (warningsSwr.data?.tracks ?? { type: 'FeatureCollection', features: [] }) as GeoJSON.FeatureCollection;
  const warningsLoading = warningsSwr.isValidating;
  const lsrSwr = useLsr();
  const lsrGeo = (lsrSwr.data?.geojson ?? { type: 'FeatureCollection', features: [] }) as GeoJSON.FeatureCollection;
  const stormReportsSwr = useStormReports();
  const stormReportsGeo = (stormReportsSwr.data?.geojson ?? { type: 'FeatureCollection', features: [] }) as GeoJSON.FeatureCollection;
  const stormReportClustersSwr = useStormReportClusters();
  const stormReportClustersGeo = (stormReportClustersSwr.data?.geojson ?? { type: 'FeatureCollection', features: [] }) as GeoJSON.FeatureCollection;
  const spcSwr = useSpc(initialSpcDays);
  // MRMS rotation (Az-Shear) overlay retired: UCAR THREDDS decommissioned its
  // MRMS GRIB collection (the latest.xml 404s), and no free source serves the
  // convective MRMS grids as web tiles anymore. Rotation decisions now come from
  // ProbSevere (per-cell az-shear + the full readout) and the velocity-couplet
  // "Rotation IDs" overlay (renderer-based, still live). Kept as a null constant
  // so the now-hidden rotation product's code paths stay inert.
  const mrmsUrlPath: string | null = null;
  const { mutate: swrMutate } = useSWRConfig();

  // Hydrate from URL once. RadarView is dynamic(ssr:false) so `window` is
  // always defined here. Subsequent state changes write back via
  // useRadarUrlSync below.
  const urlInitial = typeof window !== 'undefined' ? parseRadarUrl(window.location.search) : {};

  const [product, setProduct] = useState<ProductKey>(
    (urlInitial.product as ProductKey) ?? 'composite',
  );
  const [selectedSite, setSelectedSite] = useState<string | null>(urlInitial.site ?? null);
  // Default OFF: single-site refl/vel paints from instant IEM RIDGE tiles. The
  // 30–90 s Py-ART Level II render is opt-in (toggle) for pinpoint single-site
  // detail + click-to-sample gate values. A shared ?hiRes=1 link still honors it.
  const [hiRes, setHiRes] = useState(urlInitial.hiRes ?? false);
  // PNG is the default hi-res path: mercator-correct raster + value-grid
  // sidecar for the pointer readout. Toggling this off falls back to the
  // heavyweight GeoJSON polygon path (8–15 MB gzipped on super-res sweeps).
  const [pngFallback, setPngFallback] = useState(true);
  const [selectedElevation, setSelectedElevation] = useState<number | 'composite'>(0.5);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [drawMode, setDrawMode] = useState<'none' | 'polygon' | 'snap' | 'pick-site'>('none');
  const [polygonPoints, setPolygonPoints] = useState<[number, number][]>([]);

  // Survive reloads: an active selection or half-drawn polygon is operator
  // work product — a crash, deploy, or stray refresh mid-outbreak must not
  // erase it. sessionStorage scopes recovery to this tab; transient modes
  // (snap / pick-site) are deliberately not restored.
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem('midsouthwx:radar-selection');
      if (!raw) return;
      const s = JSON.parse(raw) as {
        selection?: Selection | null;
        drawMode?: string;
        polygonPoints?: [number, number][];
      };
      if (s.selection && (s.selection.type === 'circle' || s.selection.type === 'polygon')) {
        setSelection(s.selection);
      }
      if (s.drawMode === 'polygon') setDrawMode('polygon');
      if (Array.isArray(s.polygonPoints) && s.polygonPoints.length > 0) {
        setPolygonPoints(s.polygonPoints);
      }
    } catch {
      /* corrupt entry — start clean */
    }
  }, []);
  useEffect(() => {
    try {
      if (!selection && drawMode !== 'polygon' && polygonPoints.length === 0) {
        sessionStorage.removeItem('midsouthwx:radar-selection');
      } else {
        sessionStorage.setItem(
          'midsouthwx:radar-selection',
          JSON.stringify({
            selection,
            drawMode: drawMode === 'polygon' ? 'polygon' : 'none',
            polygonPoints,
          }),
        );
      }
    } catch {
      /* storage unavailable */
    }
  }, [selection, drawMode, polygonPoints]);
  // 5 min buckets — NCEP base reflectivity itself only updates every ~4–6 min
  // (one full NEXRAD VCP), so anything faster just forces tile refetches for
  // identical imagery and tanks the buttery feel during pan/zoom.
  const [tileCacheKey, setTileCacheKey] = useState(() => Math.floor(Date.now() / 300_000));

  // LibreWxR storm-motion arrow overlay (radar tiles only — satellite ignores).
  const [showArrows, setShowArrows] = useState(urlInitial.showArrows ?? true);
  // LibreWxR color scheme (1..9 — see LIBREWXR_COLOR_SCHEMES). Radar tiles only.
  const [colorScheme, setColorScheme] = useState(urlInitial.colorScheme ?? 9);
  // Satellite source: LibreWxR modeled IR (animated) or a real GOES-East band
  // served single-frame live via NASA GIBS WMTS.
  const [satSource, setSatSource] = useState<SatSourceId>(
    (urlInitial.satSource as SatSourceId | undefined) ?? 'lwxr',
  );
  // CAP alert polygons (LibreWxR pipeline) as a secondary overlay alongside
  // the NWS warning polygons. Off by default — observation-only until
  // operator opts in.
  const [showCap, setShowCap] = useState(urlInitial.showCap ?? false);
  const capSwr = useCapWarnings(showCap);
  const capWarningsGeo = (capSwr.data?.geojson ?? { type: 'FeatureCollection', features: [] }) as GeoJSON.FeatureCollection;

  const [opacity, setOpacity] = useState(urlInitial.opacity ?? 100);
  const [showNws, setShowNws] = useState(urlInitial.showNws ?? true);
  // Per-category gates under the master NWS toggle. All on by default. When
  // showNws is off the master overrides; when on, these whittle which polygon
  // types render on the map AND show up in the inspector list.
  const [catWarnings, setCatWarnings] = useState(true);
  const [catWatches, setCatWatches] = useState(true);
  const [catAdvisories, setCatAdvisories] = useState(true);
  const [catDiscussions, setCatDiscussions] = useState(true);
  const [showStormTracks, setShowStormTracks] = useState(urlInitial.showStormTracks ?? true);
  // F4: Local Storm Reports overlay. Pulled separately from warnings on a
  // gentler cadence (every 2 min) — LSRs filter in slowly as spotters call
  // them in, no need to refresh as aggressively as the warnings polygons.
  const [showLsr, setShowLsr] = useState(urlInitial.showLsr ?? true);
  // Telegram-submitted subscriber storm reports. Default on; toggle in inspector.
  const [showStormReports, setShowStormReports] = useState(urlInitial.showStormReports ?? true);
  // Cluster ring pulse phase (0 ↔ 1) — drives circle-opacity on the cluster
  // layer so the operator sees a slow heartbeat at active cluster centroids.
  // 2 s period, paused when no clusters are active to avoid wasted renders.
  const [clusterPulse, setClusterPulse] = useState(0);
  const [selectedStormReport, setSelectedStormReport] = useState<SelectedStormReport | null>(null);
  // NWS forecast + fire zone outlines from /public/maps/nws-zones.geojson
  // (run `npm run gen:zones` to rebuild). Off by default — useful for
  // "which zone is this alert in" reference but visually busy when always
  // on.
  const [showZones, setShowZones] = useState(urlInitial.showZones ?? false);
  const [selectedLsr, setSelectedLsr] = useState<SelectedLsr | null>(null);
  // F13: selected mPING report popover state.
  const [selectedMping, setSelectedMping] = useState<SelectedMping | null>(null);
  // F12: selected METAR station popover state.
  const [selectedMetar, setSelectedMetar] = useState<SelectedMetar | null>(null);
  // F9: selected NEXRAD velocity-couplet — popover shows shear, site, age,
  // and how many volume scans this rotation has been seen on. `lat`/`lon`
  // round-tripped from the GeoJSON so an "alert from this rotation" CTA
  // can pre-fill a compose with a tight circle around the point.
  const [selectedCouplet, setSelectedCouplet] = useState<SelectedCouplet | null>(null);

  // F7: SPC convective outlooks. One stored row per Day 1/2/3; client picks
  // which day to render. Off by default so the radar stays uncluttered
  // unless the operator is actively previewing risk.
  const spcDays = spcSwr.data?.days ?? [];
  const [showSpc, setShowSpc] = useState(urlInitial.showSpc ?? false);
  const [spcDay, setSpcDay] = useState<1 | 2 | 3>(1);
  const [selectedWarning, setSelectedWarning] = useState<NwsWarning | null>(null);
  // Warning → environmental sounding. Click a warning's "Sounding" action to
  // pull a model Skew-T at the polygon centroid (reuses /api/forecast/sounding,
  // GFS column → MetPy). Lets the operator read the storm environment without
  // leaving the radar. Held in a small modal state with its own load/error.
  const [warningSounding, setWarningSounding] = useState<
    { label: string; lat: number; lon: number; imageUrl: string | null; loading: boolean; error: string | null } | null
  >(null);
  const openWarningSounding = useCallback(async (w: NwsWarning) => {
    const [lon, lat] = w.centroid;
    setWarningSounding({ label: w.event, lat, lon, imageUrl: null, loading: true, error: null });
    try {
      const r = await fetch(`/api/forecast/sounding?lat=${lat}&lon=${lon}`);
      const d = await r.json();
      setWarningSounding((s) =>
        s && s.lat === lat && s.lon === lon
          ? { ...s, loading: false, imageUrl: d.image_url ?? null, error: d.image_url ? null : (d.error ?? 'no_image') }
          : s,
      );
    } catch {
      setWarningSounding((s) => (s && s.lat === lat && s.lon === lon ? { ...s, loading: false, error: 'fetch_failed' } : s));
    }
  }, []);
  // Map popup anchored at the polygon click location. `candidates` holds every
  // warning whose polygon was under the click, deduped by id, so overlapping
  // warnings render a chooser instead of silently picking the topmost one.
  // When `candidates.length === 1` we render the single-warning detail card
  // directly; otherwise the operator picks one from the list.
  const [warningPopup, setWarningPopup] = useState<{
    lng: number;
    lat: number;
    candidates: NwsWarning[];
    chosenId: string | null;
  } | null>(null);
  const [probSeverePopup, setProbSeverePopup] = useState<{
    lng: number;
    lat: number;
    topType: string;
    topProb: number;
    severe: number;
    tor: number;
    hail: number;
    wind: number;
    readout: string;
    me: number; // motion east m/s — for the warn-from-cell projected corridor
    ms: number; // motion south m/s
  } | null>(null);
  const [hoverPixel, setHoverPixel] = useState<{ lng: number; lat: number; sample: number | null } | null>(null);
  const [hoverSub, setHoverSub] = useState<any | null>(null);
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [audienceBreakdown, setAudienceBreakdown] = useState<AudienceBreakdown>({ total: 0, tn: 0, ms: 0, ar: 0, other: 0 });

  const [showSubs, setShowSubs] = useState(urlInitial.showSubs ?? true);
  // Coverage heatmap — Mapbox heatmap layer on the same subs-source so dim
  // regions = potential blind spots during an event. Default off so it
  // doesn't compete with the pin layer for visual attention; the operator
  // turns it on during recruitment planning or briefing time.
  const [showCoverage, setShowCoverage] = useState(urlInitial.showCoverage ?? false);
  const subsCount = subsGeo.features?.length ?? 0;

  // Default the inspector closed on phones — the 304px panel would otherwise
  // cover most of the viewport on first paint and bury the map. Desktop users
  // (and operators who explicitly opened the inspector before) still see it
  // expanded thanks to the URL flag check.
  const [inspectorCollapsed, setInspectorCollapsed] = useState(() => {
    if (urlInitial.inspectorCollapsed !== undefined) return urlInitial.inspectorCollapsed;
    if (typeof window !== 'undefined' && window.matchMedia?.('(max-width: 767px)').matches) {
      return true;
    }
    return false;
  });
  const [uiHidden, setUiHidden] = useState(urlInitial.uiHidden ?? false);
  // Mobile-only: the draw tools collapse into a popover menu and the warning
  // chips collapse into a single "N alerts" button that opens a bottom sheet.
  const [toolsMenuOpen, setToolsMenuOpen] = useState(false);
  const [alertsSheetOpen, setAlertsSheetOpen] = useState(false);
  const [showSitePills, setShowSitePills] = useState(urlInitial.showSitePills ?? true);
  const [showLightning, setShowLightning] = useState(urlInitial.showLightning ?? false);
  // F9: NEXRAD velocity-couplet rotation IDs. Default off — these are noisy
  // outside an active severe-weather event and the cron pipeline only fills
  // the table when the renderer has fresh Level II to scan.
  const [showCouplets, setShowCouplets] = useState(urlInitial.showCouplets ?? false);
  const coupletsSwr = useCouplets(showCouplets);
  const coupletGeo = (coupletsSwr.data?.geojson ?? { type: 'FeatureCollection', features: [] }) as GeoJSON.FeatureCollection;
  const coupletTracks = (coupletsSwr.data?.tracks ?? { type: 'FeatureCollection', features: [] }) as GeoJSON.FeatureCollection;

  // ProbSevere 3.0 — object-based ML severe probabilities. Default off (CONUS
  // feed, most useful during active convection); the headline nowcasting aid.
  const [showProbSevere, setShowProbSevere] = useState(urlInitial.showProbSevere ?? false);
  const probSevereSwr = useProbSevere(showProbSevere);
  // Nowcast mode — one tap to the storm-scale decision layout (warnings +
  // ProbSevere + rotation IDs + lightning + storm reports). Tapping again clears
  // the noisy convective overlays back to a clean map (warnings/LSR stay — they
  // matter regardless). Not URL-persisted: it's an action, not a saved view.
  const [nowcastOn, setNowcastOn] = useState(false);
  const probSevereGeo = (probSevereSwr.data ?? { type: 'FeatureCollection', features: [] }) as GeoJSON.FeatureCollection;
  // Cells actually drawn (≥1% severe signal) — what the map shows, so the
  // toggle count never claims more than is visible. The highest prob in view
  // surfaces the day's ceiling at a glance.
  const probSevereDrawn = useMemo(() => {
    let count = 0;
    let max = 0;
    for (const f of probSevereGeo.features) {
      const p = Number((f.properties as { topProb?: number } | null)?.topProb ?? 0);
      if (p >= 1) count++;
      if (p > max) max = p;
    }
    return { count, max };
  }, [probSevereGeo]);

  // Ranked threat list — the highest-probability cells, so the operator triages
  // top-down instead of hunting polygons on the map. Each row flies the map to
  // the cell and opens its readout popup. Mirrors the toggle's "N cells" count
  // (≥1% drawn signal), sorted by probability, capped at 8 to stay compact.
  const probSevereTop = useMemo(() => {
    const rows = probSevereGeo.features
      .map((f) => {
        const p = (f.properties ?? {}) as Record<string, number | string>;
        const geom = f.geometry as GeoJSON.Polygon | GeoJSON.MultiPolygon | null;
        if (!geom || (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon')) return null;
        return {
          id: String(p.ID ?? ''),
          topType: String(p.topType ?? 'severe'),
          topProb: Number(p.topProb ?? 0),
          severe: Number(p.ProbSevere ?? 0),
          tor: Number(p.ProbTor ?? 0),
          hail: Number(p.ProbHail ?? 0),
          wind: Number(p.ProbWind ?? 0),
          readout: String(p.readout ?? ''),
          center: geometryCentroid(geom),
          // ProbSevere storm motion components (m/s). East = +x, South = +y.
          me: Number(p.MOTION_EAST ?? 0),
          ms: Number(p.MOTION_SOUTH ?? 0),
        };
      })
      .filter((r): r is NonNullable<typeof r> => !!r && r.topProb >= 1)
      .sort((a, b) => b.topProb - a.topProb)
      .slice(0, 8);
    return rows;
  }, [probSevereGeo]);

  // Projected motion for the ranked cells — the heart of nowcasting. ProbSevere
  // ships each cell's motion (m/s east/south); we extrapolate the centroid out
  // to +15/+30/+45 min and draw a vector + tick marks, so the operator sees
  // *where a cell is going*, not just where it is. Lines + ticks in separate
  // FeatureCollections (Mapbox layers filter by geometry type).
  const probSevereMotion = useMemo(() => {
    const lines: GeoJSON.Feature[] = [];
    const ticks: GeoJSON.Feature[] = [];
    const STEPS = [15, 30, 45];
    for (const c of probSevereTop) {
      const speed = Math.hypot(c.me, c.ms); // m/s
      if (speed < 0.5) continue; // ~1 kt floor — skip near-stationary cells
      const [lon, lat] = c.center;
      const cosLat = Math.cos((lat * Math.PI) / 180) || 1e-6;
      const project = (min: number): [number, number] => {
        const dt = min * 60; // s
        const dxM = c.me * dt; // east meters
        const dyM = -c.ms * dt; // north meters (south is +y, so north is −)
        return [lon + dxM / (111320 * cosLat), lat + dyM / 111320];
      };
      const speedKt = Math.round(speed * 1.94384);
      lines.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [c.center, ...STEPS.map(project)] },
        properties: { topType: c.topType, speedKt },
      });
      for (const min of STEPS) {
        ticks.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: project(min) },
          properties: { topType: c.topType, min, label: min === 45 ? `+45m · ${speedKt}kt` : `+${min}` },
        });
      }
    }
    return {
      lines: { type: 'FeatureCollection' as const, features: lines },
      ticks: { type: 'FeatureCollection' as const, features: ticks },
    };
  }, [probSevereTop]);

  // ProbSevere trend — diff successive snapshots (the feed has persistent cell
  // IDs + per-cell ENI flash rate) to get each cell's probability tendency (↑/↓)
  // and lightning-jump (flash-rate surge). Trend builds after the first ~2-min
  // refresh; the first load has no prior snapshot to compare against. This is
  // the "is it intensifying" signal that turns a snapshot into a nowcast.
  // Plain Record, not Map — `Map` is shadowed by the react-map-gl component import.
  const probSeverePrevRef = useRef<Record<string, { prob: number; flash: number }>>({});
  const [probSevereTrend, setProbSevereTrend] = useState<Record<string, { dProb: number; dFlash: number }>>({});
  useEffect(() => {
    const prev = probSeverePrevRef.current;
    const nextSnap: Record<string, { prob: number; flash: number }> = {};
    const trend: Record<string, { dProb: number; dFlash: number }> = {};
    for (const f of probSevereGeo.features) {
      const p = (f.properties ?? {}) as Record<string, number | string>;
      const id = String(p.ID ?? '');
      if (!id) continue;
      const prob = Number(p.topProb ?? 0);
      const flash = Number(p.FLASH_RATE ?? 0);
      nextSnap[id] = { prob, flash };
      const old = prev[id];
      if (old) trend[id] = { dProb: prob - old.prob, dFlash: flash - old.flash };
    }
    probSeverePrevRef.current = nextSnap;
    setProbSevereTrend(trend);
  }, [probSevereGeo]);

  // Rapidly-intensifying cells — a prob jump (≥8 pts) or lightning jump (flash
  // rate ≥+4/min) since the last scan. Surfaced as a ring on the map + a badge
  // in the threat list so the operator's eye is pulled to escalating storms.
  const probSevereHot = useMemo(() => {
    const features: GeoJSON.Feature[] = [];
    for (const c of probSevereTop) {
      const t = probSevereTrend[c.id];
      if (!t) continue;
      if (t.dProb >= 8 || t.dFlash >= 4) {
        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: c.center },
          properties: { reason: t.dProb >= 8 ? `↑${t.dProb}%` : `⚡+${Math.round(t.dFlash)}` },
        });
      }
    }
    return { type: 'FeatureCollection' as const, features };
  }, [probSevereTop, probSevereTrend]);

  // F10: MRMS MESH (Max Estimated Size of Hail) overlay. Translucent raster
  // layered on top of whatever the operator's looking at — keeps the
  // reflectivity context while showing where hail has actually fallen in
  // the last 30/60/120 min. 30 min is the operational default.
  // MESH (MRMS Max Estimated Size of Hail) overlay retired alongside rotation —
  // same dead THREDDS source. Per-cell hail size now lives in the ProbSevere
  // readout (MESH in inches). State kept (read-only) for URL back-compat; the
  // hook is hard-gated off so it never polls the decommissioned endpoint.
  const [showMesh] = useState(urlInitial.showMesh ?? false);
  const [meshWindow] = useState<30 | 60 | 120>(urlInitial.meshWindow ?? 30);
  const meshUrlPath: string | null = null;

  // F12: METAR surface obs. Compact "station plot lite" — temp-colored pin,
  // wind arrow (rotated to direction wind is going TOWARD), and a text
  // label at higher zoom levels. Clicking a station opens a popup with
  // the raw METAR.
  const [showMetar, setShowMetar] = useState(urlInitial.showMetar ?? false);
  const metarSwr = useMetar(showMetar);
  const metarGeo = (metarSwr.data?.geojson ?? { type: 'FeatureCollection', features: [] }) as GeoJSON.FeatureCollection;

  // F13: mPING crowdsource reports. Pinned with a diamond glyph (vs the
  // circular LSR pin) so the operator can tell at a glance that this is
  // citizen-submitted, lower-confidence ground truth.
  const [showMping, setShowMping] = useState(urlInitial.showMping ?? false);
  const mpingSwr = useMping(showMping);
  const mpingGeo = (mpingSwr.data?.geojson ?? { type: 'FeatureCollection', features: [] }) as GeoJSON.FeatureCollection;
  // Inspector is organized into tabs (one group visible at a time) rather than a
  // long scroll of collapsible sections — far less scrolling, clearer IA:
  //   Threats → threat board + active alerts (the triage/decision surface)
  //   Layers  → all overlay toggles
  //   Source  → radar source / site / product settings
  //   Models  → models & discussion
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('threats');

  // Split view (Phase 4 v1). When non-null, the map area splits horizontally
  // and renders a second NCEP raster source for the chosen product on the
  // right side, with the camera synced imperatively. v1 only renders radar
  // tiles on the right pane — warnings/tracks/LSRs/subs stay on the left so
  // the operator has a single "data" pane and a "compare" pane.
  const [splitProduct, setSplitProduct] = useState<ProductKey | null>(null);
  const altMapRef = useRef<MapRef>(null);

  // Forecast model overlay. When set, renders an additional raster source on
  // top of radar tiles (below admin/labels) with its own opacity + forecast
  // hour. Independent of the radar product so the operator can keep observed
  // reflectivity below and a model REFC forecast on top.
  const [modelOverlay, setModelOverlay] = useState<ModelOverlayKey | null>(null);
  const activeModel = modelOverlay ? MODEL_OVERLAYS[modelOverlay] : null;
  const [modelHour, setModelHour] = useState<number>(activeModel?.hours.default ?? 1);
  const [modelOpacity, setModelOpacity] = useState<number>(70);
  // When the active overlay changes, snap the hour back into its valid range.
  useEffect(() => {
    if (!activeModel) return;
    setModelHour((h) => {
      const { min, max, step } = activeModel.hours;
      const clamped = Math.max(min, Math.min(max, h));
      return Math.round(clamped / step) * step;
    });
  }, [activeModel]);


  // Round-trip radar state through ?s=KNQA&p=velocity&hr=1… so /radar URLs are
  // shareable and survive refresh.
  useRadarUrlSync({
    site: selectedSite,
    product,
    hiRes,
    opacity,
    showNws,
    showSpc,
    showLsr,
    showStormReports,
    showCoverage,
    showZones,
    showSubs,
    showStormTracks,
    showArrows,
    colorScheme,
    satSource,
    showCap,
    inspectorCollapsed,
    uiHidden,
    showSitePills,
    showLightning,
    showCouplets,
    showProbSevere,
    showMesh,
    meshWindow,
    showMetar,
    showMping,
  });

  const mapCursor = drawMode !== 'none' ? 'crosshair' : 'grab';

  // Start the camera on the URL-selected site, not a fixed Mid-South default —
  // otherwise loading/reloading a `?s=<site>` link (the site persists in the URL
  // but the map center does not) leaves the camera over Memphis while requesting
  // the selected single-site radar there, which is outside that radar's range
  // and paints nothing. The interactive picker already flyTo()s; this fixes the
  // cold-load / shared-link / reload path.
  const initialSite = urlInitial.site ? NEXRAD_SITES_BY_CODE[urlInitial.site.toUpperCase()] : null;
  const initialView = initialSite
    ? { longitude: initialSite.center[0], latitude: initialSite.center[1], zoom: initialSite.zoom }
    : { longitude: -89.8, latitude: 35.0, zoom: 7 };
  const [viewState, setViewState] = useState(initialView);
  // Settled viewport — only changes on `moveend`. Memos that do expensive
  // work (nearestSites sort, distance ranking) depend on this, NOT on the
  // live `viewState`, so they don't recompute 60×/sec during pan.
  const [settledView, setSettledView] = useState(initialView);

  // Single-site picker state. siteQuery drives the search box; pickerSites is
  // derived (search matches when there's a query, otherwise the N closest
  // NEXRAD sites to the picker center — cursor when hovering, settled
  // viewport otherwise).
  const [siteQuery, setSiteQuery] = useState('');
  const [pickerCenter, setPickerCenter] = useState<[number, number] | null>(null);
  const pickerSites = useMemo<RadarSite[]>(() => {
    if (siteQuery.trim()) return searchSites(siteQuery, 48);
    const center = pickerCenter ?? [settledView.longitude, settledView.latitude];
    return nearestSites(center, 12);
  }, [siteQuery, settledView.longitude, settledView.latitude, pickerCenter]);

  // Debounce hoverPixel into pickerCenter so the Nearest list follows the
  // cursor — but only when the cursor has settled for 250ms (the raw stream
  // fires every frame during mouse motion).
  useEffect(() => {
    if (!hoverPixel) return;
    const lng = hoverPixel.lng;
    const lat = hoverPixel.lat;
    const t = setTimeout(() => setPickerCenter([lng, lat]), 250);
    return () => clearTimeout(t);
  }, [hoverPixel?.lng, hoverPixel?.lat]);

  // Last few NEXRAD sites the operator picked, persisted in localStorage so
  // the rotation across favorites is one click after a refresh.
  const [recentSiteCodes, setRecentSiteCodes] = useState<string[]>(() => {
    if (typeof window === 'undefined') return [];
    try {
      const raw = window.localStorage.getItem('radar:recent-sites');
      if (!raw) return [];
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];
      return arr.filter((x): x is string => typeof x === 'string' && /^[A-Z]{4}$/.test(x)).slice(0, 5);
    } catch {
      return [];
    }
  });
  useEffect(() => {
    if (!selectedSite) return;
    setRecentSiteCodes((prev) => {
      const next = [selectedSite, ...prev.filter((c) => c !== selectedSite)].slice(0, 5);
      try {
        window.localStorage.setItem('radar:recent-sites', JSON.stringify(next));
      } catch {
        // localStorage can throw in private mode — recent list is best-effort.
      }
      return next;
    });
  }, [selectedSite]);

  const mapRef = useRef<MapRef>(null);
  const token = mapboxAccessToken();
  const styleUrl = mapboxStyleUrl();
  const [radarBeforeId, setRadarBeforeId] = useState<string | null>(null);

  // Presentation/annotation overlay — pen, arrow, polygon, circle, text.
  // Disabled while another draw tool (audience polygon, snap, pick-site)
  // is active so the two systems don't fight for the same mouse events.
  const annotations = useRadarAnnotations(mapRef, drawMode !== 'none');

  useEffect(() => {
    if (token) {
      mapboxgl.accessToken = token;
    }
  }, [token]);

  // Anchor the radar *just below the first line or symbol layer* in the style.
  // Mapbox stacks layers in array order: background → fills (water, landuse) →
  // lines (waterways, roads, admin) → symbols (labels). Inserting before the
  // first non-fill layer pushes the radar above terrain/water but keeps every
  // road, county/state boundary, and label rendered on top of the radar.
  //
  // Then re-paint the road / boundary / label layers so they stay legible on
  // top of bright reflectivity. dark-v11's defaults are intentionally subtle
  // for a black basemap and disappear over yellow/red radar pixels.
  const resolvedBeforeIdRef = useRef<string | null>(null);
  // Per-layer-id cache of which Mapbox layers have already had their boost ops
  // applied. Re-running the boost is idempotent — a Set lets us safely re-fire
  // on `styledata` events without paying for setPaintProperty hundreds of times.
  const boostedLayersRef = useRef<Set<string>>(new Set());
  // Set true when the loaded style uses Mapbox's v3 Standard "imports"
  // architecture (e.g. a fork of mapbox/standard). Standard styles bury their
  // layers behind a slot system; `beforeId` and our dark-v11-shaped label
  // boost don't apply. We instead anchor our tiles + overlays via `slot`.
  const [isStandardStyle, setIsStandardStyle] = useState(false);
  // Computed once-per-style-shape: where radar tiles go (under roads + labels)
  // vs where overlays go (above labels). Each is spread onto its <Layer />.
  //   - Flat (dark-v11): tiles get `beforeId`, overlays get nothing (appended on top).
  //   - Standard imports: tiles get `slot: 'bottom'` (above water/land, below
  //     roads + labels); overlays get `slot: 'top'` (above everything).
  //     `middle` puts tiles above roads — wrong for a radar underlay.
  const tileAnchor = useMemo<Record<string, unknown>>(() => {
    if (isStandardStyle) return { slot: 'bottom' };
    return radarBeforeId ? { beforeId: radarBeforeId } : {};
  }, [isStandardStyle, radarBeforeId]);
  const overlayAnchor = useMemo<Record<string, unknown>>(() => {
    if (isStandardStyle) return { slot: 'top' };
    return {};
  }, [isStandardStyle]);
  const viewportSyncedRef = useRef(false);
  // Flips true once Mapbox fires `load`. Effects that imperatively call
  // setPaintProperty depend on it so they re-run after react-map-gl is
  // actually able to register sources/layers (before this point, getLayer
  // returns undefined even though the JSX mounted them).
  const [mapReady, setMapReady] = useState(false);

  type Bounds = { west: number; east: number; south: number; north: number };
  const [mapBounds, setMapBounds] = useState<Bounds | null>(null);
  // `mapPos.k` is just a tick counter — incrementing it on every map `move`
  // event forces a re-render so site-pill `screenPoint(...)` positions follow
  // the map smoothly during pan. Width/height stay for future use but aren't
  // read today.
  const [mapPos, setMapPos] = useState({ w: 0, h: 0, k: 0 });

  // Light, fires at 60 Hz during pan. Only bumps the tick counter so the pill
  // layer can re-project its DOM positions. No bounds query, no sorts.
  const kickMapPos = useCallback(() => {
    setMapPos((p) => ({ w: p.w, h: p.h, k: p.k + 1 }));
  }, []);

  // Heavy, fires once when the user lets go of the map. Updates bounds and the
  // settled viewport, which together trigger the picker/pill list recomputes.
  const settleMapViewport = useCallback(() => {
    const map = mapRef.current?.getMap();
    if (!map) return;
    const b = map.getBounds();
    if (b) {
      setMapBounds({
        west: b.getWest(),
        east: b.getEast(),
        south: b.getSouth(),
        north: b.getNorth(),
      });
    }
    const c = map.getCenter();
    setSettledView({ longitude: c.lng, latitude: c.lat, zoom: map.getZoom() });
    setMapPos((p) => ({
      w: map.getContainer().clientWidth,
      h: map.getContainer().clientHeight,
      k: p.k + 1,
    }));
  }, []);

  void mapPos;

  // GLM bbox is rounded to ~1 km so tiny pan jitters don't churn the SWR key.
  // Hook is gated by showLightning so we don't poll the renderer when the
  // overlay is off (default).
  const lightningBbox = useMemo<readonly [number, number, number, number] | null>(() => {
    if (!mapBounds) return null;
    const r = (n: number) => Math.round(n * 100) / 100;
    return [r(mapBounds.west), r(mapBounds.south), r(mapBounds.east), r(mapBounds.north)] as const;
  }, [mapBounds]);
  const lightningSwr = useLightning(showLightning, lightningBbox);
  const lightningGeo = (lightningSwr.data ?? { type: 'FeatureCollection', features: [] }) as GeoJSON.FeatureCollection;

  const boostBasemapLegibility = useCallback((map: mapboxgl.Map) => {
    const layers = map.getStyle()?.layers ?? [];

    type Op = { kind: 'paint' | 'layout'; id: string; prop: string; value: any };
    const ops: Op[] = [];
    const boosted = boostedLayersRef.current;
    const tryPaint = (id: string, prop: string, value: any) => {
      ops.push({ kind: 'paint', id, prop, value });
    };
    const tryLayout = (id: string, prop: string, value: any) => {
      ops.push({ kind: 'layout', id, prop, value });
    };

    // Dark-v11 sublayer IDs that add visual noise behind radar without giving
    // the operator any useful spatial context. Hiding them de-clutters the map
    // so warnings, tracks, and radar pixels are what the eye lands on.
    // Airports stay visible — they're common reference points during wx ops.
    const isNuisance = (id: string, type: string) => {
      if (type !== 'fill' && type !== 'fill-extrusion' && type !== 'symbol' && type !== 'line' && type !== 'hillshade') return false;
      if (/airport/i.test(id)) return false;
      return (
        /^poi-label/i.test(id) ||
        /^transit-label/i.test(id) ||
        /^building/i.test(id) ||
        /^landuse(-overlay)?/i.test(id) ||
        /^hillshade/i.test(id) ||
        /^pitch/i.test(id) ||
        /^natural-(line|point-label)/i.test(id) ||
        /^aerialway/i.test(id)
      );
    };

    for (const layer of layers as any[]) {
      const id: string = layer.id || '';
      if (boosted.has(id)) continue;
      if (isNuisance(id, layer.type)) {
        tryLayout(id, 'visibility', 'none');
        continue;
      }
      const isMajorRoad   = /(motorway|trunk|primary)/i.test(id) && layer.type === 'line';
      const isMidRoad     = /(secondary|tertiary)/i.test(id) && layer.type === 'line';
      const isMinorRoad   = /(road|street|bridge|tunnel)/i.test(id) && layer.type === 'line' && !isMajorRoad && !isMidRoad;
      const isAdmin0      = /^admin-0/i.test(id) && layer.type === 'line';   // country
      const isAdmin1      = /^admin-1/i.test(id) && layer.type === 'line';   // state
      const isAdmin2      = /^admin-2/i.test(id) && layer.type === 'line';   // county
      // Catch every place/settlement/state/country label sublayer dark-v11
      // emits. Also boost airport names and waterway/water-body labels —
      // they render with the dark-v11 defaults (slate text, thin halo) which
      // disappear over yellow/red reflectivity.
      const isPlaceLabel  = (
        /settlement|place-label|place-|state-label|country-label|airport-label|waterway-label|water-(point|line)-label/i.test(id)
      ) && layer.type === 'symbol';
      // Highway/interstate shields and route number labels (I-40, US 51, etc).
      const isShield      = /shield/i.test(id) && layer.type === 'symbol';
      // Generic road name labels ("Poplar Ave", "Sam Cooper Blvd", …).
      const isRoadLabel   = /road-label|road-intersection/i.test(id) && layer.type === 'symbol';

      if (isMajorRoad) {
        tryPaint(id, 'line-color', '#fde047');                                          // bright yellow
        tryPaint(id, 'line-opacity', 1);
        tryPaint(id, 'line-width', ['interpolate', ['linear'], ['zoom'], 5, 1.5, 8, 2.8, 12, 5, 16, 9]);
      } else if (isMidRoad) {
        tryPaint(id, 'line-color', '#fcd34d');
        tryPaint(id, 'line-opacity', 0.95);
        tryPaint(id, 'line-width', ['interpolate', ['linear'], ['zoom'], 5, 0.6, 8, 1.6, 12, 3.5, 16, 6]);
      } else if (isMinorRoad) {
        tryPaint(id, 'line-color', '#e2e8f0');
        tryPaint(id, 'line-opacity', 0.85);
        tryPaint(id, 'line-width', ['interpolate', ['linear'], ['zoom'], 8, 0.4, 12, 1.2, 16, 3]);
      } else if (isAdmin0) {
        tryPaint(id, 'line-color', '#ffffff');
        tryPaint(id, 'line-opacity', 0.95);
        tryPaint(id, 'line-width', ['interpolate', ['linear'], ['zoom'], 4, 1.4, 10, 3]);
      } else if (isAdmin1) {
        tryPaint(id, 'line-color', '#f1f5f9');
        tryPaint(id, 'line-opacity', 0.9);
        tryPaint(id, 'line-width', ['interpolate', ['linear'], ['zoom'], 4, 1, 10, 2.4]);
        tryPaint(id, 'line-dasharray', [1, 0]);
      } else if (isAdmin2) {
        tryPaint(id, 'line-color', '#cbd5e1');
        tryPaint(id, 'line-opacity', 0.75);
        tryPaint(id, 'line-width', ['interpolate', ['linear'], ['zoom'], 6, 0.5, 12, 1.4]);
      } else if (isPlaceLabel) {
        // Beefier text + dark halo so city/town/state names stay readable on
        // top of bright radar pixels. Wider halo + no blur because anti-aliased
        // halos visibly soften the letters at the small sizes used at z<7.
        tryPaint(id, 'text-color', '#ffffff');
        tryPaint(id, 'text-halo-color', '#0b1220');
        tryPaint(id, 'text-halo-width', 2.6);
        tryPaint(id, 'text-halo-blur', 0);
        tryLayout(id, 'text-size', ['interpolate', ['linear'], ['zoom'], 4, 11, 8, 14, 12, 17, 16, 22]);
      } else if (isShield) {
        // Make the I-40 / US-51 / state route shields actually readable. Force
        // visible (some shield layers default to higher minzoom), scale the
        // icon up, and shrink the symbol-spacing so a shield appears more
        // frequently along long stretches of highway.
        tryLayout(id, 'visibility', 'visible');
        tryLayout(id, 'icon-size', ['interpolate', ['linear'], ['zoom'], 5, 0.8, 8, 1.1, 12, 1.4, 16, 1.7]);
        tryLayout(id, 'text-size', ['interpolate', ['linear'], ['zoom'], 5, 10, 8, 12, 12, 14, 16, 17]);
        tryLayout(id, 'symbol-spacing', 200);
        tryLayout(id, 'icon-allow-overlap', true);
        tryLayout(id, 'text-allow-overlap', false);
        tryPaint(id, 'icon-opacity', 1);
        tryPaint(id, 'text-color', '#ffffff');
        tryPaint(id, 'text-halo-color', '#0b1220');
        tryPaint(id, 'text-halo-width', 1.4);
      } else if (isRoadLabel) {
        // Street/road names. Brighten, halo, and uncap so names show at
        // moderate zooms on top of the radar wash.
        tryLayout(id, 'visibility', 'visible');
        tryLayout(id, 'text-size', ['interpolate', ['linear'], ['zoom'], 10, 10, 14, 13, 18, 16]);
        tryPaint(id, 'text-color', '#fef3c7');
        tryPaint(id, 'text-halo-color', '#0b1220');
        tryPaint(id, 'text-halo-width', 1.6);
      }
    }

    if (ops.length === 0) return;
    // Batch all paint/layout writes into one frame so Mapbox only fires
    // `styledata` once instead of ~50× during initial style hydration.
    requestAnimationFrame(() => {
      for (const op of ops) {
        try {
          if (op.kind === 'paint') (map.setPaintProperty as any)(op.id, op.prop, op.value);
          else (map.setLayoutProperty as any)(op.id, op.prop, op.value);
          boosted.add(op.id);
        } catch { /* layer may not exist in this style version */ }
      }
    });
  }, []);

  const handleMapLoad = useCallback(() => {
    const map = mapRef.current?.getMap();
    if (!map) return;
    // Pinch-to-zoom without two-finger rotate — Mapbox's combined handler
    // enables both by default; disableRotation() keeps zoom alive but stops
    // accidental compass spin during a casual pinch on a phone.
    try {
      const tzr = (map as unknown as { touchZoomRotate?: { disableRotation?: () => void } })
        .touchZoomRotate;
      tzr?.disableRotation?.();
    } catch {
      // Older mapbox-gl-js bundles may not expose touchZoomRotate; harmless.
    }
    // Detect Standard-imports styles. When detected, we anchor via Mapbox
    // slots ('middle' for radar, 'top' for overlays) instead of `beforeId`,
    // and skip the dark-v11-shaped label boost (Standard's layer IDs are
    // namespaced inside the import and our patches wouldn't match anyway).
    const styleObj = (map.getStyle?.() ?? null) as { imports?: unknown[] } | null;
    const standard = Array.isArray(styleObj?.imports) && (styleObj!.imports!.length > 0);
    if (standard) setIsStandardStyle(true);
    if (!resolvedBeforeIdRef.current && !standard) {
      const layers = map.getStyle()?.layers ?? [];
      // Anchor radar so it draws UNDER roads + admin boundaries + labels but
      // OVER water/landuse. Mapbox styles vary across forks, so try in order
      // of specificity:
      //   1. First road/tunnel/bridge layer (radar goes underneath roads).
      //   2. First admin boundary (next-best: still under labels).
      //   3. First non-water line/symbol/circle (legacy fallback).
      const isRoadId = (id: string) =>
        /^(road|tunnel|bridge|motorway|street|highway)(-|_|$)/i.test(id);
      const isAdminId = (id: string) => /^admin(-|_|$)/i.test(id);
      const isExcluded = (id: string) =>
        /water|waterway|hillshade|land-structure|landuse|natural|landcover|hill|park|wetland/i.test(id);

      const roadAnchor = layers.find((l: any) => isRoadId(l.id));
      const adminAnchor = !roadAnchor
        ? layers.find((l: any) => isAdminId(l.id))
        : null;
      const fallback = !roadAnchor && !adminAnchor
        ? layers.find((l: any) => {
            if (l.type !== 'line' && l.type !== 'symbol' && l.type !== 'circle') return false;
            return !isExcluded(l.id);
          })
        : null;
      const anchor = roadAnchor ?? adminAnchor ?? fallback;
      if (anchor) {
        resolvedBeforeIdRef.current = anchor.id;
        setRadarBeforeId(anchor.id);
      }
    }
    if (!viewportSyncedRef.current) {
      viewportSyncedRef.current = true;
      settleMapViewport();
      map.on('move', kickMapPos);
      map.on('moveend', settleMapViewport);
      map.on('resize', settleMapViewport);
      setMapReady(true);
    }
    // Boost only applies to flat dark-v11-shaped styles. For Standard, the
    // imported layers' IDs are out of reach via this path, so skip entirely.
    if (!standard) {
      map.once('idle', () => boostBasemapLegibility(map));
      map.on('styledata', () => boostBasemapLegibility(map));
    }
  }, [boostBasemapLegibility, kickMapPos, settleMapViewport]);

  // Imperative anchor enforcement. The Layer JSX may mount BEFORE handleMapLoad
  // sets radarBeforeId, in which case react-map-gl appends the radar layer to
  // the top of the stack and never moves it when the prop updates. Walk every
  // known radar/overlay layer id after each styledata event and reposition it
  // to either (a) the resolved beforeId, or (b) the first non-raster/background
  // layer we can find when the original anchor logic came up empty.
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !mapReady) return;
    // Standard styles handle position via slots — moveLayer doesn't apply.
    if (isStandardStyle) return;

    const repositionRadar = () => {
      const layers = map.getStyle()?.layers ?? [];
      // Find the first symbol (label) layer — that's the most reliable anchor
      // across custom styles: every Mapbox style has labels, and we want radar
      // under them. Beat that with the user-resolved road anchor when present.
      const firstSymbol = layers.find((l: { id: string; type?: string }) => l.type === 'symbol');
      const anchorId = radarBeforeId ?? firstSymbol?.id ?? null;
      if (!anchorId) return;

      // Every layer ID a radar source might register under: live tile layer,
      // LibreWxR per-frame layers, Level II fill/image layers, MRMS, lightning
      // raster, satellite. Move each one that exists below the anchor.
      const radarLayerPrefixes = [
        'live-radar',
        'lwxr-layer-',
        'level2-fill',
        'level2-image',
        'mrms-fill',
        'lightning-fill',
      ];
      for (const layer of layers) {
        const id = (layer as { id: string }).id;
        const isRadarLayer = radarLayerPrefixes.some((p) => id === p || id.startsWith(p));
        if (!isRadarLayer) continue;
        if (id === anchorId) continue;
        try {
          map.moveLayer(id, anchorId);
        } catch {
          // Anchor layer may have been removed between styledata fires; skip.
        }
      }
    };

    // First pass on mount (after handleMapLoad has populated radarBeforeId).
    repositionRadar();
    // Re-pass after every style change: new sources/layers appearing, style
    // swaps, paint property updates that internally re-add layers.
    map.on('styledata', repositionRadar);
    return () => {
      map.off('styledata', repositionRadar);
    };
  }, [mapReady, radarBeforeId, isStandardStyle]);

  useEffect(() => {
    const id = setInterval(() => setTileCacheKey(Math.floor(Date.now() / 300_000)), 300_000);
    return () => clearInterval(id);
  }, []);

  // Realtime channel — any insert/update on nws_alerts triggers an immediate
  // SWR revalidation. SWR dedupes against in-flight requests so a burst of
  // postgres changes only kicks off one re-fetch.
  useEffect(() => {
    const supa = supabaseBrowser();
    const channel = supa
      .channel('radar-nws')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'nws_alerts' },
        () => { swrMutate(WARNINGS_KEY); },
      )
      .subscribe();
    return () => {
      supa.removeChannel(channel);
    };
  }, [swrMutate]);

  const effectiveProduct: ProductKey = useMemo(() => {
    const meta = PRODUCTS[product];
    if (selectedSite && !meta.modes.site) return 'reflectivity';
    if (!selectedSite && !meta.modes.composite) return 'composite';
    return product;
  }, [product, selectedSite]);

  // Mirror the main map's camera onto the right (split) pane. jumpTo doesn't
  // fire Mapbox `move` events, so there's no feedback loop. Right pane has
  // interactions disabled in its <Map> props so the operator can only drive
  // the camera from the left pane.
  useEffect(() => {
    if (!splitProduct) return;
    const m = altMapRef.current?.getMap();
    if (!m) return;
    m.jumpTo({
      center: [viewState.longitude, viewState.latitude],
      zoom: viewState.zoom,
    });
  }, [splitProduct, viewState.longitude, viewState.latitude, viewState.zoom]);

  // Auto-clear split when its preconditions break:
  //   - no site selected (CONUS / LibreWxR mode), or
  //   - main product isn't reflectivity/velocity, or
  //   - main product == split product (would render the same thing twice).
  useEffect(() => {
    if (!splitProduct) return;
    if (!selectedSite) { setSplitProduct(null); return; }
    if (effectiveProduct !== 'reflectivity' && effectiveProduct !== 'velocity') {
      setSplitProduct(null);
      return;
    }
    if (splitProduct === effectiveProduct) {
      setSplitProduct(effectiveProduct === 'reflectivity' ? 'velocity' : 'reflectivity');
    }
  }, [splitProduct, selectedSite, effectiveProduct]);

  const level2Product =
    effectiveProduct === 'velocity' ? 'vel'
    : effectiveProduct === 'correlation' ? 'cc'
    : effectiveProduct === 'zdr' ? 'zdr'
    : effectiveProduct === 'kdp' ? 'kdp'
    : 'refl';
  const useLevel2 = !!selectedSite && (
    effectiveProduct === 'correlation'
    || effectiveProduct === 'zdr'
    || effectiveProduct === 'kdp'
    || (hiRes && (effectiveProduct === 'reflectivity' || effectiveProduct === 'velocity'))
  );
  // CC + ZDR always use the PNG path. A super-res dual-pol sweep produces
  // 250–500 k polygons → 8–15 MB gzipped GeoJSON, which can take 30–60 s to
  // download on cell and parse on the phone (manifests as "stuck loading").
  // PNG renders the same gates as a single ~300 KB raster, no pointer readout
  // but the operator cares about pattern (debris ball, hail/ZDR signature).
  const useL2Png = pngFallback || effectiveProduct === 'correlation' || effectiveProduct === 'zdr' || effectiveProduct === 'kdp';

  const selectProduct = useCallback((k: ProductKey) => {
    const meta = PRODUCTS[k];
    if (!selectedSite && meta.modes.site && !meta.modes.composite) {
      // Default to whichever NEXRAD site is closest to the current map
      // center so single-site products don't yank the operator across the
      // country when they tap CC / BVEL from a non-Mid-South view.
      const center: [number, number] = [viewState.longitude, viewState.latitude];
      const nearest = nearestSites(center, 1)[0] ?? NEXRAD_SITES_BY_CODE[DEFAULT_SITE_CODE];
      setSelectedSite(nearest.code);
      mapRef.current?.flyTo({ center: nearest.center, zoom: nearest.zoom, duration: 700 });
    }
    setProduct(k);
  }, [selectedSite, viewState.longitude, viewState.latitude]);

  const {
    overlay: level2Overlay,
    geojson: level2GeoJSON,
    loading: level2Loading,
    error: level2Error,
    attempt: level2Attempt,
    maxAttempts: level2MaxAttempts,
    availableSweeps,
    isComposite,
    resolvedSweepIndex,
    sampleValue: sampleLevel2Value,
  } = useLevel2Data({
    enabled: useLevel2,
    site: selectedSite,
    product: level2Product,
    selectedElevation,
    usePng: useL2Png,
  });

  // ── Timeline frames ──────────────────────────────────────────────────
  // LibreWxR drives the timeline for two CONUS-only products: 'composite' (its
  // native radar dataset, 2h past + ~1h nowcast at 10 min intervals) and
  // 'satellite' (12h hourly IR cloud-cover, no forecast). Every other product
  // is a single live frame — we don't fabricate forecasts.
  const lwxrSubject: 'radar' | 'satellite' | null =
    selectedSite ? null
      : effectiveProduct === 'composite' ? 'radar'
      : effectiveProduct === 'satellite' && satSource === 'lwxr' ? 'satellite'
      : null;
  const useLibreWxR = lwxrSubject !== null;
  const {
    lwxrIndex,
    lwxrAllFrames,
    lwxrPastCount,
    totalFrames,
    frame,
    setFrame,
    playing,
    setPlaying,
    speed,
    setSpeed,
    hoverFrame,
    setHoverFrame,
    trackRef,
    draggingRef,
    scrubAtClientX,
  } = useLwxrTimeline(lwxrSubject);

  // Window mounted LibreWxR raster sources to ±LWXR_MOUNT_RADIUS around the
  // current frame so we never have more than ~7 sources alive at once instead
  // of 30+. The previous frame (for crossfade) and a small look-ahead buffer
  // (for scrubbing/playback) are always inside the window. Mapbox keeps the
  // tile cache for unmounted sources, so re-entering the window is cheap.
  // Mount just the current frame on first paint so the initial tile burst is
  // ~1 frame instead of 7 — switching to CREF used to fetch ~100 tiles at once
  // (browser limits ~6 parallel per origin → multiple round-trip batches).
  // After the map idles (or the operator hits play), expand back to ±3 for
  // smooth scrubbing/playback.
  const LWXR_MOUNT_RADIUS_INITIAL = 0;
  const LWXR_MOUNT_RADIUS_FULL = 3;
  const [lwxrMountRadius, setLwxrMountRadius] = useState(LWXR_MOUNT_RADIUS_INITIAL);
  useEffect(() => {
    setLwxrMountRadius(LWXR_MOUNT_RADIUS_INITIAL);
  }, [lwxrSubject]);
  useEffect(() => {
    if (!useLibreWxR) return;
    if (lwxrMountRadius === LWXR_MOUNT_RADIUS_FULL) return;
    const map = mapRef.current?.getMap();
    if (!map) return;
    const expand = () => setLwxrMountRadius(LWXR_MOUNT_RADIUS_FULL);
    if (map.loaded() && !map.isMoving() && !map.isZooming()) {
      const t = setTimeout(expand, 50);
      return () => clearTimeout(t);
    }
    map.once('idle', expand);
    return () => { map.off('idle', expand); };
  }, [useLibreWxR, lwxrSubject, lwxrMountRadius, mapReady]);
  useEffect(() => {
    if (playing && lwxrMountRadius < LWXR_MOUNT_RADIUS_FULL) {
      setLwxrMountRadius(LWXR_MOUNT_RADIUS_FULL);
    }
  }, [playing, lwxrMountRadius]);

  const lwxrMountedFrames = useMemo<LibreWxRFrame[]>(() => {
    if (!useLibreWxR || lwxrAllFrames.length === 0) return [];
    const start = Math.max(0, frame - lwxrMountRadius);
    const end = Math.min(lwxrAllFrames.length - 1, frame + lwxrMountRadius);
    return lwxrAllFrames.slice(start, end + 1);
  }, [useLibreWxR, lwxrAllFrames, frame, lwxrMountRadius]);

  // Track whether tiles for the current product are still loading so the
  // product chip can show a "fetching" pip. We arm a one-shot map.once('idle')
  // when the product/site changes and clear loading when Mapbox reports idle
  // (i.e. all pending tile fetches finished). 10s failsafe in case the map
  // never goes idle (e.g., tile errors).
  const [tilesLoading, setTilesLoading] = useState(false);
  const tileLoadEpochRef = useRef(0);
  useEffect(() => {
    if (!mapReady) return;
    const epoch = ++tileLoadEpochRef.current;
    setTilesLoading(true);
    const map = mapRef.current?.getMap();
    if (!map) return;
    const onIdle = () => {
      if (tileLoadEpochRef.current === epoch) setTilesLoading(false);
    };
    map.once('idle', onIdle);
    const failsafe = setTimeout(() => {
      if (tileLoadEpochRef.current === epoch) setTilesLoading(false);
    }, 10000);
    return () => {
      clearTimeout(failsafe);
      map.off('idle', onIdle);
    };
  }, [effectiveProduct, selectedSite, satSource, mapReady]);

  const radarSourceId = 'radar-source';
  const radarLayerId = 'radar-layer';
  const level2GeoJSONSourceId = 'level2-geojson';
  const level2ImageSourceId = 'level2-image';

  // Non-LibreWxR products render a single "now" tile URL (NCEP / THREDDS).
  const liveTileUrl: string | null = useMemo(() => {
    if (useLibreWxR) return null;
    if (selectedSite) {
      switch (effectiveProduct) {
        case 'reflectivity':
          return IEM_RIDGE_URL(selectedSite, 'N0B', tileCacheKey);
        case 'velocity':
          return IEM_RIDGE_URL(selectedSite, 'N0S', tileCacheKey);
        case 'correlation':
          return null; // Level II only
        default:
          return null;
      }
    }
    switch (effectiveProduct) {
      case 'composite':
        return NCEP_WMS_URL('conus', 'conus:conus_cref_qcd', tileCacheKey);
      case 'reflectivity':
        return NCEP_WMS_URL('conus', 'conus:conus_bref_qcd', tileCacheKey);
      case 'rotation':
        if (!mrmsUrlPath) return null;
        return THREDDS_WMS_URL(
          mrmsUrlPath,
          'MergedAzShear0to2kmAGL_altitude_above_msl',
          tileCacheKey,
        );
      case 'satellite': {
        // satSource === 'lwxr' is handled by the LibreWxR animated pipeline
        // above (useLibreWxR returns null here). Anything else is a single
        // live frame from GIBS or IEM — dispatched by provider in satTileUrl.
        if (satSource === 'lwxr') return null;
        const cfg = GOES_SOURCES[satSource as GoesSourceId];
        if (!cfg) return null;
        return satTileUrl(cfg, tileCacheKey);
      }
      default:
        return null;
    }
  }, [effectiveProduct, selectedSite, tileCacheKey, mrmsUrlPath, useLibreWxR, satSource]);

  const lwxrFrameUrl = useCallback((f: LibreWxRFrame) => {
    if (!lwxrIndex) return '';
    // Satellite tiles use a fixed `/0/0_0.png` tail (color/options don't apply
    // to IFS cloud cover) and ignore the arrows overlay.
    if (lwxrSubject === 'satellite') {
      return `${lwxrIndex.host}${f.path}/${LIBREWXR_TILE_SIZE}/{z}/{x}/{y}/0/0_0.png`;
    }
    const arrowsQ = showArrows ? '?arrows=dark' : '';
    return `${lwxrIndex.host}${f.path}/${LIBREWXR_TILE_SIZE}/{z}/{x}/{y}/${colorScheme}/${LIBREWXR_OPTS}.png${arrowsQ}`;
  }, [lwxrIndex, lwxrSubject, showArrows, colorScheme]);

  // Stable key for the live source — only swap when the URL *pattern* changes
  // (provider / site / product / MRMS dataset), not on every frame.
  const liveSourceKey = useMemo(() => {
    const base = selectedSite ? `site:${selectedSite.toLowerCase()}` : 'conus';
    const satTag = effectiveProduct === 'satellite' ? `:${satSource}` : '';
    return `${base}:${effectiveProduct}${satTag}:${mrmsUrlPath ?? '-'}:${tileCacheKey}`;
  }, [selectedSite, effectiveProduct, tileCacheKey, mrmsUrlPath, satSource]);

  const liveRadarSource = useMemo(() => {
    if (!liveTileUrl) return null;
    // IEM single-site refl/vel is requested as 512px tiles to keep the per-view
    // fan-out small (see IEM_RIDGE_URL); everything else stays at 256.
    const iemSingleSite =
      !!selectedSite &&
      (effectiveProduct === 'reflectivity' || effectiveProduct === 'velocity');
    const base = {
      type: 'raster' as const,
      tiles: [liveTileUrl],
      tileSize: iemSingleSite ? 512 : 256,
    };
    if (effectiveProduct === 'satellite' && satSource !== 'lwxr') {
      const cfg = GOES_SOURCES[satSource as GoesSourceId];
      if (cfg) return { ...base, maxzoom: cfg.maxzoom };
    }
    return base;
  }, [liveTileUrl, effectiveProduct, satSource, selectedSite]);

  // Right-pane (split view) tile URL. Mirrors liveTileUrl's logic but always
  // for `splitProduct`, and only when splitProduct is set AND we have a site
  // (CONUS LibreWxR doesn't fit the split-view UX — it'd just be the same
  // mosaic twice).
  const altTileUrl: string | null = useMemo(() => {
    if (!splitProduct || !selectedSite) return null;
    switch (splitProduct) {
      case 'reflectivity':
        return IEM_RIDGE_URL(selectedSite, 'N0B', tileCacheKey);
      case 'velocity':
        return IEM_RIDGE_URL(selectedSite, 'N0S', tileCacheKey);
      default:
        return null;
    }
  }, [splitProduct, selectedSite, tileCacheKey]);

  const altLiveRadarSource = useMemo(() => {
    if (!altTileUrl) return null;
    // Split-pane alt is always IEM single-site refl/vel → 512px tiles to match.
    return { type: 'raster' as const, tiles: [altTileUrl], tileSize: 512 };
  }, [altTileUrl]);

  const altSourceKey = useMemo(() => {
    if (!splitProduct || !selectedSite) return 'alt:none';
    return `alt:${selectedSite.toLowerCase()}:${splitProduct}:${tileCacheKey}`;
  }, [splitProduct, selectedSite, tileCacheKey]);

  const level2GeoJSONSource = useMemo(() => {
    if (!useLevel2 || useL2Png || !level2GeoJSON) return null;
    return { type: 'geojson' as const, data: level2GeoJSON };
  }, [useLevel2, useL2Png, level2GeoJSON]);

  const level2ImageSource = useMemo(() => {
    if (!useLevel2 || !useL2Png || !level2Overlay?.image_url) return null;
    const { north, south, east, west } = level2Overlay.bounds;
    return {
      type: 'image' as const,
      url: level2Overlay.image_url,
      coordinates: [
        [west, north], [east, north], [east, south], [west, south],
      ] as [number, number][],
    };
  }, [useLevel2, useL2Png, level2Overlay]);

  // Live + Level II opacity are kept up-to-date imperatively (see the
  // useEffect just below this block), so these layer configs intentionally
  // bake in the *current* opacity at mount but don't get re-created on every
  // opacity slider tick — that would force react-map-gl to diff the whole
  // paint object 60×/sec while dragging the slider.
  const liveRadarLayer = useMemo(() => ({
    id: radarLayerId,
    type: 'raster' as const,
    source: radarSourceId,
    paint: {
      'raster-opacity': opacity / 100,
      // Short fade smooths the 5-min NCEP refresh swap without making
      // pan/zoom feel sluggish.
      'raster-fade-duration': 200,
      // `linear` resampling blends pixels at high zoom so reflectivity reads
      // as a smooth gradient instead of pixelated steps. Matches RadarScope /
      // Weatherwise's rendering. NCEP/THREDDS tiles already encode discrete
      // dBZ bands, so the blend gives RadarScope-style edge softening without
      // losing the underlying step palette.
      'raster-resampling': 'linear' as const,
      // Punch up the basemap-tile blend — saturation makes the dBZ colors
      // pop against the colorful dusk basemap; contrast lifts the midtones
      // so light/moderate returns don't read muddy.
      'raster-saturation': 0.35,
      'raster-contrast': 0.2,
    },
    ...tileAnchor,
  // opacity is intentionally NOT a dep — the imperative effect below mutates
  // it via setPaintProperty so we don't re-render the layer object.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [tileAnchor]);

  // Layer ID is keyed by subject so radar/satellite frames with matching
  // timestamps can't accidentally cross-talk in the imperative opacity effect.
  const lwxrLayerId = (time: number) => `lwxr-layer-${lwxrSubject ?? 'none'}-${time}`;
  // Source key includes subject + radar render params so flipping the arrows
  // toggle, swapping color scheme, or switching subject remounts the source
  // and refetches tiles. Mapbox keeps the previous tile cache around, so
  // returning to a prior config is fast.
  const lwxrSourceId = (time: number) =>
    `lwxr-src-${lwxrSubject ?? 'none'}-${lwxrSubject === 'radar' ? `${colorScheme}-${showArrows ? 'a' : 'n'}-` : ''}${time}`;

  const fillColorExpr = useMemo(() => {
    if (!level2Overlay) return '#000000';
    return buildFillColorExpr(level2Product, level2Overlay.vmin, level2Overlay.vmax);
  }, [level2Overlay, level2Product]);

  const level2FillLayer = useMemo(() => ({
    id: 'level2-fill',
    type: 'fill' as const,
    source: level2GeoJSONSourceId,
    paint: {
      'fill-color': fillColorExpr,
      'fill-opacity': level2Overlay
        ? buildFillOpacityExpr(level2Product, opacity / 100,
                               level2Overlay.vmin, level2Overlay.vmax)
        : 0,
      'fill-antialias': true,
    },
    ...tileAnchor,
  // opacity excluded for the same reason as liveRadarLayer.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [fillColorExpr, level2Overlay, level2Product, tileAnchor]);

  const level2RasterLayer = useMemo(() => ({
    id: 'level2-raster',
    type: 'raster' as const,
    source: level2ImageSourceId,
    paint: {
      'raster-opacity': opacity / 100,
      'raster-fade-duration': 0,
      // Nearest keeps gate edges crisp on overzoom — the renderer emits
      // pixel-exact nearest-gate samples, and linear resampling smears the
      // hard Baron band edges into mush.
      'raster-resampling': 'nearest' as const,
      // No saturation/contrast boost here (unlike the dim LibreWxR tiles) —
      // the renderer's PNG carries the exact Baron/ALPHA-Velo palette and
      // boosting would shift the band colors.
    },
    ...tileAnchor,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [tileAnchor]);

  // Live opacity + LibreWxR frame visibility, all imperatively so swapping
  // frames during playback never tears down a source (tiles stay in Mapbox
  // cache → buttery scrubbing once each frame has been seen once).
  //
  // Only the previously-visible frame and the current frame get touched per
  // tick — the old code walked all 30+ frames every frame change, which was
  // 30+ setPaintProperty calls and a noticeable hitch during playback.
  const prevLwxrFrameRef = useRef<number | null>(null);
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map) return;
    if (map.getLayer(radarLayerId)) {
      // Hide the NCEP underlay when LibreWxR (CONUS animated) is active or
      // when Level II is actually painting polygons. "Actually painting"
      // means level2GeoJSON is set (geojson mode) OR level2Overlay.image_url
      // is set (PNG mode) — the previous check on just level2Overlay was too
      // eager: metadata arrives ~5-10 s before the gzipped geojson finishes
      // downloading, and during that gap NCEP was hidden but Level II hadn't
      // mounted, leaving a blank map. NCEP is intentionally the coarse
      // first-paint while Hi-Res is en route.
      const level2Painting =
        useLevel2 &&
        ((!useL2Png && !!level2GeoJSON) ||
          (useL2Png && !!level2Overlay?.image_url));
      const hideNcep = useLibreWxR || level2Painting;
      map.setPaintProperty(radarLayerId, 'raster-opacity', hideNcep ? 0 : opacity / 100);
    }
    if (useLibreWxR) {
      const op = opacity / 100;
      const prev = prevLwxrFrameRef.current;
      if (prev != null && prev !== frame) {
        const prevF = lwxrAllFrames[prev];
        if (prevF && map.getLayer(lwxrLayerId(prevF.time))) {
          map.setPaintProperty(lwxrLayerId(prevF.time), 'raster-opacity', 0);
        }
      }
      const curF = lwxrAllFrames[frame];
      if (curF) {
        const layerId = lwxrLayerId(curF.time);
        if (map.getLayer(layerId)) {
          map.setPaintProperty(layerId, 'raster-opacity', op);
        } else {
          // Layer was just JSX-mounted but Mapbox hasn't finished registering
          // it yet (can happen when the lazy mount window shifts). Apply the
          // opacity once the map next reaches idle.
          map.once('idle', () => {
            if (map.getLayer(layerId)) {
              map.setPaintProperty(layerId, 'raster-opacity', op);
            }
          });
        }
      }
      prevLwxrFrameRef.current = frame;
    } else if (prevLwxrFrameRef.current != null) {
      // Switched away from LibreWxR; clear the cursor so the next entry
      // doesn't try to hide a stale "previous" frame.
      prevLwxrFrameRef.current = null;
    }
    if (map.getLayer('level2-raster')) {
      map.setPaintProperty('level2-raster', 'raster-opacity', opacity / 100);
    }
    if (map.getLayer('level2-fill') && level2Overlay) {
      map.setPaintProperty(
        'level2-fill',
        'fill-opacity',
        buildFillOpacityExpr(level2Product, opacity / 100, level2Overlay.vmin, level2Overlay.vmax),
      );
    }
  }, [opacity, level2Overlay, level2GeoJSON, useL2Png, level2Product, useLibreWxR, useLevel2, level2Error, lwxrAllFrames, frame, mapReady]);

  // Imperative line-width update when the operator selects a warning. The
  // layer's `paint` prop stays referentially stable (no react-map-gl diff);
  // we just retarget the case expression's matched id.
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !map.getLayer('warning-line')) return;
    const id = selectedWarning?.id;
    map.setPaintProperty(
      'warning-line',
      'line-width',
      id ? ['case', ['==', ['get', 'id'], id], 3.5, 2] : 2,
    );
  }, [selectedWarning, warningsGeo, mapReady]);

  // Hover handler — throttled to ~30 Hz. Each call does up to two
  // queryRenderedFeatures hits which are non-trivial on the level2-fill layer
  // (thousands of polygon wedges), so halving the cadence from raw mousemove
  // (~60 Hz) measurably reduces input-handler latency without making the
  // inspector readout feel choppy.
  const hoverThrottleRef = useRef(0);
  const handleMapMouseMove = useCallback((e: MapMouseEvent) => {
    // Skip hover inspection while drawing annotations — the move events
    // belong to the pen/arrow/circle drag and shouldn't trigger pill
    // popouts at the same time.
    if (annotations.isActive) return;
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (now - hoverThrottleRef.current < 32) return;
    hoverThrottleRef.current = now;
    const map = mapRef.current?.getMap();
    const { lng, lat } = e.lngLat;
    let sample: number | null = null;
    if (map && useLevel2 && !useL2Png && level2Overlay && map.getLayer('level2-fill')) {
      const hits = map.queryRenderedFeatures(e.point, { layers: ['level2-fill'] });
      if (hits.length > 0) {
        const v = (hits[0].properties as any)?.v;
        // properties.v is the raw product value (dBZ / m/s / ρhv) — see
        // polar.py. (An old byte-scale dequantization here used to garble
        // the readout.)
        if (typeof v === 'number') sample = v;
      }
    } else if (useLevel2 && useL2Png) {
      // PNG mode: sample the value-grid sidecar instead of map features.
      sample = sampleLevel2Value(lng, lat);
    }
    setHoverPixel({ lng, lat, sample });

    if (map && showSubs && map.getLayer('subs-pin')) {
      const subHits = map.queryRenderedFeatures(e.point, { layers: ['subs-pin'] });
      if (subHits.length > 0) {
        setHoverPos({ x: e.point.x, y: e.point.y });
        setHoverSub(subHits[0].properties);
      } else {
        setHoverSub(null);
      }
    } else {
      setHoverSub(null);
    }
  }, [useLevel2, useL2Png, level2Overlay, showSubs, sampleLevel2Value]);

  // F7: derived selectors for the currently-rendered SPC day.
  const activeSpc = useMemo(
    () => spcDays.find((d) => d.day_number === spcDay) ?? null,
    [spcDays, spcDay],
  );
  const spcGeo = useMemo<GeoJSON.FeatureCollection>(() => {
    if (!activeSpc) return { type: 'FeatureCollection', features: [] };
    return activeSpc.geojson;
  }, [activeSpc]);
  const spcLayerVis = showSpc ? 'visible' : 'none' as const;

  const nwsLayerVis = showNws ? 'visible' : 'none' as const;
  const trackLayerVis = showNws && showStormTracks ? 'visible' : 'none' as const;
  const stormTrackCount = useMemo(() => {
    const ids = new Set<string>();
    for (const f of tracksGeo.features ?? []) {
      const aid = (f.properties as { alert_id?: string })?.alert_id;
      if (aid) ids.add(aid);
    }
    return ids.size;
  }, [tracksGeo]);

  // Subscribers
  const subsHaloLayer = useMemo<any>(() => ({
    id: 'subs-halo', type: 'circle' as const, source: 'subs-source',
    layout: { visibility: showSubs ? 'visible' : 'none' },
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 6, 7, 12, 10, 20, 14, 28],
      'circle-color': '#38bdf8', 'circle-opacity': 0.25, 'circle-blur': 0.55,
    },
    ...overlayAnchor,
  }), [showSubs, overlayAnchor]);
  const subsPinLayer = useMemo<any>(() => ({
    id: 'subs-pin', type: 'circle' as const, source: 'subs-source',
    layout: { visibility: showSubs ? 'visible' : 'none' },
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 3, 7, 5, 10, 7, 14, 9],
      'circle-color': '#38bdf8',
      'circle-stroke-color': '#0b1220',
      'circle-stroke-width': 1.5,
    },
    ...overlayAnchor,
  }), [showSubs, overlayAnchor]);

  // Selection / draw GeoJSON features — memo them so the Source's `data` prop
  // doesn't churn on every parent re-render (which would force Mapbox setData
  // calls with identical content).
  const selectionCircleData = useMemo(() => {
    if (!selection || selection.type !== 'circle') return null;
    return {
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: selection.center },
      properties: {},
    };
  }, [selection]);
  const selectionCirclePaint = useMemo<any>(() => {
    if (!selection || selection.type !== 'circle') return null;
    return {
      'circle-radius': (selection.radius_km / 111) * 1000 * (settledView.zoom / 8),
      'circle-color': 'rgba(251,191,36,0.15)',
      'circle-stroke-color': '#fbbf24',
      'circle-stroke-width': 2,
    };
  }, [selection, settledView.zoom]);
  const selectionPolyData = useMemo(() => {
    if (!selection || selection.type !== 'polygon') return null;
    return {
      type: 'Feature' as const,
      geometry: { type: 'Polygon' as const, coordinates: [selection.coordinates] },
      properties: {},
    };
  }, [selection]);
  const polyDrawData = useMemo(() => {
    if (drawMode !== 'polygon' || polygonPoints.length === 0) return null;
    return {
      type: 'Feature' as const,
      geometry: { type: 'LineString' as const, coordinates: polygonPoints },
      properties: {},
    };
  }, [drawMode, polygonPoints]);

  const handleMapClick = (e: MapMouseEvent) => {
    // Annotation tools own the mouse while active; the RadarAnnotations
    // hook attaches its own map.on('click') listener for vertex placement.
    if (annotations.isActive) return;
    if (drawMode !== 'none' && e.originalEvent) {
      e.originalEvent.stopPropagation();
      e.originalEvent.preventDefault?.();
    }
    const { lng, lat } = e.lngLat;

    if (drawMode === 'polygon') {
      const pts = [...polygonPoints, [lng, lat] as [number, number]];
      setPolygonPoints(pts);
      return;
    }

    if (drawMode === 'pick-site') {
      const nearest = nearestSites([lng, lat], 1)[0];
      if (nearest) {
        mapRef.current?.flyTo({ center: nearest.center, zoom: nearest.zoom, duration: 700 });
        setSelectedSite(nearest.code);
      }
      setDrawMode('none');
      return;
    }

    if (drawMode === 'snap') {
      const map = mapRef.current?.getMap();
      if (!map || !map.getLayer('warning-fill')) return;
      const hits = map.queryRenderedFeatures(e.point, { layers: ['warning-fill'] });
      if (hits.length === 0) return;
      const w = warnings.find((x) => x.id === (hits[0].properties as any)?.id);
      if (!w) return;
      const coords = warningToSelectionCoords(w);
      if (!coords) return;
      const newSel: Selection = { type: 'polygon', coordinates: coords };
      setSelection(newSel);
      setDrawMode('none');
      setSelectedWarning(w);
      previewAudience(newSel);
      return;
    }

    // Not in draw mode → see if the click lands on a subscriber pin first
    // (smaller targets win over the larger warning polygons underneath).
    const map = mapRef.current?.getMap();
    if (!map) return;
    // One queryRenderedFeatures pass across every clickable layer, then
    // dispatch by layer id in priority order below — instead of up to eight
    // separate feature-index queries when the click lands on empty map.
    const clickLayers = [
      showSubs ? 'subs-pin' : null,
      showLsr ? 'lsr-pin' : null,
      showStormReports ? 'storm-report-pin' : null,
      showMping ? 'mping-pin' : null,
      showMetar ? 'metar-pin' : null,
      showCouplets ? 'couplet-pin' : null,
      showProbSevere ? 'probsevere-fill' : null,
      'warning-fill',
    ].filter((l): l is string => !!l && !!map.getLayer(l));
    const allHits = clickLayers.length > 0
      ? map.queryRenderedFeatures(e.point, { layers: clickLayers })
      : [];
    const hitsFor = (layer: string) => allHits.filter((f) => f.layer?.id === layer);
    if (showSubs) {
      const subHits = hitsFor('subs-pin');
      if (subHits.length > 0) {
        const props = subHits[0].properties as any;
        if (props?.id) {
          window.open(`/subscribers/${props.id}`, '_blank');
          return;
        }
      }
    }
    // F4: LSR pins next — same priority logic (small targets first).
    if (showLsr) {
      const lsrHits = hitsFor('lsr-pin');
      if (lsrHits.length > 0) {
        const props = lsrHits[0].properties as any;
        setSelectedLsr({
          id: String(props?.id ?? ''),
          event: String(props?.event ?? ''),
          hazard: (props?.hazard as string | null) ?? null,
          magnitude: (props?.magnitude as string | null) ?? null,
          location: (props?.location as string | null) ?? null,
          occurred_at: (props?.occurred_at as string | null) ?? null,
          remark: (props?.remark as string | null) ?? null,
          source: (props?.source as string | null) ?? null,
        });
        return;
      }
    }
    // Subscriber storm reports — same priority as LSRs (small targets).
    if (showStormReports) {
      const hits = hitsFor('storm-report-pin');
      if (hits.length > 0) {
        const f = hits[0];
        const props = f.properties as any;
        const geom = f.geometry as GeoJSON.Point | undefined;
        const [lon, lat] = geom?.coordinates ?? [0, 0];
        setSelectedStormReport({
          id: String(props?.id ?? ''),
          hazard: String(props?.hazard ?? 'other'),
          description: (props?.description as string | null) ?? null,
          photo_url: (props?.photo_url as string | null) ?? null,
          reported_at: (props?.reported_at as string | null) ?? null,
          reporter: (props?.reporter as string | null) ?? null,
          place_name: (props?.place_name as string | null) ?? null,
          status: (props?.status as string | null) ?? null,
          lat: Number(lat),
          lon: Number(lon),
        });
        return;
      }
    }
    // F13: mPING report click. Higher priority than METAR but lower
    // than LSRs since mPING is community-sourced.
    if (showMping) {
      const hits = hitsFor('mping-pin');
      if (hits.length > 0) {
        const props = hits[0].properties as any;
        setSelectedMping({
          id: Number(props?.id ?? 0),
          description: String(props?.description ?? ''),
          hazard: String(props?.hazard ?? 'other'),
          obtime: String(props?.obtime ?? ''),
        });
        return;
      }
    }
    // F12: METAR station click. Lower priority than warning fills but
    // higher than nothing — the operator clicks a station to see surface
    // obs context for whatever storm they're looking at.
    if (showMetar) {
      const mHits = hitsFor('metar-pin');
      if (mHits.length > 0) {
        const props = mHits[0].properties as any;
        setSelectedMetar({
          icaoId: String(props?.icaoId ?? ''),
          name: (props?.name as string | null) ?? null,
          obsTime: (props?.obsTime as string | null) ?? null,
          temp: props?.temp != null ? Number(props.temp) : null,
          dewp: props?.dewp != null ? Number(props.dewp) : null,
          wdir: props?.wdir != null ? Number(props.wdir) : null,
          wspd: props?.wspd != null ? Number(props.wspd) : null,
          wgst: props?.wgst != null ? Number(props.wgst) : null,
          altim: props?.altim != null ? Number(props.altim) : null,
          wxString: (props?.wxString as string | null) ?? null,
          rawOb: (props?.rawOb as string | null) ?? null,
        });
        return;
      }
    }
    // F9: rotation IDs. Sit above LSRs in click priority because a strong
    // couplet is a higher-urgency signal than a backfilled storm report.
    if (showCouplets) {
      const cpHits = hitsFor('couplet-pin');
      if (cpHits.length > 0) {
        const f = cpHits[0];
        const props = f.properties as any;
        const geom = f.geometry as GeoJSON.Point | undefined;
        const [lon, lat] = geom?.coordinates ?? [0, 0];
        setSelectedCouplet({
          track_id: String(props?.track_id ?? ''),
          site: String(props?.site ?? ''),
          shear_kt: Number(props?.shear_kt ?? 0),
          max_shear_kt: Number(props?.max_shear_kt ?? 0),
          range_km: Number(props?.range_km ?? 0),
          azimuth_deg: Number(props?.azimuth_deg ?? 0),
          elevation_deg: Number(props?.elevation_deg ?? 0),
          volume_time_utc: (props?.volume_time_utc as string | null) ?? null,
          first_seen_at: (props?.first_seen_at as string | null) ?? null,
          volume_count: Number(props?.volume_count ?? 1),
          lat: Number(lat),
          lon: Number(lon),
        });
        return;
      }
    }
    // ProbSevere object click → readout popup. High priority: clicking a storm
    // object to see its full ML breakdown (probs + the radar/NWP ingredients) is
    // a core nowcasting action.
    if (showProbSevere) {
      const psHits = hitsFor('probsevere-fill');
      if (psHits.length > 0) {
        const props = psHits[0].properties as any;
        setProbSeverePopup({
          lng: e.lngLat.lng,
          lat: e.lngLat.lat,
          topType: String(props?.topType ?? 'severe'),
          topProb: Number(props?.topProb ?? 0),
          severe: Number(props?.ProbSevere ?? 0),
          tor: Number(props?.ProbTor ?? 0),
          hail: Number(props?.ProbHail ?? 0),
          wind: Number(props?.ProbWind ?? 0),
          readout: String(props?.readout ?? ''),
          me: Number(props?.MOTION_EAST ?? 0),
          ms: Number(props?.MOTION_SOUTH ?? 0),
        });
        return;
      }
    }
    const hits = hitsFor('warning-fill');
    if (hits.length === 0) return;

    // Multiple overlapping polygons (common: a Tornado Warning nested inside
    // an SVR Watch, or two adjoining county-level alerts) → open a popup
    // listing each one so the operator picks which to act on rather than
    // silently getting the topmost-rendered feature.
    const seen = new Set<string>();
    const candidates: NwsWarning[] = [];
    for (const f of hits) {
      const id = (f.properties as { id?: string } | null)?.id;
      if (!id || seen.has(id)) continue;
      const w = warnings.find((x) => x.id === id);
      if (!w) continue;
      seen.add(id);
      candidates.push(w);
    }
    if (candidates.length === 0) return;

    setWarningPopup({
      lng: e.lngLat.lng,
      lat: e.lngLat.lat,
      candidates,
      chosenId: candidates.length === 1 ? candidates[0].id : null,
    });
    if (candidates.length === 1) {
      setSelectedWarning(candidates[0]);
      focusWarning(candidates[0]);
    }
  };

  const completePolygon = () => {
    if (polygonPoints.length < 3) return;
    const ring = [...polygonPoints, polygonPoints[0]];
    const newSel: Selection = { type: 'polygon', coordinates: ring };
    setSelection(newSel);
    setDrawMode('none');
    setPolygonPoints([]);
    previewAudience(newSel);
  };

  const cancelDraw = () => {
    setDrawMode('none');
    setPolygonPoints([]);
    setSelection(null);
    setPreviewCount(null);
  };

  const startPolygonDraw = () => { cancelDraw(); setDrawMode('polygon'); setPolygonPoints([]); };
  const startSnapMode = () => { cancelDraw(); setDrawMode('snap'); };

  // Nowcast preset: warnings + reports stay on either way; the storm-scale
  // convective overlays (ProbSevere / rotation / lightning) toggle with it.
  // Shared by the desktop toolbar button and the mobile Tools menu item.
  const toggleNowcast = () => {
    const next = !nowcastOn;
    setNowcastOn(next);
    setShowNws(true);
    setShowStormReports(true);
    setShowLsr(true);
    setShowProbSevere(next);
    setShowCouplets(next);
    setShowLightning(next);
  };

  // Extract a single outer ring from a warning's GeoJSON geometry for use as
  // a Selection. MultiPolygon warnings (split alerts) lose their other parts —
  // a known limitation; extend Selection to support MultiPolygon if it bites.
  const warningToSelectionCoords = (w: NwsWarning): number[][] | null => {
    const g = w.geometry;
    if (!g) return null;
    if (g.type === 'Polygon') return g.coordinates[0] ?? null;
    if (g.type === 'MultiPolygon') return g.coordinates[0]?.[0] ?? null;
    return null;
  };

  // Live audience preview while drawing — once the polygon has at least 3
  // vertices we close it and call resolve_audience after a brief debounce.
  // setPreviewCount is the same state shown in the post-Complete card, which
  // is fine since `selection` is null during draw so the card isn't mounted.
  useEffect(() => {
    if (drawMode !== 'polygon' || polygonPoints.length < 3) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      const ring = [...polygonPoints, polygonPoints[0]];
      const supa = supabaseBrowser();
      const spec = { geometry: { type: 'Polygon', coordinates: [ring] } };
      const { data, error } = await supa.rpc('resolve_audience', { spec });
      if (cancelled) return;
      if (!error && data) setPreviewCount(data.length);
      else setPreviewCount(null);
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [drawMode, polygonPoints]);

  const previewAudience = async (sel: Selection) => {
    const supa = supabaseBrowser();
    let spec: any = {};
    if (sel.type === 'circle') {
      spec = { geometry: { type: 'circle', center: sel.center, radius_km: sel.radius_km } };
    } else {
      spec = { geometry: { type: 'Polygon', coordinates: [sel.coordinates] } };
    }
    const { data, error } = await supa.rpc('resolve_audience', { spec });
    if (!error && data) setPreviewCount(data.length);
    else setPreviewCount(0);
  };

  // F1+F2: build /compose URL for a warning row's "Send" action. Passes
  //   - the warning polygon as the audience geometry
  //   - the hazard kind so /compose can auto-select the matching template
  //   - the AI summary (or a fallback) as the default body, used until the
  //     operator picks a template that overrides it.
  // 'other' hazard is intentionally omitted from the template auto-match —
  // generic warnings shouldn't snap to anything.
  const composeUrlForWarning = useCallback((w: NwsWarning): string => {
    const params = new URLSearchParams();
    params.set('geo', JSON.stringify(w.geometry));
    if (w.hazard && w.hazard !== 'other') {
      params.set('hazard', w.hazard);
    }
    // Carry the source NWS id through so the compose action can link the
    // outbound message back to the alert row — that link lets /m/[id] show
    // full NWS context and reach for the alert's polygon when the operator
    // swaps the audience away from the radar selection.
    if (w.nws_id) params.set('nws_id', w.nws_id);
    const body = warningBodySeed(w);
    if (body) params.set('body', body);
    return `/compose?${params.toString()}`;
  }, []);

  // F3: same as composeUrlForWarning but the audience geometry is the
  // forecast-track corridor instead of the warning polygon. Caller must
  // verify w.forecast_track exists.
  const composeUrlForWarningTrack = useCallback((w: NwsWarning): string | null => {
    if (!w.forecast_track) return null;
    const corridor_km = w.in_path_corridor_km ?? 8;
    const spec = { type: 'track', line: w.forecast_track, corridor_km };
    const params = new URLSearchParams();
    params.set('geo', JSON.stringify(spec));
    if (w.hazard && w.hazard !== 'other') params.set('hazard', w.hazard);
    if (w.nws_id) params.set('nws_id', w.nws_id);
    const body = warningBodySeed(w);
    if (body) params.set('body', body);
    return `/compose?${params.toString()}`;
  }, []);

  // Warn-from-cell: draft an alert straight from a ProbSevere object, addressed
  // to its *projected path* (the cell motion-projected ~45 min into a corridor)
  // so the operator warns where the storm is going, not just where it is. Falls
  // back to a radius around the cell when it's near-stationary.
  const composeUrlForProbSevereCell = useCallback(
    (p: NonNullable<typeof probSeverePopup>): string => {
      const hazard = p.topType === 'tor' ? 'tornado' : 'severe';
      const corridor_km = p.topType === 'tor' ? 5 : 7;
      const speed = Math.hypot(p.me, p.ms); // m/s
      const params = new URLSearchParams();
      if (speed >= 0.5) {
        const cosLat = Math.cos((p.lat * Math.PI) / 180) || 1e-6;
        const dt = 45 * 60;
        const end: [number, number] = [
          p.lng + (p.me * dt) / (111320 * cosLat),
          p.lat + (-p.ms * dt) / 111320,
        ];
        const spec = {
          type: 'track',
          line: { type: 'LineString', coordinates: [[p.lng, p.lat], end] },
          corridor_km,
        };
        params.set('geo', JSON.stringify(spec));
      } else {
        params.set('geo', JSON.stringify({ type: 'circle', center: [p.lng, p.lat], radius_km: corridor_km * 1.5 }));
      }
      params.set('hazard', hazard);
      const lead = (p.readout || '').split('\n')[0] || `ProbSevere ${p.topType.toUpperCase()} ${p.topProb}%`;
      params.set('body', lead);
      return `/compose?${params.toString()}`;
    },
    [],
  );

  const goToCompose = () => {
    if (!selection) return;
    const params = new URLSearchParams();
    if (selection.type === 'circle') {
      params.set('geo', JSON.stringify({ type: 'circle', center: selection.center, radius_km: selection.radius_km }));
    } else {
      params.set('geo', JSON.stringify({ type: 'polygon', coordinates: selection.coordinates }));
    }
    window.open(`/compose?${params.toString()}`, '_blank', 'noopener,noreferrer');
  };

  // In-radar quick send. The audience_spec mirrors goToCompose's geo param so
  // preview-count = queued-count holds (both resolve via resolve_audience).
  const [quickComposeOpen, setQuickComposeOpen] = useState(false);
  const quickComposeSpec = useMemo(() => {
    if (!selection) return null;
    return selection.type === 'circle'
      ? { geometry: { type: 'circle', center: selection.center, radius_km: selection.radius_km } }
      : { geometry: { type: 'Polygon', coordinates: [selection.coordinates] } };
  }, [selection]);
  useEffect(() => {
    if (!selection) setQuickComposeOpen(false);
  }, [selection]);

  // Hand off the polygon selection to /forecast/new for the operator to
  // attach hazards + a time window + discussion. /forecast only handles
  // polygon areas today, so the circle path is intentionally omitted.
  const goToForecast = () => {
    if (!selection || selection.type !== 'polygon') return;
    const params = new URLSearchParams();
    params.set('geo', JSON.stringify({ type: 'polygon', coordinates: selection.coordinates }));
    window.location.href = `/forecast/new?${params.toString()}`;
  };

  // 'H' toggles hide-all-UI mode. Lives in its own effect (not the LWXR
  // playback handler above) so it works in every product/mode, not only
  // when a timeline is available.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement | null;
      const tag = tgt?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tgt?.isContentEditable) return;
      if (e.key === 'h' || e.key === 'H') {
        e.preventDefault();
        setUiHidden((v) => !v);
      } else if (e.key === 'Escape') {
        // Esc cancels any in-progress draw or clears the active selection.
        // setState calls are no-ops when there's nothing to clear, so it's
        // safe to fire unconditionally.
        setDrawMode('none');
        setPolygonPoints([]);
        setSelection(null);
        setPreviewCount(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Audience breakdown is resolved server-side now — the old version bucketed
  // subscribers by name substring ("memphis"/"bartlett" → memphis bucket) which
  // broke whenever a subscriber's display name didn't match the hardcoded list.
  // resolve_audience_breakdown() returns counts grouped by state via
  // subscribers.county_fips, which is authoritative.
  useEffect(() => {
    if (!selection) {
      setAudienceBreakdown({ total: 0, tn: 0, ms: 0, ar: 0, other: 0 });
      return;
    }
    const supa = supabaseBrowser();
    const spec =
      selection.type === 'circle'
        ? { geometry: { type: 'circle', center: selection.center, radius_km: selection.radius_km } }
        : { geometry: { type: 'Polygon', coordinates: [selection.coordinates] } };
    let cancelled = false;
    (async () => {
      const { data, error } = await supa.rpc('resolve_audience_breakdown', { spec });
      if (cancelled || error || !data) return;
      const d = data as Partial<AudienceBreakdown>;
      setAudienceBreakdown({
        total: Number(d.total ?? 0),
        tn:    Number(d.tn ?? 0),
        ms:    Number(d.ms ?? 0),
        ar:    Number(d.ar ?? 0),
        other: Number(d.other ?? 0),
      });
    })();
    return () => { cancelled = true; };
  }, [selection]);

  const focusWarning = (w: NwsWarning) => {
    mapRef.current?.flyTo({ center: w.centroid, zoom: 8.5, duration: 800 });
  };

  // Geographic pills anchored at each NEXRAD site visible in the viewport.
  // Off entirely when the operator toggles them or zooms out below z5; the
  // selected site is always included so it doesn't vanish on pan.
  const mapPillSites = useMemo<RadarSite[]>(() => {
    if (!showSitePills) {
      if (!selectedSite) return [];
      const sel = NEXRAD_SITES_BY_CODE[selectedSite];
      return sel ? [sel] : [];
    }
    const zoom = settledView.zoom;
    const center: [number, number] = [settledView.longitude, settledView.latitude];
    const cap = mapPillCapForZoom(zoom);
    if (cap === 0) {
      if (!selectedSite) return [];
      const sel = NEXRAD_SITES_BY_CODE[selectedSite];
      return sel ? [sel] : [];
    }

    const inView = mapBounds
      ? NEXRAD_SITES.filter((s) => {
          const [lon, lat] = s.center;
          return lon >= mapBounds.west && lon <= mapBounds.east
            && lat >= mapBounds.south && lat <= mapBounds.north;
        })
      : nearestSites(center, Math.max(cap, 12));

    const pool = inView.length > 0 ? inView : nearestSites(center, cap === Infinity ? 24 : cap);
    const ranked = pool
      .map((s) => ({ s, d: distanceKm(center, s.center) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, cap === Infinity ? pool.length : cap)
      .map((x) => x.s);

    if (selectedSite && !ranked.some((s) => s.code === selectedSite)) {
      const sel = NEXRAD_SITES_BY_CODE[selectedSite];
      if (sel) ranked.push(sel);
    }
    return ranked;
  }, [mapBounds, settledView.zoom, settledView.longitude, settledView.latitude, selectedSite, showSitePills]);

  const screenPoint = (lngLat: [number, number]) => {
    const map = mapRef.current?.getMap();
    return map ? map.project(lngLat) : null;
  };

  // Active frame's wall-clock time (LibreWxR = real timestamp; otherwise NOW).
  const frameTimeLabel = useMemo(() => {
    let d: Date;
    if (useLibreWxR && lwxrAllFrames[frame]) {
      d = new Date(lwxrAllFrames[frame].time * 1000);
    } else {
      d = new Date();
    }
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }, [frame, useLibreWxR, lwxrAllFrames]);

  const isForecastFrame = useLibreWxR && frame >= lwxrPastCount;
  const relLabel = useMemo(() => {
    if (!useLibreWxR) return 'LIVE';
    const f = lwxrAllFrames[frame];
    if (!f) return '—';
    const nowSec = Math.floor(Date.now() / 1000);
    const diffMin = Math.round((f.time - nowSec) / 60);
    if (diffMin === 0) return 'NOW';
    return diffMin > 0 ? `+${diffMin} min` : `${diffMin} min`;
  }, [useLibreWxR, frame, lwxrAllFrames]);

  // F8: scrub-time replay. When the operator drags the LibreWxR timeline
  // back, return the past-frame timestamp (ms); otherwise null = live.
  // The latest past frame (lwxrPastCount - 1) is always treated as "live now"
  // — it's the freshest mosaic LibreWxR publishes, typically 5-10 min old,
  // and the operator expects current warnings to overlay it. Without this,
  // any warning issued in the last few minutes would be filtered out the
  // moment the page loads.
  const scrubTimeMs = useMemo<number | null>(() => {
    if (!useLibreWxR) return null;
    if (frame >= lwxrPastCount - 1) return null;
    const f = lwxrAllFrames[frame];
    if (!f) return null;
    const nowSec = Math.floor(Date.now() / 1000);
    if (f.time >= nowSec - 60) return null;
    return f.time * 1000;
  }, [useLibreWxR, frame, lwxrAllFrames, lwxrPastCount]);

  const replayDiffMin = scrubTimeMs == null
    ? null
    : Math.round((scrubTimeMs - Date.now()) / 60_000);

  // F8: scrub-aware derivatives. Live mode (scrubTimeMs null) just passes
  // through. In replay mode, warnings are kept only if they were active at
  // the scrubbed timestamp (effective <= t < expires_at), and LSRs are
  // kept only if their occurred_at <= t.
  //
  // Plus a category gate (warning/watch/advisory/discussion). 'statement' and
  // 'other' tag along with warnings since they're rare and the operator hasn't
  // asked for finer control over them.
  const isCategoryVisible = useCallback(
    (cat: string) => {
      switch (cat) {
        case 'warning': return catWarnings;
        case 'watch': return catWatches;
        case 'advisory': return catAdvisories;
        case 'discussion': return catDiscussions;
        default: return catWarnings;
      }
    },
    [catWarnings, catWatches, catAdvisories, catDiscussions],
  );
  const displayWarnings = useMemo<NwsWarning[]>(() => {
    const t = scrubTimeMs;
    return warnings
      .filter((w) => {
        if (!isCategoryVisible(w.category)) return false;
        if (t == null) return true;
        const eff = w.effective ? new Date(w.effective).getTime() : -Infinity;
        const exp = w.expires_at ? new Date(w.expires_at).getTime() : Infinity;
        return eff <= t && exp > t;
      })
      // Triage order: scariest first (Tornado/Severe Warnings) so the chip row
      // and inspector list — both sliced to the first N — never bury an active
      // warning behind a flood/winter watch. Tie-break on soonest expiry.
      .sort((a, b) => {
        const d = nwsAlertPriority(b) - nwsAlertPriority(a);
        if (d !== 0) return d;
        const ea = a.expires_at ? new Date(a.expires_at).getTime() : Infinity;
        const eb = b.expires_at ? new Date(b.expires_at).getTime() : Infinity;
        return ea - eb;
      });
  }, [warnings, scrubTimeMs, isCategoryVisible]);

  // Unified Threat Board — one prioritized triage list merging the three threat
  // streams the operator otherwise has to scan separately: issued NWS
  // warnings/watches, ProbSevere ML cells, and velocity-couplet rotation IDs.
  // Issued warnings sort to the top (ground truth), then guidance interleaved by
  // intensity (ProbSevere prob, couplet shear). Each row flies the map there and
  // opens the matching detail. The single "what needs my attention now" surface.
  const threatBoard = useMemo(() => {
    type Threat = {
      key: string;
      kind: 'warning' | 'probsevere' | 'couplet';
      score: number;
      badge: string;
      title: string;
      sub: string;
      dot: string;
      center: [number, number] | null;
      warning?: NwsWarning;
      cell?: (typeof probSevereTop)[number];
    };
    const out: Threat[] = [];
    for (const w of displayWarnings) {
      if (w.category !== 'warning' && w.category !== 'watch') continue;
      const weight =
        w.concern_type === 'tornado' ? 320
        : w.concern_type === 'severe' ? 220
        : w.concern_type === 'flood' ? 120
        : w.concern_type === 'winter' ? 80 : 60;
      const dot =
        w.concern_type === 'tornado' ? 'bg-red-500'
        : w.concern_type === 'severe' ? 'bg-amber-400'
        : w.concern_type === 'flood' ? 'bg-emerald-400'
        : w.concern_type === 'winter' ? 'bg-indigo-400' : 'bg-fuchsia-400';
      out.push({
        key: `w:${w.id}`,
        kind: 'warning',
        score: (w.category === 'warning' ? 1000 : 400) + weight,
        badge: w.category === 'warning' ? 'WRN' : 'WCH',
        title: w.event,
        sub: shortNwsLocation(w.area_desc) ?? '',
        dot,
        center: w.centroid,
        warning: w,
      });
    }
    for (const c of probSevereTop) {
      const dot =
        c.topType === 'tor' ? 'bg-red-500'
        : c.topType === 'hail' ? 'bg-cyan-400'
        : c.topType === 'wind' ? 'bg-blue-400' : 'bg-amber-400';
      out.push({
        key: `ps:${c.id}`,
        kind: 'probsevere',
        score: c.topProb,
        badge: 'PSv',
        title: `${c.topType.toUpperCase()} ${c.topProb}%`,
        sub: c.id ? `#${c.id.slice(-4)}` : '',
        dot,
        center: c.center,
        cell: c,
      });
    }
    for (const f of coupletGeo.features ?? []) {
      const p = (f.properties ?? {}) as Record<string, unknown>;
      const shear = Number(p.max_shear_kt ?? 0);
      const geom = f.geometry;
      const center = geom?.type === 'Point' ? (geom.coordinates as [number, number]) : null;
      out.push({
        key: `c:${String(p.track_id ?? '')}`,
        kind: 'couplet',
        score: shear,
        badge: 'ROT',
        title: `Couplet ${Math.round(shear)}kt`,
        sub: String(p.track_id ?? ''),
        dot: 'bg-fuchsia-400',
        center,
      });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, 14);
  }, [displayWarnings, probSevereTop, coupletGeo]);

  const displayWarningsGeo = useMemo<GeoJSON.FeatureCollection>(() => {
    const t = scrubTimeMs;
    return {
      type: 'FeatureCollection',
      features: (warningsGeo.features ?? []).filter((f) => {
        const p = f.properties as {
          effective?: string | null;
          expires_at?: string | null;
          category?: string | null;
        } | null;
        if (!isCategoryVisible(p?.category ?? 'warning')) return false;
        if (t == null) return true;
        const eff = p?.effective ? new Date(p.effective).getTime() : -Infinity;
        const exp = p?.expires_at ? new Date(p.expires_at).getTime() : Infinity;
        return eff <= t && exp > t;
      }),
    };
  }, [warningsGeo, scrubTimeMs, isCategoryVisible]);
  const displayLsrGeo = useMemo<GeoJSON.FeatureCollection>(() => {
    if (scrubTimeMs == null) return lsrGeo;
    const t = scrubTimeMs;
    return {
      type: 'FeatureCollection',
      features: (lsrGeo.features ?? []).filter((f) => {
        const p = f.properties as { occurred_at?: string | null } | null;
        const occ = p?.occurred_at ? new Date(p.occurred_at).getTime() : Infinity;
        return occ <= t;
      }),
    };
  }, [lsrGeo, scrubTimeMs]);
  const displayStormReportsGeo = useMemo<GeoJSON.FeatureCollection>(() => {
    if (scrubTimeMs == null) return stormReportsGeo;
    const t = scrubTimeMs;
    return {
      type: 'FeatureCollection',
      features: (stormReportsGeo.features ?? []).filter((f) => {
        const p = f.properties as { reported_at?: string | null } | null;
        const rep = p?.reported_at ? new Date(p.reported_at).getTime() : Infinity;
        return rep <= t;
      }),
    };
  }, [stormReportsGeo, scrubTimeMs]);

  const activeClusterCount = stormReportClustersGeo.features?.length ?? 0;
  useEffect(() => {
    if (activeClusterCount === 0) {
      setClusterPulse(0);
      return;
    }
    const start = performance.now();
    const id = window.setInterval(() => {
      const t = (performance.now() - start) / 2000; // 2s period
      // Sine 0..1 — smooth in/out so the ring breathes rather than blinks.
      setClusterPulse(0.5 + 0.5 * Math.sin(t * Math.PI * 2));
    }, 80);
    return () => window.clearInterval(id);
  }, [activeClusterCount]);

  // Format the raw sampled value in natural units for the hover readout.
  // Velocity arrives in m/s (Py-ART) — convert to kt for display.
  const sampleLabel = useMemo(() => {
    if (!hoverPixel || hoverPixel.sample == null) return '—';
    if (effectiveProduct === 'correlation') return `${hoverPixel.sample.toFixed(2)} ρhv`;
    if (effectiveProduct === 'velocity' && useLevel2) return `${(hoverPixel.sample * 1.94384).toFixed(0)} kt`;
    if (effectiveProduct === 'zdr') return `${hoverPixel.sample.toFixed(1)} dB`;
    if (effectiveProduct === 'kdp') return `${hoverPixel.sample.toFixed(1)} °/km`;
    return `${hoverPixel.sample.toFixed(0)} dBZ`;
  }, [hoverPixel, effectiveProduct, useLevel2]);

  // Register the lightning-bolt symbol image with Mapbox once the style is up.
  // Inline SVG keeps it a code-only change — no public/ asset.
  useEffect(() => {
    if (!mapReady) return;
    const map = mapRef.current?.getMap();
    if (!map || map.hasImage('lightning-bolt')) return;
    const img = new Image(48, 72);
    img.onload = () => {
      if (!map.hasImage('lightning-bolt')) {
        map.addImage('lightning-bolt', img, { pixelRatio: 2 });
      }
    };
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(LIGHTNING_BOLT_SVG)}`;
  }, [mapReady]);

  // Drive the bolt fade. Mapbox style expressions can't reference "now", so we
  // rebind the literal current time at 1 Hz and let the GPU-side `interpolate`
  // do the per-feature age math. Strikes < 0s old hold full opacity; strikes
  // ≥ LIGHTNING_FADE_MS old are invisible.
  useEffect(() => {
    if (!showLightning || !mapReady) return;
    const map = mapRef.current?.getMap();
    if (!map) return;
    const tick = () => {
      if (!map.getLayer('lightning-bolts')) return;
      map.setPaintProperty('lightning-bolts', 'icon-opacity', [
        'interpolate', ['linear'],
        ['-', Date.now(), ['get', 't']],
        0, 1,
        LIGHTNING_FADE_MS, 0,
      ] as any);
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [showLightning, mapReady]);

  return (
    <div className="h-[100dvh] tallmd:h-[calc(100dvh-3.25rem)] flex flex-col bg-wx-ink text-wx-fg [contain:layout_paint]">
      <div className="flex-1 relative overflow-hidden">
        <div className={`absolute inset-0 ${splitProduct ? 'flex flex-row' : ''}`}>
        <div className={splitProduct ? 'relative h-full flex-1 min-w-0' : 'relative h-full w-full'}>
        <AnnotationToolbar {...annotations} />
        <Map
          ref={mapRef}
          initialViewState={viewState}
          // setViewState here is what keeps pill labels (zoom>=8 switches to
          // city name) and the live circle-radius hint following pan/zoom.
          // The heavy bounds + pill-list recompute is on `moveend` via
          // settleMapViewport — see handleMapLoad.
          onMove={(e) => setViewState(e.viewState)}
          onLoad={handleMapLoad}
          style={{ width: '100%', height: '100%', cursor: mapCursor }}
          mapLib={mapboxgl as any}
          mapStyle={styleUrl}
          // Force mercator — Mapbox Standard styles default to globe, which
          // our radar overlays (mercator-tile-anchored rasters + GeoJSON
          // fills) can't render onto correctly.
          projection={{ name: 'mercator' } as any}
          mapboxAccessToken={token || undefined}
          customAttribution={[
            // LibreWxR radar composite + CAP alert layers — required by their CC BY 4.0 license.
            '<a href="https://librewxr.net" target="_blank" rel="noopener noreferrer">© LibreWxR</a> (CC BY 4.0)',
            // NOAA NWS / NCEP single-site reflectivity, velocity, and Level II tiles. Public-domain
            // data, but a courtesy credit matches the convention of other operational radar viewers.
            '<a href="https://www.weather.gov" target="_blank" rel="noopener noreferrer">NOAA / NWS</a>',
          ].join(' · ')}
          dragPan={drawMode === 'none' && !annotations.isActive}
          scrollZoom={drawMode === 'none' && !annotations.isActive}
          dragRotate={false}
          // touchZoomRotate enables BOTH pinch-zoom and two-finger rotate.
          // We want pinch-zoom on mobile but not rotate, so enable here and
          // imperatively call touchZoomRotate.disableRotation() in
          // handleMapLoad. Disable when drawing so two-finger gestures
          // don't accidentally zoom while the operator is sketching audience.
          touchZoomRotate={drawMode === 'none' && !annotations.isActive}
          touchPitch={false}
          boxZoom={false}
          doubleClickZoom={!annotations.isActive}
          onClick={handleMapClick}
          onMouseMove={handleMapMouseMove}
          onMouseLeave={() => { setHoverPixel(null); setHoverSub(null); }}
          // Required so the AnnotationToolbar's "snapshot" button can read
          // pixels back out of the WebGL canvas via toDataURL(). Costs a
          // small amount of GPU memory; negligible for our render budget.
          preserveDrawingBuffer
        >
          {liveRadarSource && (
            <Source key={liveSourceKey} id={radarSourceId} {...liveRadarSource}>
              <Layer {...liveRadarLayer} />
            </Source>
          )}

          {/* Render only the ±LWXR_MOUNT_RADIUS frames around the current one
              as raster sources. Frame visibility is driven imperatively via
              setPaintProperty in the effect above. Tiles for unmounted frames
              stay in Mapbox's tile cache so re-entering the window is fast.
              maxzoom is fixed to LibreWxR's tile cap so Mapbox
              over-scales (instead of going blank) past city-level zoom. */}
          {useLibreWxR && lwxrMountedFrames.map((f) => (
            <Source
              key={lwxrSourceId(f.time)}
              id={lwxrSourceId(f.time)}
              type="raster"
              tiles={[lwxrFrameUrl(f)]}
              tileSize={LIBREWXR_TILE_SIZE}
              maxzoom={LIBREWXR_MAX_ZOOM}
            >
              <Layer
                id={lwxrLayerId(f.time)}
                type="raster"
                paint={LWXR_FRAME_PAINT}
                {...tileAnchor}
              />
            </Source>
          ))}

          {level2GeoJSONSource && (
            <Source
              key={`level2gj:${selectedSite}:${level2Product}:${level2Overlay?.scan_time}:${resolvedSweepIndex}:${isComposite ? 'c' : 'b'}`}
              id={level2GeoJSONSourceId}
              {...level2GeoJSONSource}
            >
              <Layer {...level2FillLayer} />
            </Source>
          )}

          {level2ImageSource && (
            <Source
              key={`level2png:${selectedSite}:${level2Product}:${level2Overlay?.scan_time}:${resolvedSweepIndex}:${isComposite ? 'c' : 'b'}`}
              id={level2ImageSourceId}
              {...level2ImageSource}
            >
              <Layer {...level2RasterLayer} />
            </Source>
          )}

          {/* Forecast model overlay (Phase 3). Public WMS-backed raster
              source: HRRR REFC (IEM), NDFD T2M/Wind (nowCOAST), WPC QPF
              (NOAA mapservices). Key on overlay+hour so changing forecast
              hour replaces the source cleanly rather than fading. */}
          {activeModel && (
            <Source
              key={`model:${activeModel.id}:${modelHour}`}
              id="model-overlay-src"
              type="raster"
              tiles={[activeModel.tileUrl(modelHour)]}
              tileSize={512}
            >
              <Layer
                id="model-overlay-layer"
                type="raster"
                paint={{
                  'raster-opacity': modelOpacity / 100,
                  'raster-fade-duration': 120,
                  'raster-resampling': 'linear',
                }}
                {...tileAnchor}
              />
            </Source>
          )}

          {/* F10: MRMS MESH overlay. Above radar tiles, below labels/
              warnings/pins, so hail tracks read as part of the radar
              product band. ncWMS serves the GRIB2 variable directly with
              a default raster style + a hail-sized colorscalerange
              (0-75 mm ≈ 0-3 in). Window selector (30/60/120 min) lives in
              the layer panel — the URL changes when the operator picks a
              different accumulation, which swaps the SWR key and remounts
              the source. */}
          {showMesh && meshUrlPath && (
            <Source
              key={`mesh:${meshUrlPath}`}
              id="mesh-overlay-src"
              type="raster"
              tiles={[
                `https://thredds.ucar.edu/thredds/wms/${meshUrlPath}` +
                `?service=WMS&request=GetMap&version=1.3.0` +
                `&layers=${encodeURIComponent('MaxEstimatedSizeofHail_altitude_above_msl')}` +
                `&styles=raster%2Fdefault` +
                `&colorscalerange=5%2C75` +
                `&belowmincolor=transparent` +
                `&format=image/png&transparent=true` +
                `&width=256&height=256&crs=EPSG:3857` +
                `&bbox={bbox-epsg-3857}`,
              ]}
              tileSize={256}
            >
              <Layer
                id="mesh-overlay-layer"
                type="raster"
                paint={{
                  // Slightly translucent so reflectivity underneath remains
                  // legible. 0.7 reads as "real product, but layered".
                  'raster-opacity': 0.7,
                  'raster-fade-duration': 150,
                  'raster-resampling': 'linear',
                }}
                {...tileAnchor}
              />
            </Source>
          )}

          {/* F7: SPC categorical outlook layer. Below NWS warnings so an
              active warning polygon never gets obscured by the outlook
              wash; above radar so the operator can read risk regions over
              the storm field. */}
          <Source id="spc-source" type="geojson" data={spcGeo as any}>
            <Layer
              id="spc-fill"
              {...overlayAnchor}
              type="fill"
              layout={{ visibility: spcLayerVis }}
              paint={{
                'fill-color': SPC_FILL_EXPR,
                'fill-opacity': 0.25,
                'fill-antialias': true,
              }}
            />
            <Layer
              id="spc-line"
              {...overlayAnchor}
              type="line"
              layout={{ visibility: spcLayerVis, 'line-cap': 'round', 'line-join': 'round' }}
              paint={{
                'line-color': SPC_LINE_EXPR,
                'line-width': 1.8,
                'line-opacity': 0.85,
              }}
            />
          </Source>

          {/* NWS forecast + fire zone outlines from /maps/nws-zones.geojson
              (generated by `npm run gen:zones`). Single static FeatureCollection
              of pre-simplified polygons — Mapbox handles ~7K features in a
              client GeoJSON source comfortably. Drawn between SPC outlooks
              and warnings so active warning polygons remain on top. */}
          <Source
            id="nws-zones-source"
            type="geojson"
            data="/maps/nws-zones.geojson"
          >
            <Layer
              id="nws-zones-forecast"
              {...overlayAnchor}
              type="line"
              filter={['==', ['get', 'kind'], 'forecast']}
              layout={{ visibility: showZones ? 'visible' : 'none', 'line-join': 'round' }}
              paint={{
                'line-color': '#e2e8f0',
                'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.6, 8, 1.4, 12, 2.2],
                'line-opacity': 0.85,
              }}
            />
            <Layer
              id="nws-zones-fire"
              {...overlayAnchor}
              type="line"
              filter={['==', ['get', 'kind'], 'fire']}
              layout={{ visibility: showZones ? 'visible' : 'none', 'line-join': 'round' }}
              paint={{
                'line-color': '#fda4af',
                'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.6, 8, 1.2, 12, 2],
                'line-opacity': 0.75,
                'line-dasharray': [3, 2],
              }}
            />
          </Source>

          <Source id="cap-warning-source" type="geojson" data={capWarningsGeo as any}>
            {/* CAP polygons styled distinctly from NWS warnings: sky-blue
                stroke with a 6/3 dash pattern + a low-opacity fill. Anchored
                under the NWS layers (added before storm-track-source) so
                NWS warnings remain visually dominant when both are shown. */}
            <Layer
              id="cap-warning-fill"
              {...overlayAnchor}
              type="fill"
              layout={{ visibility: showCap ? 'visible' : 'none' }}
              paint={{ 'fill-color': '#38bdf8', 'fill-opacity': 0.08 }}
            />
            <Layer
              id="cap-warning-line"
              {...overlayAnchor}
              type="line"
              layout={{ visibility: showCap ? 'visible' : 'none', 'line-cap': 'round', 'line-join': 'round' }}
              paint={{
                'line-color': '#38bdf8',
                'line-width': 1.5,
                'line-dasharray': [6, 3],
                'line-opacity': 0.9,
              }}
            />
          </Source>

          <Source id="storm-track-source" type="geojson" data={tracksGeo as any}>
            <Layer
              id="storm-track-observed"
              {...overlayAnchor}
              type="line"
              filter={['==', ['get', 'segment'], 'observed']}
              layout={{ visibility: trackLayerVis, 'line-cap': 'round', 'line-join': 'round' }}
              paint={{
                'line-color': STORM_TRACK_LINE_COLOR,
                'line-width': 3,
                'line-opacity': 0.95,
              }}
            />
            <Layer
              id="storm-track-forecast"
              {...overlayAnchor}
              type="line"
              filter={['==', ['get', 'segment'], 'forecast']}
              layout={{ visibility: trackLayerVis, 'line-cap': 'round', 'line-join': 'round' }}
              paint={{
                'line-color': STORM_TRACK_LINE_COLOR,
                'line-width': 2.5,
                'line-opacity': 0.75,
                'line-dasharray': [2, 1.5],
              }}
            />
            <Layer
              id="storm-track-points"
              {...overlayAnchor}
              type="circle"
              filter={['==', ['get', 'segment'], 'observed']}
              layout={{ visibility: trackLayerVis }}
              paint={{
                'circle-radius': 4,
                'circle-color': STORM_TRACK_LINE_COLOR,
                'circle-stroke-color': '#0b1220',
                'circle-stroke-width': 1.5,
              }}
            />
            {/* Rotating arrowhead at the forecast endpoint. Triangle glyph
                rotated to match storm motion (deg, clockwise from N) and
                pinned to the map's coordinate system so it doesn't spin
                with viewport tilt. */}
            <Layer
              id="storm-track-arrow"
              {...overlayAnchor}
              type="symbol"
              filter={['==', ['get', 'kind'], 'forecast-end']}
              layout={{
                visibility: trackLayerVis,
                'text-field': '▲',
                'text-size': 16,
                // Default DIN Pro doesn't carry U+25B2; fall through to Arial
                // Unicode MS so we don't render a tofu box at the arrowhead.
                'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'],
                'text-rotate': ['get', 'motion_deg'],
                'text-rotation-alignment': 'map',
                'text-keep-upright': false,
                'text-allow-overlap': true,
                'text-ignore-placement': true,
                'text-anchor': 'center',
              }}
              paint={{
                'text-color': STORM_TRACK_LINE_COLOR,
                'text-halo-color': '#0b1220',
                'text-halo-width': 1.6,
              }}
            />
            {/* Upright speed label just above the arrow. text-offset moves
                it ~1 line-height up; text-rotation-alignment=viewport keeps
                it readable regardless of motion direction. */}
            <Layer
              id="storm-track-speed"
              {...overlayAnchor}
              type="symbol"
              filter={['==', ['get', 'kind'], 'forecast-end']}
              layout={{
                visibility: trackLayerVis,
                'text-field': ['concat', ['to-string', ['round', ['get', 'motion_kts']]], ' kt'],
                'text-size': 11,
                'text-anchor': 'bottom',
                'text-offset': [0, -1.2],
                'text-rotation-alignment': 'viewport',
                'text-allow-overlap': true,
                'text-ignore-placement': true,
              }}
              paint={{
                'text-color': '#f8fafc',
                'text-halo-color': '#0b1220',
                'text-halo-width': 1.6,
              }}
            />
          </Source>

          {/* F4: Local Storm Reports overlay. Outer halo + solid inner pin
              so the report stands off the basemap even when it lands inside
              a colored warning polygon. */}
          <Source id="lsr-source" type="geojson" data={displayLsrGeo as any}>
            <Layer
              id="lsr-halo"
              {...overlayAnchor}
              type="circle"
              layout={{ visibility: showLsr ? 'visible' : 'none' }}
              paint={{
                'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 6, 7, 10, 10, 14, 14, 20],
                'circle-color': LSR_FILL_EXPR,
                'circle-opacity': 0.25,
                'circle-blur': 0.4,
              }}
            />
            <Layer
              id="lsr-pin"
              {...overlayAnchor}
              type="circle"
              layout={{ visibility: showLsr ? 'visible' : 'none' }}
              paint={{
                'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 3, 7, 5, 10, 7, 14, 10],
                'circle-color': LSR_FILL_EXPR,
                'circle-stroke-color': '#0b1220',
                'circle-stroke-width': 1.5,
              }}
            />
          </Source>

          {/* Live event mode: pulsing ring at each active cluster centroid
              (≥2 same-hazard reports within 5 km / 10 min, fired in the last
              30 min). Sits below the storm-report pins so the operator can
              still click individual reports inside the ring. */}
          <Source id="storm-report-cluster-source" type="geojson" data={stormReportClustersGeo as any}>
            <Layer
              id="storm-report-cluster-ring"
              {...overlayAnchor}
              type="circle"
              layout={{ visibility: showStormReports ? 'visible' : 'none' }}
              paint={{
                'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 22, 7, 38, 10, 60, 14, 96],
                'circle-color': STORM_REPORT_FILL_EXPR,
                'circle-opacity': 0.04 + 0.20 * clusterPulse,
                'circle-stroke-color': STORM_REPORT_FILL_EXPR,
                'circle-stroke-width': 1.5,
                'circle-stroke-opacity': 0.55 + 0.35 * clusterPulse,
                'circle-blur': 0.15,
              }}
            />
          </Source>

          {/* Subscriber-submitted storm reports (Telegram /report flow).
              Triangle glyph so the operator can pick subscriber pins out of
              a cluster of NWS LSRs at a glance. Same hazard palette so the
              colors stay consistent across all "what's happening on the
              ground" overlays. */}
          <Source id="storm-report-source" type="geojson" data={displayStormReportsGeo as any}>
            <Layer
              id="storm-report-halo"
              {...overlayAnchor}
              type="circle"
              layout={{ visibility: showStormReports ? 'visible' : 'none' }}
              paint={{
                'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 8, 7, 12, 10, 16, 14, 22],
                'circle-color': STORM_REPORT_FILL_EXPR,
                'circle-opacity': 0.18,
                'circle-blur': 0.5,
              }}
            />
            <Layer
              id="storm-report-pin"
              {...overlayAnchor}
              type="symbol"
              layout={{
                visibility: showStormReports ? 'visible' : 'none',
                'text-field': '▲',
                'text-size': ['interpolate', ['linear'], ['zoom'], 4, 12, 7, 16, 10, 22],
                'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'],
                'text-allow-overlap': true,
                'text-ignore-placement': true,
                'text-anchor': 'center',
              }}
              paint={{
                'text-color': STORM_REPORT_FILL_EXPR,
                'text-halo-color': '#0b1220',
                'text-halo-width': 2,
                'text-opacity': 0.98,
              }}
            />
          </Source>

          {/* F13: mPING crowdsource reports. Diamond glyph (rotated square)
              distinguishes citizen pings from the circular LSR pins, since
              the operator should treat them as lower-confidence ground
              truth. Same hazard palette as LSRs so a tornado mPING reads
              the same red as a tornado LSR. */}
          <Source id="mping-source" type="geojson" data={mpingGeo as any}>
            <Layer
              id="mping-pin"
              {...overlayAnchor}
              type="symbol"
              layout={{
                visibility: showMping ? 'visible' : 'none',
                'text-field': '◆',
                'text-size': ['interpolate', ['linear'], ['zoom'], 4, 11, 7, 15, 10, 19],
                'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'],
                'text-allow-overlap': true,
                'text-ignore-placement': true,
                'text-anchor': 'center',
              }}
              paint={{
                'text-color': LSR_FILL_EXPR,
                'text-halo-color': '#0b1220',
                'text-halo-width': 1.4,
                'text-opacity': 0.95,
              }}
            />
          </Source>

          {/* F12: METAR surface obs — compact station plot. Pin colored
              by temperature (°C), wind arrow rotated to the direction the
              wind is going TOWARD (wdir + 180 is the FROM direction; the
              arrow glyph naturally points where it's headed), and a
              text label (T/Td/wind) that only appears at higher zooms to
              avoid clutter at CONUS view. Gusts shown in red. */}
          <Source id="metar-source" type="geojson" data={metarGeo as any}>
            <Layer
              id="metar-pin"
              {...overlayAnchor}
              type="circle"
              layout={{ visibility: showMetar ? 'visible' : 'none' }}
              paint={{
                'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 3, 7, 4.5, 10, 6],
                'circle-color': [
                  'case',
                  ['==', ['typeof', ['get', 'temp']], 'number'],
                  [
                    'interpolate', ['linear'], ['to-number', ['get', 'temp']],
                    -15, '#a5f3fc',
                    -5,  '#7dd3fc',
                    5,   '#60a5fa',
                    15,  '#34d399',
                    22,  '#fbbf24',
                    30,  '#fb923c',
                    38,  '#ef4444',
                  ],
                  '#94a3b8',
                ] as any,
                'circle-stroke-color': '#0b1220',
                'circle-stroke-width': 1.2,
                'circle-opacity': 0.95,
              }}
            />
            <Layer
              id="metar-wind"
              {...overlayAnchor}
              type="symbol"
              filter={[
                'all',
                ['==', ['typeof', ['get', 'wdir']], 'number'],
                ['==', ['typeof', ['get', 'wspd']], 'number'],
                ['>', ['to-number', ['get', 'wspd']], 0],
              ]}
              layout={{
                visibility: showMetar ? 'visible' : 'none',
                'text-field': '↓',
                'text-size': ['interpolate', ['linear'], ['zoom'], 4, 12, 7, 16, 10, 22],
                'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'],
                'text-rotate': ['to-number', ['get', 'wdir']],
                'text-rotation-alignment': 'map',
                'text-allow-overlap': true,
                'text-ignore-placement': true,
                'text-anchor': 'center',
              }}
              paint={{
                // Gusts >= 35 kt or sustained >= 25 kt → red emphasis;
                // otherwise white. Visually flags the storm cores without
                // requiring the operator to open every popup.
                'text-color': [
                  'case',
                  ['>=', ['coalesce', ['to-number', ['get', 'wgst']], 0], 35], '#fca5a5',
                  ['>=', ['to-number', ['get', 'wspd']], 25],                  '#fde047',
                  '#f8fafc',
                ] as any,
                'text-halo-color': '#0b1220',
                'text-halo-width': 1.4,
              }}
            />
            <Layer
              id="metar-label"
              {...overlayAnchor}
              type="symbol"
              minzoom={7}
              layout={{
                visibility: showMetar ? 'visible' : 'none',
                'text-field': [
                  'concat',
                  ['coalesce', ['get', 'icaoId'], ''],
                  '\n',
                  // Temp / dewp in °F so the operator doesn't context-switch.
                  // 1.8 * c + 32, rounded.
                  ['case',
                    ['==', ['typeof', ['get', 'temp']], 'number'],
                    ['concat', ['to-string', ['round', ['+', ['*', ['to-number', ['get', 'temp']], 1.8], 32]]], '°'],
                    '—',
                  ],
                  '/',
                  ['case',
                    ['==', ['typeof', ['get', 'dewp']], 'number'],
                    ['to-string', ['round', ['+', ['*', ['to-number', ['get', 'dewp']], 1.8], 32]]],
                    '—',
                  ],
                  ['case',
                    ['>', ['coalesce', ['to-number', ['get', 'wspd']], 0], 0],
                    ['concat', '\n', ['to-string', ['round', ['to-number', ['get', 'wspd']]]], 'kt'],
                    '',
                  ],
                ] as any,
                'text-size': ['interpolate', ['linear'], ['zoom'], 7, 9, 10, 11, 13, 12],
                'text-anchor': 'top',
                'text-offset': [0, 0.9],
                'text-allow-overlap': false,
                'text-ignore-placement': false,
                'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'],
              }}
              paint={{
                'text-color': '#e2e8f0',
                'text-halo-color': '#0b1220',
                'text-halo-width': 1.5,
              }}
            />
          </Source>

          <Source id="subs-source" type="geojson" data={subsGeo}>
            <Layer {...subsHaloLayer} />
            <Layer {...subsPinLayer} />
            {/* Coverage density. Heatmap reads as a soft glow over populated
                areas; the "dark" zones at typical AOR zooms are the gap.
                Falls off above zoom 11 so individual pins take over. */}
            <Layer
              id="subs-coverage-heatmap"
              {...overlayAnchor}
              type="heatmap"
              layout={{ visibility: showCoverage ? 'visible' : 'none' }}
              paint={{
                'heatmap-weight': 1,
                'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 4, 0.6, 9, 1.2, 12, 1.8],
                'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 4, 18, 7, 32, 10, 50, 13, 80],
                'heatmap-opacity': ['interpolate', ['linear'], ['zoom'], 4, 0.55, 11, 0.55, 13, 0],
                'heatmap-color': [
                  'interpolate', ['linear'], ['heatmap-density'],
                  0,   'rgba(0,0,0,0)',
                  0.15, 'rgba(59,130,246,0.25)',
                  0.4,  'rgba(56,189,248,0.45)',
                  0.7,  'rgba(34,197,94,0.55)',
                  1.0,  'rgba(250,204,21,0.65)',
                ],
              }}
            />
          </Source>

          {/* GOES-19 GLM lightning flashes — small yellow bolts that fade
              linearly over LIGHTNING_FADE_MS. Symbol layer with no click
              handler, so it never steals interaction from subs/LSR/warnings
              underneath. The `paint` here is just an initial value; the 1 Hz
              effect rebinds `icon-opacity` with the current Date.now(). */}
          <Source id="lightning-source" type="geojson" data={lightningGeo}>
            <Layer
              id="lightning-bolts"
              {...overlayAnchor}
              type="symbol"
              layout={{
                'icon-image': 'lightning-bolt',
                'icon-allow-overlap': true,
                'icon-ignore-placement': true,
                'icon-anchor': 'center',
                'icon-size': ['interpolate', ['linear'], ['zoom'], 4, 0.35, 8, 0.55, 12, 0.85],
                visibility: showLightning ? 'visible' : 'none',
              }}
              paint={{
                'icon-opacity': [
                  'interpolate', ['linear'],
                  ['-', Date.now(), ['get', 't']],
                  0, 1,
                  LIGHTNING_FADE_MS, 0,
                ] as any,
              }}
            />
          </Source>

          {/* NWS warning polygons mount LAST (just before the operator's draw
              layers) so warning fills + outlines paint on top of radar tiles,
              storm tracks, LSR pins, subscriber pins, lightning, and CAP. The
              operator's active selection still wins, by sitting below. */}
          <Source id="warning-source" type="geojson" data={displayWarningsGeo as any}>
            <Layer
              id="warning-fill"
              {...overlayAnchor}
              type="fill"
              layout={{ visibility: nwsLayerVis }}
              paint={WARNING_FILL_PAINT}
            />
            <Layer
              id="warning-line"
              {...overlayAnchor}
              type="line"
              filter={['all',
                ['!=', ['get', 'category'], 'watch'],
                ['!=', ['get', 'category'], 'discussion'],
              ]}
              layout={{ visibility: nwsLayerVis }}
              paint={WARNING_LINE_PAINT}
            />
            <Layer
              id="warning-line-watch"
              {...overlayAnchor}
              type="line"
              filter={['==', ['get', 'category'], 'watch']}
              layout={{ visibility: nwsLayerVis }}
              paint={WARNING_LINE_WATCH_PAINT}
            />
            <Layer
              id="warning-line-discussion"
              {...overlayAnchor}
              type="line"
              filter={['==', ['get', 'category'], 'discussion']}
              layout={{ visibility: nwsLayerVis, 'line-cap': 'round', 'line-join': 'round' }}
              paint={WARNING_LINE_DISCUSSION_PAINT}
            />
          </Source>

          {/* F9: NEXRAD velocity-couplet trails. Drawn FIRST so the pin sits
              on top of its own trail. LineString per track_id ordered
              past→present; dashed pattern + low opacity reads as "history"
              vs. the bright pin's "now". */}
          <Source id="couplet-tracks-source" type="geojson" data={coupletTracks as any}>
            <Layer
              id="couplet-trail"
              {...overlayAnchor}
              type="line"
              layout={{
                visibility: showCouplets ? 'visible' : 'none',
                'line-cap': 'round',
                'line-join': 'round',
              }}
              paint={{
                'line-color': '#d946ef',
                'line-width': ['interpolate', ['linear'], ['zoom'], 4, 1.2, 8, 1.8, 12, 2.4],
                'line-opacity': 0.55,
                'line-dasharray': [2, 2],
              }}
            />
          </Source>

          {/* F9: latest-detection pin per track_id. Color graduates by max
              shear: amber under 60 kt (weak couplet), fuchsia 60-80 (meso),
              red 80+ (TVS-strength). Stroke thickness scales with
              volume_count so a circulation that's been around for 6 scans
              reads as more substantial than a single-scan blip. */}
          <Source id="couplet-pin-source" type="geojson" data={coupletGeo as any}>
            <Layer
              id="couplet-halo"
              {...overlayAnchor}
              type="circle"
              layout={{ visibility: showCouplets ? 'visible' : 'none' }}
              paint={{
                'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 10, 8, 16, 12, 24],
                'circle-color': [
                  'case',
                  ['>=', ['get', 'max_shear_kt'], 80], '#ef4444',
                  ['>=', ['get', 'max_shear_kt'], 60], '#d946ef',
                  '#f59e0b',
                ] as any,
                'circle-opacity': 0.18,
                'circle-blur': 0.6,
              }}
            />
            <Layer
              id="couplet-pin"
              {...overlayAnchor}
              type="circle"
              layout={{ visibility: showCouplets ? 'visible' : 'none' }}
              paint={{
                'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 4, 8, 7, 12, 11],
                'circle-color': [
                  'case',
                  ['>=', ['get', 'max_shear_kt'], 80], '#ef4444',
                  ['>=', ['get', 'max_shear_kt'], 60], '#d946ef',
                  '#f59e0b',
                ] as any,
                'circle-stroke-color': '#0b1220',
                'circle-stroke-width': [
                  'interpolate', ['linear'],
                  ['get', 'volume_count'],
                  1, 1.2,
                  3, 2.0,
                  6, 3.0,
                ] as any,
              }}
            />
            <Layer
              id="couplet-label"
              {...overlayAnchor}
              type="symbol"
              layout={{
                visibility: showCouplets ? 'visible' : 'none',
                'text-field': ['get', 'track_id'],
                'text-size': ['interpolate', ['linear'], ['zoom'], 4, 9, 8, 11, 12, 13],
                'text-anchor': 'top',
                'text-offset': [0, 0.8],
                'text-allow-overlap': true,
                'text-ignore-placement': true,
                'text-font': ['DIN Pro Bold', 'Arial Unicode MS Bold'],
              }}
              paint={{
                'text-color': '#fde047',
                'text-halo-color': '#0b1220',
                'text-halo-width': 1.6,
              }}
            />
          </Source>

          {/* ProbSevere 3.0 — object-based ML severe probabilities. Each storm
              object is filled/outlined by its dominant hazard (tor=red,
              hail=cyan, wind=blue, severe=amber); opacity + outline width scale
              with the probability, so a 70% ProbTor cell reads loud and a 3%
              blip reads faint. Labels appear once the dominant prob clears 10%
              to keep quiet days uncluttered. */}
          <Source id="probsevere-source" type="geojson" data={probSevereGeo as any}>
            <Layer
              id="probsevere-fill"
              {...overlayAnchor}
              type="fill"
              // ProbSevere tags every tracked cell, including 0% (no severe
              // signal at all) — those are noise, so draw only cells with ≥1%.
              // Shown objects stay legible even at low prob and bolden as the
              // probability climbs.
              filter={['>=', ['get', 'topProb'], 1] as any}
              layout={{ visibility: showProbSevere ? 'visible' : 'none' }}
              paint={{
                'fill-color': [
                  'match', ['get', 'topType'],
                  'tor', '#ef4444',
                  'hail', '#22d3ee',
                  'wind', '#3b82f6',
                  '#f59e0b',
                ] as any,
                'fill-opacity': [
                  'interpolate', ['linear'], ['get', 'topProb'],
                  1, 0.14, 50, 0.32, 90, 0.46,
                ] as any,
              }}
            />
            <Layer
              id="probsevere-line"
              {...overlayAnchor}
              type="line"
              filter={['>=', ['get', 'topProb'], 1] as any}
              layout={{
                visibility: showProbSevere ? 'visible' : 'none',
                'line-cap': 'round',
                'line-join': 'round',
              }}
              paint={{
                'line-color': [
                  'match', ['get', 'topType'],
                  'tor', '#ef4444',
                  'hail', '#22d3ee',
                  'wind', '#3b82f6',
                  '#f59e0b',
                ] as any,
                'line-width': [
                  'interpolate', ['linear'], ['get', 'topProb'],
                  1, 1.8, 50, 3.2, 90, 4.5,
                ] as any,
                'line-opacity': 0.95,
              }}
            />
            <Layer
              id="probsevere-label"
              {...overlayAnchor}
              type="symbol"
              filter={['>=', ['get', 'topProb'], 10] as any}
              layout={{
                visibility: showProbSevere ? 'visible' : 'none',
                'text-field': [
                  'concat',
                  ['to-string', ['get', 'topProb']], '% ',
                  ['upcase', ['get', 'topType']],
                ] as any,
                'text-size': ['interpolate', ['linear'], ['zoom'], 4, 10, 8, 12, 12, 14] as any,
                'text-anchor': 'center',
                'text-allow-overlap': false,
                'text-font': ['DIN Pro Bold', 'Arial Unicode MS Bold'],
              }}
              paint={{
                'text-color': '#f8fafc',
                'text-halo-color': '#0b1220',
                'text-halo-width': 1.8,
              }}
            />
          </Source>

          {/* ProbSevere projected motion — extrapolated centroid path (+15/30/45
              min) for the ranked cells. The nowcasting "where is it going"
              layer; colored to match each cell's dominant hazard. */}
          <Source id="probsevere-motion-line-source" type="geojson" data={probSevereMotion.lines as any}>
            <Layer
              id="probsevere-motion-line"
              {...overlayAnchor}
              type="line"
              layout={{
                visibility: showProbSevere ? 'visible' : 'none',
                'line-cap': 'round',
                'line-join': 'round',
              }}
              paint={{
                'line-color': [
                  'match', ['get', 'topType'],
                  'tor', '#ef4444', 'hail', '#22d3ee', 'wind', '#3b82f6', '#f59e0b',
                ] as any,
                'line-width': ['interpolate', ['linear'], ['zoom'], 4, 1, 8, 2, 12, 3] as any,
                'line-opacity': 0.85,
                'line-dasharray': [1.5, 1] as any,
              }}
            />
          </Source>
          <Source id="probsevere-motion-tick-source" type="geojson" data={probSevereMotion.ticks as any}>
            <Layer
              id="probsevere-motion-tick"
              {...overlayAnchor}
              type="circle"
              layout={{ visibility: showProbSevere ? 'visible' : 'none' }}
              paint={{
                'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 2, 8, 3, 12, 4.5] as any,
                'circle-color': [
                  'match', ['get', 'topType'],
                  'tor', '#ef4444', 'hail', '#22d3ee', 'wind', '#3b82f6', '#f59e0b',
                ] as any,
                'circle-stroke-color': '#0b1220',
                'circle-stroke-width': 1,
              }}
            />
            <Layer
              id="probsevere-motion-label"
              {...overlayAnchor}
              type="symbol"
              filter={['==', ['get', 'min'], 45] as any}
              layout={{
                visibility: showProbSevere ? 'visible' : 'none',
                'text-field': ['get', 'label'] as any,
                'text-size': ['interpolate', ['linear'], ['zoom'], 4, 9, 8, 10.5, 12, 12] as any,
                'text-anchor': 'left',
                'text-offset': [0.6, 0],
                'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'],
              }}
              paint={{
                'text-color': '#cbd5e1',
                'text-halo-color': '#0b1220',
                'text-halo-width': 1.4,
              }}
            />
          </Source>

          {/* Rapidly-intensifying ProbSevere cells — a bright ring + reason
              badge (prob jump or lightning jump) so escalating storms pull the
              eye. The "is it getting worse" nowcast signal. */}
          <Source id="probsevere-hot-source" type="geojson" data={probSevereHot as any}>
            <Layer
              id="probsevere-hot-ring"
              {...overlayAnchor}
              type="circle"
              layout={{ visibility: showProbSevere ? 'visible' : 'none' }}
              paint={{
                'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 12, 8, 20, 12, 30] as any,
                'circle-color': 'rgba(0,0,0,0)',
                'circle-stroke-color': '#fde047',
                'circle-stroke-width': 2.5,
                'circle-stroke-opacity': 0.9,
              }}
            />
            <Layer
              id="probsevere-hot-label"
              {...overlayAnchor}
              type="symbol"
              layout={{
                visibility: showProbSevere ? 'visible' : 'none',
                'text-field': ['concat', '⚠ ', ['get', 'reason']] as any,
                'text-size': ['interpolate', ['linear'], ['zoom'], 4, 10, 8, 12, 12, 14] as any,
                'text-anchor': 'bottom',
                'text-offset': [0, -1.6],
                'text-allow-overlap': true,
                'text-font': ['DIN Pro Bold', 'Arial Unicode MS Bold'],
              }}
              paint={{
                'text-color': '#fde047',
                'text-halo-color': '#0b1220',
                'text-halo-width': 1.8,
              }}
            />
          </Source>

          {selection && selection.type === 'circle' && selectionCircleData && (
            <Source id="selection-circle" type="geojson" data={selectionCircleData}>
              <Layer id="sel-circle" type="circle" paint={selectionCirclePaint} {...overlayAnchor} />
            </Source>
          )}
          {selection && selection.type === 'polygon' && selectionPolyData && (
            <Source id="selection-poly" type="geojson" data={selectionPolyData}>
              <Layer id="sel-poly-fill" type="fill" paint={SEL_POLY_FILL_PAINT} {...overlayAnchor} />
              <Layer id="sel-poly-line" type="line" paint={SEL_POLY_LINE_PAINT} {...overlayAnchor} />
            </Source>
          )}

          {drawMode === 'polygon' && polygonPoints.length > 0 && polyDrawData && (
            <Source id="poly-draw" type="geojson" data={polyDrawData}>
              <Layer id="poly-line" type="line" paint={SEL_POLY_LINE_PAINT} {...overlayAnchor} />
            </Source>
          )}

          <AnnotationLayer geojson={annotations.geojson} />

          {probSeverePopup ? (
            <Popup
              longitude={probSeverePopup.lng}
              latitude={probSeverePopup.lat}
              anchor="bottom"
              offset={12}
              closeButton={false}
              closeOnClick={false}
              onClose={() => setProbSeverePopup(null)}
              maxWidth="300px"
              className="wx-warning-popup"
            >
              {(() => {
                const TYPE_COLOR: Record<string, string> = {
                  tor: 'text-red-400', hail: 'text-cyan-300', wind: 'text-blue-400', severe: 'text-amber-400',
                };
                const row = (label: string, v: number, hot: boolean) => (
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[10px] text-wx-mute">{label}</span>
                    <span className={`font-mono text-[11px] ${hot ? 'text-wx-fg font-semibold' : 'text-wx-mute'}`}>{v}%</span>
                  </div>
                );
                const p = probSeverePopup;
                return (
                  <div className="w-[280px] space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className={`text-[12px] font-semibold ${TYPE_COLOR[p.topType] ?? 'text-wx-fg'}`}>
                        ProbSevere · {p.topType.toUpperCase()} {p.topProb}%
                      </div>
                      <button
                        type="button"
                        onClick={() => setProbSeverePopup(null)}
                        className="text-wx-mute hover:text-wx-fg"
                        aria-label="Close popup"
                      >
                        <X size={12} />
                      </button>
                    </div>
                    <div className="space-y-0.5 rounded-md border border-wx-line bg-wx-ink p-2">
                      {row('ProbSevere', p.severe, p.topType === 'severe')}
                      {row('ProbTor', p.tor, p.topType === 'tor')}
                      {row('ProbHail', p.hail, p.topType === 'hail')}
                      {row('ProbWind', p.wind, p.topType === 'wind')}
                    </div>
                    {p.readout ? (
                      <pre className="max-h-44 overflow-y-auto whitespace-pre-wrap rounded-md border border-wx-line bg-wx-ink p-2 font-mono text-[10px] leading-relaxed text-wx-mute">
                        {p.readout}
                      </pre>
                    ) : null}
                    <a
                      href={composeUrlForProbSevereCell(p)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-wx-accent px-2.5 py-1.5 text-[11px] font-semibold text-black hover:bg-amber-300"
                      title="Draft an alert addressed to this cell's projected path"
                    >
                      <Send size={11} /> Draft alert · projected path
                    </a>
                    <div className="text-[9px] text-wx-mute">NOAA/CIMSS ProbSevere 3.0</div>
                  </div>
                );
              })()}
            </Popup>
          ) : null}

          {warningPopup ? (
            <Popup
              longitude={warningPopup.lng}
              latitude={warningPopup.lat}
              anchor="bottom"
              offset={12}
              closeButton={false}
              closeOnClick={false}
              onClose={() => setWarningPopup(null)}
              maxWidth="280px"
              className="wx-warning-popup"
            >
              {(() => {
                const chosen = warningPopup.chosenId
                  ? warningPopup.candidates.find((c) => c.id === warningPopup.chosenId) ?? null
                  : null;
                // Multi-candidate chooser: render one row per overlapping
                // polygon so the operator picks which warning to act on.
                if (!chosen) {
                  return (
                    <div className="w-[260px] space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-[11px] font-semibold text-wx-fg">
                          {warningPopup.candidates.length} warnings here
                        </div>
                        <button
                          type="button"
                          onClick={() => setWarningPopup(null)}
                          className="text-wx-mute hover:text-wx-fg"
                          aria-label="Close popup"
                        >
                          <X size={12} />
                        </button>
                      </div>
                      <ul className="space-y-1.5">
                        {warningPopup.candidates.map((w) => {
                          const t = alertTint(w.category, w.hazard, w.severity);
                          return (
                            <li key={w.id}>
                              <button
                                type="button"
                                onClick={() => {
                                  setWarningPopup({ ...warningPopup, chosenId: w.id });
                                  setSelectedWarning(w);
                                  focusWarning(w);
                                }}
                                className={`w-full text-left p-2 rounded-md bg-wx-ink border ${t.border} ${t.bg} hover:bg-wx-card transition`}
                              >
                                <div className={`text-[11px] font-semibold ${t.text}`}>{w.event}</div>
                                <div className="text-[10px] text-wx-mute mt-0.5 line-clamp-1">
                                  {shortNwsLocation(w.area_desc) ?? w.area_desc ?? '—'}
                                </div>
                                <div className="text-[10px] text-wx-mute mt-0.5">
                                  {categoryBadge(w.category)} · {w.severity ?? '—'}
                                </div>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  );
                }
                // Single-warning detail: mirrors the side-panel card so the
                // popup and inspector stay in sync after a selection.
                const t = alertTint(chosen.category, chosen.hazard, chosen.severity);
                const trackUrl = chosen.forecast_track && chosen.in_path_count != null
                  ? composeUrlForWarningTrack(chosen)
                  : null;
                return (
                  <div className={`w-[260px] p-1 space-y-1.5`}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className={`text-[11px] font-semibold ${t.text}`}>{chosen.event}</div>
                        {chosen.ai_summary ? (
                          <p className="text-[10.5px] text-wx-fg/90 mt-0.5 line-clamp-3">
                            {chosen.ai_summary}
                          </p>
                        ) : chosen.headline ? (
                          <p className="text-[10.5px] text-wx-fg/85 mt-0.5 line-clamp-3">
                            {chosen.headline}
                          </p>
                        ) : null}
                      </div>
                      <button
                        type="button"
                        onClick={() => setWarningPopup(null)}
                        className="text-wx-mute hover:text-wx-fg shrink-0"
                        aria-label="Close popup"
                      >
                        <X size={12} />
                      </button>
                    </div>
                    <div className="text-[10px] text-wx-mute">
                      {categoryBadge(chosen.category)} · {chosen.severity ?? '—'} · until{' '}
                      {chosen.expires_at
                        ? new Date(chosen.expires_at).toLocaleString([], {
                            month: 'short',
                            day: 'numeric',
                            hour: 'numeric',
                            minute: '2-digit',
                          })
                        : '—'}
                    </div>
                    <div className="flex items-center justify-between gap-2 pt-1">
                      <a href={`/nws/${chosen.id}`} className="text-[11px] text-wx-accent font-medium">
                        Full NWS detail →
                      </a>
                      <a
                        href={composeUrlForWarning(chosen)}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-wx-accent text-black rounded-md text-[11px] font-semibold hover:bg-amber-300"
                        title="Send to subscribers in this polygon"
                      >
                        <Send size={11} /> Send to polygon
                      </a>
                    </div>
                    {trackUrl ? (
                      <a
                        href={trackUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-1 inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 border border-amber-400/50 text-amber-300 hover:bg-amber-400/10 rounded-md text-[11px] font-semibold w-full"
                        title={`Send to ${chosen.in_path_count} subscribers in the storm's projected ${chosen.in_path_corridor_km ?? 8}km corridor`}
                      >
                        <Send size={11} />
                        Send to path · {chosen.in_path_count} in {chosen.in_path_corridor_km ?? 8}km
                      </a>
                    ) : null}
                    {warningPopup.candidates.length > 1 ? (
                      <button
                        type="button"
                        onClick={() => setWarningPopup({ ...warningPopup, chosenId: null })}
                        className="w-full text-[10px] text-wx-mute hover:text-wx-fg pt-0.5"
                      >
                        ← back to {warningPopup.candidates.length} warnings here
                      </button>
                    ) : null}
                  </div>
                );
              })()}
            </Popup>
          ) : null}
        </Map>
        </div>
        {warningSounding && (
          <div
            className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
            onClick={() => setWarningSounding(null)}
            role="presentation"
          >
            <div
              className="relative max-h-[90vh] w-full max-w-[520px] overflow-y-auto rounded-xl border border-wx-line bg-wx-card p-3 shadow-2xl"
              onClick={(e) => e.stopPropagation()}
              role="dialog"
              aria-modal="true"
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="text-[11px] font-semibold text-wx-fg">
                  Sounding · {warningSounding.label}
                  <span className="ml-1 font-mono text-[10px] text-wx-mute">
                    {warningSounding.lat.toFixed(2)}, {warningSounding.lon.toFixed(2)}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setWarningSounding(null)}
                  className="shrink-0 text-wx-mute hover:text-wx-fg"
                  aria-label="Close sounding"
                >
                  <X size={16} />
                </button>
              </div>
              {warningSounding.loading ? (
                <div className="flex h-64 items-center justify-center text-[11px] text-wx-mute">
                  Rendering Skew-T at the warning centroid…
                </div>
              ) : warningSounding.error ? (
                <div className="flex h-32 items-center justify-center text-center text-[11px] text-wx-danger">
                  Sounding unavailable ({warningSounding.error})
                </div>
              ) : warningSounding.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={warningSounding.imageUrl}
                  alt={`Environmental sounding at ${warningSounding.label}`}
                  className="mx-auto block w-full rounded-md"
                />
              ) : null}
              <div className="mt-1 text-[9px] text-wx-mute">
                Model column Skew-T at the polygon centroid · GFS
              </div>
            </div>
          </div>
        )}
        {splitProduct && (
          <div className="relative h-full flex-1 min-w-0 border-l border-wx-line">
            <Map
              ref={altMapRef}
              initialViewState={viewState}
              // Right pane is read-only — main map drives the camera via a
              // useEffect below. Disabling interactions prevents the user
              // from accidentally desyncing the view.
              dragPan={false}
              scrollZoom={false}
              dragRotate={false}
              doubleClickZoom={false}
              touchZoomRotate={false}
              boxZoom={false}
              keyboard={false}
              style={{ width: '100%', height: '100%' }}
              mapLib={mapboxgl as any}
              mapStyle={styleUrl}
              projection={{ name: 'mercator' } as any}
              mapboxAccessToken={token || undefined}
              attributionControl={false}
            >
              {altLiveRadarSource && (
                <Source key={altSourceKey} id="alt-radar-source" {...altLiveRadarSource}>
                  <Layer
                    id="alt-radar-layer"
                    type="raster"
                    paint={{
                      'raster-opacity': opacity / 100,
                      'raster-fade-duration': 200,
                      'raster-resampling': 'linear',
                    }}
                    {...tileAnchor}
                  />
                </Source>
              )}
            </Map>
            <div className="absolute top-2 left-2 z-10 px-2 py-1 rounded bg-wx-card/95 border border-wx-line text-[10px] uppercase tracking-wider font-bold text-wx-fg">
              {splitProduct === 'reflectivity' ? 'BREF' : splitProduct === 'velocity' ? 'SRV' : splitProduct}
              <span className="ml-1.5 font-mono font-normal text-wx-mute">· {selectedSite ?? ''}</span>
            </div>
          </div>
        )}
        </div>

        {/* Products rail (left). Narrower + tighter padding on phones so the
            draw toolbar to its right has room to breathe on a 375px viewport. */}
        {!uiHidden && (
          <div className="products-rail absolute top-3 left-3 md:top-4 md:left-4 w-[52px] md:w-[68px] bg-wx-card border border-wx-line rounded-xl p-1 md:p-1.5 flex flex-col gap-0.5 z-20">
            {(Object.keys(PRODUCTS) as ProductKey[])
              // 'rotation' (MRMS Az-Shear) retired — dead THREDDS source. Hidden
              // from the rail; use ProbSevere + Rotation IDs for rotation.
              .filter((k) => k !== 'rotation')
              .map((k) => {
              const p = PRODUCTS[k];
              const Icon = p.icon;
              const allowed = selectedSite ? p.modes.site : p.modes.composite;
              const disabled = !allowed;
              const active = effectiveProduct === k;
              // Thin divider before each product group: Reflectivity (CREF/BREF)
              // | Velocity (SRV) | Dual-pol (CC/ZDR/KDP) | Satellite (SAT).
              const startsGroup = k === 'velocity' || k === 'correlation' || k === 'satellite';
              return (
                <React.Fragment key={k}>
                  {startsGroup && <div className="h-px bg-wx-line/40 mx-1.5 my-1" />}
                <button
                  onClick={() => !disabled && selectProduct(k)}
                  disabled={disabled}
                  title={disabled ? (selectedSite ? 'Not available in single-site mode' : 'Pick a radar site to use this product') : p.label}
                  className={`relative flex flex-col items-center justify-center gap-0.5 py-2.5 md:py-2 rounded-lg text-[10px] font-semibold tracking-wide transition ${active ? 'bg-wx-ink border border-wx-line text-wx-fg' : 'text-wx-mute hover:text-wx-fg'} ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
                >
                  {active && tilesLoading && (
                    <span
                      className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-wx-accent animate-pulse"
                      title="Fetching tiles…"
                    />
                  )}
                  <Icon size={18} className={`md:hidden ${active ? 'text-wx-accent' : ''}`} />
                  <Icon size={20} className={`hidden md:block ${active ? 'text-wx-accent' : ''}`} />
                  <span className="text-[9px] md:text-[10px]">{p.short}</span>
                </button>
                </React.Fragment>
              );
            })}
          </div>
        )}

        {/* Draw toolbar. Desktop: inline labelled buttons. Mobile: the three
            primary tools collapse into a single Tools popover (+ a compact
            "N alerts" button) so the top of the map isn't a wall of chrome. */}
        {!uiHidden && (
          <div className="absolute top-3 left-[72px] md:top-4 md:left-[100px] flex gap-1.5 md:gap-2 items-center z-30">
            {/* Mobile: Tools menu trigger + popover */}
            <div className="md:hidden relative">
              <button
                onClick={() => setToolsMenuOpen((v) => !v)}
                className={`px-2.5 py-2.5 bg-wx-card border rounded-lg text-sm flex items-center gap-1 ${drawMode !== 'none' || nowcastOn ? 'border-wx-accent text-wx-accent' : 'border-wx-line text-wx-fg'}`}
                aria-label="Drawing tools"
                aria-expanded={toolsMenuOpen}
                title="Tools"
              >
                <PenTool size={16} />
                <ChevronDown size={12} className={`transition-transform ${toolsMenuOpen ? 'rotate-180' : ''}`} />
              </button>
              {toolsMenuOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setToolsMenuOpen(false)} />
                  <div className="absolute top-full left-0 mt-1.5 w-48 bg-wx-card border border-wx-line rounded-xl p-1 flex flex-col gap-0.5 shadow-xl z-20">
                    <button
                      onClick={() => { startPolygonDraw(); setToolsMenuOpen(false); }}
                      className={`flex items-center gap-2.5 px-2.5 py-2.5 rounded-lg text-sm text-left ${drawMode === 'polygon' ? 'bg-wx-accent text-black' : 'text-wx-fg hover:bg-wx-ink'}`}
                    >
                      <Target size={15} /> Draw polygon
                    </button>
                    <button
                      onClick={() => { startSnapMode(); setToolsMenuOpen(false); }}
                      className={`flex items-center gap-2.5 px-2.5 py-2.5 rounded-lg text-sm text-left ${drawMode === 'snap' ? 'bg-wx-accent text-black' : 'text-wx-fg hover:bg-wx-ink'}`}
                    >
                      <MousePointer2 size={15} /> Copy alert polygon
                    </button>
                    <button
                      onClick={() => { toggleNowcast(); setToolsMenuOpen(false); }}
                      aria-pressed={nowcastOn}
                      className={`flex items-center gap-2.5 px-2.5 py-2.5 rounded-lg text-sm text-left ${nowcastOn ? 'bg-rose-500 text-white' : 'text-wx-fg hover:bg-wx-ink'}`}
                    >
                      <Zap size={15} /> {nowcastOn ? 'Exit nowcast' : 'Nowcast mode'}
                    </button>
                  </div>
                </>
              )}
            </div>

            {/* Mobile: compact alerts button — opens the alerts sheet. */}
            {showNws && displayWarnings.length > 0 && (
              <button
                onClick={() => setAlertsSheetOpen(true)}
                className={`md:hidden px-2.5 py-2.5 bg-wx-card/95 backdrop-blur-sm border rounded-lg text-sm font-semibold flex items-center gap-1.5 ${
                  displayWarnings.some((w) => w.category === 'warning' && w.hazard === 'tornado')
                    ? 'border-red-500/60 text-red-300'
                    : displayWarnings.some((w) => w.category === 'warning' && w.hazard === 'severe')
                      ? 'border-orange-500/60 text-orange-300'
                      : displayWarnings.some((w) => w.category === 'warning')
                        ? 'border-emerald-500/60 text-emerald-300'
                        : 'border-wx-line text-wx-fg'
                }`}
                aria-label={`${displayWarnings.length} active alerts`}
                title="Active alerts"
              >
                <AlertTriangle size={15} />
                {displayWarnings.length}
              </button>
            )}

            {/* Desktop: inline labelled toolbar */}
            <div className="hidden md:flex gap-2 items-center">
              <button
                onClick={startPolygonDraw}
                className={`px-3 py-2 bg-wx-card border border-wx-line rounded-lg text-sm flex items-center gap-1.5 ${drawMode === 'polygon' ? 'bg-wx-accent text-black border-wx-accent' : ''}`}
                aria-label="Draw polygon"
                title="Draw polygon"
              >
                <Target size={14} /> Polygon
              </button>
              <button
                onClick={startSnapMode}
                className={`px-3 py-2 bg-wx-card border border-wx-line rounded-lg text-sm flex items-center gap-1.5 ${drawMode === 'snap' ? 'bg-wx-accent text-black border-wx-accent' : ''}`}
                aria-label="Copy alert polygon"
                title="Copy an active alert's polygon as your selection (click an alert on the map)"
              >
                <MousePointer2 size={14} /> Copy alert
              </button>
              <button
                onClick={toggleNowcast}
                className={`px-3 py-2 border rounded-lg text-sm flex items-center gap-1.5 ${nowcastOn ? 'bg-rose-500 text-white border-rose-400' : 'bg-wx-card border-wx-line'}`}
                aria-label="Nowcast mode"
                aria-pressed={nowcastOn}
                title={nowcastOn ? 'Exit nowcast mode (clear storm-scale overlays)' : 'Nowcast mode — warnings + ProbSevere + rotation + lightning + reports'}
              >
                <Zap size={14} /> Nowcast
              </button>
            </div>
            {drawMode === 'polygon' && (
              <button onClick={completePolygon} disabled={polygonPoints.length < 3} className="px-3 py-2.5 md:py-2 bg-wx-card border border-wx-line rounded-lg text-sm disabled:opacity-50">Complete ({polygonPoints.length})</button>
            )}
            {drawMode === 'polygon' && polygonPoints.length >= 3 && previewCount != null && (
              <span className="px-2 py-1 rounded bg-wx-ink border border-wx-line text-[11px] font-mono text-wx-fg" title="Subscribers inside the in-progress polygon (live)">
                ~{previewCount} in area
              </span>
            )}
            {(drawMode !== 'none' || selection) && (
              <button onClick={cancelDraw} className="px-3 py-2 bg-wx-card border border-wx-line rounded-lg text-sm text-wx-mute hover:text-wx-danger hover:border-wx-danger flex items-center gap-1.5">
                <Trash2 size={14} /> Clear
              </button>
            )}
            {drawMode === 'polygon' && polygonPoints.length === 0 && <div className="text-[11px]"><span className="px-1.5 py-0.5 text-[10px] border border-wx-line rounded bg-wx-ink">Click</span> add vertex</div>}
            {drawMode === 'snap' && <div className="text-[11px] text-wx-mute">Click any alert polygon</div>}
            {drawMode === 'pick-site' && <div className="text-[11px] text-wx-mute">Click the map to pick the nearest NEXRAD site</div>}
          </div>
        )}

        {!uiHidden && envWarnings && envWarnings.length > 0 && (
          <EnvPreflightBanner items={envWarnings} />
        )}

        {scrubTimeMs != null && (
          <div className={`absolute ${!uiHidden && envWarnings && envWarnings.length > 0 ? 'top-16' : 'top-4'} left-1/2 -translate-x-1/2 z-30 flex items-center gap-3 px-3 py-1.5 rounded-lg border border-amber-400 bg-amber-500/15 backdrop-blur-sm shadow-lg text-amber-200`}>
            <span className="text-[10px] font-bold tracking-wider uppercase">Replay</span>
            <span className="text-xs">
              Showing {new Date(scrubTimeMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
              {replayDiffMin != null ? <span className="text-amber-300/80"> · {replayDiffMin} min</span> : null}
              <span className="text-amber-200/70"> — alerts and reports filtered to this time</span>
            </span>
            <button
              type="button"
              onClick={() => {
                setPlaying(false);
                setFrame(Math.max(0, lwxrPastCount - 1));
              }}
              className="text-[11px] font-semibold px-2 py-0.5 rounded border border-amber-400 hover:bg-amber-500/20"
            >
              Back to live
            </button>
          </div>
        )}

        {/* Desktop alert chips. On mobile these collapse into the compact
            "N alerts" button (in the toolbar row) → alerts sheet. */}
        {!uiHidden && showNws && displayWarnings.length > 0 && (
          <div
            className="wx-scroll absolute md:top-[68px] md:left-[100px] md:right-[340px] z-20 hidden md:flex md:flex-nowrap items-center md:gap-2 md:overflow-x-auto md:whitespace-nowrap md:max-h-none"
          >
            {displayWarnings.slice(0, 12).map((w) => (
              <button
                key={w.id}
                onClick={() => {
                  setSelectedWarning(w);
                  focusWarning(w);
                }}
                className={`inline-flex shrink-0 max-w-full items-center gap-1 md:gap-1.5 px-2 py-1 md:px-3 md:py-1.5 rounded-lg border bg-wx-card/95 backdrop-blur-sm text-xs md:text-sm font-medium ${
                  selectedWarning?.id === w.id ? 'border-wx-accent bg-wx-accent/10' : ''
                } ${
                  w.category === 'warning' && w.hazard === 'tornado'
                    ? 'border-red-500/50 text-red-300'
                    : w.category === 'warning' && w.hazard === 'severe'
                      ? 'border-orange-500/50 text-orange-300'
                      : w.category === 'warning' && w.hazard === 'flood'
                        ? 'border-emerald-500/50 text-emerald-300'
                        : w.category === 'watch'
                          ? 'border-yellow-500/50 text-yellow-200'
                          : w.category === 'advisory'
                            ? 'border-violet-500/50 text-violet-200'
                            : w.category === 'discussion' && w.severity === 'Extreme'
                              ? 'border-red-500/50 text-red-300'
                              : w.category === 'discussion' && w.severity === 'Severe'
                                ? 'border-orange-500/50 text-orange-300'
                                : w.category === 'discussion' && w.severity === 'Minor'
                                  ? 'border-sky-500/50 text-sky-300'
                                  : w.category === 'discussion'
                                    ? 'border-fuchsia-500/50 text-fuchsia-200'
                                    : 'border-slate-500/50 text-slate-300'
                }`}
              >
                <span className="text-[9px] font-bold opacity-80">{categoryBadge(w.category)}</span>
                {/* Mobile shows just the event name so two-or-three chips fit per
                    row instead of one chip overflowing — the area_desc + count
                    suffix (e.g. "· Colbert +5") still appears in the inspector
                    card once a chip is tapped. */}
                <span className="md:hidden truncate">{w.event}</span>
                <span className="hidden md:inline">{w.label}</span>
              </button>
            ))}
          </div>
        )}

        {/* Mobile alerts sheet — the list behind the compact "N alerts" button.
            Same tap target as a desktop chip: selects + flies to the warning. */}
        {!uiHidden && alertsSheetOpen && showNws && displayWarnings.length > 0 && (
          <div className="md:hidden absolute inset-0 z-40">
            <div
              className="absolute inset-0 bg-black/40 backdrop-blur-[1px]"
              onClick={() => setAlertsSheetOpen(false)}
            />
            <div className="absolute bottom-0 left-0 right-0 max-h-[70vh] rounded-t-2xl border-t border-x border-wx-line bg-wx-card overflow-y-auto p-4 pt-7 flex flex-col gap-2 wx-scroll">
              <button
                onClick={() => setAlertsSheetOpen(false)}
                className="absolute top-1.5 right-1.5 w-7 h-7 inline-flex items-center justify-center rounded-md text-wx-mute hover:text-wx-fg hover:bg-wx-ink"
                aria-label="Close alerts"
              >
                <X size={15} />
              </button>
              <div className="text-[11px] uppercase tracking-[0.06em] text-wx-mute font-semibold">
                {displayWarnings.length} active alert{displayWarnings.length === 1 ? '' : 's'}
              </div>
              {displayWarnings.map((w) => (
                <button
                  key={w.id}
                  onClick={() => { setSelectedWarning(w); focusWarning(w); setAlertsSheetOpen(false); }}
                  className={`flex items-center gap-2 px-3 py-2.5 rounded-lg border bg-wx-ink/60 text-left text-sm font-medium ${
                    selectedWarning?.id === w.id ? 'border-wx-accent bg-wx-accent/10' : ''
                  } ${
                    w.category === 'warning' && w.hazard === 'tornado'
                      ? 'border-red-500/50 text-red-300'
                      : w.category === 'warning' && w.hazard === 'severe'
                        ? 'border-orange-500/50 text-orange-300'
                        : w.category === 'warning' && w.hazard === 'flood'
                          ? 'border-emerald-500/50 text-emerald-300'
                          : w.category === 'watch'
                            ? 'border-yellow-500/50 text-yellow-200'
                            : w.category === 'advisory'
                              ? 'border-violet-500/50 text-violet-200'
                              : 'border-slate-500/50 text-slate-300'
                  }`}
                >
                  <span className="text-[9px] font-bold opacity-80 shrink-0">{categoryBadge(w.category)}</span>
                  <span className="truncate">{w.label}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Inspector — collapsed.
            Desktop: thin vertical rail flush right (legacy behaviour).
            Mobile: a tap-friendly pill in the bottom-right corner labelled
            "Layers" so the affordance is obvious; the rail's icon-only style
            is too cryptic at finger-tip sizes. */}
        {!uiHidden && !selection && inspectorCollapsed && (
          <>
            <button
              type="button"
              onClick={() => setInspectorCollapsed(false)}
              className="hidden md:flex absolute top-4 right-4 w-9 h-[120px] bg-wx-card border border-wx-line rounded-xl z-20 flex-col items-center justify-between py-2 hover:border-wx-accent group"
              aria-label="Expand inspector"
              title="Expand inspector"
            >
              <ChevronLeft size={14} className="text-wx-mute group-hover:text-wx-fg" />
              <div
                className={`flex-1 w-2 my-1 rounded-sm ${effectiveProduct === 'velocity' ? 'bg-[linear-gradient(180deg,#16a34a_0%,#22d3ee_25%,#e5e7eb_50%,#fb7185_75%,#b91c1c_100%)]' : effectiveProduct === 'rotation' ? 'bg-[linear-gradient(180deg,#1e1b4b_0%,#6d28d9_40%,#d946ef_70%,#fde047_100%)]' : effectiveProduct === 'correlation' ? 'bg-[linear-gradient(180deg,#1f2937_0%,#4b5563_30%,#6b7280_60%,#fbbf24_85%,#ef4444_100%)]' : effectiveProduct === 'zdr' ? 'bg-[linear-gradient(180deg,#5b21b6_0%,#6b7280_25%,#9ca3af_33%,#22d3ee_42%,#10b981_50%,#84cc16_58%,#facc15_67%,#f97316_75%,#ef4444_83%,#fbcfe8_100%)]' : effectiveProduct === 'kdp' ? 'bg-[linear-gradient(180deg,#4b5563_0%,#1f2937_17%,#0ea5e9_25%,#10b981_33%,#84cc16_50%,#facc15_67%,#f97316_83%,#ec4899_100%)]' : effectiveProduct === 'satellite' ? 'bg-[linear-gradient(180deg,#0f172a_0%,#475569_35%,#cbd5e1_70%,#f8fafc_100%)]' : 'bg-[linear-gradient(180deg,#3b82f6_0%,#22d3ee_15%,#10b981_30%,#84cc16_45%,#facc15_60%,#f97316_75%,#ef4444_88%,#d946ef_100%)]'}`}
              />
              <span className="font-mono text-[9px] text-wx-mute">{PRODUCTS[effectiveProduct].short}</span>
            </button>
            <button
              type="button"
              onClick={() => setInspectorCollapsed(false)}
              className="md:hidden absolute bottom-[68px] right-3 z-20 inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-wx-card/95 border border-wx-line text-xs font-semibold text-wx-fg shadow-lg backdrop-blur-sm"
              aria-label="Open layers panel"
            >
              <ChevronLeft size={14} className="text-wx-mute" />
              Layers · {PRODUCTS[effectiveProduct].short}
            </button>
          </>
        )}

        {/* Inspector — expanded.
            Desktop: 304px right rail.
            Mobile: full-width bottom sheet pinned to viewport bottom, capped
            at 75vh with internal scroll so the operator can still see the
            map context above. Backdrop dim makes it read as a modal layer
            so the tap-to-close X is obvious. */}
        {!uiHidden && !selection && !inspectorCollapsed && (
          <RadarInspector
            setInspectorCollapsed={setInspectorCollapsed}
            inspectorTab={inspectorTab}
            setInspectorTab={setInspectorTab}
            mapRef={mapRef}
            effectiveProduct={effectiveProduct}
            satSource={satSource}
            setSatSource={setSatSource}
            lwxrSubject={lwxrSubject}
            useLibreWxR={useLibreWxR}
            useLevel2={useLevel2}
            useL2Png={useL2Png}
            isComposite={isComposite}
            availableSweeps={availableSweeps}
            resolvedSweepIndex={resolvedSweepIndex}
            level2Loading={level2Loading}
            level2Error={level2Error}
            level2Attempt={level2Attempt}
            level2MaxAttempts={level2MaxAttempts}
            level2Overlay={level2Overlay}
            threatBoard={threatBoard}
            setProbSeverePopup={setProbSeverePopup}
            showArrows={showArrows}
            setShowArrows={setShowArrows}
            colorScheme={colorScheme}
            setColorScheme={setColorScheme}
            opacity={opacity}
            setOpacity={setOpacity}
            selectedSite={selectedSite}
            setSelectedSite={setSelectedSite}
            siteQuery={siteQuery}
            setSiteQuery={setSiteQuery}
            viewState={viewState}
            settledView={settledView}
            drawMode={drawMode}
            setDrawMode={setDrawMode}
            recentSiteCodes={recentSiteCodes}
            pickerSites={pickerSites}
            pickerCenter={pickerCenter}
            splitProduct={splitProduct}
            setSplitProduct={setSplitProduct}
            hiRes={hiRes}
            setHiRes={setHiRes}
            pngFallback={pngFallback}
            setPngFallback={setPngFallback}
            selectedElevation={selectedElevation}
            setSelectedElevation={setSelectedElevation}
            subsCount={subsCount}
            showSubs={showSubs}
            setShowSubs={setShowSubs}
            showCoverage={showCoverage}
            setShowCoverage={setShowCoverage}
            warnings={warnings}
            warningsLoading={warningsLoading}
            displayWarnings={displayWarnings}
            scrubTimeMs={scrubTimeMs}
            showNws={showNws}
            setShowNws={setShowNws}
            catWarnings={catWarnings}
            setCatWarnings={setCatWarnings}
            catWatches={catWatches}
            setCatWatches={setCatWatches}
            catAdvisories={catAdvisories}
            setCatAdvisories={setCatAdvisories}
            catDiscussions={catDiscussions}
            setCatDiscussions={setCatDiscussions}
            stormTrackCount={stormTrackCount}
            showStormTracks={showStormTracks}
            setShowStormTracks={setShowStormTracks}
            displayLsrGeo={displayLsrGeo}
            showLsr={showLsr}
            setShowLsr={setShowLsr}
            displayStormReportsGeo={displayStormReportsGeo}
            showStormReports={showStormReports}
            setShowStormReports={setShowStormReports}
            lightningGeo={lightningGeo}
            showLightning={showLightning}
            setShowLightning={setShowLightning}
            coupletGeo={coupletGeo}
            coupletsSwr={coupletsSwr}
            showCouplets={showCouplets}
            setShowCouplets={setShowCouplets}
            probSevereDrawn={probSevereDrawn}
            probSevereSwr={probSevereSwr}
            showProbSevere={showProbSevere}
            setShowProbSevere={setShowProbSevere}
            probSevereTop={probSevereTop}
            probSevereTrend={probSevereTrend}
            mpingGeo={mpingGeo}
            mpingSwr={mpingSwr}
            showMping={showMping}
            setShowMping={setShowMping}
            metarGeo={metarGeo}
            metarSwr={metarSwr}
            showMetar={showMetar}
            setShowMetar={setShowMetar}
            showZones={showZones}
            setShowZones={setShowZones}
            mapPillSites={mapPillSites}
            showSitePills={showSitePills}
            setShowSitePills={setShowSitePills}
            capWarningsGeo={capWarningsGeo}
            showCap={showCap}
            setShowCap={setShowCap}
            spcDay={spcDay}
            setSpcDay={setSpcDay}
            spcDays={spcDays}
            activeSpc={activeSpc}
            showSpc={showSpc}
            setShowSpc={setShowSpc}
            selectedWarning={selectedWarning}
            setSelectedWarning={setSelectedWarning}
            composeUrlForWarning={composeUrlForWarning}
            composeUrlForWarningTrack={composeUrlForWarningTrack}
            openWarningSounding={openWarningSounding}
            focusWarning={focusWarning}
            modelOverlay={modelOverlay}
            setModelOverlay={setModelOverlay}
            activeModel={activeModel}
            modelHour={modelHour}
            setModelHour={setModelHour}
            modelOpacity={modelOpacity}
            setModelOpacity={setModelOpacity}
            hoverPixel={hoverPixel}
            sampleLabel={sampleLabel}
          />
        )}

        {selection && (
          <div className="absolute bottom-2 left-2 right-2 md:bottom-4 md:left-4 md:right-auto md:w-[320px] p-4 md:p-5 bg-wx-card border border-wx-line rounded-xl z-30">
            <div className="flex items-start justify-between">
              <div>
                <div className="text-[11px] uppercase tracking-[0.06em] text-wx-mute font-semibold">Audience in area</div>
                <div className="text-[30px] font-extrabold leading-none mt-1">{previewCount ?? '—'}</div>
              </div>
              <button onClick={cancelDraw} className="w-8 h-8 inline-flex items-center justify-center"><Trash2 size={14} /></button>
            </div>
            <div className="text-[11.5px] text-wx-mute mt-1 font-mono">
              {selection.type === 'circle' ? <>Circle · {selection.radius_km.toFixed(1)} km · {selection.center[1].toFixed(3)}, {selection.center[0].toFixed(3)}</> : <>Polygon · {selection.coordinates.length - 1} vertices</>}
            </div>

            <div className="grid grid-cols-4 gap-2 mt-3.5 pt-3.5 border-t border-wx-line">
              <div className="bg-wx-ink border border-wx-line rounded-lg p-2.5"><div className="text-base font-bold">{audienceBreakdown.tn}</div><div className="text-[10px] uppercase tracking-wide text-wx-mute mt-0.5">TN</div></div>
              <div className="bg-wx-ink border border-wx-line rounded-lg p-2.5"><div className="text-base font-bold">{audienceBreakdown.ms}</div><div className="text-[10px] uppercase tracking-wide text-wx-mute mt-0.5">MS</div></div>
              <div className="bg-wx-ink border border-wx-line rounded-lg p-2.5"><div className="text-base font-bold">{audienceBreakdown.ar}</div><div className="text-[10px] uppercase tracking-wide text-wx-mute mt-0.5">AR</div></div>
              <div className="bg-wx-ink border border-wx-line rounded-lg p-2.5"><div className="text-base font-bold">{audienceBreakdown.other}</div><div className="text-[10px] uppercase tracking-wide text-wx-mute mt-0.5">Other</div></div>
            </div>

            <button onClick={() => setQuickComposeOpen(true)} className="mt-3.5 w-full bg-wx-accent text-black rounded-lg font-semibold text-sm py-2 flex items-center justify-center gap-2 hover:bg-amber-300">
              <Send size={14} /> Send alert to area
            </button>
            <div className="mt-2 flex gap-2">
              <button
                onClick={goToCompose}
                className="flex-1 bg-wx-ink border border-wx-line text-wx-mute rounded-lg text-xs font-semibold py-1.5 hover:border-wx-accent hover:text-wx-fg"
                title="Templates, media, check-ins — opens in a new tab"
              >
                Full compose ↗
              </button>
              {selection.type === 'polygon' && (
                <button
                  onClick={goToForecast}
                  className="flex-1 bg-wx-ink border border-wx-line text-wx-mute rounded-lg text-xs font-semibold py-1.5 hover:border-wx-accent hover:text-wx-fg"
                >
                  Forecast this area
                </button>
              )}
            </div>
          </div>
        )}

        {quickComposeOpen && quickComposeSpec ? (
          <QuickComposePanel
            spec={quickComposeSpec}
            count={previewCount ?? audienceBreakdown.total}
            onClose={() => setQuickComposeOpen(false)}
          />
        ) : null}

        {!uiHidden && <RecentSends />}

        {/* Hide-all-UI toggle (always visible so we can get out of hidden mode).
            Desktop sits bottom-right; mobile moves to top-right so it doesn't
            clash with the Layers pill / timeline at the bottom edge. */}
        <button
          type="button"
          onClick={() => setUiHidden((v) => !v)}
          className="absolute top-3 right-3 md:top-auto md:bottom-4 md:right-4 z-30 w-9 h-9 inline-flex items-center justify-center rounded-lg bg-wx-card border border-wx-line text-wx-mute hover:text-wx-fg hover:border-wx-accent"
          aria-label={uiHidden ? 'Show UI (H)' : 'Hide UI (H)'}
          title={uiHidden ? 'Show UI (H)' : 'Hide UI (H)'}
          aria-pressed={uiHidden}
        >
          {uiHidden ? <Eye size={16} /> : <EyeOff size={16} />}
        </button>

        {/* Timeline — drag to scrub, space to play, arrows to step. */}
        {useLibreWxR && totalFrames > 1 && (() => {
          const nowIdx = Math.max(0, lwxrPastCount - 1);
          const nowPct = (nowIdx / Math.max(1, totalFrames - 1)) * 100;
          const headPct = (frame / Math.max(1, totalFrames - 1)) * 100;
          const hoverFrameTime =
            hoverFrame != null && lwxrAllFrames[hoverFrame] ? lwxrAllFrames[hoverFrame].time : null;
          const nowSec = Math.floor(Date.now() / 1000);
          // Hour-grid labels. Radar covers ~2h past + ~1h nowcast at 10 min
          // intervals — show fine-grained marks around NOW. Satellite covers
          // 12h hourly with no forecast — use wider hourly marks.
          const labelMinutes: { mins: number; label: string }[] =
            lwxrSubject === 'satellite'
              ? [
                  { mins: -720, label: '−12h' },
                  { mins: -540, label: '−9h' },
                  { mins: -360, label: '−6h' },
                  { mins: -180, label: '−3h' },
                  { mins: 0, label: 'NOW' },
                ]
              : [
                  { mins: -120, label: '−2h' },
                  { mins: -60, label: '−1h' },
                  { mins: -30, label: '−30m' },
                  { mins: 0, label: 'NOW' },
                  { mins: 30, label: '+30m' },
                ];
          const snapTolSec = lwxrSubject === 'satellite' ? 40 * 60 : 20 * 60;
          const labels = labelMinutes
            .map(({ mins, label }) => {
              const target = nowSec + mins * 60;
              const idx = lwxrAllFrames.reduce(
                (best, f, i) => Math.abs(f.time - target) < Math.abs(lwxrAllFrames[best].time - target) ? i : best,
                0,
              );
              const diff = Math.abs(lwxrAllFrames[idx].time - target);
              if (diff > snapTolSec) return null;
              return { idx, label };
            })
            .filter((x): x is { idx: number; label: string } => x != null);

          return (
            <div className="absolute bottom-2 md:bottom-4 left-2 right-2 md:left-1/2 md:right-auto md:-translate-x-1/2 md:w-[min(880px,calc(100%-380px))] md:min-w-[520px] z-30">
              <div className="bg-wx-card border border-wx-line rounded-xl px-2.5 md:px-4 py-1.5 md:py-3.5 flex items-center gap-2 md:gap-3.5">
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => { setPlaying(false); setFrame((f) => Math.max(0, f - 1)); }}
                    className="hidden md:grid w-7 h-9 place-items-center text-wx-mute hover:text-wx-fg"
                    title="Previous frame (←)"
                    aria-label="Previous frame"
                  >‹</button>
                  <button
                    onClick={() => setPlaying((p) => !p)}
                    className="w-8 h-8 md:w-9 md:h-9 rounded-lg bg-wx-accent text-black grid place-items-center hover:bg-amber-300"
                    title={playing ? 'Pause (space)' : 'Play (space)'}
                  >
                    {playing ? <Pause size={14} /> : <Play size={14} />}
                  </button>
                  <button
                    onClick={() => { setPlaying(false); setFrame((f) => Math.min(totalFrames - 1, f + 1)); }}
                    className="hidden md:grid w-7 h-9 place-items-center text-wx-mute hover:text-wx-fg"
                    title="Next frame (→)"
                    aria-label="Next frame"
                  >›</button>
                  <button
                    onClick={() => { setPlaying(false); setFrame(Math.max(0, lwxrPastCount - 1)); }}
                    disabled={frame === nowIdx}
                    className={`ml-0.5 md:ml-1 px-1.5 md:px-2 h-8 md:h-9 rounded-md text-[10px] font-bold tracking-wider border transition disabled:opacity-40 disabled:cursor-default ${frame === nowIdx ? 'border-wx-line text-wx-mute' : 'border-wx-accent text-wx-accent hover:bg-wx-accent/10'}`}
                    title="Jump to live frame (N)"
                    aria-label="Jump to NOW"
                  >NOW</button>
                </div>

                <div className="flex-1 flex flex-col gap-1 md:gap-1.5">
                  <div
                    ref={trackRef}
                    className="relative h-6 md:h-7 cursor-pointer select-none"
                    onMouseDown={(e) => {
                      draggingRef.current = true;
                      setPlaying(false);
                      const f = scrubAtClientX(e.clientX);
                      if (f != null) setFrame(f);
                    }}
                    onMouseMove={(e) => {
                      const f = scrubAtClientX(e.clientX);
                      if (f != null) setHoverFrame(f);
                    }}
                    onMouseLeave={() => setHoverFrame(null)}
                  >
                    {/* Past + nowcast bands */}
                    <div className="absolute left-0 right-0 top-1/2 h-1.5 bg-wx-line rounded-sm overflow-hidden -translate-y-1/2">
                      <div className="absolute left-0 top-0 bottom-0 bg-wx-ok/70" style={{ width: `${nowPct}%` }} />
                      {lwxrAllFrames.length > lwxrPastCount && (
                        <div
                          className="absolute right-0 top-0 bottom-0 bg-[repeating-linear-gradient(45deg,rgba(251,191,36,0.10)_0_5px,rgba(251,191,36,0.28)_5px_10px)] border-l border-amber-500/60"
                          style={{ width: `${100 - nowPct}%` }}
                        />
                      )}
                    </div>

                    {/* Frame ticks */}
                    <div className="absolute left-0 right-0 top-1/2 -translate-y-1/2 flex justify-between px-0.5 pointer-events-none">
                      {lwxrAllFrames.map((_, i) => (
                        <div
                          key={i}
                          className={`w-[1.5px] rounded ${
                            i === nowIdx ? 'h-4 bg-wx-accent' :
                            i === 0 || i === totalFrames - 1 ? 'h-3 bg-wx-mute/70' :
                            'h-[7px] bg-wx-mute/50'
                          }`}
                        />
                      ))}
                    </div>

                    {/* Hover ghost head */}
                    {hoverFrame != null && hoverFrame !== frame && (
                      <div
                        className="absolute top-1/2 w-[10px] h-[10px] rounded-full bg-wx-mute/60 -translate-x-1/2 -translate-y-1/2 pointer-events-none"
                        style={{ left: `${(hoverFrame / Math.max(1, totalFrames - 1)) * 100}%` }}
                      />
                    )}

                    {/* Active head */}
                    <div
                      className="absolute top-1/2 w-[14px] h-[14px] rounded-full bg-wx-accent border-2 border-wx-ink -translate-x-1/2 -translate-y-1/2 pointer-events-none shadow"
                      style={{ left: `${headPct}%` }}
                    />

                    {/* Hover timestamp tooltip */}
                    {hoverFrame != null && hoverFrameTime != null && (
                      <div
                        className="absolute -top-7 px-1.5 py-0.5 rounded bg-wx-ink border border-wx-line text-[10px] font-mono whitespace-nowrap pointer-events-none -translate-x-1/2"
                        style={{ left: `${(hoverFrame / Math.max(1, totalFrames - 1)) * 100}%` }}
                      >
                        {new Date(hoverFrameTime * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                      </div>
                    )}
                  </div>

                  {/* Time-axis labels under the track — desktop only; on
                      mobile they crowd the slim timeline pill. */}
                  <div className="relative h-3 select-none pointer-events-none hidden md:block">
                    {labels.map(({ idx, label }) => (
                      <span
                        key={label}
                        className={`absolute -translate-x-1/2 text-[9.5px] font-mono ${label === 'NOW' ? 'text-wx-accent font-semibold' : 'text-wx-mute'}`}
                        style={{ left: `${(idx / Math.max(1, totalFrames - 1)) * 100}%` }}
                      >
                        {label}
                      </span>
                    ))}
                  </div>
                </div>

                <div className="flex flex-col items-end gap-0.5 md:min-w-[96px]">
                  <span className={`hidden md:inline-flex text-[10px] px-1.5 py-0.5 rounded border font-semibold tracking-wider uppercase ${
                    replayDiffMin != null
                      ? 'border-amber-400 text-amber-300'
                      : isForecastFrame
                        ? 'border-wx-accent text-wx-accent'
                        : 'border-wx-line text-wx-fg'
                  }`}>
                    {replayDiffMin != null
                      ? `REPLAY · ${replayDiffMin} min`
                      : isForecastFrame
                        ? 'NOWCAST'
                        : 'OBSERVED'}
                  </span>
                  <span className="text-[12px] md:text-[15px] font-bold tabular-nums">{frameTimeLabel}</span>
                  <span className="hidden md:inline text-[11px] text-wx-mute tabular-nums">{relLabel}</span>
                </div>

                {(() => {
                  const order: ('0.5x' | '1x' | '2x' | '4x')[] = ['0.5x', '1x', '2x', '4x'];
                  const nextSpeed = order[(order.indexOf(speed) + 1) % order.length];
                  return (
                    <button
                      onClick={() => setSpeed(nextSpeed)}
                      className="hidden md:flex text-[11px] px-2.5 py-1.5 border border-wx-line rounded-md hover:border-wx-accent font-mono tabular-nums items-center gap-1"
                      title={`Click for ${nextSpeed} (cycles 0.5× / 1× / 2× / 4×)`}
                    >
                      <span className="text-wx-fg font-semibold">{speed.replace('x', '×')}</span>
                      <span className="text-wx-mute text-[9.5px]">→ {nextSpeed.replace('x', '×')}</span>
                    </button>
                  );
                })()}
              </div>
              <div className="hidden md:block text-[10px] text-wx-mute text-center mt-1.5 font-mono">
                Space play/pause · ← → step · Home/End · N to jump to NOW
              </div>
            </div>
          );
        })()}

        {!useLibreWxR && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-30">
            <div className="bg-wx-card border border-wx-line rounded-xl px-4 py-2 text-[11px] text-wx-mute">
              Live frame · {frameTimeLabel}
            </div>
          </div>
        )}

        {hoverPixel && (
          // Hover-only readout. Hidden on touch devices because a tap fires
          // mousemove → the chip flashes briefly then never clears since
          // there's no mouseleave on a finger lift.
          <div className="hidden md:block absolute bottom-4 right-4 font-mono text-[11px] bg-wx-card border border-wx-line rounded-md px-2.5 py-1.5 z-20 [@media(hover:none)]:hidden">
            <span className="text-wx-mute">lat</span> {hoverPixel.lat.toFixed(3)} <span className="text-wx-mute">lon</span> {hoverPixel.lng.toFixed(3)} <span className="text-wx-mute">· </span>{sampleLabel}
          </div>
        )}


        {/* Click-selected entity cards — all five share the lower-right slot;
            the click dispatch above guarantees at most one opens per click. */}
        {selectedLsr && <LsrCard lsr={selectedLsr} onClose={() => setSelectedLsr(null)} />}
        {selectedStormReport && (
          <StormReportCard
            report={selectedStormReport}
            onClose={() => setSelectedStormReport(null)}
            onActed={() => {
              setSelectedStormReport(null);
              swrMutate(STORM_REPORTS_KEY);
              swrMutate(STORM_REPORT_CLUSTERS_KEY);
            }}
          />
        )}
        {selectedMping && <MpingCard report={selectedMping} onClose={() => setSelectedMping(null)} />}
        {selectedMetar && <MetarCard metar={selectedMetar} onClose={() => setSelectedMetar(null)} />}
        {selectedCouplet && <CoupletCard couplet={selectedCouplet} onClose={() => setSelectedCouplet(null)} />}

        {/* NEXRAD site pills — one per radar location in the current view.
            Stays below the products rail / draw toolbar / inspector (z-20) so
            pills never sit on top of chrome controls. */}
        {mapPillSites.length > 0 && (
          <div className="absolute inset-0 pointer-events-none z-[15]">
            {mapPillSites.map((site) => {
              const isActive = selectedSite === site.code;
              const p = screenPoint(site.center);
              if (!p) return null;
              return (
                <div
                  key={site.code}
                  className="absolute pointer-events-auto"
                  style={{ left: p.x, top: p.y, transform: 'translate(-50%, -50%)' }}
                >
                  {isActive && (
                    <div
                      className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[230px] h-[230px] rounded-full border border-dashed border-white/10 pointer-events-none"
                      style={{ background: 'radial-gradient(circle, rgba(251,191,36,0.06) 0%, transparent 70%)' }}
                    />
                  )}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedSite(site.code);
                      mapRef.current?.flyTo({ center: site.center, zoom: site.zoom, duration: 700 });
                    }}
                    title={`${site.code} · ${site.name}, ${site.state}`}
                    className={`relative inline-flex items-center whitespace-nowrap rounded-full font-mono font-semibold border backdrop-blur-sm transition ${
                      isActive
                        ? 'bg-wx-accent text-black border-wx-accent scale-105 px-2.5 py-1 text-[11px] shadow-lg'
                        : 'bg-wx-card border-wx-line text-wx-mute hover:text-wx-fg hover:border-wx-accent px-2 py-0.5 text-[10px]'
                    }`}
                  >
                    {sitePillLabel(site, viewState.zoom)}
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {hoverSub && (
          <div
            className="hidden md:block absolute z-50 bg-wx-card border border-wx-line rounded-lg px-2.5 py-2 text-[11px] pointer-events-none shadow-lg max-w-[240px] [@media(hover:none)]:hidden"
            style={{ left: hoverPos.x + 12, top: hoverPos.y - 20 }}
          >
            <div className="font-semibold text-wx-fg">{hoverSub.name || 'Subscriber'}</div>
            <div className="text-[10px] text-wx-mute">
              {hoverSub.zip ? `ZIP ${hoverSub.zip}` : ''}
              {hoverSub.telegram_username ? ` · @${hoverSub.telegram_username}` : ''}
            </div>
            {hoverSub.current_address && (
              <div className="text-[10px] text-wx-accent mt-0.5">
                📍 At: {hoverSub.current_address}
              </div>
            )}
            {!hoverSub.current_address && hoverSub.home_address && (
              <div className="text-[10px] text-wx-mute mt-0.5 truncate">
                Home: {hoverSub.home_address}
              </div>
            )}
            <div className="font-mono text-[10px] text-wx-mute mt-1">
              {hoverPixel?.lat.toFixed(3)}, {hoverPixel?.lng.toFixed(3)}
            </div>
            <div className="text-[9.5px] text-wx-mute mt-1">Click to open profile</div>
          </div>
        )}
      </div>
    </div>
  );
}
