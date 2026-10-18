import { get } from '@vercel/blob';
import { getSql } from '@/lib/db';
import { uuidSchema } from '@/lib/contracts';
import { apiError, HttpError, rateLimit, requireUser } from '@/lib/http';
import { getOwnedTour } from '@/lib/tours';

const ASSETS: Record<string, { column: string; contentType: string; paid: boolean }> = {
  'splat-500k.spz': { column: 'splat_mobile_path', contentType: 'application/octet-stream', paid: true },
  'splat-full.spz': { column: 'splat_path', contentType: 'application/octet-stream', paid: true },
  'pano.png': { column: 'pano_path', contentType: 'image/png', paid: true },
  'thumb.webp': { column: 'thumb_path', contentType: 'image/webp', paid: false }, // the pre-payment preview
};

export const runtime = 'nodejs';
export const maxDuration = 300;
export async function GET(_request: Request, { params }: { params: Promise<{ id: string; roomId: string; asset: string }> }) {
  try {
    const user = await requireUser();
    const { id, roomId, asset } = await params;
    uuidSchema.parse(roomId);
    const spec = Object.hasOwn(ASSETS, asset) ? ASSETS[asset] : null;
    if (!spec) throw new HttpError(404, 'Archivo no disponible.');
    const tour = await getOwnedTour(id, user.id);
    if (spec.paid) {
      if (tour.status !== 'pagado') throw new HttpError(402, 'Completa el pago antes de abrir el modelo 3D.');
      // Separate, higher budget than model.sog: switching rooms downloads one splat each time.
      await rateLimit(user.id, 'room-asset', 300);
    }
    const sql = getSql();
    const [room] = await sql`SELECT splat_mobile_path, splat_path, pano_path, thumb_path FROM tour_rooms
      WHERE id = ${roomId} AND tour_id = ${id} AND status = 'completed'`;
    const pathname = room?.[spec.column] as string | null | undefined;
    if (!pathname) throw new HttpError(404, 'Archivo no disponible.');
    const blob = await get(pathname, { access: 'private' });
    if (!blob || blob.statusCode !== 200 || !blob.stream) throw new HttpError(404, 'Archivo no disponible.');
    return new Response(blob.stream, { headers: { 'Content-Type': spec.contentType,
      'Content-Disposition': `inline; filename="${asset}"`, 'Cache-Control': 'private, no-store',
      'Vary': 'Cookie', 'X-Content-Type-Options': 'nosniff' } });
  } catch (error) { return apiError(error); }
}
