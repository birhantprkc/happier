import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

import type { MachineCapabilitiesSnapshot } from '@/hooks/server/useMachineCapabilitiesCache';
import type { Machine } from '@/sync/domains/state/storageTypes';

import { buildMachineUpdateGroups } from './buildMachineUpdateGroups';
import { buildUpdatesSummary } from './items/buildUpdatesSummary';

function machine(id: string, metadata: Partial<NonNullable<Machine['metadata']>> = {}): Machine {
    return {
        id,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: Date.now(),
        metadata: {
            host: id,
            platform: 'darwin',
            happyCliVersion: '0.2.12',
            happyHomeDir: '/h/.happier',
            homeDir: '/h',
            ...metadata,
        },
    } as Machine;
}

const NO_RUNS = new Map();

describe('buildMachineUpdateGroups (what the always-mounted pill counts)', () => {
    it('counts a remote CLI update from machine metadata alone, before Updates was ever opened (K5)', () => {
        const studio = machine('studio', {
            cliUpdate: {
                currentVersion: '0.2.12',
                latestVersion: '0.2.13',
                channel: 'stable',
                installSource: 'managed',
                updateCommand: 'happier self update',
                canUpdateRemotely: true,
                lastUpdate: null,
            },
        });
        // No capability detect cached for that machine yet: its `tool.systemTasks` kinds are unknown.
        const { groups } = buildMachineUpdateGroups({
            machines: [studio],
            thisMachineId: null,
            thisComputerItem: null,
            runs: NO_RUNS,
            snapshots: new Map(),
        });
        expect(buildUpdatesSummary(groups.flatMap((group) => group.items))).toMatchObject({ actionableCount: 1, phase: 'available' });
    });

    it('does not offer the remote update once the daemon is known not to list cli.update.v1', () => {
        const studio = machine('studio', {
            cliUpdate: {
                currentVersion: '0.2.12', latestVersion: '0.2.13', channel: 'stable', installSource: 'managed',
                updateCommand: 'happier self update', canUpdateRemotely: true, lastUpdate: null,
            },
        });
        const snapshot: MachineCapabilitiesSnapshot = {
            response: { protocolVersion: 1, results: { 'tool.systemTasks': { ok: true, checkedAt: 1, data: { kinds: ['relay.runtime.status.v1'] } } } },
        };
        const { groups } = buildMachineUpdateGroups({
            machines: [studio], thisMachineId: null, thisComputerItem: null, runs: NO_RUNS, snapshots: new Map([['studio', snapshot]]),
        });
        expect(buildUpdatesSummary(groups.flatMap((group) => group.items)).actionableCount).toBe(0);
    });

    it('counts an agent CLI update from the background-prefetched detect (K6), on this computer too', () => {
        const snapshot: MachineCapabilitiesSnapshot = {
            response: {
                protocolVersion: 1,
                results: {
                    'cli.claude': {
                        ok: true,
                        checkedAt: 1,
                        data: { available: true, version: '2.1.3', latestVersion: '2.1.4', installSource: 'managed', updateSupported: true, updateCommand: null },
                    },
                },
            },
        };
        const { groups } = buildMachineUpdateGroups({
            machines: [machine('laptop')],
            thisMachineId: 'laptop',
            thisComputerItem: null,
            runs: NO_RUNS,
            snapshots: new Map([['laptop', snapshot]]),
        });
        expect(groups.map((group) => group.kind)).toEqual(['thisComputer']);
        expect(buildUpdatesSummary(groups.flatMap((group) => group.items))).toMatchObject({ actionableCount: 1 });
    });
});
