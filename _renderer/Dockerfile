# syntax=docker/dockerfile:1.7

# Py-ART needs a real C/C++ toolchain + HDF5/netCDF native libs. The official
# Python image is glibc-based which makes the wheel installs work without
# fallback compiles.
FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    MPLBACKEND=Agg \
    # Py-ART writes the user-level config to $HOME/.pyart, so the runtime user
    # needs a writable HOME or pyart logs a warning on every import.
    HOME=/tmp

# System deps for arm-pyart, netCDF4, matplotlib, and ffmpeg (for
# /alert-loop's MP4 stitching). Kept minimal.
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        libhdf5-dev \
        libnetcdf-dev \
        libgeos-dev \
        libproj-dev \
        proj-data \
        proj-bin \
        ca-certificates \
        curl \
        ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt /app/
RUN pip install --no-cache-dir -r requirements.txt

COPY *.py /app/

# Fly health-check expects the app on 0.0.0.0:8080 — this was the binding bug
# in the previous renderer. uvicorn's --host 0.0.0.0 is the fix.
EXPOSE 8080
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1", "--timeout-keep-alive", "75"]
