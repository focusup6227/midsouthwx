"""Forecast Skew-T soundings from model GRIB columns.

Pulls a vertical profile (T, RH, U, V across isobaric levels) at a point from a
NOMADS model subset, then renders a MetPy Skew-T with parcel path, CAPE/CIN
shading, a hodograph inset, and computed indices. This replaces the soundings
panel's external links with real forecast soundings the operator can step by
forecast hour.

Auth + caching mirror the model-render path (RENDERER_TOKEN bearer; Supabase
Storage by model/point/fhr/cycle). Runnable standalone:
    python sounding.py gfs 35.15 -90.05 12
"""

from __future__ import annotations

import os
import sys
import tempfile
import time
from io import BytesIO
from typing import Optional
from urllib.parse import urlencode

import httpx
import matplotlib
import numpy as np

matplotlib.use("Agg")
import matplotlib.pyplot as plt

from model_render import NOMADS_BASE, fetch_grib, latest_cycle

# Sounding source models. GFS/NAM carry clean isobaric T/RH/U/V columns via the
# pgrb2/awphys files. HRRR's surface bundle doesn't, so soundings use GFS/NAM.
SND_MODELS = {
    "gfs": {
        "label": "GFS 0.25°", "cgi": "filter_gfs_0p25.pl",
        "dir": "/gfs.{ymd}/{hh}/atmos", "file": "gfs.t{hh}z.pgrb2.0p25.f{fff}",
        "fff": 3, "cycles": [0, 6, 12, 18], "cycle_lag_h": 4,
        "fhr_max": 84, "fhr_step": 3,
    },
    "nam": {
        "label": "NAM 12 km", "cgi": "filter_nam.pl",
        "dir": "/nam.{ymd}", "file": "nam.t{hh}z.awphys{ff}.tm00.grib2",
        "fff": 2, "cycles": [0, 6, 12, 18], "cycle_lag_h": 3,
        "fhr_max": 60, "fhr_step": 3,
    },
}


def _snd_url(model: str, lat: float, lon: float, ymd: str, hh: str, fhr: int) -> str:
    m = SND_MODELS[model]
    fnum = f"{fhr:0{m['fff']}d}"
    # Small subregion around the point keeps the column tiny. GFS subregion
    # longitudes are 0-360.
    lon360 = lon % 360.0
    params = {
        "dir": m["dir"].format(ymd=ymd, hh=hh),
        "file": m["file"].format(hh=hh, fff=fnum, ff=fnum),
        "var_TMP": "on", "var_RH": "on", "var_UGRD": "on", "var_VGRD": "on",
        "subregion": "",
        "toplat": f"{lat + 1.0:.2f}", "bottomlat": f"{lat - 1.0:.2f}",
        "leftlon": f"{lon360 - 1.0:.2f}", "rightlon": f"{lon360 + 1.0:.2f}",
    }
    return f"{NOMADS_BASE}/{m['cgi']}?{urlencode(params)}"


def _extract_column(grib: bytes, lat: float, lon: float):
    """Return dict[level_hPa] -> {t,r,u,v} read nearest the point via eccodes."""
    import eccodes as ec

    with tempfile.NamedTemporaryFile(suffix=".grib2", delete=False) as tf:
        tf.write(grib)
        path = tf.name
    col: dict[int, dict] = {}
    try:
        with open(path, "rb") as f:
            while True:
                gid = ec.codes_grib_new_from_file(f)
                if gid is None:
                    break
                try:
                    if ec.codes_get(gid, "typeOfLevel") != "isobaricInhPa":
                        continue
                    short = ec.codes_get(gid, "shortName")
                    if short not in ("t", "r", "u", "v"):
                        continue
                    lvl = int(ec.codes_get(gid, "level"))
                    val = ec.codes_grib_find_nearest(gid, lat, lon)[0].value
                    col.setdefault(lvl, {})[short] = float(val)
                except Exception:
                    pass
                finally:
                    ec.codes_release(gid)
    finally:
        try:
            os.remove(path)
        except OSError:
            pass
    return col


def render_sounding(model: str, lat: float, lon: float, ymd: str, hh: str,
                    fhr: int) -> tuple[bytes, dict]:
    if model not in SND_MODELS:
        raise ValueError(f"unknown sounding model {model}")
    import metpy.calc as mpcalc
    from metpy.plots import Hodograph, SkewT
    from metpy.units import units
    from mpl_toolkits.axes_grid1.inset_locator import inset_axes

    grib = fetch_grib(_snd_url(model, lat, lon, ymd, hh, fhr), timeout=30.0)
    col = _extract_column(grib, lat, lon)

    # Keep levels that have all four fields; sort surface->top (desc pressure).
    levels = sorted([lv for lv, d in col.items() if {"t", "r", "u", "v"} <= d.keys()], reverse=True)
    if len(levels) < 5:
        raise RuntimeError(f"insufficient column ({len(levels)} levels)")

    p = np.array(levels, dtype=float)
    T = np.array([col[lv]["t"] for lv in levels]) - 273.15
    RH = np.clip(np.array([col[lv]["r"] for lv in levels]), 1, 100)
    u = np.array([col[lv]["u"] for lv in levels]) * 1.94384  # m/s -> kt
    v = np.array([col[lv]["v"] for lv in levels]) * 1.94384

    pq = p * units.hPa
    Tq = T * units.degC
    Tdq = mpcalc.dewpoint_from_relative_humidity(Tq, RH * units.percent)
    uq = u * units.knots
    vq = v * units.knots

    # Indices (best-effort; parcel calcs can fail on odd columns).
    cape = cin = lcl_p = li = None
    prof = None
    try:
        prof = mpcalc.parcel_profile(pq, Tq[0], Tdq[0]).to("degC")
        cape, cin = mpcalc.surface_based_cape_cin(pq, Tq, Tdq)
        lcl_p, _ = mpcalc.lcl(pq[0], Tq[0], Tdq[0])
        li = mpcalc.lifted_index(pq, Tq, prof)
    except Exception:
        pass

    fig = plt.figure(figsize=(8, 9), dpi=110)
    fig.patch.set_facecolor("#0b1220")
    skew = SkewT(fig, rotation=45, rect=(0.06, 0.06, 0.66, 0.88))
    skew.ax.set_facecolor("#0b1220")
    for spine in skew.ax.spines.values():
        spine.set_color("#334155")
    skew.ax.tick_params(colors="#e5e7eb", labelsize=8)
    skew.ax.set_xlabel("Temperature (°C)", color="#e5e7eb", fontsize=9)
    skew.ax.set_ylabel("Pressure (hPa)", color="#e5e7eb", fontsize=9)

    skew.plot(pq, Tq, "#f87171", linewidth=2)       # temperature (red)
    skew.plot(pq, Tdq, "#34d399", linewidth=2)      # dewpoint (green)
    skew.plot_barbs(pq[::2], uq[::2], vq[::2], barbcolor="#e5e7eb", flagcolor="#e5e7eb")
    if prof is not None:
        skew.plot(pq, prof, "#fbbf24", linewidth=1.4, linestyle="--")  # parcel
        try:
            skew.shade_cape(pq, Tq, prof, alpha=0.2, color="#ef4444")
            skew.shade_cin(pq, Tq, prof, Tdq, alpha=0.2, color="#3b82f6")
        except Exception:
            pass
    skew.plot_dry_adiabats(color="#475569", alpha=0.4, linewidth=0.5)
    skew.plot_moist_adiabats(color="#1e7a5a", alpha=0.4, linewidth=0.5)
    skew.plot_mixing_lines(color="#7c5e2a", alpha=0.4, linewidth=0.5)
    skew.ax.set_ylim(1000, 100)
    skew.ax.set_xlim(-40, 45)

    # Hodograph inset (0-10 km wind).
    try:
        ax_hod = inset_axes(skew.ax, "38%", "30%", loc="upper right")
        ax_hod.set_facecolor("#0b1220")
        h = Hodograph(ax_hod, component_range=60.0)
        h.add_grid(increment=20, color="#334155")
        h.plot(uq, vq, color="#fbbf24", linewidth=1.5)
        ax_hod.tick_params(colors="#64748b", labelsize=5)
    except Exception:
        pass

    # Index readout.
    def fmt(q, unit, n=0):
        try:
            return f"{q.to(unit).magnitude:.{n}f}"
        except Exception:
            return "n/a"

    lines = [
        f"{SND_MODELS[model]['label']}  F{fhr:03d}  {ymd} {hh}Z",
        f"{lat:.2f}N {abs(lon):.2f}W",
        f"SBCAPE {fmt(cape,'joule/kilogram') if cape is not None else 'n/a'} J/kg",
        f"SBCIN  {fmt(cin,'joule/kilogram') if cin is not None else 'n/a'} J/kg",
        f"LI     {fmt(li[0],'delta_degC',1) if li is not None else 'n/a'}",
        f"LCL    {fmt(lcl_p,'hPa') if lcl_p is not None else 'n/a'} hPa",
    ]
    fig.text(0.75, 0.40, "\n".join(lines), color="#e5e7eb", fontsize=9,
             family="monospace", va="top",
             bbox=dict(boxstyle="round,pad=0.5", fc="#111827", ec="#334155"))

    buf = BytesIO()
    fig.savefig(buf, format="png", facecolor="#0b1220")
    plt.close(fig)

    meta = {
        "model": SND_MODELS[model]["label"],
        "cycle": f"{ymd}{hh}",
        "fhr": fhr,
        "point": {"lat": round(lat, 3), "lon": round(lon, 3)},
        "sbcape": None if cape is None else round(float(cape.to("joule/kilogram").magnitude)),
        "sbcin": None if cin is None else round(float(cin.to("joule/kilogram").magnitude)),
        "source": f"NOMADS {SND_MODELS[model]['label']}",
    }
    return buf.getvalue(), meta


# --- FastAPI router --------------------------------------------------------

import asyncio  # noqa: E402

from fastapi import APIRouter, Header, HTTPException  # noqa: E402
from pydantic import BaseModel, Field  # noqa: E402

router = APIRouter()
_snd_locks: dict[str, asyncio.Lock] = {}
_snd_sem = asyncio.Semaphore(2)


class SoundingRequest(BaseModel):
    model: str = "gfs"
    lat: float
    lon: float
    fhr: int = Field(default=0, ge=0, le=84)
    cycle: Optional[str] = None
    force: bool = False


def _snd_cycles(model: str, cycle: Optional[str]) -> list[tuple[str, str]]:
    if cycle and len(cycle) == 10:
        return [(cycle[:8], cycle[8:10])]
    from datetime import datetime, timedelta, timezone
    out = []
    ymd, hh = latest_cycle(model)
    out.append((ymd, hh))
    cur = datetime.strptime(f"{ymd}{hh}", "%Y%m%d%H").replace(tzinfo=timezone.utc)
    nc = len(SND_MODELS[model]["cycles"])
    for _ in range(3):
        cur = cur - timedelta(hours=24 // nc)
        out.append((cur.strftime("%Y%m%d"), f"{cur.hour:02d}"))
    return out


@router.post("/render-sounding")
async def render_sounding_route(req: SoundingRequest, authorization: str = Header(default="")) -> dict:
    token = os.environ.get("RENDERER_TOKEN", "")
    if not token or authorization != f"Bearer {token}":
        raise HTTPException(status_code=401, detail="unauthorized")
    if req.model not in SND_MODELS:
        raise HTTPException(status_code=400, detail=f"unknown model {req.model}")

    from storage import fetch_metadata, public_url, upload, upload_metadata

    started = time.time()
    last_err = None
    for ymd, hh in _snd_cycles(req.model, req.cycle):
        cache_id = f"sounding/{req.model}/{ymd}{hh}/{req.lat:.2f}_{req.lon:.2f}_f{req.fhr:03d}"
        asset_path, meta_path = f"{cache_id}.png", f"{cache_id}.meta.json"

        if not req.force:
            cached = await fetch_metadata(meta_path)
            if cached:
                return {**cached, "image_url": public_url(asset_path), "cached": True,
                        "render_ms": int((time.time() - started) * 1000)}

        lock = _snd_locks.setdefault(cache_id, asyncio.Lock())
        async with lock:
            if not req.force:
                cached = await fetch_metadata(meta_path)
                if cached:
                    return {**cached, "image_url": public_url(asset_path), "cached": True,
                            "render_ms": int((time.time() - started) * 1000)}
            try:
                async with _snd_sem:
                    body, meta = await asyncio.to_thread(
                        render_sounding, req.model, req.lat, req.lon, ymd, hh, req.fhr)
            except RuntimeError as e:
                last_err = str(e)
                continue
            except Exception as e:
                raise HTTPException(status_code=502, detail=f"render_failed: {e}")
            try:
                await upload(asset_path, body, "image/png")
                await upload_metadata(meta_path, meta)
            except Exception as e:
                raise HTTPException(status_code=502, detail=f"upload_failed: {e}")
        if len(_snd_locks) > 200:
            _snd_locks.clear()
        return {**meta, "image_url": public_url(asset_path), "cached": False,
                "render_ms": int((time.time() - started) * 1000)}

    raise HTTPException(status_code=502, detail=f"no_posted_cycle: {last_err or 'unavailable'}")


if __name__ == "__main__":
    model = sys.argv[1] if len(sys.argv) > 1 else "gfs"
    lat = float(sys.argv[2]) if len(sys.argv) > 2 else 35.15
    lon = float(sys.argv[3]) if len(sys.argv) > 3 else -90.05
    fhr = int(sys.argv[4]) if len(sys.argv) > 4 else 12
    ymd, hh = latest_cycle(model)
    print(f"sounding {model} {ymd} {hh}Z F{fhr:03d} at {lat},{lon}")
    t0 = time.time()
    png, meta = render_sounding(model, lat, lon, ymd, hh, fhr)
    with open("/tmp/sounding_test.png", "wb") as f:
        f.write(png)
    print(f"rendered {len(png)} bytes in {int((time.time()-t0)*1000)} ms -> /tmp/sounding_test.png")
    print(meta)
