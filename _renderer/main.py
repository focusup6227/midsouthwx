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
from ero import router as ero_router
from glm import router as glm_router
from mesh import router as mesh_router
from model_render import router as model_router
from sounding import router as sounding_router
from polar import PYART_FIELDS, _enumerate_sweeps, build_geojson
from raster_render import build_raster
from radar_io import download_volume, find_latest_volume, list_volumes_since, read_volume
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

# Model fields (forecast side): NOMADS GRIB2 subset → matplotlib PNG for the
# dashboard's /forecast/data Models panel. Self-auths via the RENDERER_TOKEN
# bearer. Renders are cached in Supabase Storage by model/field/fhr/region/cycle.
app.include_router(model_router)

# Forecast Skew-T soundings (GFS/NAM column → MetPy skew-T). Same auth + cache.
app.include_router(sounding_router)

# MRMS MESH hail-swath overlay (30/60/120 min windows). Same auth + cache.
app.include_router(mesh_router)

# WPC Excessive Rainfall Outlook Day 1 (shapefile -> GeoJSON). Same auth + cache.
app.include_router(ero_router)

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
    product: Literal["refl", "vel", "srm", "sw", "cc", "zdr", "kdp"]
    format: Literal["png", "geojson"] = "geojson"
    sweep_index: int = 0
    composite: bool = False
    force: bool = False
    # Render a specific archived volume (S3 key from /volumes) instead of the
    # latest scan — the dashboard's Level II loop prefetches these.
    volume_key: Optional[str] = None
    # Storm motion in m/s east/north components — required for product 'srm';
    # quantized to whole m/s for cache keying.
    storm_u: Optional[float] = None
    storm_v: Optional[float] = None


class VolumesRequest(BaseModel):
    site: str = Field(min_length=4, max_length=4)
    window_minutes: int = Field(default=60, ge=5, le=180)


class RenderResponse(BaseModel):
    site: str
    product: str
    scan_time: str
    image_url: Optional[str] = None
    geojson_url: Optional[str] = None
    # Quantized value-grid sidecar for PNG renders (gzipped uint8; 0 = no
    # data, 1..255 spans vmin..vmax on the same bounds). Lets the dashboard
    # keep the pointer readout in PNG mode.
    values_url: Optional[str] = None
    values_w: Optional[int] = None
    values_h: Optional[int] = None
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


@app.post("/volumes")
async def volumes(req: VolumesRequest, authorization: str = Header(default="")) -> dict:
    """List recent Level II volumes for a site so the dashboard can build a
    hi-res loop: render each key via /render {volume_key}, oldest→newest."""
    if not RENDERER_TOKEN or authorization != f"Bearer {RENDERER_TOKEN}":
        raise HTTPException(status_code=401, detail="unauthorized")
    from datetime import datetime, timedelta, timezone

    since = datetime.now(timezone.utc) - timedelta(minutes=req.window_minutes)
    try:
        vols = await asyncio.to_thread(list_volumes_since, req.site.upper(), since)
    except Exception as e:
        log.exception("list_volumes_since failed")
        raise HTTPException(status_code=502, detail=f"s3_list_failed: {e}")
    return {
        "site": req.site.upper(),
        "volumes": [
            {"key": key, "scan_time": t.isoformat()} for key, t in vols
        ],
    }


@app.post("/render", response_model=RenderResponse)
async def render(req: RenderRequest, authorization: str = Header(default="")) -> RenderResponse:
    if not RENDERER_TOKEN or authorization != f"Bearer {RENDERER_TOKEN}":
        raise HTTPException(status_code=401, detail="unauthorized")

    started = time.time()
    site = req.site.upper()

    # 1. Resolve the volume: an explicit archived key (Level II loop prefetch)
    # or the latest scan via THREDDS latest.xml. ~100-500 ms — wrapped in
    # to_thread because find_latest_volume uses sync httpx and would
    # otherwise block the asyncio event loop for every request.
    if req.volume_key:
        from radar_io import _parse_scan_time

        s3_key = req.volume_key
        try:
            scan_time = _parse_scan_time(s3_key)
        except Exception:
            raise HTTPException(status_code=400, detail="bad_volume_key")
    else:
        try:
            s3_key, scan_time = await asyncio.to_thread(find_latest_volume, site)
        except Exception as e:
            log.exception("find_latest_volume failed")
            raise HTTPException(status_code=502, detail=f"s3_lookup_failed: {e}")

    cache_id = _cache_id(site, req.product, scan_time, req.sweep_index,
                         req.composite, req.format, _cache_extra(req))
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

        # KDP isn't a raw Level II moment — it's retrieved from differential
        # phase (PHIDP). _ensure_kdp extracts the requested tilt and runs the
        # retrieval on just that sweep (full-volume is minutes); it returns a
        # single-sweep radar, so we render its sweep 0 below.
        build_sweep_index = req.sweep_index
        full_sweeps: list[dict] | None = None
        actual_sweep_index: int | None = None
        if req.product == "kdp":
            try:
                radar = await asyncio.to_thread(_ensure_kdp, radar, req.sweep_index)
                build_sweep_index = 0
            except Exception as e:
                log.exception("kdp retrieval failed")
                with suppress(OSError):
                    os.remove(local_path)
                raise HTTPException(status_code=502, detail=f"kdp_failed: {e}")
        elif req.product in ("vel", "srm"):
            # Dealias (and for SRM, subtract storm motion) on just the target
            # sweep — full-volume dealiasing is prohibitively slow, same story
            # as KDP. Preserve the full volume's sweep list for the dashboard
            # tilt picker since the extracted radar only has one sweep.
            try:
                full_sweeps = _enumerate_sweeps(radar, "velocity")
                radar, actual_sweep_index = await asyncio.to_thread(
                    _ensure_velocity, radar, req.sweep_index,
                    req.product, req.storm_u, req.storm_v,
                )
                build_sweep_index = 0
            except Exception as e:
                log.exception("velocity processing failed")
                with suppress(OSError):
                    os.remove(local_path)
                raise HTTPException(status_code=502, detail=f"velocity_failed: {e}")

        values_body: bytes | None = None
        try:
            async with _render_semaphore:
                if req.format == "geojson":
                    body, meta = await asyncio.to_thread(
                        build_geojson, radar, req.product, build_sweep_index, req.composite,
                    )
                    # Supabase Storage's default bucket allowlist excludes
                    # application/geo+json; the body is gzipped GeoJSON so
                    # application/gzip is both accurate and accepted. The
                    # dashboard pipes the raw body through DecompressionStream
                    # so the upstream Content-Type is irrelevant to clients.
                    content_type = "application/gzip"
                else:
                    body, values_body, meta = await asyncio.to_thread(
                        build_raster, radar, req.product, build_sweep_index, req.composite,
                    )
                    content_type = "image/png"
                    meta["count"] = None
                # Single-sweep extraction (vel/srm) collapses the sweep list —
                # restore the full volume's so the tilt picker keeps working.
                if full_sweeps is not None:
                    meta["sweeps"] = full_sweeps
                if actual_sweep_index is not None:
                    meta["sweep_index"] = actual_sweep_index
        finally:
            with suppress(OSError):
                os.remove(local_path)

        # 5. Upload asset (+ value-grid sidecar for PNG) + metadata. Metadata
        # goes last — its presence is what makes a cache hit, so the assets it
        # points at must already exist.
        try:
            await upload(asset_path, body, content_type)
            if values_body is not None:
                values_path = f"{cache_id}.values.gz"
                await upload(values_path, values_body, "application/gzip")
                meta["values_path"] = values_path
            await upload_metadata(meta_path, meta)
        except Exception as e:
            log.exception("upload failed")
            raise HTTPException(status_code=502, detail=f"upload_failed: {e}")

    # Cleanup locks for keys we no longer expect to see. Cheap dict op.
    if len(_render_locks) > 200:
        _render_locks.clear()

    return _response(req, scan_time, meta, asset_path,
                     cached=False, started=started)


def _ensure_velocity(radar, sweep_index: int, product: str,
                     storm_u: float | None, storm_v: float | None):
    """Extract the target sweep, dealias its velocity, and (for 'srm')
    subtract the storm-motion radial component.

    Returns (single-sweep radar, actual sweep index rendered). Dealiasing
    failures fall back to the raw field — a folded display beats a 502 during
    an event. For 'srm' the derived field is 'storm_relative_velocity';
    without a motion vector SRM degrades to plain dealiased velocity.
    """
    import numpy as np
    import pyart

    # Pick a sweep that actually carries velocity (VCP surveillance cuts are
    # refl-only) — mirrors polar.build_geojson's fallback, but must happen
    # before extraction.
    valid = [m["index"] for m in _enumerate_sweeps(radar, "velocity")]
    idx = sweep_index if sweep_index in valid else (valid[0] if valid else 0)
    sub = radar.extract_sweeps([idx])

    try:
        dealiased = pyart.correct.dealias_region_based(sub, vel_field="velocity")
        sub.add_field("velocity", dealiased, replace_existing=True)
    except Exception:
        log.warning("dealias failed for sweep %s — rendering raw velocity", idx, exc_info=True)

    if product == "srm":
        vel = sub.fields["velocity"]["data"]
        u = float(storm_u or 0.0)
        v = float(storm_v or 0.0)
        az = np.radians(np.asarray(sub.azimuth["data"], dtype=np.float64))
        elev = np.radians(np.asarray(sub.elevation["data"], dtype=np.float64))
        # Radial component of the storm motion along each ray.
        vr_storm = (u * np.sin(az) + v * np.cos(az)) * np.cos(elev)
        srm = vel - vr_storm[:, None]
        sub.add_field(
            "storm_relative_velocity",
            {
                "data": srm,
                "units": "m/s",
                "long_name": "Storm-relative radial velocity",
                "standard_name": "storm_relative_velocity",
            },
            replace_existing=True,
        )
    return sub, idx


def _cache_extra(req: "RenderRequest") -> str:
    """Cache-key salt for parameterized/derived products.

    'v2' on vel/srm invalidates pre-dealiasing cached renders; SRM also keys
    on the storm-motion vector quantized to whole m/s.
    """
    if req.product == "vel":
        return "v2"
    if req.product == "srm":
        return f"v2u{round(req.storm_u or 0.0)}v{round(req.storm_v or 0.0)}"
    return ""


def _ensure_kdp(radar, sweep_index: int):
    """Return a single-sweep radar with a retrieved KDP field.

    NEXRAD Level II ships differential phase (PHIDP) but not KDP; KDP is the
    range-derivative of PHIDP and must be retrieved. Py-ART's Maesaka
    linear-programming estimator is the standard — but it's iterative and
    running it on the full ~14-sweep volume takes minutes (and times out). We
    only ever render one tilt, so extract just the requested sweep first; the
    retrieval then runs on ~1/14th the gates and finishes in seconds. The
    returned radar has a single sweep (index 0), so the caller renders sweep 0.
    """
    import pyart

    n = int(radar.nsweeps)
    idx = sweep_index if 0 <= sweep_index < n else 0
    sub = radar.extract_sweeps([idx])
    if "specific_differential_phase" not in sub.fields:
        kdp_dict, _filtered_phidp, _phidp_r = pyart.retrieve.kdp_maesaka(sub)
        sub.add_field("specific_differential_phase", kdp_dict, replace_existing=True)
    return sub


def _response(req: RenderRequest, scan_time, meta: dict, asset_path: str,
              *, cached: bool, started: float) -> RenderResponse:
    url = public_url(asset_path)
    values_path = meta.get("values_path")
    return RenderResponse(
        site=req.site.upper(),
        product=req.product,
        scan_time=scan_time.isoformat() if not isinstance(scan_time, str) else scan_time,
        image_url=url if req.format == "png" else None,
        geojson_url=url if req.format == "geojson" else None,
        values_url=public_url(values_path) if values_path else None,
        values_w=meta.get("values_w"),
        values_h=meta.get("values_h"),
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
              composite: bool, format: str, extra: str = "") -> str:
    ts = scan_time.isoformat() if not isinstance(scan_time, str) else scan_time
    raw = f"{site}|{product}|{ts}|{sweep_index}|{composite}|{format}|{extra}"
    h = hashlib.sha1(raw.encode("utf-8")).hexdigest()[:10]
    # Group by site/date so Storage browser stays organized.
    safe_ts = ts.replace(":", "").replace("-", "").replace("+", "_")
    return f"{site}/{safe_ts}/{product}_{sweep_index}_{int(composite)}_{format}_{h}"


def _asset_path(cache_id: str, format: str) -> str:
    if format == "geojson":
        return f"{cache_id}.geojson.gz"
    return f"{cache_id}.png"
