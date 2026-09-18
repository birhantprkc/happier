export type DaemonControlLivenessProbeResult =
  | 'running'
  | 'pid_not_running'
  | 'unauthorized'
  | 'unreachable';

async function pingAuthenticatedControl(input: Readonly<{
  httpPort: number;
  controlToken: string;
  timeoutMs: number;
}>): Promise<Exclude<DaemonControlLivenessProbeResult, 'pid_not_running'>> {
  try {
    const response = await fetch(`http://127.0.0.1:${input.httpPort}/ping`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-happier-daemon-token': input.controlToken,
      },
      body: '{}',
      signal: AbortSignal.timeout(input.timeoutMs),
    });
    if (response.status === 401 || response.status === 403) return 'unauthorized';
    if (!response.ok) return 'unreachable';
    const payload = await response.json() as unknown;
    return payload && typeof payload === 'object' && !Array.isArray(payload)
      && (payload as Readonly<{ status?: unknown }>).status === 'ok'
      ? 'running'
      : 'unreachable';
  } catch {
    return 'unreachable';
  }
}

/**
 * Proves that persisted daemon coordinates still name a live Happier daemon.
 * The authenticated ping defeats PID/port reuse; neither PID liveness nor a
 * stale state-file generation is execution authority by itself.
 *
 * A PID the caller cannot see (ESRCH) is not proof of absence either: containers
 * and host boundaries hide the daemon's pid namespace while its control endpoint
 * stays reachable. Only an authenticated `ok` answer resurrects such a PID.
 */
export async function probeDaemonAuthenticatedControl(input: Readonly<{
  pid: number;
  httpPort: number;
  controlToken: string;
  timeoutMs: number;
}>): Promise<DaemonControlLivenessProbeResult> {
  try {
    process.kill(input.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ESRCH') {
      return 'unreachable';
    }
    const hiddenPidProbe = await pingAuthenticatedControl(input);
    return hiddenPidProbe === 'running' ? 'running' : 'pid_not_running';
  }

  return await pingAuthenticatedControl(input);
}
