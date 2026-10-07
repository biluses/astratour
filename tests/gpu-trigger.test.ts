import { afterEach, describe, expect, it, vi } from 'vitest';
import { GPU_EXECUTION_TIMEOUT_MS, triggerGpuWorker } from '@/lib/gpu-trigger';

const KEY = 'rpa_test_key_never_logged';

describe('triggerGpuWorker', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('does nothing unless both endpoint and API key are set', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('RUNPOD_ENDPOINT_ID', 'abc123');
    vi.stubEnv('RUNPOD_API_KEY', '');
    await triggerGpuWorker('t1');
    vi.stubEnv('RUNPOD_ENDPOINT_ID', '');
    vi.stubEnv('RUNPOD_API_KEY', KEY);
    await triggerGpuWorker('t1');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts an async /run job with the execution timeout policy', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"id":"x"}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('RUNPOD_ENDPOINT_ID', 'abc123');
    vi.stubEnv('RUNPOD_API_KEY', KEY);
    await triggerGpuWorker('t1');
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.runpod.ai/v2/abc123/run');
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(init.body)).toEqual({ input: { tourId: 't1' }, policy: { executionTimeout: GPU_EXECUTION_TIMEOUT_MS } });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ['network error', () => Promise.reject(new TypeError(`fetch failed ${KEY}`))],
    ['non-2xx response', () => Promise.resolve(new Response(`bad ${KEY}`, { status: 401 }))],
  ])('swallows a %s and never logs the key', async (_label, impl) => {
    vi.stubGlobal('fetch', vi.fn(impl));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('RUNPOD_ENDPOINT_ID', 'abc123');
    vi.stubEnv('RUNPOD_API_KEY', KEY);
    await expect(triggerGpuWorker()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.stringify(log.mock.calls)).not.toContain(KEY);
  });
});
