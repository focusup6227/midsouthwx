"""Polar-to-GeoJSON conversion for NEXRAD Level II.

The quality goal: clean tessellation with shared edges between neighboring
azimuth wedges. The old renderer's quilt-look came from each ray computing its
own azimuth half-width independently, leaving sub-degree gaps/overlaps at
shared boundaries. Here we compute boundaries from neighbor midpoints, so
ray i's `az_high` is identical to ray i+1's `az_low` by construction.

Performance: the corner-coordinate math is fully vectorized with numpy so the
~700 k-gate super-res renders don't pay a Python interpreter tax. The final
features list is the only remaining Python loop and orjson handles serialization
(both ~3-5x faster than the stdlib equivalents for an object this size).
"""

from __future__ import annotations

import gzip
from io import BytesIO
from typing import Any

import numpy as np
import orjson

# Py-ART field name per radar product.
PYART_FIELDS = {
    "refl": "reflectivity",
    "vel": "velocity",
    "cc": "cross_correlation_ratio",
}

# Dashboard's color-scale bounds. Returned in the response so the frontend
# doesn't have to know per-product limits.
COLOR_RANGES = {
    "refl": (-32.0, 95.0),   # dBZ
    "vel": (-64.0, 64.0),    # m/s
    "cc": (0.0, 1.05),       # ρhv
}

# Drop gates below threshold to keep the GeoJSON small. None = keep all values.
MASK_THRESHOLDS = {
    "refl": -10.0,
    "vel": None,
    "cc": 0.2,
}

# Max range to render (m). Beyond ~230 km NEXRAD beams are very high above the
# ground and the data is mostly clutter / over-ranged. Trimming keeps payload
# size sane and avoids visually-distracting fringe noise.
MAX_RENDER_RANGE_M = 230_000


def build_geojson(
    radar: Any,
    product: str,
    sweep_index: int,
    composite: bool = False,
) -> tuple[bytes, dict]:
    """Render the requested sweep as gzipped GeoJSON polygons.

    Returns (gzip-compressed bytes, metadata) where metadata has bounds,
    sweeps, feature count, vmin/vmax, and the chosen sweep_index (may differ
    from input when a product-empty sweep was requested).
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
        # Fall back to the lowest sweep that actually contains this product if
        # the caller asked for one without data (VCP 12 sweep 0 is refl-only,
        # for example — vel/cc requested there would return nothing).
        valid_indices = {m["index"] for m in sweeps_meta}
        if sweep_index not in valid_indices and sweeps_meta:
            sweep_index = sweeps_meta[0]["index"]
        data, az = _extract_sweep(radar, field, sweep_index)

    ranges_full = np.asarray(radar.range["data"], dtype=np.float64)
    in_range = ranges_full <= MAX_RENDER_RANGE_M
    ranges = ranges_full[in_range]
    if data.shape[1] > len(ranges):
        data = data[:, : len(ranges)]

    # Sort rays by azimuth so the neighbor-midpoint math (in _ray_az_bounds)
    # produces strictly-increasing boundaries.
    order = np.argsort(az)
    az = az[order]
    data = data[order, :]

    n_rays, n_gates = data.shape
    base_meta = {
        "bounds": _empty_bounds(),
        "sweeps": sweeps_meta,
        "vmin": vmin,
        "vmax": vmax,
        "sweep_index": sweep_index,
    }
    if n_rays == 0 or n_gates == 0:
        return _empty_geojson(), {**base_meta, "count": 0}

    az_low, az_high = _ray_az_bounds(az)        # (n_rays,)
    r_low, r_high = _gate_range_bounds(ranges)  # (n_gates,)

    # Build mask of valid gates (numeric, above threshold, not Py-ART-masked).
    raw = np.asarray(data, dtype=np.float64)
    if hasattr(data, "mask"):
        invalid = np.ma.getmaskarray(data).astype(bool)
    else:
        invalid = np.zeros_like(raw, dtype=bool)
    invalid |= ~np.isfinite(raw)
    if threshold is not None:
        invalid |= raw < threshold

    valid_ri, valid_gi = np.where(~invalid)
    if valid_ri.size == 0:
        return _empty_geojson(), {**base_meta, "count": 0}

    # All polygon-corner math is vectorized. Shapes here are (N_valid,):
    #   az_low_v / az_high_v: azimuth bounds for the ray each valid gate belongs to
    #   r_low_v / r_high_v: range bounds for that gate
    az_low_v = az_low[valid_ri]
    az_high_v = az_high[valid_ri]
    r_low_km = r_low[valid_gi] / 1000.0
    r_high_km = r_high[valid_gi] / 1000.0
    values = raw[valid_ri, valid_gi]

    sin_low = np.sin(np.radians(az_low_v))
    cos_low = np.cos(np.radians(az_low_v))
    sin_high = np.sin(np.radians(az_high_v))
    cos_high = np.cos(np.radians(az_high_v))

    cos_site_lat = np.cos(np.radians(site_lat))
    lat_per_km = 1.0 / 111.0
    lon_per_km = 1.0 / (111.0 * cos_site_lat) if cos_site_lat > 1e-9 else 0.0

    # Four corners. Order matters — clockwise so polygons are right-handed.
    #   A = (range_low, az_low)
    #   B = (range_high, az_low)
    #   C = (range_high, az_high)
    #   D = (range_low, az_high)
    lat_a = site_lat + r_low_km * cos_low * lat_per_km
    lon_a = site_lon + r_low_km * sin_low * lon_per_km
    lat_b = site_lat + r_high_km * cos_low * lat_per_km
    lon_b = site_lon + r_high_km * sin_low * lon_per_km
    lat_c = site_lat + r_high_km * cos_high * lat_per_km
    lon_c = site_lon + r_high_km * sin_high * lon_per_km
    lat_d = site_lat + r_low_km * cos_high * lat_per_km
    lon_d = site_lon + r_low_km * sin_high * lon_per_km

    # Bounding box from min/max of all corner arrays — one numpy pass beats
    # an inline per-feature tracker for 300 k+ features.
    lat_all = np.concatenate([lat_a, lat_b, lat_c, lat_d])
    lon_all = np.concatenate([lon_a, lon_b, lon_c, lon_d])
    bounds = {
        "north": float(lat_all.max()),
        "south": float(lat_all.min()),
        "east": float(lon_all.max()),
        "west": float(lon_all.min()),
    }

    # Round once vector-wide instead of per-feature. round(x, 5) in pure Python
    # was ~30% of total render time on the old per-feature loop.
    lon_a_r = lon_a.round(5).tolist()
    lat_a_r = lat_a.round(5).tolist()
    lon_b_r = lon_b.round(5).tolist()
    lat_b_r = lat_b.round(5).tolist()
    lon_c_r = lon_c.round(5).tolist()
    lat_c_r = lat_c.round(5).tolist()
    lon_d_r = lon_d.round(5).tolist()
    lat_d_r = lat_d.round(5).tolist()
    values_r = values.round(2).tolist()

    # Final dict construction is unavoidably Python — pulling the arrays into
    # lists first means CPython can iterate them ~2x faster than indexing into
    # numpy arrays.
    features = [
        {
            "type": "Feature",
            "geometry": {
                "type": "Polygon",
                "coordinates": [[
                    [lon_a_r[i], lat_a_r[i]],
                    [lon_b_r[i], lat_b_r[i]],
                    [lon_c_r[i], lat_c_r[i]],
                    [lon_d_r[i], lat_d_r[i]],
                    [lon_a_r[i], lat_a_r[i]],
                ]],
            },
            "properties": {"v": values_r[i]},
        }
        for i in range(len(values_r))
    ]

    fc = {"type": "FeatureCollection", "features": features}

    # orjson serializes 3-5x faster than json.dumps for large object trees.
    body = orjson.dumps(fc)
    buf = BytesIO()
    with gzip.GzipFile(fileobj=buf, mode="wb", compresslevel=6) as gz:
        gz.write(body)

    return buf.getvalue(), {
        **base_meta,
        "bounds": bounds,
        "count": len(features),
    }


def _enumerate_sweeps(radar: Any, field: str | None = None) -> list[dict]:
    """Per-sweep [{index, elevation_deg}] entries.

    When `field` is provided, sweeps whose ALL gates are masked for that field
    are omitted — e.g. VCP 12's surveillance-pulse sweeps carry reflectivity
    but no velocity, so a VEL render would list only the doppler sweeps. This
    lets the dashboard's tilt picker map "0.5°" to the correct sweep_index
    instead of accidentally selecting an empty surveillance pulse.
    """
    out: list[dict] = []
    for i in range(radar.nsweeps):
        if field is not None and field in radar.fields:
            sweep_slice = radar.get_slice(i)
            data = radar.fields[field]["data"][sweep_slice, :]
            mask = np.ma.getmaskarray(data) if hasattr(data, "mask") else None
            if mask is not None and mask.all():
                continue
            if mask is None and not np.isfinite(np.asarray(data)).any():
                continue
        elev = float(radar.fixed_angle["data"][i])
        out.append({"index": i, "elevation_deg": round(elev, 2)})
    return out


def _extract_sweep(radar: Any, field: str, sweep_index: int):
    """Return (data, azimuth) for a single sweep, dedup'd by ray azimuth.

    NEXRAD VCPs sometimes include split-cut sweeps where the same elevation
    appears twice (one short-pulse, one long-pulse). Without dedup, plotting
    both layers them and exaggerates the 'quilt' effect. We keep the first
    occurrence per 0.1° azimuth bucket within the sweep slice.
    """
    sweep_slice = radar.get_slice(sweep_index)
    az = np.asarray(radar.azimuth["data"][sweep_slice], dtype=np.float64)
    data = radar.fields[field]["data"][sweep_slice, :]

    bucket = np.round(az * 10).astype(np.int64) % 3600
    seen = set()
    keep = np.zeros(len(az), dtype=bool)
    for i, b in enumerate(bucket):
        bi = int(b)
        if bi in seen:
            continue
        seen.add(bi)
        keep[i] = True
    return data[keep, :], az[keep]


def _composite_max(radar: Any, field: str):
    """Composite (max across sweeps) using the lowest sweep's azimuth grid.

    For each ray in the lowest sweep we find the nearest-azimuth ray in every
    other sweep and take the per-gate max. Higher tilts have fewer ranges, so
    we trim to the lowest tilt's gate count.
    """
    lowest = 0
    base_sl = radar.get_slice(lowest)
    base_az = np.asarray(radar.azimuth["data"][base_sl], dtype=np.float64)
    base_data = np.ma.asarray(radar.fields[field]["data"][base_sl, :])

    out = base_data.copy()
    n_gates = out.shape[1]

    for s in range(1, radar.nsweeps):
        sl = radar.get_slice(s)
        az = np.asarray(radar.azimuth["data"][sl], dtype=np.float64)
        data = np.ma.asarray(radar.fields[field]["data"][sl, :])
        for i, a in enumerate(base_az):
            diff = np.abs(((az - a + 180) % 360) - 180)
            j = int(np.argmin(diff))
            row = data[j, :n_gates]
            out[i, :n_gates] = np.ma.maximum(out[i, :n_gates], row)
    return out, base_az


def _ray_az_bounds(az_sorted: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Per-ray azimuth low/high bounds from neighbor midpoints (wrap-aware).

    For sorted azimuths a[0]..a[n-1], ray i's low edge is the midpoint between
    a[i-1] and a[i], its high edge is the midpoint between a[i] and a[i+1].
    Ray 0's low and ray n-1's high wrap around through 360°.
    """
    prev = np.roll(az_sorted, 1)
    nxt = np.roll(az_sorted, -1)

    def midpoint(a: np.ndarray, b: np.ndarray) -> np.ndarray:
        diff = (b - a) % 360.0
        diff = np.where(diff > 180.0, diff - 360.0, diff)
        return (a + diff / 2.0) % 360.0

    return midpoint(prev, az_sorted), midpoint(az_sorted, nxt)


def _gate_range_bounds(ranges: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Per-gate range low/high bounds. Assumes uniform spacing (NEXRAD does)."""
    if len(ranges) < 2:
        return ranges, ranges
    dr = float(ranges[1] - ranges[0])
    r_low = np.clip(ranges - dr / 2.0, 0.0, None)
    r_high = ranges + dr / 2.0
    return r_low, r_high


def _empty_geojson() -> bytes:
    buf = BytesIO()
    with gzip.GzipFile(fileobj=buf, mode="wb", compresslevel=6) as gz:
        gz.write(b'{"type":"FeatureCollection","features":[]}')
    return buf.getvalue()


def _empty_bounds() -> dict:
    return {"north": 0.0, "south": 0.0, "east": 0.0, "west": 0.0}
