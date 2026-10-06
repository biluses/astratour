#!/bin/bash
# One-shot worker on a Runpod PyTorch pod (Ubuntu 24.04): install, process at most one job, stop the pod.
# Pod env: RECONSTRUCTION_WORKER_SECRET and BLOB_READ_WRITE_TOKEN as Runpod secret references.
set -euo pipefail
stop_pod() { runpodctl stop pod "$RUNPOD_POD_ID" || true; }
trap stop_pod EXIT
# Independent wall-clock cap, in case the worker or the trap hangs.
(sleep "${WORKER_POD_MAX_SECONDS:-5400}"; runpodctl stop pod "$RUNPOD_POD_ID") &

apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq colmap libegl1 libgl1 xvfb git curl xz-utils > /dev/null
curl -fsSL https://nodejs.org/dist/v22.22.2/node-v22.22.2-linux-x64.tar.xz | tar -xJ -C /opt
python3 -m venv --system-site-packages /workspace/ns
/workspace/ns/bin/pip install -q --ignore-installed blinker nerfstudio==1.1.5
export PATH=/workspace/ns/bin:/opt/node-v22.22.2-linux-x64/bin:$PATH

rm -rf /workspace/astratour
git clone --depth 1 https://github.com/biluses/astratour /workspace/astratour
cd /workspace/astratour/worker
npm ci --omit=dev --no-audit --no-fund

# torch >= 2.6 defaults to weights_only loads, which nerfstudio 1.1.5 checkpoints do not support.
export QT_QPA_PLATFORM=offscreen TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD=1 \
  WORKER_WORK_DIR=/workspace/work ASTRATOUR_API_URL=https://astratour.vercel.app WORKER_ID="runpod-$RUNPOD_POD_ID"
mkdir -p "$WORKER_WORK_DIR"
xvfb-run -a python main.py --once
