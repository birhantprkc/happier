import { systemTasks } from '@happier-dev/cli-common';
import {
  ensureHappierCliPathExposure,
  removeHappierCliPathExposure,
  resolveFirstPartyInstallLayout,
} from '@happier-dev/cli-common/firstPartyRuntime';

import { parseDaemonServiceParams } from './daemonService.js';

type CliPathExposureDeps = Readonly<{
  processEnv: NodeJS.ProcessEnv;
}>;

function resolveManagedCliBinDir(processEnv: NodeJS.ProcessEnv): string {
  return resolveFirstPartyInstallLayout({ componentId: 'happier-cli', processEnv }).shimDir;
}

/**
 * Settings repair action: "Add happier to PATH". The setup executor calls the same owner after
 * readiness; this kind exists so the user can retry (or undo) it explicitly, and a failure here
 * is the user-facing result rather than a quiet one.
 */
export function createCliPathExposureEnsureHandler(overrides: Partial<CliPathExposureDeps> = {}) {
  const processEnv = overrides.processEnv ?? process.env;

  return async function* (
    params: unknown,
    _context: Readonly<{ signal: AbortSignal }>,
  ): AsyncGenerator<never, Readonly<{ changed: boolean; shellReloadHint: string | null; failure: string | null }>, void> {
    parseDaemonServiceParams(params);
    const result = await ensureHappierCliPathExposure({
      binDir: resolveManagedCliBinDir(processEnv),
      processEnv,
    });
    if (result.failure) {
      throw new systemTasks.SystemTaskExecutionError('cli_path_exposure_failed', result.failure);
    }
    return result;
  };
}

export function createCliPathExposureRemoveHandler(overrides: Partial<CliPathExposureDeps> = {}) {
  const processEnv = overrides.processEnv ?? process.env;

  return async function* (
    params: unknown,
    _context: Readonly<{ signal: AbortSignal }>,
  ): AsyncGenerator<never, Readonly<{ removed: boolean; failure: string | null }>, void> {
    parseDaemonServiceParams(params);
    const result = await removeHappierCliPathExposure({ processEnv });
    if (result.failure) {
      throw new systemTasks.SystemTaskExecutionError('cli_path_exposure_failed', result.failure);
    }
    return result;
  };
}
