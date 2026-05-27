"""Supabase Storage uploads + cache hits via the REST API.

The dashboard expects renderer responses to contain a public URL pointing at
the rendered asset. We upload to Supabase Storage (bucket `radar-tiles`) and
return the public URL. A second small JSON metadata file is uploaded alongside
each asset so a cache-hit can reconstruct bounds/vmin/vmax without re-rendering.
"""

from __future__ import annotations

import json
import os
from typing import Optional

import httpx

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SERVICE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
BUCKET = os.environ.get("RENDERER_STORAGE_BUCKET", "radar-tiles")

_BASE_HEADERS = {
    "Authorization": f"Bearer {SERVICE_KEY}",
    "apikey": SERVICE_KEY,
}


def _object_url(path: str) -> str:
    return f"{SUPABASE_URL}/storage/v1/object/{BUCKET}/{path}"


def public_url(path: str) -> str:
    return f"{SUPABASE_URL}/storage/v1/object/public/{BUCKET}/{path}"


async def upload(path: str, body: bytes, content_type: str) -> str:
    headers = {
        **_BASE_HEADERS,
        "Content-Type": content_type,
        # Storage REST: POST creates, PUT updates. x-upsert turns POST into
        # create-or-replace so we don't have to differentiate first-write vs
        # rewrite (Mapbox is hitting the same content-addressed URL anyway).
        "x-upsert": "true",
        # Long max-age — assets are content-addressed by scan_time so the same
        # URL is always the same bytes. Browser + CDN can cache aggressively.
        "Cache-Control": "public, max-age=31536000, immutable",
    }
    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.post(_object_url(path), content=body, headers=headers)
        if r.status_code >= 400:
            # Surface Supabase's JSON error body so upstream logs aren't blind.
            snippet = r.text[:500]
            raise RuntimeError(
                f"supabase upload {r.status_code}: {snippet}",
            )
    return public_url(path)


async def upload_metadata(path: str, meta: dict) -> str:
    return await upload(
        path,
        json.dumps(meta, separators=(",", ":")).encode("utf-8"),
        "application/json",
    )


async def fetch_metadata(path: str) -> Optional[dict]:
    """Return parsed metadata JSON if cached, else None."""
    async with httpx.AsyncClient(timeout=10.0) as client:
        # Public read — no auth needed once bucket is set to public-read on
        # the .json paths. Falls back to authed read if 403.
        r = await client.get(public_url(path))
        if r.status_code == 200:
            try:
                return r.json()
            except ValueError:
                return None
        if r.status_code == 403:
            r = await client.get(_object_url(path), headers=_BASE_HEADERS)
            if r.status_code == 200:
                try:
                    return r.json()
                except ValueError:
                    return None
    return None
