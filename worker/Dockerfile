# Immutable upstream digests inspected 2026-09-19; no GPU layers downloaded during development.
FROM --platform=linux/amd64 node:22.22.2-bookworm-slim@sha256:9f6d5975c7dca860947d3915877f85607946403fc55349f39b4bc3688448bb6e AS node
WORKDIR /opt/astratour-worker
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Includes CUDA 11.8, COLMAP 3.9.1 and Nerfstudio 1.1.5, pinned as one immutable environment.
FROM --platform=linux/amd64 ghcr.io/nerfstudio-project/nerfstudio:1.1.5@sha256:b59b8e1012d7a43679d3234b3de9c8416a4b8435fcbf21b9d8c4494b8563f19e
USER root
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /opt/astratour-worker /opt/astratour-worker
COPY . /opt/astratour-worker
RUN groupadd --gid 10001 astratour && useradd --uid 10001 --gid 10001 --create-home astratour \
    && mkdir -p /work && chown 10001:10001 /work \
    && python -c "from PIL import Image; import nerfstudio; import torch" \
    && node --version
ENV PATH="/opt/astratour-worker/node_modules/.bin:${PATH}" \
    PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 QT_QPA_PLATFORM=offscreen \
    WORKER_WORK_DIR=/work HOME=/home/astratour
WORKDIR /opt/astratour-worker
USER 10001:10001
ENTRYPOINT ["python", "main.py"]
