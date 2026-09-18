import { describe, expect, it } from 'vitest';

import { resolveDesktopCloseDaemonDecision } from './resolveDesktopCloseDaemonDecision';

describe('resolveDesktopCloseDaemonDecision', () => {
    it('stops the background service when the app closes, nothing is running, and it is on-demand', () => {
        expect(resolveDesktopCloseDaemonDecision({
            autostart: 'on-demand',
            activeLocalSessionCount: 0,
            canSeeDaemonSessions: true,
        })).toBe('stop');
    });

    it('asks when agent sessions on this computer are still active', () => {
        expect(resolveDesktopCloseDaemonDecision({
            autostart: 'on-demand',
            activeLocalSessionCount: 1,
            canSeeDaemonSessions: true,
        })).toBe('ask');
    });

    it('never stops a service the user asked to start at login', () => {
        expect(resolveDesktopCloseDaemonDecision({
            autostart: 'at-login',
            activeLocalSessionCount: 0,
            canSeeDaemonSessions: true,
        })).toBe('leaveRunning');
    });

    it('leaves the service running when the autostart mode could not be read', () => {
        // Unknown stays unknown: stopping here would take the computer off the air on a guess.
        expect(resolveDesktopCloseDaemonDecision({
            autostart: null,
            activeLocalSessionCount: 0,
            canSeeDaemonSessions: true,
        })).toBe('leaveRunning');
    });

    it('asks rather than stopping when the app cannot see what this daemon is running (H4)', () => {
        // The session count comes from the app's own store, which holds the sessions of the relay
        // and account the APP is on — and is emptied entirely on sign-out. A daemon paired to
        // another account, or an app with no account, therefore reports zero running sessions for
        // a computer that may be running several. Zero-because-invisible must never be read as
        // "nothing to lose".
        expect(resolveDesktopCloseDaemonDecision({
            autostart: 'on-demand',
            activeLocalSessionCount: 0,
            canSeeDaemonSessions: false,
        })).toBe('ask');
    });
});
