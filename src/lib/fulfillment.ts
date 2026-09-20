import 'server-only';
import type Stripe from 'stripe';
import { getSql } from '@/lib/db';
import { paidCheckoutIdentity } from '@/lib/payment-contract';

export async function fulfillCheckout(eventId: string, session: Stripe.Checkout.Session) {
  const identity = paidCheckoutIdentity(session);
  if (!identity) return;
  const sql = getSql();
  const intent = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id ?? null;
  // Atomic transaction: an event is recorded only if the matching order can be fulfilled.
  // Concurrent or out-of-order delivery cannot clear a paid state or fulfill another user's order.
  const rows = await sql`
    WITH eligible AS (
      SELECT id FROM tours WHERE id = ${identity.tourId} AND user_id = ${identity.userId}
        AND checkout_key = ${identity.checkoutKey}
        AND (stripe_session_id IS NULL OR stripe_session_id = ${session.id})
        AND amount_cents = ${session.amount_total} AND currency = ${session.currency}
        AND status IN ('pendiente_de_pago','pagado') AND archive_path IS NOT NULL
      FOR UPDATE
    ), accepted AS (
      INSERT INTO stripe_events (event_id) SELECT ${eventId} FROM eligible
      ON CONFLICT DO NOTHING RETURNING event_id
    )
    UPDATE tours SET status = 'pagado', paid_at = COALESCE(paid_at, now()),
      stripe_session_id = ${session.id}, payment_intent_id = ${intent}, updated_at = now()
    WHERE id IN (SELECT id FROM eligible) AND EXISTS (SELECT 1 FROM accepted)
    RETURNING id`;
  if (!rows.length) {
    const existing = await sql`SELECT event_id FROM stripe_events WHERE event_id = ${eventId}`;
    if (!existing.length) throw new Error('Payment could not be matched to its order');
  }
}
