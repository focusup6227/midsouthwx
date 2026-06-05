"""NWP model-field rendering: NOMADS GRIB2 subset -> matplotlib PNG.

This is the real-data answer to the gap lib/radar/models.ts documents (raw
GFS/NAM/HRRR aren't on any public WMS). We pull a single field for one
forecast hour from NOMADS' GRIB filter endpoints, parse it with cfgrib, and
render an opaque PNG with state boundaries baked in — so the dashboard's
Models panel can show it as a plain <img> and animate by forecast hour, the
same shape as the SPC mesoanalysis panel.

Caching mirrors the radar path (Supabase Storage, keyed by
model/field/fhr/region/cycle). Heavy deps: cfgrib + eccodes (system lib).

Runnable standalone for local verification:
    python model_render.py gfs t2m 24 midsouth
writes /tmp/model_test.png without touching Supabase.
"""

from __future__ import annotations

import os
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone
from io import BytesIO
from typing import Optional

import httpx
import matplotlib
import numpy as np

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.colors import BoundaryNorm, LinearSegmentedColormap, Normalize

# --- geographic regions (west, east, south, north) ------------------------

REGIONS: dict[str, tuple[float, float, float, float]] = {
    "conus":     (-125.0, -66.0, 23.5, 50.0),
    "midsouth":  (-95.0, -82.0, 31.0, 38.5),
    "southeast": (-92.0, -75.0, 28.0, 37.0),
    "splains":   (-105.0, -89.0, 28.0, 40.0),
    "ohvalley":  (-92.0, -78.0, 33.0, 42.0),
}
DEFAULT_REGION = "midsouth"

# --- color ramps ----------------------------------------------------------

_REFL = LinearSegmentedColormap.from_list("refl", [
    "#3b82f6", "#22d3ee", "#10b981", "#84cc16",
    "#facc15", "#f97316", "#ef4444", "#d946ef",
])
_THERMAL = LinearSegmentedColormap.from_list("thermal", [
    "#3b0764", "#1d4ed8", "#0891b2", "#10b981", "#a3e635",
    "#fde047", "#f97316", "#dc2626", "#7f1d1d",
])
_CAPE = LinearSegmentedColormap.from_list("cape", [
    "#0b1220", "#1d4ed8", "#10b981", "#facc15", "#f97316", "#dc2626", "#a21caf",
])
_PRECIP = LinearSegmentedColormap.from_list("precip", [
    "#0b1220", "#22d3ee", "#3b82f6", "#10b981", "#facc15", "#f97316", "#dc2626", "#a21caf",
])
_HGT = LinearSegmentedColormap.from_list("hgt", [
    "#6d28d9", "#2563eb", "#0891b2", "#10b981", "#fde047", "#f97316", "#dc2626",
])

# --- field catalog --------------------------------------------------------
# Each field: NOMADS var/level filter flags, a transform from GRIB native
# units to display units, a colormap + value range, and a label/unit. `fbk`
# is a cfgrib filter_by_keys fallback used only when a narrow subset still
# decodes to multiple messages.

FIELDS: dict[str, dict] = {
    "t2m": {
        "label": "2 m Temperature", "unit": "°F",
        "var": "TMP", "lev": "2_m_above_ground",
        "fbk": {"typeOfLevel": "heightAboveGround", "level": 2},
        "xf": lambda a: a * 9.0 / 5.0 - 459.67,  # K -> °F
        "cmap": _THERMAL, "vmin": 10, "vmax": 110,
    },
    "mslp": {
        "label": "MSLP", "unit": "hPa",
        "var": "PRMSL", "lev": "mean_sea_level",
        "fbk": {"typeOfLevel": "meanSea"},
        "xf": lambda a: a / 100.0,  # Pa -> hPa
        "cmap": "viridis", "vmin": 980, "vmax": 1040, "contour": True,
    },
    "cape": {
        "label": "Surface CAPE", "unit": "J/kg",
        "var": "CAPE", "lev": "surface",
        "fbk": {"typeOfLevel": "surface"},
        "xf": lambda a: a,
        "cmap": _CAPE, "vmin": 0, "vmax": 4000,
    },
    "apcp": {
        "label": "Accumulated precip", "unit": "in",
        "var": "APCP", "lev": "surface",
        "fbk": {"stepType": "accum"},
        "xf": lambda a: a / 25.4,  # mm -> in
        "cmap": _PRECIP, "vmin": 0, "vmax": 3, "min_fhr": 1,
    },
    "hgt500": {
        "label": "500 hPa height", "unit": "dam",
        "var": "HGT", "lev": "500_mb",
        "fbk": {"typeOfLevel": "isobaricInhPa", "level": 500},
        "xf": lambda a: a / 10.0,  # m -> dam
        "cmap": _HGT, "vmin": 510, "vmax": 600, "contour": True,
    },
    "refc": {
        "label": "Composite reflectivity", "unit": "dBZ",
        "var": "REFC", "lev": "entire_atmosphere",
        "fbk": {},
        "xf": lambda a: a,
        "cmap": _REFL, "vmin": 5, "vmax": 75, "mask_below": 5,
    },
}

# --- model catalog --------------------------------------------------------
# cgi: NOMADS filter endpoint. dir/file: path templates. cycles: UTC run hours
# the model posts. fhr_max/step: forecast-hour catalog for the UI slider.

MODELS: dict[str, dict] = {
    "gfs": {
        "label": "GFS 0.25°",
        "cgi": "filter_gfs_0p25.pl",
        "dir": "/gfs.{ymd}/{hh}/atmos",
        "file": "gfs.t{hh}z.pgrb2.0p25.f{fff}",
        "fff": 3,
        "cycles": [0, 6, 12, 18], "cycle_lag_h": 4,
        "fhr_max": 84, "fhr_step": 3,
        "fields": ["t2m", "mslp", "cape", "apcp", "hgt500"],
    },
    "nam": {
        "label": "NAM 12 km",
        "cgi": "filter_nam.pl",
        "dir": "/nam.{ymd}",
        "file": "nam.t{hh}z.awphys{ff}.tm00.grib2",
        "fff": 2,
        "cycles": [0, 6, 12, 18], "cycle_lag_h": 3,
        "fhr_max": 60, "fhr_step": 3,
        "fields": ["t2m", "mslp", "cape", "apcp"],
    },
    "hrrr": {
        "label": "HRRR 3 km",
        "cgi": "filter_hrrr_2d.pl",
        "dir": "/hrrr.{ymd}/conus",
        "file": "hrrr.t{hh}z.wrfsfcf{ff}.grib2",
        "fff": 2,
        "cycles": list(range(24)), "cycle_lag_h": 2,
        "fhr_max": 18, "fhr_step": 1,
        "fields": ["t2m", "refc", "cape"],
    },
}

NOMADS_BASE = "https://nomads.ncep.noaa.gov/cgi-bin"

_STATES_PATH = os.path.join(os.path.dirname(__file__), "geo", "us_states.json")
_states_cache: Optional[list] = None


def _load_states() -> list:
    global _states_cache
    if _states_cache is None:
        import json
        try:
            with open(_STATES_PATH) as f:
                gj = json.load(f)
            rings: list = []
            for feat in gj.get("features", []):
                geom = feat.get("geometry", {})
                t, coords = geom.get("type"), geom.get("coordinates", [])
                polys = [coords] if t == "Polygon" else coords if t == "MultiPolygon" else []
                for poly in polys:
                    for ring in poly:
                        rings.append(np.asarray(ring))
            _states_cache = rings
        except Exception:
            _states_cache = []
    return _states_cache


def latest_cycle(model: str, now: Optional[datetime] = None) -> tuple[str, str]:
    """Best-effort most-recent posted cycle. Returns (ymd, hh)."""
    m = MODELS[model]
    now = now or datetime.now(timezone.utc)
    t = now - timedelta(hours=m["cycle_lag_h"])
    cycles = sorted(m["cycles"])
    for back in range(0, 48):
        cand = t - timedelta(hours=back)
        hour = cand.hour
        avail = [c for c in cycles if c <= hour]
        if avail:
            hh = max(avail)
            return cand.strftime("%Y%m%d"), f"{hh:02d}"
    # Fallback: yesterday 00Z.
    y = (now - timedelta(days=1)).strftime("%Y%m%d")
    return y, "00"


def build_url(model: str, field: str, fhr: int, ymd: str, hh: str) -> str:
    m, f = MODELS[model], FIELDS[field]
    fnum = f"{fhr:0{m['fff']}d}"
    file = m["file"].format(hh=hh, fff=fnum, ff=fnum)
    dirpath = m["dir"].format(ymd=ymd, hh=hh)
    params = {
        "dir": dirpath,
        "file": file,
        f"var_{f['var']}": "on",
        f"lev_{f['lev']}": "on",
    }
    from urllib.parse import urlencode
    return f"{NOMADS_BASE}/{m['cgi']}?{urlencode(params)}"


def fetch_grib(url: str, timeout: float = 25.0) -> bytes:
    with httpx.Client(timeout=timeout, follow_redirects=True) as c:
        r = c.get(url)
        if r.status_code != 200:
            raise RuntimeError(f"nomads {r.status_code}")
        body = r.content
        # NOMADS returns a tiny HTML/text error body when the cycle/hour isn't
        # posted yet; a real GRIB2 message starts with 'GRIB'.
        if len(body) < 500 or body[:4] != b"GRIB":
            raise RuntimeError(f"not_grib (len={len(body)})")
        return body


def _open_field(grib_bytes: bytes, field: str):
    """Decode the GRIB subset to (lon2d_or_1d, lat..., data2d, valid_time)."""
    import xarray as xr

    fbk = FIELDS[field]["fbk"]
    with tempfile.NamedTemporaryFile(suffix=".grib2", delete=False) as tf:
        tf.write(grib_bytes)
        path = tf.name
    try:
        backend = {"indexpath": ""}
        try:
            ds = xr.open_dataset(path, engine="cfgrib", backend_kwargs=backend)
        except Exception:
            # Mixed messages — disambiguate with the field's filter_by_keys.
            backend["filter_by_keys"] = fbk
            ds = xr.open_dataset(path, engine="cfgrib", backend_kwargs=backend)

        names = list(ds.data_vars)
        if not names:
            raise RuntimeError("no data variables in GRIB")
        da = ds[names[0]]
        # Drop any singleton dims (e.g. surface level).
        da = da.squeeze()

        lat = ds["latitude"].values
        lon = ds["longitude"].values
        data = np.asarray(da.values, dtype=np.float64)
        vt = None
        if "valid_time" in ds.coords:
            vt = str(ds["valid_time"].values)
        return lon, lat, data, vt
    finally:
        for p in (path, path + ".idx"):
            try:
                os.remove(p)
            except OSError:
                pass


def render_to_png(model: str, field: str, fhr: int, region: str,
                  ymd: str, hh: str) -> tuple[bytes, dict]:
    if model not in MODELS:
        raise ValueError(f"unknown model {model}")
    if field not in FIELDS:
        raise ValueError(f"unknown field {field}")
    if field not in MODELS[model]["fields"]:
        raise ValueError(f"{field} not available for {model}")
    region = region if region in REGIONS else DEFAULT_REGION
    fcfg = FIELDS[field]

    url = build_url(model, field, fhr, ymd, hh)
    grib = fetch_grib(url)
    lon, lat, data, valid_time = _open_field(grib, field)

    # Normalize longitudes to -180..180 for state-overlay alignment.
    lon = np.where(lon > 180.0, lon - 360.0, lon)

    data = fcfg["xf"](data)
    if fcfg.get("mask_below") is not None:
        data = np.ma.masked_less(data, fcfg["mask_below"])

    west, east, south, north = REGIONS[region]

    fig = plt.figure(figsize=(9, 7), dpi=110)
    ax = fig.add_axes((0.0, 0.0, 1.0, 1.0))
    ax.set_xlim(west, east)
    ax.set_ylim(south, north)
    ax.set_axis_off()
    fig.patch.set_facecolor("#0b1220")
    ax.set_facecolor("#0b1220")

    cmap = fcfg["cmap"]
    norm = Normalize(vmin=fcfg["vmin"], vmax=fcfg["vmax"])

    # Regular 1-D grid (GFS) vs 2-D curvilinear (NAM/HRRR Lambert).
    if lon.ndim == 1 and lat.ndim == 1:
        # Sort lon ascending after the -180..180 wrap so pcolormesh is monotone.
        order = np.argsort(lon)
        lon_s = lon[order]
        data_s = data[:, order]
        mesh = ax.pcolormesh(lon_s, lat, data_s, cmap=cmap, norm=norm, shading="auto")
    else:
        mesh = ax.pcolormesh(lon, lat, data, cmap=cmap, norm=norm, shading="auto")

    # Contour overlay for height/pressure fields.
    if fcfg.get("contour"):
        try:
            if lon.ndim == 1:
                CS = ax.contour(lon_s, lat, data_s, colors="#e5e7eb",
                                linewidths=0.6, alpha=0.7)
            else:
                CS = ax.contour(lon, lat, data, colors="#e5e7eb",
                                linewidths=0.6, alpha=0.7)
            ax.clabel(CS, inline=True, fontsize=6, fmt="%d")
        except Exception:
            pass

    # State boundaries.
    for ring in _load_states():
        ax.plot(ring[:, 0], ring[:, 1], color="#94a3b8", linewidth=0.5, alpha=0.6)

    # Colorbar + title strip drawn as figure overlays.
    cax = fig.add_axes((0.015, 0.04, 0.018, 0.30))
    cb = fig.colorbar(mesh, cax=cax)
    cb.ax.tick_params(labelsize=7, colors="#e5e7eb")
    cb.outline.set_edgecolor("#334155")

    title = f"{MODELS[model]['label']} · {fcfg['label']} ({fcfg['unit']}) · F{fhr:03d} · {ymd} {hh}Z"
    ax.text(0.5, 0.985, title, transform=ax.transAxes, ha="center", va="top",
            fontsize=9, color="#e5e7eb",
            bbox=dict(boxstyle="round,pad=0.3", fc="#0b1220", ec="#334155", alpha=0.85))

    buf = BytesIO()
    fig.savefig(buf, format="png", facecolor="#0b1220")
    plt.close(fig)

    meta = {
        "bounds": {"west": west, "east": east, "south": south, "north": north},
        "valid_time": valid_time,
        "cycle": f"{ymd}{hh}",
        "label": fcfg["label"],
        "unit": fcfg["unit"],
        "source": f"NOMADS {MODELS[model]['label']}",
    }
    return buf.getvalue(), meta


def catalog() -> dict:
    """Machine-readable catalog for the dashboard's select menus."""
    return {
        "regions": [{"key": k, "bounds": v} for k, v in REGIONS.items()],
        "models": [
            {
                "key": mk,
                "label": mv["label"],
                "fhr_max": mv["fhr_max"],
                "fhr_step": mv["fhr_step"],
                "fields": [
                    {"key": fk, "label": FIELDS[fk]["label"], "unit": FIELDS[fk]["unit"],
                     "min_fhr": FIELDS[fk].get("min_fhr", 0)}
                    for fk in mv["fields"]
                ],
            }
            for mk, mv in MODELS.items()
        ],
    }


# --- FastAPI router (caching + walk-back) ---------------------------------
# Imported by main.py. Mirrors the radar /render path: bearer auth, per-key
# lock, render semaphore, Supabase Storage cache. Storage is imported lazily so
# this module stays runnable standalone (the __main__ test path needs no
# Supabase env).

import asyncio  # noqa: E402

from fastapi import APIRouter, Header, HTTPException  # noqa: E402
from pydantic import BaseModel, Field  # noqa: E402

router = APIRouter()
_model_locks: dict[str, asyncio.Lock] = {}
_model_sem = asyncio.Semaphore(2)


class ModelRequest(BaseModel):
    model: str
    field: str
    fhr: int = Field(default=0, ge=0, le=384)
    region: str = DEFAULT_REGION
    cycle: Optional[str] = None  # "YYYYMMDDHH"; None → resolve latest
    force: bool = False


def _cache_id(model: str, field: str, fhr: int, region: str, ymd: str, hh: str) -> str:
    return f"model/{model}/{ymd}{hh}/{region}/{field}_f{fhr:03d}"


def _cycles_to_try(model: str, cycle: Optional[str]) -> list[tuple[str, str]]:
    """Ordered (ymd, hh) candidates: explicit cycle, else latest then older."""
    if cycle and len(cycle) == 10:
        return [(cycle[:8], cycle[8:10])]
    m = MODELS[model]
    step = 1 if len(m["cycles"]) >= 24 else (24 // len(m["cycles"]))
    out: list[tuple[str, str]] = []
    base = datetime.now(timezone.utc)
    ymd, hh = latest_cycle(model, base)
    out.append((ymd, hh))
    # Walk back up to 4 cycles in case the latest run isn't fully posted.
    cur = datetime.strptime(f"{ymd}{hh}", "%Y%m%d%H").replace(tzinfo=timezone.utc)
    for _ in range(4):
        cur = cur - timedelta(hours=step * (24 // len(m["cycles"]) if len(m["cycles"]) < 24 else 1))
        out.append((cur.strftime("%Y%m%d"), f"{cur.hour:02d}"))
    return out


@router.post("/render-model")
async def render_model(req: ModelRequest, authorization: str = Header(default="")) -> dict:
    token = os.environ.get("RENDERER_TOKEN", "")
    if not token or authorization != f"Bearer {token}":
        raise HTTPException(status_code=401, detail="unauthorized")
    if req.model not in MODELS:
        raise HTTPException(status_code=400, detail=f"unknown model {req.model}")
    if req.field not in FIELDS or req.field not in MODELS[req.model]["fields"]:
        raise HTTPException(status_code=400, detail=f"unsupported field {req.field} for {req.model}")

    from storage import fetch_metadata, public_url, upload, upload_metadata

    started = time.time()
    region = req.region if req.region in REGIONS else DEFAULT_REGION
    last_err: Optional[str] = None

    for ymd, hh in _cycles_to_try(req.model, req.cycle):
        cache_id = _cache_id(req.model, req.field, req.fhr, region, ymd, hh)
        asset_path = f"{cache_id}.png"
        meta_path = f"{cache_id}.meta.json"

        if not req.force:
            cached = await fetch_metadata(meta_path)
            if cached:
                return _model_response(req, region, cached, asset_path, public_url,
                                       cached=True, started=started)

        lock = _model_locks.setdefault(cache_id, asyncio.Lock())
        async with lock:
            if not req.force:
                cached = await fetch_metadata(meta_path)
                if cached:
                    return _model_response(req, region, cached, asset_path, public_url,
                                           cached=True, started=started)
            try:
                async with _model_sem:
                    body, meta = await asyncio.to_thread(
                        render_to_png, req.model, req.field, req.fhr, region, ymd, hh,
                    )
            except RuntimeError as e:
                # not_grib / 404 → this cycle isn't posted for this hour; try older.
                last_err = str(e)
                continue
            except Exception as e:
                log_exc = str(e)
                raise HTTPException(status_code=502, detail=f"render_failed: {log_exc}")

            try:
                await upload(asset_path, body, "image/png")
                await upload_metadata(meta_path, meta)
            except Exception as e:
                raise HTTPException(status_code=502, detail=f"upload_failed: {e}")

        if len(_model_locks) > 200:
            _model_locks.clear()
        return _model_response(req, region, meta, asset_path, public_url,
                               cached=False, started=started)

    raise HTTPException(status_code=502, detail=f"no_posted_cycle: {last_err or 'unavailable'}")


def _model_response(req: ModelRequest, region: str, meta: dict, asset_path: str,
                    public_url, *, cached: bool, started: float) -> dict:
    return {
        "model": req.model,
        "field": req.field,
        "fhr": req.fhr,
        "region": region,
        "image_url": public_url(asset_path),
        "bounds": meta.get("bounds", {}),
        "valid_time": meta.get("valid_time"),
        "cycle": meta.get("cycle"),
        "label": meta.get("label"),
        "unit": meta.get("unit"),
        "source": meta.get("source"),
        "cached": cached,
        "render_ms": int((time.time() - started) * 1000),
    }


@router.get("/model-catalog")
def model_catalog() -> dict:
    return catalog()


if __name__ == "__main__":
    model = sys.argv[1] if len(sys.argv) > 1 else "gfs"
    field = sys.argv[2] if len(sys.argv) > 2 else "t2m"
    fhr = int(sys.argv[3]) if len(sys.argv) > 3 else 24
    region = sys.argv[4] if len(sys.argv) > 4 else "midsouth"
    ymd, hh = latest_cycle(model)
    print(f"cycle {ymd} {hh}Z  ->  {model}/{field}/F{fhr:03d}/{region}")
    print(build_url(model, field, fhr, ymd, hh))
    t0 = time.time()
    png, meta = render_to_png(model, field, fhr, region, ymd, hh)
    with open("/tmp/model_test.png", "wb") as f:
        f.write(png)
    print(f"rendered {len(png)} bytes in {int((time.time()-t0)*1000)} ms -> /tmp/model_test.png")
    print(meta)
