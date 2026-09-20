import { uuidSchema } from '@/lib/contracts';
import { apiError, json, readJson } from '@/lib/http';
import { completionSchema, completeReconstruction, requireWorker } from '@/lib/reconstruction';

export const runtime = 'nodejs';
export async function POST(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    requireWorker(request);
    const { jobId } = await params;
    uuidSchema.parse(jobId);
    const payload = completionSchema.parse(await readJson(request, 16384));
    const result = await completeReconstruction(jobId, payload);
    return json({ ok: true, ...(result ?? {}) });
  } catch (error) { return apiError(error); }
}
