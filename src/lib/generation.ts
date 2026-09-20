import 'server-only';
import sharp from 'sharp';
import { get, head, put } from '@vercel/blob';
import { strToU8, zipSync } from 'fflate';
import { getSql } from '@/lib/db';
import { HttpError } from '@/lib/http';
import { MAX_FILE_BYTES, type ImageRow } from '@/lib/contracts';

async function readPrivateImage(image: ImageRow) {
  const meta = await head(image.source_path);
  if (meta.size !== image.size_bytes || meta.size > MAX_FILE_BYTES ||
    meta.contentType !== image.content_type) throw new HttpError(400, 'Una imagen no coincide con la carga autorizada.');
  const blob = await get(image.source_path, { access: 'private', useCache: false });
  if (!blob || blob.statusCode !== 200 || !blob.stream) throw new HttpError(409, 'Una imagen sigue subiendo. Reintenta la generación.');
  const input = Buffer.from(await new Response(blob.stream).arrayBuffer());
  if (input.length > MAX_FILE_BYTES) throw new HttpError(413, 'Imagen demasiado grande.');
  const jpeg = input.length > 3 && input[0] === 0xff && input[1] === 0xd8 && input[2] === 0xff;
  const png = input.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if ((!jpeg && !png) || (jpeg && image.content_type !== 'image/jpeg') || (png && image.content_type !== 'image/png')) {
    throw new HttpError(400, 'El contenido de la imagen no es un JPG o PNG válido.');
  }
  const decoded = sharp(input, { limitInputPixels: 25_000_000, animated: false, failOn: 'error' });
  const metadata = await decoded.metadata();
  if (!['jpeg', 'png'].includes(metadata.format ?? '') || (metadata.pages ?? 1) !== 1) {
    throw new HttpError(400, 'Solo se admiten JPG y PNG estáticos válidos.');
  }
  // Rotate EXIF orientation, remove metadata (including location) and normalize.
  return decoded.rotate().jpeg({ quality: 94, mozjpeg: true }).toBuffer();
}

export async function watermarkedPreview(input: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(input).resize({ width: 1200, height: 900, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 75 }).toBuffer({ resolveWithObject: true });
  const fontSize = Math.max(11, Math.round(info.width / 34));
  const lines = [0.22, 0.5, 0.78].map(y => `<text x="50%" y="${Math.round(info.height * y)}" dominant-baseline="middle" text-anchor="middle" font-family="sans-serif" font-weight="700" font-size="${fontSize}" fill="white" fill-opacity="0.66" stroke="black" stroke-opacity="0.32" stroke-width="1">VISTA PREVIA - Requiere Pago</text>`).join('');
  const svg = Buffer.from(`<svg width="${info.width}" height="${info.height}" xmlns="http://www.w3.org/2000/svg">${lines}</svg>`);
  return sharp(data).composite([{ input: svg }]).jpeg({ quality: 78 }).toBuffer();
}

function offlineViewer(count: number): string {
  // Only trusted numbers and generated filenames are interpolated. Never user-supplied HTML.
  return `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AstraTour Express · Demostración</title>
<style>body{margin:0;background:#0a0a0d;color:#fff;font:16px system-ui;display:grid;min-height:100vh;place-content:center;gap:20px;text-align:center}img{width:min(94vw,1200px);height:70vh;object-fit:contain}button{border:1px solid #777;border-radius:9px;padding:12px 22px;background:#222;color:#fff;font:inherit;cursor:pointer}p{color:#aaa;padding:0 20px}</style>
<h1>AstraTour Express</h1><p>Pack de demostración. Visor de imágenes planas; no contiene una reconstrucción 3D.</p>
<img id="scene" alt="Imagen de la propiedad" src="images/01.jpg"><nav><button id="prev">← Anterior</button> <span id="count">1 / ${count}</span> <button id="next">Siguiente →</button></nav>
<script>let i=0;const n=${count};function show(d){i=(i+d+n)%n;document.getElementById('scene').src='images/'+String(i+1).padStart(2,'0')+'.jpg';document.getElementById('count').textContent=(i+1)+' / '+n}document.getElementById('prev').onclick=()=>show(-1);document.getElementById('next').onclick=()=>show(1);document.addEventListener('keydown',e=>{if(e.key==='ArrowLeft')show(-1);if(e.key==='ArrowRight')show(1)})</script></html>`;
}

/** Replace this adapter with a real, durable reconstruction job before selling 3D tours. */
export async function generateSimulatedTour(tourId: string, userId: string, generationToken: string, images: ImageRow[]) {
  const prefix = `generated/${userId}/${tourId}/${generationToken}`;
  const files: Record<string, Uint8Array> = {};
  const results: { id: string; preview_path: string; asset_path: string }[] = [];
  for (const [index, image] of images.entries()) {
    const full = await readPrivateImage(image);
    const preview = await watermarkedPreview(full);
    // Decode sequentially: bounded CPU/memory per request. Independent writes can run concurrently.
    const [assetBlob, previewBlob] = await Promise.all([
      put(`${prefix}/images/${image.id}.jpg`, full, { access: 'private', contentType: 'image/jpeg', addRandomSuffix: false }),
      put(`${prefix}/previews/${image.id}.jpg`, preview, { access: 'private', contentType: 'image/jpeg', addRandomSuffix: false }),
    ]);
    files[`images/${String(index + 1).padStart(2, '0')}.jpg`] = full;
    results.push({ id: image.id, asset_path: assetBlob.pathname, preview_path: previewBlob.pathname });
  }
  files['index.html'] = strToU8(offlineViewer(images.length));
  files['manifest.json'] = strToU8(JSON.stringify({ version: 1, tourId, engine: 'simulation', is3D: false,
    description: 'Imágenes normalizadas y visor HTML. No es una reconstrucción 3D.', imageCount: images.length }, null, 2));
  const archive = zipSync(files, { level: 0 });
  const blob = await put(`${prefix}/astratour-pack.zip`, Buffer.from(archive), {
    access: 'private', contentType: 'application/zip', addRandomSuffix: false,
  });
  const sql = getSql();
  const updated = await sql`
    WITH images_updated AS (
      UPDATE tour_images i SET preview_path = x.preview_path, asset_path = x.asset_path, source_uploaded = true
      FROM jsonb_to_recordset(${JSON.stringify(results)}::jsonb) AS x(id uuid, preview_path text, asset_path text), tours t
      WHERE i.id = x.id AND i.tour_id = t.id AND t.id = ${tourId} AND t.user_id = ${userId}
        AND t.generation_token = ${generationToken} AND t.status = 'procesando' RETURNING i.id
    )
    UPDATE tours SET status = 'pendiente_de_pago', archive_path = ${blob.pathname}, updated_at = now()
    WHERE id = ${tourId} AND user_id = ${userId} AND generation_token = ${generationToken}
      AND status = 'procesando' AND (SELECT count(*) FROM images_updated) = ${images.length}
    RETURNING id`;
  if (!updated.length) throw new Error('Generation lease lost');
}
