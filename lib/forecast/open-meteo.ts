// Server-side convective-parameter sampler for the AI forecast draft.
//
// The SPC mesoanalysis the operator reads is raster-only (no numeric API), and
// raw severe-storm params (SRH/STP/SCP) need GRIB. Open-Meteo's free API,
// however, exposes the thermodynamic core — CAPE, CIN, Lifted Index — sampled
// from a best-match model, no key required. We pull those at the forecast
// area's centroid over the valid window and summarize them so the draft model
// can cite real instability numbers instead of reasoning from text alone.
//
// This is deliberately deploy-free (no GRIB, no renderer). When the model
// renderer lands, a point-sample endpoint can enrich this with shear/SRH/STP.

export type ConvectiveSample = {
  t: string;            // ISO hour (UTC)
  cape: number | null;  // J/kg
  cin: number | null;   // J/kg
  li: number | null;    // Lifted Index (°C, lower = more unstable)
};

export type ConvectiveSummary = {
  source: string;
  centroid: { lat: number; lon: number };
  window: { from: string; until: string };
  peak_cape: { value: number; at: string } | null;
  cin_at_peak: number | null;
  min_lifted_index: { value: number; at: string } | null;
  // A coarse trace (every ~6 h) so the model sees timing, not just extremes.
  trace: ConvectiveSample[];
};

function utcDate(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

/**
 * Sample CAPE/CIN/LI at a point over [from, until]. Best-effort: returns null
 * on any failure so the caller can proceed with a text-only draft.
 */
export async function sampleConvectiveContext(
  lat: number,
  lon: number,
  fromIso: string,
  untilIso: string,
): Promise<ConvectiveSummary | null> {
  try {
    const url = new URL('https://api.open-meteo.com/v1/forecast');
    url.searchParams.set('latitude', lat.toFixed(3));
    url.searchParams.set('longitude', lon.toFixed(3));
    url.searchParams.set('hourly', 'cape,convective_inhibition,lifted_index');
    url.searchParams.set('timezone', 'UTC');
    url.searchParams.set('start_date', utcDate(fromIso));
    url.searchParams.set('end_date', utcDate(untilIso));

    const res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(8_000),
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const data = await res.json();
    const h = data?.hourly;
    if (!h?.time?.length) return null;

    const fromMs = new Date(fromIso).getTime();
    const untilMs = new Date(untilIso).getTime();

    const samples: ConvectiveSample[] = [];
    for (let i = 0; i < h.time.length; i++) {
      // Open-Meteo UTC times come back without a 'Z'; append it.
      const tMs = new Date(`${h.time[i]}Z`).getTime();
      if (tMs < fromMs || tMs > untilMs) continue;
      samples.push({
        t: `${h.time[i]}Z`,
        cape: numOrNull(h.cape?.[i]),
        cin: numOrNull(h.convective_inhibition?.[i]),
        li: numOrNull(h.lifted_index?.[i]),
      });
    }
    if (!samples.length) return null;

    let peak: { value: number; at: string } | null = null;
    let cinAtPeak: number | null = null;
    let minLi: { value: number; at: string } | null = null;
    for (const s of samples) {
      if (s.cape != null && (peak == null || s.cape > peak.value)) {
        peak = { value: Math.round(s.cape), at: s.t };
        cinAtPeak = s.cin != null ? Math.round(s.cin) : null;
      }
      if (s.li != null && (minLi == null || s.li < minLi.value)) {
        minLi = { value: Math.round(s.li * 10) / 10, at: s.t };
      }
    }

    // Thin to ~every 6th hour for the trace, always keeping first/last.
    const trace = samples.filter((_, i) => i % 6 === 0 || i === samples.length - 1);

    return {
      source: 'Open-Meteo (best-match model)',
      centroid: { lat, lon },
      window: { from: fromIso, until: untilIso },
      peak_cape: peak,
      cin_at_peak: cinAtPeak,
      min_lifted_index: minLi,
      trace,
    };
  } catch {
    return null;
  }
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && !Number.isNaN(v) ? v : null;
}
