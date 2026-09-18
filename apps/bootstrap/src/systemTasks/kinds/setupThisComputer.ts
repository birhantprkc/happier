import { systemTasks } from '@happier-dev/cli-common';
import {
  createSetupPairingPromptData,
  createSetupServiceConsentPromptData,
  SETUP_PAIRING_PROMPT_KIND,
  SETUP_SERVICE_CONSENT_PROMPT_KIND,
} from '@happier-dev/protocol';
import { ensureHappierCliPathExposure, resolveFirstPartyInstallLayout } from '@happier-dev/cli-common/firstPartyRuntime';
import type { InteractiveSystemTaskContext, InteractiveSystemTaskKind } from '@happier-dev/cli-common/systemTasks';
import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import type { SetupCapableLocalHappierCli } from '../happierCli.js';
import {
  type AuthPairingClaim,
  type AuthPairingRequest,
  type AuthStatusSnapshot,
  type ConfiguredRelay,
  type DaemonStatusSnapshot,
  type RelayProfileTarget,
  type ServiceInstallApplyFlags,
  type ServiceInstallPreview,
  previewServiceInstall,
  readAuthStatus,
  readDaemonStatus,
} from '../localDaemonCli.js';
import type { LocalFirstPartyCommandProvenance } from '../localFirstPartyCommand.js';
import { ACCEPTED_BOOTSTRAP_CHANNELS, normalizeBootstrapChannel } from '../taskRuntime.js';

export type SetupThisComputerParams = Readonly<{
  activeRelayUrl: string;
  activeWebappUrl: string;
  activeLocalRelayUrl: string | null;
  releaseRing: PublicReleaseRingId;
  expectedAccountId: string;
  surface?: string;
}>;

export type SetupThisComputerServiceAction = 'install' | 'start' | 'restart';

/** The slice of the daemon status the lifecycle decision (E3) reads before the relay changes. */
export type ServiceLifecycleObservation = Pick<DaemonStatusSnapshot, 'serviceInstalled' | 'daemonRunning' | 'serverComparableKey'>;

/**
 * hsetup writes this line to stdout unredacted (only events are redacted), so it carries no URL:
 * the relay the app selected is the app's own input, and a credential-bearing one would reach the
 * app's logs and the bridge's snapshots verbatim. `relayChanged` reports the outcome instead.
 *
 * PATH exposure is absent for the same reason it is not awaited (R6): the app begins its readiness
 * proof from this result, so anything reported here gates the reveal. Its state is read — and
 * repaired — through the `cli.pathExposure.*` tasks that own it.
 */
export type SetupThisComputerResult = Readonly<{
  machineId: string;
  cliProvenance: LocalFirstPartyCommandProvenance;
  cliVersion: string;
  relayChanged: boolean;
  credentialsChanged: boolean;
  /**
   * The lifecycle action the executor selected (E3). A consented replace/takeover apply may also
   * have run beside it — that is the CLI's convergence command, not a lifecycle decision.
   */
  serviceAction: SetupThisComputerServiceAction;
}>;

type PathExposureOutcome = Readonly<{
  changed: boolean;
  shellReloadHint: string | null;
  failure: string | null;
}>;

/**
 * Every CLI command in the run takes the CLI `ensureCli` resolved, and the parameter is required
 * here so the executor cannot forget one: the pairing this run approves is bound to that exact
 * command path and provenance (INV2), and re-resolving per command would let a different binary —
 * an override that appeared or disappeared mid-run, a freshly promoted managed install — answer
 * the commands that write credentials and install the service.
 */
export type SetupThisComputerDeps = Readonly<{
  ensureCli: (params: Readonly<{ releaseRing: PublicReleaseRingId }>) => Promise<SetupCapableLocalHappierCli>;
  previewServiceInstall: (
    releaseRing: PublicReleaseRingId,
    cli: SetupCapableLocalHappierCli,
  ) => Promise<ServiceInstallPreview>;
  configureRelay: (
    releaseRing: PublicReleaseRingId,
    profile: RelayProfileTarget,
    cli: SetupCapableLocalHappierCli,
  ) => Promise<ConfiguredRelay>;
  readAuthStatus: (
    releaseRing: PublicReleaseRingId,
    cli: SetupCapableLocalHappierCli,
  ) => Promise<AuthStatusSnapshot>;
  requestAuthPairing: (
    releaseRing: PublicReleaseRingId,
    cli: SetupCapableLocalHappierCli,
  ) => Promise<AuthPairingRequest>;
  waitForAuthPairing: (
    releaseRing: PublicReleaseRingId,
    params: Readonly<{ publicKey: string; replaceExisting: boolean }>,
    cli: SetupCapableLocalHappierCli,
  ) => Promise<AuthPairingClaim>;
  readDaemonStatus: (
    releaseRing: PublicReleaseRingId,
    cli: SetupCapableLocalHappierCli,
  ) => Promise<ServiceLifecycleObservation>;
  installService: (
    releaseRing: PublicReleaseRingId,
    flags: ServiceInstallApplyFlags,
    cli: SetupCapableLocalHappierCli,
  ) => Promise<void>;
  startService: (
    releaseRing: PublicReleaseRingId,
    params: Readonly<{ action: 'start' | 'restart'; takeover: boolean }>,
    cli: SetupCapableLocalHappierCli,
  ) => Promise<void>;
  ensurePathExposure: (params: Readonly<{ releaseRing: PublicReleaseRingId }>) => Promise<PathExposureOutcome>;
}>;

/**
 * The deps whose real implementation changes this computer: it installs the managed CLI, rewrites
 * the CLI's relay profile and credentials, installs/starts the background service, or edits the
 * user's shell startup files. Requiring them means a caller — a test above all — cannot construct
 * the kind without deciding, so a forgotten stub is a compile error instead of a silent mutation
 * of the developer's machine.
 */
type MutatingSetupDepName =
  | 'ensureCli'
  | 'configureRelay'
  | 'requestAuthPairing'
  | 'waitForAuthPairing'
  | 'installService'
  | 'startService'
  | 'ensurePathExposure';

/** Every mutating dep is explicit; the three read-only CLI reads keep their real default. */
export type SetupThisComputerDepsInput =
  Pick<SetupThisComputerDeps, MutatingSetupDepName>
  & Partial<Omit<SetupThisComputerDeps, MutatingSetupDepName>>;

const STEP = {
  ensureCli: 'setup.thisComputer.ensureCli',
  inspectService: 'setup.thisComputer.inspectService',
  serviceConsent: 'setup.thisComputer.serviceConsent',
  configureRelay: 'setup.thisComputer.configureRelay',
  checkAuth: 'setup.thisComputer.checkAuth',
  authRequest: 'setup.thisComputer.auth.request',
  authWait: 'setup.thisComputer.auth.wait',
  installService: 'setup.thisComputer.installService',
  startService: 'setup.thisComputer.startService',
  restartService: 'setup.thisComputer.restartService',
  pathExposure: 'setup.thisComputer.pathExposure',
} as const;

function isParseableUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new systemTasks.SystemTaskExecutionError('cancelled', 'System task execution was cancelled.');
  }
}

function readApproval(answer: unknown): boolean {
  return Boolean(answer && typeof answer === 'object' && (answer as { approved?: unknown }).approved === true);
}

/**
 * The fixed refusal code the app answered a prompt with, or `null` when it named none.
 *
 * Unattended approval refuses silently by design (a wrong relay, an override CLI, an account that
 * is not the one being set up), so without the code the user sees only "not approved". Only a
 * `snake_case` token is accepted: the answer crosses the app bridge, and an error message must
 * never become a channel for arbitrary text.
 */
function readRefusalReason(answer: unknown): string | null {
  const reason = answer && typeof answer === 'object' ? (answer as { reason?: unknown }).reason : null;
  return typeof reason === 'string' && /^[a-z0-9_]{1,64}$/.test(reason) ? reason : null;
}

/**
 * The one executor that makes this computer ready for the relay the app selected (R9/INV1).
 *
 * Order (R12): validate the explicit target → ensure a trusted, floor-compatible CLI →
 * preview the service install and obtain consent before any mutation → configure the relay →
 * validate credentials for that relay → pair (or claim with `--replace-existing` on an account
 * mismatch) → install/start/restart through the CLI service owner. Readiness is proven by the
 * ambient `runtimeConvergence` read afterwards, never by this result (INV8).
 */
export function createSetupThisComputerKind(
  overrides: SetupThisComputerDepsInput,
): InteractiveSystemTaskKind<SetupThisComputerResult> {
  const deps = createSetupThisComputerDeps(overrides);

  return {
    async run(ctx: InteractiveSystemTaskContext): Promise<SetupThisComputerResult> {
      const params = parseSetupThisComputerParams(ctx.params);
      const ring = params.releaseRing;

      ctx.emit({ type: 'progress', stepId: STEP.ensureCli, message: 'Preparing the Happier command line' });
      const cli = await deps.ensureCli({ releaseRing: ring });
      throwIfCancelled(ctx.signal);

      ctx.emit({ type: 'progress', stepId: STEP.inspectService, message: 'Checking the background service' });
      const preview = await deps.previewServiceInstall(ring, cli);
      if (preview.installConflict?.blocking) {
        throw new systemTasks.SystemTaskExecutionError('service_install_blocked', preview.installConflict.message);
      }
      const applyFlags: ServiceInstallApplyFlags = {
        replaceExisting: preview.installConflict !== null,
        takeover: preview.takeover !== null,
      };
      if (applyFlags.replaceExisting || applyFlags.takeover) {
        const answer = await ctx.prompt({
          kind: SETUP_SERVICE_CONSENT_PROMPT_KIND,
          stepId: STEP.serviceConsent,
          message: 'Allow Happier to take over the existing background service on this computer?',
          data: createSetupServiceConsentPromptData({
            takeover: preview.takeover,
            message: preview.installConflict?.message ?? null,
            competingServices: preview.installConflict?.competingServices ?? [],
            servicesToRemove: preview.installConflict?.servicesToRemove ?? [],
          }),
        });
        if (!readApproval(answer)) {
          throw new systemTasks.SystemTaskExecutionError(
            'service_consent_declined',
            'Setup stopped before changing anything: the existing background service was left as it is.',
          );
        }
      }
      throwIfCancelled(ctx.signal);

      // PATH exposure is ancillary (R6): once the managed CLI exists and consent is settled it runs
      // beside the remaining service work, and nothing waits for it — the app starts its readiness
      // proof from this task's result, so awaiting a shell-profile write would hold the reveal
      // behind it.
      //
      // Its failure is reported on the run's own event stream, but only while there is still a line
      // the app will read: the desktop bridge stops reading hsetup's stdout at the result line
      // (`apps/ui/src-tauri/src/system_tasks/mod.rs:191-199`), and hsetup's stderr is surfaced only
      // when the executor dies without a result. So the outcome is emitted just before the result
      // if it has settled by then (the common case — a profile append against seconds of pairing
      // and service work), and otherwise not at all: machine settings › Terminal reads and repairs
      // PATH through the `cli.pathExposure.*` kinds, which is the surface that owns it either way.
      const pathExposure = cli.provenance === 'managed'
        ? observePathExposure(deps.ensurePathExposure({ releaseRing: ring }))
        : null;

      ctx.emit({ type: 'progress', stepId: STEP.configureRelay, message: 'Pointing this computer at your relay' });
      const observedBeforeRelay = await deps.readDaemonStatus(ring, cli);
      throwIfCancelled(ctx.signal);
      const configured = await deps.configureRelay(ring, {
        serverUrl: params.activeRelayUrl,
        webappUrl: params.activeWebappUrl,
        localServerUrl: params.activeLocalRelayUrl,
      }, cli);
      const relayChanged = observedBeforeRelay.serverComparableKey !== configured.comparableKey;
      throwIfCancelled(ctx.signal);

      ctx.emit({ type: 'progress', stepId: STEP.checkAuth, message: 'Checking this computer\'s sign-in' });
      const authStatus = await deps.readAuthStatus(ring, cli);
      throwIfCancelled(ctx.signal);
      const sameAccount = authStatus.authenticated && authStatus.accountId === params.expectedAccountId;
      let machineId = sameAccount ? authStatus.machineId : null;
      let credentialsChanged = false;

      if (!machineId) {
        const request = await deps.requestAuthPairing(ring, cli);
        if (!sameAccount) {
          // Public material only (A2/INV2): the terminal public key, the relay and server identity
          // the app sent, and the CLI's pairing requirement (`compatible` or `v3`).
          const answer = await ctx.prompt({
            kind: SETUP_PAIRING_PROMPT_KIND,
            stepId: STEP.authRequest,
            message: 'Approve this computer in Happier to continue',
            data: createSetupPairingPromptData({
              publicKeyB64Url: request.publicKeyB64Url,
              // The builder strips any userinfo before this reaches an event (INV2).
              relayUrl: params.activeRelayUrl,
              // The key the CLI ended up configured for, not an echo of the spec: the app refuses
              // to approve a CLI that is pointed somewhere else (INV2).
              serverIdentityKey: configured.comparableKey,
              // The account this run is for, so the app can refuse to seal its content key for a
              // pairing that belongs to a different account (INV2).
              accountId: params.expectedAccountId,
              pairingRequirement: request.pairingRequirement,
              cliProvenance: cli.provenance,
              // The command this run actually resolved. When the desktop install path did not
              // place it, the app shows this verbatim to the person asked to vouch for it.
              cliCommand: cli.command,
            }),
          });
          if (!readApproval(answer)) {
            const reason = readRefusalReason(answer);
            throw new systemTasks.SystemTaskExecutionError(
              'pairing_declined',
              reason
                ? `This computer was not approved for pairing (${reason}).`
                : 'This computer was not approved for pairing.',
            );
          }
        }
        throwIfCancelled(ctx.signal);

        // A freshly approved pairing must be claimed even when a credentials file already exists
        // for another account or was rejected by the relay (`auth status` reports both as not
        // authenticated). `--replace-existing` only skips `auth wait`'s early return, so it is a
        // no-op when no file exists. The same account with no machine id keeps the early return:
        // that path returns the credentials already on disk and only registers the machine id, so
        // nothing the running daemon holds changed and it must not be restarted for it.
        ctx.emit({ type: 'progress', stepId: STEP.authWait, message: 'Finishing the pairing' });
        const claim = await deps.waitForAuthPairing(ring, {
          publicKey: request.publicKey,
          replaceExisting: !sameAccount,
        }, cli);
        if (!claim.machineId) {
          throw new systemTasks.SystemTaskExecutionError(
            'machine_id_unavailable',
            'Authenticated Relay session did not expose a machineId for this computer.',
          );
        }
        machineId = claim.machineId;
        credentialsChanged = !sameAccount;
      }
      throwIfCancelled(ctx.signal);

      const serviceAction = resolveServiceAction({
        observed: observedBeforeRelay,
        changed: relayChanged || credentialsChanged,
      });
      // The apply is the other half of the consent (R12/INV9). `install` is the CLI's idempotent
      // convergence command — it re-evaluates the conflict immediately before mutating and returns
      // early when the exact target is already converged — so whenever the dry-run demanded consent
      // it must run even though a definition already exists: that is precisely the case where the
      // approved `--replace-existing`/`--takeover` has something to remove or take over. Leaving it
      // to the start path's best-effort drift refresh would drop the removal the user approved.
      if (serviceAction === 'install' || applyFlags.replaceExisting || applyFlags.takeover) {
        ctx.emit({ type: 'progress', stepId: STEP.installService, message: 'Installing the background service' });
        await deps.installService(ring, applyFlags, cli);
        throwIfCancelled(ctx.signal);
      }
      ctx.emit({
        type: 'progress',
        stepId: serviceAction === 'restart' ? STEP.restartService : STEP.startService,
        message: serviceAction === 'restart' ? 'Restarting the background service' : 'Starting the background service',
      });
      await deps.startService(ring, {
        action: serviceAction === 'restart' ? 'restart' : 'start',
        takeover: applyFlags.takeover,
      }, cli);
      // Cancellation stops the run, it does not undo it (INV11): whatever the CLI already installed
      // or started stays discoverable for the next run to converge on, but an abandoned run must
      // not report success.
      throwIfCancelled(ctx.signal);

      const pathExposureFailure = pathExposure?.readFailure() ?? null;
      if (pathExposureFailure) {
        ctx.emit({
          type: 'progress',
          stepId: STEP.pathExposure,
          message: `Could not add happier to your PATH: ${pathExposureFailure}`,
        });
      }

      return {
        machineId,
        cliProvenance: cli.provenance,
        cliVersion: cli.version,
        relayChanged,
        credentialsChanged,
        serviceAction,
      };
    },
  };
}

type SettledPathExposure = Readonly<{ readFailure: () => string | null }>;

/**
 * Watches an unawaited PATH exposure so the run can report its failure if it finished in time,
 * without ever waiting for it. `readFailure()` answers `null` while it is still in flight — there
 * is nothing to report yet, and by the result line there is no longer anywhere to report it.
 */
function observePathExposure(exposure: Promise<PathExposureOutcome>): SettledPathExposure {
  let failure: string | null = null;
  void exposure.then(
    (outcome) => {
      failure = outcome.failure;
    },
    (error: unknown) => {
      failure = error instanceof Error && error.message.trim() ? error.message.trim() : 'PATH exposure failed.';
    },
  );
  return { readFailure: () => failure };
}

/**
 * Executor-owned lifecycle decision (E3): the CLI executes install/start/restart, the executor
 * chooses which one because it knows what it just changed.
 */
function resolveServiceAction(params: Readonly<{
  observed: ServiceLifecycleObservation;
  changed: boolean;
}>): SetupThisComputerServiceAction {
  if (!params.observed.serviceInstalled) {
    return 'install';
  }
  if (params.observed.daemonRunning && params.changed) {
    return 'restart';
  }
  return 'start';
}

export function parseSetupThisComputerParams(params: unknown): SetupThisComputerParams {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw new systemTasks.SystemTaskExecutionError('invalid_params', 'Expected setup params to be an object.');
  }
  const record = params as Record<string, unknown>;
  const readRequired = (key: 'activeRelayUrl' | 'activeWebappUrl' | 'expectedAccountId'): string => {
    const value = typeof record[key] === 'string' ? record[key].trim() : '';
    if (!value) {
      throw new systemTasks.SystemTaskExecutionError('invalid_params', `${key} is required.`);
    }
    return value;
  };
  const activeRelayUrl = readRequired('activeRelayUrl');
  const activeWebappUrl = readRequired('activeWebappUrl');
  const expectedAccountId = readRequired('expectedAccountId');
  for (const [key, value] of [['activeRelayUrl', activeRelayUrl], ['activeWebappUrl', activeWebappUrl]] as const) {
    if (!isParseableUrl(value)) {
      throw new systemTasks.SystemTaskExecutionError('invalid_params', `${key} must be a valid URL.`);
    }
  }

  const channel = typeof record.channel === 'string' ? record.channel.trim().toLowerCase() : '';
  if (!ACCEPTED_BOOTSTRAP_CHANNELS.includes(channel)) {
    throw new systemTasks.SystemTaskExecutionError(
      'invalid_params',
      `channel must be one of ${ACCEPTED_BOOTSTRAP_CHANNELS.join(', ')}.`,
    );
  }

  const localRaw = record.activeLocalRelayUrl;
  const activeLocalRelayUrl = localRaw === null || localRaw === undefined
    ? null
    : typeof localRaw === 'string' && localRaw.trim()
      ? localRaw.trim()
      : null;
  if (activeLocalRelayUrl && !isParseableUrl(activeLocalRelayUrl)) {
    throw new systemTasks.SystemTaskExecutionError('invalid_params', 'activeLocalRelayUrl must be a valid URL when provided.');
  }

  const surface = typeof record.surface === 'string' && record.surface.trim() ? record.surface.trim() : undefined;

  return {
    activeRelayUrl,
    activeWebappUrl,
    activeLocalRelayUrl,
    releaseRing: normalizeBootstrapChannel(channel).releaseChannel,
    expectedAccountId,
    ...(surface ? { surface } : {}),
  };
}

/** Production PATH exposure: edits the user's shell startup files, so it is wired explicitly. */
export async function ensureManagedCliPathExposureDefault(params: Readonly<{ releaseRing: PublicReleaseRingId }>): Promise<PathExposureOutcome> {
  const layout = resolveFirstPartyInstallLayout({
    componentId: 'happier-cli',
    releaseRing: params.releaseRing,
    processEnv: process.env,
  });
  return await ensureHappierCliPathExposure({ binDir: layout.shimDir, processEnv: process.env });
}

function createSetupThisComputerDeps(overrides: SetupThisComputerDepsInput): SetupThisComputerDeps {
  return {
    ...overrides,
    previewServiceInstall: overrides.previewServiceInstall ?? previewServiceInstall,
    readAuthStatus: overrides.readAuthStatus ?? readAuthStatus,
    readDaemonStatus: overrides.readDaemonStatus ?? readDaemonStatus,
  };
}
