import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import Stripe from 'stripe';
import sharp from 'sharp';
import { unzipSync, strFromU8 } from 'fflate';

const state = vi.hoisted(() => ({
  db: null as PGlite | null,
  user: null as { id: string; name: string } | null,
  blobs: new Map<string, Uint8Array>(),
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
  BlobNotFoundError: class BlobNotFoundError extends Error {},
  head: vi.fn(async (path: string) => ({ size: state.blobs.get(path)?.length ?? 0, contentType: 'image/jpeg' })),
  put: vi.fn(async (path: string, content: Uint8Array) => { state.blobs.set(path, content); return { pathname: path }; }),
}));

import { createTourSchema, MAX_FILES, MAX_FILE_BYTES, MAX_TOTAL_BYTES } from '@/lib/contracts';
import { paidCheckoutIdentity } from '@/lib/payment-contract';
import { fulfillCheckout } from '@/lib/fulfillment';
import { getOwnedTour, tourView } from '@/lib/tours';
import { getStripe } from '@/lib/stripe';
import { generateSimulatedTour } from '@/lib/generation';
import { rateLimit } from '@/lib/http';
import { GET as download } from '@/app/api/tours/[id]/download/route';
import { GET as serveImage } from '@/app/api/tours/[id]/images/[imageId]/route';
import { POST as webhook } from '@/app/api/webhooks/stripe/route';
import { POST as createTour } from '@/app/api/tours/route';
import { POST as checkout } from '@/app/api/checkout/route';
import { POST as uploadToken } from '@/app/api/upload/route';
import { POST as reconcileUpload } from '@/app/api/tours/[id]/uploads/[imageId]/route';
import { head as blobHead, BlobNotFoundError } from '@vercel/blob';
import { enqueueReconstruction, claimReconstruction, heartbeatReconstruction, completeReconstruction,
  recoverReconstructionJobs, requireWorker } from '@/lib/reconstruction';
import { GET as model } from '@/app/api/tours/[id]/model.sog/route';
import { GET as viewer } from '@/app/api/tours/[id]/viewer/route';
import { POST as claimJob } from '@/app/api/internal/reconstruction/claim/route';


const owner = '10000000-0000-4000-8000-000000000001';
const other = '20000000-0000-4000-8000-000000000002';
const tourId = '30000000-0000-4000-8000-000000000003';
const attempt = '40000000-0000-4000-8000-000000000004';
const imageId = '50000000-0000-4000-8000-000000000005';
const generation = '60000000-0000-4000-8000-000000000006';
const context = { params: Promise.resolve({ id: tourId }) };
let source: Buffer;
function session(overrides: Partial<Stripe.Checkout.Session> = {}): Stripe.Checkout.Session {
  return { id: 'cs_test_order', object: 'checkout.session', mode: 'payment', payment_status: 'paid',
    status: 'complete', amount_total: 1900, currency: 'eur', livemode: false, client_reference_id: tourId,
    payment_intent: 'pi_test_order', metadata: { tourId, userId: owner, checkoutKey: attempt },
    ...overrides } as Stripe.Checkout.Session;
}
async function orderStatus() {
  return (await state.db!.query<{ status: string }>('SELECT status FROM tours WHERE id = $1', [tourId])).rows[0].status;
}
function post(url: string, body: unknown, origin = 'http://localhost:3000') {
  return new Request(`http://localhost:3000${url}`, { method: 'POST', headers: { origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

beforeAll(async () => {
  Object.assign(process.env, { APP_URL: 'http://localhost:3000', AUTH_SECRET: 'test-only', AUTH_GOOGLE_ID: 'test-only',
    AUTH_GOOGLE_SECRET: 'test-only', DATABASE_URL: 'test-only', STRIPE_SECRET_KEY: 'sk_test_local', STRIPE_WEBHOOK_SECRET: 'whsec_local',
    BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_teststore_testonly' });
  state.db = new PGlite();
  await state.db.exec(await readFile(new URL('../db/001_initial.sql', import.meta.url), 'utf8'));
  await state.db.exec(await readFile(new URL('../db/002_reconstruction.sql', import.meta.url), 'utf8'));
  source = await sharp({ create: { width: 1600, height: 1000, channels: 3, background: '#6383a1' } }).jpeg().toBuffer();
});
beforeEach(async () => {
  vi.restoreAllMocks();
  process.env.RECONSTRUCTION_ENABLED = 'true';
  process.env.RECONSTRUCTION_WORKER_SECRET = 'w'.repeat(64);
  state.user = { id: owner, name: 'Test owner' };
  state.blobs.clear();
  state.blobs.set('sources/test.jpg', source);
  state.blobs.set('private/preview.jpg', new Uint8Array([1, 2, 3]));
  state.blobs.set('private/full.jpg', new Uint8Array([4, 5, 6]));
  state.blobs.set('private/pack.zip', new Uint8Array([80, 75, 3, 4]));
  await state.db!.exec('TRUNCATE app_users CASCADE; TRUNCATE stripe_events, api_rate_limits;');
  await state.db!.query('INSERT INTO app_users (id,google_sub,email) VALUES ($1,$2,$3),($4,$5,$6)',
    [owner, 'google-owner', 'owner@example.invalid', other, 'google-other', 'other@example.invalid']);
  await state.db!.query(`INSERT INTO tours (id,user_id,title,status,checkout_key,archive_path)
    VALUES ($1,$2,'Test property','pendiente_de_pago',$3,'private/pack.zip')`, [tourId, owner, attempt]);
  await state.db!.query(`INSERT INTO tour_images (id,tour_id,ordinal,original_name,content_type,size_bytes,source_path,preview_path,asset_path)
    VALUES ($1,$2,0,'room.jpg','image/jpeg',$3,'sources/test.jpg','private/preview.jpg','private/full.jpg')`, [imageId, tourId, source.length]);
});
afterAll(async () => { await state.db?.close(); });

describe('Upload and access boundaries', () => {
  it('rejects unsupported MIME, too many files and excessive bytes', () => {
    const file = { name: 'room.jpg', type: 'image/jpeg', size: 100 };
    expect(createTourSchema.safeParse({ files: [file] }).success).toBe(true);
    for (const files of [[], [{ ...file, type: 'image/svg+xml' }], Array(MAX_FILES + 1).fill(file),
      [{ ...file, size: MAX_FILE_BYTES + 1 }], Array(Math.floor(MAX_TOTAL_BYTES / MAX_FILE_BYTES) + 1).fill({ ...file, size: MAX_FILE_BYTES })]) {
      expect(createTourSchema.safeParse({ files }).success).toBe(false);
    }
  });
  it('rejects unauthenticated downloads', async () => {
    state.user = null;
    expect((await download(new Request('http://localhost:3000/download'), context)).status).toBe(401);
  });
  it('hides another owner’s tour and rejects its download', async () => {
    await expect(getOwnedTour(tourId, other)).rejects.toMatchObject({ status: 404 });
    state.user = { id: other, name: 'Other' };
    expect((await download(new Request('http://localhost:3000/download'), context)).status).toBe(404);
  });
  it('rejects unpaid downloads even with a success query parameter', async () => {
    expect((await download(new Request('http://localhost:3000/download?checkout=success'), context)).status).toBe(402);
  });
  it('serves only the baked preview before payment, then the clean asset', async () => {
    const params = { params: Promise.resolve({ id: tourId, imageId }) };
    const before = await serveImage(new Request('http://localhost:3000/image?paid=true'), params);
    expect([...new Uint8Array(await before.arrayBuffer())]).toEqual([1, 2, 3]);
    expect(before.headers.get('cache-control')).toContain('no-store');
    await fulfillCheckout('evt_first', session());
    const after = await serveImage(new Request('http://localhost:3000/image'), params);
    expect([...new Uint8Array(await after.arrayBuffer())]).toEqual([4, 5, 6]);
  });
  it('never includes private Blob paths in the client DTO', async () => {
    const view = await tourView(await getOwnedTour(tourId, owner));
    expect(JSON.stringify(view)).not.toContain('private/');
    expect(JSON.stringify(view)).not.toContain('sources/');
    expect(view.images[0].url).toContain('/api/tours/');
  });
  it('rejects cross-origin state changes', async () => {
    const response = await createTour(post('/api/tours', { files: [{ name: 'a.jpg', type: 'image/jpeg', size: 1 }] }, 'https://attacker.invalid'));
    expect(response.status).toBe(403);
  });
  it('does not grant upload tokens without authentication or for another owner’s paths', async () => {
    const body = { type: 'blob.generate-client-token', payload: { pathname: 'sources/test.jpg',
      clientPayload: JSON.stringify({ tourId, imageId }), multipart: false } };
    state.user = null;
    expect((await uploadToken(post('/api/upload', body))).status).toBe(401);
    state.user = { id: other, name: 'Other' };
    expect((await uploadToken(post('/api/upload', body))).status).toBe(403);
  });
  it('blocks new captures and upload tokens while reconstruction is disabled', async () => {
    process.env.RECONSTRUCTION_ENABLED = 'false';
    expect((await createTour(post('/api/tours', { files: [{ name: 'room.jpg', type: 'image/jpeg', size: 10 }] }))).status).toBe(503);
    const body = { type: 'blob.generate-client-token', payload: { pathname: 'sources/test.jpg',
      clientPayload: JSON.stringify({ tourId, imageId }), multipart: false } };
    expect((await uploadToken(post('/api/upload', body))).status).toBe(503);
  });
  it('reconciles uncertain uploads only for their owner and exact metadata', async () => {
    await state.db!.query("UPDATE tours SET status = 'borrador' WHERE id = $1", [tourId]);
    const ctx = { params: Promise.resolve({ id: tourId, imageId }) };
    expect(await (await reconcileUpload(post('/reconcile', {}), ctx)).json()).toEqual({ uploaded: true });
    vi.mocked(blobHead).mockResolvedValueOnce({ size: 1, contentType: 'image/jpeg' } as Awaited<ReturnType<typeof blobHead>>);
    expect((await reconcileUpload(post('/reconcile', {}), ctx)).status).toBe(409);
    vi.mocked(blobHead).mockRejectedValueOnce(new BlobNotFoundError());
    expect(await (await reconcileUpload(post('/reconcile', {}), ctx)).json()).toEqual({ uploaded: false });
    state.user = { id: other, name: 'Other' };
    expect((await reconcileUpload(post('/reconcile', {}), ctx)).status).toBe(404);
  });
  it('reserves upload paths server-side with a fixed owner and price', async () => {
    const response = await createTour(post('/api/tours', { userId: other, amount: 1,
      title: '<script>anything</script>', files: [{ name: '../../image.jpg', type: 'image/jpeg', size: 10 }] }));
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.uploads[0].pathname).toContain(`sources/${owner}/`);
    expect(body.uploads[0].pathname).not.toContain('..');
    const actual = await getOwnedTour(body.tourId, owner);
    expect(actual.amount_cents).toBe(1900);
    expect(actual.status).toBe('borrador');
  });
  it('enforces a persistent per-user rate limit', async () => {
    await rateLimit(owner, 'example', 1);
    await expect(rateLimit(owner, 'example', 1)).rejects.toMatchObject({ status: 429 });
    await expect(rateLimit(other, 'example', 1)).resolves.toBeUndefined();
  });
});

describe('Stripe contracts and real SQL fulfillment', () => {
  it('rejects altered amount, currency, mode, live mode or reference', () => {
    for (const override of [{ amount_total: 1 }, { currency: 'usd' }, { mode: 'subscription' as const },
      { livemode: true }, { client_reference_id: other }]) {
      expect(() => paidCheckoutIdentity(session(override))).toThrow();
    }
  });
  it('does not fulfill an unpaid completed session', async () => {
    await fulfillCheckout('evt_unpaid', session({ payment_status: 'unpaid' }));
    expect(await orderStatus()).toBe('pendiente_de_pago');
  });
  it('atomically fulfills payment and makes repeated delivery harmless', async () => {
    await fulfillCheckout('evt_repeat', session());
    await fulfillCheckout('evt_repeat', session());
    expect(await orderStatus()).toBe('pagado');
    expect((await state.db!.query('SELECT * FROM stripe_events')).rows).toHaveLength(1);
    const response = await download(new Request('http://localhost:3000/download'), context);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain('attachment');
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([80, 75, 3, 4]);
  });
  it('rejects a validly signed payment belonging to another owner or attempt', async () => {
    for (const metadata of [{ tourId, userId: other, checkoutKey: attempt }, { tourId, userId: owner, checkoutKey: other }]) {
      await expect(fulfillCheckout('evt_mismatch', session({ metadata }))).rejects.toThrow();
    }
    expect(await orderStatus()).toBe('pendiente_de_pago');
    expect((await state.db!.query('SELECT * FROM stripe_events')).rows).toHaveLength(0);
  });
  it('accepts a genuine test signature and rejects a mutated raw body', async () => {
    const sdk = new Stripe('sk_test_local');
    const payload = JSON.stringify({ id: 'evt_signed', type: 'checkout.session.completed', data: { object: session() } });
    const signature = sdk.webhooks.generateTestHeaderString({ payload, secret: 'whsec_local' });
    const invalid = await webhook(new Request('http://localhost:3000/api/webhooks/stripe', {
      method: 'POST', headers: { 'stripe-signature': signature }, body: payload.replace('1900', '1800'),
    }));
    expect(invalid.status).toBe(400);
    expect(await orderStatus()).toBe('pendiente_de_pago');
    const valid = await webhook(new Request('http://localhost:3000/api/webhooks/stripe', {
      method: 'POST', headers: { 'stripe-signature': signature }, body: payload,
    }));
    expect(valid.status).toBe(200);
    expect(await orderStatus()).toBe('pagado');
  });
  it('creates a fixed-price checkout and reuses it on a second click', async () => {
    const sdk = getStripe();
    const create = vi.spyOn(sdk.checkout.sessions, 'create').mockResolvedValue({ id: 'cs_test_order', url: 'https://checkout.stripe.com/c/pay/test' } as never);
    vi.spyOn(sdk.checkout.sessions, 'retrieve').mockResolvedValue({ id: 'cs_test_order', url: 'https://checkout.stripe.com/c/pay/test', status: 'open' } as never);
    const response = await checkout(post('/api/checkout', { tourId, price: 1, currency: 'usd', userId: other }));
    expect(response.status).toBe(200);
    expect(create.mock.calls[0][0]?.line_items?.[0].price_data?.unit_amount).toBe(1900);
    expect(create.mock.calls[0][1]?.idempotencyKey).toBe(`astratour:${tourId}:${attempt}`);
    expect((await checkout(post('/api/checkout', { tourId }))).status).toBe(200);
    expect(create).toHaveBeenCalledTimes(1);
  });
  it('blocks live Stripe credentials for a simulated product', () => {
    const key = process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_SECRET_KEY = 'sk_live_not_a_real_key';
    try { expect(() => getStripe()).toThrow('modo de prueba'); } finally { process.env.STRIPE_SECRET_KEY = key; }
  });
});

describe('Image pipeline', () => {
  it('rejects disguised non-image bytes before decoding them', async () => {
    const forged = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
    state.blobs.set('sources/test.jpg', forged);
    await state.db!.query('UPDATE tour_images SET size_bytes=$1 WHERE id=$2', [forged.length, imageId]);
    const image = (await state.db!.query('SELECT * FROM tour_images WHERE id=$1', [imageId])).rows[0];
    await expect(generateSimulatedTour(tourId, owner, generation, [image as never])).rejects.toMatchObject({ status: 400 });
  });
  it('produces a baked watermark, private artifacts and an honest downloadable pack', async () => {
    await state.db!.query(`UPDATE tours SET status='procesando',generation_token=$1 WHERE id=$2`, [generation, tourId]);
    const image = (await state.db!.query('SELECT * FROM tour_images WHERE id=$1', [imageId])).rows[0];
    await generateSimulatedTour(tourId, owner, generation, [image as never]);
    expect(await orderStatus()).toBe('pendiente_de_pago');
    const result = (await state.db!.query<{ preview_path: string; asset_path: string }>('SELECT * FROM tour_images WHERE id=$1', [imageId])).rows[0];
    const preview = state.blobs.get(result.preview_path)!;
    expect((await sharp(preview).metadata()).width).toBe(1200);
    const { channels } = await sharp(preview).stats();
    expect(channels[0].max - channels[0].min).toBeGreaterThan(40); // Burned text changes pixels on a uniform source.
    const row = await getOwnedTour(tourId, owner);
    const pack = unzipSync(state.blobs.get(row.archive_path!)!);
    expect(Object.keys(pack)).toEqual(expect.arrayContaining(['index.html', 'manifest.json', 'images/01.jpg']));
    expect(JSON.parse(strFromU8(pack['manifest.json'])).is3D).toBe(false);
    expect(strFromU8(pack['index.html'])).toContain('no contiene una reconstrucción 3D');
  });
});

describe('Durable 3D reconstruction and protected SuperSplat delivery', () => {
  async function queuedJob() {
    await state.db!.query("UPDATE tours SET status='borrador', archive_path=NULL WHERE id=$1", [tourId]);
    await enqueueReconstruction(tourId, owner);
    return await claimReconstruction('test-worker');
  }
  beforeEach(() => {
    process.env.RECONSTRUCTION_ENABLED = 'true';
    process.env.RECONSTRUCTION_WORKER_SECRET = 'worker-secret-for-tests-only-32-chars';
  });
  it('rejects missing and invalid worker authorization', async () => {
    expect((await claimJob(post('/api/internal/reconstruction/claim', { workerId: 'test' }))).status).toBe(401);
    expect(() => requireWorker(new Request('https://example.invalid', { headers: { authorization: 'Bearer wrong' } }))).toThrow();
  });
  it('does not allow GPU work when the deployment gate is disabled', async () => {
    process.env.RECONSTRUCTION_ENABLED = 'false';
    await expect(claimReconstruction('test')).rejects.toMatchObject({ status: 503 });
  });
  it('queues idempotently and claims each job only once', async () => {
    const job = await queuedJob();
    expect(job).toMatchObject({ tourId, userId: owner, attempt: 1 });
    await enqueueReconstruction(tourId, owner);
    expect(await claimReconstruction('second-worker')).toBe(null);
    expect((await state.db!.query('SELECT * FROM reconstruction_jobs')).rows).toHaveLength(1);
    expect(await orderStatus()).toBe('procesando');
  });
  it('fences a stale worker after lease expiry and reassignment', async () => {
    const first = await queuedJob();
    await state.db!.query("UPDATE reconstruction_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [first!.id]);
    const second = await claimReconstruction('second');
    expect(second!.token).not.toBe(first!.token);
    expect(second!.attempt).toBe(2);
    await expect(heartbeatReconstruction(first!.id as string, { token: first!.token, progress: 70, stage: 'training' })).rejects.toMatchObject({ status: 409 });
    await expect(heartbeatReconstruction(second!.id as string, { token: second!.token, progress: 30, stage: 'training' })).resolves.toHaveProperty('leaseExpiresAt');
  });
  it('does not resurrect an expired lease without reassignment', async () => {
    const job = await queuedJob();
    await state.db!.query("UPDATE reconstruction_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [job!.id]);
    await expect(heartbeatReconstruction(job!.id as string, { token: job!.token, progress: 50, stage: 'training' })).rejects.toMatchObject({ status: 409 });
  });
  it('bounds retries and moves an exhausted reconstruction to error', async () => {
    const job = await queuedJob();
    await state.db!.query("UPDATE reconstruction_jobs SET attempts=3,lease_expires_at=now()-interval '1 second' WHERE id=$1", [job!.id]);
    await recoverReconstructionJobs();
    expect(await claimReconstruction('test')).toBe(null);
    expect(await orderStatus()).toBe('error');
  });
  it('does not publish artifacts from a different path or attempt', async () => {
    const job = await queuedJob();
    await expect(completeReconstruction(job!.id as string, { token: job!.token,
      modelPath: 'generated/other/scene.sog', archivePath: 'generated/other/pack.zip',
      camera: { position: [0, 0, 3], target: [0, 0, 0], fov: 60 },
      previews: [{ imageId, path: 'generated/other/preview.jpg' }],
    })).rejects.toMatchObject({ status: 400 });
    expect(await orderStatus()).toBe('procesando');
  });
  it('atomically publishes real artifacts, hides the model until payment and serves the paid viewer', async () => {
    const job = await queuedJob();
    const prefix = job!.outputPrefix;
    const payload = { token: job!.token, modelPath: `${prefix}/scene.sog`, archivePath: `${prefix}/astratour-pack.zip`,
      camera: { position: [0, 0, 3] as [number, number, number], target: [0, 0, 0] as [number, number, number], fov: 60 },
      previews: [{ imageId, path: `${prefix}/previews/${imageId}.jpg` }],
    };
    state.blobs.set(payload.modelPath, new Uint8Array([80, 75, 3, 4]));
    state.blobs.set(payload.archivePath, new Uint8Array([80, 75, 3, 4]));
    state.blobs.set(payload.previews[0].path, source);
    vi.mocked(blobHead).mockImplementation(async (path: string) => ({ size: state.blobs.get(path)?.length ?? 0,
      contentType: path.endsWith('.jpg') ? 'image/jpeg' : 'application/octet-stream' }) as never);
    await completeReconstruction(job!.id as string, payload);
    await completeReconstruction(job!.id as string, payload); // successful response lost: safe to retry
    expect(await orderStatus()).toBe('pendiente_de_pago');
    expect((await tourView(await getOwnedTour(tourId, owner))).modelUrl).toBe(null);
    expect((await model(new Request('http://localhost:3000/model?paid=true'), context)).status).toBe(402);
    expect((await viewer(new Request('http://localhost:3000/viewer'), context)).status).toBe(402);
    await fulfillCheckout('evt_3d', session());
    const paidView = await tourView(await getOwnedTour(tourId, owner));
    expect(paidView.simulated).toBe(false);
    expect(paidView.modelUrl).toBe(`/api/tours/${tourId}/model.sog`);
    const response = await viewer(new Request('http://localhost:3000/viewer?lang=es'), context);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'self'");
    const html = await response.text();
    expect(html).toContain(`/api/tours/${tourId}/model.sog`);
    expect(html).not.toContain('generated/');
    expect(html).not.toContain(process.env.RECONSTRUCTION_WORKER_SECRET);
    const asset = await model(new Request('http://localhost:3000/model.sog'), context);
    expect(asset.status).toBe(200);
    state.user = { id: other, name: 'Other' };
    expect((await model(new Request('http://localhost:3000/model.sog'), context)).status).toBe(404);
    expect((await viewer(new Request('http://localhost:3000/viewer'), context)).status).toBe(404);
  });
  it('blocks SuperSplat query-string overrides to arbitrary remote assets', async () => {
    await state.db!.query("UPDATE tours SET simulated=false,model_path='private/scene.sog',viewer_settings=$1::jsonb WHERE id=$2",
      [JSON.stringify({ position: [0, 0, 3], target: [0, 0, 0], fov: 60 }), tourId]);
    await fulfillCheckout('evt_viewer', session());
    expect((await viewer(new Request('http://localhost:3000/viewer?content=https://attacker.invalid/model.sog'), context)).status).toBe(400);
  });
  it('validates capture counts consistently in API and database', async () => {
    expect(createTourSchema.safeParse({ files: Array(500).fill({ name: 'x.jpg', type: 'image/jpeg', size: 100 }) }).success).toBe(true);
    await state.db!.query('UPDATE tour_images SET ordinal=499 WHERE id=$1', [imageId]);
    await expect(state.db!.query('UPDATE tour_images SET ordinal=500 WHERE id=$1', [imageId])).rejects.toThrow();
  });
});
