# Couplet-detection endpoint — drop-in for the sibling midsouthwx-radar-renderer
# repo (Fly.io). NOT loaded by this Next.js app; the leading underscore in
# _renderer/ keeps Next from picking it up as a route.
#
# What this serves:
#   POST /couplets/scan   (bearer auth via RENDERER_TOKEN)
#     {
#       "site": "KNQA",                  # 4-letter NEXRAD ID
#       "min_shear_kt": 50,              # optional; default 50
#       "max_range_km": 150,             # optional; default 150
#       "min_range_km": 10,              # optional; default 10
#     }
#     -> {
#       "site": "KNQA",
#       "volume_filename": "KNQA20260524_143215_V06",
#       "volume_time_utc": "2026-05-24T14:32:15Z",
#       "scan_age_seconds": 47,
#       "elevation_deg": 0.48,           # actual sweep elevation (≈ 0.5)
#       "radar_lat": 35.345,             # site location for downstream display
#       "radar_lon": -89.873,
#       "detections": [
#         { "lon": -89.42, "lat": 34.91, "shear_kt": 67.2,
#           "range_km": 42.1, "azimuth_deg": 245.0 },
#         ...
#       ],
#       "scan_ms": 8420,
#       "candidates_before_cluster": 184
#     }
#
#   GET /couplets/sites
#     -> { "sites": [ {"id": "KNQA", "lat": 35.345, "lon": -89.873, "name": "Memphis, TN"}, ... ] }
#
# Why this exists:
#   Gate-to-gate velocity shear in the lowest-elevation sweep is a tornado
#   vortex / mesocyclone signature. NWS uses it (with other signals) when
#   deciding to issue a Tornado Warning. Detecting it algorithmically and
#   surfacing it on the operator's radar gives them a faster heads-up than
#   waiting for the formal warning to drop on api.weather.gov.
#
#   This endpoint does ONE volume per call. The Next.js Edge Function
#   `couplet-poll` (Phase 2) calls this every ~60 s per Mid-South site and
#   persists the detections to `public.radar_couplets`.
#
# Algorithm (concise):
#   1. List latest Level II keys for `site` in s3://noaa-nexrad-level2/
#   2. Download the most recent volume
#   3. Read with pyart.io.read_nexrad_archive
#   4. Pick the sweep with elevation closest to 0.5°
#   5. Dealias velocity (pyart.correct.dealias_region_based)
#   6. For each adjacent azimuth pair, compute |Δv| at each range gate
#   7. Find peaks above `min_shear_kt`, within (min_range_km, max_range_km)
#   8. Cluster nearby peaks (1.5 km radius) — keep the strongest in each
#   9. Translate (range, azimuth) → (lon, lat) using Py-ART's gate_latitude /
#      gate_longitude tables (already accounts for Earth curvature + beam
#      refraction). Return list.
#
# Calibration notes:
#   - 50 kt gate-to-gate shear is a permissive starting threshold; expect a
#     non-trivial false-alarm rate from biological targets, ground clutter
#     at long range, and broken meso circulations. Phase 4 validation
#     against subsequent NWS warnings will tune this per-site.
#   - We intentionally do NOT filter by reflectivity overlap here. That's a
#     common second-pass filter (real circulations sit inside a precip
#     echo). It can be added once Phase 4 shows what FAR looks like raw.
#
# Integration in main.py:
#   from couplet_detect import router as couplet_router
#   app.include_router(couplet_router)
#
# Required env vars:
#   RENDERER_TOKEN — already set; same bearer used by /render and /alert-snapshot.
#
# Dependencies (renderer already has pyart + boto3):
#   pip install arm-pyart boto3 numpy fastapi pydantic

from __future__ import annotations

import logging
import os
import threading
import time
from datetime import datetime, timezone
from typing import Any

import numpy as np
import pyart  # type: ignore
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field

from radar_io import download_volume, find_latest_volume

log = logging.getLogger("couplet_detect")

router = APIRouter()

RENDERER_TOKEN = os.environ.get("RENDERER_TOKEN", "")

# ──────────────────────────────────────────────────────────────────────────
# Mid-South NEXRAD sites. Lat/lon used only for the /sites listing endpoint;
# /couplets/scan reads true site coordinates from each volume's metadata.
# ──────────────────────────────────────────────────────────────────────────

MIDSOUTH_SITES: dict[str, dict[str, Any]] = {
    "KNQA": {"lat": 35.3450, "lon": -89.8731, "name": "Memphis, TN"},
    "KDGX": {"lat": 32.2800, "lon": -89.9844, "name": "Jackson, MS"},
    "KGWX": {"lat": 33.8967, "lon": -88.3294, "name": "Columbus AFB, MS"},
    "KOHX": {"lat": 36.2472, "lon": -86.5625, "name": "Nashville, TN"},
    "KLZK": {"lat": 34.8364, "lon": -92.2622, "name": "Little Rock, AR"},
    "KHTX": {"lat": 34.9306, "lon": -86.0833, "name": "Hytop, AL"},
    "KPAH": {"lat": 37.0683, "lon": -88.7719, "name": "Paducah, KY"},
    "KMRX": {"lat": 36.1686, "lon": -83.4019, "name": "Morristown, TN"},
}

# ──────────────────────────────────────────────────────────────────────────
# Defaults and limits
# ──────────────────────────────────────────────────────────────────────────

# 50 kt ≈ 25.7 m/s. The conversion is exact-enough at 0.5144.
KTS_TO_MS = 0.5144444

# Minimum gate-to-gate shear to flag a candidate. Lower = more candidates =
# more false alarms. NWS internally uses values in the 40–80 kt range
# depending on storm mode + range; 50 is a permissive starting point that
# Phase 4 validation will tune per-site.
DEFAULT_MIN_SHEAR_KT = 50.0

# Range filters. Inside 10 km the radar is in the cone of silence + clutter
# dominates; past 150 km the beam is high enough above the surface that
# low-level rotation is invisible (and the gate spacing widens, reducing
# the gate-to-gate shear we can resolve).
DEFAULT_MIN_RANGE_KM = 10.0
DEFAULT_MAX_RANGE_KM = 150.0

# Two candidates within this distance get collapsed to the strongest. A
# single real circulation often lights up 2–5 adjacent gates; clustering
# avoids inflating the detection count.
CLUSTER_RADIUS_KM = 1.5

# How old a volume can be (relative to wall clock) before we refuse to
# return its detections. Stale volumes are usually a sign that the radar
# is down for maintenance; surfacing 30-min-old "live" rotations would
# mislead the operator.
MAX_VOLUME_AGE_SECONDS = 600  # 10 min

# NEXRAD discovery + download is delegated to radar_io (THREDDS catalog).
# NOAA's noaa-nexrad-level2 bucket allows GetObject but NOT ListBucket for
# anonymous requests, so we cannot enumerate the latest volume via S3
# without signed credentials. The /render endpoint uses the same THREDDS
# resolver and has been stable in prod.

# Concurrency cap for Py-ART parse + dealias. Each scan loads a ~5 MB Level
# II volume into Python objects and runs region-based dealiasing — peak
# RSS is ~600-900 MB per concurrent scan. The dashboard's couplet-poll
# edge function fans out 8 parallel requests (one per Mid-South site); on
# the 4 GB Fly machine, 3 × 900 MB ≈ 2.7 GB peak fits comfortably.
# 2 worked but pushed back-of-queue sites over the 60 s per-site timeout
# whenever the machine cold-started; 3 finishes 8 sites in ~50 s warm,
# ~60 s cold, well under the timeout.
_COUPLET_SEMAPHORE = threading.Semaphore(3)


# ──────────────────────────────────────────────────────────────────────────
# Models
# ──────────────────────────────────────────────────────────────────────────


class CoupletScanRequest(BaseModel):
    site: str = Field(min_length=4, max_length=4)
    min_shear_kt: float = Field(default=DEFAULT_MIN_SHEAR_KT, ge=20.0, le=200.0)
    min_range_km: float = Field(default=DEFAULT_MIN_RANGE_KM, ge=0.0, le=50.0)
    max_range_km: float = Field(default=DEFAULT_MAX_RANGE_KM, ge=50.0, le=230.0)


class Detection(BaseModel):
    lon: float
    lat: float
    shear_kt: float
    range_km: float
    azimuth_deg: float


class CoupletScanResponse(BaseModel):
    site: str
    volume_filename: str
    volume_time_utc: str
    scan_age_seconds: int
    elevation_deg: float
    radar_lat: float
    radar_lon: float
    detections: list[Detection]
    candidates_before_cluster: int
    scan_ms: int


# ──────────────────────────────────────────────────────────────────────────
# AWS NEXRAD discovery
# ──────────────────────────────────────────────────────────────────────────


# NEXRAD discovery + fetch is now handled by radar_io.find_latest_volume and
# radar_io.download_volume — both go through UCAR's THREDDS catalog. The
# previous S3 ListBucket path returned AccessDenied against the public NOAA
# bucket and has been removed.


# ──────────────────────────────────────────────────────────────────────────
# Detection
# ──────────────────────────────────────────────────────────────────────────


def _pick_low_elevation_sweep(radar: Any) -> int:
    """Return the index of the sweep closest to 0.5° elevation.

    Most VCPs (12, 212, 215) start with a 0.5° tilt at sweep index 0; some
    modes split-cut and put 0.5° SAILS scans elsewhere. argmin(|elev - 0.5|)
    works for both without having to know the VCP.
    """
    elevs = np.asarray(radar.fixed_angle["data"], dtype=float)
    return int(np.argmin(np.abs(elevs - 0.5)))


def _dealias_velocity(radar: Any, sweep_idx: int) -> np.ndarray | None:
    """Run Py-ART's region-based dealiasing on a single sweep.

    Returns the dealiased velocity field (m/s) for that sweep as a masked
    2D ndarray (shape (n_rays_in_sweep, n_gates)). Returns None if the
    radar volume has no velocity field (e.g., reflectivity-only mode).
    """
    if "velocity" not in radar.fields:
        return None
    try:
        dealiased = pyart.correct.dealias_region_based(
            radar, vel_field="velocity"
        )
        radar.add_field("velocity_dealiased", dealiased, replace_existing=True)
        field = "velocity_dealiased"
    except Exception:  # noqa: BLE001
        # Some volumes have nyquist/region ambiguities that the algorithm
        # can't resolve. Fall back to the raw field — gate-to-gate Δv is
        # still meaningful for the strongest couplets, just noisier.
        log.warning("dealias_region_based failed; using raw velocity")
        field = "velocity"

    start = radar.sweep_start_ray_index["data"][sweep_idx]
    end = radar.sweep_end_ray_index["data"][sweep_idx]
    return radar.fields[field]["data"][start : end + 1, :]


def _scan_for_couplets(
    radar: Any,
    sweep_idx: int,
    min_shear_kt: float,
    min_range_km: float,
    max_range_km: float,
) -> tuple[list[dict[str, float]], int]:
    """Per-gate scan for strong azimuthal velocity shear.

    Returns (clustered_detections, raw_candidate_count). The raw count is
    useful for diagnostics — a sudden 10× jump usually means dealiasing
    blew up, not a real outbreak.
    """
    vel = _dealias_velocity(radar, sweep_idx)
    if vel is None:
        return [], 0

    start = radar.sweep_start_ray_index["data"][sweep_idx]
    end = radar.sweep_end_ray_index["data"][sweep_idx]

    azimuths = np.asarray(radar.azimuth["data"][start : end + 1], dtype=float)
    ranges_m = np.asarray(radar.range["data"], dtype=float)
    gate_lat = np.asarray(radar.gate_latitude["data"][start : end + 1, :], dtype=float)
    gate_lon = np.asarray(radar.gate_longitude["data"][start : end + 1, :], dtype=float)

    # Sort rays by azimuth so "adjacent" really means adjacent in space.
    # NEXRAD VCPs typically start near 0° and march around, but the first
    # ray in a SAILS sweep can be at any azimuth.
    sort_idx = np.argsort(azimuths)
    azimuths = azimuths[sort_idx]
    vel = vel[sort_idx]
    gate_lat = gate_lat[sort_idx]
    gate_lon = gate_lon[sort_idx]

    n_rays, n_gates = vel.shape
    if n_rays < 2:
        return [], 0

    threshold_ms = min_shear_kt * KTS_TO_MS

    # Range mask: only consider gates inside (min_range_km, max_range_km).
    rng_km = ranges_m / 1000.0
    range_mask = (rng_km >= min_range_km) & (rng_km <= max_range_km)
    if not range_mask.any():
        return [], 0

    candidates: list[dict[str, float]] = []
    # Vectorized gate-to-gate shear: vel[i+1] - vel[i] across the azimuth
    # axis. Masked arrays propagate the mask through subtract so missing
    # gates don't generate spurious huge deltas.
    dv_all = vel[1:] - vel[:-1]
    # If pyart returned a masked array, fill masked entries with 0 so the
    # threshold comparison rejects them rather than crashing on NaN.
    if hasattr(dv_all, "mask"):
        dv = np.where(dv_all.mask, 0.0, np.abs(dv_all.filled(0.0)))
    else:
        dv = np.abs(np.asarray(dv_all))

    # For each ray-pair, find gates where |Δv| exceeds threshold AND we're
    # in the valid range band. Argmax-per-row would only catch one per pair;
    # we walk the row and pick non-adjacent peaks so a single mesocyclone
    # producing 3 adjacent peaks lights up once per cluster (handled by the
    # clustering pass below).
    for i in range(n_rays - 1):
        row = dv[i]
        eligible = (row > threshold_ms) & range_mask
        if not eligible.any():
            continue
        for j in np.where(eligible)[0]:
            mid_az = float((azimuths[i] + azimuths[i + 1]) / 2.0)
            shear_kt = float(row[j] / KTS_TO_MS)
            # Use the midpoint of the two gate coordinates for placement.
            lat = float((gate_lat[i, j] + gate_lat[i + 1, j]) / 2.0)
            lon = float((gate_lon[i, j] + gate_lon[i + 1, j]) / 2.0)
            candidates.append({
                "lat": lat,
                "lon": lon,
                "shear_kt": shear_kt,
                "range_km": float(rng_km[j]),
                "azimuth_deg": mid_az,
            })

    raw_count = len(candidates)
    clustered = _cluster_detections(candidates, CLUSTER_RADIUS_KM)
    return clustered, raw_count


def _cluster_detections(
    candidates: list[dict[str, float]],
    radius_km: float,
) -> list[dict[str, float]]:
    """Greedy strongest-first clustering.

    Sort candidates by shear (descending). For each candidate, accept it
    only if no already-accepted detection sits within `radius_km`. This
    collapses the 3–7 adjacent strong-shear gates of one real circulation
    into a single reported point at the strongest gate.
    """
    if not candidates:
        return []
    sorted_cands = sorted(candidates, key=lambda d: d["shear_kt"], reverse=True)
    accepted: list[dict[str, float]] = []
    for c in sorted_cands:
        close = any(
            _haversine_km(c["lat"], c["lon"], a["lat"], a["lon"]) < radius_km
            for a in accepted
        )
        if not close:
            accepted.append(c)
    return accepted


def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in km. Inlined to avoid a turf/pyart dep."""
    r = 6371.0
    phi1 = np.radians(lat1)
    phi2 = np.radians(lat2)
    dphi = np.radians(lat2 - lat1)
    dlam = np.radians(lon2 - lon1)
    a = (np.sin(dphi / 2.0) ** 2
         + np.cos(phi1) * np.cos(phi2) * np.sin(dlam / 2.0) ** 2)
    return float(2 * r * np.arcsin(np.sqrt(a)))


# ──────────────────────────────────────────────────────────────────────────
# Endpoints
# ──────────────────────────────────────────────────────────────────────────


@router.get("/couplets/sites")
def list_sites() -> dict[str, Any]:
    """Static listing of the Mid-South NEXRAD sites this endpoint understands.

    Useful for the Edge Function's cron config and for any operator-facing
    debug page. No auth required — the data is public.
    """
    return {
        "sites": [
            {"id": sid, **meta}
            for sid, meta in sorted(MIDSOUTH_SITES.items())
        ]
    }


@router.post("/couplets/scan", response_model=CoupletScanResponse)
def couplets_scan(
    req: CoupletScanRequest,
    authorization: str = Header(default=""),
) -> CoupletScanResponse:
    if not RENDERER_TOKEN or authorization != f"Bearer {RENDERER_TOKEN}":
        raise HTTPException(status_code=401, detail="unauthorized")

    site = req.site.upper()
    if site not in MIDSOUTH_SITES:
        raise HTTPException(status_code=400, detail=f"unsupported site {site}")

    started = time.time()
    now_dt = datetime.now(timezone.utc)

    try:
        url_path, vol_time = find_latest_volume(site)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=502, detail=f"no recent Level II for {site}: {exc}"
        ) from exc

    age = (now_dt - vol_time).total_seconds()
    if age > MAX_VOLUME_AGE_SECONDS:
        raise HTTPException(
            status_code=503,
            detail=f"latest {site} volume is {int(age)}s old (>{MAX_VOLUME_AGE_SECONDS}s threshold)",
        )

    volume_filename = url_path.rsplit("/", 1)[-1]

    # Download is network-bound and small (~5 MB tmpfile), safe to do outside
    # the memory semaphore. Parse + detect is the heavy step and stays inside.
    try:
        local_path = download_volume(url_path)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=502, detail=f"could not download {volume_filename}: {exc}"
        ) from exc

    with _COUPLET_SEMAPHORE:
        try:
            try:
                radar = pyart.io.read_nexrad_archive(local_path)
            except Exception as exc:  # noqa: BLE001
                raise HTTPException(
                    status_code=502,
                    detail=f"pyart could not read {volume_filename}: {exc}",
                ) from exc
        finally:
            try:
                os.remove(local_path)
            except OSError:
                pass

        try:
            sweep_idx = _pick_low_elevation_sweep(radar)
            elev_deg = float(radar.fixed_angle["data"][sweep_idx])
            radar_lat = float(radar.latitude["data"][0])
            radar_lon = float(radar.longitude["data"][0])

            detections, raw_count = _scan_for_couplets(
                radar,
                sweep_idx,
                req.min_shear_kt,
                req.min_range_km,
                req.max_range_km,
            )
        finally:
            # Py-ART Radar holds large arrays; help GC out promptly on Fly's
            # smaller machines where back-to-back scans can stack memory.
            del radar

    return CoupletScanResponse(
        site=site,
        volume_filename=volume_filename,
        volume_time_utc=vol_time.isoformat().replace("+00:00", "Z"),
        scan_age_seconds=int(age),
        elevation_deg=elev_deg,
        radar_lat=radar_lat,
        radar_lon=radar_lon,
        detections=[Detection(**d) for d in detections],
        candidates_before_cluster=raw_count,
        scan_ms=int((time.time() - started) * 1000),
    )
