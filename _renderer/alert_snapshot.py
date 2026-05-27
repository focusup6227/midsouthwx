# Alert-snapshot PNG endpoint — drop-in for the sibling midsouthwx-radar-renderer
# repo (Fly.io). NOT loaded by this Next.js app; the leading underscore in
# _renderer/ keeps Next from picking it up as a route.
#
# What this serves:
#   POST /alert-snapshot   (bearer auth via RENDERER_TOKEN)
#     {
#       "alert_id":  "<uuid>",
#       "event":     "Tornado Warning",
#       "polygon":   { GeoJSON Polygon|MultiPolygon },
#       "observed":  [ [lon,lat], [lon,lat], ... ],   # past storm positions, optional
#       "forecast":  [ [lon,lat], [lon,lat] ],        # projected line, optional
#     }
#   -> { "url": "https://.../alert-snapshots/<path>.png",
#        "cached": false, "render_ms": 1240 }
#
# Approach:
#   1. Build a simplestyle-spec GeoJSON FeatureCollection (polygon + track lines).
#   2. Hit Mapbox Static Images API with `geojson(...)` overlay on dark-v11
#      basemap (state/county labels, roads). `auto` placement auto-fits.
#   3. Upload the returned PNG to Supabase Storage (`alert-snapshots` bucket).
#   4. Return the public URL. The nws-dispatcher writes it to messages.media_url
#      and the send worker switches to sendPhoto with the message body as
#      caption — no further work in the dashboard.
#
# How to integrate in the renderer app (main.py):
#   from alert_snapshot import router as alert_snapshot_router
#   app.include_router(alert_snapshot_router)
#
# Required env vars (in addition to what storage.py already needs):
#   MAPBOX_STATIC_TOKEN  — server-side Mapbox token. Distinct from the
#                          frontend NEXT_PUBLIC_MAPBOX_TOKEN so it can be
#                          scoped to Static Images API only and rotated
#                          independently.
#   RENDERER_TOKEN       — already set; same bearer used by /render.
#
# No new pip deps — httpx is already in requirements.txt for the radar path.

from __future__ import annotations

import hashlib
import json
import logging
import os
import time
import urllib.parse
from typing import Literal, Optional

import httpx
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field

# storage.py is the existing module in this repo. We call the bucket-aware
# wrappers below since the radar pipeline uses `radar-tiles` and alert
# snapshots go to a separate `alert-snapshots` bucket.
from storage import SUPABASE_URL, SERVICE_KEY  # type: ignore

log = logging.getLogger("alert_snapshot")

router = APIRouter()

RENDERER_TOKEN = os.environ.get("RENDERER_TOKEN", "")
MAPBOX_TOKEN = os.environ.get("MAPBOX_STATIC_TOKEN", "")
SNAPSHOT_BUCKET = os.environ.get("ALERT_SNAPSHOT_BUCKET", "alert-snapshots")

# dark-v11 matches the dashboard's radar style — operator looking at both
# screens sees the same basemap colors. Reasonable size for Telegram preview.
MAPBOX_STYLE = "mapbox/dark-v11"
SNAP_WIDTH = 800
SNAP_HEIGHT = 600
MAPBOX_URL_LIMIT = 8000   # Mapbox Static URL hard limit ≈ 8192 chars
HTTP_TIMEOUT = 20.0


# ---------- request/response models ----------

class TrackPoint(BaseModel):
    lon: float
    lat: float


class AlertSnapshotRequest(BaseModel):
    alert_id: str = Field(min_length=1, max_length=128)
    event: str = Field(min_length=1, max_length=128)
    polygon: dict  # GeoJSON geometry (Polygon | MultiPolygon)
    observed: list[list[float]] = Field(default_factory=list)
    forecast: list[list[float]] = Field(default_factory=list)
    force: bool = False


class AlertSnapshotResponse(BaseModel):
    url: str
    cached: bool
    render_ms: int


# ---------- color choice per hazard ----------

def _event_palette(event: str) -> dict[str, str]:
    """Return simplestyle properties for the warning polygon, by hazard."""
    e = event.lower()
    if "tornado" in e:
        return {"fill": "#dc2626", "stroke": "#fecaca"}      # red
    if "flash flood" in e or "flood" in e:
        return {"fill": "#16a34a", "stroke": "#bbf7d0"}      # green
    if "severe thunderstorm" in e or "thunderstorm" in e:
        return {"fill": "#ea580c", "stroke": "#fed7aa"}      # orange
    if "special marine" in e or "marine" in e:
        return {"fill": "#0ea5e9", "stroke": "#bae6fd"}      # blue
    return {"fill": "#475569", "stroke": "#cbd5e1"}          # slate


# ---------- geojson assembly ----------

def _build_feature_collection(
    polygon: dict,
    observed: list[list[float]],
    forecast: list[list[float]],
    event: str,
) -> dict:
    palette = _event_palette(event)
    features: list[dict] = [{
        "type": "Feature",
        "geometry": polygon,
        "properties": {
            "fill": palette["fill"],
            "fill-opacity": 0.35,
            "stroke": palette["stroke"],
            "stroke-width": 2,
            "stroke-opacity": 0.95,
        },
    }]
    if observed and len(observed) >= 2:
        features.append({
            "type": "Feature",
            "geometry": {"type": "LineString", "coordinates": observed},
            "properties": {
                "stroke": "#fcd34d",          # amber — past track
                "stroke-width": 3,
                "stroke-opacity": 0.95,
            },
        })
    if forecast and len(forecast) >= 2:
        features.append({
            "type": "Feature",
            "geometry": {"type": "LineString", "coordinates": forecast},
            "properties": {
                "stroke": "#f87171",          # red — projected
                "stroke-width": 3,
                "stroke-opacity": 1.0,
            },
        })
        # Storm position dot at the current (start of forecast) location.
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": forecast[0]},
            "properties": {
                "marker-color": "#ef4444",
                "marker-size": "medium",
                "marker-symbol": "circle",
            },
        })
    return {"type": "FeatureCollection", "features": features}


# ---------- supabase storage I/O (bucket-scoped) ----------

def _object_url(bucket: str, path: str) -> str:
    return f"{SUPABASE_URL}/storage/v1/object/{bucket}/{path}"


def _public_url(bucket: str, path: str) -> str:
    return f"{SUPABASE_URL}/storage/v1/object/public/{bucket}/{path}"


async def _upload_png(path: str, body: bytes) -> str:
    headers = {
        "Authorization": f"Bearer {SERVICE_KEY}",
        "apikey": SERVICE_KEY,
        "Content-Type": "image/png",
        "x-upsert": "true",
        # Content-addressed by geometry hash — same hash = same bytes forever.
        "Cache-Control": "public, max-age=31536000, immutable",
    }
    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.post(_object_url(SNAPSHOT_BUCKET, path),
                              content=body, headers=headers)
        if r.status_code >= 400:
            raise RuntimeError(f"supabase upload {r.status_code}: {r.text[:300]}")
    return _public_url(SNAPSHOT_BUCKET, path)


async def _head_exists(path: str) -> bool:
    """Cheap cache-hit check: HEAD the public URL. 200 == already rendered."""
    async with httpx.AsyncClient(timeout=5.0) as client:
        try:
            r = await client.head(_public_url(SNAPSHOT_BUCKET, path))
            return r.status_code == 200
        except httpx.HTTPError:
            return False


# ---------- Mapbox Static fetch ----------

async def _fetch_mapbox_static(fc: dict) -> bytes:
    if not MAPBOX_TOKEN:
        raise HTTPException(status_code=500, detail="mapbox_token_missing")

    encoded = urllib.parse.quote(
        json.dumps(fc, separators=(",", ":")),
        safe="(),:",
    )
    url = (
        f"https://api.mapbox.com/styles/v1/{MAPBOX_STYLE}/static/"
        f"geojson({encoded})/auto/{SNAP_WIDTH}x{SNAP_HEIGHT}@2x"
        f"?access_token={MAPBOX_TOKEN}&attribution=true&logo=false"
    )
    if len(url) > MAPBOX_URL_LIMIT:
        # Most NWS polygons fit; truly enormous CWA-wide polygons (rare for
        # warnings, common for watches) bust this. Caller handles by skipping
        # snapshot — we'd rather fall back to text than upload a broken PNG.
        raise HTTPException(status_code=413, detail="overlay_url_too_long")

    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        r = await client.get(url)
        if r.status_code != 200:
            raise HTTPException(
                status_code=502,
                detail=f"mapbox_static_{r.status_code}: {r.text[:200]}",
            )
        return r.content


# ---------- endpoint ----------

@router.post("/alert-snapshot", response_model=AlertSnapshotResponse)
async def alert_snapshot(
    req: AlertSnapshotRequest,
    authorization: str = Header(default=""),
) -> AlertSnapshotResponse:
    if not RENDERER_TOKEN or authorization != f"Bearer {RENDERER_TOKEN}":
        raise HTTPException(status_code=401, detail="unauthorized")

    started = time.time()
    fc = _build_feature_collection(req.polygon, req.observed, req.forecast, req.event)

    # Cache key: hash of the FeatureCollection. NWS alerts update their
    # storm track on each poll; each unique geom set gets its own snapshot.
    geom_hash = hashlib.sha1(
        json.dumps(fc, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()[:12]
    path = f"{req.alert_id}/snap_{geom_hash}.png"

    if not req.force and await _head_exists(path):
        return AlertSnapshotResponse(
            url=_public_url(SNAPSHOT_BUCKET, path),
            cached=True,
            render_ms=int((time.time() - started) * 1000),
        )

    png = await _fetch_mapbox_static(fc)
    url = await _upload_png(path, png)

    return AlertSnapshotResponse(
        url=url,
        cached=False,
        render_ms=int((time.time() - started) * 1000),
    )
