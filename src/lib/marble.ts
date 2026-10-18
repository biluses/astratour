import 'server-only';
import { after } from 'next/server';
import { get, put } from '@vercel/blob';
import { requiredEnv } from '@/lib/config';
import { MAX_FILE_BYTES } from '@/lib/contracts';
import { getSql } from '@/lib/db';

/** World Labs Marble: one world per room (~6 min, 1,600 credits). Ported from capture-study/marble/gen.py. */
const ENDPOINT = 'https://api.worldlabs.ai/marble/v1';
export const MARBLE_MAX_ATTEMPTS = 2; // each submit spends credits: one automatic resubmit at most
const FINALIZE_STALE_MINUTES = 10;
const MAX_ASSET_BYTES = 200 * 1024 * 1024;

export interface MarbleAssets { thumb: string; pano: string | null; splatMobile: string; splatFull: string }
interface World {
  world_id?: string;
  assets?: {
    splats?: { spz_urls?: Record<string, string | null> | null };
    imagery?: { pano_url?: string | null };
    thumbnail_url?: string | null;
  };
}
interface Operation {
  done?: boolean;
  error?: unknown;
  metadata?: { world_id?: string };
  response?: {
    world_id?: string;
    assets?: {
      splats?: { spz_urls?: Record<string, string | null> | null };
      imagery?: { pano_url?: string | null };
      thumbnail_url?: string | null;
    };
  };
}

// Errors carry the status code only: never the key, the request body or the provider's response.
class MarbleHttpError extends Error {
  constructor(public status: number) { super(`Marble HTTP ${status}`); }
}
/** Network errors, 429 and 5xx heal on their own; other HTTP errors (404: expired operation) do not. */
const transient = (error: unknown) => !(error instanceof MarbleHttpError) || error.status === 429 || error.status >= 500;

async function call<T>(path: string, body?: unknown, timeoutMs = 15_000): Promise<T> {
  const response = await fetch(`${ENDPOINT}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'WLT-Api-Key': requiredEnv('WORLD_LABS_API_KEY') },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
    cache: 'no-store',
  });
  if (!response.ok) throw new MarbleHttpError(response.status);
  return await response.json() as T;
}

/** Starts a reconstruct-mode world from JPEGs and their azimuths. Returns the operation id (and world id, if already known). */
export async function generateWorld(displayName: string, images: { azimuth: number; jpeg: Buffer }[]) {
  const operation = await call<{ operation_id?: string; metadata?: { world_id?: string } }>('/worlds:generate', {
    display_name: displayName, model: 'marble-1.1',
    world_prompt: { type: 'multi-image', reconstruct_images: true, multi_image_prompt: images.map(image => ({
      azimuth: image.azimuth, content: { source: 'data_base64', extension: 'jpg', data_base64: image.jpeg.toString('base64') },
    })) },
  }, 120_000);
  if (!operation.operation_id) throw new Error('Marble response without operation_id');
  return { operationId: operation.operation_id, worldId: operation.metadata?.world_id ?? null };
}

export async function getOperation(id: string): Promise<Operation> {
  return await call<Operation>(`/operations/${encodeURIComponent(id)}`);
}

/** The world outlives its operation (~3 h): same assets shape. */
export async function getWorld(id: string): Promise<World> {
  const body = await call<World & { world?: World }>(`/worlds/${encodeURIComponent(id)}`);
  return body.world ?? body;
}

/** Asset URLs of a finished operation, or null when a required asset is missing. Only World Labs hosts are fetched. */
export function operationAssets(operation: Operation): MarbleAssets | null {
  const assets = operation.response?.assets;
  const trusted = (value: string | null | undefined) => {
    try {
      const url = new URL(value ?? '');
      return url.protocol === 'https:' && (url.hostname === 'worldlabs.ai' || url.hostname.endsWith('.worldlabs.ai')) ? url.href : null;
    } catch { return null; }
  };
  const result = { thumb: trusted(assets?.thumbnail_url), pano: trusted(assets?.imagery?.pano_url),
    splatMobile: trusted(assets?.splats?.spz_urls?.['500k']), splatFull: trusted(assets?.splats?.spz_urls?.full_res) };
  return result.thumb && result.splatMobile && result.splatFull ? result as MarbleAssets : null;
}

async function readSource(path: string): Promise<Buffer> {
  const blob = await get(path, { access: 'private', useCache: false });
  if (!blob || blob.statusCode !== 200 || !blob.stream) throw new Error('Source image missing');
  const jpeg = Buffer.from(await new Response(blob.stream).arrayBuffer());
  if (jpeg.length > MAX_FILE_BYTES || jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg[2] !== 0xff) throw new Error('Source image is not a JPEG');
  return jpeg;
}

/**
 * Claims queued rooms (status 'generating', attempts + 1) and moves the tour to 'procesando'. Only a 'borrador'
 * tour qualifies, so repeated clicks claim nothing. Call sendRoom for each returned id.
 */
export async function claimMarbleTour(tourId: string, userId: string): Promise<string[]> {
  const sql = getSql();
  const rows = await sql`
    WITH eligible AS (
      UPDATE tours SET status = 'procesando', simulated = false, processing_started_at = now(), updated_at = now()
      WHERE id = ${tourId} AND user_id = ${userId} AND engine = 'marble' AND status = 'borrador' RETURNING id
    )
    UPDATE tour_rooms r SET status = 'generating', attempts = attempts + 1, operation_id = NULL, updated_at = now()
    FROM eligible e WHERE r.tour_id = e.id AND r.status = 'queued' RETURNING r.id`;
  return rows.map(row => row.id as string);
}

/**
 * Submits a claimed room (status 'generating', no operation). A failed submit fails this room only.
 * Azimuths are sent relative to the room's first photo, so the world's azimuth 0 is that photo (tour.html convention).
 */
export async function sendRoom(roomId: string): Promise<void> {
  const sql = getSql();
  try {
    const images = await sql`SELECT source_path, azimuth FROM tour_images WHERE room_id = ${roomId} ORDER BY ordinal`;
    if (!images.length || images.some(image => image.azimuth == null)) throw new Error('Room without azimuths');
    const jpegs = await Promise.all(images.map(image => readSource(image.source_path as string)));
    const first = Number(images[0].azimuth);
    const { operationId, worldId } = await generateWorld(`astratour-${roomId}`, images.map((image, i) => ({
      azimuth: ((Number(image.azimuth) - first) % 360 + 360) % 360, jpeg: jpegs[i] })));
    await sql`UPDATE tour_rooms SET operation_id = ${operationId}, world_id = ${worldId}, updated_at = now()
      WHERE id = ${roomId} AND status = 'generating' AND operation_id IS NULL`;
  } catch (error) {
    console.error('Marble submit failed', error instanceof Error ? error.message : 'UnknownError');
    await sql`UPDATE tour_rooms SET status = 'failed', error_message = 'submit_failed', updated_at = now()
      WHERE id = ${roomId} AND status = 'generating' AND operation_id IS NULL`;
    const [room] = await sql`SELECT tour_id FROM tour_rooms WHERE id = ${roomId}`;
    if (room) await settleMarbleTour(room.tour_id as string);
  }
}

/**
 * One progress step for a 'procesando' marble tour, safe under concurrent polls: every transition is a
 * conditional UPDATE. Returns rooms to finalize (copy assets) and rooms to resubmit (sendRoom), both already
 * claimed; the caller runs them after the response.
 */
export async function advanceMarbleTour(tourId: string) {
  const sql = getSql();
  // Terminal paths for crashes: a claim whose submit never answered, an expired operation without a known world,
  // and a world that never produced its assets.
  await sql`UPDATE tour_rooms SET status = 'failed', error_message = 'timeout', updated_at = now()
    WHERE tour_id = ${tourId} AND ((status = 'generating' AND operation_id IS NULL AND updated_at < now() - interval '10 minutes')
      OR (status IN ('generating','finalizing') AND world_id IS NULL AND updated_at < now() - interval '3 hours')
      OR (status IN ('generating','finalizing') AND updated_at < now() - interval '24 hours'))`;
  const rooms = await sql`SELECT id, operation_id, world_id, attempts FROM tour_rooms
    WHERE tour_id = ${tourId} AND operation_id IS NOT NULL AND (status = 'generating'
      OR (status = 'finalizing' AND updated_at < now() - make_interval(mins => ${FINALIZE_STALE_MINUTES})))`;
  const finalize: { roomId: string; assets: MarbleAssets }[] = [];
  const resubmit: string[] = [];
  await Promise.all(rooms.map(async room => {
    const operationId = room.operation_id as string;
    let operation: Operation;
    try { operation = await getOperation(operationId); } catch (error) {
      if (transient(error) || !room.world_id) return; // the next poll retries
      // Operation gone (expired): the world keeps the assets. Not ready yet: stay 'generating'.
      try { operation = { done: true, response: await getWorld(room.world_id as string) }; } catch { return; }
      if (!operationAssets(operation)) return;
    }
    const worldId = operation.response?.world_id ?? operation.metadata?.world_id;
    if (worldId && worldId !== room.world_id) {
      await sql`UPDATE tour_rooms SET world_id = ${worldId} WHERE id = ${room.id} AND operation_id = ${operationId}`;
    }
    if (!operation.done && !operation.error) return;
    const assets = operation.error ? null : operationAssets(operation);
    if (!assets) {
      const retry = Number(room.attempts) < MARBLE_MAX_ATTEMPTS;
      const [claimed] = retry
        ? await sql`UPDATE tour_rooms SET operation_id = NULL, attempts = attempts + 1, updated_at = now()
            WHERE id = ${room.id} AND status = 'generating' AND operation_id = ${operationId} RETURNING id`
        : await sql`UPDATE tour_rooms SET status = 'failed', error_message = 'generation_failed', updated_at = now()
            WHERE id = ${room.id} AND status = 'generating' AND operation_id = ${operationId} RETURNING id`;
      if (claimed && retry) resubmit.push(room.id as string);
      return;
    }
    const [claimed] = await sql`UPDATE tour_rooms SET status = 'finalizing', world_id = COALESCE(${worldId ?? null}, world_id), updated_at = now()
      WHERE id = ${room.id} AND operation_id = ${operationId} AND (status = 'generating'
        OR (status = 'finalizing' AND updated_at < now() - make_interval(mins => ${FINALIZE_STALE_MINUTES})))
      RETURNING id`;
    if (claimed) finalize.push({ roomId: room.id as string, assets });
  }));
  await settleMarbleTour(tourId);
  return { finalize, resubmit };
}

/** One progress step plus its follow-up work after the response. Shared by the owner's poll and the maintenance cron. */
export async function pollMarbleTour(tourId: string, userId: string): Promise<void> {
  const { finalize, resubmit } = await advanceMarbleTour(tourId);
  if (finalize.length || resubmit.length) {
    after(() => Promise.all([
      ...finalize.map(room => finalizeRoom(tourId, userId, room.roomId, room.assets)),
      ...resubmit.map(sendRoom),
    ]));
  }
}

/** Copies a claimed room's assets into private Blob and completes it. A crash leaves it 'finalizing' to be reclaimed. */
export async function finalizeRoom(tourId: string, userId: string, roomId: string, assets: MarbleAssets): Promise<void> {
  try {
    const prefix = `generated/${userId}/${tourId}/rooms/${roomId}`;
    const copy = async (url: string | null, name: string, contentType: string) => {
      if (!url) return null;
      const response = await fetch(url, { signal: AbortSignal.timeout(120_000), cache: 'no-store' });
      if (!response.ok) throw new Error(`Marble asset HTTP ${response.status}`);
      const body = Buffer.from(await response.arrayBuffer());
      if (!body.length || body.length > MAX_ASSET_BYTES) throw new Error('Marble asset size out of bounds');
      const blob = await put(`${prefix}/${name}`, body, { access: 'private', contentType, addRandomSuffix: false,
        allowOverwrite: true, multipart: body.length > 8 * 1024 * 1024 }); // reclaimed rooms rewrite the same paths
      return blob.pathname;
    };
    // Sequential: bounded memory (largest asset ~29 MB).
    const thumb = await copy(assets.thumb, 'thumb.webp', 'image/webp');
    const pano = await copy(assets.pano, 'pano.png', 'image/png');
    const splatMobile = await copy(assets.splatMobile, 'splat-500k.spz', 'application/octet-stream');
    const splatFull = await copy(assets.splatFull, 'splat-full.spz', 'application/octet-stream');
    const sql = getSql();
    await sql`UPDATE tour_rooms SET status = 'completed', thumb_path = ${thumb}, pano_path = ${pano},
      splat_mobile_path = ${splatMobile}, splat_path = ${splatFull}, error_message = NULL, updated_at = now()
      WHERE id = ${roomId} AND tour_id = ${tourId} AND status = 'finalizing'`;
    await settleMarbleTour(tourId);
  } catch (error) {
    console.error('Marble finalize failed', error instanceof Error ? error.message : 'UnknownError');
  }
}

/** Once every room is terminal: at least one completed room makes the tour payable, otherwise it failed. */
export async function settleMarbleTour(tourId: string): Promise<void> {
  const sql = getSql();
  await sql`UPDATE tours t SET status = CASE WHEN EXISTS (SELECT 1 FROM tour_rooms r WHERE r.tour_id = t.id AND r.status = 'completed')
      THEN 'pendiente_de_pago' ELSE 'error' END, updated_at = now()
    WHERE t.id = ${tourId} AND t.engine = 'marble' AND t.status = 'procesando'
      AND NOT EXISTS (SELECT 1 FROM tour_rooms r WHERE r.tour_id = t.id AND r.status NOT IN ('completed','failed'))`;
}
