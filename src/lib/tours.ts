import 'server-only';
import { getSql } from '@/lib/db';
import { HttpError } from '@/lib/http';
import { uuidSchema, type TourRow, type TourView, type ImageRow } from '@/lib/contracts';

export async function getOwnedTour(id: string, userId: string): Promise<TourRow> {
  uuidSchema.parse(id);
  const sql = getSql();
  const [row] = await sql`SELECT * FROM tours WHERE id = ${id} AND user_id = ${userId}`;
  if (!row) throw new HttpError(404, 'No se ha encontrado esta propiedad.');
  return row as TourRow;
}
export async function getImages(tourId: string): Promise<ImageRow[]> {
  const sql = getSql();
  return await sql`SELECT * FROM tour_images WHERE tour_id = ${tourId} ORDER BY ordinal` as ImageRow[];
}
export async function tourView(tour: TourRow): Promise<TourView> {
  const images = await getImages(tour.id);
  const sql = getSql();
  const [job] = await sql`SELECT status, progress, stage, error_code FROM reconstruction_jobs WHERE tour_id = ${tour.id}`;
  return {
    modelUrl: tour.status === 'pagado' && !tour.simulated && tour.model_path ? `/api/tours/${tour.id}/model.sog` : null,
    reconstruction: job ? { status: job.status as 'queued' | 'running' | 'completed' | 'failed', progress: Number(job.progress),
      stage: job.stage as string, errorCode: job.error_code as string | null } : null,
    id: tour.id, title: tour.title, status: tour.status, simulated: tour.simulated,
    images: images.map(image => ({
      id: image.id, name: image.original_name,
      // Pathnames/URLs of private assets never leave the server here.
      url: image.preview_path ? `/api/tours/${tour.id}/images/${image.id}?v=${tour.status}` : null,
    })),
  };
}
