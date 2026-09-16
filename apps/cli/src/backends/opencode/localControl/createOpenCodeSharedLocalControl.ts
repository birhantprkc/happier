import { createSharedProviderLocalControl } from '@/agent/localControl/createSharedProviderLocalControl';
import type { ApiSessionClient } from '@/api/session/sessionClient';

import { createOpenCodeTuiSupervisor, type OpenCodeTuiSupervisor } from './openCodeTuiSupervisor';
import type { OpenCodeLocalControlSupport } from './resolveOpenCodeLocalControlSupport';

type Mode = 'local' | 'remote';

type OpenCodeAttachTarget = Readonly<{
  baseUrl: string;
  directory: string;
  sessionId: string;
}>;

export function createOpenCodeSharedLocalControl(params: Readonly<{
  support: OpenCodeLocalControlSupport;
  startingMode: Mode;
  getSession: () => ApiSessionClient | null;
  getSessionId: () => string | null;
  getDirectory: () => string;
  getServerBaseUrl: () => Promise<string | null> | string | null;
  supervisor?: OpenCodeTuiSupervisor;
  mountRemoteUi?: () => void;
  unmountRemoteUi?: () => Promise<void>;
}>) {
  let localControl: ReturnType<typeof createSharedProviderLocalControl<OpenCodeAttachTarget>>;
  const supervisor = params.supervisor ?? createOpenCodeTuiSupervisor({
    onExit: async () => {
      await localControl.onTerminalExit();
    },
  });
  localControl = createSharedProviderLocalControl({
    supported: params.support.ok,
    startingMode: params.startingMode,
    getSession: params.getSession,
    resolveTarget: async () => {
      const baseUrl = await params.getServerBaseUrl();
      const sessionId = params.getSessionId();
      if (!baseUrl || !sessionId) return null;
      return { baseUrl, directory: params.getDirectory(), sessionId };
    },
    isSameTarget: (left, right) => left.baseUrl === right.baseUrl && left.sessionId === right.sessionId,
    supervisor,
    mountRemoteUi: params.mountRemoteUi,
    unmountRemoteUi: params.unmountRemoteUi,
  });
  return localControl;
}
