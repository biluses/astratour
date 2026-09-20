import { z } from 'zod';
import type Stripe from 'stripe';
import { PRICE_CENTS, uuidSchema } from '@/lib/contracts';

const paymentMetadata = z.object({ tourId: uuidSchema, userId: uuidSchema, checkoutKey: uuidSchema });
export function paidCheckoutIdentity(session: Stripe.Checkout.Session) {
  if (session.payment_status !== 'paid') return null;
  if (session.mode !== 'payment' || session.amount_total !== PRICE_CENTS || session.currency !== 'eur' || session.livemode) {
    throw new Error('Payment contract mismatch');
  }
  const metadata = paymentMetadata.parse(session.metadata);
  if (session.client_reference_id !== metadata.tourId) throw new Error('Payment reference mismatch');
  return metadata;
}
