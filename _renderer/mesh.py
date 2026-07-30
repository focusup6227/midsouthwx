"""MRMS MESH (Maximum Estimated Size of Hail) overlay.

The old dashboard MESH layer died with its THREDDS source; this reintroduces
it from the authoritative feed: NOAA's MRMS 2D product server publishes
`MRMS_MESH_Max_{30,60,120}min.latest.grib2.gz` every ~2 minutes.

  POST /mesh   (bearer auth via RENDERER_TOKEN)
    { "window_minutes": 30 | 60 | 120 }
    -> { "image_url": "...", "bounds": {north,south,east,west},
         "valid_time": "...", "cached": bool, "render_ms": int }

The grid is cropped to the Mid-South service area before rasterizing —
the full 0.01° CONUS grid is 7000×3500 and nobody needs Maine hail here.
PNG is transparent where MESH < ~6 mm so it can layer on top of any radar
product. Cached in Supabase Storage keyed by (window, grib valid time).
"""

from __future__ import annotations

import gzip
import logging
import os
import tempfile
import time
from io import BytesIO

import httpx
import numpy as np
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field

from storage import fetch_metadata, public_url, upload, upload_metadata

log = logging.getLogger("mesh")

router = APIRouter()

RENDERER_TOKEN = os.environ.get("RENDERER_TOKEN", "")

MRMS_BASE = "https://mrms.ncep.noaa.gov/2D"

# Mid-South service area with generous margins (west, east, south, north).
BBOX = (-98.0, -80.0, 29.0, 40.0)

# Hail size ramp in millimetres → RGBA. Transparent below 6 mm (pea);
# 25 mm = 1 in (severe), 50 mm = 2 in, 100 mm = 4 in (giant).
_MESH_STOPS: list[tuple[float, tuple[int, int, int, int]]] = [
    (6.0,   (14, 165, 233, 140)),   # pea — translucent blue
    (12.0,  (16, 185, 129, 170)),   # dime
    (19.0,  (250, 204, 21, 190)),   # penny/nickel
    (25.4,  (249, 115, 22, 210)),   # quarter — severe threshold
    (44.0,  (239, 68, 68, 230)),    # golf ball
    (63.5,  (217, 70, 239, 240)),   # tennis ball+
    (100.0, (255, 255, 255, 255)),  # softball
]


class MeshRequest(BaseModel):
    window_minutes: int = Field(default=30)


@router.post("/mesh")
async def mesh(req: MeshRequest, authorization: str = Header(default="")) -> dict:
    if not RENDERER_TOKEN or authorization != f"Bearer {RENDERER_TOKEN}":
        raise HTTPException(status_code=401, detail="unauthorized")
    if req.window_minutes not in (30, 60, 120):
        raise HTTPException(status_code=400, detail="window_minutes must be 30, 60 or 120")

    started = time.time()
    product = f"MESH_Max_{req.window_minutes}min"
    url = f"{MRMS_BASE}/{product}/MRMS_{product}.latest.grib2.gz"

    try:
        # follow_redirects: NOAA has moved this path before (/data/2D → /2D).
        async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
            r = await client.get(url)
            r.raise_for_status()
            grib_bytes = gzip.decompress(r.content)
    except Exception as e:  # noqa: BLE001
        log.exception("mesh fetch failed")
        raise HTTPException(status_code=502, detail=f"mrms_fetch_failed: {e}")

    import asyncio

    try:
        body, meta = await asyncio.to_thread(_render_mesh, grib_bytes)
    except Exception as e:  # noqa: BLE001
        log.exception("mesh render failed")
        raise HTTPException(status_code=502, detail=f"mesh_render_failed: {e}")

    safe_ts = meta["valid_time"].replace(":", "").replace("-", "")
    cache_id = f"mesh/{req.window_minutes}/{safe_ts}"
    meta_path = f"{cache_id}.meta.json"
    asset_path = f"{cache_id}.png"

    cached = await fetch_metadata(meta_path)
    if cached:
        return {
            "image_url": public_url(asset_path),
            "bounds": cached["bounds"],
            "valid_time": cached["valid_time"],
            "cached": True,
            "render_ms": int((time.time() - started) * 1000),
        }

    try:
        await upload(asset_path, body, "image/png")
        await upload_metadata(meta_path, meta)
    except Exception as e:  # noqa: BLE001
        log.exception("mesh upload failed")
        raise HTTPException(status_code=502, detail=f"upload_failed: {e}")

    return {
        "image_url": public_url(asset_path),
        "bounds": meta["bounds"],
        "valid_time": meta["valid_time"],
        "cached": False,
        "render_ms": int((time.time() - started) * 1000),
    }


def _render_mesh(grib_bytes: bytes) -> tuple[bytes, dict]:
    """Decode the MESH GRIB, crop to BBOX, and paint a transparent PNG."""
    import xarray as xr
    from PIL import Image

    with tempfile.NamedTemporaryFile(suffix=".grib2", delete=False) as f:
        f.write(grib_bytes)
        path = f.name
    try:
        ds = xr.open_dataset(path, engine="cfgrib", backend_kwargs={"indexpath": ""})
        var = next(iter(ds.data_vars.values()))
        lats = ds["latitude"].values
        lons = ds["longitude"].values
        # MRMS longitudes come 0..360.
        lons = np.where(lons > 180.0, lons - 360.0, lons)
        data = np.asarray(var.values, dtype=np.float32)
        valid_time = str(np.datetime_as_string(ds["time"].values, unit="s")) + "Z"
        ds.close()
    finally:
        try:
            os.remove(path)
        except OSError:
            pass

    west, east, south, north = BBOX
    lat_mask = (lats >= south) & (lats <= north)
    lon_mask = (lons >= west) & (lons <= east)
    if not lat_mask.any() or not lon_mask.any():
        raise RuntimeError("bbox produced empty crop")
    sub = data[np.ix_(lat_mask, lon_mask)]
    sub_lats = lats[lat_mask]
    sub_lons = lons[lon_mask]

    # MESH is mm; negatives are missing-data sentinels.
    sub = np.where(np.isfinite(sub), sub, -1.0)

    h, w = sub.shape
    rgba = np.zeros((h, w, 4), dtype=np.uint8)
    for i, (val, color) in enumerate(_MESH_STOPS):
        upper = _MESH_STOPS[i + 1][0] if i + 1 < len(_MESH_STOPS) else np.inf
        m = (sub >= val) & (sub < upper)
        rgba[m] = color

    # GRIB latitudes run north→south already for MRMS; ensure image row 0 is
    # the northernmost latitude either way.
    if sub_lats[0] < sub_lats[-1]:
        rgba = rgba[::-1]
        sub_lats = sub_lats[::-1]

    img = Image.fromarray(rgba, "RGBA")
    # Halve resolution — 0.02° is plenty for a translucent overlay and keeps
    # the PNG ~4x smaller.
    img = img.resize((w // 2, h // 2), Image.NEAREST)
    buf = BytesIO()
    img.save(buf, format="PNG", optimize=True)

    meta = {
        "bounds": {
            "north": float(sub_lats.max()),
            "south": float(sub_lats.min()),
            "east": float(sub_lons.max()),
            "west": float(sub_lons.min()),
        },
        "valid_time": valid_time,
    }
    return buf.getvalue(), meta
