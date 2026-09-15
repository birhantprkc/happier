import { beforeEach, describe, expect, it, vi } from 'vitest';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());
const storageState = vi.hoisted(() => ({
    value: {
        machines: {},
    },
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpcWithServerScopeMock,
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        storage: {
            getState: () => storageState.value,
        },
    });
});

const directSource = {
    kind: 'codexHome' as const,
    home: 'user' as const,
};

describe('machine direct sessions ops server-scoped routing', () => {
    beforeEach(() => {
        machineRpcWithServerScopeMock.mockReset();
        storageState.value = { machines: {} };
    });

    it('routes direct session candidate listing through server-scoped machine rpc', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            ok: true,
            candidates: [],
            nextCursor: null,
        });
        const { machineDirectSessionsCandidatesList } = await import('./machineDirectSessions');

        const result = await machineDirectSessionsCandidatesList({
            machineId: 'machine-1',
            providerId: 'codex',
            source: directSource,
            limit: 20,
        }, { serverId: 'server-a' });

        expect(result).toEqual({ ok: true, candidates: [], nextCursor: null });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: 'daemon.directSessions.candidates.list',
            payload: expect.objectContaining({
                providerId: 'codex',
                limit: 20,
            }),
        }));
    });

    it('routes direct session linking hints through server-scoped machine rpc', async () => {
        const runtimeDescriptor = {
            v: 1 as const,
            providerId: 'codex' as const,
            provider: {
                backendMode: 'appServer' as const,
                vendorSessionId: 'vendor-session-1',
                home: 'user' as const,
            },
        };
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            ok: true,
            sessionId: 'happy-session-1',
            created: true,
        });
        const { machineDirectSessionLinkEnsure } = await import('./machineDirectSessions');

        const result = await machineDirectSessionLinkEnsure({
            machineId: 'machine-1',
            providerId: 'codex',
            remoteSessionId: 'vendor-session-1',
            titleHint: 'Existing Codex Session',
            directoryHint: '/tmp/worktree',
            codexBackendMode: 'appServer',
            runtimeDescriptor,
            source: directSource,
        }, { serverId: 'server-a' });

        expect(result).toEqual({
            ok: true,
            sessionId: 'happy-session-1',
            created: true,
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: 'daemon.directSessions.link.ensure',
            payload: {
                machineId: 'machine-1',
                providerId: 'codex',
                remoteSessionId: 'vendor-session-1',
                titleHint: 'Existing Codex Session',
                directoryHint: '/tmp/worktree',
                codexBackendMode: 'appServer',
                runtimeDescriptor,
                source: directSource,
            },
        }));
    });

    it('routes provider-owned candidate deletion through server-scoped machine rpc', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ ok: true, deleted: true });
        const { machineDirectSessionCandidateDelete } = await import('./machineDirectSessions');

        const result = await machineDirectSessionCandidateDelete({
            machineId: 'machine-1',
            providerId: 'kimi',
            remoteSessionId: 'vendor-session-1',
            source: { kind: 'acpSessionList', cwd: '/work/repo' },
        }, { serverId: 'server-a' });

        expect(result).toEqual({ ok: true, deleted: true });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: 'daemon.directSessions.candidate.delete',
            payload: {
                machineId: 'machine-1',
                providerId: 'kimi',
                remoteSessionId: 'vendor-session-1',
                source: { kind: 'acpSessionList', cwd: '/work/repo' },
            },
        }));
    });

    it('routes direct transcript paging through server-scoped machine rpc', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            ok: true,
            items: [],
            nextCursor: 'cursor-2',
            hasMore: true,
        });
        const { machineDirectSessionTranscriptPage } = await import('./machineDirectSessions');

        const result = await machineDirectSessionTranscriptPage({
            machineId: 'machine-1',
            providerId: 'codex',
            remoteSessionId: 'vendor-session-1',
            source: directSource,
            direction: 'older',
        }, { serverId: 'server-a' });

        expect(result).toEqual({
            ok: true,
            items: [],
            nextCursor: 'cursor-2',
            hasMore: true,
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: 'daemon.directSessions.transcript.page',
            payload: expect.objectContaining({
                remoteSessionId: 'vendor-session-1',
                direction: 'older',
            }),
        }));
    });

    it('routes direct session takeover+persist through server-scoped machine rpc', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            ok: true,
            converted: true,
        });
        const { machineDirectSessionTakeoverPersist } = await import('./machineDirectSessions');

        const result = await machineDirectSessionTakeoverPersist({
            machineId: 'machine-1',
            sessionId: 'happy-session-1',
            forceStop: true,
        }, { serverId: 'server-a' });

        expect(result).toEqual({ ok: true, converted: true });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: 'daemon.directSessions.takeoverPersist',
            payload: {
                machineId: 'machine-1',
                sessionId: 'happy-session-1',
                forceStop: true,
            },
        }));
    });

    it('routes direct session RPCs to an active replacement machine while preserving linked metadata identity', async () => {
        storageState.value = {
            machines: {
                'machine-old': {
                    id: 'machine-old',
                    active: false,
                    replacedByMachineId: 'machine-new',
                    replacedAt: 123,
                },
                'machine-new': {
                    id: 'machine-new',
                    active: true,
                },
            },
        };
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            ok: true,
            converted: true,
        });
        const { machineDirectSessionTakeoverPersist } = await import('./machineDirectSessions');

        const result = await machineDirectSessionTakeoverPersist({
            machineId: 'machine-old',
            sessionId: 'happy-session-1',
            forceStop: true,
        }, { serverId: 'server-a' });

        expect(result).toEqual({ ok: true, converted: true });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-new',
            serverId: 'server-a',
            method: 'daemon.directSessions.takeoverPersist',
            payload: {
                machineId: 'machine-old',
                sessionId: 'happy-session-1',
                forceStop: true,
            },
        }));
    });

    it('throws for malformed transcript page responses', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ nope: true });
        const { machineDirectSessionTranscriptPage } = await import('./machineDirectSessions');

        await expect(machineDirectSessionTranscriptPage({
            machineId: 'machine-1',
            providerId: 'codex',
            remoteSessionId: 'vendor-session-1',
            source: directSource,
            direction: 'older',
        })).rejects.toThrow('Unsupported response from machine RPC (daemon.directSessions.transcript.page)');
    });
});
