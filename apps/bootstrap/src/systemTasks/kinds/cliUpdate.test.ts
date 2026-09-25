import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ManagedCliUpdateRestart } from '@happier-dev/cli-common/firstPartyRuntime';

const { runLocalHappierJsonCommandMock, updateManagedLocalHappierCliMock } = vi.hoisted(() => ({
  runLocalHappierJsonCommandMock: vi.fn(),
  updateManagedLocalHappierCliMock: vi.fn(),
}));

// The Happier CLI is a subprocess boundary. The update transaction itself is proven at its owner
// (cli-common `runManagedCliUpdate`, and `updateManagedLocalHappierCli` in happierCli.test.ts);
// here the stand-in hands the kind's restart plan to the transaction the way it does.
vi.mock('../happierCli.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../happierCli.js')>();
  return {
    ...actual,
    runLocalHappierJsonCommand: runLocalHappierJsonCommandMock,
    updateManagedLocalHappierCli: updateManagedLocalHappierCliMock,
  };
});

import { createCliUpdateHandler } from './cliUpdate.js';

const CURRENT_CLI = { command: '/home/user/.happier/cli/current/happier', provenance: 'managed' as const, version: '0.2.13' };

function statusJson(params: Readonly<{ running: boolean; serviceManaged: boolean; version?: string }>) {
  return {
    server: {
      activeServerId: 'cloud',
      serverUrl: 'https://api.happier.dev',
      localServerUrl: null,
      publicServerUrl: 'https://api.happier.dev',
      webappUrl: 'https://app.happier.dev',
      comparableKey: 'api.happier.dev',
    },
    daemon: {
      running: params.running,
      pid: params.running ? 42 : null,
      httpPort: params.running ? 7777 : null,
      serviceManaged: params.serviceManaged,
      ...(params.version ? { startedWithCliVersion: params.version } : {}),
    },
    service: { installed: true, running: params.running },
    auth: { authenticated: true, machineRegistered: true, machineId: 'm1', needsAuth: false, accountId: 'acct' },
  };
}

/** The transaction's use of the plan: restart onto the target, and report what it proved. */
function transactionStandIn(targetVersion: string) {
  return async (params: Readonly<{ planRestart: (current: typeof CURRENT_CLI) => Promise<ManagedCliUpdateRestart | null> }>) => {
    const restart = await params.planRestart(CURRENT_CLI);
    await restart?.({ expectedVersion: targetVersion, phase: 'activated' });
    return { previousVersion: CURRENT_CLI.version, cli: { ...CURRENT_CLI, version: targetVersion }, restarted: restart !== null };
  };
}

async function run(params: unknown) {
  const events: unknown[] = [];
  const iterator = createCliUpdateHandler()(params, { signal: new AbortController().signal, emit: (event) => { events.push(event); } });
  for (;;) {
    const next = await iterator.next();
    if (next.done) return { result: next.value, events };
  }
}

describe('cli.update.v1', () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  it('restarts a running service daemon through the service\'s own relay selection and proves the new version', async () => {
    // A stack-pinned launch: the restart and its proof must not follow the pinned profile.
    process.env.HAPPIER_ACTIVE_SERVER_ID = 'stack-pinned';
    updateManagedLocalHappierCliMock.mockImplementation(transactionStandIn('0.2.14'));
    runLocalHappierJsonCommandMock
      .mockResolvedValueOnce(statusJson({ running: true, serviceManaged: true, version: '0.2.13' }))
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce(statusJson({ running: true, serviceManaged: true, version: '0.2.14' }));

    const { result } = await run({ channel: 'preview' });

    expect(updateManagedLocalHappierCliMock).toHaveBeenCalledWith(expect.objectContaining({ releaseRing: 'preview' }));
    expect(runLocalHappierJsonCommandMock.mock.calls.map((call) => call[0].args.join(' '))).toEqual([
      'daemon status --json',
      'daemon service restart --json',
      'daemon status --json',
    ]);
    for (const [call] of runLocalHappierJsonCommandMock.mock.calls) {
      expect(call.cli.command).toBe(CURRENT_CLI.command);
      expect(call.processEnv.HAPPIER_ACTIVE_SERVER_ID).toBeUndefined();
    }
    expect(result).toEqual({ previousVersion: '0.2.13', version: '0.2.14', restarted: true });
  });

  it('does not start a daemon that was not running, nor restart a manual one', async () => {
    updateManagedLocalHappierCliMock.mockImplementation(transactionStandIn('0.2.14'));
    runLocalHappierJsonCommandMock.mockResolvedValueOnce(statusJson({ running: false, serviceManaged: false }));
    expect((await run({ channel: 'stable' })).result).toEqual({ previousVersion: '0.2.13', version: '0.2.14', restarted: false });

    runLocalHappierJsonCommandMock.mockResolvedValueOnce(statusJson({ running: true, serviceManaged: false, version: '0.2.13' }));
    expect((await run({ channel: 'stable' })).result).toMatchObject({ restarted: false });
    expect(runLocalHappierJsonCommandMock.mock.calls.some((call) => call[0].args.includes('restart'))).toBe(false);
  });

  it('fails the restart proof when the restarted daemon still runs the previous version', async () => {
    updateManagedLocalHappierCliMock.mockImplementation(transactionStandIn('0.2.14'));
    runLocalHappierJsonCommandMock
      .mockResolvedValueOnce(statusJson({ running: true, serviceManaged: true, version: '0.2.13' }))
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce(statusJson({ running: true, serviceManaged: true, version: '0.2.13' }));

    await expect(run({ channel: 'stable' })).rejects.toThrow(/runs 0\.2\.13 instead of 0\.2\.14/);
  });

  it('rejects an unknown channel without updating anything', async () => {
    await expect(run({ channel: 'nightly' })).rejects.toMatchObject({ code: 'invalid_params' });
    expect(updateManagedLocalHappierCliMock).not.toHaveBeenCalled();
  });
});
