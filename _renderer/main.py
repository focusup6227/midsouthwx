"""FastAPI entrypoint for the radar renderer.

Auth: bearer token RENDERER_TOKEN. Health check: GET /healthz.

POST /render is the only real endpoint. The contract matches what the dashboard
proxies via app/api/radar/level2/[site]/route.ts:
  request body:  { site, product, format, sweep_index, composite, force }
  response:      { site, product, scan_time, image_url|geojson_url, bounds,
                    cached, render_ms, available_sweeps, sweep_index,
                    feature_count, vmin, vmax }

Renders are cached per (site, product, scan_time, sweep_index, composite, format)
in Supabase Storage. Cache hit returns the existing public URL plus metadata
without invoking Py-ART.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import time
from contextlib import suppress
from typing import Literal, Optional

from fastapi import FastAPI, Header, HTTPException, Request
from pydantic import BaseModel, Field

from alert_loop import router as alert_loop_router
from alert_snapshot import router as alert_snapshot_router
from couplet_detect import router as couplet_router
from glm import router as glm_router
from polar import build_geojson
from png_render import build_png
from radar_io import download_volume, find_latest_volume, read_volume
from storage import fetch_metadata, upload, upload_metadata, public_url

log = logging.getLogger("renderer")
logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))

RENDERER_TOKEN = os.environ.get("RENDERER_TOKEN", "")

app = FastAPI(title="midsouthwx-radar-renderer", version="2.0.0")

# GLM lightning feed (GOES-19). Self-auths via Authorization: Bearer header,
# same shape as /render — no Depends wrapper needed.
app.include_router(glm_router)

# Per-alert snapshot PNGs (warning polygon + storm track) composed via Mapbox
# Static. Self-auths via the same RENDERER_TOKEN bearer.
app.include_router(alert_snapshot_router)

# Per-alert MP4 loops (last 30 min of reflectivity over the warning polygon),
# fired async from nws-dispatcher and swapped into messages.media_url when
# ready. Long render — uses its own concurrency cap inside the module.
app.include_router(alert_loop_router)

# F9 (dashboard side): gate-to-gate velocity-couplet detector. Called by
# the dashboard's couplet-poll edge function every minute per Mid-South
# NEXRAD site; persists to public.radar_couplets with stable track IDs.
# Self-auths via the same RENDERER_TOKEN bearer.
app.include_router(couplet_router)

# In-process lock per cache key so concurrent requests for the same scan
# share one render instead of stampeding. Keyed by `cache_id`.
_render_locks: dict[str, asyncio.Lock] = {}

# Global render semaphore: caps concurrent rendering CPU/memory load.
# A super-res render holds ~600 MB of polygon dicts mid-flight; with 4 GB
# allotted we can safely run 2 in parallel and still leave headroom for
# uvicorn + asyncio + the download buffer. The per-cache_id lock above
# dedupes identical requests; this semaphore caps cross-key parallelism.
_render_semaphore = asyncio.Semaphore(2)


class RenderRequest(BaseModel):
    site: str = Field(min_length=4, max_length=4)
    product: Literal["refl", "vel", "cc"]
    format: Literal["png", "geojson"] = "geojson"
    sweep_index: int = 0
    composite: bool = False
    force: bool = False


class RenderResponse(BaseModel):
    site: str
    product: str
    scan_time: str
    image_url: Optional[str] = None
    geojson_url: Optional[str] = None
    bounds: dict
    cached: bool
    render_ms: int
    available_sweeps: list[dict]
    sweep_index: Optional[int] = None
    feature_count: Optional[int] = None
    vmin: Optional[float] = None
    vmax: Optional[float] = None


@app.get("/healthz")
def healthz() -> dict:
    return {"ok": True, "service": "midsouthwx-radar-renderer", "v": app.version}


@app.post("/render", response_model=RenderResponse)
async def render(req: RenderRequest, authorization: str = Header(default="")) -> RenderResponse:
    if not RENDERER_TOKEN or authorization != f"Bearer {RENDERER_TOKEN}":
        raise HTTPException(status_code=401, detail="unauthorized")

    started = time.time()
    site = req.site.upper()

    # 1. Find the latest scan via THREDDS latest.xml. ~100-500 ms — wrapped
    # in to_thread because find_latest_volume uses sync httpx and would
    # otherwise block the asyncio event loop for every request.
    try:
        s3_key, scan_time = await asyncio.to_thread(find_latest_volume, site)
    except Exception as e:
        log.exception("find_latest_volume failed")
        raise HTTPException(status_code=502, detail=f"s3_lookup_failed: {e}")

    cache_id = _cache_id(site, req.product, scan_time, req.sweep_index,
                         req.composite, req.format)
    asset_path = _asset_path(cache_id, req.format)
    meta_path = f"{cache_id}.meta.json"

    # 2. Try cache. Concurrent same-key requests will skip past the lock-held
    # render since the cache check is the first thing inside the lock too.
    if not req.force:
        cached = await fetch_metadata(meta_path)
        if cached:
            return _response(req, scan_time, cached, asset_path,
                             cached=True, started=started)

    # 3. Lock per cache_id so we only render once for a given scan.
    lock = _render_locks.setdefault(cache_id, asyncio.Lock())
    async with lock:
        # Re-check inside lock — another request may have populated cache.
        if not req.force:
            cached = await fetch_metadata(meta_path)
            if cached:
                return _response(req, scan_time, cached, asset_path,
                                 cached=True, started=started)

        # 4. Download + parse. CPU-bound, so push to a thread.
        try:
            local_path = await asyncio.to_thread(download_volume, s3_key)
        except Exception as e:
            log.exception("download_volume failed")
            raise HTTPException(status_code=502, detail=f"download_failed: {e}")

        try:
            radar = await asyncio.to_thread(read_volume, local_path)
        except Exception as e:
            log.exception("read_volume failed")
            with suppress(OSError):
                os.remove(local_path)
            raise HTTPException(status_code=502, detail=f"parse_failed: {e}")

        try:
            async with _render_semaphore:
                if req.format == "geojson":
                    body, meta = await asyncio.to_thread(
                        build_geojson, radar, req.product, req.sweep_index, req.composite,
                    )
                    # Supabase Storage's default bucket allowlist excludes
                    # application/geo+json; the body is gzipped GeoJSON so
                    # application/gzip is both accurate and accepted. The
                    # dashboard pipes the raw body through DecompressionStream
                    # so the upstream Content-Type is irrelevant to clients.
                    content_type = "application/gzip"
                else:
                    body, meta = await asyncio.to_thread(
                        build_png, radar, req.product, req.sweep_index, req.composite,
                    )
                    content_type = "image/png"
                    meta["count"] = None
        finally:
            with suppress(OSError):
                os.remove(local_path)

        # 5. Upload asset + metadata.
        try:
            await upload(asset_path, body, content_type)
            await upload_metadata(meta_path, meta)
        except Exception as e:
            log.exception("upload failed")
            raise HTTPException(status_code=502, detail=f"upload_failed: {e}")

    # Cleanup locks for keys we no longer expect to see. Cheap dict op.
    if len(_render_locks) > 200:
        _render_locks.clear()

    return _response(req, scan_time, meta, asset_path,
                     cached=False, started=started)


def _response(req: RenderRequest, scan_time, meta: dict, asset_path: str,
              *, cached: bool, started: float) -> RenderResponse:
    url = public_url(asset_path)
    return RenderResponse(
        site=req.site.upper(),
        product=req.product,
        scan_time=scan_time.isoformat() if not isinstance(scan_time, str) else scan_time,
        image_url=url if req.format == "png" else None,
        geojson_url=url if req.format == "geojson" else None,
        bounds=meta.get("bounds", {}),
        cached=cached,
        render_ms=int((time.time() - started) * 1000),
        available_sweeps=meta.get("sweeps", []),
        # Reflect the actual sweep rendered (may differ from requested if the
        # caller asked for a sweep without data for this product — polar.py
        # falls back to the lowest available sweep in that case).
        sweep_index=meta.get("sweep_index", req.sweep_index),
        feature_count=meta.get("count"),
        vmin=meta.get("vmin"),
        vmax=meta.get("vmax"),
    )


def _cache_id(site: str, product: str, scan_time, sweep_index: int,
              composite: bool, format: str) -> str:
    ts = scan_time.isoformat() if not isinstance(scan_time, str) else scan_time
    raw = f"{site}|{product}|{ts}|{sweep_index}|{composite}|{format}"
    h = hashlib.sha1(raw.encode("utf-8")).hexdigest()[:10]
    # Group by site/date so Storage browser stays organized.
    safe_ts = ts.replace(":", "").replace("-", "").replace("+", "_")
    return f"{site}/{safe_ts}/{product}_{sweep_index}_{int(composite)}_{format}_{h}"


def _asset_path(cache_id: str, format: str) -> str:
    if format == "geojson":
        return f"{cache_id}.geojson.gz"
    return f"{cache_id}.png"
