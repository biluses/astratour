import { BlobNotFoundError, head } from '@vercel/blob';
import { uuidSchema } from '@/lib/contracts';
import { getSql } from '@/lib/db';
import { getOwnedTour } from '@/lib/tours';
import { apiError, HttpError, json, rateLimit, requireSameOrigin, requireUser } from '@/lib/http';

export const runtime = 'nodejs';

// Reconcile an upload whose HTTP response was lost; never allow overwriting an original.
export async function POST(request: Request, { params }: { params: Promise<{ id: string; imageId: string }> }) {
  try {
    requireSameOrigin(request);
    const user = await requireUser();
    const { id, imageId } = await params;
    uuidSchema.parse(imageId);
    const tour = await getOwnedTour(id, user.id);
    if (tour.status !== 'borrador') throw new HttpError(409, 'La captura ya está cerrada.');
    await rateLimit(user.id, 'reconcile-upload', 1800);
    const sql = getSql();
    const [image] = await sql`SELECT source_path, size_bytes, content_type FROM tour_images WHERE id = ${imageId} AND tour_id = ${id}`;
    if (!image) throw new HttpError(404, 'Imagen no encontrada.');
    let blob;
    try { blob = await head(image.source_path as string); }
    catch (error) { if (error instanceof BlobNotFoundError) return json({ uploaded: false }); throw error; }
    if (blob.size !== Number(image.size_bytes) || blob.contentType !== image.content_type) {
      throw new HttpError(409, 'La imagen almacenada no coincide con la captura. Crea una captura nueva.');
    }
    await sql`UPDATE tour_images SET source_uploaded = true WHERE id = ${imageId} AND tour_id = ${id}`;
    return json({ uploaded: true });
  } catch (error) { return apiError(error); }
}
