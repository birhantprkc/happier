import { createAttachedTerminalSupervisor, type AttachedTerminalSupervisor } from '@/agent/localControl/createAttachedTerminalSupervisor';

import { resolveCodexCliInvocation } from '../utils/resolveCodexCliInvocation';
import { createCodexSharedAttachArgs, type CodexSharedAttachTarget } from './createCodexSharedAttachArgs';

export type CodexSharedTuiSupervisor = AttachedTerminalSupervisor<CodexSharedAttachTarget>;

export function createCodexSharedTuiSupervisor(params: Readonly<{
  processEnv?: NodeJS.ProcessEnv;
  onExit?: () => void | Promise<void>;
}> = {}): CodexSharedTuiSupervisor {
  const processEnv = params.processEnv ?? process.env;
  return createAttachedTerminalSupervisor({
    env: processEnv,
    onExit: params.onExit,
    resolveInvocation: async (target) => await resolveCodexCliInvocation({
      args: createCodexSharedAttachArgs(target),
      cwd: target.directory,
      processEnv,
      overrideEnvVarKeys: ['HAPPIER_CODEX_TUI_BIN', 'HAPPY_CODEX_TUI_BIN'],
      targetLabel: 'Codex CLI',
    }),
  });
}
