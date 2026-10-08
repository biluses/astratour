# GPU worker on Runpod Serverless

Goal: reconstruction starts automatically when a user clicks "Generar", and the GPU costs $0 while idle.

## How it works

1. The web app enqueues the job in Postgres (unchanged).
2. If `RUNPOD_ENDPOINT_ID` and `RUNPOD_API_KEY` are set in Vercel, the app also sends `POST https://api.runpod.ai/v2/{endpoint}/run` (`src/lib/gpu-trigger.ts`). It runs after the response is sent, with a 3 s timeout and one retry on network errors, 429 or 5xx. It sends no job data. Errors are logged without secrets and never fail the user request.
3. Runpod starts a worker. `worker/serverless_handler.py` runs `main.py --once` (under `xvfb-run` when available). That command claims at most one job through the authenticated `/api/internal/reconstruction/claim` endpoint, processes it and exits.
4. Once the worker has been idle past the idle timeout, Runpod scales it back to zero.

**Idempotent by design.** The Runpod request carries no job data, blob tokens or secrets. Postgres is the only source of truth. A duplicate or stray run claims nothing and exits within seconds.

**Other triggers:**
- A retryable failure (`/fail` re-queues the job) triggers a fresh run.
- The maintenance cron triggers a run when a queued job is older than 10 minutes. That covers lost triggers and jobs re-queued after a lease expiry, for example when a worker was killed. On the Hobby plan this cron runs once a day (`vercel.json`).

With both variables unset, behaviour is exactly as before.

## 1. Runpod console: create the endpoint

1. Go to **Serverless → New Endpoint**. Choose the Docker/container image path, which may be called **Import from Docker Registry**.
2. **Container image:** `ghcr.io/biluses/astratour-worker:<tag>`. If the package is private, add GHCR registry credentials under **Settings → Container Registry Auth** and select them.
3. **Endpoint type:** Queue-based.
4. **GPU:** pick the 24 GB tier (RTX 4090 / L4 / A5000 / 3090) first. Add the 48 GB tier (A6000 / A40 / L40S) as a fallback for availability.
5. **Workers:**
   - Active (min) workers: **0**. This is what gives $0 idle.
   - Max workers: **1** (2 if two tours may be processed at once).
   - GPUs per worker: 1.
6. **Timeouts:**
   - Idle timeout: default (5 s) is fine.
   - **Execution timeout: at least 5400 s (90 min).** The web trigger also sends `policy.executionTimeout = 90 min` on each request, but set it on the endpoint as well.
7. **FlashBoot:** keep enabled (default). It shortens cold starts after the first one.
8. **Container disk:** **at least 60 GB**. This covers COLMAP, training checkpoints and exports in `WORKER_WORK_DIR`.
9. **Container start command:** the handler path inside the image. With the image from `feat/worker-image` it is:

   ```
   python -u /opt/astratour/worker/serverless_handler.py
   ```

   Adjust the path to wherever that image puts the worker code. The interpreter that runs the handler must have the `runpod` pip package installed.

   If `main.py` must run with a different interpreter (for example the nerfstudio venv), set `WORKER_PYTHON` to that interpreter's path. `ASTRATOUR_WORKER_DIR` overrides the worker directory, which defaults to the handler's own directory.
10. **Environment variables.** Reference the existing Runpod secrets; never paste raw values.

    | Key | Value |
    | --- | --- |
    | `ASTRATOUR_API_URL` | `https://astratour.vercel.app` (canonical origin, no path) |
    | `RECONSTRUCTION_WORKER_SECRET` | `{{ RUNPOD_SECRET_astratour_worker_secret }}` |
    | `BLOB_READ_WRITE_TOKEN` | `{{ RUNPOD_SECRET_astratour_blob_token }}` |
    | `WORKER_WORK_DIR` | `/tmp/astratour-work` (any writable path on the container disk) |
    | `WORKER_ID` | `runpod-serverless` (optional; defaults to `runpod-$RUNPOD_POD_ID`) |

    The handler defaults `QT_QPA_PLATFORM=offscreen` and `TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD=1`, which nerfstudio 1.1.5 needs with torch ≥ 2.6.

    Optional: `WORKER_CYCLE_SECONDS` (default 5100). It must stay below the execution timeout so the worker shuts down cleanly first. The handler caps `WORKER_JOB_TIMEOUT_SECONDS` at the cycle minus 5 min, so an overlong job fails at once with `PROCESS_TIMEOUT` instead of being killed and retried by the daily cron.
11. Deploy. Copy the **Endpoint ID** shown on the endpoint page.

**Test it without the web app:**
- Click **Requests → Run** with `{"input": {}}`.
- With no queued job, the expected result is `{"status": "ok", "exitCode": 0}` after a cold start.
- This only proves start-up and claim auth. It does not prove reconstruction.

## 2. Runpod API key

Create it under **Settings → API Keys**. Prefer a restricted key scoped to this endpoint, if the console offers that option.

## 3. Vercel: two environment variables (Production)

| Key | Value |
| --- | --- |
| `RUNPOD_ENDPOINT_ID` | the endpoint ID from step 1.11 |
| `RUNPOD_API_KEY` | the key from step 2 (mark as Sensitive) |

Redeploy. `npm run env:check` reports `OK RUNPOD_ENDPOINT_ID`, or `ERROR` if only one of the two is set.

To roll back, remove either variable. The app goes back to waiting for a manually started worker (`worker/runpod-once.sh`).

## Cost reasoning

Runpod lists flex (scale-to-zero) prices on its [endpoint settings page](https://docs.runpod.io/serverless/endpoints/endpoint-configurations), as of 2026-10:

| GPU tier | Price per second | One 45-min job |
| --- | --- | --- |
| 24 GB (L4, A5000, 3090) | ~$0.00019 | ~$0.51 |
| 48 GB (A6000, A40) | ~$0.00034 | ~$0.92 |

- **Idle:** $0 compute, because there are no active workers.
- **Image storage and network pulls:** not billed per job.
- **Cold start:** adds billed seconds. The first pull of a large image can take minutes; FlashBoot reduces later starts.
- **Stray runs** (duplicate clicks, cron safety net): each costs a cold start plus a few seconds, typically well under $0.05.
- **Hard cap:** the 90 min execution timeout limits any single run to about $1.03 on 24 GB.

Compare a manually started pod: it bills for every second it is up, including setup and any time it is forgotten.

## Not verified

- No live endpoint was created while writing this. The steps are based on the Runpod docs ([handler](https://docs.runpod.io/serverless/workers/handler-functions), [/run](https://docs.runpod.io/serverless/endpoints/send-requests), [settings](https://docs.runpod.io/serverless/endpoints/endpoint-configurations)). Console labels may differ slightly.
- The [secrets docs](https://docs.runpod.io/pods/templates/secrets) document `{{ RUNPOD_SECRET_name }}` for Pod templates. Serverless endpoint support is expected but was not confirmed.
- Whether `RUNPOD_POD_ID` is injected into serverless workers is unconfirmed, so `WORKER_ID` falls back to `runpod-serverless`.
