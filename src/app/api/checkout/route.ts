import { getStripe } from '@/lib/stripe';
import { getSql } from '@/lib/db';
import { appOrigin, requiredEnv } from '@/lib/config';
import { checkoutSchema, PRICE_CENTS } from '@/lib/contracts';
import { apiError, HttpError, json, readJson, requireSameOrigin, requireUser, rateLimit } from '@/lib/http';
import { getOwnedTour } from '@/lib/tours';

export const runtime = 'nodejs';
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireUser();
    const { tourId } = checkoutSchema.parse(await readJson(request));
    await rateLimit(user.id, 'checkout', 30);
    requiredEnv('STRIPE_WEBHOOK_SECRET');
    const stripe = getStripe();
    const sql = getSql();
    let tour = await getOwnedTour(tourId, user.id);
    if (tour.status === 'pagado') throw new HttpError(409, 'Este tour ya está pagado. Actualiza para descargarlo.');
    if (tour.status !== 'pendiente_de_pago' || !tour.archive_path) throw new HttpError(409, 'Genera primero la previsualización.');
    if (tour.stripe_session_id) {
      const existing = await stripe.checkout.sessions.retrieve(tour.stripe_session_id);
      if (existing.status === 'open' && existing.url) return json({ url: existing.url });
      if (existing.status === 'complete') throw new HttpError(409, 'Estamos verificando el pago. Actualiza el estado en unos segundos.');
      await sql`UPDATE tours SET checkout_key = gen_random_uuid(), stripe_session_id = NULL
        WHERE id = ${tourId} AND user_id = ${user.id} AND stripe_session_id = ${existing.id}
          AND status = 'pendiente_de_pago'`;
      tour = await getOwnedTour(tourId, user.id);
      if (tour.status !== 'pendiente_de_pago') throw new HttpError(409, 'El estado ha cambiado. Actualiza la página.');
    }
    const origin = appOrigin();
    const session = await stripe.checkout.sessions.create({
      mode: 'payment', payment_method_types: ['card'], locale: 'es',
      client_reference_id: tourId,
      metadata: { tourId, userId: user.id, checkoutKey: tour.checkout_key },
      line_items: [{ quantity: 1, price_data: { currency: 'eur', unit_amount: PRICE_CENTS,
        product_data: { name: 'AstraTour Express · Pack completo',
          description: tour.simulated ? 'Prototipo: paquete de imágenes, sin modelo 3D.' : 'Tour Gaussian Splatting: modelo 3D y visor SuperSplat descargable. Pago de prueba.' } } }],
      success_url: `${origin}/?tour=${tourId}&checkout=success`,
      cancel_url: `${origin}/?tour=${tourId}&checkout=cancelled`,
    }, { idempotencyKey: `astratour:${tourId}:${tour.checkout_key}` });
    if (!session.url) throw new Error('Missing Stripe checkout URL');
    const persisted = await sql`UPDATE tours SET stripe_session_id = ${session.id}, updated_at = now()
      WHERE id = ${tourId} AND user_id = ${user.id} AND checkout_key = ${tour.checkout_key}
        AND (stripe_session_id IS NULL OR stripe_session_id = ${session.id}) RETURNING id`;
    if (!persisted.length) throw new HttpError(409, 'El checkout ha cambiado. Vuelve a intentarlo.');
    return json({ url: session.url });
  } catch (error) { return apiError(error); }
}
