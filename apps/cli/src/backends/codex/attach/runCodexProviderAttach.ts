import { spawn } from 'node:child_process';

import {
  resolvePersistedCodexRuntimeIdentity,
  resolvePersistedCodexVendorSessionId,
} from '@happier-dev/agents';
import { resolveWindowsCommandInvocation } from '@happier-dev/cli-common/process';

import { configuration } from '@/configuration';
import type { CodexSharedControlEndpoint } from '../localControl/codexSharedControlEndpoint';
import { readCodexSharedControlEndpoint } from '../localControl/codexSharedControlEndpoint';
import { createCodexSharedAttachArgs } from '../localControl/createCodexSharedAttachArgs';
import { resolveCodexCliInvocation } from '../utils/resolveCodexCliInvocation';

type SpawnedProcess = Readonly<{
  once: (event: 'exit' | 'error', handler: (...args: unknown[]) => void) => void;
}>;

type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: Readonly<{
    stdio: 'inherit';
    shell: false;
    env: NodeJS.ProcessEnv;
    windowsVerbatimArguments?: boolean;
  }>,
) => SpawnedProcess;

export async function runCodexProviderAttach(params: Readonly<{
  sessionId: string;
  metadata: Record<string, unknown>;
  happyHomeDir?: string;
  env?: NodeJS.ProcessEnv;
  command?: string;
  commandArgs?: readonly string[];
  spawnProcess?: SpawnProcess;
  readEndpointFn?: (params: { happyHomeDir: string; sessionId: string }) => Promise<CodexSharedControlEndpoint | null>;
}>): Promise<number> {
  if (resolvePersistedCodexRuntimeIdentity(params.metadata)?.backendMode !== 'appServer') return 1;
  const directory = typeof params.metadata.path === 'string' ? params.metadata.path.trim() : '';
  const vendorSessionId = resolvePersistedCodexVendorSessionId(params.metadata);
  if (!directory || !vendorSessionId) return 1;

  const endpoint = await (params.readEndpointFn ?? readCodexSharedControlEndpoint)({
    happyHomeDir: params.happyHomeDir ?? configuration.happyHomeDir,
    sessionId: params.sessionId,
  });
  if (!endpoint) return 1;

  const env = params.env ?? process.env;
  const resolved = params.command
    ? { command: params.command, args: [...(params.commandArgs ?? [])] }
    : await resolveCodexCliInvocation({
        args: [],
        cwd: directory,
        processEnv: env,
        overrideEnvVarKeys: ['HAPPIER_CODEX_TUI_BIN', 'HAPPY_CODEX_TUI_BIN'],
        targetLabel: 'Codex CLI',
      });
  const invocation = resolveWindowsCommandInvocation({
    command: resolved.command,
    args: [
      ...resolved.args,
      ...createCodexSharedAttachArgs({ endpoint: endpoint.endpoint, directory, sessionId: vendorSessionId }),
    ],
    env,
    resolveCommandOnPath: false,
  });

  return await new Promise<number>((resolve) => {
    const spawnProcess: SpawnProcess = params.spawnProcess ?? ((command, args, options) => {
      const child = spawn(command, [...args], options);
      return {
        once: (event, handler) => {
          child.once(event, (...args: unknown[]) => handler(...args));
        },
      };
    });
    const child = spawnProcess(invocation.command, invocation.args, {
      stdio: 'inherit',
      shell: false,
      env,
      ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
    child.once('error', () => resolve(1));
    child.once('exit', (code) => resolve(typeof code === 'number' ? code : 1));
  });
}
