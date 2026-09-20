import { z } from 'zod';

export const PRICE_CENTS = 1900;
export const MAX_FILES = 500;
export const MIN_CAPTURE_FILES = 20;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
export const uuidSchema = z.uuid();
export const fileSchema = z.object({
  name: z.string().min(1).max(150),
  type: z.enum(['image/jpeg', 'image/png']),
  size: z.number().int().min(1).max(MAX_FILE_BYTES),
});
export const createTourSchema = z.object({
  title: z.string().trim().min(1).max(120).default('Mi propiedad'),
  files: z.array(fileSchema).min(1).max(MAX_FILES),
}).refine(v => v.files.reduce((n, f) => n + f.size, 0) <= MAX_TOTAL_BYTES,
  'Máximo 2 GB por propiedad.');
export const checkoutSchema = z.object({ tourId: uuidSchema });
export const uploadPayloadSchema = z.object({ tourId: uuidSchema, imageId: uuidSchema });

export type TourStatus = 'borrador' | 'procesando' | 'pendiente_de_pago' | 'pagado' | 'error';
export interface TourView {
  id: string;
  title: string;
  status: TourStatus;
  simulated: boolean;
  images: { id: string; name: string; url: string | null }[];
  modelUrl?: string | null;
  reconstruction?: { status: 'queued' | 'running' | 'completed' | 'failed'; progress: number; stage: string; errorCode: string | null } | null;
}
export interface TourRow {
  id: string; user_id: string; title: string; status: TourStatus; simulated: boolean;
  archive_path: string | null; checkout_key: string; stripe_session_id: string | null;
  amount_cents: number; currency: string;
  model_path?: string | null;
  viewer_settings?: CameraPose | null;
}
export interface ImageRow {
  id: string; tour_id: string; ordinal: number; source_path: string;
  original_name: string; content_type: string; size_bytes: number;
  preview_path: string | null; asset_path: string | null;
}

export const cameraPoseSchema = z.object({
  position: z.tuple([z.number().finite().min(-1e6).max(1e6), z.number().finite().min(-1e6).max(1e6), z.number().finite().min(-1e6).max(1e6)]),
  target: z.tuple([z.number().finite().min(-1e6).max(1e6), z.number().finite().min(-1e6).max(1e6), z.number().finite().min(-1e6).max(1e6)]),
  fov: z.number().finite().min(20).max(120),
}).refine(camera => camera.position.some((value, index) => Math.abs(value - camera.target[index]) > 0.000001), 'Camera target must differ from position');
export type CameraPose = z.infer<typeof cameraPoseSchema>;
