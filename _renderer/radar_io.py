"""NEXRAD Level II discovery + download from UCAR's THREDDS server.

NOAA's `noaa-nexrad-level2` S3 bucket only allows GetObject (not ListBucket)
for anonymous requests, so we can't enumerate the latest file there without
auth. UCAR's THREDDS server exposes the same IDD-fed feed with a per-site
`latest.xml` resolver, which is both easier and free.

Lag is ~5 minutes from real time — comparable to AWS's NEXRAD feed.
"""

from __future__ import annotations

import os
import re
import tempfile
from datetime import datetime, timedelta, timezone
from xml.etree import ElementTree as ET

import httpx
import pyart

_THREDDS_BASE = "https://thredds.ucar.edu/thredds"
_NS = {"t": "http://www.unidata.ucar.edu/namespaces/thredds/InvCatalog/v1.0"}

# Filename pattern: Level2_KNQA_20260523_0933.ar2v
_FNAME_RE = re.compile(r"Level2_([A-Z]{4})_(\d{8})_(\d{4})\.ar2v$")

# Polite UA so UCAR's logs can identify us if we ever misbehave.
_HEADERS = {"User-Agent": "midsouthwx-radar-renderer/2.0 (operator@midsouthwx)"}


def find_latest_volume(site: str) -> tuple[str, datetime]:
    """Return (thredds_url_path, scan_time_utc) for the most recent volume.

    The url_path is THREDDS's catalog-relative path (e.g.
    'nexrad/level2/KNQA/20260523/Level2_KNQA_20260523_0933.ar2v').
    Pass it back into download_volume() to fetch the actual bytes.
    """
    site = site.upper()
    now = datetime.now(timezone.utc)
    errors: list[str] = []
    # Cross-UTC-midnight calls: latest.xml under today's prefix may not exist
    # yet for the first few minutes after 00:00 UTC. Fall back to yesterday.
    for offset in (0, 1):
        d = now - timedelta(days=offset)
        date_str = f"{d.year:04d}{d.month:02d}{d.day:02d}"
        url = f"{_THREDDS_BASE}/catalog/nexrad/level2/{site}/{date_str}/latest.xml"
        try:
            r = httpx.get(url, timeout=15.0, headers=_HEADERS)
        except httpx.HTTPError as e:
            errors.append(f"{url} -> {type(e).__name__}: {e}")
            continue
        if r.status_code == 404:
            errors.append(f"{url} -> 404 (no data for this day yet)")
            continue
        if r.status_code != 200:
            errors.append(f"{url} -> HTTP {r.status_code}")
            continue
        try:
            tree = ET.fromstring(r.text)
        except ET.ParseError as e:
            errors.append(f"{url} -> XML parse error: {e}")
            continue
        ds = tree.find(".//t:dataset[@urlPath]", _NS)
        if ds is None:
            errors.append(f"{url} -> no dataset[urlPath] in catalog")
            continue
        url_path = ds.get("urlPath", "")
        if not url_path:
            errors.append(f"{url} -> empty urlPath")
            continue
        scan_time = _parse_scan_time(url_path)
        return url_path, scan_time
    raise RuntimeError(
        f"no Level II data found for site {site}; tried THREDDS:\n  - "
        + "\n  - ".join(errors)
    )


def _parse_scan_time(url_path: str) -> datetime:
    """Parse YYYYMMDD + HHMM out of the filename. Falls back to now() if odd."""
    m = _FNAME_RE.search(url_path)
    if not m:
        return datetime.now(timezone.utc)
    _, date_str, time_str = m.groups()
    try:
        return datetime.strptime(
            f"{date_str}{time_str}", "%Y%m%d%H%M",
        ).replace(tzinfo=timezone.utc)
    except ValueError:
        return datetime.now(timezone.utc)


def download_volume(url_path: str) -> str:
    """Download a THREDDS fileServer URL to a tmpfile. Caller cleans up."""
    url = f"{_THREDDS_BASE}/fileServer/{url_path}"
    fd, path = tempfile.mkstemp(suffix=".ar2v", prefix="nexrad-")
    os.close(fd)
    try:
        with httpx.stream(
            "GET", url, timeout=60.0, follow_redirects=True, headers=_HEADERS,
        ) as r:
            r.raise_for_status()
            with open(path, "wb") as f:
                for chunk in r.iter_bytes(chunk_size=64 * 1024):
                    f.write(chunk)
    except Exception:
        # Don't leak the tmpfile on failure.
        try:
            os.remove(path)
        except OSError:
            pass
        raise
    return path


def read_volume(path: str):
    """Parse with Py-ART. read_nexrad_archive handles both .gz and uncompressed."""
    return pyart.io.read_nexrad_archive(path)


def list_volumes_since(site: str, since: datetime) -> list[tuple[str, datetime]]:
    """Return [(thredds_url_path, scan_time_utc), ...] with scan_time >= `since`,
    sorted ascending. Iterates one day at a time across the catalog so the
    common 30-min loop window only ever touches today's listing (occasionally
    today + yesterday near UTC midnight).
    """
    site = site.upper()
    now = datetime.now(timezone.utc)
    results: list[tuple[str, datetime]] = []
    seen: set[str] = set()

    cur = since.replace(hour=0, minute=0, second=0, microsecond=0)
    while cur <= now:
        date_str = f"{cur.year:04d}{cur.month:02d}{cur.day:02d}"
        url = f"{_THREDDS_BASE}/catalog/nexrad/level2/{site}/{date_str}/catalog.xml"
        try:
            r = httpx.get(url, timeout=15.0, headers=_HEADERS)
        except httpx.HTTPError:
            cur += timedelta(days=1)
            continue
        if r.status_code != 200:
            cur += timedelta(days=1)
            continue
        try:
            tree = ET.fromstring(r.text)
        except ET.ParseError:
            cur += timedelta(days=1)
            continue
        for ds in tree.findall(".//t:dataset[@urlPath]", _NS):
            url_path = ds.get("urlPath", "")
            if not url_path or url_path in seen:
                continue
            seen.add(url_path)
            scan_time = _parse_scan_time(url_path)
            if scan_time >= since:
                results.append((url_path, scan_time))
        cur += timedelta(days=1)

    results.sort(key=lambda x: x[1])
    return results
