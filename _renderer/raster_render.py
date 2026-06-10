"""Mercator-correct PNG raster path for Level II products.

Replaces the matplotlib PolyCollection renderer (png_render.py). Two fixes and
one new capability:

1. **Geolocation**: Mapbox `image` sources interpolate pixel positions
   linearly in *Web Mercator* between the four corner coordinates. The old
   renderer painted rows uniform in latitude (equirectangular), which put
   mid-image echoes up to ~3 km north/south of their true position at
   Mid-South latitudes. Rows here are uniform in mercator-y, so every pixel
   lands where Mapbox will draw it.

2. **Speed/quality**: instead of rasterizing 250k+ gate polygons, each output
   pixel is inverse-mapped to (range, azimuth) and indexed straight into the
   sweep's (ray, gate) array — pure numpy, no matplotlib, ~order-of-magnitude
   faster, and pixel-exact nearest-gate sampling (no anti-alias smear between
   gates).

3. **Value sidecar**: alongside the display PNG we emit a gzipped uint8 grid
   of quantized gate values (0 = no data, 1..255 spans vmin..vmax) on the same
   bounds/projection at half resolution. The dashboard samples it for the
   pointer readout, which PNG mode previously lost — that readout was the only
   reason the heavyweight GeoJSON path existed for refl/vel.

The inverse mapping is the exact inverse of polar.build_geojson's forward
model (local equirectangular with cos(site_lat) fixed), so raster output is
positionally consistent with the GeoJSON path and the couplet detector.
"""

from __future__ import annotations

import gzip
from io import BytesIO
from typing import Any

import numpy as np

import matplotlib

matplotlib.use("Agg")  # No display, headless server.
from matplotlib import image as mpl_image

from polar import (
    COLOR_RANGES,
    MASK_THRESHOLDS,
    MAX_RENDER_RANGE_M,
    PYART_FIELDS,
    _composite_max,
    _enumerate_sweeps,
    _extract_sweep,
)

# Output sizes. 2048 px over a 460 km disk = ~225 m/px, matching super-res
# gate spacing (250 m). The values sidecar is the same grid strided 2× —
# ~450 m/px is plenty for a pointer readout and keeps it ~100 KB gzipped.
RASTER_SIZE = 2048
VALUES_STRIDE = 2

# Reject pixels whose nearest ray is more than this far away in azimuth —
# prevents smearing data across a missing sector. Normal NEXRAD ray spacing
# is 0.5° (super-res) or 1°.
MAX_AZ_GAP_DEG = 2.0

# Display palettes as (value, "#rrggbb") stops in *raw value space*, matching
# the dashboard's Mapbox expressions exactly (lib/radar/layer-styles.ts).
# Adjacent stops like 14.99/15 produce the hard 5-dBZ band edges of the Baron
# palette; np.interp reproduces them faithfully.
_PALETTES: dict[str, list[tuple[float, str]]] = {
    # Baron256 reflectivity (REFL_STOPS).
    "refl": [
        (5.00, "#105F90"), (14.99, "#1FBFFF"),
        (15.00, "#1FDF70"), (34.99, "#005000"),
        (35.00, "#FFFF1F"), (44.99, "#FFAF00"),
        (45.00, "#FF0000"), (54.99, "#C00000"),
        (55.00, "#DF00DF"), (64.99, "#AF00AF"),
        (65.00, "#000000"), (80.00, "#FFFFFF"),
    ],
    # ALPHA-Velo in m/s (VEL_STOPS).
    "vel": [
        (-61.78, "#00009B"),
        (-25.74, "#00FFFF"),
        (-5.15, "#006600"),
        (0.00, "#808080"),
        (5.15, "#600D17"),
        (15.44, "#C80000"),
        (30.89, "#FFFF00"),
        (61.78, "#783C00"),
    ],
    # kk.pal correlation coefficient (CC_STOPS).
    "cc": [
        (0.00, "#FFFFFF"),
        (0.45, "#000000"),
        (0.60, "#0A0ABE"),
        (0.75, "#7878FF"),
        (0.80, "#5FF564"),
        (0.85, "#87D70A"),
        (0.90, "#FFFF00"),
        (0.95, "#FF8C00"),
        (0.97, "#E10300"),
        (0.99, "#8B1E4D"),
        (1.00, "#FFB4D7"),
        (1.05, "#A43696"),
    ],
    # ZDR: same ramp the old PNG path used, expressed in dB.
    "zdr": [
        (-4.0, "#5b21b6"),  # hail / graupel
        (-1.0, "#6b7280"),
        (0.0, "#9ca3af"),   # near-zero
        (1.0, "#22d3ee"),   # drizzle / small drops
        (2.0, "#10b981"),
        (3.0, "#84cc16"),   # rain
        (4.0, "#facc15"),
        (5.0, "#f97316"),   # large drops
        (6.0, "#ef4444"),
        (8.0, "#fbcfe8"),   # very large drops / melting
    ],
    # KDP in °/km.
    "kdp": [
        (-1.0, "#4b5563"),  # noise / negative
        (0.0, "#1f2937"),
        (0.5, "#0ea5e9"),   # light rain
        (1.0, "#10b981"),
        (2.0, "#84cc16"),
        (3.0, "#facc15"),   # heavy
        (4.0, "#f97316"),
        (5.0, "#ec4899"),   # extreme rain rate
    ],
}

_KM_PER_DEG_LAT = 111.0


def _hex_to_rgb(h: str) -> tuple[int, int, int]:
    h = h.lstrip("#")
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def _merc_y(lat_deg: np.ndarray | float):
    lat = np.radians(lat_deg)
    return np.log(np.tan(np.pi / 4 + lat / 2))


def _inv_merc_y(y: np.ndarray):
    return np.degrees(2 * np.arctan(np.exp(y)) - np.pi / 2)


def _build_lut(product: str, vmin: float, vmax: float) -> np.ndarray:
    """RGBA uint8 LUT indexed by quantized value q (0..255, 0 = no data)."""
    stops = _PALETTES[product]
    stop_v = np.array([s[0] for s in stops], dtype=np.float64)
    stop_rgb = np.array([_hex_to_rgb(s[1]) for s in stops], dtype=np.float64)

    q = np.arange(1, 256, dtype=np.float64)
    v = vmin + (q - 1) / 254.0 * (vmax - vmin)

    lut = np.zeros((256, 4), dtype=np.uint8)
    for c in range(3):
        lut[1:, c] = np.clip(np.interp(v, stop_v, stop_rgb[:, c]), 0, 255).astype(np.uint8)

    # Alpha: match the dashboard's reflectivity fade-in (half opacity at
    # 5 dBZ, full by 20 — see buildFillOpacityExpr). Other products opaque.
    if product == "refl":
        alpha = np.clip((v - 5.0) / 15.0, 0.0, 1.0) * 0.5 + 0.5
        lut[1:, 3] = np.round(alpha * 255).astype(np.uint8)
    else:
        lut[1:, 3] = 255
    lut[0] = (0, 0, 0, 0)  # q=0 → transparent / no data
    return lut


def build_raster(
    radar: Any,
    product: str,
    sweep_index: int,
    composite: bool = False,
) -> tuple[bytes, bytes, dict]:
    """Render one sweep (or composite) to (png_bytes, values_gz, metadata).

    metadata: bounds, sweeps, vmin/vmax, sweep_index, values_w/values_h.
    """
    field = PYART_FIELDS[product]
    vmin, vmax = COLOR_RANGES[product]
    threshold = MASK_THRESHOLDS[product]

    site_lat = float(radar.latitude["data"][0])
    site_lon = float(radar.longitude["data"][0])

    sweeps_meta = _enumerate_sweeps(radar, field)

    if composite:
        data, az = _composite_max(radar, field)
    else:
        # Same fallback as the GeoJSON path: if the requested sweep carries no
        # data for this product (VCP 12 surveillance cuts), use the lowest
        # sweep that does.
        valid_indices = {m["index"] for m in sweeps_meta}
        if sweep_index not in valid_indices and sweeps_meta:
            sweep_index = sweeps_meta[0]["index"]
        data, az = _extract_sweep(radar, field, sweep_index)

    ranges_full = np.asarray(radar.range["data"], dtype=np.float64)
    in_range = ranges_full <= MAX_RENDER_RANGE_M
    ranges = ranges_full[in_range]
    if data.shape[1] > len(ranges):
        data = data[:, : len(ranges)]

    order = np.argsort(az)
    az = az[order]
    data = data[order, :]

    # Full-disk bounds (site ± max range). Stable across scans, so successive
    # frames of the same site reuse identical corner coordinates and Mapbox
    # can crossfade without re-anchoring; transparent margins gzip to nothing.
    cos_site_lat = float(np.cos(np.radians(site_lat)))
    r_max_km = MAX_RENDER_RANGE_M / 1000.0
    dlat = r_max_km / _KM_PER_DEG_LAT
    dlon = r_max_km / (_KM_PER_DEG_LAT * cos_site_lat) if cos_site_lat > 1e-9 else 0.0
    bounds = {
        "north": site_lat + dlat,
        "south": site_lat - dlat,
        "east": site_lon + dlon,
        "west": site_lon - dlon,
    }

    base_meta = {
        "bounds": bounds,
        "sweeps": sweeps_meta,
        "vmin": vmin,
        "vmax": vmax,
        "sweep_index": sweep_index,
        "values_w": RASTER_SIZE // VALUES_STRIDE,
        "values_h": RASTER_SIZE // VALUES_STRIDE,
    }

    n_rays, n_gates = data.shape
    if n_rays == 0 or n_gates == 0:
        q = np.zeros((RASTER_SIZE, RASTER_SIZE), dtype=np.uint8)
        return _encode(q, product, vmin, vmax) + (base_meta,)

    # Quantize the sweep once (uint8, 0 = masked). Pixel lookup then indexes
    # this small (rays × gates) array instead of the float field.
    raw = np.asarray(data, dtype=np.float64)
    invalid = np.ma.getmaskarray(data).astype(bool) if hasattr(data, "mask") else np.zeros_like(raw, dtype=bool)
    invalid |= ~np.isfinite(raw)
    if threshold is not None:
        invalid |= raw < threshold
    span = (vmax - vmin) or 1.0
    q_sweep = np.where(
        invalid,
        0,
        1 + np.clip(np.rint((raw - vmin) / span * 254.0), 0, 254),
    ).astype(np.uint8)

    # Output pixel grid: columns uniform in longitude (mercator-x is linear in
    # lon), rows uniform in mercator-y. Row 0 = north (PNG top).
    lon_px = np.linspace(bounds["west"], bounds["east"], RASTER_SIZE, dtype=np.float64)
    y_n, y_s = _merc_y(bounds["north"]), _merc_y(bounds["south"])
    lat_px = _inv_merc_y(np.linspace(y_n, y_s, RASTER_SIZE)).astype(np.float64)

    # Inverse of the forward model in polar.build_geojson.
    east_km = (lon_px[None, :] - site_lon) * _KM_PER_DEG_LAT * cos_site_lat
    north_km = (lat_px[:, None] - site_lat) * _KM_PER_DEG_LAT
    r_m = np.hypot(east_km, north_km) * 1000.0
    az_px = np.degrees(np.arctan2(east_km, north_km)) % 360.0

    # Gate index (uniform spacing — NEXRAD is).
    dr = float(ranges[1] - ranges[0]) if len(ranges) > 1 else 1.0
    gi = np.rint((r_m - float(ranges[0])) / dr).astype(np.int64)
    in_disk = (gi >= 0) & (gi < n_gates) & (r_m <= MAX_RENDER_RANGE_M)
    gi = np.clip(gi, 0, n_gates - 1)

    # Nearest ray by azimuth (wrap-aware) via searchsorted on the sorted rays.
    pos = np.searchsorted(az, az_px.ravel())
    left = (pos - 1) % n_rays
    right = pos % n_rays
    az_flat = az_px.ravel()
    d_left = np.abs(((az[left] - az_flat + 180.0) % 360.0) - 180.0)
    d_right = np.abs(((az[right] - az_flat + 180.0) % 360.0) - 180.0)
    ri = np.where(d_right < d_left, right, left)
    az_dist = np.minimum(d_left, d_right).reshape(az_px.shape)
    ri = ri.reshape(az_px.shape)

    valid = in_disk & (az_dist <= MAX_AZ_GAP_DEG)
    q = np.where(valid, q_sweep[ri, gi], 0).astype(np.uint8)

    png_bytes, values_gz = _encode(q, product, vmin, vmax)
    return png_bytes, values_gz, base_meta


def _encode(q: np.ndarray, product: str, vmin: float, vmax: float) -> tuple[bytes, bytes]:
    """Colorize the quantized grid into the display PNG + gzip the sidecar."""
    lut = _build_lut(product, vmin, vmax)
    rgba = lut[q]  # (H, W, 4) uint8

    png_buf = BytesIO()
    mpl_image.imsave(png_buf, rgba, format="png")

    # Max-pool 2×2 rather than stride so an echo that lights a single display
    # pixel still appears in the sidecar — striding would drop isolated gates
    # and make the pointer readout disagree with visibly painted pixels.
    h, w = q.shape
    values = q.reshape(h // VALUES_STRIDE, VALUES_STRIDE, w // VALUES_STRIDE, VALUES_STRIDE).max(axis=(1, 3))
    gz_buf = BytesIO()
    with gzip.GzipFile(fileobj=gz_buf, mode="wb", compresslevel=6) as gz:
        gz.write(np.ascontiguousarray(values).tobytes())

    return png_buf.getvalue(), gz_buf.getvalue()
