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
    if (tour.status !== 'pagado' || !tour.archive_path) throw new HttpError(402, 'Completa el pago antes de descargar.');
    await rateLimit(user.id, 'download', 30);
    const blob = await get(tour.archive_path, { access: 'private' });
    if (!blob || blob.statusCode !== 200 || !blob.stream) throw new HttpError(404, 'El pack no está disponible.');
    // Stream the archive; never expose a public URL or buffer a large response in the route.
    return new Response(blob.stream, { headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="astratour-${id}.zip"`,
      'Cache-Control': 'private, no-store', 'Vary': 'Cookie', 'X-Content-Type-Options': 'nosniff',
    } });
  } catch (error) { return apiError(error); }
}
