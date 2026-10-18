import { after } from 'next/server';
import { apiError, HttpError, json, requireSameOrigin, requireUser, rateLimit } from '@/lib/http';
import { getImages, getOwnedTour, tourView } from '@/lib/tours';
import { triggerGpuWorker } from '@/lib/gpu-trigger';
import { marbleConfigured } from '@/lib/config';
import { claimMarbleTour, sendRoom } from '@/lib/marble';
import { enqueueReconstruction, minimumCaptureImages, reconstructionEnabled } from '@/lib/reconstruction';

export const runtime = 'nodejs';
export const maxDuration = 300; // marble: downloading each room's photos and submitting them runs after the response
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireSameOrigin(request);
    const user = await requireUser();
    const { id } = await params;
    const tour = await getOwnedTour(id, user.id);
    if (tour.status === 'pendiente_de_pago' || tour.status === 'pagado' || tour.status === 'procesando') return json(await tourView(tour));
    if (tour.engine === 'marble') {
      if (tour.status !== 'borrador') throw new HttpError(409, 'Esta captura ya se procesó. Crea una nueva propiedad para repetirla.');
      if (!marbleConfigured()) throw new HttpError(503, 'La generación por estancias todavía no está activada. Las fotos se conservan para continuar después.');
      await rateLimit(user.id, 'process-tour', 10);
      const rooms = await claimMarbleTour(id, user.id);
      after(() => Promise.all(rooms.map(sendRoom)));
      return json(await tourView(await getOwnedTour(id, user.id)), 202);
    }
    if (!reconstructionEnabled()) throw new HttpError(503, 'El motor 3D todavía no está activado. Las fotos se conservan para continuar después.');
    const images = await getImages(id);
    const minimum = minimumCaptureImages();
    if (images.length < minimum) throw new HttpError(400, `La reconstrucción necesita al menos ${minimum} fotografías solapadas de la misma escena.`);
    await rateLimit(user.id, 'process-tour', 10);
    await enqueueReconstruction(id, user.id);
    after(triggerGpuWorker); // After the response: no-op unless Runpod Serverless is configured; never throws.
    return json(await tourView(await getOwnedTour(id, user.id)), 202);
  } catch (error) { return apiError(error); }
}
