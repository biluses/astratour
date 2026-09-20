import 'server-only';
import { ZodError } from 'zod';
import { auth } from '@/auth';
import { authConfigured, appOrigin } from '@/lib/config';
import { getSql } from '@/lib/db';

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export async function requireUser() {
  if (!authConfigured()) throw new HttpError(503, 'El acceso con Google todavía no está configurado.');
  const session = await auth();
  if (!session?.user?.id) throw new HttpError(401, 'Inicia sesión con Google para continuar.');
  return session.user;
}
export function requireSameOrigin(request: Request) {
  if (request.headers.get('origin') !== appOrigin()) throw new HttpError(403, 'Origen no permitido.');
}
export async function readJson(request: Request, maxBytes = 32_768): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'Solicitud vacía.');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) { await reader.cancel(); throw new HttpError(413, 'Solicitud demasiado grande.'); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'JSON no válido.');
  } finally { reader.releaseLock(); }
}
export async function rateLimit(userId: string, action: string, limit: number, seconds = 3600) {
  const sql = getSql();
  const [row] = await sql`
    INSERT INTO api_rate_limits (key, expires_at)
    VALUES (${`${action}:${userId}`}, now() + ${seconds} * interval '1 second')
    ON CONFLICT (key) DO UPDATE SET
      hits = CASE WHEN api_rate_limits.expires_at <= now() THEN 1 ELSE api_rate_limits.hits + 1 END,
      expires_at = CASE WHEN api_rate_limits.expires_at <= now()
        THEN now() + ${seconds} * interval '1 second' ELSE api_rate_limits.expires_at END
    RETURNING hits`;
  if (Number(row.hits) > limit) throw new HttpError(429, 'Has alcanzado el límite temporal. Inténtalo más tarde.');
}
export function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'private, no-store', 'Vary': 'Cookie' } });
}
export function apiError(error: unknown) {
  if (error instanceof HttpError) return json({ error: error.message }, error.status);
  if (error instanceof ZodError) return json({ error: 'Revisa el formato, tamaño y número de las imágenes.' }, 400);
  // Avoid logging uploaded names, SQL parameters, tokens or OAuth/Stripe payloads.
  console.error('API request failed', error instanceof Error ? error.name : 'UnknownError');
  return json({ error: 'No se ha podido completar la operación. Vuelve a intentarlo.' }, 500);
}
