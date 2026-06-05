// Server-side severe-weather ingredient sampler for the AI forecast draft.
//
// Calls the renderer's /sample-point endpoint (HRRR GRIB → CAPE/CIN/SRH/shear
// nearest a point), giving the AI the *kinematic* ingredients Open-Meteo can't
// provide (storm-relative helicity, bulk shear). Best-effort: returns null on
// any failure so the draft falls back to the Open-Meteo thermodynamic sample.

export type SevereSample = {
  model: string;
  cycle: string | null;
  valid_time: string | null;
  point: { lat: number; lon: number };
  sbcape: number | null;
  sbcin: number | null;
  mlcape: number | null;
  mlcin: number | null;
  mucape: number | null;
  lcl_m: number | null;
  srh_0_1km: number | null;
  srh_0_3km: number | null;
  shear_0_1km_kt: number | null;
  shear_0_6km_kt: number | null;
  // Fixed-layer (approximate) composite parameters.
  stp_fixed: number | null;
  scp_fixed: number | null;
};

export async function sampleSevereParams(lat: number, lon: number): Promise<SevereSample | null> {
  const base = process.env.RENDERER_BASE_URL;
  const token = process.env.RENDERER_TOKEN;
  if (!base || !token) return null;
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/sample-point`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat, lon, fhr: 0 }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as SevereSample;
  } catch {
    return null;
  }
}
