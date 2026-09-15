import { createAttachedTerminalSupervisor, type AttachedTerminalSupervisor } from '@/agent/localControl/createAttachedTerminalSupervisor';

import { createOpenCodeAttachArgs } from './createOpenCodeAttachArgs';
import { resolveOpenCodeCliLaunchSpec } from '../utils/resolveOpenCodeCliCommand';

function resolveDetachTimeoutMs(): number {
  const raw = Number.parseInt(String(process.env.HAPPIER_OPENCODE_LOCAL_DETACH_TIMEOUT_MS ?? ''), 10);
  const value = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 3_000;
  return Math.max(100, Math.min(60_000, value));
}

export type OpenCodeTuiSupervisor = AttachedTerminalSupervisor<{
  baseUrl: string;
  directory: string;
  sessionId: string;
}>;

export function createOpenCodeTuiSupervisor(params?: Readonly<{
  spawnProcess?: Parameters<typeof createAttachedTerminalSupervisor>[0]['spawnProcess'];
  command?: string;
  commandArgs?: readonly string[];
  env?: NodeJS.ProcessEnv;
  onExit?: () => void | Promise<void>;
}>): OpenCodeTuiSupervisor {
  const env = params?.env ?? process.env;
  const commandOverride = params?.command;
  let command: string;
  let commandArgs: readonly string[];
  if (commandOverride) {
    command = commandOverride;
    commandArgs = params?.commandArgs ?? [];
  } else {
    const launch = resolveOpenCodeCliLaunchSpec(env);
    command = launch.command;
    commandArgs = params?.commandArgs ?? launch.args;
  }
  return createAttachedTerminalSupervisor({
    spawnProcess: params?.spawnProcess,
    env,
    detachTimeoutMs: resolveDetachTimeoutMs(),
    onExit: params?.onExit,
    resolveInvocation: ({ baseUrl, directory, sessionId }) => ({
        command,
        args: [...commandArgs, ...createOpenCodeAttachArgs({ baseUrl, directory, sessionId })],
    }),
  });
}
