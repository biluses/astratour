import { afterEach, describe, expect, it, vi } from 'vitest';
import { minReconstructionImages } from '@/lib/config';
import { MIN_CAPTURE_FILES } from '@/lib/contracts';

describe('minReconstructionImages', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('lifts a stale env value below the evidence-backed floor', () => {
    vi.stubEnv('RECONSTRUCTION_MIN_IMAGES', '20');
    expect(minReconstructionImages()).toBe(MIN_CAPTURE_FILES);
  });

  it('lets the env raise the minimum', () => {
    vi.stubEnv('RECONSTRUCTION_MIN_IMAGES', '60');
    expect(minReconstructionImages()).toBe(60);
  });
});
