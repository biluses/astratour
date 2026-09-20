import 'server-only';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { head } from '@vercel/blob';
import { z } from 'zod';
import { cameraPoseSchema, uuidSchema } from '@/lib/contracts';
import { reconstructionConfigured, minReconstructionImages } from '@/lib/config';
import { getSql } from '@/lib/db';
import { HttpError } from '@/lib/http';
import { getImages } from '@/lib/tours';

export const LEASE_SECONDS = 300;
export const MAX_ATTEMPTS = 3;
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 5 * 1024 * 1024;

export const reconstructionEnabled = reconstructionConfigured;
export const minimumCaptureImages = minReconstructionImages;
export function requireWorker(request: Request) {
  const secret = process.env.RECONSTRUCTION_WORKER_SECRET;
  const actual = request.headers.get('authorization') ?? '';
  const expected = secret ? `Bearer ${secret}` : '';
  if (!expected || Buffer.byteLength(actual) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) throw new HttpError(401, 'Unauthorized');
}

export async function enqueueReconstruction(tourId: string, userId: string) {
  const sql = getSql();
  // One unique job per tour. Concurrent clicks cannot create duplicate GPU work.
  const rows = await sql`
    WITH eligible AS (
      SELECT id FROM tours WHERE id = ${tourId} AND user_id = ${userId}
        AND status IN ('borrador','error') FOR UPDATE
    ), queued AS (
      INSERT INTO reconstruction_jobs (tour_id) SELECT id FROM eligible
      ON CONFLICT (tour_id) DO NOTHING RETURNING tour_id
    )
    UPDATE tours SET status = 'procesando', simulated = false, processing_started_at = now(), updated_at = now()
    WHERE id IN (SELECT tour_id FROM queued) RETURNING id`;
  if (!rows.length) {
    const [existing] = await sql`SELECT j.status FROM reconstruction_jobs j JOIN tours t ON t.id = j.tour_id
      WHERE j.tour_id = ${tourId} AND t.user_id = ${userId}`;
    if (existing?.status === 'queued' || existing?.status === 'running' || existing?.status === 'completed') return;
    throw new HttpError(409, 'La reconstrucción agotó sus intentos. Revisa la captura y crea una nueva propiedad.');
  }
}

export async function claimReconstruction(workerId: string) {
  if (!reconstructionEnabled()) throw new HttpError(503, 'Reconstruction is disabled');
  // Final expired attempts must fail promptly, not wait for the daily Hobby cron.
  await recoverReconstructionJobs();
  const sql = getSql();
  const token = randomUUID();
  const [job] = await sql`
    WITH candidate AS (
      SELECT j.id FROM reconstruction_jobs j JOIN tours t ON t.id = j.tour_id
      WHERE (j.status = 'queued' OR (j.status = 'running' AND j.lease_expires_at <= now()))
        AND j.attempts < ${MAX_ATTEMPTS} AND t.status = 'procesando'
      ORDER BY j.created_at FOR UPDATE OF j SKIP LOCKED LIMIT 1
    )
    UPDATE reconstruction_jobs j SET status = 'running', attempts = attempts + 1,
      token = ${token}, worker_id = ${workerId}, lease_expires_at = now() + ${LEASE_SECONDS} * interval '1 second',
      run_started_at = now(), progress = 0, stage = 'download', error_code = NULL, error_message = NULL, updated_at = now()
    FROM candidate, tours t WHERE j.id = candidate.id AND t.id = j.tour_id
    RETURNING j.id, j.tour_id, t.user_id, j.attempts, j.lease_expires_at`;
  if (!job) return null;
  const images = await getImages(job.tour_id as string);
  return {
    id: job.id, tourId: job.tour_id, userId: job.user_id, token,
    attempt: Number(job.attempts), leaseExpiresAt: job.lease_expires_at,
    outputPrefix: `generated/${job.user_id}/${job.tour_id}/${token}`,
    images: images.map(image => ({ id: image.id, path: image.source_path, name: image.original_name,
      contentType: image.content_type, sizeBytes: image.size_bytes, ordinal: image.ordinal })),
  };
}

export const heartbeatSchema = z.object({ token: uuidSchema,
  progress: z.number().int().min(0).max(99), stage: z.string().trim().min(1).max(80) });
export async function heartbeatReconstruction(id: string, payload: z.infer<typeof heartbeatSchema>) {
  const sql = getSql();
  // A dead worker cannot resurrect an expired lease. Each attempt is capped at four hours.
  const rows = await sql`UPDATE reconstruction_jobs SET lease_expires_at = now() + ${LEASE_SECONDS} * interval '1 second',
    progress = GREATEST(progress, ${payload.progress}), stage = ${payload.stage}, updated_at = now()
    WHERE id = ${id} AND token = ${payload.token} AND status = 'running' AND lease_expires_at > now()
      AND run_started_at > now() - interval '4 hours'
    RETURNING lease_expires_at`;
  if (!rows.length) throw new HttpError(409, 'Lease expired or ownership lost');
  return { leaseExpiresAt: rows[0].lease_expires_at };
}

export const completionSchema = z.object({
  token: uuidSchema, modelPath: z.string().max(500), archivePath: z.string().max(500), camera: cameraPoseSchema,
  previews: z.array(z.object({ imageId: uuidSchema, path: z.string().max(500) })).min(1).max(12),
}).refine(value => new Set(value.previews.map(preview => preview.imageId)).size === value.previews.length, 'Duplicate preview');

async function verifyArtifact(path: string, maxBytes: number, contentTypes: string[]) {
  const metadata = await head(path);
  if (!Number.isSafeInteger(metadata.size) || metadata.size < 1 || metadata.size > maxBytes ||
      !contentTypes.includes(metadata.contentType)) throw new HttpError(400, 'Invalid reconstruction artifact');
}

export async function completeReconstruction(id: string, payload: z.infer<typeof completionSchema>) {
  const sql = getSql();
  const [job] = await sql`SELECT j.*, t.user_id FROM reconstruction_jobs j JOIN tours t ON t.id = j.tour_id
    WHERE j.id = ${id} AND j.token = ${payload.token}`;
  if (!job) throw new HttpError(409, 'Lease ownership lost');
  if (job.status === 'completed') return; // Lost HTTP response after success is safe to retry.
  if (job.status !== 'running' || new Date(job.lease_expires_at as string).getTime() <= Date.now()) {
    throw new HttpError(409, 'Lease expired or ownership lost');
  }
  const prefix = `generated/${job.user_id}/${job.tour_id}/${payload.token}`;
  if (payload.modelPath !== `${prefix}/scene.sog` || payload.archivePath !== `${prefix}/astratour-pack.zip` ||
      payload.previews.some(preview => preview.path !== `${prefix}/previews/${preview.imageId}.jpg`)) {
    throw new HttpError(400, 'Artifact path is outside the active job');
  }
  const images = await getImages(job.tour_id as string);
  const imageIds = new Set(images.map(image => image.id));
  if (payload.previews.some(preview => !imageIds.has(preview.imageId))) throw new HttpError(400, 'Preview image does not belong to this job');
  await Promise.all([
    verifyArtifact(payload.modelPath, MAX_ARTIFACT_BYTES, ['application/octet-stream', 'application/zip']),
    verifyArtifact(payload.archivePath, MAX_ARTIFACT_BYTES, ['application/zip', 'application/octet-stream']),
    ...payload.previews.map(preview => verifyArtifact(preview.path, MAX_PREVIEW_BYTES, ['image/jpeg'])),
  ]);
  // Re-check fencing after network I/O. Publication of previews, model, pack and completion is atomic.
  const rows = await sql`
    WITH eligible AS (
      SELECT j.id, j.tour_id FROM reconstruction_jobs j JOIN tours t ON t.id = j.tour_id
      WHERE j.id = ${id} AND j.token = ${payload.token} AND j.status = 'running'
        AND j.lease_expires_at > now() AND t.status = 'procesando' FOR UPDATE OF j, t
    ), images_updated AS (
      UPDATE tour_images i SET preview_path = p.path, asset_path = NULL, source_uploaded = true
      FROM eligible e, jsonb_to_recordset(${JSON.stringify(payload.previews)}::jsonb) AS p("imageId" uuid, path text)
      WHERE i.id = p."imageId" AND i.tour_id = e.tour_id RETURNING i.id
    ), tours_updated AS (
      UPDATE tours t SET status = 'pendiente_de_pago', simulated = false, model_path = ${payload.modelPath},
        archive_path = ${payload.archivePath}, viewer_settings = ${JSON.stringify(payload.camera)}::jsonb, updated_at = now()
      FROM eligible e WHERE t.id = e.tour_id AND (SELECT count(*) FROM images_updated) = ${payload.previews.length}
      RETURNING t.id
    )
    UPDATE reconstruction_jobs j SET status = 'completed', progress = 100, stage = 'completed',
      completed_at = now(), updated_at = now(), lease_expires_at = NULL
    FROM eligible e, tours_updated t WHERE j.id = e.id AND j.tour_id = t.id RETURNING j.id`;
  if (!rows.length) throw new HttpError(409, 'Lease expired or ownership lost');
}

export const failureSchema = z.object({ token: uuidSchema, code: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
  message: z.string().max(500).default('Reconstruction failed'), retryable: z.boolean() });
export async function failReconstruction(id: string, payload: z.infer<typeof failureSchema>) {
  const sql = getSql();
  const rows = await sql`
    WITH failed AS (
      UPDATE reconstruction_jobs SET status = CASE WHEN ${payload.retryable} AND attempts < ${MAX_ATTEMPTS} THEN 'queued' ELSE 'failed' END,
        stage = 'failed', error_code = ${payload.code}, error_message = ${payload.message},
        token = NULL, lease_expires_at = NULL, updated_at = now()
      WHERE id = ${id} AND token = ${payload.token} AND status = 'running' AND lease_expires_at > now()
      RETURNING tour_id, status
    )
    UPDATE tours t SET status = CASE WHEN failed.status = 'failed' THEN 'error' ELSE 'procesando' END, updated_at = now()
    FROM failed WHERE t.id = failed.tour_id RETURNING t.id`;
  if (!rows.length) throw new HttpError(409, 'Lease expired or ownership lost');
}

export async function recoverReconstructionJobs() {
  const sql = getSql();
  await sql`
    WITH recovered AS (
      UPDATE reconstruction_jobs SET status = CASE WHEN attempts < ${MAX_ATTEMPTS} THEN 'queued' ELSE 'failed' END,
        token = NULL, lease_expires_at = NULL, error_code = 'WORKER_LEASE_EXPIRED', stage = 'failed', updated_at = now()
      WHERE status = 'running' AND lease_expires_at <= now() RETURNING tour_id, status
    )
    UPDATE tours t SET status = CASE WHEN recovered.status = 'failed' THEN 'error' ELSE 'procesando' END, updated_at = now()
    FROM recovered WHERE t.id = recovered.tour_id`;
}
