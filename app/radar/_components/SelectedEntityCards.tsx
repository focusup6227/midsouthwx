'use client';

import { X } from 'lucide-react';
import StormReportPopupActions from './StormReportPopupActions';

// Floating lower-right cards for the map's click-selected entities (LSR /
// subscriber storm report / mPING / METAR / rotation couplet). Extracted from
// RadarView so the card markup lives next to its siblings instead of inline
// in the map JSX. All five share the same slot; RadarView's click dispatch
// guarantees at most one is open per click flow.

export type SelectedLsr = {
  id: string;
  event: string;
  hazard: string | null;
  magnitude: string | null;
  location: string | null;
  occurred_at: string | null;
  remark: string | null;
  source: string | null;
};

export type SelectedStormReport = {
  id: string;
  hazard: string;
  description: string | null;
  photo_url: string | null;
  reported_at: string | null;
  reporter: string | null;
  place_name: string | null;
  status: string | null;
  lat: number;
  lon: number;
};

export type SelectedMping = {
  id: number;
  description: string;
  hazard: string;
  obtime: string;
};

export type SelectedMetar = {
  icaoId: string;
  name: string | null;
  obsTime: string | null;
  temp: number | null;
  dewp: number | null;
  wdir: number | null;
  wspd: number | null;
  wgst: number | null;
  altim: number | null;
  wxString: string | null;
  rawOb: string | null;
};

export type SelectedCouplet = {
  track_id: string;
  site: string;
  shear_kt: number;
  max_shear_kt: number;
  range_km: number;
  azimuth_deg: number;
  elevation_deg: number;
  volume_time_utc: string | null;
  first_seen_at: string | null;
  volume_count: number;
  lat: number;
  lon: number;
};

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button
      type="button"
      onClick={onClose}
      className="text-wx-mute hover:text-wx-fg shrink-0"
      aria-label="Clear selection"
    >
      <X size={14} />
    </button>
  );
}

// F4: selected Local Storm Report card. Floats above the hover-pixel
// readout so the operator can dismiss without losing the cursor position.
export function LsrCard({ lsr, onClose }: { lsr: SelectedLsr; onClose: () => void }) {
  return (
    <div className="absolute bottom-16 md:bottom-14 left-2 right-2 md:left-auto md:right-4 md:w-[280px] p-3 bg-wx-card border border-wx-line rounded-xl z-30 space-y-1.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-wider text-wx-mute font-semibold">
            NWS Storm Report{lsr.source ? ` · ${lsr.source}` : ''}
          </div>
          <div className="text-[12px] font-semibold text-wx-fg mt-0.5">
            {lsr.event}
            {lsr.magnitude ? <span className="ml-1.5 font-mono text-wx-accent">{lsr.magnitude}</span> : null}
          </div>
          {lsr.location ? (
            <div className="text-[11px] text-wx-mute mt-0.5">{lsr.location}</div>
          ) : null}
        </div>
        <CloseButton onClose={onClose} />
      </div>
      {lsr.occurred_at ? (
        <div className="text-[10px] font-mono text-wx-mute">
          {new Date(lsr.occurred_at).toLocaleString([], {
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
          })}
        </div>
      ) : null}
      {lsr.remark ? (
        <p className="text-[10.5px] text-wx-fg/85 italic line-clamp-4">
          &quot;{lsr.remark}&quot;
        </p>
      ) : null}
    </div>
  );
}

export function StormReportCard({
  report: sr,
  onClose,
  onActed,
}: {
  report: SelectedStormReport;
  onClose: () => void;
  onActed: () => void;
}) {
  const hazardLabelMap: Record<string, string> = {
    tornado: 'Tornado',
    funnel: 'Funnel cloud',
    wind: 'Damaging wind',
    hail: 'Hail',
    flood: 'Flooding',
    other: 'Severe weather',
  };
  const ageMin = sr.reported_at
    ? Math.max(0, Math.round((Date.now() - new Date(sr.reported_at).getTime()) / 60_000))
    : null;
  return (
    <div className="absolute bottom-16 md:bottom-14 left-2 right-2 md:left-auto md:right-4 md:w-[300px] p-3 bg-wx-card border border-wx-line rounded-xl z-30 space-y-1.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-wider text-wx-mute font-semibold flex items-center gap-1.5">
            <span>Subscriber report{sr.reporter ? ` · ${sr.reporter}` : ''}</span>
            {sr.status && sr.status !== 'new' ? (
              <span className={
                'px-1.5 py-0.5 rounded text-[9px] ' +
                (sr.status === 'verified' ? 'bg-emerald-400/15 text-emerald-300' :
                 sr.status === 'promoted' ? 'bg-sky-400/15 text-sky-300' :
                 'bg-wx-line/40 text-wx-mute')
              }>{sr.status}</span>
            ) : null}
          </div>
          <div className="text-[12px] font-semibold text-wx-fg mt-0.5">
            {hazardLabelMap[sr.hazard] ?? sr.hazard}
          </div>
          {sr.place_name ? (
            <div className="text-[11px] text-wx-mute mt-0.5">{sr.place_name}</div>
          ) : null}
        </div>
        <CloseButton onClose={onClose} />
      </div>
      {ageMin != null ? (
        <div className="text-[10px] font-mono text-wx-mute">
          {ageMin < 60 ? `${ageMin} min ago` : `${Math.round(ageMin / 60)} h ago`}
        </div>
      ) : null}
      {sr.photo_url ? (
        <a
          href={sr.photo_url}
          target="_blank"
          rel="noreferrer"
          className="block rounded-md overflow-hidden border border-wx-line"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={sr.photo_url}
            alt="Subscriber storm report"
            className="w-full max-h-48 object-cover"
            loading="lazy"
          />
        </a>
      ) : null}
      {sr.description ? (
        <p className="text-[10.5px] text-wx-fg/85 italic line-clamp-4">
          &quot;{sr.description}&quot;
        </p>
      ) : null}
      <StormReportPopupActions report={sr} onActed={onActed} />
    </div>
  );
}

// F13: selected mPING report card. Compact — just description + age + a
// "lower confidence than LSR" reminder. The operator looks at this to decide
// whether to escalate from "possible" to "confirmed" before sending an alert.
export function MpingCard({ report: sm, onClose }: { report: SelectedMping; onClose: () => void }) {
  const ageMin = sm.obtime
    ? Math.max(0, Math.round((Date.now() - new Date(sm.obtime).getTime()) / 60_000))
    : null;
  return (
    <div className="absolute bottom-16 md:bottom-14 left-2 right-2 md:left-auto md:right-4 md:w-[280px] p-3 bg-wx-card border border-wx-line rounded-xl z-30 space-y-1.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-wider text-wx-mute font-semibold">
            mPING · citizen report
          </div>
          <div className="text-[12px] font-semibold text-wx-fg mt-0.5">
            {sm.description}
          </div>
        </div>
        <CloseButton onClose={onClose} />
      </div>
      {ageMin != null ? (
        <div className="text-[10px] font-mono text-wx-mute">
          {ageMin} min ago · hazard {sm.hazard}
        </div>
      ) : null}
      <div className="text-[10px] text-wx-mute/80 italic">
        Crowdsourced — verify before treating as confirmed ground truth.
      </div>
    </div>
  );
}

// F12: selected METAR station card. Single-line obs summary plus raw METAR
// for the operator who wants the full picture. Sits in the same lower-right
// slot as the LSR / couplet cards; only one of the three can be open at a
// time per click flow.
export function MetarCard({ metar: m, onClose }: { metar: SelectedMetar; onClose: () => void }) {
  const toF = (c: number | null) => c == null ? null : Math.round(c * 1.8 + 32);
  const tempF = toF(m.temp);
  const dewpF = toF(m.dewp);
  const ageMin = m.obsTime
    ? Math.max(0, Math.round((Date.now() - new Date(m.obsTime).getTime()) / 60_000))
    : null;
  return (
    <div className="absolute bottom-16 md:bottom-14 left-2 right-2 md:left-auto md:right-4 md:w-[300px] p-3 bg-wx-card border border-wx-line rounded-xl z-30 space-y-1.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-wider text-wx-mute font-semibold">
            METAR{ageMin != null ? ` · ${ageMin} min old` : ''}
          </div>
          <div className="text-[13px] font-mono font-bold text-cyan-200 mt-0.5">
            {m.icaoId}
          </div>
          {m.name ? (
            <div className="text-[10.5px] text-wx-mute mt-0.5 truncate">{m.name}</div>
          ) : null}
        </div>
        <CloseButton onClose={onClose} />
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10.5px] font-mono">
        {tempF != null ? (
          <div><span className="text-wx-mute/70">T</span> <span className="text-wx-fg">{tempF}°F</span></div>
        ) : null}
        {dewpF != null ? (
          <div><span className="text-wx-mute/70">Td</span> <span className="text-wx-fg">{dewpF}°F</span></div>
        ) : null}
        {m.wspd != null && m.wspd > 0 ? (
          <div className="col-span-2">
            <span className="text-wx-mute/70">wind</span>{' '}
            <span className="text-wx-fg">
              {m.wdir != null ? `${Math.round(m.wdir)}°` : 'VRB'} @ {Math.round(m.wspd)} kt
            </span>
            {m.wgst != null && m.wgst > 0 ? (
              <span className={`ml-1.5 ${m.wgst >= 35 ? 'text-red-300' : 'text-amber-200'}`}>
                G{Math.round(m.wgst)}
              </span>
            ) : null}
          </div>
        ) : (
          <div className="col-span-2 text-wx-mute/70">calm</div>
        )}
        {m.altim != null ? (
          <div className="col-span-2 text-[10px] text-wx-mute">altim {m.altim.toFixed(0)} hPa</div>
        ) : null}
        {m.wxString ? (
          <div className="col-span-2 text-amber-200">{m.wxString}</div>
        ) : null}
      </div>
      {m.rawOb ? (
        <pre className="mt-1 text-[9.5px] font-mono text-wx-mute/80 whitespace-pre-wrap break-all border-t border-wx-line/60 pt-1">{m.rawOb}</pre>
      ) : null}
    </div>
  );
}

// F9: selected NEXRAD velocity-couplet ("rotation ID") card. Volume_count +
// first_seen disambiguate a one-scan blip from a persistent circulation;
// "Alert from this rotation" pre-fills compose with a circle around the meso,
// ready to send.
export function CoupletCard({ couplet: sc, onClose }: { couplet: SelectedCouplet; onClose: () => void }) {
  const intensity = sc.max_shear_kt >= 80
    ? { label: 'TVS-strength', cls: 'text-red-300', dot: 'bg-red-400' }
    : sc.max_shear_kt >= 60
    ? { label: 'Meso',          cls: 'text-fuchsia-300', dot: 'bg-fuchsia-400' }
    : { label: 'Weak couplet',  cls: 'text-amber-300', dot: 'bg-amber-400' };
  const ageMin = sc.first_seen_at
    ? Math.max(0, Math.round((Date.now() - new Date(sc.first_seen_at).getTime()) / 60_000))
    : null;
  // F19a: signature-triggered phrasing. Body copy and audience radius
  // escalate with shear strength so the operator's default alert matches the
  // threat tier. Tier breakpoints align with the pin's color (60 kt = meso,
  // 80 kt = TVS-strength) so the visual intensity and the language move
  // together.
  const tier = sc.max_shear_kt >= 80
    ? 'tvs'
    : sc.max_shear_kt >= 60
    ? 'meso'
    : 'weak';
  const composeGeo = {
    type: 'circle' as const,
    center: [sc.lon, sc.lat] as [number, number],
    // Wider audience for stronger rotations — downstream impact grows with
    // intensity, and a TVS warrants pulling in neighbors a township over.
    radius_km: tier === 'tvs' ? 12 : tier === 'meso' ? 9 : 6,
  };
  const ageStr = ageMin != null ? `${ageMin} min` : 'new';
  const persistStr = sc.volume_count >= 3 ? ', persistent' : '';
  const body =
    tier === 'tvs'
      ? `TORNADO LIKELY — strong rotation (${Math.round(sc.max_shear_kt)} kt gate-to-gate, ${ageStr}${persistStr}) on ${sc.site} radar at ${sc.track_id}. TAKE SHELTER NOW if you are in the affected area: lowest floor, interior room, away from windows. Stay sheltered until the threat passes.`
      : tier === 'meso'
      ? `Rotation observed — mesocyclone signature (${Math.round(sc.max_shear_kt)} kt, ${ageStr}${persistStr}) on ${sc.site} radar at ${sc.track_id}. Move to a safe shelter and monitor for a tornado warning. Do not wait for sirens.`
      : `Weak rotation under observation (${Math.round(sc.shear_kt)} kt, ${ageStr}) on ${sc.site} radar at ${sc.track_id}. Stay weather-aware and have a shelter plan ready in case it strengthens.`;
  const composeHref = `/compose?geo=${encodeURIComponent(JSON.stringify(composeGeo))}&hazard=tornado&body=${encodeURIComponent(body)}`;
  return (
    <div className="absolute bottom-16 md:bottom-14 left-2 right-2 md:left-auto md:right-4 md:w-[300px] p-3 bg-wx-card border border-wx-line rounded-xl z-30 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-wider text-wx-mute font-semibold flex items-center gap-1.5">
            <span className={`inline-block h-2 w-2 rounded-full ${intensity.dot}`} />
            Rotation ID · {sc.site}
          </div>
          <div className="text-[14px] font-mono font-bold text-fuchsia-200 mt-0.5">
            {sc.track_id}
          </div>
          <div className={`text-[11px] mt-0.5 ${intensity.cls}`}>
            {intensity.label} · {Math.round(sc.shear_kt)} kt gate-to-gate shear
            {sc.max_shear_kt > sc.shear_kt
              ? <span className="text-wx-mute"> (peak {Math.round(sc.max_shear_kt)})</span>
              : null}
          </div>
        </div>
        <CloseButton onClose={onClose} />
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px] font-mono text-wx-mute">
        <div><span className="text-wx-mute/70">range</span> {sc.range_km.toFixed(0)} km</div>
        <div><span className="text-wx-mute/70">az</span> {Math.round(sc.azimuth_deg)}°</div>
        <div><span className="text-wx-mute/70">tilt</span> {sc.elevation_deg.toFixed(1)}°</div>
        <div><span className="text-wx-mute/70">scans</span> {sc.volume_count}</div>
        {ageMin != null ? (
          <div className="col-span-2"><span className="text-wx-mute/70">first seen</span> {ageMin} min ago</div>
        ) : null}
      </div>
      <a
        href={composeHref}
        target="_blank"
        rel="noreferrer"
        className="block w-full text-center px-2.5 py-1.5 text-[11px] font-semibold rounded-md bg-fuchsia-500/90 hover:bg-fuchsia-500 text-white"
      >
        Alert from this rotation →
      </a>
    </div>
  );
}
