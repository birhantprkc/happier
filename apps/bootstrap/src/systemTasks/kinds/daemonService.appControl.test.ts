import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { runLocalHappierJsonCommandMock, resolveVersionedLocalHappierCliMock } = vi.hoisted(() => ({
  runLocalHappierJsonCommandMock: vi.fn(),
  resolveVersionedLocalHappierCliMock: vi.fn(),
}));

// The Happier CLI is a subprocess boundary; what the handlers ask it to do, and how they project
// its JSON, is the logic under test.
vi.mock('../happierCli.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../happierCli.js')>();
  return {
    ...actual,
    runLocalHappierJsonCommand: runLocalHappierJsonCommandMock,
    resolveVersionedLocalHappierCli: resolveVersionedLocalHappierCliMock,
  };
});

const RESOLVED_CLI = {
  command: '/home/user/.happier/cli/current/happier',
  provenance: 'managed' as const,
  version: '0.2.13',
};

import {
  createDaemonServiceAutostartSetHandler,
  createDaemonServiceStopHandler,
  createDaemonServiceStatusHandler,
} from './daemonService.js';

// Mirrors what `happier daemon status --json` prints for a stopped service: a daemon that never
// started reports no version and no service label, and the CLI omits those keys rather than
// sending nulls.
const STOPPED_STATUS_JSON = {
  server: {
    activeServerId: 'custom',
    serverUrl: 'https://relay.example.test',
    localServerUrl: null,
    publicServerUrl: 'https://relay.example.test',
    webappUrl: 'https://app.example.test',
    comparableKey: 'https://relay.example.test',
  },
  daemon: { running: false, pid: null, httpPort: null, serviceManaged: null, serviceLabel: null },
  service: { installed: true, running: false, targetMode: 'default-following', autostart: 'on-demand' },
  auth: {
    authenticated: true,
    machineRegistered: true,
    machineId: 'machine-b',
    needsAuth: false,
    accountId: 'acct_b',
    credentialState: 'valid',
    validatedAccountId: 'acct_b',
  },
};

const PARAMS = { target: { kind: 'local' }, channel: 'stable', surface: 'desktop.ui', mode: 'user' };

async function collectResult(
  handler: (params: unknown, context: Readonly<{ signal: AbortSignal }>) => AsyncGenerator<unknown, unknown, void>,
  params: unknown,
) {
  const iterator = handler(params, { signal: new AbortController().signal });
  const events: unknown[] = [];
  for (;;) {
    const next = await iterator.next();
    if (next.done) {
      return { events, result: next.value };
    }
    events.push(next.value);
  }
}

function commandArgs(callIndex: number): readonly string[] {
  return runLocalHappierJsonCommandMock.mock.calls[callIndex]?.[0]?.args ?? [];
}

describe('desktop control of the background service', () => {
  beforeEach(() => {
    resolveVersionedLocalHappierCliMock.mockResolvedValue(RESOLVED_CLI);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('stops the background service through the existing service command and returns the re-read state', async () => {
    runLocalHappierJsonCommandMock.mockResolvedValueOnce({ ok: true });
    runLocalHappierJsonCommandMock.mockResolvedValueOnce(STOPPED_STATUS_JSON);

    const { result } = await collectResult(createDaemonServiceStopHandler(), PARAMS);

    expect(commandArgs(0)).toEqual(['daemon', 'service', 'stop', '--json']);
    // The answer is a re-read, never the stop command's own success.
    expect(commandArgs(1)).toEqual(['daemon', 'status', '--json']);
    expect(result).toMatchObject({ daemonRunning: false, service: { running: false } });
  });

  it('refuses to report the service stopped while the daemon is still running', async () => {
    runLocalHappierJsonCommandMock.mockResolvedValueOnce({ ok: true });
    runLocalHappierJsonCommandMock.mockResolvedValueOnce({
      ...STOPPED_STATUS_JSON,
      daemon: { ...STOPPED_STATUS_JSON.daemon, running: true },
      service: { ...STOPPED_STATUS_JSON.service, running: true },
    });

    await expect(collectResult(createDaemonServiceStopHandler(), PARAMS)).rejects.toMatchObject({
      code: 'daemon_service_still_running',
    });
  });

  /**
   * The argv is the contract. `--autostart=<at-login|on-demand>` is the flag
   * `apps/cli/src/daemon/service/cli.ts` actually parses; a flag it does not parse would be
   * silently ignored and the toggle would report a change that never happened.
   */
  it('sets the autostart mode through the install command and proves it by re-reading', async () => {
    runLocalHappierJsonCommandMock.mockResolvedValueOnce({ ok: true });
    runLocalHappierJsonCommandMock.mockResolvedValueOnce(STOPPED_STATUS_JSON);

    const { result } = await collectResult(createDaemonServiceAutostartSetHandler(), { ...PARAMS, autostart: 'on-demand' });

    expect(commandArgs(0)).toEqual(['daemon', 'service', 'install', '--autostart=on-demand', '--json']);
    expect(result).toMatchObject({ service: { autostart: 'on-demand' } });
  });

  it('restores login start with the same command and the opposite mode', async () => {
    runLocalHappierJsonCommandMock.mockResolvedValueOnce({ ok: true });
    runLocalHappierJsonCommandMock.mockResolvedValueOnce({
      ...STOPPED_STATUS_JSON,
      service: { ...STOPPED_STATUS_JSON.service, autostart: 'at-login' },
    });

    const { result } = await collectResult(createDaemonServiceAutostartSetHandler(), { ...PARAMS, autostart: 'at-login' });

    expect(commandArgs(0)).toEqual(['daemon', 'service', 'install', '--autostart=at-login', '--json']);
    expect(result).toMatchObject({ service: { autostart: 'at-login' } });
  });

  it('fails by name when the CLI that answered does not report the autostart mode it was asked to set', async () => {
    runLocalHappierJsonCommandMock.mockResolvedValueOnce({ ok: true });
    runLocalHappierJsonCommandMock.mockResolvedValueOnce({
      ...STOPPED_STATUS_JSON,
      service: { installed: true, running: false, targetMode: 'default-following' },
    });

    await expect(
      collectResult(createDaemonServiceAutostartSetHandler(), { ...PARAMS, autostart: 'on-demand' }),
    ).rejects.toMatchObject({ code: 'daemon_service_autostart_unsupported' });
  });

  it('requires an explicit autostart mode rather than defaulting one', async () => {
    await expect(collectResult(createDaemonServiceAutostartSetHandler(), PARAMS)).rejects.toMatchObject({
      code: 'invalid_params',
    });
  });

  it('rejects a boolean autostart param rather than translating it', async () => {
    await expect(
      collectResult(createDaemonServiceAutostartSetHandler(), { ...PARAMS, autostart: true }),
    ).rejects.toMatchObject({ code: 'invalid_params' });
  });

  it('reports an unknown autostart mode as unknown rather than as on-demand', async () => {
    runLocalHappierJsonCommandMock.mockResolvedValueOnce({
      ...STOPPED_STATUS_JSON,
      service: { installed: true, running: false, targetMode: 'default-following' },
    });

    const { result } = await collectResult(createDaemonServiceStatusHandler(), PARAMS);

    expect(result).toMatchObject({ service: { autostart: null } });
  });
});
