import { get } from '@vercel/blob';
import { apiError, HttpError, requireUser, rateLimit } from '@/lib/http';
import { getOwnedTour } from '@/lib/tours';

export const runtime = 'nodejs';
export const maxDuration = 300;
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const tour = await getOwnedTour(id, user.id);
    if (tour.status !== 'pagado') throw new HttpError(402, 'Completa el pago antes de abrir el modelo 3D.');
    if (tour.simulated || !tour.model_path) throw new HttpError(404, 'Esta propiedad no tiene un modelo 3D.');
    await rateLimit(user.id, 'model', 60);
    const blob = await get(tour.model_path, { access: 'private' });
    if (!blob || blob.statusCode !== 200 || !blob.stream) throw new HttpError(404, 'Modelo no disponible.');
    return new Response(blob.stream, { headers: { 'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'inline; filename="scene.sog"', 'Cache-Control': 'private, no-store',
      'Vary': 'Cookie', 'X-Content-Type-Options': 'nosniff' } });
  } catch (error) { return apiError(error); }
}
