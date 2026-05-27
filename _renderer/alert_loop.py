# Alert-loop MP4 endpoint — drop-in for the sibling midsouthwx-radar-renderer
# repo (Fly.io). NOT loaded by this Next.js app; the leading underscore in
# _renderer/ keeps Next from picking it up as a route.
#
# What this serves:
#   POST /alert-loop   (bearer auth via RENDERER_TOKEN)
#     {
#       "alert_id":       "<uuid>",
#       "event":          "Tornado Warning",
#       "polygon":        { GeoJSON Polygon|MultiPolygon },
#       "site":           "KNQA",                # 4-letter NEXRAD code
#       "window_minutes": 30                     # default
#     }
#   -> { "url": ".../alert-snapshots/<path>.mp4",
#        "cached": false,
#        "render_ms": 24310,
#        "frames_rendered": 6 }
#
# Approach:
#   1. List Level II volumes for `site` over the last `window_minutes`.
#   2. Fetch a Mapbox dark basemap for the polygon bbox (one shared image).
#   3. For each volume: download, parse, render reflectivity polygons over the
#      basemap, overlay warning polygon outline + timestamp → PNG frame.
#   4. Stitch frames via ffmpeg → h264 MP4 (yuv420p, faststart) — Telegram
#      auto-loops `sendAnimation`-typed videos in clients.
#   5. Upload to the alert-snapshots bucket (already public-read).
#
# Integration in main.py:
#   from alert_loop import router as alert_loop_router
#   app.include_router(alert_loop_router)
#
# Required env vars (in addition to what alert_snapshot.py + storage.py need):
#   ffmpeg installed in the container (Dockerfile apt-get).

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import subprocess
import tempfile
import time
import urllib.parse
from contextlib import suppress
from io import BytesIO
from typing import Optional

import httpx
import numpy as np
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.collections import PolyCollection
from matplotlib.colors import LinearSegmentedColormap, Normalize
from PIL import Image

from polar import (
    COLOR_RANGES,
    MASK_THRESHOLDS,
    MAX_RENDER_RANGE_M,
    PYART_FIELDS,
    _extract_sweep,
    _gate_range_bounds,
    _ray_az_bounds,
)
from radar_io import download_volume, list_volumes_since, read_volume
from storage import SUPABASE_URL, SERVICE_KEY  # type: ignore

log = logging.getLogger("alert_loop")
router = APIRouter()

RENDERER_TOKEN = os.environ.get("RENDERER_TOKEN", "")
MAPBOX_TOKEN = os.environ.get("MAPBOX_STATIC_TOKEN", "")
LOOP_BUCKET = os.environ.get("ALERT_LOOP_BUCKET", "alert-snapshots")

# Tuned for "fast enough to land before the next worker cron tick (60 s)" on
# a warm Fly machine, while still showing enough storm evolution to be useful.
# 6 frames at 4 fps = a 1.5 s loop that Telegram auto-replays.
LOOP_WIDTH = 720
LOOP_HEIGHT = 540
LOOP_FPS = 4
MAX_FRAMES = 6
WINDOW_MINUTES_DEFAULT = 30

# Reflectivity colormap mirrors png_render.py so the loop frames look like the
# live radar page the operator already trusts.
_REFL_CMAP = LinearSegmentedColormap.from_list("refl", [
    (0.00, "#3b82f6"),
    (0.20, "#22d3ee"),
    (0.35, "#10b981"),
    (0.50, "#84cc16"),
    (0.65, "#facc15"),
    (0.80, "#f97316"),
    (0.92, "#ef4444"),
    (1.00, "#d946ef"),
])

# Only one loop renders at a time. Each holds 6 radar volumes in memory before
# emitting frames, so we serialize hard rather than competing with /render.
_loop_semaphore = asyncio.Semaphore(1)


# ---------- request/response ----------

class AlertLoopRequest(BaseModel):
    alert_id: str = Field(min_length=1, max_length=128)
    event: str = Field(min_length=1, max_length=128)
    polygon: dict
    site: str = Field(min_length=4, max_length=4)
    window_minutes: int = Field(default=WINDOW_MINUTES_DEFAULT, ge=5, le=120)
    force: bool = False


class AlertLoopResponse(BaseModel):
    url: str
    cached: bool
    render_ms: int
    frames_rendered: int


# ---------- geometry helpers ----------

def _polygon_bbox(polygon: dict, padding_frac: float = 0.25) -> tuple[float, float, float, float]:
    """Return (minlon, minlat, maxlon, maxlat) with padding."""
    coords: list[list[float]] = []
    geom_type = polygon.get("type", "")
    if geom_type == "Polygon":
        for ring in polygon["coordinates"]:
            coords.extend(ring)
    elif geom_type == "MultiPolygon":
        for poly in polygon["coordinates"]:
            for ring in poly:
                coords.extend(ring)
    else:
        raise HTTPException(status_code=400, detail=f"unsupported geometry type: {geom_type}")
    if not coords:
        raise HTTPException(status_code=400, detail="polygon has no coordinates")
    lons = [c[0] for c in coords]
    lats = [c[1] for c in coords]
    minx, maxx = min(lons), max(lons)
    miny, maxy = min(lats), max(lats)
    dx = max((maxx - minx) * padding_frac, 0.05)
    dy = max((maxy - miny) * padding_frac, 0.05)
    return (minx - dx, miny - dy, maxx + dx, maxy + dy)


def _polygon_rings(polygon: dict) -> list[list[list[float]]]:
    """Flatten a Polygon/MultiPolygon to a list of exterior rings."""
    geom_type = polygon.get("type", "")
    if geom_type == "Polygon":
        return [polygon["coordinates"][0]]
    if geom_type == "MultiPolygon":
        return [poly[0] for poly in polygon["coordinates"]]
    return []


# ---------- basemap ----------

async def _fetch_basemap(bbox: tuple[float, float, float, float]) -> Image.Image:
    """One Mapbox Static fetch per loop, reused as the backdrop for every
    frame. We pin the bbox exactly so radar polygons align by lon/lat."""
    if not MAPBOX_TOKEN:
        raise HTTPException(status_code=500, detail="mapbox_token_missing")
    bbox_str = f"[{bbox[0]},{bbox[1]},{bbox[2]},{bbox[3]}]"
    url = (
        f"https://api.mapbox.com/styles/v1/mapbox/dark-v11/static/"
        f"{bbox_str}/{LOOP_WIDTH}x{LOOP_HEIGHT}@2x"
        f"?access_token={MAPBOX_TOKEN}&logo=false&attribution=false"
    )
    async with httpx.AsyncClient(timeout=10.0) as client:
        r = await client.get(url)
        if r.status_code != 200:
            raise HTTPException(
                status_code=502,
                detail=f"basemap_{r.status_code}: {r.text[:200]}",
            )
        return Image.open(BytesIO(r.content)).convert("RGBA")


# ---------- frame rendering ----------

def _render_frame(
    radar,
    bbox: tuple[float, float, float, float],
    basemap_rgba: np.ndarray,
    warning_rings: list[list[list[float]]],
    scan_time_iso: str,
) -> Image.Image:
    """Render one frame: basemap → reflectivity polygons clipped to bbox →
    warning-polygon outline → timestamp label. Returns RGB Image (no alpha,
    so ffmpeg's yuv420p has no edge-case to worry about)."""
    field = PYART_FIELDS["refl"]
    vmin, vmax = COLOR_RANGES["refl"]
    threshold = MASK_THRESHOLDS["refl"]

    site_lat = float(radar.latitude["data"][0])
    site_lon = float(radar.longitude["data"][0])

    # Lowest sweep is the surface-rain layer the operator looks at on the
    # live radar; matches /radar's default sweep_index=0.
    data, az = _extract_sweep(radar, field, 0)
    ranges_full = np.asarray(radar.range["data"], dtype=np.float64)
    in_range = ranges_full <= MAX_RENDER_RANGE_M
    ranges = ranges_full[in_range]
    if data.shape[1] > len(ranges):
        data = data[:, : len(ranges)]
    order = np.argsort(az)
    az = az[order]
    data = data[order, :]

    if data.size == 0:
        return _basemap_only_frame(basemap_rgba, bbox, warning_rings, scan_time_iso)

    az_low, az_high = _ray_az_bounds(az)
    r_low, r_high = _gate_range_bounds(ranges)

    raw = np.asarray(data, dtype=np.float64)
    mask = (
        np.ma.getmaskarray(data).astype(bool) if hasattr(data, "mask") else np.zeros_like(raw, dtype=bool)
    )
    if threshold is not None:
        mask |= raw < threshold
    mask |= ~np.isfinite(raw)
    valid_idx = np.argwhere(~mask)
    if len(valid_idx) == 0:
        return _basemap_only_frame(basemap_rgba, bbox, warning_rings, scan_time_iso)

    ri = valid_idx[:, 0]
    gi = valid_idx[:, 1]
    sin_low = np.sin(np.radians(az_low[ri]))
    cos_low = np.cos(np.radians(az_low[ri]))
    sin_high = np.sin(np.radians(az_high[ri]))
    cos_high = np.cos(np.radians(az_high[ri]))
    rl_km = r_low[gi] / 1000.0
    rh_km = r_high[gi] / 1000.0

    cos_site_lat = np.cos(np.radians(site_lat))
    lat_per_km = 1.0 / 111.0
    lon_per_km = 1.0 / (111.0 * cos_site_lat) if cos_site_lat > 1e-9 else 0.0

    lon_a = site_lon + rl_km * sin_low * lon_per_km
    lat_a = site_lat + rl_km * cos_low * lat_per_km
    lon_b = site_lon + rh_km * sin_low * lon_per_km
    lat_b = site_lat + rh_km * cos_low * lat_per_km
    lon_c = site_lon + rh_km * sin_high * lon_per_km
    lat_c = site_lat + rh_km * cos_high * lat_per_km
    lon_d = site_lon + rl_km * sin_high * lon_per_km
    lat_d = site_lat + rl_km * cos_high * lat_per_km

    # Clip polygons to the bbox before stacking — radar covers ~230 km but the
    # warning bbox is usually 50-100 km on a side, so we drop 80%+ of polygons
    # before they hit matplotlib. Big speedup on PolyCollection construction.
    in_bbox = (
        (lon_a >= bbox[0]) & (lon_a <= bbox[2]) & (lat_a >= bbox[1]) & (lat_a <= bbox[3])
    ) | (
        (lon_c >= bbox[0]) & (lon_c <= bbox[2]) & (lat_c >= bbox[1]) & (lat_c <= bbox[3])
    )
    if not in_bbox.any():
        return _basemap_only_frame(basemap_rgba, bbox, warning_rings, scan_time_iso)

    lon_a, lat_a = lon_a[in_bbox], lat_a[in_bbox]
    lon_b, lat_b = lon_b[in_bbox], lat_b[in_bbox]
    lon_c, lat_c = lon_c[in_bbox], lat_c[in_bbox]
    lon_d, lat_d = lon_d[in_bbox], lat_d[in_bbox]
    values = raw[ri, gi][in_bbox]

    verts = np.stack([
        np.stack([lon_a, lat_a], axis=-1),
        np.stack([lon_b, lat_b], axis=-1),
        np.stack([lon_c, lat_c], axis=-1),
        np.stack([lon_d, lat_d], axis=-1),
    ], axis=1)

    norm = Normalize(vmin=vmin, vmax=vmax)

    fig = plt.figure(figsize=(LOOP_WIDTH / 100, LOOP_HEIGHT / 100), dpi=100)
    ax = fig.add_axes((0, 0, 1, 1))
    ax.set_xlim(bbox[0], bbox[2])
    ax.set_ylim(bbox[1], bbox[3])
    ax.set_axis_off()

    # Basemap first (drawn at z=0), then radar polygons at z=1, then warning
    # outline at z=2, then timestamp at z=3.
    ax.imshow(
        basemap_rgba,
        extent=(bbox[0], bbox[2], bbox[1], bbox[3]),
        origin="upper",
        zorder=0,
    )

    pc = PolyCollection(
        verts, array=values, cmap=_REFL_CMAP, norm=norm,
        edgecolors="none", alpha=0.75, zorder=1,
    )
    ax.add_collection(pc)

    for ring in warning_rings:
        if len(ring) < 2:
            continue
        rx = [p[0] for p in ring]
        ry = [p[1] for p in ring]
        ax.plot(rx, ry, color="#fbbf24", linewidth=2.5, zorder=2)

    ax.text(
        0.02, 0.97, scan_time_iso, transform=ax.transAxes,
        fontsize=10, color="#fafafa", fontfamily="monospace",
        bbox={"facecolor": "#0b1220", "alpha": 0.75, "pad": 4, "edgecolor": "none"},
        verticalalignment="top", zorder=3,
    )

    buf = BytesIO()
    fig.savefig(buf, format="png", dpi=100)
    plt.close(fig)
    buf.seek(0)
    return Image.open(buf).convert("RGB")


def _basemap_only_frame(
    basemap_rgba: np.ndarray,
    bbox: tuple[float, float, float, float],
    warning_rings: list[list[list[float]]],
    scan_time_iso: str,
) -> Image.Image:
    """Fallback frame when a volume has no usable reflectivity in the bbox —
    we still want it in the loop so the timestamp progression is continuous."""
    fig = plt.figure(figsize=(LOOP_WIDTH / 100, LOOP_HEIGHT / 100), dpi=100)
    ax = fig.add_axes((0, 0, 1, 1))
    ax.set_xlim(bbox[0], bbox[2])
    ax.set_ylim(bbox[1], bbox[3])
    ax.set_axis_off()
    ax.imshow(basemap_rgba, extent=(bbox[0], bbox[2], bbox[1], bbox[3]), origin="upper")
    for ring in warning_rings:
        rx = [p[0] for p in ring]
        ry = [p[1] for p in ring]
        ax.plot(rx, ry, color="#fbbf24", linewidth=2.5)
    ax.text(
        0.02, 0.97, scan_time_iso, transform=ax.transAxes,
        fontsize=10, color="#fafafa", fontfamily="monospace",
        bbox={"facecolor": "#0b1220", "alpha": 0.75, "pad": 4, "edgecolor": "none"},
        verticalalignment="top",
    )
    buf = BytesIO()
    fig.savefig(buf, format="png", dpi=100)
    plt.close(fig)
    buf.seek(0)
    return Image.open(buf).convert("RGB")


# ---------- ffmpeg ----------

async def _build_mp4(frames: list[Image.Image]) -> bytes:
    """Stitch frames into an h264 MP4 with yuv420p + faststart for max client
    compatibility (Telegram, iOS, etc)."""
    with tempfile.TemporaryDirectory() as tmpdir:
        for i, frame in enumerate(frames):
            frame.save(os.path.join(tmpdir, f"f{i:03d}.png"))
        out_path = os.path.join(tmpdir, "loop.mp4")
        cmd = [
            "ffmpeg", "-y", "-loglevel", "error",
            "-framerate", str(LOOP_FPS),
            "-i", os.path.join(tmpdir, "f%03d.png"),
            "-c:v", "libx264",
            "-pix_fmt", "yuv420p",
            "-movflags", "+faststart",
            # Width MUST be even for yuv420p — pad if odd. Our LOOP_WIDTH is
            # already 720, but the safeguard keeps us defensive against future
            # resolution tweaks.
            "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2",
            out_path,
        ]
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await proc.communicate()
        if proc.returncode != 0:
            raise RuntimeError(f"ffmpeg failed (rc={proc.returncode}): {stderr.decode()[:300]}")
        with open(out_path, "rb") as f:
            return f.read()


# ---------- storage helpers (bucket-scoped, no shared mutable state) ----------

def _public_url(path: str) -> str:
    return f"{SUPABASE_URL}/storage/v1/object/public/{LOOP_BUCKET}/{path}"


def _object_url(path: str) -> str:
    return f"{SUPABASE_URL}/storage/v1/object/{LOOP_BUCKET}/{path}"


async def _upload_mp4(path: str, body: bytes) -> str:
    headers = {
        "Authorization": f"Bearer {SERVICE_KEY}",
        "apikey": SERVICE_KEY,
        "Content-Type": "video/mp4",
        "x-upsert": "true",
        "Cache-Control": "public, max-age=31536000, immutable",
    }
    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.post(_object_url(path), content=body, headers=headers)
        if r.status_code >= 400:
            raise RuntimeError(f"supabase upload {r.status_code}: {r.text[:300]}")
    return _public_url(path)


async def _head_exists(path: str) -> bool:
    async with httpx.AsyncClient(timeout=5.0) as client:
        try:
            r = await client.head(_public_url(path))
            return r.status_code == 200
        except httpx.HTTPError:
            return False


# ---------- endpoint ----------

@router.post("/alert-loop", response_model=AlertLoopResponse)
async def alert_loop(
    req: AlertLoopRequest,
    authorization: str = Header(default=""),
) -> AlertLoopResponse:
    if not RENDERER_TOKEN or authorization != f"Bearer {RENDERER_TOKEN}":
        raise HTTPException(status_code=401, detail="unauthorized")

    started = time.time()
    bbox = _polygon_bbox(req.polygon)
    warning_rings = _polygon_rings(req.polygon)

    # Cache key includes window so a re-render after the window slides forward
    # produces a fresh asset.
    from datetime import datetime, timedelta, timezone
    since = datetime.now(timezone.utc) - timedelta(minutes=req.window_minutes)
    # 5-minute cache granularity for the "since" component — within one scan
    # period, repeated requests share the same MP4.
    since_bucket = since.replace(second=0, microsecond=0)
    since_bucket = since_bucket.replace(minute=(since_bucket.minute // 5) * 5)
    cache_seed = json.dumps({
        "polygon": req.polygon,
        "site": req.site.upper(),
        "since_bucket": since_bucket.isoformat(),
    }, sort_keys=True)
    cache_hash = hashlib.sha1(cache_seed.encode()).hexdigest()[:12]
    asset_path = f"{req.alert_id}/loop_{cache_hash}.mp4"

    if not req.force and await _head_exists(asset_path):
        return AlertLoopResponse(
            url=_public_url(asset_path),
            cached=True,
            render_ms=int((time.time() - started) * 1000),
            frames_rendered=0,
        )

    # List recent volumes; cap to MAX_FRAMES from the tail so we always show
    # the latest data even when the window covered more scans than we render.
    volumes = await asyncio.to_thread(list_volumes_since, req.site.upper(), since)
    if len(volumes) == 0:
        raise HTTPException(status_code=502, detail="no_volumes_in_window")
    volumes = volumes[-MAX_FRAMES:]

    # Serialize loop renders — each holds multiple radar volumes in RAM.
    async with _loop_semaphore:
        # Re-check cache inside semaphore in case a peer just finished.
        if not req.force and await _head_exists(asset_path):
            return AlertLoopResponse(
                url=_public_url(asset_path),
                cached=True,
                render_ms=int((time.time() - started) * 1000),
                frames_rendered=0,
            )

        try:
            basemap_img = await _fetch_basemap(bbox)
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"basemap_fetch_failed: {e}")
        basemap_rgba = np.asarray(basemap_img)

        frames: list[Image.Image] = []
        for url_path, scan_time in volumes:
            local_path: Optional[str] = None
            try:
                local_path = await asyncio.to_thread(download_volume, url_path)
                radar = await asyncio.to_thread(read_volume, local_path)
                scan_iso = scan_time.strftime("%H:%MZ")
                frame = await asyncio.to_thread(
                    _render_frame, radar, bbox, basemap_rgba, warning_rings, scan_iso,
                )
                frames.append(frame)
            except Exception as e:
                # Per-volume failure: skip and continue. A loop with 4 frames
                # instead of 6 still works.
                log.warning("frame %s failed: %s", url_path, e)
                continue
            finally:
                if local_path:
                    with suppress(OSError):
                        os.remove(local_path)

        if len(frames) < 2:
            raise HTTPException(status_code=502, detail=f"too_few_frames: {len(frames)}")

        try:
            mp4_bytes = await _build_mp4(frames)
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"ffmpeg_failed: {e}")

        url = await _upload_mp4(asset_path, mp4_bytes)

    return AlertLoopResponse(
        url=url,
        cached=False,
        render_ms=int((time.time() - started) * 1000),
        frames_rendered=len(frames),
    )
