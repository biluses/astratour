import { get } from '@vercel/blob';
import { getSql } from '@/lib/db';
import { uuidSchema } from '@/lib/contracts';
import { apiError, HttpError, requireUser } from '@/lib/http';
import { getOwnedTour } from '@/lib/tours';

export const runtime = 'nodejs';
export async function GET(_request: Request, { params }: { params: Promise<{ id: string; imageId: string }> }) {
  try {
    const user = await requireUser();
    const { id, imageId } = await params;
    uuidSchema.parse(imageId);
    const tour = await getOwnedTour(id, user.id);
    const sql = getSql();
    const [image] = await sql`SELECT preview_path, asset_path FROM tour_images WHERE id = ${imageId} AND tour_id = ${id}`;
    const pathname = tour.status === 'pagado' ? (image?.asset_path ?? image?.preview_path) : image?.preview_path;
    if (!pathname) throw new HttpError(404, 'Imagen no disponible.');
    const result = await get(pathname as string, { access: 'private' });
    if (!result || result.statusCode !== 200 || !result.stream) throw new HttpError(404, 'Imagen no disponible.');
    return new Response(result.stream, { headers: {
      'Content-Type': 'image/jpeg', 'Cache-Control': 'private, no-store', 'Vary': 'Cookie',
      'Content-Disposition': 'inline', 'X-Content-Type-Options': 'nosniff',
    } });
  } catch (error) { return apiError(error); }
}
