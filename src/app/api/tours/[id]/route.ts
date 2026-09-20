import { apiError, json, requireUser } from '@/lib/http';
import { getOwnedTour, tourView } from '@/lib/tours';

export const runtime = 'nodejs';
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    return json(await tourView(await getOwnedTour(id, user.id)));
  } catch (error) { return apiError(error); }
}
