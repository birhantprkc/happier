import { describe, expect, it } from 'vitest';

import { buildDesktopTrayState } from './buildDesktopTrayState';

describe('buildDesktopTrayState', () => {
    const translate = (key: string) => key;

    it('describes healthy connection health with its machine counts', () => {
        expect(buildDesktopTrayState({
            health: {
                kind: 'healthy',
                machineCount: 3,
                onlineCount: 3,
                statusLabelKey: 'status.connected',
                machineLabelKey: 'status.online',
            },
            t: translate,
        })).toEqual({
            label: 'status.connected',
            detail: 'status.online · 3/3',
            openLabel: 'settingsDesktop.trayOpen',
            quitLabel: 'settingsDesktop.trayQuit',
        });
    });

    it('describes relay drift as action required even when connection health is healthy', () => {
        expect(buildDesktopTrayState({
            health: {
                kind: 'healthy',
                machineCount: 3,
                onlineCount: 3,
                statusLabelKey: 'status.connected',
                machineLabelKey: 'status.online',
            },
            thisComputerSentence: 'This computer is connected to self.example.test as bob.',
            t: translate,
        })).toEqual({
            label: 'status.actionRequired',
            detail: 'This computer is connected to self.example.test as bob.',
            openLabel: 'settingsDesktop.trayOpen',
            quitLabel: 'settingsDesktop.trayQuit',
        });
    });

    it('explains "no machines" by what this computer is connected to, instead of the generic hint (U7)', () => {
        expect(buildDesktopTrayState({
            health: {
                kind: 'no_machine',
                machineCount: 0,
                onlineCount: 0,
                statusLabelKey: 'status.actionRequired',
                machineLabelKey: 'newSession.noMachinesFound',
            },
            thisComputerSentence: 'This computer is connected to self.example.test as bob.',
            t: translate,
        })).toMatchObject({
            label: 'status.actionRequired',
            detail: 'This computer is connected to self.example.test as bob.',
        });
    });

    it('keeps a server-level failure its own description even when this computer has something to say', () => {
        expect(buildDesktopTrayState({
            health: {
                kind: 'server_unreachable',
                machineCount: 0,
                onlineCount: 0,
                statusLabelKey: 'status.disconnected',
                machineLabelKey: 'status.unknown',
            },
            thisComputerSentence: 'This computer is connected to self.example.test as bob.',
            t: translate,
        })).toMatchObject({ label: 'status.disconnected', detail: 'status.unknown' });
    });

    it('describes action-required health kinds with the canonical status keys', () => {
        expect(buildDesktopTrayState({
            health: {
                kind: 'machine_offline',
                machineCount: 4,
                onlineCount: 0,
                statusLabelKey: 'status.actionRequired',
                machineLabelKey: 'status.offline',
            },
            t: translate,
        })).toEqual({
            label: 'status.actionRequired',
            detail: 'status.offline · 0/4',
            openLabel: 'settingsDesktop.trayOpen',
            quitLabel: 'settingsDesktop.trayQuit',
        });
    });

    it('omits machine counts when there are no machines', () => {
        expect(buildDesktopTrayState({
            health: {
                kind: 'server_unreachable',
                machineCount: 0,
                onlineCount: 0,
                statusLabelKey: 'status.disconnected',
                machineLabelKey: 'status.unknown',
            },
            t: translate,
        })).toEqual({
            label: 'status.disconnected',
            detail: 'status.unknown',
            openLabel: 'settingsDesktop.trayOpen',
            quitLabel: 'settingsDesktop.trayQuit',
        });
    });

    it('carries the one Updates item label only while there is something to act on (R13 (e))', () => {
        const health = {
            kind: 'healthy' as const,
            machineCount: 1,
            onlineCount: 1,
            statusLabelKey: 'status.connected' as const,
            machineLabelKey: 'status.online' as const,
        };
        expect(buildDesktopTrayState({ health, updatesLabel: 'Updates available (2)…', t: translate }).updatesLabel)
            .toBe('Updates available (2)…');
        expect(buildDesktopTrayState({ health, thisComputerSentence: 'Drift.', updatesLabel: 'Updating…', t: translate }).updatesLabel)
            .toBe('Updating…');
        expect('updatesLabel' in buildDesktopTrayState({ health, updatesLabel: null, t: translate })).toBe(false);
    });
});
