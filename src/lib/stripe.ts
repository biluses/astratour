import 'server-only';
import Stripe from 'stripe';
import { requiredEnv } from '@/lib/config';
import { HttpError } from '@/lib/http';

let client: Stripe | undefined;
export function getStripe() {
  const key = requiredEnv('STRIPE_SECRET_KEY');
  if (!key.startsWith('sk_test_')) {
    throw new HttpError(503, 'Los cobros reales están deshabilitados. Utiliza Stripe en modo de prueba.');
  }
  // The exact SDK/API contract is pinned in package-lock.json. No speculative API version string.
  return client ??= new Stripe(key, { maxNetworkRetries: 2, timeout: 20_000 });
}
