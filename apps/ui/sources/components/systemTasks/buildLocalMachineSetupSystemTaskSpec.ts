import { SYSTEM_TASK_PROTOCOL_VERSION, type SystemTaskSpec } from '@happier-dev/protocol';

/** The executor's release ring, in the bootstrap channel vocabulary (`publicdev` is spelled `dev`). */
export type LocalMachineSetupChannel = 'stable' | 'preview' | 'dev';

/**
 * The explicit target of `setup.thisComputer.v1` (R3): the relay the app selected, the account
 * the app is signed in as, and the app's release ring. The executor fails on a missing target
 * rather than reading the CLI's ambient relay, so every field here is required.
 */
export type LocalMachineSetupTarget = Readonly<{
    activeRelayUrl: string;
    activeWebappUrl: string;
    activeLocalRelayUrl: string | null;
    channel: LocalMachineSetupChannel;
    expectedAccountId: string;
}>;

export function buildLocalMachineSetupSystemTaskSpec(target: LocalMachineSetupTarget): SystemTaskSpec {
    return {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind: 'setup.thisComputer.v1',
        params: {
            activeRelayUrl: target.activeRelayUrl,
            activeWebappUrl: target.activeWebappUrl,
            activeLocalRelayUrl: target.activeLocalRelayUrl,
            channel: target.channel,
            expectedAccountId: target.expectedAccountId,
            surface: 'desktop.ui',
        },
    };
}
