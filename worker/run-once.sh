#!/bin/bash
# Entry point of the prebuilt Runpod image (Dockerfile.runpod): process at most one job, then stop the pod.
# Pod env: RECONSTRUCTION_WORKER_SECRET and BLOB_READ_WRITE_TOKEN as Runpod secret references.
set -euo pipefail
stop_pod() { runpodctl stop pod "$RUNPOD_POD_ID" || true; }
trap stop_pod EXIT
# Independent wall-clock cap, in case the worker or the trap hangs.
(sleep "${WORKER_POD_MAX_SECONDS:-5400}"; runpodctl stop pod "$RUNPOD_POD_ID") &

export WORKER_ID="${WORKER_ID:-runpod-$RUNPOD_POD_ID}"
mkdir -p "$WORKER_WORK_DIR"
cd /opt/astratour/worker
xvfb-run -a python main.py --once
