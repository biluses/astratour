import { apiError, json, requireUser } from '@/lib/http';
import { getOwnedTour, tourView } from '@/lib/tours';
import { pollMarbleTour } from '@/lib/marble';

export const runtime = 'nodejs';
export const maxDuration = 300; // marble: copying a room's assets (~50 MB) into Blob runs after the response
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    let tour = await getOwnedTour(id, user.id);
    // The client polls this route while processing: each poll advances marble rooms.
    if (tour.engine === 'marble' && tour.status === 'procesando') {
      await pollMarbleTour(id, user.id);
      tour = await getOwnedTour(id, user.id);
    }
    return json(await tourView(tour));
  } catch (error) { return apiError(error); }
}
