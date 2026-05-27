# midsouthwx-radar-renderer

On-demand NEXRAD Level II renderer for the
[midsouthwx dashboard](../midsouthwx-main). Renders single-site BREF / BVEL /
CC products as either gzipped GeoJSON polar wedges (default — supports
pointer-dBZ readout) or a transparent PNG (faster fetch, no per-gate readout).

## Quality goals

The previous renderer produced a "quilt" pattern where adjacent azimuth
wedges either overlapped or left tiny gaps along shared edges. This rewrite
constructs polygons so that **ray i's high-azimuth edge is identical to
ray i+1's low-azimuth edge by construction** — boundaries come from neighbor
midpoints, not from each ray's independent half-width.

Other quality fixes:
- Split-cut VCPs (e.g. VCP 12, 212) sometimes include duplicate rays at the
  same azimuth in a sweep. `_extract_sweep` dedupes by 0.1° azimuth bucket
  before rendering, eliminating the over-plotting that exaggerated the quilt.
- Range gates use shared edges between adjacent gates too.
- Range is trimmed to 230 km. Beyond that the beam is high above ground and
  the data is mostly clutter / over-ranged returns.

## API

`POST /render` (bearer auth via `RENDERER_TOKEN`)

```json
{
  "site": "KNQA",
  "product": "refl",       // refl | vel | cc
  "format": "geojson",     // geojson | png
  "sweep_index": 0,
  "composite": false,
  "force": false
}
```

Response:

```json
{
  "site": "KNQA",
  "product": "refl",
  "scan_time": "2026-05-23T14:32:07+00:00",
  "geojson_url": "https://…/radar-tiles/KNQA/.../refl_0_0_geojson_….geojson.gz",
  "image_url": null,
  "bounds": { "north": …, "south": …, "east": …, "west": … },
  "cached": false,
  "render_ms": 4123,
  "available_sweeps": [{"index": 0, "elevation_deg": 0.5}, …],
  "sweep_index": 0,
  "feature_count": 31254,
  "vmin": -32, "vmax": 95
}
```

`GET /healthz` → `{"ok": true, …}` (no auth — Fly health check).

## Required secrets

| Var | Notes |
| --- | --- |
| `RENDERER_TOKEN` | Shared with the dashboard. |
| `SUPABASE_URL` | Project URL. |
| `SUPABASE_SERVICE_KEY` | Service-role key — needed to upload to `radar-tiles` past RLS. |
| `RENDERER_STORAGE_BUCKET` | Optional. Defaults to `radar-tiles`. |

## Local dev (faster than Fly)

The Fly machine is `shared-cpu-2x`. A modern Mac (especially Apple Silicon)
will render 2-3x faster than the deployed instance because the polygon-corner
math runs on a real CPU instead of a tiny burstable VM, *and* there's no
network hop between dashboard ↔ renderer.

**Quickest path — Docker** (one command, secrets auto-pulled from dashboard):

```sh
bash scripts/run-local.sh
```

It builds the same Dockerfile Fly uses and runs the container with
`RENDERER_TOKEN`, `NEXT_PUBLIC_SUPABASE_URL`, and `SUPABASE_SERVICE_ROLE_KEY`
pulled from `~/Desktop/midsouthwx-main/.env.local`. Listens on
`http://localhost:8080`.

Then in the dashboard's `.env.local`:

```sh
RENDERER_BASE_URL=http://localhost:8080
```

…and restart `npm run dev`. Ctrl-C the script to stop the local renderer and
fall back to Fly.

**Native Python** (no Docker — useful for editing+hot-reload of polar.py):

```sh
# macOS only — Py-ART needs HDF5 + netCDF + proj.
brew install hdf5 netcdf proj

python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

export RENDERER_TOKEN=$(grep '^RENDERER_TOKEN=' ~/Desktop/midsouthwx-main/.env.local | cut -d= -f2-)
export SUPABASE_URL=$(grep '^NEXT_PUBLIC_SUPABASE_URL=' ~/Desktop/midsouthwx-main/.env.local | cut -d= -f2-)
export SUPABASE_SERVICE_KEY=$(grep '^SUPABASE_SERVICE_ROLE_KEY=' ~/Desktop/midsouthwx-main/.env.local | cut -d= -f2-)

uvicorn main:app --host 0.0.0.0 --port 8080 --reload
```

Quick smoke test (works for either path):

```sh
TOKEN=$(grep '^RENDERER_TOKEN=' ~/Desktop/midsouthwx-main/.env.local | cut -d= -f2-)
curl -X POST http://localhost:8080/render \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"site":"KNQA","product":"refl","format":"geojson","sweep_index":0}' \
  | python3 -c "import sys, json; d=json.load(sys.stdin); print('render_ms:', d['render_ms'])"
```

## Deploy

```sh
fly launch --no-deploy           # accept name/region — match fly.toml's app=
fly secrets set \
  RENDERER_TOKEN=$(openssl rand -hex 32) \
  SUPABASE_URL=https://your-project.supabase.co \
  SUPABASE_SERVICE_KEY=eyJ…
fly deploy
fly logs                          # verify "uvicorn started on http://0.0.0.0:8080"
```

Take the generated `RENDERER_TOKEN` and the Fly hostname (e.g.
`https://midsouthwx-radar-renderer.fly.dev`) and set them in the dashboard's
`.env.local` as `RENDERER_TOKEN` and `RENDERER_BASE_URL`.

## Why these knobs

- **`shared-cpu-2x`, 2 GB RAM** — Py-ART/numpy/matplotlib first-import is
  ~400 MB resident; a 0.5° volume render uses another ~300–600 MB. 2 GB
  leaves headroom for the 4-concurrent soft cap.
- **`auto_stop_machines = "stop"`** — radar usage is bursty (operator stares
  at radar during severe weather, ignores it otherwise). Scaling to zero
  saves cost. The dashboard's proxy has a 120 s timeout to absorb cold
  starts, and the `/healthz` grace period is 60 s.
- **`primary_region = "iad"`** — NEXRAD's `noaa-nexrad-level2` S3 bucket is
  in `us-east-1`. Same region = fast and free egress.
