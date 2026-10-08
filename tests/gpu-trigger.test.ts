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
    await triggerGpuWorker();
    vi.stubEnv('RUNPOD_ENDPOINT_ID', '');
    vi.stubEnv('RUNPOD_API_KEY', KEY);
    await triggerGpuWorker();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts an async /run job with the execution timeout policy', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"id":"x"}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('RUNPOD_ENDPOINT_ID', 'abc123');
    vi.stubEnv('RUNPOD_API_KEY', KEY);
    await triggerGpuWorker();
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.runpod.ai/v2/abc123/run');
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(init.body)).toEqual({ input: { wake: true }, policy: { executionTimeout: GPU_EXECUTION_TIMEOUT_MS } });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ['network error', () => Promise.reject(new TypeError(`fetch failed ${KEY}`)), 2],
    ['5xx response', () => Promise.resolve(new Response(`bad ${KEY}`, { status: 503 })), 2],
    ['401 response', () => Promise.resolve(new Response(`bad ${KEY}`, { status: 401 })), 1],
  ])('swallows a %s, retries only transient failures and never logs the key', async (_label, impl, calls) => {
    const fetchMock = vi.fn(impl);
    vi.stubGlobal('fetch', fetchMock);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('RUNPOD_ENDPOINT_ID', 'abc123');
    vi.stubEnv('RUNPOD_API_KEY', KEY);
    await expect(triggerGpuWorker()).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(calls);
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.stringify(log.mock.calls)).not.toContain(KEY);
  });

  it('stops after a successful retry without logging', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('RUNPOD_ENDPOINT_ID', 'abc123');
    vi.stubEnv('RUNPOD_API_KEY', KEY);
    await triggerGpuWorker();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(log).not.toHaveBeenCalled();
  });
});
