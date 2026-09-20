import { timingSafeEqual } from 'node:crypto';
import { getSql } from '@/lib/db';
import { recoverReconstructionJobs } from '@/lib/reconstruction';
import { apiError, json } from '@/lib/http';

export const runtime = 'nodejs';
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
        WHERE status = 'procesando' AND processing_started_at < now() - interval '6 minutes'
          AND NOT EXISTS (SELECT 1 FROM reconstruction_jobs j WHERE j.tour_id = tours.id)`,
    ]);
    return json({ ok: true });
  } catch (error) { return apiError(error); }
}
