import { systemTasks } from '@happier-dev/cli-common';
import { compareVersions, normalizeSemverBase } from '@happier-dev/cli-common/update';
import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import {
  acquireManagedLocalFirstPartyComponentCommand,
  ensureLocalFirstPartyComponentCommand,
  resolveExplicitOrInstalledLocalFirstPartyCommand,
  type LocalFirstPartyCommandAcquisitionDeps,
  type ResolvedLocalFirstPartyCommand,
} from './localFirstPartyCommand.js';
import { CommandTimeoutError, parseFirstJsonObject, runCommandCapture } from './taskRuntime.js';

const DEFAULT_ENV_VAR_NAMES = [
  'HAPPIER_BOOTSTRAP_CLI_PATH',
  'HAPPIER_BOOTSTRAP_HAPPIER_PATH',
] as const;

/**
 * The oldest Happier CLI release desktop setup can drive. Raise it only when setup starts
 * depending on a newer command contract, and say which one in the commit.
 *
 * 0.2.13: `auth status --json` reports `accountId`; `auth wait --replace-existing` claims a
 * pairing for a different account without resetting credentials.
 *
 * Compared on the semver base only, so a preview or dev build of the same base satisfies it.
 */
export const SETUP_CLI_VERSION_FLOOR = '0.2.13';

export type SetupCapableLocalHappierCli = ResolvedLocalFirstPartyCommand & Readonly<{
  version: string;
}>;

function resolveHappierCliParams(params: Readonly<{
  releaseRing: PublicReleaseRingId;
  processEnv: NodeJS.ProcessEnv;
}>) {
  return {
    componentId: 'happier-cli' as const,
    releaseRing: params.releaseRing,
    processEnv: params.processEnv,
    envVarNames: DEFAULT_ENV_VAR_NAMES,
  };
}

export type LocalHappierJsonCommandParams = Readonly<{
  args: readonly string[];
  releaseRing: PublicReleaseRingId;
  processEnv?: NodeJS.ProcessEnv;
  allowJsonFailure?: boolean;
  /**
   * A CLI this caller already resolved through one of the resolvers below. Passing it runs the
   * command against exactly that CLI instead of resolving again, so a caller that issues several
   * commands (or polls one) acquires and version-checks once.
   */
  cli?: ResolvedLocalFirstPartyCommand;
}>;

/**
 * Runs a Happier CLI JSON command. Unless the caller passes a CLI it already resolved, every
 * invocation acquires/installs the managed CLI first, so acquisition is part of running a
 * command rather than a separate step a caller can forget.
 */
export async function runLocalHappierJsonCommand(params: LocalHappierJsonCommandParams): Promise<unknown> {
  const processEnv = params.processEnv ?? process.env;
  const cli = params.cli ?? await ensureLocalFirstPartyComponentCommand(resolveHappierCliParams({
    releaseRing: params.releaseRing,
    processEnv,
  }));
  const { command } = cli;

  const result = await runCommandCapture({
    command,
    args: params.args,
    env: processEnv,
  }).catch((error: unknown) => {
    if (error instanceof CommandTimeoutError) {
      throw new systemTasks.SystemTaskExecutionError('cli_command_timeout', error.message);
    }
    const message = error instanceof Error && error.message.trim()
      ? error.message.trim()
      : 'Failed to spawn Happier CLI.';
    throw new systemTasks.SystemTaskExecutionError('cli_spawn_failed', message);
  });

  const parsed = parseFirstJsonObject(result.stdout);

  if (result.status !== 0) {
    if (params.allowJsonFailure && parsed && typeof parsed === 'object') {
      return parsed;
    }
    throw new systemTasks.SystemTaskExecutionError(
      'cli_command_failed',
      result.stderr.trim() || result.stdout.trim() || `Command failed: ${command}`,
    );
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new systemTasks.SystemTaskExecutionError(
      'invalid_cli_response',
      `Command did not return a JSON object: ${params.args.join(' ')}`,
    );
  }

  if (!params.allowJsonFailure && isJsonFailureEnvelope(parsed)) {
    const envelope = parsed as {
      error?: { code?: unknown; message?: unknown } | unknown;
      message?: unknown;
    };
    const message = typeof envelope.message === 'string' && envelope.message.trim()
      ? envelope.message.trim()
      : envelope.error && typeof envelope.error === 'object' && envelope.error !== null
          && typeof (envelope.error as { message?: unknown }).message === 'string'
        ? ((envelope.error as { message?: string }).message ?? '').trim()
        : `Command failed: ${params.args.join(' ')}`;
    throw new systemTasks.SystemTaskExecutionError('cli_command_failed', message);
  }

  return parsed;
}

async function readLocalHappierCliVersion(params: Readonly<{
  command: string;
  processEnv: NodeJS.ProcessEnv;
}>): Promise<string> {
  const result = await runCommandCapture({
    command: params.command,
    args: ['--version'],
    env: params.processEnv,
  }).catch((error: unknown) => {
    const message = error instanceof Error && error.message.trim()
      ? error.message.trim()
      : 'Failed to spawn Happier CLI.';
    throw new systemTasks.SystemTaskExecutionError('cli_spawn_failed', message);
  });
  const version = result.stdout.trim().split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? '';
  if (result.status !== 0 || !normalizeSemverBase(version)) {
    throw new systemTasks.SystemTaskExecutionError(
      'cli_version_unavailable',
      `Could not read the Happier CLI version from ${params.command}: ${result.stderr.trim() || result.stdout.trim() || 'no output'}`,
    );
  }
  return version;
}

function meetsSetupVersionFloor(version: string): boolean {
  const base = normalizeSemverBase(version);
  return base !== null && compareVersions(base, SETUP_CLI_VERSION_FLOOR) >= 0;
}

export type LocalHappierCliResolutionOverrides = Partial<LocalFirstPartyCommandAcquisitionDeps & {
  readVersion: typeof readLocalHappierCliVersion;
}>;

/**
 * Resolve the Happier CLI for a ring — installing it when this machine has none — and report which
 * version answered. This is the one place a CLI and its version are established together, so any
 * task that states which CLI served it says so from the CLI's own `--version` output rather than
 * from a second reader.
 */
export async function resolveVersionedLocalHappierCli(
  params: Readonly<{
    releaseRing: PublicReleaseRingId;
    processEnv?: NodeJS.ProcessEnv;
  }>,
  overrides: LocalHappierCliResolutionOverrides = {},
): Promise<SetupCapableLocalHappierCli> {
  const processEnv = params.processEnv ?? process.env;
  const cliParams = resolveHappierCliParams({ releaseRing: params.releaseRing, processEnv });
  const readVersion = overrides.readVersion ?? readLocalHappierCliVersion;
  const resolved = resolveExplicitOrInstalledLocalFirstPartyCommand(cliParams)
    ?? await acquireManagedLocalFirstPartyComponentCommand(cliParams, overrides);
  return { ...resolved, version: await readVersion({ command: resolved.command, processEnv }) };
}

/**
 * Resolve a Happier CLI that desktop setup may drive: report its provenance (R13) and enforce
 * the setup version floor. A managed CLI below the floor is reacquired once through the verified
 * release path; an override is development-only and is never reacquired.
 */
export async function ensureSetupCapableLocalHappierCli(
  params: Readonly<{
    releaseRing: PublicReleaseRingId;
    processEnv?: NodeJS.ProcessEnv;
  }>,
  overrides: LocalHappierCliResolutionOverrides = {},
): Promise<SetupCapableLocalHappierCli> {
  const processEnv = params.processEnv ?? process.env;
  const cliParams = resolveHappierCliParams({ releaseRing: params.releaseRing, processEnv });
  const readVersion = overrides.readVersion ?? readLocalHappierCliVersion;

  const resolved = await resolveVersionedLocalHappierCli(params, overrides);
  const { version } = resolved;
  if (meetsSetupVersionFloor(version)) {
    return resolved;
  }

  if (resolved.provenance === 'override') {
    throw new systemTasks.SystemTaskExecutionError(
      'cli_override_below_setup_floor',
      `The Happier CLI override at ${resolved.command} is version ${version}, but desktop setup needs ${SETUP_CLI_VERSION_FLOOR} or newer. Update that checkout or remove the override.`,
    );
  }

  const reacquired = await acquireManagedLocalFirstPartyComponentCommand({
    ...cliParams,
    // The release path resolves the ring's newest version before it downloads or promotes
    // anything, so a ring that cannot satisfy the floor fails here. Installing first would
    // re-download and re-promote a CLI setup cannot drive on every attempt, and fail anyway.
    // An unparseable version id proves nothing about the ring, so it is left to the installed
    // binary's own `--version` below.
    assertAcceptableVersion: (versionId) => {
      if (normalizeSemverBase(versionId) !== null && !meetsSetupVersionFloor(versionId)) {
        throw belowSetupFloorError({ releaseRing: params.releaseRing, version: versionId });
      }
    },
  }, overrides);
  const reacquiredVersion = await readVersion({ command: reacquired.command, processEnv });
  if (meetsSetupVersionFloor(reacquiredVersion)) {
    return { ...reacquired, version: reacquiredVersion };
  }
  throw belowSetupFloorError({ releaseRing: params.releaseRing, version: reacquiredVersion });
}

function belowSetupFloorError(params: Readonly<{
  releaseRing: PublicReleaseRingId;
  version: string;
}>): systemTasks.SystemTaskExecutionError {
  return new systemTasks.SystemTaskExecutionError(
    'cli_below_setup_floor',
    `The newest Happier CLI on the ${params.releaseRing} ring is ${params.version}, but desktop setup needs ${SETUP_CLI_VERSION_FLOOR} or newer. Update the app or wait for the next CLI release.`,
  );
}

function isJsonFailureEnvelope(value: unknown): value is Readonly<{ ok: false }> {
  return Boolean(
    value
      && typeof value === 'object'
      && 'ok' in value
      && (value as { ok?: unknown }).ok === false,
  );
}
