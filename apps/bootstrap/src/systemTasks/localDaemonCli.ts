import { systemTasks } from '@happier-dev/cli-common';
import { DoctorSnapshotDaemonStatusSchema, type DoctorSnapshotDaemonStatus } from '@happier-dev/protocol';
import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import {
  readLocalHappierCliChoiceFacts,
  resolveLocalHappierCliReleaseRing,
  resolveVersionedLocalHappierCli,
  runLocalHappierJsonCommand,
  type LocalHappierCliChoiceFacts,
  type SetupCapableLocalHappierCli,
} from './happierCli.js';
import type { LocalFirstPartyCommandProvenance } from './localFirstPartyCommand.js';

export type RelayProfileTarget = Readonly<{
  serverUrl: string;
  webappUrl: string;
  localServerUrl: string | null;
}>;

export type ConfiguredRelay = Readonly<{
  serverUrl: string;
  comparableKey: string;
}>;

export type AuthStatusSnapshot = Readonly<{
  authenticated: boolean;
  accountId: string | null;
  /** The label the relay's profile gave the validated account; absent when it gave none. */
  accountLabel?: string | null;
  machineId: string | null;
}>;

export type DaemonCredentialState = 'missing' | 'rejected' | 'valid' | 'unknown';

/**
 * Whether the installed background service follows the default relay or is pinned to one relay
 * profile — the CLI's own vocabulary (`DaemonServiceTargetMode`). A reader that cannot see this
 * cannot tell "a service is installed" apart from "a service this app may repoint on its own".
 */
export type DaemonServiceTargetMode = 'pinned' | 'default-following';

/**
 * Whether the installed background service starts the daemon at login — the CLI's own
 * `DaemonServiceAutostartMode` vocabulary (`apps/cli/src/daemon/service/plan.ts`), not a boolean.
 * A boolean cannot express UNKNOWN, and this seam needs unknown: a CLI that reports no mode must
 * not be read as "off" and taken off the air, nor as "on" and claimed available.
 */
export type DaemonServiceAutostartMode = 'at-login' | 'on-demand';

/**
 * What the running daemon is doing, as the CLI derived it from its authenticated control
 * endpoint and owner evaluation. `null` when the CLI that answered predates the block.
 */
export type DaemonRuntimeConvergence = Readonly<{
  controlReachable: boolean;
  serviceOwnsRunningDaemon: boolean;
  machineIdMatches: boolean;
  cliVersionMatches: boolean;
}>;

/**
 * The ambient inspection. The flat fields are the long-standing summary; the nested blocks
 * carry every fact `happier daemon status --json` emitted, plus which CLI answered.
 */
export type DaemonStatusSnapshot = Readonly<{
  serviceInstalled: boolean;
  daemonRunning: boolean;
  needsAuth: boolean;
  machineId: string | null;
  serverComparableKey: string | null;
  acquisition: Readonly<{
    command: string;
    provenance: LocalFirstPartyCommandProvenance;
    /** The version that CLI reports for itself, so a reader can tell which contract answered. */
    version: string;
    /**
     * The release channel whose managed CLI this is — the default channel's when the app adopted
     * it (D2), else the app's own. `null` for an override CLI, which belongs to no channel.
     */
    channel: PublicReleaseRingId | null;
  }>;
  server: Readonly<{
    activeServerId: string | null;
    serverUrl: string | null;
    publicServerUrl: string | null;
    localServerUrl: string | null;
    comparableKey: string | null;
  }>;
  auth: Readonly<{
    authenticated: boolean;
    machineRegistered: boolean;
    machineId: string | null;
    needsAuth: boolean;
    accountId: string | null;
    credentialState: DaemonCredentialState | null;
    validatedAccountId: string | null;
    /** The validated account's readable name (username, else display name); `null` when unknown. */
    accountLabel: string | null;
  }>;
  service: Readonly<{
    installed: boolean;
    running: boolean;
    /** `null` when nothing proved a mode — an older CLI, or no readable definition. Never a default. */
    targetMode: DaemonServiceTargetMode | null;
    /**
     * The autostart mode the installed definition declares. `null` when the CLI that answered
     * does not report one, so a desktop toggle shows "unknown" instead of claiming the user's
     * computer will stop answering after they close the app.
     */
    autostart: DaemonServiceAutostartMode | null;
  }>;
  daemon: Readonly<{
    running: boolean;
    startedWithCliVersion: string | null;
    serviceManaged: boolean | null;
    serviceLabel: string | null;
  }>;
  runtimeConvergence: DaemonRuntimeConvergence | null;
  cli: Readonly<{
    /**
     * The answering CLI's update state from its cached daily check (plan R17/K1). `managed` says
     * whether this app's install path placed that CLI (`acquisition.provenance`), i.e. whether the
     * app may update it in place (`cli.update.v1`). `null` when the CLI cached no check yet or
     * predates the field.
     */
    update: DaemonCliUpdateState | null;
    /**
     * R12 — this computer's one-CLI answer and the CLI that is not the managed one (the kept CLI,
     * or an old copy still on PATH), with the commands that remove or update it. Read from the
     * app's own records, not the answering CLI, so any CLI version reports it.
     */
    choice: LocalHappierCliChoiceFacts;
  }>;
}>;

export type DaemonCliUpdateState = Readonly<{
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  managed: boolean;
}>;

export type AuthPairingRequest = Readonly<{
  publicKey: string;
  publicKeyB64Url: string;
  pairingRequirement: string;
}>;

export type AuthPairingClaim = Readonly<{
  machineId: string | null;
}>;

/**
 * The structured answer of `happier daemon service install --dry-run --json` (the `service …`
 * alias runs the same command), as bootstrap consumes it. Every ownership/conflict decision stays
 * inside the CLI: bootstrap only reads whether the intended apply would take over a manual daemon
 * or replace competing services (consent), or is blocked outright.
 */
export type ServiceInstallPreview = Readonly<{
  takeover: string | null;
  installConflict: Readonly<{
    blocking: boolean;
    message: string;
    competingServices: readonly string[];
    servicesToRemove: readonly string[];
    /** The installed service runs another CLI and installing switches it to the managed one (K3). */
    runtimeReplacement: Readonly<{ current: string; replacement: string }> | null;
  }> | null;
}>;

export type ServiceInstallApplyFlags = Readonly<{
  replaceExisting: boolean;
  takeover: boolean;
}>;

const DEFAULT_DAEMON_READY_TIMEOUT_MS = 15_000;
const DEFAULT_DAEMON_READY_POLL_MS = 500;

/**
 * A resolved CLI and the environment a command spawns it with. Every command this module issues
 * answers for "this computer" under one context rule (plan R13 a): without `processEnv` it runs with
 * the inherited relay selectors cleared (`createSelectedCliInvocation`), so the app's status reads,
 * the service toggle, `cli.update.v1` and a setup run's apply all address this Happier home's
 * persisted selection — the relay setup writes and the background service serves. Only a setup
 * scope's `target` invocation carries an explicit environment.
 */
export type LocalHappierCliInvocation = SetupCapableLocalHappierCli & Readonly<{
  processEnv?: NodeJS.ProcessEnv;
}>;

/**
 * The one execution context of a setup run (plan R13 a), built once from the target relay the app
 * selected and threaded through every command the run issues.
 *
 * A stack/dev launch exports a server selection of its own — `HAPPIER_ACTIVE_SERVER_ID` (the CLI's
 * configuration prefers that persisted profile over a URL it does not match),
 * `HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID` (where daemon state is read) and the URL selectors — so an
 * inherited selector would let a run judge relay Y and then write to relay X. Both invocations
 * clear every one of them:
 *
 * - `target` adds the target through the CLI's env server selection without persisting it, for
 *   the reads that must answer for the target before the run may select it (service-install
 *   dry-run, the target's saved credentials).
 * - `selected` answers for the relay this Happier home's persisted selection names — before
 *   `server set`, the relay the default-following service serves; from `server set` on, the target
 *   — which is exactly what the background service itself reads.
 */
export type SetupCliScope = Readonly<{
  target: LocalHappierCliInvocation;
  selected: LocalHappierCliInvocation;
}>;

const INHERITED_RELAY_SELECTOR_ENV_KEYS = [
  'HAPPIER_SERVER_URL',
  'HAPPIER_WEBAPP_URL',
  'HAPPIER_LOCAL_SERVER_URL',
  'HAPPIER_PUBLIC_SERVER_URL',
  'HAPPIER_ACTIVE_SERVER_ID',
  'HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID',
] as const;

function clearInheritedRelaySelectors(processEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const selectedEnv: NodeJS.ProcessEnv = { ...processEnv };
  for (const key of INHERITED_RELAY_SELECTOR_ENV_KEYS) {
    delete selectedEnv[key];
  }
  return selectedEnv;
}

/**
 * The `selected` half of a setup scope on its own: `cli` with every inherited relay selector
 * cleared, so it answers for this Happier home's persisted selection — the relay the background
 * service itself serves. It is also what every invocation without an explicit env runs with.
 */
export function createSelectedCliInvocation(params: Readonly<{
  cli: SetupCapableLocalHappierCli;
  processEnv: NodeJS.ProcessEnv;
}>): LocalHappierCliInvocation {
  return { ...params.cli, processEnv: clearInheritedRelaySelectors(params.processEnv) };
}

/**
 * The `target` half's environment on its own: the inherited relay selectors cleared and `target`
 * added through the CLI's env server selection, nothing persisted. For a command that names its
 * relay but lets `runLocalHappierJsonCommand` resolve the CLI (the remote-bootstrap approval).
 */
export function scopeProcessEnvToTargetRelay(target: RelayProfileTarget, processEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...clearInheritedRelaySelectors(processEnv),
    HAPPIER_SERVER_URL: target.serverUrl,
    HAPPIER_WEBAPP_URL: target.webappUrl,
    ...(target.localServerUrl ? { HAPPIER_LOCAL_SERVER_URL: target.localServerUrl } : {}),
  };
}

export function createSetupCliScope(params: Readonly<{
  cli: SetupCapableLocalHappierCli;
  target: RelayProfileTarget;
  processEnv: NodeJS.ProcessEnv;
}>): SetupCliScope {
  return {
    target: { ...params.cli, processEnv: scopeProcessEnvToTargetRelay(params.target, params.processEnv) },
    selected: createSelectedCliInvocation(params),
  };
}

/**
 * Runs one JSON command through `invocation`'s CLI and environment — this process's environment
 * with the inherited relay selectors cleared when the invocation names none (one context rule).
 */
async function runInvocationJsonCommand(params: Readonly<{
  args: readonly string[];
  releaseRing: PublicReleaseRingId;
  invocation?: LocalHappierCliInvocation;
  allowJsonFailure?: boolean;
}>): Promise<unknown> {
  return await runLocalHappierJsonCommand({
    args: params.args,
    releaseRing: params.releaseRing,
    ...(params.invocation ? { cli: params.invocation } : {}),
    processEnv: params.invocation?.processEnv ?? clearInheritedRelaySelectors(process.env),
    ...(params.allowJsonFailure ? { allowJsonFailure: true } : {}),
  });
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * A boolean the CLI's JSON contract has always emitted. Coercing a missing or wrongly typed one to
 * `false` would read corrupt output as "no service, no daemon, no credentials" — the state setup
 * answers by installing and re-pairing — so the value is required rather than defaulted.
 */
function readRequiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new systemTasks.SystemTaskExecutionError(
      'invalid_cli_response',
      `CLI response is missing a boolean "${field}".`,
    );
  }
  return value;
}

export async function readAuthStatus(
  releaseRing: PublicReleaseRingId,
  cli?: LocalHappierCliInvocation,
): Promise<AuthStatusSnapshot> {
  const parsed = await runInvocationJsonCommand({
    args: ['auth', 'status', '--json'],
    releaseRing,
    allowJsonFailure: true,
    invocation: cli,
  });
  if (!parsed || typeof parsed !== 'object') {
    throw new systemTasks.SystemTaskExecutionError('invalid_cli_response', 'Received an invalid auth status response.');
  }

  const record = parsed as {
    ok?: boolean;
    error?: { code?: unknown };
    data?: {
      authenticated?: unknown;
      accountId?: unknown;
      accountLabel?: unknown;
      machineId?: unknown;
    };
  };

  if (record.ok === false) {
    const errorCode = typeof record.error?.code === 'string' ? record.error.code.trim() : '';
    if (errorCode === 'not_authenticated') {
      return {
        authenticated: false,
        accountId: null,
        machineId: null,
      };
    }
    throw new systemTasks.SystemTaskExecutionError(
      errorCode || 'auth_status_unavailable',
      'Could not determine authentication status for the selected Relay.',
    );
  }

  // Not defaulted to "not authenticated": the executor answers that state by requesting a pairing
  // and claiming it with `--replace-existing`, which rewrites credentials and restarts the daemon.
  const authenticated = readRequiredBoolean(record.data?.authenticated, 'data.authenticated');
  const accountId = readNonEmptyString(record.data?.accountId);
  if (authenticated && !accountId) {
    throw new systemTasks.SystemTaskExecutionError(
      'invalid_cli_response',
      'Auth status reported authenticated credentials without the account they belong to.',
    );
  }

  return {
    authenticated,
    accountId,
    accountLabel: readNonEmptyString(record.data?.accountLabel),
    machineId: readNonEmptyString(record.data?.machineId),
  };
}

export async function configureRelay(
  releaseRing: PublicReleaseRingId,
  profile: RelayProfileTarget,
  cli?: LocalHappierCliInvocation,
): Promise<ConfiguredRelay> {
  const parsed = await runInvocationJsonCommand({
    args: [
      'server',
      'set',
      '--server-url',
      profile.serverUrl,
      ...(profile.localServerUrl ? ['--local-server-url', profile.localServerUrl] : []),
      '--webapp-url',
      profile.webappUrl,
      '--json',
    ],
    releaseRing,
    invocation: cli,
  });
  const active = parsed && typeof parsed === 'object'
    ? (parsed as { data?: { active?: { serverUrl?: unknown; comparableKey?: unknown } } }).data?.active
    : undefined;
  const serverUrl = readNonEmptyString(active?.serverUrl);
  const comparableKey = readNonEmptyString(active?.comparableKey);
  if (!serverUrl || !comparableKey) {
    throw new systemTasks.SystemTaskExecutionError('invalid_cli_response', 'Received an invalid server set response.');
  }
  return { serverUrl, comparableKey };
}

export async function requestAuthPairing(
  releaseRing: PublicReleaseRingId,
  cli?: LocalHappierCliInvocation,
): Promise<AuthPairingRequest> {
  const parsed = await runInvocationJsonCommand({ args: ['auth', 'request', '--json'], releaseRing, invocation: cli });
  const record = parsed && typeof parsed === 'object'
    ? (parsed as { publicKey?: unknown; publicKeyB64Url?: unknown; pairingRequirement?: unknown })
    : {};
  const publicKey = readNonEmptyString(record.publicKey);
  const publicKeyB64Url = readNonEmptyString(record.publicKeyB64Url);
  const pairingRequirement = readNonEmptyString(record.pairingRequirement);
  if (!publicKey || !publicKeyB64Url || !pairingRequirement) {
    throw new systemTasks.SystemTaskExecutionError('invalid_cli_response', 'Received an invalid auth request response.');
  }
  return { publicKey, publicKeyB64Url, pairingRequirement };
}

export async function waitForAuthPairing(
  releaseRing: PublicReleaseRingId,
  params: Readonly<{ publicKey: string; replaceExisting: boolean }>,
  cli?: LocalHappierCliInvocation,
): Promise<AuthPairingClaim> {
  let parsed: unknown;
  try {
    parsed = await runInvocationJsonCommand({
      args: [
        'auth',
        'wait',
        '--public-key',
        params.publicKey,
        ...(params.replaceExisting ? ['--replace-existing'] : []),
        '--json',
      ],
      releaseRing,
      invocation: cli,
    });
  } catch (error) {
    if (error instanceof systemTasks.SystemTaskExecutionError && error.code === 'cli_command_timeout') {
      throw new systemTasks.SystemTaskExecutionError(
        'pairing_claim_timeout',
        'The approved pairing was not claimed in time. Run setup again to retry.',
      );
    }
    throw error;
  }
  const machineId = parsed && typeof parsed === 'object'
    ? readNonEmptyString((parsed as { machineId?: unknown }).machineId)
    : null;
  return { machineId };
}

function readServiceLabels(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (entry && typeof entry === 'object' ? readNonEmptyString((entry as { label?: unknown }).label) : null))
    .filter((label): label is string => label !== null);
}

function readRuntimeReplacement(value: unknown): Readonly<{ current: string; replacement: string }> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as { current?: unknown; replacement?: unknown };
  const current = readNonEmptyString(record.current);
  const replacement = readNonEmptyString(record.replacement);
  return current && replacement ? { current, replacement } : null;
}

/**
 * The one argv for `daemon service install` — the CLI's idempotent convergence command, which is
 * also how the autostart mode is applied. A second builder would let the two drift in the flags
 * they pass to the same command.
 */
function buildServiceInstallArgs(params: Readonly<{
  flags?: ServiceInstallApplyFlags;
  autostart?: DaemonServiceAutostartMode;
}> = {}): string[] {
  return [
    'daemon',
    'service',
    'install',
    ...(params.flags?.replaceExisting ? ['--yes', '--replace-existing=all'] : []),
    ...(params.flags?.takeover ? ['--takeover'] : []),
    ...(params.autostart ? [`--autostart=${params.autostart}`] : []),
    '--json',
  ];
}

/**
 * Preview the most complete apply desktop setup may perform (replace competing services, take
 * over a manual daemon). Each of those effects only appears in the response when the CLI would
 * actually perform it, so the response tells the executor exactly what needs consent.
 *
 * Setup previews before `server set` (no mutation before consent), so it passes its scope's
 * `target` invocation: ownership and takeover are per-relay facts, and judging them against the
 * CLI's previous relay would block on a pinned service that does not conflict, or ask to take over
 * a manual daemon the apply can never reach.
 */
export async function previewServiceInstall(
  releaseRing: PublicReleaseRingId,
  cli?: LocalHappierCliInvocation,
): Promise<ServiceInstallPreview> {
  const parsed = await runInvocationJsonCommand({
    args: [...buildServiceInstallArgs({ flags: { replaceExisting: true, takeover: true } }), '--dry-run'],
    releaseRing,
    allowJsonFailure: true,
    invocation: cli,
  });
  if (!parsed || typeof parsed !== 'object') {
    throw new systemTasks.SystemTaskExecutionError('invalid_cli_response', 'Received an invalid service install preview.');
  }
  const record = parsed as {
    ok?: unknown;
    error?: unknown;
    message?: unknown;
    plan?: unknown;
    takeover?: unknown;
    installConflict?: {
      blocking?: unknown;
      message?: unknown;
      competingServices?: unknown;
      servicesToRemove?: unknown;
      runtimeReplacement?: unknown;
    } | null;
  };
  if (record.ok === false) {
    throw new systemTasks.SystemTaskExecutionError(
      readNonEmptyString(record.error) ?? 'service_install_blocked',
      readNonEmptyString(record.message) ?? 'The background service cannot be installed on this computer right now.',
    );
  }
  if (!record.plan || typeof record.plan !== 'object') {
    throw new systemTasks.SystemTaskExecutionError('invalid_cli_response', 'Received an invalid service install preview.');
  }

  const conflict = record.installConflict;
  if (conflict !== undefined && conflict !== null) {
    if (typeof conflict !== 'object' || typeof conflict.blocking !== 'boolean' || !readNonEmptyString(conflict.message)) {
      throw new systemTasks.SystemTaskExecutionError('invalid_cli_response', 'Received an invalid service install conflict description.');
    }
  }

  return {
    takeover: readNonEmptyString(record.takeover),
    installConflict: conflict
      ? {
          blocking: conflict.blocking === true,
          message: String(conflict.message).trim(),
          competingServices: readServiceLabels(conflict.competingServices),
          servicesToRemove: readServiceLabels(conflict.servicesToRemove),
          runtimeReplacement: readRuntimeReplacement(conflict.runtimeReplacement),
        }
      : null,
  };
}

export async function installService(
  releaseRing: PublicReleaseRingId,
  flags: ServiceInstallApplyFlags,
  cli?: LocalHappierCliInvocation,
): Promise<void> {
  await runInvocationJsonCommand({ args: buildServiceInstallArgs({ flags }), releaseRing, invocation: cli });
}

/**
 * The one invoker of the service lifecycle verbs. `stop` joined `start`/`restart` when desktop
 * gained a background-service toggle: with login start off the app stops the daemon as it quits,
 * and it must stop it through the same command the CLI already owns rather than a second path.
 */
export async function controlDaemonService(
  releaseRing: PublicReleaseRingId,
  params: Readonly<{ action: 'start' | 'stop' | 'restart'; takeover: boolean }>,
  cli?: LocalHappierCliInvocation,
): Promise<void> {
  await runInvocationJsonCommand({
    args: ['daemon', 'service', params.action, ...(params.takeover ? ['--takeover'] : []), '--json'],
    releaseRing,
    invocation: cli,
  });
}

/**
 * The autostart mode of the installed service, expressed through the command that already owns
 * the service definition (`install` is the CLI's idempotent convergence path) and through the
 * flag that command parses. Bootstrap states the intent and re-reads the result; every platform
 * rule stays inside the CLI (INV9).
 */
export async function setDaemonServiceAutostart(
  releaseRing: PublicReleaseRingId,
  autostart: DaemonServiceAutostartMode,
  cli?: LocalHappierCliInvocation,
): Promise<void> {
  await runInvocationJsonCommand({
    args: buildServiceInstallArgs({ autostart }),
    releaseRing,
    invocation: cli,
  });
}

/**
 * `happier daemon status --json` prints exactly the doctor snapshot's daemon-status block
 * (`readDaemonStatusSnapshot` is typed from it), so the protocol schema that already owns that
 * wire shape is the parser. One validation, one failure behaviour: corrupt output fails by field
 * name instead of degrading into "no service, no daemon, not authenticated" — the facts that make
 * the app start an installing, re-pairing setup run.
 *
 * Every released 0.2 CLI emits this shape; the fields added since (targetMode, autostart,
 * credentialState, validatedAccountId, runtimeConvergence) are optional in the schema, so an older
 * CLI parses and reports them as unknown.
 */
function parseDaemonStatusResponse(parsed: unknown): DoctorSnapshotDaemonStatus {
  const result = DoctorSnapshotDaemonStatusSchema.safeParse(parsed);
  if (result.success) {
    return result.data;
  }
  const issue = result.error.issues[0];
  const field = issue?.path.join('.') ?? '';
  throw new systemTasks.SystemTaskExecutionError(
    'invalid_cli_response',
    field
      ? `Daemon status response is invalid at "${field}": ${issue?.message ?? 'unexpected value'}.`
      : 'Received an invalid daemon status response.',
  );
}

/**
 * The ambient inspection. `cli` is the CLI a caller already resolved; pass it when the same caller
 * reads status more than once so the acquisition and version read happen once for that run. Like
 * every command here it answers for this home's persisted selection, never a launch's pinned relay,
 * so the app proves ready exactly the relay setup wrote.
 *
 * Absent optional facts are projected to `null` rather than left off: the result crosses to the
 * app, where "the CLI that answered proved no mode" has to be a value a reader can see.
 */
export async function readDaemonStatus(
  releaseRing: PublicReleaseRingId,
  cli?: LocalHappierCliInvocation,
): Promise<DaemonStatusSnapshot> {
  const resolvedCli: LocalHappierCliInvocation = cli ?? await resolveVersionedLocalHappierCli({ releaseRing });
  const parsed = await runInvocationJsonCommand({ args: ['daemon', 'status', '--json'], releaseRing, invocation: resolvedCli });
  const status = parseDaemonStatusResponse(parsed);

  return {
    serviceInstalled: status.service.installed,
    daemonRunning: status.daemon.running,
    needsAuth: status.auth.needsAuth,
    machineId: status.auth.machineId,
    serverComparableKey: status.server.comparableKey,
    acquisition: {
      command: resolvedCli.command,
      provenance: resolvedCli.provenance,
      version: resolvedCli.version,
      channel: resolvedCli.provenance === 'managed'
        ? resolveLocalHappierCliReleaseRing({ appRing: releaseRing, processEnv: process.env })
        : null,
    },
    server: {
      activeServerId: status.server.activeServerId,
      serverUrl: status.server.serverUrl,
      publicServerUrl: status.server.publicServerUrl,
      localServerUrl: status.server.localServerUrl,
      comparableKey: status.server.comparableKey,
    },
    auth: {
      authenticated: status.auth.authenticated,
      machineRegistered: status.auth.machineRegistered,
      machineId: status.auth.machineId,
      needsAuth: status.auth.needsAuth,
      accountId: status.auth.accountId,
      credentialState: status.auth.credentialState ?? null,
      validatedAccountId: status.auth.validatedAccountId ?? null,
      accountLabel: status.auth.accountLabel ?? null,
    },
    service: {
      installed: status.service.installed,
      running: status.service.running,
      targetMode: status.service.targetMode ?? null,
      autostart: status.service.autostart ?? null,
    },
    daemon: {
      running: status.daemon.running,
      startedWithCliVersion: status.daemon.startedWithCliVersion ?? null,
      serviceManaged: status.daemon.serviceManaged ?? null,
      serviceLabel: status.daemon.serviceLabel ?? null,
    },
    runtimeConvergence: status.runtimeConvergence ?? null,
    cli: {
      update: status.cliUpdate
        ? { ...status.cliUpdate, managed: resolvedCli.provenance === 'managed' }
        : null,
      choice: readLocalHappierCliChoiceFacts(process.env),
    },
  };
}

/**
 * What starting the background service can prove about itself: a service is installed, its daemon
 * answers, and credentials for the configured relay are present.
 *
 * This is deliberately NOT "this computer is ready". Desktop readiness is the CLI-derived
 * `runtimeConvergence` block plus the app's own reachability proof (INV8/INV10) — it also requires
 * that the installed service owns the running daemon, that the machine id and CLI version match,
 * and that the machine answers an RPC. These three flat fields cannot establish any of that, so
 * they are named after the command that produces them and nothing reads them as readiness.
 */
export function isDaemonServiceStarted(status: DaemonStatusSnapshot): boolean {
  return status.serviceInstalled && status.daemonRunning && !status.needsAuth;
}

export async function waitForStartedDaemonService(params: Readonly<{
  readDaemonStatus: () => Promise<DaemonStatusSnapshot>;
  signal: AbortSignal;
}>): Promise<DaemonStatusSnapshot> {
  const timeoutMs = readPositiveIntEnv(
    'HAPPIER_BOOTSTRAP_SETUP_THIS_COMPUTER_SERVICE_READY_TIMEOUT_MS',
    DEFAULT_DAEMON_READY_TIMEOUT_MS,
    { min: 100, max: 120_000 },
  );
  const pollMs = readPositiveIntEnv(
    'HAPPIER_BOOTSTRAP_SETUP_THIS_COMPUTER_SERVICE_READY_POLL_MS',
    DEFAULT_DAEMON_READY_POLL_MS,
    { min: 50, max: 5_000 },
  );

  const deadline = Date.now() + timeoutMs;
  let latest = await params.readDaemonStatus();
  while (!isDaemonServiceStarted(latest) && Date.now() < deadline) {
    await delay(pollMs, params.signal);
    latest = await params.readDaemonStatus();
  }
  return latest;
}

function readPositiveIntEnv(
  envVarName: string,
  fallback: number,
  bounds: Readonly<{ min: number; max: number }>,
): number {
  const rawValue = process.env[envVarName];
  const parsed = typeof rawValue === 'string' ? Number.parseInt(rawValue.trim(), 10) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < bounds.min) {
    return fallback;
  }
  return Math.min(parsed, bounds.max);
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    throw new systemTasks.SystemTaskExecutionError('cancelled', 'System task execution was cancelled.');
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abortHandler);
      resolve();
    }, ms);
    const abortHandler = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abortHandler);
      reject(new systemTasks.SystemTaskExecutionError('cancelled', 'System task execution was cancelled.'));
    };
    signal.addEventListener('abort', abortHandler, { once: true });
  });
}
