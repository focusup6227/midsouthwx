import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const revalidate = 60;

// MRMS RotationTrack GRIB2 files publish to UCAR THREDDS every ~10 min with a
// timestamped filename. The browser can't fetch THREDDS directly (no CORS), but
// we can resolve the latest filename here and let the client point its WMS GetMap
// requests at it. The PNG tiles themselves load fine via <img> regardless of CORS.
const LATEST_XML_URL =
  'https://thredds.ucar.edu/thredds/catalog/grib/NCEP/MRMS/CONUS/RotationTrack/latest.xml';

export async function GET() {
  try {
    const res = await fetch(LATEST_XML_URL, {
      next: { revalidate: 60 },
      headers: { Accept: 'application/xml' },
    });
    if (!res.ok) {
      return NextResponse.json(
        { urlPath: null, error: `thredds_${res.status}` },
        { status: 502 },
      );
    }
    const xml = await res.text();
    const m = xml.match(
      /urlPath="(grib\/NCEP\/MRMS\/CONUS\/RotationTrack\/MRMS_CONUS_RotationTrack_\d{8}_\d{4}\.grib2)"/,
    );
    if (!m) {
      return NextResponse.json(
        { urlPath: null, error: 'no_urlpath_match' },
        { status: 502 },
      );
    }
    return NextResponse.json(
      { urlPath: m[1], fetchedAt: Date.now() },
      { headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300' } },
    );
  } catch (e: any) {
    return NextResponse.json(
      { urlPath: null, error: e?.message || 'fetch_error' },
      { status: 502 },
    );
  }
}
