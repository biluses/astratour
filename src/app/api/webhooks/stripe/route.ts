import type Stripe from 'stripe';
import { getStripe } from '@/lib/stripe';
import { requiredEnv } from '@/lib/config';
import { fulfillCheckout } from '@/lib/fulfillment';
import { apiError, json } from '@/lib/http';

export const runtime = 'nodejs';
export async function POST(request: Request) {
  const signature = request.headers.get('stripe-signature');
  if (!signature) return json({ error: 'Missing signature' }, 400);
  let event: Stripe.Event;
  try {
    // Raw body is mandatory. Parsing/re-serializing JSON invalidates the signature.
    const body = await request.text();
    event = getStripe().webhooks.constructEvent(body, signature, requiredEnv('STRIPE_WEBHOOK_SECRET'));
  } catch { return json({ error: 'Invalid webhook signature or configuration' }, 400); }
  try {
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      await fulfillCheckout(event.id, event.data.object);
    }
    return json({ received: true });
  } catch (error) { return apiError(error); } // 500 asks Stripe to retry; do not swallow persistence failures.
}
