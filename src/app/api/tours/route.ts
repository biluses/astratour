import { randomUUID } from 'node:crypto';
import { createMarbleTourSchema, createTourSchema } from '@/lib/contracts';
import { getSql } from '@/lib/db';
import { apiError, HttpError, json, readJson, requireSameOrigin, requireUser, rateLimit } from '@/lib/http';
import { marbleConfigured, marbleMaxRooms, reconstructionConfigured } from '@/lib/config';

export const runtime = 'nodejs';
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireUser();
    const body = await readJson(request, 256 * 1024);
    if ((body as { engine?: unknown } | null)?.engine === 'marble') return await createMarbleTour(user.id, body);
    if (!reconstructionConfigured()) throw new HttpError(503, 'La captura está deshabilitada hasta validar el motor 3D.');
    const { files, title } = createTourSchema.parse(body);
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

// Uploads are returned flattened in room order, then photo order: the client uploads in that same order.
async function createMarbleTour(userId: string, body: unknown) {
  if (!marbleConfigured()) throw new HttpError(503, 'La captura por estancias todavía no está activada.');
  const { title, rooms } = createMarbleTourSchema.parse(body);
  const maxRooms = marbleMaxRooms();
  if (rooms.length > maxRooms) throw new HttpError(400, `Máximo ${maxRooms} estancias por propiedad.`);
  await rateLimit(userId, 'create-tour', 10);
  const tourId = randomUUID();
  const roomRows = rooms.map((room, ordinal) => ({ id: randomUUID(), ordinal, name: room.name }));
  const uploads = rooms.flatMap((room, r) => room.files.map(f => {
    const id = randomUUID();
    return { id, room_id: roomRows[r].id, azimuth: f.azimuth, original_name: f.name, content_type: f.type,
      size_bytes: f.size, source_path: `sources/${userId}/${tourId}/${id}.jpg` };
  })).map((upload, ordinal) => ({ ...upload, ordinal }));
  const sql = getSql();
  await sql`
    WITH new_tour AS (
      INSERT INTO tours (id, user_id, title, engine) VALUES (${tourId}, ${userId}, ${title}, 'marble') RETURNING id
    ), new_rooms AS (
      INSERT INTO tour_rooms (id, tour_id, ordinal, name)
      SELECT x.id, new_tour.id, x.ordinal, x.name FROM new_tour, jsonb_to_recordset(${JSON.stringify(roomRows)}::jsonb)
        AS x(id uuid, ordinal integer, name text)
      RETURNING id
    )
    INSERT INTO tour_images (id, tour_id, ordinal, original_name, content_type, size_bytes, source_path, room_id, azimuth)
    SELECT x.id, new_tour.id, x.ordinal, x.original_name, x.content_type, x.size_bytes, x.source_path, x.room_id, x.azimuth
    FROM new_tour, jsonb_to_recordset(${JSON.stringify(uploads)}::jsonb)
      AS x(id uuid, ordinal integer, original_name text, content_type text, size_bytes integer, source_path text, room_id uuid, azimuth real)
    WHERE (SELECT count(*) FROM new_rooms) = ${roomRows.length}`;
  return json({ tourId, uploads: uploads.map(f => ({ imageId: f.id, pathname: f.source_path })) }, 201);
}
