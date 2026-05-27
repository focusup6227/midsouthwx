"""Optional PNG fallback path. Renders the polygon set into a transparent PNG.

The frontend's PNG mode uses Mapbox's image source which warps a single PNG
between four lat/lon corners. So we render polygons on an equirectangular
canvas sized to the polygon bounds, then return that PNG + the same bounds.

PNG mode loses the per-gate value (no pointer-dBZ readout) but is faster to
fetch over slow links since it's a single image, not 250k+ JSON polygons.
"""

from __future__ import annotations

from io import BytesIO
from typing import Any

import matplotlib
import numpy as np

matplotlib.use("Agg")  # No display, headless server.
import matplotlib.pyplot as plt
from matplotlib.collections import PolyCollection
from matplotlib.colors import LinearSegmentedColormap, Normalize

from polar import (
    COLOR_RANGES,
    MASK_THRESHOLDS,
    MAX_RENDER_RANGE_M,
    PYART_FIELDS,
    _composite_max,
    _extract_sweep,
    _gate_range_bounds,
    _ray_az_bounds,
)

PNG_WIDTH = 1600
PNG_HEIGHT = 1600

# Color ramps matching the dashboard's gradients (NWS reflectivity, jet-ish
# velocity, etc.). Kept simple — discrete bands per product.
_CMAPS = {
    "refl": LinearSegmentedColormap.from_list("refl", [
        (0.00, "#3b82f6"),
        (0.20, "#22d3ee"),
        (0.35, "#10b981"),
        (0.50, "#84cc16"),
        (0.65, "#facc15"),
        (0.80, "#f97316"),
        (0.92, "#ef4444"),
        (1.00, "#d946ef"),
    ]),
    "vel": LinearSegmentedColormap.from_list("vel", [
        (0.00, "#16a34a"),
        (0.30, "#22d3ee"),
        (0.50, "#e5e7eb"),
        (0.70, "#fb7185"),
        (1.00, "#b91c1c"),
    ]),
    # Mirror the dashboard's kk.pal correlation-coefficient ramp (see
    # CC_STOPS in app/radar/RadarView.tsx). Stops are in [0, 1] colormap
    # space; the values 0–1.05 map there via Normalize(vmin=0, vmax=1.05),
    # so each ρhv value v is at position v / 1.05.
    "cc": LinearSegmentedColormap.from_list("cc", [
        (0.00 / 1.05, "#FFFFFF"),
        (0.45 / 1.05, "#000000"),
        (0.60 / 1.05, "#0A0ABE"),
        (0.75 / 1.05, "#7878FF"),
        (0.80 / 1.05, "#5FF564"),
        (0.85 / 1.05, "#87D70A"),
        (0.90 / 1.05, "#FFFF00"),
        (0.95 / 1.05, "#FF8C00"),
        (0.97 / 1.05, "#E10300"),
        (0.99 / 1.05, "#8B1E4D"),
        (1.00 / 1.05, "#FFB4D7"),
        (1.00,        "#A43696"),
    ]),
}


def build_png(
    radar: Any,
    product: str,
    sweep_index: int,
    composite: bool = False,
) -> tuple[bytes, dict]:
    field = PYART_FIELDS[product]
    vmin, vmax = COLOR_RANGES[product]
    threshold = MASK_THRESHOLDS[product]

    site_lat = float(radar.latitude["data"][0])
    site_lon = float(radar.longitude["data"][0])

    from polar import _enumerate_sweeps
    sweeps_meta = _enumerate_sweeps(radar, field)

    if composite:
        data, az = _composite_max(radar, field)
    else:
        data, az = _extract_sweep(radar, field, sweep_index)

    ranges_full = np.asarray(radar.range["data"], dtype=np.float64)
    in_range = ranges_full <= MAX_RENDER_RANGE_M
    ranges = ranges_full[in_range]
    if data.shape[1] > len(ranges):
        data = data[:, : len(ranges)]

    order = np.argsort(az)
    az = az[order]
    data = data[order, :]

    if data.size == 0:
        return _blank_png(), {
            "bounds": {"north": site_lat + 0.01, "south": site_lat - 0.01,
                       "east": site_lon + 0.01, "west": site_lon - 0.01},
            "sweeps": sweeps_meta,
            "vmin": vmin,
            "vmax": vmax,
        }

    az_low, az_high = _ray_az_bounds(az)
    r_low, r_high = _gate_range_bounds(ranges)

    cos_site_lat = np.cos(np.radians(site_lat))
    lat_per_km = 1.0 / 111.0
    lon_per_km = 1.0 / (111.0 * cos_site_lat) if cos_site_lat > 1e-9 else 0.0

    # Build the polygon list. Mirrors polar.build_geojson but in matplotlib's
    # vertex-array shape: (N_polys, 4, 2).
    sin_low = np.sin(np.radians(az_low))
    cos_low = np.cos(np.radians(az_low))
    sin_high = np.sin(np.radians(az_high))
    cos_high = np.cos(np.radians(az_high))

    raw = np.asarray(data)
    mask = np.ma.getmaskarray(data) if hasattr(data, "mask") else np.zeros_like(raw, dtype=bool)
    if threshold is not None:
        mask = mask | (raw < threshold)
    mask = mask | (~np.isfinite(raw))

    valid_idx = np.argwhere(~mask)
    if len(valid_idx) == 0:
        return _blank_png(), {
            "bounds": {"north": site_lat + 0.01, "south": site_lat - 0.01,
                       "east": site_lon + 0.01, "west": site_lon - 0.01},
            "sweeps": sweeps_meta,
            "vmin": vmin,
            "vmax": vmax,
        }

    ri = valid_idx[:, 0]
    gi = valid_idx[:, 1]
    rl_km = r_low[gi] / 1000.0
    rh_km = r_high[gi] / 1000.0
    sl = sin_low[ri]
    cl = cos_low[ri]
    sh = sin_high[ri]
    ch = cos_high[ri]

    lon_a = site_lon + rl_km * sl * lon_per_km
    lat_a = site_lat + rl_km * cl * lat_per_km
    lon_b = site_lon + rh_km * sl * lon_per_km
    lat_b = site_lat + rh_km * cl * lat_per_km
    lon_c = site_lon + rh_km * sh * lon_per_km
    lat_c = site_lat + rh_km * ch * lat_per_km
    lon_d = site_lon + rl_km * sh * lon_per_km
    lat_d = site_lat + rl_km * ch * lat_per_km

    verts = np.stack([
        np.stack([lon_a, lat_a], axis=-1),
        np.stack([lon_b, lat_b], axis=-1),
        np.stack([lon_c, lat_c], axis=-1),
        np.stack([lon_d, lat_d], axis=-1),
    ], axis=1)
    values = raw[ri, gi]

    lat_min = min(lat_a.min(), lat_b.min(), lat_c.min(), lat_d.min())
    lat_max = max(lat_a.max(), lat_b.max(), lat_c.max(), lat_d.max())
    lon_min = min(lon_a.min(), lon_b.min(), lon_c.min(), lon_d.min())
    lon_max = max(lon_a.max(), lon_b.max(), lon_c.max(), lon_d.max())

    bounds = {
        "north": float(lat_max),
        "south": float(lat_min),
        "east": float(lon_max),
        "west": float(lon_min),
    }

    cmap = _CMAPS[product]
    norm = Normalize(vmin=vmin, vmax=vmax)

    fig = plt.figure(figsize=(PNG_WIDTH / 100, PNG_HEIGHT / 100), dpi=100)
    ax = fig.add_axes((0, 0, 1, 1))
    ax.set_xlim(lon_min, lon_max)
    ax.set_ylim(lat_min, lat_max)
    ax.set_axis_off()
    fig.patch.set_alpha(0)
    ax.patch.set_alpha(0)

    pc = PolyCollection(verts, array=values, cmap=cmap, norm=norm, edgecolors="none")
    ax.add_collection(pc)

    buf = BytesIO()
    fig.savefig(buf, format="png", transparent=True, dpi=100,
                bbox_inches=None, pad_inches=0)
    plt.close(fig)

    return buf.getvalue(), {
        "bounds": bounds,
        "sweeps": sweeps_meta,
        "vmin": vmin,
        "vmax": vmax,
    }


def _blank_png() -> bytes:
    fig = plt.figure(figsize=(1, 1), dpi=10)
    buf = BytesIO()
    fig.savefig(buf, format="png", transparent=True)
    plt.close(fig)
    return buf.getvalue()
