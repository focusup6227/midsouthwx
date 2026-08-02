import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Station guidance: MOS (GFS/MAV, NAM/MET) and NBM (NBS short / NBE extended)
// bulletins via Iowa State Mesonet's archive. Latest run for a station,
// normalized to the columns the guidance table renders.
const MODELS = new Set(['GFS', 'NAM', 'NBS', 'NBE']);

type IemRow = Record<string, unknown> & { ftime_utc?: string; runtime_utc?: string };

export async function GET(req: NextRequest) {
  const station = (req.nextUrl.searchParams.get('station') ?? '').toUpperCase().trim();
  const model = (req.nextUrl.searchParams.get('model') ?? 'NBS').toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(station)) {
    return NextResponse.json({ error: 'station must be a 4-char id (e.g. KMEM)' }, { status: 400 });
  }
  if (!MODELS.has(model)) {
    return NextResponse.json({ error: `model must be one of ${[...MODELS].join(', ')}` }, { status: 400 });
  }

  try {
    const res = await fetch(
      `https://mesonet.agron.iastate.edu/api/1/mos.json?station=${station}&model=${model}`,
      { signal: AbortSignal.timeout(20_000), cache: 'no-store' },
    );
    if (!res.ok) return NextResponse.json({ error: `iem ${res.status}` }, { status: 502 });
    const body = (await res.json()) as { data?: IemRow[] };
    const rows = body.data ?? [];
    if (rows.length === 0) {
      return NextResponse.json({
        station, model, runtime: null, rows: [],
        hint: 'No guidance for this station/model — MOS uses METAR ids (KMEM); NBM covers more sites (KNQA works).',
      });
    }

    const num = (r: IemRow, k: string) => {
      const v = r[k];
      return typeof v === 'number' && Number.isFinite(v) ? v : null;
    };
    const str = (r: IemRow, k: string) => {
      const v = r[k];
      return typeof v === 'string' && v.trim() ? v : null;
    };

    // IEM's *_utc fields are UTC but carry no zone suffix — tag them so
    // Date() parses them as UTC instead of browser-local (a silent 5-6 h
    // shift otherwise).
    const asUtc = (t: string) => (/[zZ]|[+-]\d{2}:?\d{2}$/.test(t) ? t : `${t.replace(' ', 'T')}Z`);
    const out = rows
      .filter((r) => r.ftime_utc || (r as { ftime?: string }).ftime)
      .map((r) => ({
        ftime: asUtc((r.ftime_utc ?? (r as { ftime?: string }).ftime) as string),
        tmp: num(r, 'tmp'),
        dpt: num(r, 'dpt'),
        txn: num(r, 'txn') ?? num(r, 'n_x'),          // max/min temp (NBM txn, MOS n_x)
        sky: str(r, 'cld') ?? (num(r, 'sky') != null ? `${num(r, 'sky')}%` : null),
        wdr: num(r, 'wdr'),
        wsp: num(r, 'wsp'),
        gst: num(r, 'gst'),
        p06: num(r, 'p06'),
        p12: num(r, 'p12'),
        t06: num(r, 't06'),                           // 6-h thunderstorm prob
        t12: num(r, 't12'),
        q06: num(r, 'q06'),
        q12: num(r, 'q12'),
        vis: num(r, 'vis'),
        cig: num(r, 'cig'),
      }));

    return NextResponse.json(
      {
        station,
        model,
        runtime: asUtc((rows[0].runtime_utc ?? (rows[0] as { runtime?: string }).runtime) as string),
        rows: out,
      },
      { headers: { 'Cache-Control': 'private, max-age=600' } },
    );
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'iem_unreachable' }, { status: 502 });
  }
}
