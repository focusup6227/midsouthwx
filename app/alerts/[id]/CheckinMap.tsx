'use client';

// Real-time map of subscriber check-in state for a single alert message.
// Each subscriber with a known location renders as a colored dot:
//   green   = ✅ safe
//   red     = 🆘 distress (help / sos)
//   amber   = some other response code (sheltering, etc.)
//   gray    = silent (no response yet)
// Operator clicks a pin → opens the subscriber detail page in a new tab so
// they can follow up directly. Realtime: re-fetches the RPC on any
// check_in_responses insert/update for this message_id.

import '@/lib/mapbox/patch-remove-source';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Map, { Source, Layer, type MapRef, Popup } from 'react-map-gl';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { mapboxAccessToken, mapboxStyleUrl } from '@/lib/supabase/env';
import { supabaseBrowser } from '@/lib/supabase/client';

type Recipient = {
  subscriber_id: string;
  display_name: string | null;
  telegram_username: string | null;
  current_address: string | null;
  home_address: string | null;
  sent_at: string | null;
  response_code: string | null;
  responded_at: string | null;
  lon: number | null;
  lat: number | null;
};

type CheckinState = 'safe' | 'distress' | 'other' | 'silent';

function classify(code: string | null): CheckinState {
  if (!code) return 'silent';
  if (code === 'safe') return 'safe';
  if (code === 'help' || code === 'sos') return 'distress';
  return 'other';
}

// Colors match the list view's STATUS_STYLE in CheckinRecipients.tsx.
const STATE_COLOR: Record<CheckinState, string> = {
  safe:     '#10b981',  // emerald
  distress: '#ef4444',  // red
  other:    '#8b5cf6',  // violet
  silent:   '#6b7280',  // gray
};

// Mapbox circle paint expression — pin color by feature property `state`.
const CIRCLE_PAINT: mapboxgl.CirclePaint = {
  'circle-radius': 8,
  'circle-stroke-width': 2,
  'circle-stroke-color': '#0b1220',
  'circle-color': [
    'match',
    ['get', 'state'],
    'safe', STATE_COLOR.safe,
    'distress', STATE_COLOR.distress,
    'other', STATE_COLOR.other,
    /* default */ STATE_COLOR.silent,
  ],
};

// Distress pins get a halo so they're easy to spot on a crowded map.
const DISTRESS_HALO_PAINT: mapboxgl.CirclePaint = {
  'circle-radius': 18,
  'circle-color': STATE_COLOR.distress,
  'circle-opacity': 0.25,
  'circle-stroke-width': 0,
};

const POLY_FILL_PAINT: mapboxgl.FillPaint = {
  'fill-color': '#fbbf24',
  'fill-opacity': 0.12,
};
const POLY_LINE_PAINT: mapboxgl.LinePaint = {
  'line-color': '#fbbf24',
  'line-width': 1.5,
};

function computeBounds(
  recipients: Recipient[],
  polygon: GeoJSON.Polygon | GeoJSON.MultiPolygon | null,
): mapboxgl.LngLatBoundsLike | null {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  let any = false;
  const include = (lon: number, lat: number) => {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
    any = true;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  };
  for (const r of recipients) {
    if (r.lon != null && r.lat != null) include(r.lon, r.lat);
  }
  if (polygon) {
    const rings =
      polygon.type === 'Polygon'
        ? polygon.coordinates
        : polygon.coordinates.flat();
    for (const ring of rings) {
      for (const [lon, lat] of ring as [number, number][]) include(lon, lat);
    }
  }
  if (!any) return null;
  return [
    [minLon, minLat],
    [maxLon, maxLat],
  ];
}

export default function CheckinMap({
  messageId,
  initial,
  polygon,
}: {
  messageId: string;
  initial: Recipient[];
  polygon: GeoJSON.Polygon | GeoJSON.MultiPolygon | null;
}) {
  const token = mapboxAccessToken();
  const styleUrl = mapboxStyleUrl();
  useEffect(() => { if (token) mapboxgl.accessToken = token; }, [token]);

  const [recipients, setRecipients] = useState<Recipient[]>(initial);
  const [popup, setPopup] = useState<{ lon: number; lat: number; r: Recipient } | null>(null);
  const mapRef = useRef<MapRef>(null);

  // Realtime: re-fetch the RPC on any check_in_responses change for this
  // message. Also refresh on outbound_queue updates (e.g. 'sent' transitions)
  // so brand-new recipients appear as silent pins as they come online.
  useEffect(() => {
    const supa = supabaseBrowser();
    const refresh = async () => {
      const { data } = await supa.rpc('checkin_recipients', { p_message_id: messageId });
      if (data) setRecipients(data as Recipient[]);
    };
    const channel = supa
      .channel(`checkin-map-${messageId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'check_in_responses', filter: `message_id=eq.${messageId}` },
        refresh,
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'outbound_queue', filter: `message_id=eq.${messageId}` },
        refresh,
      )
      .subscribe();
    return () => {
      supa.removeChannel(channel);
    };
  }, [messageId]);

  const { collection, distressCollection } = useMemo(() => {
    const features: GeoJSON.Feature<GeoJSON.Point>[] = [];
    const distressFeatures: GeoJSON.Feature<GeoJSON.Point>[] = [];
    for (const r of recipients) {
      if (r.lon == null || r.lat == null) continue;
      const state = classify(r.response_code);
      const feat: GeoJSON.Feature<GeoJSON.Point> = {
        type: 'Feature',
        id: r.subscriber_id,
        geometry: { type: 'Point', coordinates: [r.lon, r.lat] },
        properties: { state, name: r.display_name ?? 'subscriber', id: r.subscriber_id },
      };
      features.push(feat);
      if (state === 'distress') distressFeatures.push(feat);
    }
    return {
      collection: { type: 'FeatureCollection', features } as GeoJSON.FeatureCollection<GeoJSON.Point>,
      distressCollection: { type: 'FeatureCollection', features: distressFeatures } as GeoJSON.FeatureCollection<GeoJSON.Point>,
    };
  }, [recipients]);

  const polygonGeoJson = useMemo<GeoJSON.Feature | null>(
    () => (polygon ? { type: 'Feature', geometry: polygon, properties: {} } : null),
    [polygon],
  );

  const bounds = useMemo(
    () => computeBounds(recipients, polygon),
    [recipients, polygon],
  );

  // Fit to bounds once on mount and whenever bounds change meaningfully.
  // padding=40 keeps pins off the card edge.
  useEffect(() => {
    if (!mapRef.current || !bounds) return;
    mapRef.current.fitBounds(bounds, { padding: 40, duration: 400, maxZoom: 11 });
  }, [bounds]);

  const onClick = useCallback((e: any) => {
    const f = e.features?.[0];
    if (!f) {
      setPopup(null);
      return;
    }
    const id = f.properties?.id;
    const r = recipients.find((x) => x.subscriber_id === id);
    if (!r || r.lon == null || r.lat == null) return;
    setPopup({ lon: r.lon, lat: r.lat, r });
  }, [recipients]);

  if (!token) {
    return (
      <section className="card p-5">
        <p className="text-wx-danger text-sm">
          NEXT_PUBLIC_MAPBOX_TOKEN missing — check-in map disabled.
        </p>
      </section>
    );
  }

  // Stat summary on the header row (matches CheckinTally vocabulary).
  const counts = recipients.reduce(
    (acc, r) => {
      const s = classify(r.response_code);
      acc[s]++;
      if (r.lon == null || r.lat == null) acc.unmapped++;
      return acc;
    },
    { safe: 0, distress: 0, other: 0, silent: 0, unmapped: 0 },
  );

  return (
    <section className="card">
      <header className="border-b border-wx-line px-4 py-2 flex flex-wrap items-center gap-3 text-xs uppercase tracking-wider text-wx-mute font-semibold">
        <span>Check-in map</span>
        <span className="text-emerald-300">✅ {counts.safe}</span>
        <span className="text-red-300">🆘 {counts.distress}</span>
        {counts.other > 0 && <span className="text-violet-300">… {counts.other}</span>}
        <span>silent {counts.silent}</span>
        {counts.unmapped > 0 && (
          <span className="text-wx-mute" title="Subscribers without a known location">
            (no pin: {counts.unmapped})
          </span>
        )}
      </header>
      <div className="h-[420px]">
        <Map
          ref={mapRef}
          mapboxAccessToken={token}
          mapStyle={styleUrl}
          initialViewState={{ longitude: -90, latitude: 35, zoom: 6 }}
          interactiveLayerIds={['recipients-pins']}
          onClick={onClick}
          style={{ width: '100%', height: '100%' }}
          cursor="default"
        >
          {polygonGeoJson && (
            <Source id="warning-polygon" type="geojson" data={polygonGeoJson}>
              <Layer id="warning-polygon-fill" type="fill" paint={POLY_FILL_PAINT} />
              <Layer id="warning-polygon-line" type="line" paint={POLY_LINE_PAINT} />
            </Source>
          )}
          <Source id="distress-halo" type="geojson" data={distressCollection}>
            <Layer id="distress-halo-circle" type="circle" paint={DISTRESS_HALO_PAINT} />
          </Source>
          <Source id="recipients" type="geojson" data={collection}>
            <Layer id="recipients-pins" type="circle" paint={CIRCLE_PAINT} />
          </Source>
          {popup && (
            <Popup
              longitude={popup.lon}
              latitude={popup.lat}
              anchor="top"
              onClose={() => setPopup(null)}
              closeOnClick={false}
              className="checkin-popup"
            >
              <div className="text-xs text-slate-100 px-1 py-1 min-w-[140px]">
                <div className="font-semibold">
                  {popup.r.display_name ?? 'subscriber'}
                </div>
                {popup.r.telegram_username && (
                  <div className="text-slate-400">@{popup.r.telegram_username}</div>
                )}
                <div className="mt-1">
                  state: <strong>{classify(popup.r.response_code)}</strong>
                </div>
                <a
                  href={`/subscribers/${popup.r.subscriber_id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-wx-accent block mt-1"
                >
                  Open subscriber →
                </a>
              </div>
            </Popup>
          )}
        </Map>
      </div>
    </section>
  );
}
