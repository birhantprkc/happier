export async function waitForOpenCodeServerHealth(params: {
  baseUrl: string;
  timeoutMs: number;
  pollIntervalMs: number;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  apiGeneration?: 'auto' | 'v2';
}): Promise<void> {
  const deadline = Date.now() + params.timeoutMs;
  while (Date.now() < deadline) {
    if (params.signal?.aborted) throw new Error('Aborted while waiting for OpenCode server health');
    try {
      const request = async (path: string): Promise<Response | null> => {
        const ctrl = new AbortController();
        const onAbort = () => ctrl.abort();
        params.signal?.addEventListener('abort', onAbort, { once: true });
        const requestTimeoutMs = Math.min(
          1_500,
          params.pollIntervalMs * 5,
          Math.max(1, deadline - Date.now()),
        );
        const timer = setTimeout(() => ctrl.abort(), requestTimeoutMs);
        timer.unref?.();
        try {
          return await fetch(`${params.baseUrl}${path}`, {
            signal: ctrl.signal,
            ...(params.headers && Object.keys(params.headers).length > 0 ? { headers: params.headers } : {}),
          }).catch(() => null);
        } finally {
          clearTimeout(timer);
          params.signal?.removeEventListener('abort', onAbort);
        }
      };
      const isHealthy = async (response: Response | null): Promise<boolean> => {
        if (!response?.ok) return false;
        const body = await response.json().catch(() => null) as unknown;
        return Boolean(body && typeof body === 'object' && !Array.isArray(body) && (body as { healthy?: unknown }).healthy === true);
      };
      const paths = params.apiGeneration === 'v2'
          ? ['/api/health']
          : ['/api/health', '/global/health'];
      let healthy = false;
      for (const path of paths) {
        if (await isHealthy(await request(path))) {
          healthy = true;
          break;
        }
      }
      if (healthy) return;
    } catch {
      // ignore and retry until deadline
    }
    await new Promise((r) => setTimeout(r, params.pollIntervalMs));
  }
  throw new Error(`Timed out waiting for OpenCode server health after ${params.timeoutMs}ms`);
}
