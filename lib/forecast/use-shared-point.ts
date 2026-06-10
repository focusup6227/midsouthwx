'use client';

// Shared, persisted location for the /forecast data viewers. Previously each
// panel (point forecast, severe params, ensemble plume, sounding) kept its own
// useState(DEFAULT_POINT): the operator had to re-pick the same city in every
// panel, every visit. This hook keeps one point in localStorage and syncs
// panels in the same tab via a custom event (the native `storage` event only
// fires across tabs).

import { useEffect, useState } from 'react';
import { DEFAULT_POINT, type ForecastPoint } from './points';

const KEY = 'midsouthwx:forecast-point';
const EVENT = 'midsouthwx:forecast-point-change';

function parsePoint(raw: string | null): ForecastPoint | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<ForecastPoint>;
    if (
      typeof o.key === 'string' &&
      typeof o.city === 'string' &&
      typeof o.state === 'string' &&
      typeof o.lat === 'number' &&
      typeof o.lon === 'number'
    ) {
      return o as ForecastPoint;
    }
  } catch {
    /* corrupt entry — fall through to default */
  }
  return null;
}

export function useSharedForecastPoint(): [ForecastPoint, (p: ForecastPoint) => void] {
  const [pt, setPtState] = useState<ForecastPoint>(DEFAULT_POINT);

  useEffect(() => {
    try {
      const stored = parsePoint(localStorage.getItem(KEY));
      if (stored) setPtState(stored);
    } catch {
      /* storage unavailable */
    }
    const onChange = (e: Event) => {
      const p = (e as CustomEvent<ForecastPoint>).detail;
      if (p && typeof p.lat === 'number') setPtState(p);
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key !== KEY) return;
      const p = parsePoint(e.newValue);
      if (p) setPtState(p);
    };
    window.addEventListener(EVENT, onChange);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(EVENT, onChange);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const setPt = (p: ForecastPoint) => {
    setPtState(p);
    try {
      localStorage.setItem(KEY, JSON.stringify(p));
    } catch {
      /* storage unavailable */
    }
    window.dispatchEvent(new CustomEvent<ForecastPoint>(EVENT, { detail: p }));
  };

  return [pt, setPt];
}
