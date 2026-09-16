import { createAgentLocalControlState } from '@/agent/localControl/createAgentLocalControlState';
import { createLocalRemoteModeController } from '@/agent/localControl/createLocalRemoteModeController';
import { resolveSwitchRequestTarget } from '@/agent/localControl/switchRequestTarget';
import type { ApiSessionClient } from '@/api/session/sessionClient';

import type { AttachedTerminalSupervisor } from './createAttachedTerminalSupervisor';

type Mode = 'local' | 'remote';

export function createSharedProviderLocalControl<TTarget>(params: Readonly<{
  supported: boolean;
  startingMode: Mode;
  getSession: () => ApiSessionClient | null;
  resolveTarget: () => Promise<TTarget | null> | TTarget | null;
  isSameTarget: (left: TTarget, right: TTarget) => boolean;
  supervisor: AttachedTerminalSupervisor<TTarget>;
  mountRemoteUi?: () => void;
  unmountRemoteUi?: () => Promise<void>;
}>): Readonly<{
  resolveKeepAliveMode: () => Mode;
  shouldRenderTerminalDisplay: () => boolean;
  onAfterStart: () => Promise<void>;
  onSessionSwap: (session: ApiSessionClient) => Promise<void>;
  onTerminalExit: () => Promise<void>;
  switchToLocal: () => Promise<boolean>;
  dispose: () => Promise<void>;
}> {
  let currentMode: Mode = params.supported && params.startingMode === 'local' ? 'local' : 'remote';
  let attachedTarget: TTarget | null = null;

  const buildController = (session: ApiSessionClient) => createLocalRemoteModeController({
    session,
    getThinking: () => false,
    resolveLocalSwitchAvailability: async () => params.supported
      ? { ok: true }
      : { ok: false, reason: 'Local attachment is unavailable' },
    requestSwitchToLocalIfSupported: attachLocal,
    mountRemoteUi: params.mountRemoteUi ?? (() => undefined),
    unmountRemoteUi: params.unmountRemoteUi ?? (async () => undefined),
    setRemoteUiAllowsSwitchToLocal: () => undefined,
    buildAgentStateForMode: (currentState, nextMode) => ({
      ...currentState,
      controlledByUser: false,
      localControl: createAgentLocalControlState({
        attached: nextMode === 'local',
        topology: 'shared',
        canAttach: params.supported,
        canDetach: nextMode === 'local',
        remoteWritable: true,
      }),
    }),
  });

  const registerLocalSwitchHandler = (session: ApiSessionClient): void => {
    session.rpcHandlerManager.registerHandler('switch', async (requestParams: unknown) => {
      if (resolveSwitchRequestTarget(requestParams) === 'local') return true;
      return await detachLocal();
    });
  };

  const publishCurrentMode = async (session: ApiSessionClient): Promise<void> => {
    const controller = buildController(session);
    await controller.publishModeState(currentMode);
    if (currentMode === 'local') registerLocalSwitchHandler(session);
    else controller.registerRemoteSwitchHandler();
  };

  async function attachLocal(): Promise<boolean> {
    if (!params.supported) return false;
    const session = params.getSession();
    const target = await params.resolveTarget();
    if (!session || !target) return false;
    if (params.supervisor.isAttached() && attachedTarget && !params.isSameTarget(attachedTarget, target)) {
      await params.supervisor.detach();
      attachedTarget = null;
    }
    const attached = await params.supervisor.attach(target);
    if (!attached) return false;
    attachedTarget = target;
    currentMode = 'local';
    await buildController(session).publishModeState('local');
    registerLocalSwitchHandler(session);
    return true;
  }

  async function detachLocal(): Promise<boolean> {
    const session = params.getSession();
    if (!session) return false;
    await params.supervisor.detach();
    attachedTarget = null;
    currentMode = 'remote';
    await publishCurrentMode(session);
    return true;
  }

  return {
    resolveKeepAliveMode: () => currentMode,
    shouldRenderTerminalDisplay: () => currentMode === 'remote',
    onAfterStart: async () => {
      const session = params.getSession();
      if (!session) return;
      if (currentMode === 'local' && await attachLocal()) return;
      currentMode = 'remote';
      await publishCurrentMode(session);
    },
    onSessionSwap: async (session) => {
      if (currentMode === 'local' && await attachLocal()) return;
      currentMode = 'remote';
      await publishCurrentMode(session);
    },
    onTerminalExit: async () => {
      attachedTarget = null;
      currentMode = 'remote';
      const session = params.getSession();
      if (session) await publishCurrentMode(session);
    },
    switchToLocal: attachLocal,
    dispose: async () => {
      attachedTarget = null;
      await params.supervisor.dispose();
    },
  };
}
