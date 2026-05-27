'use client';

import useSWR, { type SWRConfiguration } from 'swr';
import type { NwsRadarAlert } from '@/lib/nws/radar';

const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

const jsonFetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch_${res.status}`);
  return res.json();
};

const BASE_OPTS: SWRConfiguration = {
  revalidateOnFocus: false,
  revalidateOnReconnect: true,
  dedupingInterval: 5_000,
  shouldRetryOnError: true,
  errorRetryInterval: 10_000,
  errorRetryCount: 3,
};

export type WarningsResponse = {
  warnings: NwsRadarAlert[];
  geojson: GeoJSON.FeatureCollection;
  tracks: GeoJSON.FeatureCollection;
};
const EMPTY_WARNINGS: WarningsResponse = {
  warnings: [],
  geojson: EMPTY_FC,
  tracks: EMPTY_FC,
};
export const WARNINGS_KEY = '/api/radar/warnings';
export function useWarnings(initial?: WarningsResponse) {
  return useSWR<WarningsResponse>(WARNINGS_KEY, jsonFetcher, {
    ...BASE_OPTS,
    refreshInterval: 90_000,
    fallbackData: initial ?? EMPTY_WARNINGS,
  });
}

export type CapWarningsResponse = { geojson: GeoJSON.FeatureCollection };
const EMPTY_CAP: CapWarningsResponse = { geojson: EMPTY_FC };
export const CAP_WARNINGS_KEY = '/api/radar/cap-warnings';
export function useCapWarnings(enabled: boolean) {
  return useSWR<CapWarningsResponse>(
    enabled ? CAP_WARNINGS_KEY : null,
    jsonFetcher,
    {
      ...BASE_OPTS,
      refreshInterval: 90_000,
      fallbackData: EMPTY_CAP,
    },
  );
}

export type LsrResponse = { geojson: GeoJSON.FeatureCollection; hours: number };
const EMPTY_LSR: LsrResponse = { geojson: EMPTY_FC, hours: 6 };
export const LSR_KEY = '/api/radar/lsr';
export function useLsr() {
  return useSWR<LsrResponse>(LSR_KEY, jsonFetcher, {
    ...BASE_OPTS,
    refreshInterval: 120_000,
    fallbackData: EMPTY_LSR,
  });
}

export type StormReportsResponse = { geojson: GeoJSON.FeatureCollection; hours: number };
const EMPTY_STORM_REPORTS: StormReportsResponse = { geojson: EMPTY_FC, hours: 24 };
export const STORM_REPORTS_KEY = '/api/radar/storm-reports';
export function useStormReports() {
  return useSWR<StormReportsResponse>(STORM_REPORTS_KEY, jsonFetcher, {
    ...BASE_OPTS,
    refreshInterval: 60_000,
    fallbackData: EMPTY_STORM_REPORTS,
  });
}

export type SpcDay = {
  day_number: number;
  geojson: GeoJSON.FeatureCollection;
  issued_at: string | null;
  valid_from: string | null;
  valid_until: string | null;
  highest_label: string | null;
};
export type SpcResponse = { days: SpcDay[] };
export const SPC_KEY = '/api/radar/spc';
export function useSpc(initialDays?: SpcDay[]) {
  return useSWR<SpcResponse>(SPC_KEY, jsonFetcher, {
    ...BASE_OPTS,
    refreshInterval: 900_000,
    fallbackData: { days: initialDays ?? [] },
  });
}

export const SUBS_KEY = '/api/radar/subs';
export function useSubs(initialGeo?: GeoJSON.FeatureCollection) {
  // No refresh interval: subscribers move rarely. Components can call mutate
  // manually if needed.
  return useSWR<GeoJSON.FeatureCollection>(SUBS_KEY, jsonFetcher, {
    ...BASE_OPTS,
    refreshInterval: 0,
    fallbackData: initialGeo ?? EMPTY_FC,
  });
}

export type CoupletProps = {
  track_id: string;
  site: string;
  shear_kt: number;
  max_shear_kt: number;
  range_km: number;
  azimuth_deg: number;
  elevation_deg: number;
  volume_filename: string;
  volume_time_utc: string;
  first_seen_at: string;
  last_seen_at: string;
  volume_count: number;
};
export type CoupletTrailProps = {
  track_id: string;
  site: string;
  volume_count: number;
  max_shear_kt: number;
};
export type CoupletsResponse = {
  geojson: GeoJSON.FeatureCollection<GeoJSON.Point, CoupletProps>;
  tracks: GeoJSON.FeatureCollection<GeoJSON.LineString, CoupletTrailProps>;
  minutes: number;
};
const EMPTY_COUPLETS: CoupletsResponse = {
  geojson: { type: 'FeatureCollection', features: [] },
  tracks: { type: 'FeatureCollection', features: [] },
  minutes: 30,
};
export const COUPLETS_KEY = '/api/radar/couplets';
export function useCouplets(enabled: boolean) {
  return useSWR<CoupletsResponse>(
    enabled ? COUPLETS_KEY : null,
    jsonFetcher,
    {
      ...BASE_OPTS,
      // Couplet-poll edge function fires every 60 s; 30 s client refresh
      // keeps the display within a single poll cycle of fresh.
      refreshInterval: 30_000,
      fallbackData: EMPTY_COUPLETS,
    },
  );
}

export type LightningFlash = GeoJSON.Feature<GeoJSON.Point, { id: number; t: number; e: number }>;
export type LightningResponse = {
  type: 'FeatureCollection';
  features: LightningFlash[];
  as_of_ms?: number;
};
const EMPTY_LIGHTNING: LightningResponse = { type: 'FeatureCollection', features: [] };
export const LIGHTNING_KEY_BASE = '/api/radar/lightning';
export function useLightning(
  enabled: boolean,
  bbox: readonly [number, number, number, number] | null,
) {
  const key = enabled && bbox ? `${LIGHTNING_KEY_BASE}?bbox=${bbox.join(',')}` : null;
  return useSWR<LightningResponse>(key, jsonFetcher, {
    ...BASE_OPTS,
    refreshInterval: 15_000,
    fallbackData: EMPTY_LIGHTNING,
  });
}

export type MrmsLatestResponse = { urlPath: string | null; fetchedAt?: number; error?: string };
export const MRMS_KEY = '/api/radar/mrms-latest';
export function useMrmsLatest() {
  return useSWR<MrmsLatestResponse>(MRMS_KEY, jsonFetcher, {
    ...BASE_OPTS,
    refreshInterval: 180_000,
    fallbackData: { urlPath: null },
  });
}

// F13: mPING crowdsource reports. Same shape as the LSR response so the
// frontend can re-use the FeatureCollection pattern. Refresh slowly (2 min)
// to be polite to NSSL's free API.
export type MpingProps = {
  id: number;
  description: string;
  hazard: 'tornado' | 'severe' | 'flood' | 'wind' | 'winter' | 'other';
  obtime: string;
  category: number;
};
export type MpingResponse = {
  geojson: GeoJSON.FeatureCollection<GeoJSON.Point, MpingProps>;
  count?: number;
  hours?: number;
  error?: string;
};
const EMPTY_MPING: MpingResponse = {
  geojson: { type: 'FeatureCollection', features: [] },
};
export const MPING_KEY = '/api/radar/mping';
export function useMping(enabled: boolean) {
  return useSWR<MpingResponse>(enabled ? MPING_KEY : null, jsonFetcher, {
    ...BASE_OPTS,
    refreshInterval: 120_000,
    fallbackData: EMPTY_MPING,
  });
}

// F12: METAR surface obs. Heavy enough (~120 stations) that we only fetch
// when the layer is enabled. AWC publishes ~every 10 min; 4 min refresh
// keeps the operator within one report cycle of fresh while staying well
// under AWC's anonymous-rate-limit threshold.
export type MetarProps = {
  icaoId?: string;
  obsTime?: string;
  temp?: number | null;
  dewp?: number | null;
  wdir?: number | null;
  wspd?: number | null;
  wgst?: number | null;
  altim?: number | null;
  visib?: number | string | null;
  wxString?: string | null;
  rawOb?: string;
  name?: string;
};
export type MetarResponse = {
  geojson: GeoJSON.FeatureCollection<GeoJSON.Point, MetarProps>;
  count?: number;
  error?: string;
};
const EMPTY_METAR: MetarResponse = {
  geojson: { type: 'FeatureCollection', features: [] },
};
export const METAR_KEY = '/api/radar/metar';
export function useMetar(enabled: boolean) {
  return useSWR<MetarResponse>(enabled ? METAR_KEY : null, jsonFetcher, {
    ...BASE_OPTS,
    refreshInterval: 240_000,
    fallbackData: EMPTY_METAR,
  });
}

// F10: MESH (Maximum Estimated Size of Hail). Window in minutes — MRMS
// publishes 30, 60, 120, and 1440-min accumulation tracks. 30 is the
// operational sweet spot: long enough to show a swath shape, short enough
// to still reflect "where hail is falling right now."
export type MrmsMeshResponse = {
  urlPath: string | null;
  window: number;
  fetchedAt?: number;
  error?: string;
};
export const MRMS_MESH_KEY_BASE = '/api/radar/mrms-mesh-latest';
export function useMrmsMesh(enabled: boolean, windowMin: number) {
  const key = enabled ? `${MRMS_MESH_KEY_BASE}?window=${windowMin}` : null;
  return useSWR<MrmsMeshResponse>(key, jsonFetcher, {
    ...BASE_OPTS,
    // MESH publishes every ~2 min; 3-min refresh keeps the overlay in step
    // without thrashing the THREDDS catalog.
    refreshInterval: 180_000,
    fallbackData: { urlPath: null, window: windowMin },
  });
}

export type AfdItem = {
  id: string;
  wfo: string;
  product_id: string;
  issued_at: string;
  synopsis: string | null;
  short_term: string | null;
  long_term: string | null;
  aviation: string | null;
  ai_summary: string | null;
  text: string;
};
export type AfdResponse = { items: AfdItem[] };
const EMPTY_AFD: AfdResponse = { items: [] };
export const AFD_KEY = '/api/radar/afd';
export function useAfd() {
  return useSWR<AfdResponse>(AFD_KEY, jsonFetcher, {
    ...BASE_OPTS,
    // AFDs publish ~4×/day per office; refresh every 10 min to stay in step
    // with the edge function's 30-min poll without piling up duplicate work.
    refreshInterval: 600_000,
    fallbackData: EMPTY_AFD,
  });
}
