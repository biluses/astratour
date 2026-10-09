import { uuidSchema } from '@/lib/contracts';
import { apiError, json, readJson } from '@/lib/http';
import { failureSchema, failReconstruction, requireWorker } from '@/lib/reconstruction';
import { triggerGpuWorker } from '@/lib/gpu-trigger';

export const runtime = 'nodejs';
export async function POST(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    requireWorker(request);
    const { jobId } = await params;
    uuidSchema.parse(jobId);
    const payload = failureSchema.parse(await readJson(request, 16384));
    const result = await failReconstruction(jobId, payload);
    // A retryable failure re-queues the job; wake a fresh GPU worker for the next attempt.
    if (result.requeued) await triggerGpuWorker();
    return json({ ok: true, ...result });
  } catch (error) { return apiError(error); }
}
