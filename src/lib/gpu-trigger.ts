import 'server-only';

// Runpod Serverless execution timeout for one claim-and-process cycle (jobs take ~30-45 min).
// Sent per request so a forgotten endpoint setting (default 600 s) cannot kill a running job.
export const GPU_EXECUTION_TIMEOUT_MS = 90 * 60 * 1000;

/**
 * Wakes the Runpod Serverless worker. Never throws and never fails the caller.
 * The request carries no job data: the worker always claims through the authenticated
 * claim endpoint, so extra or duplicate runs simply find no job and exit.
 * A network error, 429 or 5xx is retried once: a lost trigger otherwise waits for the daily cron.
 */
export async function triggerGpuWorker(): Promise<void> {
  const endpoint = process.env.RUNPOD_ENDPOINT_ID?.trim();
  const apiKey = process.env.RUNPOD_API_KEY?.trim();
  if (!endpoint || !apiKey) return;
  let failure = 'unknown error';
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise(resolve => setTimeout(resolve, 1000));
    try {
      const response = await fetch(`https://api.runpod.ai/v2/${encodeURIComponent(endpoint)}/run`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        // Runpod rejects an empty input; the handler ignores it.
        body: JSON.stringify({ input: { wake: true }, policy: { executionTimeout: GPU_EXECUTION_TIMEOUT_MS } }),
        signal: AbortSignal.timeout(3000),
        cache: 'no-store',
      });
      if (response.ok) return;
      failure = `HTTP ${response.status}`;
      if (response.status !== 429 && response.status < 500) break; // Auth or request errors will not heal on retry.
    } catch (error) {
      failure = error instanceof Error ? error.name : 'unknown error';
    }
  }
  console.error(`GPU trigger failed: ${failure}`);
}
