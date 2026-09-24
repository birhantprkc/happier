import { spawn } from 'node:child_process';

import { resolveWindowsCommandInvocation } from '@happier-dev/cli-common/process';

import { readSharedManagedOpenCodeServerStateBestEffort } from '@/backends/opencode/server/sharedManagedServer';
import { createOpenCodeAttachArgs } from '@/backends/opencode/localControl/createOpenCodeAttachArgs';
import {
  resolveOpenCodeAttachChildEnv,
  resolveOpenCodeAttachTargetAuthHeaders,
} from '@/backends/opencode/localControl/openCodeAttachTargetAuth';
import {
  resolveOpenCodeAttachCliDialect,
  type OpenCodeAttachCliDialect,
} from '@/backends/opencode/localControl/resolveOpenCodeAttachCliDialect';
import { resolveOpenCodeCliLaunchSpec } from '@/backends/opencode/utils/resolveOpenCodeCliCommand';
import type { ProviderCliLaunchSpec } from '@/runtime/managedTools/requireProviderCliLaunchSpec';
import { resolveOpenCodeProviderAttachTargetWithManagedServerFallback } from './evaluateOpenCodeProviderAttachEligibility';

type SpawnedProcess = Readonly<{
  once: {
    (event: 'exit', handler: (code: number | null, signal: NodeJS.Signals | null) => void): void;
    (event: 'error', handler: (error: Error) => void): void;
  };
}>;

export async function runOpenCodeProviderAttach(params: Readonly<{
  sessionId: string;
  metadata: Record<string, unknown>;
  spawnProcess?: typeof spawn;
  command?: string;
  commandArgs?: readonly string[];
  env?: NodeJS.ProcessEnv;
  readManagedServerStateFn?: typeof readSharedManagedOpenCodeServerStateBestEffort;
  resolveCommandFn?: (env?: NodeJS.ProcessEnv) => ProviderCliLaunchSpec;
  /** Overrides the target probe; omit in production so the actual server decides the dialect. */
  resolveDialectFn?: (params: Readonly<{
    baseUrl: string;
    launchApiGeneration?: 'auto' | 'v2';
    headers?: Record<string, string>;
  }>) => Promise<OpenCodeAttachCliDialect> | OpenCodeAttachCliDialect;
}>): Promise<number> {
  const readManagedServerStateFn = params.readManagedServerStateFn ?? readSharedManagedOpenCodeServerStateBestEffort;
  const target = await resolveOpenCodeProviderAttachTargetWithManagedServerFallback({
    metadata: params.metadata,
    readManagedServerStateFn,
  });
  if (!target.eligible) {
    return 1;
  }

  const spawnProcess = params.spawnProcess ?? spawn;
  const ambientEnv = params.env ?? process.env;
  const launch = params.command && params.commandArgs
    ? null
    : (params.resolveCommandFn ?? resolveOpenCodeCliLaunchSpec)(ambientEnv);
  const command = params.command ?? launch?.command ?? resolveOpenCodeCliLaunchSpec(ambientEnv).command;
  const commandArgs = params.commandArgs ?? launch?.args ?? resolveOpenCodeCliLaunchSpec(ambientEnv).args;
  // A loopback (Happier-managed) target is password protected, so both the dialect probe and the
  // attached CLI need its credential; a remote target keeps the ambient environment untouched.
  const env = await resolveOpenCodeAttachChildEnv({
    baseUrl: target.baseUrl,
    env: ambientEnv,
    readManagedServerStateFn,
  });
  const launchApiGeneration = launch && 'apiGeneration' in launch
    && (launch.apiGeneration === 'v2' || launch.apiGeneration === 'auto')
    ? launch.apiGeneration
    : undefined;
  const dialect = await (params.resolveDialectFn ?? resolveOpenCodeAttachCliDialect)({
    baseUrl: target.baseUrl,
    ...(launchApiGeneration ? { launchApiGeneration } : {}),
    headers: await resolveOpenCodeAttachTargetAuthHeaders({
      baseUrl: target.baseUrl,
      env: ambientEnv,
      readManagedServerStateFn,
    }),
  });
  const invocation = resolveWindowsCommandInvocation({
    command,
    args: [
      ...commandArgs,
      ...createOpenCodeAttachArgs({
        baseUrl: target.baseUrl,
        directory: target.directory,
        sessionId: target.vendorSessionId,
        dialect,
      }),
    ],
    env,
    resolveCommandOnPath: false,
  });

  return await new Promise<number>((resolve) => {
    const child = spawnProcess(invocation.command, invocation.args, {
      stdio: 'inherit',
      shell: false,
      env,
      ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    }) as unknown as SpawnedProcess;

    child.once('error', () => resolve(1));
    child.once('exit', (code) => resolve(typeof code === 'number' ? code : 1));
  });
}
