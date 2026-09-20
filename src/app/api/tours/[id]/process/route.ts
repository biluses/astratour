import { apiError, HttpError, json, requireSameOrigin, requireUser, rateLimit } from '@/lib/http';
import { getImages, getOwnedTour, tourView } from '@/lib/tours';
import { enqueueReconstruction, minimumCaptureImages, reconstructionEnabled } from '@/lib/reconstruction';

export const runtime = 'nodejs';
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireSameOrigin(request);
    const user = await requireUser();
    const { id } = await params;
    const tour = await getOwnedTour(id, user.id);
    if (tour.status === 'pendiente_de_pago' || tour.status === 'pagado' || tour.status === 'procesando') return json(await tourView(tour));
    if (!reconstructionEnabled()) throw new HttpError(503, 'El motor 3D todavía no está activado. Las fotos se conservan para continuar después.');
    const images = await getImages(id);
    const minimum = minimumCaptureImages();
    if (images.length < minimum) throw new HttpError(400, `La reconstrucción necesita al menos ${minimum} fotografías solapadas de la misma escena.`);
    await rateLimit(user.id, 'process-tour', 10);
    await enqueueReconstruction(id, user.id);
    return json(await tourView(await getOwnedTour(id, user.id)), 202);
  } catch (error) { return apiError(error); }
}
