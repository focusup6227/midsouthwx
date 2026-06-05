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
_WIND = LinearSegmentedColormap.from_list("wind", [
    "#0b1220", "#1d4ed8", "#0891b2", "#10b981", "#fde047", "#f97316", "#dc2626", "#a21caf",
])
_DEWP = LinearSegmentedColormap.from_list("dewp", [
    "#7f1d1d", "#b45309", "#a3a30a", "#10b981", "#0891b2", "#1d4ed8", "#4c1d95",
])
# Upper-air / synoptic ramps.
_VORT = LinearSegmentedColormap.from_list("vort", [
    "#0b1220", "#334155", "#fde047", "#f97316", "#ef4444", "#a21caf",
])  # absolute vorticity (cyclonic lobes warm)
_OMEGA = LinearSegmentedColormap.from_list("omega", [
    "#1d4ed8", "#60a5fa", "#dbeafe", "#0b1220", "#fecaca", "#f87171", "#b91c1c",
])  # diverging; blue = ascent (omega < 0), red = descent
_LI = LinearSegmentedColormap.from_list("li", [
    "#7f1d1d", "#ef4444", "#fca5a5", "#0b1220", "#bfdbfe", "#3b82f6", "#1e3a8a",
])  # diverging; red = negative LI (unstable)
_RH = LinearSegmentedColormap.from_list("rhmoist", [
    "#451a03", "#92400e", "#ca8a04", "#fef9c3", "#86efac", "#16a34a", "#064e3b",
])
_THETAE = LinearSegmentedColormap.from_list("thetae", [
    "#1e3a8a", "#0891b2", "#10b981", "#a3e635", "#fde047", "#f97316", "#dc2626",
])
_PWAT = LinearSegmentedColormap.from_list("pwat", [
    "#0b1220", "#78350f", "#ca8a04", "#16a34a", "#0891b2", "#1d4ed8", "#7c3aed",
])

# --- field catalog --------------------------------------------------------
# Each field: NOMADS var/level filter flags, a transform from GRIB native
# units to display units, a colormap + value range, and a label/unit. `fbk`
# is a cfgrib filter_by_keys fallback used only when a narrow subset still
# decodes to multiple messages.

FIELDS: dict[str, dict] = {
    # --- Surface ---
    "t2m": {
        "label": "2 m Temperature", "unit": "°F", "group": "Surface",
        "var": "TMP", "lev": "2_m_above_ground",
        "fbk": {"typeOfLevel": "heightAboveGround", "level": 2},
        "xf": lambda a: a * 9.0 / 5.0 - 459.67,  # K -> °F
        "cmap": _THERMAL, "vmin": 10, "vmax": 110,
    },
    "dewp2m": {
        "label": "2 m Dewpoint", "unit": "°F", "group": "Surface",
        "var": "DPT", "lev": "2_m_above_ground",
        "fbk": {"typeOfLevel": "heightAboveGround", "level": 2},
        "xf": lambda a: a * 9.0 / 5.0 - 459.67,  # K -> °F
        "cmap": _DEWP, "vmin": 20, "vmax": 80,
    },
    # Wind is a two-component field: speed shaded, barbs overlaid. `vars`
    # (plural) signals the multi-message read path in _open_wind.
    "wind10m": {
        "label": "10 m Wind", "unit": "kt", "group": "Surface",
        "vars": ["UGRD", "VGRD"], "lev": "10_m_above_ground",
        "wind": True,
        "cmap": _WIND, "vmin": 0, "vmax": 60,
    },
    "mslp": {
        "label": "MSLP", "unit": "hPa", "group": "Surface",
        "var": "PRMSL", "lev": "mean_sea_level",
        "fbk": {"typeOfLevel": "meanSea"},
        "xf": lambda a: a / 100.0,  # Pa -> hPa
        "cmap": "viridis", "vmin": 980, "vmax": 1040, "contour": True,
    },
    # --- Upper air ---
    "jet250": {
        "label": "250 hPa Jet", "unit": "kt", "group": "Upper air",
        "vars": ["UGRD", "VGRD"], "lev": "250_mb",
        "wind": True,
        "cmap": _WIND, "vmin": 30, "vmax": 150,  # only jet-strength winds colored
    },
    "vort500": {
        "label": "500 hPa Vorticity + Height", "unit": "×10⁻⁵ s⁻¹", "group": "Upper air",
        "vars": ["ABSV", "HGT"], "lev": "500_mb",
        "shade_overlay": True, "shade_sn": "absv", "overlay_sn": "gh",
        "xf_factor": 1e5, "overlay_factor": 0.1,  # ABSV→1e-5 s⁻¹ ; HGT m→dam
        "cmap": _VORT, "vmin": 0, "vmax": 50,
    },
    "hgt500": {
        "label": "500 hPa height", "unit": "dam", "group": "Upper air",
        "var": "HGT", "lev": "500_mb",
        "fbk": {"typeOfLevel": "isobaricInhPa", "level": 500},
        "xf": lambda a: a / 10.0,  # m -> dam
        "cmap": _HGT, "vmin": 510, "vmax": 600, "contour": True,
    },
    "omega700": {
        "label": "700 hPa Omega", "unit": "Pa/s", "group": "Upper air",
        "var": "VVEL", "lev": "700_mb",
        "fbk": {"typeOfLevel": "isobaricInhPa", "level": 700},
        "xf": lambda a: a,  # Pa/s; blue = ascent (omega < 0)
        "cmap": _OMEGA, "vmin": -1.5, "vmax": 1.5,
    },
    "rh700": {
        "label": "700 hPa RH", "unit": "%", "group": "Upper air",
        "var": "RH", "lev": "700_mb",
        "fbk": {"typeOfLevel": "isobaricInhPa", "level": 700},
        "xf": lambda a: a,
        "cmap": _RH, "vmin": 0, "vmax": 100,
    },
    "t850": {
        "label": "850 hPa Temperature", "unit": "°C", "group": "Upper air",
        "var": "TMP", "lev": "850_mb",
        "fbk": {"typeOfLevel": "isobaricInhPa", "level": 850},
        "xf": lambda a: a - 273.15,  # K -> °C
        "cmap": _THERMAL, "vmin": -10, "vmax": 35, "contour": True,
    },
    "thetae850": {
        "label": "850 hPa θe + wind", "unit": "K", "group": "Upper air",
        "vars": ["TMP", "RH", "UGRD", "VGRD"], "lev": "850_mb",
        "thetae": True, "level_hpa": 850,
        "cmap": _THETAE, "vmin": 300, "vmax": 345,
    },
    # --- Convective ---
    "cape": {
        "label": "Surface CAPE", "unit": "J/kg", "group": "Convective",
        "var": "CAPE", "lev": "surface",
        "fbk": {"typeOfLevel": "surface"},
        "xf": lambda a: a,
        "cmap": _CAPE, "vmin": 0, "vmax": 4000,
    },
    "li": {
        "label": "Lifted Index", "unit": "°C", "group": "Convective",
        "var": "4LFTX", "lev": "surface",
        "fbk": {"typeOfLevel": "surface"},
        "xf": lambda a: a,  # negative = unstable (red)
        "cmap": _LI, "vmin": -10, "vmax": 10,
    },
    "refc": {
        "label": "Composite reflectivity", "unit": "dBZ", "group": "Convective",
        "var": "REFC", "lev": "entire_atmosphere",
        "fbk": {},
        "xf": lambda a: a,
        "cmap": _REFL, "vmin": 5, "vmax": 75, "mask_below": 5,
    },
    # --- Moisture & precip ---
    "pwat": {
        "label": "Precipitable Water", "unit": "in", "group": "Moisture & precip",
        "var": "PWAT", "lev": "entire_atmosphere_(considered_as_a_single_layer)",
        "fbk": {},
        "xf": lambda a: a / 25.4,  # mm -> in
        "cmap": _PWAT, "vmin": 0, "vmax": 2.5,
    },
    "apcp": {
        "label": "Accumulated precip", "unit": "in", "group": "Moisture & precip",
        "var": "APCP", "lev": "surface",
        "fbk": {"stepType": "accum"},
        "xf": lambda a: a / 25.4,  # mm -> in
        "cmap": _PRECIP, "vmin": 0, "vmax": 3, "min_fhr": 1,
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
        "fields": ["t2m", "dewp2m", "wind10m", "mslp", "jet250", "vort500", "hgt500",
                   "omega700", "rh700", "t850", "thetae850", "cape", "li", "pwat", "apcp"],
    },
    "nam": {
        "label": "NAM 12 km",
        "cgi": "filter_nam.pl",
        "dir": "/nam.{ymd}",
        "file": "nam.t{hh}z.awphys{ff}.tm00.grib2",
        "fff": 2,
        "cycles": [0, 6, 12, 18], "cycle_lag_h": 3,
        "fhr_max": 60, "fhr_step": 3,
        "fields": ["t2m", "dewp2m", "wind10m", "mslp", "jet250", "vort500", "hgt500",
                   "omega700", "rh700", "t850", "thetae850", "cape", "li", "pwat", "apcp"],
    },
    "hrrr": {
        "label": "HRRR 3 km",
        "cgi": "filter_hrrr_2d.pl",
        "dir": "/hrrr.{ymd}/conus",
        "file": "hrrr.t{hh}z.wrfsfcf{ff}.grib2",
        "fff": 2,
        "cycles": list(range(24)), "cycle_lag_h": 2,
        "fhr_max": 18, "fhr_step": 1,
        "fields": ["t2m", "dewp2m", "wind10m", "refc", "cape"],
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
        f"lev_{f['lev']}": "on",
    }
    # Single-var fields use `var`; wind (and any future multi-var field) uses `vars`.
    for v in (f["vars"] if "vars" in f else [f["var"]]):
        params[f"var_{v}"] = "on"
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


def _open_wind(grib_bytes: bytes):
    """Decode a 2-component wind GRIB subset to (lon, lat, u, v, valid_time)."""
    import xarray as xr

    with tempfile.NamedTemporaryFile(suffix=".grib2", delete=False) as tf:
        tf.write(grib_bytes)
        path = tf.name
    try:
        ds = xr.open_dataset(path, engine="cfgrib", backend_kwargs={"indexpath": ""})
        u = v = None
        for name in ds.data_vars:
            da = ds[name].squeeze()
            sn = str(da.attrs.get("standard_name", "")).lower()
            if "eastward" in sn or name.lower().startswith("u"):
                u = da
            elif "northward" in sn or name.lower().startswith("v"):
                v = da
        if u is None or v is None:
            raise RuntimeError("wind components not found in GRIB")
        lat = ds["latitude"].values
        lon = ds["longitude"].values
        vt = str(ds["valid_time"].values) if "valid_time" in ds.coords else None
        return lon, lat, np.asarray(u.values, float), np.asarray(v.values, float), vt
    finally:
        for p in (path, path + ".idx"):
            try:
                os.remove(p)
            except OSError:
                pass


def _open_multi(grib_bytes: bytes):
    """Decode a multi-variable GRIB subset to (lon, lat, {shortName: data2d}, valid_time).

    Used for fields that need more than one message at a level: vorticity+height
    overlay (ABSV+HGT) and derived theta-e (TMP+RH+UGRD+VGRD).
    """
    import xarray as xr

    with tempfile.NamedTemporaryFile(suffix=".grib2", delete=False) as tf:
        tf.write(grib_bytes)
        path = tf.name
    try:
        ds = xr.open_dataset(path, engine="cfgrib", backend_kwargs={"indexpath": ""})
        out = {str(name): np.asarray(ds[name].squeeze().values, dtype=float) for name in ds.data_vars}
        lat = ds["latitude"].values
        lon = ds["longitude"].values
        vt = str(ds["valid_time"].values) if "valid_time" in ds.coords else None
        return lon, lat, out, vt
    finally:
        for p in (path, path + ".idx"):
            try:
                os.remove(p)
            except OSError:
                pass


def _pick(vmap: dict, sn: str):
    """Fetch a variable from an _open_multi map by cfgrib shortName (case-insensitive)."""
    if sn in vmap:
        return vmap[sn]
    for k in vmap:
        if k.lower() == sn.lower():
            return vmap[k]
    raise RuntimeError(f"variable '{sn}' not in GRIB (have {list(vmap)})")


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

    is_wind = bool(fcfg.get("wind"))
    is_shov = bool(fcfg.get("shade_overlay"))
    is_thetae = bool(fcfg.get("thetae"))
    MS_TO_KT = 1.94384
    u_kt = v_kt = overlay_data = None

    if is_wind:
        lon, lat, u, v, valid_time = _open_wind(grib)
        u_kt, v_kt = u * MS_TO_KT, v * MS_TO_KT
        data = np.hypot(u_kt, v_kt)  # wind speed (kt), shaded
    elif is_shov:
        # Shade one field, contour another (e.g. 500 hPa vorticity + height).
        lon, lat, vmap, valid_time = _open_multi(grib)
        data = _pick(vmap, fcfg["shade_sn"]) * fcfg.get("xf_factor", 1.0)
        overlay_data = _pick(vmap, fcfg["overlay_sn"]) * fcfg.get("overlay_factor", 1.0)
    elif is_thetae:
        # Derived equivalent potential temperature + wind barbs.
        import metpy.calc as mpcalc
        from metpy.units import units
        lon, lat, vmap, valid_time = _open_multi(grib)
        tk = _pick(vmap, "t")
        rh = np.clip(_pick(vmap, "r"), 1.0, 100.0)
        tq = (tk - 273.15) * units.degC
        td = mpcalc.dewpoint_from_relative_humidity(tq, rh * units.percent)
        the = mpcalc.equivalent_potential_temperature(
            float(fcfg["level_hpa"]) * units.hPa, tq, td)
        data = np.asarray(the.to("kelvin").magnitude, dtype=float)
        try:
            u_kt, v_kt = _pick(vmap, "u") * MS_TO_KT, _pick(vmap, "v") * MS_TO_KT
        except RuntimeError:
            pass
    else:
        lon, lat, data, valid_time = _open_field(grib, field)
        data = fcfg["xf"](data)
        if fcfg.get("mask_below") is not None:
            data = np.ma.masked_less(data, fcfg["mask_below"])

    # Normalize longitudes to -180..180 for state-overlay alignment.
    lon = np.where(lon > 180.0, lon - 360.0, lon)
    # Sort index for regular 1-D grids (GFS); None for 2-D curvilinear (NAM/HRRR).
    order = np.argsort(lon) if lon.ndim == 1 else None

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

    def _xy(a):
        """Return (X, Y, A) ready for pcolormesh/contour, lon-sorted if 1-D."""
        if order is not None:
            return lon[order], lat, a[:, order]
        return lon, lat, a

    X, Y, A = _xy(data)
    mesh = ax.pcolormesh(X, Y, A, cmap=cmap, norm=norm, shading="auto")

    # Same-field contour (height/pressure/temperature fields).
    if fcfg.get("contour"):
        try:
            CS = ax.contour(X, Y, A, colors="#e5e7eb", linewidths=0.6, alpha=0.7)
            ax.clabel(CS, inline=True, fontsize=6, fmt="%d")
        except Exception:
            pass

    # Overlay-field contour (e.g. 500 hPa height drawn over vorticity shading).
    if overlay_data is not None:
        try:
            OX, OY, OA = _xy(overlay_data)
            CS = ax.contour(OX, OY, OA, colors="#e5e7eb", linewidths=0.7, alpha=0.85)
            ax.clabel(CS, inline=True, fontsize=6, fmt="%d")
        except Exception:
            pass

    # Wind barbs (wind fields and derived θe-with-wind), subsampled for legibility.
    if u_kt is not None:
        BX, BY, UU = _xy(u_kt)
        _, _, VV = _xy(v_kt)
        if BX.ndim == 1:
            BX, BY = np.meshgrid(BX, BY)
        ny, nx = BX.shape
        sx, sy = max(1, nx // 18), max(1, ny // 14)
        ax.barbs(
            BX[::sy, ::sx], BY[::sy, ::sx], UU[::sy, ::sx], VV[::sy, ::sx],
            length=6.5, linewidth=0.7, color="#f8fafc",
        )

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


# --- point sampling for severe-weather params (AI draft grounding) ---------
# HRRR wrfsfc carries the kinematic ingredients Open-Meteo lacks: storm-relative
# helicity (HLCY) and bulk-shear components (VUCSH/VVCSH), plus CAPE/CIN. We
# fetch a multi-field GRIB subset and read the value nearest a point with
# eccodes' find_nearest — far simpler than xarray for scattered point reads.

SAMPLE_VARS = ["CAPE", "CIN", "HLCY", "VUCSH", "VVCSH", "TMP", "DPT"]
SAMPLE_LEVS = [
    "surface",
    "2_m_above_ground",
    "3000-0_m_above_ground",
    "1000-0_m_above_ground",
    "0-6000_m_above_ground",
    "0-1000_m_above_ground",
    "180-0_mb_above_ground",   # MLCAPE/MLCIN (key 18000 Pa)
    "255-0_mb_above_ground",   # MUCAPE/MUCIN (key 25500 Pa)
]


def _sample_url(ymd: str, hh: str, fhr: int) -> str:
    from urllib.parse import urlencode
    params = {
        "dir": f"/hrrr.{ymd}/conus",
        "file": f"hrrr.t{hh}z.wrfsfcf{fhr:02d}.grib2",
    }
    for v in SAMPLE_VARS:
        params[f"var_{v}"] = "on"
    for lv in SAMPLE_LEVS:
        params[f"lev_{lv}"] = "on"
    return f"{NOMADS_BASE}/filter_hrrr_2d.pl?{urlencode(params)}"


def sample_point(lat: float, lon: float, ymd: str, hh: str, fhr: int = 0) -> dict:
    """Read HRRR severe-storm ingredients nearest (lat, lon). Raises on no-GRIB."""
    import eccodes as ec

    grib = fetch_grib(_sample_url(ymd, hh, fhr))
    MS_TO_KT = 1.94384
    with tempfile.NamedTemporaryFile(suffix=".grib2", delete=False) as tf:
        tf.write(grib)
        path = tf.name

    vals: dict[tuple, float] = {}
    valid_time = None
    try:
        with open(path, "rb") as f:
            while True:
                gid = ec.codes_grib_new_from_file(f)
                if gid is None:
                    break
                try:
                    short = ec.codes_get(gid, "shortName")
                    # Layer fields encode the depth as top/bottom fixed surfaces,
                    # and the non-zero bound isn't consistently top vs bottom
                    # (HLCY is "3000-0", shear is "0-6000"). Key on the non-zero
                    # bound so 0-1km/0-3km/0-6km layers stay distinct.
                    try:
                        top = max(ec.codes_get(gid, "topLevel"), ec.codes_get(gid, "bottomLevel"))
                    except Exception:
                        top = ec.codes_get(gid, "level")
                    if valid_time is None:
                        try:
                            valid_time = f"{ec.codes_get(gid, 'validityDate')}{ec.codes_get(gid, 'validityTime'):04d}"
                        except Exception:
                            pass
                    near = ec.codes_grib_find_nearest(gid, lat, lon)[0]
                    vals[(short, int(top))] = float(near.value)
                finally:
                    ec.codes_release(gid)
    finally:
        try:
            os.remove(path)
        except OSError:
            pass

    def g(short: str, top: int) -> float | None:
        v = vals.get((short, top))
        return None if v is None or v != v else v  # drop NaN

    def shear_kt(top: int) -> float | None:
        u, v = g("vucsh", top), g("vvcsh", top)
        if u is None or v is None:
            return None
        return round((u * u + v * v) ** 0.5 * MS_TO_KT, 1)

    sbcape = g("cape", 0)
    sbcin = g("cin", 0)
    mlcape = g("cape", 18000)
    mlcin = g("cin", 18000)
    mucape = g("cape", 25500)
    srh01 = g("hlcy", 1000)
    srh03 = g("hlcy", 3000)
    sh06_kt = shear_kt(6000)
    sh06_mps = None if sh06_kt is None else sh06_kt / MS_TO_KT

    # LCL height (m AGL) via Espy: ~125 m per °C of surface T-Td spread.
    t2, td2 = g("2t", 2), g("2d", 2)
    lcl_m = None if (t2 is None or td2 is None) else max(0.0, 125.0 * (t2 - td2))

    stp = _fixed_stp(sbcape, sbcin, srh01, sh06_mps, lcl_m)
    scp = _fixed_scp(mucape if mucape is not None else sbcape, srh03, sh06_mps)

    return {
        "model": "HRRR 3 km",
        "cycle": f"{ymd}{hh}",
        "fhr": fhr,
        "valid_time": valid_time,
        "point": {"lat": round(lat, 3), "lon": round(lon, 3)},
        "sbcape": None if sbcape is None else round(sbcape),
        "sbcin": None if sbcin is None else round(sbcin),
        "mlcape": None if mlcape is None else round(mlcape),
        "mlcin": None if mlcin is None else round(mlcin),
        "mucape": None if mucape is None else round(mucape),
        "lcl_m": _r(lcl_m),
        "srh_0_1km": _r(srh01),
        "srh_0_3km": _r(srh03),
        "shear_0_1km_kt": shear_kt(1000),
        "shear_0_6km_kt": sh06_kt,
        # Fixed-layer (approximate) composite parameters. Not SPC's effective-
        # layer STP/SCP — SBCAPE/0-1 SRH/0-6 shear/Espy-LCL ingredients.
        "stp_fixed": stp,
        "scp_fixed": scp,
    }


def _fixed_stp(sbcape, sbcin, srh01, sh06_mps, lcl_m):
    """SPC fixed-layer significant tornado parameter (approximate)."""
    if None in (sbcape, srh01, sh06_mps, lcl_m):
        return None
    cape_t = sbcape / 1500.0
    lcl_t = 1.0 if lcl_m < 1000 else (0.0 if lcl_m > 2000 else (2000.0 - lcl_m) / 1000.0)
    srh_t = srh01 / 150.0
    if sh06_mps < 12.5:
        shr_t = 0.0
    elif sh06_mps > 30.0:
        shr_t = 1.5
    else:
        shr_t = sh06_mps / 20.0
    cin = sbcin if sbcin is not None else 0.0
    cin_t = 1.0 if cin > -50 else (0.0 if cin < -200 else (200.0 + cin) / 150.0)
    return round(max(0.0, cape_t * lcl_t * srh_t * shr_t * cin_t), 1)


def _fixed_scp(cape, srh03, sh06_mps):
    """SPC fixed-layer supercell composite parameter (approximate)."""
    if None in (cape, srh03, sh06_mps):
        return None
    cape_t = cape / 1000.0
    srh_t = srh03 / 50.0
    if sh06_mps < 10.0:
        shr_t = 0.0
    elif sh06_mps > 20.0:
        shr_t = 1.0
    else:
        shr_t = sh06_mps / 20.0
    return round(max(0.0, cape_t * srh_t * shr_t), 1)


def _r(v: float | None) -> float | None:
    return None if v is None else round(v)


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
                     "group": FIELDS[fk].get("group", "Other"),
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


class SampleRequest(BaseModel):
    lat: float
    lon: float
    cycle: Optional[str] = None  # "YYYYMMDDHH"; None → latest HRRR
    fhr: int = Field(default=0, ge=0, le=18)


@router.post("/sample-point")
async def sample_point_route(req: SampleRequest, authorization: str = Header(default="")) -> dict:
    token = os.environ.get("RENDERER_TOKEN", "")
    if not token or authorization != f"Bearer {token}":
        raise HTTPException(status_code=401, detail="unauthorized")
    last_err = None
    for ymd, hh in _cycles_to_try("hrrr", req.cycle):
        try:
            return await asyncio.to_thread(sample_point, req.lat, req.lon, ymd, hh, req.fhr)
        except RuntimeError as e:
            last_err = str(e)
            continue
    raise HTTPException(status_code=502, detail=f"no_posted_cycle: {last_err or 'unavailable'}")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "sample":
        lat = float(sys.argv[2]) if len(sys.argv) > 2 else 35.15
        lon = float(sys.argv[3]) if len(sys.argv) > 3 else -90.05
        ymd, hh = latest_cycle("hrrr")
        print(f"HRRR sample cycle {ymd} {hh}Z at {lat},{lon}")
        import json as _json
        print(_json.dumps(sample_point(lat, lon, ymd, hh, 0), indent=2))
        sys.exit(0)
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
