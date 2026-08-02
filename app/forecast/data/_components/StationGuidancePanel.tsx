'use client';

import { useState } from 'react';
import useSWR from 'swr';
import { Search } from 'lucide-react';

// Station guidance: MOS (MAV/MET) + NBM (NBS/NBE) bulletins in the classic
// transposed layout — variables down the side, forecast times across.
// Search any 4-char station: MOS covers METAR sites (KMEM), NBM covers far
// more (KNQA itself verifies).

type GuidanceRow = {
  ftime: string;
  tmp: number | null; dpt: number | null; txn: number | null;
  sky: string | null; wdr: number | null; wsp: number | null; gst: number | null;
  p06: number | null; p12: number | null; t06: number | null; t12: number | null;
  q06: number | null; q12: number | null; vis: number | null; cig: number | null;
};
type GuidanceResp = {
  station: string; model: string; runtime: string | null;
  rows: GuidanceRow[]; hint?: string; error?: string;
};

const MODELS = [
  { id: 'NBS', label: 'NBM · NBS', note: 'hourly/3-h short range' },
  { id: 'NBE', label: 'NBM · NBE', note: 'extended' },
  { id: 'GFS', label: 'MOS · MAV', note: 'GFS short range' },
  { id: 'NAM', label: 'MOS · MET', note: 'NAM short range' },
] as const;

const jsonFetcher = (u: string) => fetch(u).then((r) => r.json());

// Variable rows: label, key, formatter, emphasis test for hot values.
const VARS: {
  label: string;
  key: keyof GuidanceRow;
  fmt?: (v: number) => string;
  hot?: (v: number) => boolean;
}[] = [
  { label: 'Temp °F', key: 'tmp' },
  { label: 'Dewpt °F', key: 'dpt' },
  { label: 'Max/Min', key: 'txn' },
  { label: 'Wind dir', key: 'wdr', fmt: (v) => String(Math.round(v / 10) * 10) },
  { label: 'Wind kt', key: 'wsp', hot: (v) => v >= 25 },
  { label: 'Gust kt', key: 'gst', hot: (v) => v >= 35 },
  { label: 'PoP 6h %', key: 'p06', hot: (v) => v >= 60 },
  { label: 'PoP 12h %', key: 'p12', hot: (v) => v >= 60 },
  { label: 'Tstm 6h %', key: 't06', hot: (v) => v >= 40 },
  { label: 'Tstm 12h %', key: 't12', hot: (v) => v >= 40 },
];

function fmtTime(iso: string): { day: string; hour: string } {
  const d = new Date(iso);
  return {
    day: d.toLocaleDateString('en-US', { weekday: 'short' }),
    hour: d.toLocaleTimeString('en-US', { hour: 'numeric', hour12: true }).replace(' ', '').toLowerCase(),
  };
}

export default function StationGuidancePanel() {
  const [station, setStation] = useState('KMEM');
  const [input, setInput] = useState('KMEM');
  const [model, setModel] = useState<(typeof MODELS)[number]['id']>('NBS');

  const { data, isLoading } = useSWR<GuidanceResp>(
    `/api/forecast/mos?station=${station}&model=${model}`,
    jsonFetcher,
    { refreshInterval: 900_000, revalidateOnFocus: false },
  );

  const rows = data?.rows ?? [];
  // Drop variable rows with no values at all for this model (keeps MAV's
  // sparse column set from rendering as dashes).
  const activeVars = VARS.filter((v) => rows.some((r) => r[v.key] != null));

  return (
    <section className="card p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-semibold">Station guidance — MOS &amp; NBM</h2>
          <p className="text-xs text-wx-mute">
            {data?.runtime
              ? `${data.station} · ${data.model} run ${new Date(data.runtime).toLocaleString()} · times shown in your local time`
              : 'Latest run per station · times shown in your local time'}
          </p>
        </div>
        <form
          className="flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            const s = input.toUpperCase().trim();
            if (/^[A-Z0-9]{4}$/.test(s)) setStation(s);
          }}
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value.toUpperCase())}
            maxLength={4}
            placeholder="KMEM"
            className="input w-24 px-2 py-1 font-mono text-sm uppercase"
            aria-label="Station id"
          />
          <button type="submit" className="btn-ghost px-2 py-1 text-sm" aria-label="Load station">
            <Search size={14} />
          </button>
        </form>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {MODELS.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => setModel(m.id)}
            title={m.note}
            className={`rounded-md border px-2 py-1 text-[11px] font-semibold ${
              model === m.id
                ? 'border-wx-accent bg-wx-accent/10 text-wx-accent'
                : 'border-wx-line text-wx-mute hover:text-wx-fg'
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <p className="text-sm text-wx-mute">Loading {model} for {station}…</p>
      ) : data?.error ? (
        <p className="text-sm text-wx-danger">{data.error}</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-wx-mute">
          {data?.hint ?? `No ${model} guidance for ${station}.`}
        </p>
      ) : (
        <div className="overflow-x-auto wx-scroll">
          <table className="text-[11px] font-mono tabular-nums">
            <thead>
              <tr className="text-wx-mute">
                <th className="sticky left-0 bg-wx-card pr-2 text-left font-sans font-semibold" />
                {rows.map((r, i) => {
                  const t = fmtTime(r.ftime);
                  const prevDay = i > 0 ? fmtTime(rows[i - 1].ftime).day : null;
                  return (
                    <th key={r.ftime} className="px-1.5 pb-1 text-center font-normal">
                      <div className={t.day !== prevDay ? 'text-wx-fg font-semibold' : 'text-wx-mute/60'}>
                        {t.day !== prevDay ? t.day : '·'}
                      </div>
                      <div>{t.hour}</div>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {activeVars.map((v) => (
                <tr key={v.key} className="border-t border-wx-line/50">
                  <td className="sticky left-0 bg-wx-card py-0.5 pr-2 font-sans text-wx-mute whitespace-nowrap">
                    {v.label}
                  </td>
                  {rows.map((r) => {
                    const val = r[v.key];
                    const hot = typeof val === 'number' && v.hot?.(val);
                    return (
                      <td
                        key={r.ftime}
                        className={`px-1.5 py-0.5 text-center ${
                          val == null ? 'text-wx-mute/40' : hot ? 'font-bold text-wx-accent' : 'text-wx-fg'
                        }`}
                      >
                        {val == null ? '·' : typeof val === 'number' && v.fmt ? v.fmt(val) : val}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
