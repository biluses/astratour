import { z } from 'zod';
import { apiError, json, readJson } from '@/lib/http';
import { claimReconstruction, requireWorker } from '@/lib/reconstruction';

export const runtime = 'nodejs';
export async function POST(request: Request) {
  try {
    requireWorker(request);
    const { workerId } = z.object({ workerId: z.string().min(1).max(100).default('worker') }).parse(await readJson(request, 2048));
    return json({ job: await claimReconstruction(workerId) });
  } catch (error) { return apiError(error); }
}
