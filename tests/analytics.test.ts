import { describe, expect, it } from 'vitest';
import { stripQuery } from '@/lib/analytics';

describe('analytics', () => {
  it('sends only origin and path, never tour ids or checkout state', () => {
    const event = stripQuery({ type: 'pageview' as const, url: 'https://astratour.vercel.app/?tour=3f0c9e1a-0000-4000-8000-000000000001&checkout=success#step-3' });
    expect(event).toEqual({ type: 'pageview', url: 'https://astratour.vercel.app/' });
  });
});
