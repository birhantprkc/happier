import { createSharedProviderLocalControl } from '@/agent/localControl/createSharedProviderLocalControl';
import type { ApiSessionClient } from '@/api/session/sessionClient';

import {
  createCodexSharedTuiSupervisor,
  type CodexSharedTuiSupervisor,
} from './createCodexSharedTuiSupervisor';
import type { CodexSharedAttachTarget } from './createCodexSharedAttachArgs';

export function createCodexSharedLocalControl(params: Readonly<{
  startingMode: 'local' | 'remote';
  getSession: () => ApiSessionClient | null;
  getSessionId: () => Promise<string | null> | string | null;
  directory: string;
  endpoint: string;
  processEnv?: NodeJS.ProcessEnv;
  supervisor?: CodexSharedTuiSupervisor;
  mountRemoteUi?: () => void;
  unmountRemoteUi?: () => Promise<void>;
}>) {
  let localControl: ReturnType<typeof createSharedProviderLocalControl<CodexSharedAttachTarget>>;
  const supervisor = params.supervisor ?? createCodexSharedTuiSupervisor({
    processEnv: params.processEnv,
    onExit: async () => await localControl.onTerminalExit(),
  });
  localControl = createSharedProviderLocalControl({
    supported: true,
    startingMode: params.startingMode,
    getSession: params.getSession,
    resolveTarget: async () => {
      const sessionId = await params.getSessionId();
      return sessionId
        ? { endpoint: params.endpoint, directory: params.directory, sessionId }
        : null;
    },
    isSameTarget: (left, right) => left.endpoint === right.endpoint && left.sessionId === right.sessionId,
    supervisor,
    mountRemoteUi: params.mountRemoteUi,
    unmountRemoteUi: params.unmountRemoteUi,
  });
  return localControl;
}
