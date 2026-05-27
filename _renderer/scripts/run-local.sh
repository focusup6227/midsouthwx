#!/usr/bin/env bash
# Build + run the renderer locally via Docker. Pulls the three required secrets
# from the dashboard's .env.local so you don't have to copy/paste them. The
# container is reachable at http://localhost:8080 — point the dashboard at it
# by setting RENDERER_BASE_URL=http://localhost:8080 in the dashboard's
# .env.local and restarting `npm run dev`.
#
# Why this is faster than Fly:
#   - No cold start (container stays up while this script runs)
#   - No network hop dashboard → Fly → renderer (localhost is microseconds)
#   - Local CPU (Apple Silicon especially) is much faster than Fly's
#     shared-cpu-2x for the polygon-corner math.
#
# Trade-off: only works while this script is running on your Mac. Stop with
# Ctrl-C and Fly takes over again.

set -euo pipefail

DASHBOARD_ENV="${DASHBOARD_ENV:-$HOME/Desktop/midsouthwx-main/.env.local}"

if [[ ! -f "$DASHBOARD_ENV" ]]; then
  echo "error: can't find dashboard .env.local at $DASHBOARD_ENV"
  echo "       set DASHBOARD_ENV=/path/to/.env.local and re-run"
  exit 1
fi

read_env() {
  grep -E "^$1=" "$DASHBOARD_ENV" | head -1 | cut -d= -f2-
}

RENDERER_TOKEN=$(read_env RENDERER_TOKEN)
SUPABASE_URL=$(read_env NEXT_PUBLIC_SUPABASE_URL)
SUPABASE_SERVICE_KEY=$(read_env SUPABASE_SERVICE_ROLE_KEY)

if [[ -z "$RENDERER_TOKEN" || -z "$SUPABASE_URL" || -z "$SUPABASE_SERVICE_KEY" ]]; then
  echo "error: missing one of RENDERER_TOKEN / NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY"
  echo "       in $DASHBOARD_ENV"
  exit 1
fi

cd "$(dirname "$0")/.."

echo "==> Building renderer image (first build ~3-5 min for native deps)…"
docker build -t midsouthwx-radar-renderer:local . | sed 's/^/    /'

echo
echo "==> Starting renderer on http://localhost:8080"
echo "    To use it: set RENDERER_BASE_URL=http://localhost:8080 in the"
echo "    dashboard's .env.local and restart 'npm run dev'."
echo "    Ctrl-C here to stop and fall back to Fly."
echo

exec docker run --rm --name midsouthwx-radar-renderer-local \
  -p 8080:8080 \
  -e RENDERER_TOKEN="$RENDERER_TOKEN" \
  -e SUPABASE_URL="$SUPABASE_URL" \
  -e SUPABASE_SERVICE_KEY="$SUPABASE_SERVICE_KEY" \
  -e LOG_LEVEL=INFO \
  midsouthwx-radar-renderer:local
