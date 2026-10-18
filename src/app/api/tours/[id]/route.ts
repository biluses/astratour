import { after } from 'next/server';
import { apiError, json, requireUser } from '@/lib/http';
import { getOwnedTour, tourView } from '@/lib/tours';
import { advanceMarbleTour, finalizeRoom, sendRoom } from '@/lib/marble';

export const runtime = 'nodejs';
export const maxDuration = 300; // marble: copying a room's assets (~50 MB) into Blob runs after the response
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    let tour = await getOwnedTour(id, user.id);
    // The client polls this route while processing: each poll advances marble rooms.
    if (tour.engine === 'marble' && tour.status === 'procesando') {
      const { finalize, resubmit } = await advanceMarbleTour(id);
      if (finalize.length || resubmit.length) {
        after(() => Promise.all([
          ...finalize.map(room => finalizeRoom(id, user.id, room.roomId, room.assets)),
          ...resubmit.map(sendRoom),
        ]));
      }
      tour = await getOwnedTour(id, user.id);
    }
    return json(await tourView(tour));
  } catch (error) { return apiError(error); }
}
