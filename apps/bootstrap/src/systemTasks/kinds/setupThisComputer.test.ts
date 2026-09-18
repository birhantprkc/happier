import { createSystemTasksRunner, SystemTaskExecutionError } from '@happier-dev/cli-common/systemTasks';
import {
  parseSetupPairingPromptData,
  parseSetupServiceConsentPromptData,
  SETUP_PAIRING_PROMPT_KIND,
  SETUP_SERVICE_CONSENT_PROMPT_KIND,
  type SystemTaskJsonValue,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import type {
  AuthStatusSnapshot,
  ServiceInstallPreview,
} from '../localDaemonCli.js';
import {
  createSetupThisComputerKind,
  type ServiceLifecycleObservation,
  type SetupThisComputerDeps,
} from './setupThisComputer.js';

const APP_RELAY = 'https://app-relay.example.test';
const CLI_RELAY_KEY = 'cli-relay.example.test';
const APP_RELAY_KEY = 'app-relay.example.test';

const baseParams = {
  activeRelayUrl: APP_RELAY,
  activeWebappUrl: 'https://app.example.test',
  activeLocalRelayUrl: null,
  channel: 'stable',
  expectedAccountId: 'acct_app',
  surface: 'desktop.ui',
} satisfies Record<string, SystemTaskJsonValue>;

type Scenario = Readonly<{
  preview?: ServiceInstallPreview;
  authStatus?: AuthStatusSnapshot;
  authStatusAfterPairing?: AuthStatusSnapshot;
  daemonStatus?: ServiceLifecycleObservation;
  cliProvenance?: 'managed' | 'override';
  onInstall?: () => void;
  /** Abort the run's signal while the named step is executing. */
  abortAfter?: string;
}>;

function createScenario(scenario: Scenario = {}) {
  const calls: string[] = [];
  const controller = new AbortController();
  const record = (call: string): void => {
    calls.push(call);
    if (scenario.abortAfter === call) {
      controller.abort();
    }
  };
  const preview = scenario.preview ?? { takeover: null, installConflict: null };
  let authStatus: AuthStatusSnapshot = scenario.authStatus ?? {
    authenticated: true,
    accountId: 'acct_app',
    machineId: 'machine-existing',
  };
  const daemonStatus: ServiceLifecycleObservation = scenario.daemonStatus ?? {
    serviceInstalled: false,
    daemonRunning: false,
    serverComparableKey: CLI_RELAY_KEY,
  };

  const deps: SetupThisComputerDeps = {
    ensureCli: vi.fn(async () => {
      record('ensureCli');
      return { command: '/managed/happier', provenance: scenario.cliProvenance ?? 'managed', version: '0.2.13' };
    }),
    previewServiceInstall: vi.fn(async () => {
      record('previewServiceInstall');
      return preview;
    }),
    configureRelay: vi.fn(async (_ring, profile) => {
      record(`configureRelay:${profile.serverUrl}`);
      return { serverUrl: profile.serverUrl, comparableKey: APP_RELAY_KEY };
    }),
    readAuthStatus: vi.fn(async () => {
      record('readAuthStatus');
      return authStatus;
    }),
    requestAuthPairing: vi.fn(async () => {
      record('requestAuthPairing');
      return {
        publicKey: 'cHVibGljLWtleQ==',
        publicKeyB64Url: 'cHVibGljLWtleQ',
        pairingRequirement: 'compatible',
      };
    }),
    waitForAuthPairing: vi.fn(async (_ring, params) => {
      record(`waitForAuthPairing:${params.replaceExisting ? 'replace' : 'plain'}`);
      authStatus = scenario.authStatusAfterPairing ?? { authenticated: true, accountId: 'acct_app', machineId: 'machine-paired' };
      return { machineId: 'machine-paired' };
    }),
    readDaemonStatus: vi.fn(async () => {
      record('readDaemonStatus');
      return daemonStatus;
    }),
    installService: vi.fn(async (_ring, flags) => {
      record(`installService:${flags.replaceExisting ? 'replace' : 'plain'}:${flags.takeover ? 'takeover' : 'noTakeover'}`);
      scenario.onInstall?.();
    }),
    startService: vi.fn(async (_ring, params) => {
      record(`${params.action}Service${params.takeover ? ':takeover' : ''}`);
    }),
    ensurePathExposure: vi.fn(async () => {
      record('ensurePathExposure');
      return { changed: true, shellReloadHint: 'open a new terminal', failure: null };
    }),
  };

  return { deps, calls, controller };
}

async function runKind(params: Readonly<{
  deps: SetupThisComputerDeps;
  taskParams?: Record<string, SystemTaskJsonValue>;
  answer?: (prompt: Readonly<{ kind: string; data: SystemTaskJsonValue }>) => unknown;
  signal?: AbortSignal;
}>) {
  const events: Array<Readonly<{ type: string; stepId?: string; data?: unknown }>> = [];
  const prompts: Array<Readonly<{ kind: string; data: SystemTaskJsonValue }>> = [];
  const kind = createSetupThisComputerKind(params.deps);
  const result = await kind.run({
    params: params.taskParams ?? baseParams,
    signal: params.signal,
    emit: (event) => {
      events.push(event);
    },
    prompt: async (prompt) => {
      prompts.push({ kind: prompt.kind, data: prompt.data });
      events.push({ type: 'prompt', stepId: prompt.stepId, data: prompt.data });
      return params.answer ? params.answer(prompt) : { approved: true };
    },
  });
  return { result, events, prompts };
}

async function expectExecutionError(promise: Promise<unknown>): Promise<SystemTaskExecutionError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SystemTaskExecutionError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected the setup task to fail');
}

describe('setup.thisComputer.v1 (interactive executor)', () => {
  it('configures the relay the app sent, never the CLI\'s current one', async () => {
    const { deps, calls } = createScenario();
    const { result } = await runKind({ deps });

    expect(calls).toContain(`configureRelay:${APP_RELAY}`);
    // Every CLI command in the run goes to the CLI this run resolved, never a re-resolution.
    expect(deps.configureRelay).toHaveBeenCalledWith('stable', {
      serverUrl: APP_RELAY,
      webappUrl: 'https://app.example.test',
      localServerUrl: null,
    }, { command: '/managed/happier', provenance: 'managed', version: '0.2.13' });
    expect(result.machineId).toBe('machine-existing');
    expect(result.relayChanged).toBe(true);
  });

  it('requires exactly the relay, webapp and account target, and runs without an app server profile id', async () => {
    const { deps, calls } = createScenario();
    for (const key of ['activeRelayUrl', 'activeWebappUrl', 'expectedAccountId'] as const) {
      const { [key]: _dropped, ...withoutKey } = baseParams;
      const error = await expectExecutionError(runKind({ deps, taskParams: withoutKey }));
      expect(error.code, `${key} must be required`).toBe('invalid_params');
    }
    // Nothing falls back to an ambient relay, and nothing was executed before the target failed.
    expect(calls).toEqual([]);

    // `activeServerId` is not part of the contract: the app's server profile id never reached
    // this executor, so a spec that omits it must run the whole flow.
    const { result } = await runKind({ deps });
    expect(result.machineId).toBe('machine-existing');
    expect(calls).toContain(`configureRelay:${APP_RELAY}`);
  });

  it('rejects an invalid channel and account without running anything', async () => {
    const { deps, calls } = createScenario();
    const error = await expectExecutionError(runKind({ deps, taskParams: { ...baseParams, channel: 'nightly' } }));
    expect(error.code).toBe('invalid_params');

    const accountError = await expectExecutionError(runKind({ deps, taskParams: { ...baseParams, expectedAccountId: '' } }));
    expect(accountError.code).toBe('invalid_params');
    expect(calls).toEqual([]);
  });

  it('configures the relay before validating credentials, and validates only after the relay is set', async () => {
    const { deps, calls } = createScenario();
    await runKind({ deps });

    const configureIndex = calls.indexOf(`configureRelay:${APP_RELAY}`);
    const authIndex = calls.indexOf('readAuthStatus');
    expect(configureIndex).toBeGreaterThanOrEqual(0);
    expect(authIndex).toBeGreaterThan(configureIndex);
  });

  it('obtains consent for a pre-existing manual/pinned service before the relay or credentials change', async () => {
    const { deps, calls } = createScenario({
      preview: {
        takeover: 'Taking over the current manual daemon.',
        installConflict: {
          blocking: false,
          message: 'Would remove competing background services before install: happier-preview.',
          competingServices: ['happier-preview'],
          servicesToRemove: ['happier-preview'],
        },
      },
      authStatus: { authenticated: false, accountId: null, machineId: null },
    });
    const callsAtPrompt: string[][] = [];
    const { prompts } = await runKind({
      deps,
      answer: (prompt) => {
        callsAtPrompt.push([...calls]);
        return { approved: true };
      },
    });

    expect(prompts[0]?.kind).toBe(SETUP_SERVICE_CONSENT_PROMPT_KIND);
    expect(parseSetupServiceConsentPromptData(prompts[0]?.data)).toEqual({
      takeover: 'Taking over the current manual daemon.',
      message: 'Would remove competing background services before install: happier-preview.',
      competingServices: ['happier-preview'],
      servicesToRemove: ['happier-preview'],
    });
    expect(callsAtPrompt[0]).toEqual(['ensureCli', 'previewServiceInstall']);
    expect(calls.indexOf('ensurePathExposure')).toBeGreaterThan(calls.indexOf('previewServiceInstall'));
    expect(calls).toContain('installService:replace:takeover');
    expect(calls).toContain('startService:takeover');
  });

  /**
   * The apply is the other half of the consent. `install` is the CLI's idempotent convergence
   * command — it re-evaluates the conflict and no-ops when the exact target already matches — so an
   * already-installed definition is exactly the case where the consented `--replace-existing`/
   * `--takeover` has to run. Leaving it to `start`'s best-effort drift refresh means the removal
   * the user approved may silently never happen.
   */
  it('applies the consented replace/takeover even when a service definition already exists', async () => {
    const { deps, calls } = createScenario({
      preview: {
        takeover: 'Taking over the current manual daemon.',
        installConflict: {
          blocking: false,
          message: 'Would remove competing background services before install: happier-preview.',
          competingServices: ['happier-preview'],
          servicesToRemove: ['happier-preview'],
        },
      },
      daemonStatus: {
        serviceInstalled: true,
        daemonRunning: true,
        serverComparableKey: APP_RELAY_KEY,
      },
    });

    const { result } = await runKind({ deps });

    expect(calls).toContain('installService:replace:takeover');
    expect(deps.installService).toHaveBeenCalledWith(
      'stable',
      { replaceExisting: true, takeover: true },
      { command: '/managed/happier', provenance: 'managed', version: '0.2.13' },
    );
    // The lifecycle decision is unchanged: nothing the executor changed, so start (not restart).
    expect(calls.indexOf('installService:replace:takeover')).toBeLessThan(calls.indexOf('startService:takeover'));
    expect(result.serviceAction).toBe('start');
  });

  it('does not apply install flags when the dry-run demanded no consent and a service exists', async () => {
    const { deps, calls } = createScenario({
      daemonStatus: {
        serviceInstalled: true,
        daemonRunning: true,
        serverComparableKey: APP_RELAY_KEY,
      },
    });

    await runKind({ deps });

    expect(calls.filter((call) => call.startsWith('installService'))).toEqual([]);
    expect(calls).toContain('startService');
  });

  it('declined consent stops before any mutation', async () => {
    const { deps, calls } = createScenario({
      preview: {
        takeover: 'Taking over the current manual daemon.',
        installConflict: null,
      },
    });
    const error = await expectExecutionError(runKind({ deps, answer: () => ({ approved: false }) }));

    expect(error.code).toBe('service_consent_declined');
    expect(calls).toEqual(['ensureCli', 'previewServiceInstall']);
  });

  it('fails with the CLI\'s blocking conflict before any mutation', async () => {
    const { deps, calls } = createScenario({
      preview: {
        takeover: null,
        installConflict: {
          blocking: true,
          message: 'Conflicting background services from another Happier home were detected.',
          competingServices: ['happier-other-home'],
          servicesToRemove: [],
        },
      },
    });
    const error = await expectExecutionError(runKind({ deps }));

    expect(error.code).toBe('service_install_blocked');
    expect(error.message).toContain('another Happier home');
    expect(calls).toEqual(['ensureCli', 'previewServiceInstall']);
  });

  it('installs silently when the dry-run reports nothing to consent to', async () => {
    const { deps, calls, } = createScenario();
    const { prompts } = await runKind({ deps });

    expect(prompts).toEqual([]);
    expect(calls).toContain('installService:plain:noTakeover');
    expect(calls).toContain('startService');
  });

  it('pairs through a prompt that carries only public material and resumes when answered', async () => {
    const { deps, calls } = createScenario({
      authStatus: { authenticated: false, accountId: null, machineId: null },
    });
    const { result, events, prompts } = await runKind({ deps });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.kind).toBe(SETUP_PAIRING_PROMPT_KIND);
    // The app reads this prompt through the shared contract parser; a payload it cannot parse is
    // an unanswerable prompt. `serverIdentityKey` is the key the CLI ended up configured for, so
    // an echo of the spec cannot stand in for the CLI's own state.
    expect(parseSetupPairingPromptData(prompts[0]?.data)).toEqual({
      publicKeyB64Url: 'cHVibGljLWtleQ',
      relayUrl: APP_RELAY,
      serverIdentityKey: APP_RELAY_KEY,
      // The account this run is pairing for: the app refuses to approve a pairing that is not
      // bound to the account it started setup for (INV2).
      accountId: 'acct_app',
      pairingRequirement: 'compatible',
      cliProvenance: 'managed',
      cliCommand: '/managed/happier',
    });
    const serialized = JSON.stringify(events);
    expect(Object.keys(flattenKeys(events)).filter((key) => /secret|token|password|statefile/i.test(key))).toEqual([]);
    expect(serialized).not.toContain('cHVibGljLWtleQ==');
    // Rejected credentials are reported exactly like missing ones; the approved pairing must be
    // claimed rather than returned early, so the claim never trusts a pre-existing file here.
    expect(calls).toContain('waitForAuthPairing:replace');
    expect(result.machineId).toBe('machine-paired');
    expect(result.credentialsChanged).toBe(true);
  });

  it('never emits or returns the relay URL credentials the app passed it', async () => {
    // `relayUrl` is not a key name the runner's redaction matches, so a credential-bearing relay
    // would otherwise reach event snapshots and logs verbatim. The result line is written to
    // hsetup's stdout unredacted, so it must not carry the URL at all.
    const { deps } = createScenario({
      authStatus: { authenticated: false, accountId: null, machineId: null },
    });
    const { result, events, prompts } = await runKind({
      deps,
      taskParams: { ...baseParams, activeRelayUrl: 'https://relay-user:relay-pass@app-relay.example.test/' },
    });

    expect(parseSetupPairingPromptData(prompts[0]?.data)?.relayUrl).toBe('https://app-relay.example.test/');
    const serialized = JSON.stringify({ events, result });
    expect(serialized).not.toContain('relay-pass');
    expect(serialized).not.toContain('relay-user');
  });

  it('fails closed when the pairing prompt is declined, and names why', async () => {
    const { deps, calls } = createScenario({
      authStatus: { authenticated: false, accountId: null, machineId: null },
    });
    const error = await expectExecutionError(runKind({ deps, answer: () => ({ approved: false }) }));

    expect(error.code).toBe('pairing_declined');
    expect(calls.filter((call) => call.startsWith('waitForAuthPairing'))).toEqual([]);
    expect(calls).not.toContain('installService:plain:noTakeover');

    // The app's refusal codes (`cli_not_managed`, `account_mismatch`, …) are the only thing that
    // says why an unattended approval was refused, so they reach the failure instead of dying as
    // a generic decline.
    const named = await expectExecutionError(runKind({
      deps: createScenario({ authStatus: { authenticated: false, accountId: null, machineId: null } }).deps,
      answer: () => ({ approved: false, reason: 'cli_not_managed' }),
    }));
    expect(named.code).toBe('pairing_declined');
    expect(named.message).toContain('cli_not_managed');

    // Only a fixed refusal code is ever interpolated; free text from the bridge is not.
    const opaque = await expectExecutionError(runKind({
      deps: createScenario({ authStatus: { authenticated: false, accountId: null, machineId: null } }).deps,
      answer: () => ({ approved: false, reason: 'Bearer app-token leaked here' }),
    }));
    expect(opaque.message).not.toContain('app-token');
  });

  it('claims with --replace-existing when the target relay credentials belong to another account', async () => {
    const { deps, calls } = createScenario({
      authStatus: { authenticated: true, accountId: 'acct_other', machineId: 'machine-other' },
      authStatusAfterPairing: { authenticated: true, accountId: 'acct_app', machineId: 'machine-app' },
    });
    const { result, prompts } = await runKind({ deps });

    expect(prompts.map((prompt) => prompt.kind)).toEqual([SETUP_PAIRING_PROMPT_KIND]);
    expect(calls).toContain('waitForAuthPairing:replace');
    expect(result.machineId).toBe('machine-paired');
    expect(result.machineId).not.toBe('machine-other');
    expect(result.credentialsChanged).toBe(true);
  });

  it('establishes a machine id without a pairing prompt when the same account has none yet, and does not call that a credential change', async () => {
    const { deps, calls } = createScenario({
      authStatus: { authenticated: true, accountId: 'acct_app', machineId: null },
      daemonStatus: { serviceInstalled: true, daemonRunning: true, serverComparableKey: APP_RELAY_KEY },
    });
    const { result, prompts } = await runKind({ deps });

    expect(prompts).toEqual([]);
    expect(calls).toContain('requestAuthPairing');
    expect(calls).toContain('waitForAuthPairing:plain');
    expect(result.machineId).toBe('machine-paired');
    // `auth wait` returned the credentials already on disk: nothing about them changed, so the
    // running daemon must not be restarted for them.
    expect(result.credentialsChanged).toBe(false);
    expect(result.relayChanged).toBe(false);
    expect(result.serviceAction).toBe('start');
    expect(calls).not.toContain('restartService');
  });

  it('restarts a running service when credentials changed and only starts it when nothing changed', async () => {
    const runningStatus: ServiceLifecycleObservation = {
      serviceInstalled: true,
      daemonRunning: true,
      serverComparableKey: APP_RELAY_KEY,
    };

    const changed = createScenario({
      daemonStatus: runningStatus,
      authStatus: { authenticated: true, accountId: 'acct_other', machineId: 'machine-other' },
    });
    const changedRun = await runKind({ deps: changed.deps });
    expect(changed.calls).toContain('restartService');
    expect(changed.calls).not.toContain('startService');
    expect(changed.calls.filter((call) => call.startsWith('installService'))).toEqual([]);
    expect(changedRun.result.serviceAction).toBe('restart');

    const unchanged = createScenario({
      daemonStatus: runningStatus,
    });
    const unchangedRun = await runKind({ deps: unchanged.deps });
    expect(unchanged.calls).not.toContain('restartService');
    expect(unchanged.calls).toContain('startService');
    expect(unchangedRun.result.relayChanged).toBe(false);
    expect(unchangedRun.result.credentialsChanged).toBe(false);
    expect(unchangedRun.result.serviceAction).toBe('start');
  });

  it('starts an installed but stopped service without reinstalling it', async () => {
    const { deps, calls, } = createScenario({
      daemonStatus: {
        serviceInstalled: true,
        daemonRunning: false,
        serverComparableKey: APP_RELAY_KEY,
      },
    });
    const { result } = await runKind({ deps });

    expect(calls.filter((call) => call.startsWith('installService'))).toEqual([]);
    expect(calls).toContain('startService');
    expect(result.serviceAction).toBe('start');
  });

  it('reports the install ownership and the command it resolved', async () => {
    const { deps } = createScenario({
      cliProvenance: 'override',
      authStatus: { authenticated: false, accountId: null, machineId: null },
    });
    const { result, prompts } = await runKind({ deps });

    expect(result.cliProvenance).toBe('override');
    expect(prompts).toHaveLength(1);
    // The app asks a human before approving a CLI the desktop install path did not place, and the
    // question names this exact binary — so both facts must reach it on the prompt itself.
    const payload = parseSetupPairingPromptData(prompts[0]?.data);
    expect(payload?.cliProvenance).toBe('override');
    expect(payload?.cliCommand).toBe('/managed/happier');
    // Nothing beyond the contract's public fields may ride along.
    expect(Object.keys(prompts[0]?.data as object)).toEqual([
      'kind',
      'publicKeyB64Url',
      'relayUrl',
      'serverIdentityKey',
      'accountId',
      'pairingRequirement',
      'cliProvenance',
      'cliCommand',
    ]);
  });

  it('runs PATH exposure alongside service work and reports its failure without gating the result', async () => {
    const { deps, calls } = createScenario();
    (deps.ensurePathExposure as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      calls.push('ensurePathExposure');
      throw new Error('profile is read-only');
    });
    const { result, events } = await runKind({ deps });

    expect(calls.indexOf('ensurePathExposure')).toBeLessThan(calls.indexOf('startService'));
    expect(result.serviceAction).toBe('install');
    // Reported on the run's own event stream, BEFORE the result line: the desktop bridge stops
    // reading hsetup's stdout at the result (`src-tauri/src/system_tasks/mod.rs:191-199`), so an
    // event emitted afterwards is discarded.
    const pathEvents = events.filter((event) => event.stepId === 'setup.thisComputer.pathExposure');
    expect(pathEvents).toEqual([
      expect.objectContaining({ message: expect.stringContaining('profile is read-only') }),
    ]);
    expect(events.indexOf(pathEvents[0]!)).toBeLessThan(events.length);
  });

  /**
   * R6: PATH exposure must never gate readiness or the reveal. The app starts its readiness proof
   * from the task result, so awaiting a shell-profile write here would hold the reveal behind it.
   */
  /**
   * The desktop bridge stops reading hsetup's stdout at the result line
   * (`apps/ui/src-tauri/src/system_tasks/mod.rs:191-199` breaks out of the read loop), so an event
   * emitted after it is discarded. A report nothing can receive is worse than none: it reads like
   * an observable failure path and is not one.
   */
  it('does not report a PATH failure that settles after the result line', async () => {
    const { deps } = createScenario();
    type PathExposureOutcome = Readonly<{ changed: boolean; shellReloadHint: string | null; failure: string | null }>;
    let settlePathExposure!: (outcome: PathExposureOutcome) => void;
    (deps.ensurePathExposure as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise<PathExposureOutcome>((resolve) => {
      settlePathExposure = resolve;
    }));

    const { events } = await runKind({ deps });
    const emittedBeforeResult = events.length;

    settlePathExposure({ changed: false, shellReloadHint: null, failure: 'profile is read-only' });
    await Promise.resolve();
    await Promise.resolve();

    expect(events.length).toBe(emittedBeforeResult);
    expect(events.filter((event) => event.stepId === 'setup.thisComputer.pathExposure')).toEqual([]);
  });

  it('returns without waiting for PATH exposure to finish, and emits nothing it cannot deliver', async () => {
    const { deps, calls } = createScenario();
    (deps.ensurePathExposure as ReturnType<typeof vi.fn>).mockImplementation(() => {
      calls.push('ensurePathExposure');
      return new Promise(() => {});
    });

    const { result, events } = await runKind({ deps });

    expect(calls).toContain('ensurePathExposure');
    expect(result.machineId).toBe('machine-existing');
    expect(result.serviceAction).toBe('install');
    // Still in flight at the result: there is no line the bridge would still read, so the run
    // reports nothing and the settings PATH action owns the outcome.
    expect(events.filter((event) => event.stepId === 'setup.thisComputer.pathExposure')).toEqual([]);
  });

  it('leaves an installed, stopped service on cancellation between install and start, and a re-run converges', async () => {
    const controller = new AbortController();
    const first = createScenario({ onInstall: () => controller.abort() });
    const error = await expectExecutionError(runKind({ deps: first.deps, signal: controller.signal }));

    expect(error.code).toBe('cancelled');
    expect(first.calls).toContain('installService:plain:noTakeover');
    expect(first.calls).not.toContain('startService');

    const second = createScenario({
      daemonStatus: {
        serviceInstalled: true,
        daemonRunning: false,
        serverComparableKey: APP_RELAY_KEY,
      },
    });
    const { result } = await runKind({ deps: second.deps });
    expect(second.calls.filter((call) => call.startsWith('installService'))).toEqual([]);
    expect(second.calls).toContain('startService');
    expect(result.serviceAction).toBe('start');
  });

  it('cancellation during an awaited step stops before every later mutation (INV11)', async () => {
    // Cancelled while the pre-relay daemon read is in flight: the relay profile is never rewritten.
    const duringDaemonRead = createScenario({ abortAfter: 'readDaemonStatus' });
    const daemonReadError = await expectExecutionError(runKind({
      deps: duringDaemonRead.deps,
      signal: duringDaemonRead.controller.signal,
    }));
    expect(daemonReadError.code).toBe('cancelled');
    expect(duringDaemonRead.deps.configureRelay).not.toHaveBeenCalled();
    expect(duringDaemonRead.calls).toEqual(['ensureCli', 'previewServiceInstall', 'ensurePathExposure', 'readDaemonStatus']);

    // Cancelled while the credential read is in flight: no pairing request is created on the relay
    // and no pending pairing state is written on this computer.
    const duringAuthRead = createScenario({
      abortAfter: 'readAuthStatus',
      authStatus: { authenticated: false, accountId: null, machineId: null },
    });
    const authReadError = await expectExecutionError(runKind({
      deps: duringAuthRead.deps,
      signal: duringAuthRead.controller.signal,
    }));
    expect(authReadError.code).toBe('cancelled');
    expect(duringAuthRead.deps.requestAuthPairing).not.toHaveBeenCalled();
    expect(duringAuthRead.deps.installService).not.toHaveBeenCalled();
    expect(duringAuthRead.deps.startService).not.toHaveBeenCalled();

    // Cancelled while the final service start is in flight: the run reports cancelled instead of
    // success. INV11 forbids rollback, so the service the CLI already started stays as it is.
    const duringStart = createScenario({ abortAfter: 'startService' });
    const startError = await expectExecutionError(runKind({
      deps: duringStart.deps,
      signal: duringStart.controller.signal,
    }));
    expect(startError.code).toBe('cancelled');
    expect(duringStart.deps.startService).toHaveBeenCalledTimes(1);
  });

  it('runs as an interactive kind: a respond() reaches the waiting task and resumes it', async () => {
    const { deps, calls } = createScenario({
      authStatus: { authenticated: false, accountId: null, machineId: null },
    });
    const runner = createSystemTasksRunner({
      now: () => 1700000000000,
      kinds: { 'setup.thisComputer.v1': createSetupThisComputerKind(deps) },
    });
    await runner.start({ taskId: 'task-1', kind: 'setup.thisComputer.v1', params: baseParams });

    const waiting = await pollUntil(async () => {
      const polled = await runner.poll({ taskId: 'task-1', cursor: 0 });
      return polled.pendingPrompt ? polled : null;
    });
    expect(waiting.pendingPrompt?.kind).toBe(SETUP_PAIRING_PROMPT_KIND);
    expect(waiting.result).toBeNull();
    expect(calls.filter((call) => call.startsWith('waitForAuthPairing'))).toEqual([]);

    await runner.respond({ taskId: 'task-1', answer: { approved: true } });
    const finished = await pollUntil(async () => {
      const polled = await runner.poll({ taskId: 'task-1', cursor: 0 });
      return polled.result ? polled : null;
    });
    expect(finished.result).toMatchObject({ ok: true, data: { machineId: 'machine-paired' } });
    expect(calls).toContain('waitForAuthPairing:replace');
  });
});

function flattenKeys(value: unknown, into: Record<string, true> = {}): Record<string, true> {
  if (Array.isArray(value)) {
    for (const entry of value) flattenKeys(entry, into);
  } else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      into[key] = true;
      flattenKeys(entry, into);
    }
  }
  return into;
}

async function pollUntil<T>(read: () => Promise<T | null>): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = await read();
    if (value !== null) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for the system task runner');
}
