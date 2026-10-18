import { timingSafeEqual } from 'node:crypto';
import { getSql } from '@/lib/db';
import { recoverReconstructionJobs } from '@/lib/reconstruction';
import { apiError, json } from '@/lib/http';
import { triggerGpuWorker } from '@/lib/gpu-trigger';
import { pollMarbleTour } from '@/lib/marble';

// Queued longer than this without a worker picking it up: the original trigger was lost.
const STALE_QUEUE_MINUTES = 10;
// ponytail: fixed batch per run; each finalized room copies ~50 MB after the response. Raise or loop if tours back up.
const MARBLE_TOURS_PER_RUN = 3;

export const runtime = 'nodejs';
export const maxDuration = 300;
export async function GET(request: Request) {
  const expected = process.env.CRON_SECRET ? `Bearer ${process.env.CRON_SECRET}` : '';
  const actual = request.headers.get('authorization') ?? '';
  if (!expected || Buffer.byteLength(actual) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(expected), Buffer.from(actual))) {
    return json({ error: 'Unauthorized' }, 401);
  }
  try {
    const sql = getSql();
    await recoverReconstructionJobs();
    await sql.transaction([
      sql`DELETE FROM api_rate_limits WHERE expires_at < now() - interval '1 day'`,
      sql`UPDATE tours SET status = 'error', updated_at = now()
        WHERE status = 'procesando' AND engine = 'gsplat' AND processing_started_at < now() - interval '6 minutes'
          AND NOT EXISTS (SELECT 1 FROM reconstruction_jobs j WHERE j.tour_id = tours.id)`,
    ]);
    // Safety net: covers lost triggers and jobs re-queued by lease recovery above.
    // created_at (not updated_at) because recovery and retries reset updated_at.
    const [stale] = await sql`SELECT 1 FROM reconstruction_jobs WHERE status = 'queued'
      AND created_at < now() - make_interval(mins => ${STALE_QUEUE_MINUTES}) LIMIT 1`;
    if (stale) await triggerGpuWorker();
    // Marble rooms advance without the owner's page: worlds outlive their ~3 h operations.
    const marble = await sql`SELECT id, user_id FROM tours WHERE engine = 'marble' AND status = 'procesando'
      ORDER BY random() LIMIT ${MARBLE_TOURS_PER_RUN}`;
    for (const tour of marble) await pollMarbleTour(tour.id as string, tour.user_id as string);
    return json({ ok: true });
  } catch (error) { return apiError(error); }
}
