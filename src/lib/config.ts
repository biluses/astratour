import 'server-only';
import { MAX_FILES, MIN_CAPTURE_FILES } from '@/lib/contracts';

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing configuration: ${name}`);
  return value;
}

export function appOrigin(): string {
  const url = new URL(requiredEnv('APP_URL'));
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error('APP_URL must contain only the canonical origin.');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
    throw new Error('APP_URL requires HTTPS outside localhost.');
  }
  return url.origin;
}

export function authConfigured(): boolean {
  return Boolean(process.env.AUTH_SECRET && process.env.AUTH_GOOGLE_ID &&
    process.env.AUTH_GOOGLE_SECRET && (process.env.DATABASE_URL || process.env.POSTGRES_URL));
}

export function checkoutConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_') && process.env.STRIPE_WEBHOOK_SECRET);
}

/** Deployment gate: do not accept paid GPU work until a worker is commissioned. */
export function reconstructionConfigured(): boolean {
  return process.env.RECONSTRUCTION_ENABLED === 'true' && Boolean(process.env.RECONSTRUCTION_WORKER_SECRET);
}
export function minReconstructionImages(): number {
  const value = Number(process.env.RECONSTRUCTION_MIN_IMAGES ?? MIN_CAPTURE_FILES);
  if (!Number.isInteger(value) || value < 3 || value > MAX_FILES) throw new Error('Invalid RECONSTRUCTION_MIN_IMAGES');
  return value;
}
