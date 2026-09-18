import type { DesktopBackgroundServiceAutostartMode } from '@/setup/deriveDesktopLocalSetupSnapshot';
import { readDisplayMachineIdForSession } from '@/sync/ops/sessionMachineTarget';
import type { Session } from '@/sync/domains/state/storageTypes';
import { isSessionActive } from '@/utils/sessions/sessionUtils';

/**
 * What the desktop app does with the background service as it quits.
 *
 * With login start off, the deal the settings toggle makes with the user is explicit: this
 * computer answers while the app is open and stops answering once it is closed. Honouring that
 * must never cost anyone their work, so an active agent session turns the decision into a question
 * rather than an action.
 *
 * Paths that cannot ask — force quit, OS shutdown, logout — are not an input here and never reach
 * this function: they deliver no exit handoff at all, or deliver one the app is killed before
 * answering. Nothing stops the service without an answer, so those paths leave it running.
 */
export type DesktopCloseDaemonDecision = 'stop' | 'ask' | 'leaveRunning';

export function resolveDesktopCloseDaemonDecision(input: Readonly<{
    /**
     * The installed service's autostart mode, as the CLI reports it. `null` means the CLI that
     * answered proved no mode — unknown, never `on-demand`.
     */
    autostart: DesktopBackgroundServiceAutostartMode | null;
    /** Agent sessions running on THIS computer — the only ones stopping this daemon would end. */
    activeLocalSessionCount: number;
    /**
     * Whether the count above could describe this daemon at all: the app knows its own account,
     * and the relay validated the daemon's credentials for that same account. Sessions are read
     * from the app's store, which holds only the relay and account the app is on and is emptied on
     * sign-out — so a daemon paired elsewhere, or an app with no account, reports zero sessions
     * for a computer that may be running several.
     */
    canSeeDaemonSessions: boolean;
}>): DesktopCloseDaemonDecision {
    if (input.autostart !== 'on-demand') {
        // The service is meant to outlive the app, or nothing proved otherwise. Quitting the app
        // is not a reason to take the computer off the air on a guess.
        return 'leaveRunning';
    }
    if (!input.canSeeDaemonSessions || input.activeLocalSessionCount > 0) {
        // Zero-because-invisible is not "nothing to lose", so it is put to the user rather than
        // decided for them.
        return 'ask';
    }
    return 'stop';
}

/**
 * How much is at stake if this computer's daemon stops: the agent sessions running **here**.
 *
 * Both halves come from their canonical owners — `isSessionActive` for liveness and
 * `readDisplayMachineIdForSession` for which computer a session is on — so this never becomes a
 * second notion of an active session. Sessions on other machines are untouched by stopping this
 * daemon and are not counted.
 */
export function countActiveLocalAgentSessions(params: Readonly<{
    sessions: readonly Session[] | null;
    machineId: string | null;
}>): number {
    if (!params.machineId || !params.sessions) {
        return 0;
    }
    return params.sessions.filter((session) => isSessionActive(session)
        && readDisplayMachineIdForSession({ sessionId: session.id, metadata: session.metadata ?? null }) === params.machineId
    ).length;
}
