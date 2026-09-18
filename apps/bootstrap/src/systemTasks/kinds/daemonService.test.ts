import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { runLocalHappierJsonCommandMock, resolveVersionedLocalHappierCliMock } = vi.hoisted(() => ({
  runLocalHappierJsonCommandMock: vi.fn(),
  resolveVersionedLocalHappierCliMock: vi.fn(),
}));

// The Happier CLI is a subprocess boundary; the handler's projection of its JSON is the logic under test.
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

import { createDaemonServiceStartHandler, createDaemonServiceStatusHandler } from './daemonService.js';

const AMBIENT_STATUS_JSON = {
  server: {
    activeServerId: 'custom',
    serverUrl: 'https://relay.example.test',
    localServerUrl: null,
    publicServerUrl: 'https://relay.example.test',
    webappUrl: 'https://relay.example.test',
    comparableKey: 'https://relay.example.test',
  },
  daemon: {
    running: true,
    pid: 4321,
    httpPort: 7777,
    startedWithCliVersion: '0.2.11',
    serviceManaged: true,
    serviceLabel: 'com.happier.cli.daemon.default',
  },
  service: { installed: true, running: true, targetMode: 'default-following' },
  auth: {
    authenticated: true,
    machineRegistered: true,
    machineId: 'machine-b',
    needsAuth: false,
    accountId: 'acct_b',
    credentialState: 'valid',
    validatedAccountId: 'acct_b',
  },
  runtimeConvergence: {
    controlReachable: true,
    serviceOwnsRunningDaemon: true,
    machineIdMatches: false,
    cliVersionMatches: true,
  },
};

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

describe('daemonService system task handlers', () => {
  beforeEach(() => {
    resolveVersionedLocalHappierCliMock.mockResolvedValue(RESOLVED_CLI);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('reports acquisition explicitly and carries every ambient daemon fact the CLI emitted', async () => {
    runLocalHappierJsonCommandMock.mockResolvedValueOnce(AMBIENT_STATUS_JSON);
    const handler = createDaemonServiceStatusHandler();

    const { result } = await collectResult(handler, {
      target: { kind: 'local' },
      surface: 'desktop.ui',
      mode: 'user',
      channel: 'preview',
    });

    expect(runLocalHappierJsonCommandMock).toHaveBeenCalledTimes(1);
    expect(runLocalHappierJsonCommandMock.mock.calls[0]?.[0]).toMatchObject({
      args: ['daemon', 'status', '--json'],
      releaseRing: 'preview',
      cli: RESOLVED_CLI,
    });
    expect(result).toEqual({
      serviceInstalled: true,
      daemonRunning: true,
      needsAuth: false,
      machineId: 'machine-b',
      // Which CLI answered, where it came from, and the version it reports for itself.
      acquisition: { command: '/home/user/.happier/cli/current/happier', provenance: 'managed', version: '0.2.13' },
      server: {
        activeServerId: 'custom',
        serverUrl: 'https://relay.example.test',
        publicServerUrl: 'https://relay.example.test',
        localServerUrl: null,
        comparableKey: 'https://relay.example.test',
      },
      auth: {
        authenticated: true,
        machineRegistered: true,
        machineId: 'machine-b',
        needsAuth: false,
        accountId: 'acct_b',
        credentialState: 'valid',
        validatedAccountId: 'acct_b',
      },
      service: { installed: true, running: true, targetMode: 'default-following', autostart: null },
      daemon: {
        running: true,
        startedWithCliVersion: '0.2.11',
        serviceManaged: true,
        serviceLabel: 'com.happier.cli.daemon.default',
      },
      runtimeConvergence: {
        controlReachable: true,
        serviceOwnsRunningDaemon: true,
        machineIdMatches: false,
        cliVersionMatches: true,
      },
    });
  });

  it('reports runtimeConvergence as unknown when an older CLI does not emit it', async () => {
    const { runtimeConvergence: _omitted, ...legacyStatus } = AMBIENT_STATUS_JSON;
    runLocalHappierJsonCommandMock.mockResolvedValueOnce({
      ...legacyStatus,
      auth: { ...legacyStatus.auth, credentialState: undefined, validatedAccountId: undefined },
    });
    const handler = createDaemonServiceStatusHandler();

    const { result } = await collectResult(handler, {
      target: { kind: 'local' },
      surface: 'desktop.ui',
      mode: 'user',
    });

    expect(result).toMatchObject({
      auth: { credentialState: null, validatedAccountId: null },
      runtimeConvergence: null,
    });
  });

  it('fails by field name on a status response with a missing or wrongly typed value', async () => {
    for (const malformed of [
      { path: 'service.installed', value: { ...AMBIENT_STATUS_JSON, service: { running: true } } },
      { path: 'daemon.running', value: { ...AMBIENT_STATUS_JSON, daemon: { ...AMBIENT_STATUS_JSON.daemon, running: 'yes' } } },
      { path: 'auth.needsAuth', value: { ...AMBIENT_STATUS_JSON, auth: { ...AMBIENT_STATUS_JSON.auth, needsAuth: null } } },
      // A string field the hand-written reader used to coerce to "absent": an empty machine id
      // would read as "this computer has no machine" and start a pairing.
      { path: 'auth.machineId', value: { ...AMBIENT_STATUS_JSON, auth: { ...AMBIENT_STATUS_JSON.auth, machineId: '' } } },
    ]) {
      runLocalHappierJsonCommandMock.mockResolvedValueOnce(malformed.value);
      const handler = createDaemonServiceStatusHandler();

      // Coercing these to `false`/absent would report "no service, no daemon, not authenticated" —
      // the facts that make the app start an installing, re-pairing setup run.
      await expect(collectResult(handler, {
        target: { kind: 'local' },
        surface: 'desktop.ui',
        mode: 'user',
      })).rejects.toMatchObject({
        code: 'invalid_cli_response',
        message: expect.stringContaining(`"${malformed.path}"`),
      });
    }
  });

  /**
   * The service's target mode decides whether the app may move that service on its own. An
   * absent field (an older CLI) and an unreadable one are both "unknown"; a value outside the
   * CLI's vocabulary is corrupt output and must not be coerced into either mode.
   */
  it('projects the service target mode and refuses to guess one', async () => {
    for (const declared of ['default-following', 'pinned'] as const) {
      runLocalHappierJsonCommandMock.mockResolvedValueOnce({
        ...AMBIENT_STATUS_JSON,
        service: { ...AMBIENT_STATUS_JSON.service, targetMode: declared },
      });
      const { result } = await collectResult(createDaemonServiceStatusHandler(), {
        target: { kind: 'local' },
        surface: 'desktop.ui',
        mode: 'user',
      });
      expect(result).toMatchObject({ service: { installed: true, running: true, targetMode: declared } });
    }

    for (const unknownValue of [undefined, null]) {
      runLocalHappierJsonCommandMock.mockResolvedValueOnce({
        ...AMBIENT_STATUS_JSON,
        service: { ...AMBIENT_STATUS_JSON.service, targetMode: unknownValue },
      });
      const { result } = await collectResult(createDaemonServiceStatusHandler(), {
        target: { kind: 'local' },
        surface: 'desktop.ui',
        mode: 'user',
      });
      expect(result).toMatchObject({ service: { targetMode: null } });
    }

    for (const malformed of ['default', 'DEFAULT-FOLLOWING', true, 3]) {
      runLocalHappierJsonCommandMock.mockResolvedValueOnce({
        ...AMBIENT_STATUS_JSON,
        service: { ...AMBIENT_STATUS_JSON.service, targetMode: malformed },
      });
      await expect(collectResult(createDaemonServiceStatusHandler(), {
        target: { kind: 'local' },
        surface: 'desktop.ui',
        mode: 'user',
      })).rejects.toMatchObject({
        code: 'invalid_cli_response',
        message: expect.stringContaining('"service.targetMode"'),
      });
    }
  });

  /**
   * The autostart mode decides whether this computer keeps answering once the app is closed.
   * Absent and `null` are unknown; anything outside the CLI's vocabulary — including the boolean
   * shape an earlier draft of this seam used — is corrupt output and must not be coerced.
   */
  it('projects the service autostart mode and refuses to guess one', async () => {
    for (const declared of ['at-login', 'on-demand'] as const) {
      runLocalHappierJsonCommandMock.mockResolvedValueOnce({
        ...AMBIENT_STATUS_JSON,
        service: { ...AMBIENT_STATUS_JSON.service, autostart: declared },
      });
      const { result } = await collectResult(createDaemonServiceStatusHandler(), {
        target: { kind: 'local' },
        surface: 'desktop.ui',
        mode: 'user',
      });
      expect(result).toMatchObject({ service: { installed: true, running: true, autostart: declared } });
    }

    for (const unknownValue of [undefined, null]) {
      runLocalHappierJsonCommandMock.mockResolvedValueOnce({
        ...AMBIENT_STATUS_JSON,
        service: { ...AMBIENT_STATUS_JSON.service, autostart: unknownValue },
      });
      const { result } = await collectResult(createDaemonServiceStatusHandler(), {
        target: { kind: 'local' },
        surface: 'desktop.ui',
        mode: 'user',
      });
      expect(result).toMatchObject({ service: { autostart: null } });
    }

    for (const malformed of [true, false, 'AT-LOGIN', 'login', 1]) {
      runLocalHappierJsonCommandMock.mockResolvedValueOnce({
        ...AMBIENT_STATUS_JSON,
        service: { ...AMBIENT_STATUS_JSON.service, autostart: malformed },
      });
      await expect(collectResult(createDaemonServiceStatusHandler(), {
        target: { kind: 'local' },
        surface: 'desktop.ui',
        mode: 'user',
      })).rejects.toMatchObject({
        code: 'invalid_cli_response',
        message: expect.stringContaining('"service.autostart"'),
      });
    }
  });

  it('rejects invalid daemon service params for the status task', async () => {
    const handler = createDaemonServiceStatusHandler();

    await expect(collectResult(handler, null)).rejects.toMatchObject({
      code: 'invalid_params',
    });
  });

  /**
   * A typo'd ring must not silently become `stable`: this task reads — and its siblings start and
   * stop — whichever ring's CLI answers, so the wrong ring is the wrong computer state.
   */
  it('rejects a channel outside the accepted rings instead of falling back to stable', async () => {
    await expect(collectResult(createDaemonServiceStatusHandler(), {
      target: { kind: 'local' },
      surface: 'desktop.ui',
      channel: 'nightly',
    })).rejects.toMatchObject({
      code: 'invalid_params',
      message: expect.stringContaining('stable, preview, dev, publicdev'),
    });
    expect(runLocalHappierJsonCommandMock).not.toHaveBeenCalled();

    // An absent channel still means the default ring.
    runLocalHappierJsonCommandMock.mockResolvedValueOnce(AMBIENT_STATUS_JSON);
    const { result } = await collectResult(createDaemonServiceStatusHandler(), {
      target: { kind: 'local' },
      surface: 'desktop.ui',
    });
    expect(result).toMatchObject({ serviceInstalled: true });
    expect(runLocalHappierJsonCommandMock.mock.calls[0]?.[0]).toMatchObject({ releaseRing: 'stable' });
  });

  it('rejects daemon service start params that target a non-local machine', async () => {
    const handler = createDaemonServiceStartHandler();

    await expect(collectResult(handler, {
      target: { kind: 'remote' },
      surface: 'desktop.ui',
      mode: 'user',
    })).rejects.toMatchObject({
      code: 'invalid_params',
    });
  });
});
