"""GLM lightning endpoint — GOES-19 Geostationary Lightning Mapper flashes.

Sibling to /render. Reads GLM-L2-LCFA NetCDFs from the public noaa-goes19 S3
bucket and returns recent flashes as GeoJSON for the dashboard's /radar map
to render as fading lightning-bolt symbols.

Contract:
  GET /glm/recent?bbox=west,south,east,north&since=<epoch_ms>
    headers: Authorization: Bearer ${RENDERER_TOKEN}
    -> { type: "FeatureCollection",
         features: [{ geometry: Point, properties: { id, t, e } }, ...],
         as_of_ms: <int> }

`t` is flash time in epoch milliseconds. `e` is flash_energy (GLM's relative
energy proxy). `id` is the GLM flash_id (scoped to one source file).

Data source: NOAA Open Data on AWS — bucket `noaa-goes19`, prefix
`GLM-L2-LCFA/YYYY/DOY/HH/`. Files drop every ~20 s, ~50–200 KB each. Public,
no creds. GOES-19 has been the operational GOES-East since 2025-04-04.
"""

from __future__ import annotations

import os
import time
from datetime import datetime, timedelta, timezone
from typing import Any

import boto3
import netCDF4  # type: ignore
from botocore import UNSIGNED
from botocore.client import Config
from fastapi import APIRouter, Header, HTTPException, Query

router = APIRouter()

RENDERER_TOKEN = os.environ.get("RENDERER_TOKEN", "")

_BUCKET = "noaa-goes19"
_S3 = boto3.client("s3", config=Config(signature_version=UNSIGNED))

# How far back to scan when the client doesn't specify `since`. Matches the
# Next.js client's 2-minute fade window with a small buffer for clock skew.
_DEFAULT_LOOKBACK_SECONDS = 150
_MAX_LOOKBACK_SECONDS = 900

# GLM product_time is "seconds since 2000-01-01 12:00:00 UTC" per the L2 CDL.
_GLM_EPOCH = datetime(2000, 1, 1, 12, 0, 0, tzinfo=timezone.utc)


def _hour_prefix(dt: datetime) -> str:
    return f"GLM-L2-LCFA/{dt.year:04d}/{dt.timetuple().tm_yday:03d}/{dt.hour:02d}/"


def _list_recent_keys(since_dt: datetime, now_dt: datetime) -> list[str]:
    keys: list[str] = []
    hour = now_dt.replace(minute=0, second=0, microsecond=0)
    floor = now_dt - timedelta(seconds=_MAX_LOOKBACK_SECONDS)
    while True:
        resp = _S3.list_objects_v2(Bucket=_BUCKET, Prefix=_hour_prefix(hour))
        for obj in resp.get("Contents", []):
            keys.append(obj["Key"])
        if hour <= since_dt or hour <= floor:
            break
        hour -= timedelta(hours=1)
    return sorted(keys)


def _parse_glm(
    blob: bytes,
    bbox: tuple[float, float, float, float] | None,
    since_ms: int,
) -> list[dict[str, Any]]:
    # netCDF4 ≥ 1.5 reads HDF5 from memory; saves a temp file per request.
    ds = netCDF4.Dataset("inmem", mode="r", memory=blob)
    try:
        product_time_s = float(ds.variables["product_time"][:].item())
        product_time = _GLM_EPOCH + timedelta(seconds=product_time_s)

        lats = ds.variables["flash_lat"][:]
        lons = ds.variables["flash_lon"][:]
        offs = ds.variables["flash_time_offset_of_first_event"][:]
        ids = ds.variables["flash_id"][:]
        energy = ds.variables["flash_energy"][:]

        if bbox:
            west, south, east, north = bbox
        else:
            west, south, east, north = -180.0, -90.0, 180.0, 90.0

        out: list[dict[str, Any]] = []
        for i in range(len(ids)):
            lon = float(lons[i])
            lat = float(lats[i])
            if not (west <= lon <= east and south <= lat <= north):
                continue
            t_ms = int((product_time + timedelta(seconds=float(offs[i]))).timestamp() * 1000)
            if t_ms < since_ms:
                continue
            out.append({
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [lon, lat]},
                "properties": {
                    "id": int(ids[i]),
                    "t": t_ms,
                    "e": float(energy[i]),
                },
            })
        return out
    finally:
        ds.close()


@router.get("/glm/recent")
def glm_recent(
    bbox: str | None = Query(None, description="west,south,east,north (WGS84 degrees)"),
    since: int | None = Query(None, description="Epoch ms; oldest flash to include"),
    authorization: str = Header(default=""),
) -> dict[str, Any]:
    # Match /render's in-route auth check; no Depends/verify_bearer in main.py.
    if not RENDERER_TOKEN or authorization != f"Bearer {RENDERER_TOKEN}":
        raise HTTPException(status_code=401, detail="unauthorized")

    now_ms = int(time.time() * 1000)
    if since is None:
        since_ms = now_ms - _DEFAULT_LOOKBACK_SECONDS * 1000
    else:
        since_ms = max(since, now_ms - _MAX_LOOKBACK_SECONDS * 1000)

    since_dt = datetime.fromtimestamp(since_ms / 1000, tz=timezone.utc)
    now_dt = datetime.fromtimestamp(now_ms / 1000, tz=timezone.utc)

    bbox_tuple: tuple[float, float, float, float] | None = None
    if bbox:
        parts = bbox.split(",")
        if len(parts) != 4:
            raise HTTPException(status_code=400, detail="bbox must be west,south,east,north")
        try:
            w, s, e, n = (float(p) for p in parts)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="bbox values must be numeric") from exc
        if not (-180 <= w <= 180 and -180 <= e <= 180 and -90 <= s <= 90 and -90 <= n <= 90):
            raise HTTPException(status_code=400, detail="bbox out of WGS84 range")
        bbox_tuple = (w, s, e, n)

    keys = _list_recent_keys(since_dt, now_dt)
    # Cap to most recent ~12 files (~4 min). Anything older than since_ms is
    # filtered inside _parse_glm too — this is just a fetch bound.
    keys = keys[-12:]

    features: list[dict[str, Any]] = []
    for key in keys:
        obj = _S3.get_object(Bucket=_BUCKET, Key=key)
        blob = obj["Body"].read()
        features.extend(_parse_glm(blob, bbox_tuple, since_ms))

    return {
        "type": "FeatureCollection",
        "features": features,
        "as_of_ms": now_ms,
    }
