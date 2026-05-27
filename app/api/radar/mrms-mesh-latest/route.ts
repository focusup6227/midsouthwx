// F10: resolve the latest MRMS Maximum Estimated Size of Hail (MESH) Max
// dataset path on UCAR THREDDS for a given accumulation window (30 / 60 /
// 120 min). MESH publishes alongside the rotation track this app already
// consumes (see /api/radar/mrms-latest) and uses the same URL conventions —
// timestamped GRIB2 filename in `grib/NCEP/MRMS/CONUS/MESH_Max_<min>min/`.
//
// The browser can't fetch the THREDDS catalog XML directly (no CORS); we
// resolve the latest filename server-side and the client builds WMS GetMap
// URLs that point at it. PNG tiles themselves load fine via <img>.
//
// Returned `urlPath` plugs into THREDDS_WMS_URL in RadarView with the WMS
// layer name `MESHTracks_altitude_above_msl` (the ncWMS-generated layer
// for the MESH track variable in these GRIB2 files).

import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const revalidate = 60;

const ALLOWED_WINDOWS = [30, 60, 120, 1440] as const;
type Window = typeof ALLOWED_WINDOWS[number];

const CATALOG = (win: Window) =>
  `https://thredds.ucar.edu/thredds/catalog/grib/NCEP/MRMS/CONUS/MESH_Max_${win}min/latest.xml`;

// The latest.xml entry encodes the dataset as e.g.
//   urlPath="grib/NCEP/MRMS/CONUS/MESH_Max_30min/MRMS_CONUS_MESH_Max_30min_20260524_1830.grib2"
// One regex per accumulation window keeps stray paths from sneaking through.
const URL_PATH_RE = (win: Window) =>
  new RegExp(
    `urlPath="(grib\\/NCEP\\/MRMS\\/CONUS\\/MESH_Max_${win}min\\/MRMS_CONUS_MESH_Max_${win}min_\\d{8}_\\d{4}\\.grib2)"`,
  );

export async function GET(req: NextRequest) {
  const raw = parseInt(req.nextUrl.searchParams.get('window') || '30', 10);
  const win = (ALLOWED_WINDOWS as readonly number[]).includes(raw)
    ? (raw as Window)
    : 30;

  try {
    const res = await fetch(CATALOG(win), {
      next: { revalidate: 60 },
      headers: { Accept: 'application/xml' },
    });
    if (!res.ok) {
      return NextResponse.json(
        { urlPath: null, window: win, error: `thredds_${res.status}` },
        { status: 502 },
      );
    }
    const xml = await res.text();
    const m = xml.match(URL_PATH_RE(win));
    if (!m) {
      return NextResponse.json(
        { urlPath: null, window: win, error: 'no_urlpath_match' },
        { status: 502 },
      );
    }
    return NextResponse.json(
      { urlPath: m[1], window: win, fetchedAt: Date.now() },
      { headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300' } },
    );
  } catch (e: any) {
    return NextResponse.json(
      { urlPath: null, window: win, error: e?.message || 'fetch_error' },
      { status: 502 },
    );
  }
}
