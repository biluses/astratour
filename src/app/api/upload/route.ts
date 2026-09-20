import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { MAX_FILE_BYTES, uploadPayloadSchema } from '@/lib/contracts';
import { getSql } from '@/lib/db';
import { reconstructionConfigured } from '@/lib/config';
import { apiError, HttpError, json, readJson, requireSameOrigin, requireUser, rateLimit } from '@/lib/http';

export const runtime = 'nodejs';
export async function POST(request: Request) {
  try {
    const body = await readJson(request) as HandleUploadBody;
    const result = await handleUpload({
      body, request,
      onBeforeGenerateToken: async (pathname, payload) => {
        requireSameOrigin(request);
        const user = await requireUser();
        if (!reconstructionConfigured()) throw new HttpError(503, 'La captura está deshabilitada hasta validar el motor 3D.');
        const { tourId, imageId } = uploadPayloadSchema.parse(JSON.parse(payload || '{}'));
        await rateLimit(user.id, 'upload-token', 1800);
        const sql = getSql();
        const [image] = await sql`
          SELECT i.* FROM tour_images i JOIN tours t ON t.id = i.tour_id
          WHERE i.id = ${imageId} AND t.id = ${tourId} AND t.user_id = ${user.id}
            AND t.status = 'borrador' AND i.source_path = ${pathname}`;
        if (!image) throw new HttpError(403, 'Esta carga no está autorizada.');
        return {
          allowedContentTypes: [image.content_type as string],
          maximumSizeInBytes: Math.min(Number(image.size_bytes), MAX_FILE_BYTES),
          validUntil: Date.now() + 10 * 60 * 1000,
          addRandomSuffix: false, allowOverwrite: false,
          tokenPayload: JSON.stringify({ tourId, imageId, pathname }),
        };
      },
      // Auth belongs above, not here. Blob callbacks have an SDK-verified signature, no browser session.
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        const payload = JSON.parse(tokenPayload || '{}') as { imageId: string; tourId: string; pathname: string };
        if (blob.pathname !== payload.pathname) throw new Error('Upload path mismatch');
        const sql = getSql();
        await sql`UPDATE tour_images SET source_uploaded = true
          WHERE id = ${payload.imageId} AND tour_id = ${payload.tourId} AND source_path = ${blob.pathname}`;
      },
    });
    return json(result);
  } catch (error) { return apiError(error); }
}
