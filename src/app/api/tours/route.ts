import { randomUUID } from 'node:crypto';
import { createTourSchema } from '@/lib/contracts';
import { getSql } from '@/lib/db';
import { apiError, HttpError, json, readJson, requireSameOrigin, requireUser, rateLimit } from '@/lib/http';
import { reconstructionConfigured } from '@/lib/config';

export const runtime = 'nodejs';
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireUser();
    if (!reconstructionConfigured()) throw new HttpError(503, 'La captura está deshabilitada hasta validar el motor 3D.');
    const { files, title } = createTourSchema.parse(await readJson(request, 256 * 1024));
    await rateLimit(user.id, 'create-tour', 10);
    const tourId = randomUUID();
    const uploads = files.map((f, ordinal) => {
      const id = randomUUID();
      return { id, ordinal, original_name: f.name, content_type: f.type, size_bytes: f.size,
        source_path: `sources/${user.id}/${tourId}/${id}.${f.type === 'image/png' ? 'png' : 'jpg'}` };
    });
    const sql = getSql();
    await sql`
      WITH new_tour AS (
        INSERT INTO tours (id, user_id, title) VALUES (${tourId}, ${user.id}, ${title}) RETURNING id
      )
      INSERT INTO tour_images (id, tour_id, ordinal, original_name, content_type, size_bytes, source_path)
      SELECT x.id, new_tour.id, x.ordinal, x.original_name, x.content_type, x.size_bytes, x.source_path
      FROM new_tour, jsonb_to_recordset(${JSON.stringify(uploads)}::jsonb)
        AS x(id uuid, ordinal integer, original_name text, content_type text, size_bytes integer, source_path text)`;
    return json({ tourId, uploads: uploads.map(f => ({ imageId: f.id, pathname: f.source_path })) }, 201);
  } catch (error) { return apiError(error); }
}
