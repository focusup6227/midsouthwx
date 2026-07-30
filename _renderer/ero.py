"""WPC Excessive Rainfall Outlook (Day 1) → GeoJSON.

WPC publishes the ERO only as zipped shapefiles
(ftp-wpc.ncep.noaa.gov/shapefiles/qpf/excessive/94eU_YYYYMMDD01.zip, one per
day). This endpoint downloads today's file (falling back to yesterday around
the 01Z issuance gap), parses it with pyshp, and returns a GeoJSON
FeatureCollection with a normalized `label` per polygon
(MRGL/SLGT/MDT/HIGH). Cached in Supabase Storage keyed by the zip name.

  POST /ero   (bearer auth via RENDERER_TOKEN)  -> { "geojson_url", "valid_date", "cached" }
"""

from __future__ import annotations

import gzip
import io
import logging
import os
import time
import zipfile
from datetime import datetime, timedelta, timezone

import httpx
import orjson
from fastapi import APIRouter, Header, HTTPException

from storage import fetch_metadata, public_url, upload, upload_metadata

log = logging.getLogger("ero")

router = APIRouter()

RENDERER_TOKEN = os.environ.get("RENDERER_TOKEN", "")
ERO_BASE = "https://ftp-wpc.ncep.noaa.gov/shapefiles/qpf/excessive"

# Normalize the category however the DBF spells it.
_LABELS = {
    "marginal": "MRGL", "mrgl": "MRGL",
    "slight": "SLGT", "slgt": "SLGT",
    "moderate": "MDT", "mdt": "MDT",
    "high": "HIGH",
}


@router.post("/ero")
async def ero(authorization: str = Header(default="")) -> dict:
    if not RENDERER_TOKEN or authorization != f"Bearer {RENDERER_TOKEN}":
        raise HTTPException(status_code=401, detail="unauthorized")

    started = time.time()
    now = datetime.now(timezone.utc)
    candidates = [now, now - timedelta(days=1)]

    zip_bytes: bytes | None = None
    zip_name = ""
    async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
        for d in candidates:
            name = f"94eU_{d.strftime('%Y%m%d')}01.zip"
            cached_meta = await fetch_metadata(f"ero/{name}.meta.json")
            if cached_meta:
                return {
                    "geojson_url": public_url(f"ero/{name}.geojson.gz"),
                    "valid_date": cached_meta.get("valid_date"),
                    "cached": True,
                    "render_ms": int((time.time() - started) * 1000),
                }
            try:
                r = await client.get(f"{ERO_BASE}/{name}")
                if r.status_code == 200 and len(r.content) > 200:
                    zip_bytes = r.content
                    zip_name = name
                    valid_date = d.strftime("%Y-%m-%d")
                    break
            except Exception:  # noqa: BLE001
                continue

    if zip_bytes is None:
        raise HTTPException(status_code=502, detail="ero_unavailable")

    try:
        fc = _parse_ero_zip(zip_bytes)
    except Exception as e:  # noqa: BLE001
        log.exception("ero parse failed")
        raise HTTPException(status_code=502, detail=f"ero_parse_failed: {e}")

    body = gzip.compress(orjson.dumps(fc), 6)
    asset = f"ero/{zip_name}.geojson.gz"
    try:
        await upload(asset, body, "application/gzip")
        await upload_metadata(f"ero/{zip_name}.meta.json", {"valid_date": valid_date, "features": len(fc["features"])})
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"upload_failed: {e}")

    return {
        "geojson_url": public_url(asset),
        "valid_date": valid_date,
        "cached": False,
        "render_ms": int((time.time() - started) * 1000),
    }


def _parse_ero_zip(zip_bytes: bytes) -> dict:
    import shapefile  # pyshp

    zf = zipfile.ZipFile(io.BytesIO(zip_bytes))
    shp = next((n for n in zf.namelist() if n.lower().endswith(".shp")), None)
    dbf = next((n for n in zf.namelist() if n.lower().endswith(".dbf")), None)
    if not shp or not dbf:
        raise RuntimeError("zip missing shp/dbf")
    reader = shapefile.Reader(
        shp=io.BytesIO(zf.read(shp)),
        dbf=io.BytesIO(zf.read(dbf)),
    )
    features = []
    for sr in reader.shapeRecords():
        rec = sr.record.as_dict()
        label = None
        for v in rec.values():
            key = str(v).strip().lower()
            if key in _LABELS:
                label = _LABELS[key]
                break
        geom = sr.shape.__geo_interface__
        # Skip the TSTM/general-rain outer polygon — the risk tiers are the
        # signal; an all-CONUS wash just occludes the map.
        if label is None:
            continue
        features.append({
            "type": "Feature",
            "geometry": geom,
            "properties": {"label": label, **{k: str(v)[:80] for k, v in rec.items()}},
        })
    return {"type": "FeatureCollection", "features": features}
