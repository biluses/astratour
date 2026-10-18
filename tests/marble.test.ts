import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const state = vi.hoisted(() => ({
  db: null as PGlite | null,
  user: null as { id: string; name: string } | null,
  blobs: new Map<string, Uint8Array>(),
  pending: [] as Promise<unknown>[],
  submits: [] as { url: string; headers: Record<string, string>; body: Record<string, unknown> }[],
  operations: new Map<string, unknown>(),
  nextOperation: 0,
}));
vi.mock('@/lib/db', () => ({ getSql: () => async (parts: TemplateStringsArray, ...values: unknown[]) => {
  const query = parts.reduce((text, part, i) => text + (i ? `$${i}` : '') + part, '');
  return (await state.db!.query(query, values)).rows;
} }));
vi.mock('@/auth', () => ({ auth: async () => state.user ? { user: state.user } : null }));
vi.mock('@vercel/blob', () => ({
  get: vi.fn(async (path: string) => state.blobs.has(path) ? {
    statusCode: 200, stream: new ReadableStream({ start(controller) { controller.enqueue(state.blobs.get(path)); controller.close(); } }),
  } : null),
  head: vi.fn(async (path: string) => ({ size: state.blobs.get(path)?.length ?? 0, contentType: 'image/jpeg' })),
  put: vi.fn(async (path: string, content: Uint8Array) => { state.blobs.set(path, new Uint8Array(content)); return { pathname: path }; }),
  BlobNotFoundError: class BlobNotFoundError extends Error {},
}));
// after() needs a Next request scope: collect the callbacks so tests can await them.
vi.mock('next/server', async original => ({ ...await original<typeof import('next/server')>(),
  after: (task: () => unknown) => { state.pending.push(Promise.resolve().then(task)); } }));

import { advanceMarbleTour, finalizeRoom, generateWorld, operationAssets, sendRoom } from '@/lib/marble';
import { POST as createTour } from '@/app/api/tours/route';
import { POST as processTour } from '@/app/api/tours/[id]/process/route';
import { GET as getTour } from '@/app/api/tours/[id]/route';
import { GET as roomAsset } from '@/app/api/tours/[id]/rooms/[roomId]/[asset]/route';
import { GET as download } from '@/app/api/tours/[id]/download/route';
import { fulfillCheckout } from '@/lib/fulfillment';
import type Stripe from 'stripe';

const KEY = 'wl-test-key-must-never-leak';
const owner = '10000000-0000-4000-8000-000000000001';
const other = '20000000-0000-4000-8000-000000000002';
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
const CDN = 'https://cdn.marble.worldlabs.ai/world';
const success = { done: true, error: null, response: { world_id: 'world-1', assets: {
  thumbnail_url: `${CDN}/thumb.webp`, imagery: { pano_url: `${CDN}/pano.png` },
  splats: { spz_urls: { '500k': `${CDN}/500k.spz`, full_res: `${CDN}/full.spz` } } } } };
const failure = { done: true, error: { message: 'generation failed' } };

function post(url: string, body: unknown) {
  return new Request(`http://localhost:3000${url}`, { method: 'POST', headers: { origin: 'http://localhost:3000', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
const ctx = <T extends object>(params: T) => ({ params: Promise.resolve(params) });
const room = (name: string, azimuths: number[]) => ({ name, files: azimuths.map((azimuth, i) => ({ name: `${name}-${i}.jpg`, type: 'image/jpeg', size: JPEG.length, azimuth })) });
async function settled() { while (state.pending.length) await Promise.all(state.pending.splice(0)); }
async function rows<T>(query: string, params: unknown[] = []) { return (await state.db!.query<T>(query, params)).rows; }
async function tourStatus(id: string) { return (await rows<{ status: string }>('SELECT status FROM tours WHERE id = $1', [id]))[0].status; }
async function roomsOf(id: string) {
  return rows<{ id: string; status: string; operation_id: string | null; attempts: number; splat_path: string | null }>(
    'SELECT * FROM tour_rooms WHERE tour_id = $1 ORDER BY ordinal', [id]);
}
async function createMarbleTour(rooms: ReturnType<typeof room>[]) {
  const response = await createTour(post('/api/tours', { engine: 'marble', title: 'Piso', rooms }));
  expect(response.status).toBe(201);
  const body = await response.json() as { tourId: string; uploads: { pathname: string }[] };
  for (const upload of body.uploads) state.blobs.set(upload.pathname, JPEG);
  return body;
}

beforeAll(async () => {
  Object.assign(process.env, { APP_URL: 'http://localhost:3000', AUTH_SECRET: 'test-only', AUTH_GOOGLE_ID: 'test-only',
    AUTH_GOOGLE_SECRET: 'test-only', DATABASE_URL: 'test-only' });
  state.db = new PGlite();
  for (const file of ['001_initial.sql', '002_reconstruction.sql', '003_marble_rooms.sql']) {
    await state.db.exec(await readFile(new URL(`../db/${file}`, import.meta.url), 'utf8'));
  }
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/worlds:generate')) {
      state.submits.push({ url, headers: init!.headers as Record<string, string>, body: JSON.parse(init!.body as string) });
      return Response.json({ operation_id: `op-${++state.nextOperation}` });
    }
    if (url.includes('/operations/')) return Response.json(state.operations.get(decodeURIComponent(url.split('/').pop()!)) ?? { done: false });
    if (url.startsWith(CDN)) return new Response(new Uint8Array([7, 7, 7]));
    return new Response('nope', { status: 404 });
  }));
});
beforeEach(async () => {
  Object.assign(process.env, { MARBLE_ENABLED: 'true', WORLD_LABS_API_KEY: KEY, RECONSTRUCTION_ENABLED: 'false' });
  delete process.env.MARBLE_MAX_ROOMS;
  state.user = { id: owner, name: 'Owner' };
  state.blobs.clear(); state.submits.length = 0; state.operations.clear(); state.pending.length = 0;
  await state.db!.exec('TRUNCATE app_users CASCADE; TRUNCATE api_rate_limits, stripe_events;');
  await state.db!.query('INSERT INTO app_users (id,google_sub,email) VALUES ($1,$2,$3),($4,$5,$6)',
    [owner, 'google-owner', 'owner@example.invalid', other, 'google-other', 'other@example.invalid']);
});
afterAll(async () => { vi.unstubAllGlobals(); await state.db?.close(); });

describe('Marble client', () => {
  it('sends the gen.py request shape with the WLT-Api-Key header', async () => {
    expect(await generateWorld('room', [{ azimuth: 0, jpeg: Buffer.from(JPEG) }, { azimuth: 72.5, jpeg: Buffer.from([1]) }])).toBe('op-1');
    expect(state.submits[0].url).toBe('https://api.worldlabs.ai/marble/v1/worlds:generate');
    expect(state.submits[0].headers['WLT-Api-Key']).toBe(KEY);
    expect(state.submits[0].body).toEqual({ display_name: 'room', model: 'marble-1.1', world_prompt: { type: 'multi-image',
      reconstruct_images: true, multi_image_prompt: [
        { azimuth: 0, content: { source: 'data_base64', extension: 'jpg', data_base64: Buffer.from(JPEG).toString('base64') } },
        { azimuth: 72.5, content: { source: 'data_base64', extension: 'jpg', data_base64: 'AQ==' } }] } });
  });
  it('reports only the status code on HTTP errors, never the key or the provider body', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(`invalid key ${KEY}`, { status: 401 }));
    const error = await generateWorld('room', []).catch((e: Error) => e);
    expect((error as Error).message).toBe('Marble HTTP 401');
    expect(JSON.stringify(error)).not.toContain(KEY);
  });
  it('only accepts asset URLs on World Labs hosts over HTTPS', () => {
    expect(operationAssets(success)).not.toBeNull();
    const evil = structuredClone(success);
    evil.response.assets.splats.spz_urls['500k'] = 'https://attacker.invalid/500k.spz';
    expect(operationAssets(evil)).toBeNull();
    evil.response.assets.splats.spz_urls['500k'] = 'http://cdn.marble.worldlabs.ai/500k.spz';
    expect(operationAssets(evil)).toBeNull();
  });
});

describe('Marble tour creation', () => {
  it('stores rooms, ordered photos and azimuths; rejects bad captures and the disabled switch', async () => {
    const { tourId, uploads } = await createMarbleTour([room('Salón', [10, 80, 150, 220, 290]), room('Cocina', [0, 60, 120, 180, 240, 300])]);
    expect(uploads).toHaveLength(11);
    const stored = await rows<{ name: string; azimuth: number; ordinal: number; room: string }>(`SELECT i.original_name AS name, i.azimuth, i.ordinal,
      r.name AS room FROM tour_images i JOIN tour_rooms r ON r.id = i.room_id WHERE i.tour_id = $1 ORDER BY i.ordinal`, [tourId]);
    expect(stored.map(s => s.room)).toEqual([...Array(5).fill('Salón'), ...Array(6).fill('Cocina')]);
    expect(stored[1].azimuth).toBe(80);
    expect((await rows<{ engine: string }>('SELECT engine FROM tours WHERE id = $1', [tourId]))[0].engine).toBe('marble');
    expect((await createTour(post('/api/tours', { engine: 'marble', rooms: [room('A', [1, 2, 3, 4])] }))).status).toBe(400);
    const noAzimuth = room('A', [1, 2, 3, 4, 5]);
    delete (noAzimuth.files[0] as { azimuth?: number }).azimuth;
    expect((await createTour(post('/api/tours', { engine: 'marble', rooms: [noAzimuth] }))).status).toBe(400);
    process.env.MARBLE_MAX_ROOMS = '1';
    expect((await createTour(post('/api/tours', { engine: 'marble', rooms: [room('A', [1, 2, 3, 4, 5]), room('B', [1, 2, 3, 4, 5])] }))).status).toBe(400);
    process.env.MARBLE_ENABLED = 'false';
    expect((await createTour(post('/api/tours', { engine: 'marble', rooms: [room('A', [1, 2, 3, 4, 5])] }))).status).toBe(503);
  });
});

describe('Marble room lifecycle', () => {
  it('submits, claims each success once, resubmits once, and settles with a failed room', async () => {
    const { tourId } = await createMarbleTour([room('Salón', [100, 145, 190, 235, 280]), room('Cocina', [0, 72, 144, 216, 288])]);
    const response = await processTour(post(`/api/tours/${tourId}/process`, {}), ctx({ id: tourId }));
    expect(response.status).toBe(202);
    expect((await processTour(post(`/api/tours/${tourId}/process`, {}), ctx({ id: tourId }))).status).toBe(200); // repeated click: no new claim
    await settled();
    expect(state.submits).toHaveLength(2);
    const salonSubmit = state.submits.find(s => (s.body.world_prompt as { multi_image_prompt: { azimuth: number }[] }).multi_image_prompt[1].azimuth === 45)!;
    // Relative to the first photo: 100,145,190,235,280 -> 0,45,90,135,180.
    expect((salonSubmit.body.world_prompt as { multi_image_prompt: { azimuth: number }[] }).multi_image_prompt.map(p => p.azimuth)).toEqual([0, 45, 90, 135, 180]);
    const [salon, cocina] = await roomsOf(tourId);
    expect(salon).toMatchObject({ status: 'generating', attempts: 1 });
    expect(await tourStatus(tourId)).toBe('procesando');

    state.operations.set(salon.operation_id!, success);
    state.operations.set(cocina.operation_id!, failure);
    const [a, b] = await Promise.all([advanceMarbleTour(tourId), advanceMarbleTour(tourId)]);
    expect([...a.finalize, ...b.finalize].map(f => f.roomId)).toEqual([salon.id]);
    expect([...a.resubmit, ...b.resubmit]).toEqual([cocina.id]);
    await finalizeRoom(tourId, owner, salon.id, [...a.finalize, ...b.finalize][0].assets);
    expect((await roomsOf(tourId))[0]).toMatchObject({ status: 'completed', splat_path: `generated/${owner}/${tourId}/rooms/${salon.id}/splat-full.spz` });
    expect(state.blobs.has(`generated/${owner}/${tourId}/rooms/${salon.id}/thumb.webp`)).toBe(true);
    expect(await tourStatus(tourId)).toBe('procesando');

    await sendRoom(cocina.id);
    const retried = (await roomsOf(tourId))[1];
    expect(retried).toMatchObject({ status: 'generating', attempts: 2 });
    expect(state.submits).toHaveLength(3);
    state.operations.set(retried.operation_id!, failure);
    expect((await advanceMarbleTour(tourId)).resubmit).toEqual([]);
    expect((await roomsOf(tourId))[1].status).toBe('failed');
    expect(await tourStatus(tourId)).toBe('pendiente_de_pago');
    expect(state.submits).toHaveLength(3); // no third paid attempt

    // The polled view lists rooms; assets stay gated like model.sog.
    const view = await (await getTour(new Request('http://localhost:3000'), ctx({ id: tourId }))).json();
    expect(view.rooms.map((r: { status: string }) => r.status)).toEqual(['completed', 'failed']);
    expect(JSON.stringify(view)).not.toContain('generated/');
    const asset = (name: string) => roomAsset(new Request('http://localhost:3000'), ctx({ id: tourId, roomId: salon.id, asset: name }));
    expect((await asset('thumb.webp')).status).toBe(200);
    expect((await asset('splat-500k.spz')).status).toBe(402);
    expect((await asset('../../secret')).status).toBe(404);
    expect((await download(new Request('http://localhost:3000'), ctx({ id: tourId }))).status).toBe(404);
    const [{ checkout_key }] = await rows<{ checkout_key: string }>('SELECT checkout_key FROM tours WHERE id = $1', [tourId]);
    await fulfillCheckout('evt_marble', { id: 'cs_test_marble', mode: 'payment', payment_status: 'paid', status: 'complete',
      amount_total: 1900, currency: 'eur', livemode: false, client_reference_id: tourId, payment_intent: 'pi_test',
      metadata: { tourId, userId: owner, checkoutKey: checkout_key } } as unknown as Stripe.Checkout.Session);
    expect(await tourStatus(tourId)).toBe('pagado');
    const paid = await asset('splat-full.spz');
    expect(paid.status).toBe(200);
    expect([...new Uint8Array(await paid.arrayBuffer())]).toEqual([7, 7, 7]);
    state.user = { id: other, name: 'Other' };
    expect((await asset('splat-full.spz')).status).toBe(404);
  });

  it('moves the tour to error when every room fails twice', async () => {
    const { tourId } = await createMarbleTour([room('Salón', [0, 72, 144, 216, 288])]);
    await processTour(post(`/api/tours/${tourId}/process`, {}), ctx({ id: tourId }));
    await settled();
    state.operations.set((await roomsOf(tourId))[0].operation_id!, failure);
    const { resubmit } = await advanceMarbleTour(tourId);
    await Promise.all(resubmit.map(sendRoom));
    state.operations.set((await roomsOf(tourId))[0].operation_id!, failure);
    await advanceMarbleTour(tourId);
    expect((await roomsOf(tourId))[0]).toMatchObject({ status: 'failed', attempts: 2 });
    expect(await tourStatus(tourId)).toBe('error');
  });

  it('fails a room whose submit fails without discarding the others, and reclaims stale finalizing rooms', async () => {
    const { tourId, uploads } = await createMarbleTour([room('Salón', [0, 72, 144, 216, 288]), room('Cocina', [0, 72, 144, 216, 288])]);
    state.blobs.delete(uploads[0].pathname); // Salón cannot be read
    await processTour(post(`/api/tours/${tourId}/process`, {}), ctx({ id: tourId }));
    await settled();
    const [salon, cocina] = await roomsOf(tourId);
    expect(salon.status).toBe('failed');
    expect(cocina.status).toBe('generating');
    state.operations.set(cocina.operation_id!, success);
    expect((await advanceMarbleTour(tourId)).finalize).toHaveLength(1);
    expect((await advanceMarbleTour(tourId)).finalize).toHaveLength(0); // finalize still running elsewhere
    await state.db!.query("UPDATE tour_rooms SET updated_at = now() - interval '11 minutes' WHERE id = $1", [cocina.id]);
    const { finalize } = await advanceMarbleTour(tourId);
    expect(finalize).toHaveLength(1);
    await finalizeRoom(tourId, owner, cocina.id, finalize[0].assets);
    expect(await tourStatus(tourId)).toBe('pendiente_de_pago');
  });
});
