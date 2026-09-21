import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptRowShellItem } from '@/components/sessions/transcript/measurement/transcriptRowShellSignature';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                            Platform: {
                                                OS: 'web',
                                            },
                                            AppState: {
                                                addEventListener: vi.fn(() => ({ remove: vi.fn() })) as any,
                                            },
                                        }
    );
});

vi.mock('@/log', () => ({
    log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const requestMock = vi.hoisted(() => vi.fn());
const runtimeFetchMock = vi.hoisted(() => vi.fn());
const getCredentialsForServerUrlMock = vi.hoisted(() => vi.fn());
const createEncryptionFromAuthCredentialsMock = vi.hoisted(() => vi.fn());
const machineDirectSessionTranscriptPageMock = vi.hoisted(() => vi.fn());
const machineDirectSessionTranscriptReadAfterMock = vi.hoisted(() => vi.fn());
const resolvePreferredServerIdForSessionIdMock = vi.hoisted(() => vi.fn());
const sessionRpcWithPreferredSessionScopeMock = vi.hoisted(() => vi.fn());
const emitSessionMetadataUpdateWithServerScopeMock = vi.hoisted(() => vi.fn());
const notifyActivityReadyMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/ops/machineDirectSessions', () => ({
    machineDirectSessionTranscriptPage: machineDirectSessionTranscriptPageMock,
    machineDirectSessionTranscriptReadAfter: machineDirectSessionTranscriptReadAfterMock,
}));
vi.mock('@/sync/api/session/apiSocket', () => ({
    apiSocket: {
        request: requestMock,
        emitWithAck: vi.fn(),
        send: vi.fn(),
        onMessage: vi.fn(),
        onStatusChange: vi.fn(),
        onReconnected: vi.fn(),
        disconnect: vi.fn(),
        initialize: vi.fn(),
    },
}));
vi.mock('@/utils/system/runtimeFetch', () => ({
    runtimeFetch: runtimeFetchMock,
}));
vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: {
        getCredentialsForServerUrl: getCredentialsForServerUrlMock,
    },
}));
vi.mock('@/auth/encryption/createEncryptionFromAuthCredentials', () => ({
    createEncryptionFromAuthCredentials: createEncryptionFromAuthCredentialsMock,
}));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId', () => ({
    resolvePreferredServerIdForSessionId: (sessionId: string) => resolvePreferredServerIdForSessionIdMock(sessionId),
}));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/sessionRpcWithPreferredSessionScope', () => ({
    sessionRpcWithPreferredSessionScope: (params: unknown) => sessionRpcWithPreferredSessionScopeMock(params),
}));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/emitSessionMetadataUpdateWithServerScope', () => ({
    emitSessionMetadataUpdateWithServerScope: (params: unknown) => emitSessionMetadataUpdateWithServerScopeMock(params),
}));
vi.mock('@/activity/notifications/runtime/activityLocalNotificationBus', () => ({
    notifyActivityReady: (...args: unknown[]) => notifyActivityReadyMock(...args),
}));

import { storage } from './domains/state/storage';
import { setActiveServerId, upsertServerProfile } from './domains/server/serverProfiles';
import { saveAccountSettings, savePendingAccountSettings } from './domains/state/accountSettingsPersistence';
import { createAccountSettingsScope } from './domains/settings/scope/accountSettingsScope';
import { loadPendingOutboxForSession } from './domains/state/pendingOutboxPersistence';
import { settingsDefaults } from './domains/settings/settings';
import { encodeBase64 } from '@/encryption/base64';
import { encodeUTF8 } from '@/encryption/text';
import type { Session } from './domains/state/storageTypes';
import { buildServerFeaturesResponse } from '@/hooks/server/serverFeaturesTestUtils';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { markSessionHidden, markSessionVisible } from './domains/session/activeViewingSession';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';

const initialStorageState = storage.getState();

type SyncMetadataPatchTestAccess = {
    credentials: { token: string; secret: string } | null;
    encryption: {
        decryptEncryptionKey: (encryptedKey: string | null | undefined) => Promise<null>;
        initializeSessions: () => Promise<void>;
        getSessionEncryption: (sessionId: string) => null;
    };
};

function createSession(sessionId: string): Session {
    const now = Date.now();
    return {
        id: sessionId,
        seq: 0,
        createdAt: now,
        updatedAt: now,
        active: true,
        activeAt: now,
        metadata: null,
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        optimisticThinkingAt: null,
    };
}

function createDirectSession(sessionId: string): Session {
    const now = Date.now();
    return {
        ...createSession(sessionId),
        createdAt: now,
        updatedAt: now,
        metadata: {
            path: '',
            host: '',
            machineId: 'machine-1',
            directSessionV1: {
                v: 1,
                providerId: 'codex',
                machineId: 'machine-1',
                remoteSessionId: 'vendor-session-1',
                source: { kind: 'codexHome', home: 'user' },
            },
        },
    };
}

function expectHeaderValue(headers: HeadersInit | undefined, key: string, value: string) {
    expect(new Headers(headers).get(key)).toBe(value);
}

function findRuntimeFetchCall(url: string) {
    const call = runtimeFetchMock.mock.calls.find(([input]) => String(input) === url);
    expect(call, `expected runtimeFetch to be called with ${url}`).toBeTruthy();
    return call;
}

function expectRuntimeFetchMessagePageCall(
    call: unknown[] | undefined,
    params: { baseUrl: string; sessionId: string; beforeSeq: string; limit: string },
): void {
    expect(call).toBeDefined();
    if (!call) {
        throw new Error(`Expected runtimeFetch message page call for ${params.sessionId}`);
    }
    const [url, init] = call;
    const requestUrl = new URL(String(url));
    expect(`${requestUrl.origin}${requestUrl.pathname}`).toBe(
        `${params.baseUrl}/v1/sessions/${encodeURIComponent(params.sessionId)}/messages`,
    );
    expect(requestUrl.searchParams.get('scope')).toBe('main');
    expect(requestUrl.searchParams.get('beforeSeq')).toBe(params.beforeSeq);
    expect(requestUrl.searchParams.get('limit')).toBe(params.limit);
    expect(requestUrl.searchParams.has('afterSeq')).toBe(false);
    expect(requestUrl.searchParams.has('sidechainId')).toBe(false);
    expect(init).toEqual(expect.objectContaining({ method: 'GET' }));
}

function buildTokenWithSub(sub: string): string {
    const payload = encodeBase64(encodeUTF8(JSON.stringify({ sub })), 'base64');
    return `hdr.${payload}.sig`;
}

describe('sync.fetchMessages server-scoped known-session checks', () => {
    beforeEach(() => {
        resetServerFeaturesClientForTests();
        storage.setState(initialStorageState, true);
        requestMock.mockReset();
        runtimeFetchMock.mockReset();
        getCredentialsForServerUrlMock.mockReset();
        createEncryptionFromAuthCredentialsMock.mockReset();
        machineDirectSessionTranscriptPageMock.mockReset();
        machineDirectSessionTranscriptReadAfterMock.mockReset();
        resolvePreferredServerIdForSessionIdMock.mockReset();
        sessionRpcWithPreferredSessionScopeMock.mockReset();
        emitSessionMetadataUpdateWithServerScopeMock.mockReset();
        notifyActivityReadyMock.mockReset();
        resolvePreferredServerIdForSessionIdMock.mockReturnValue(undefined);
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('does not publish an empty loaded transcript while the route owner is unresolved', async () => {
        const sessionId = 'route_owner_race';
        const { sync } = await import('./sync');
        const syncInternals = sync as unknown as {
            hasFetchedSessionsSnapshotForActiveServer: boolean;
            activeServerSessionIds: Set<string>;
            deferredMessagesFetchSessionIds: Set<string>;
        };
        syncInternals.hasFetchedSessionsSnapshotForActiveServer = true;
        syncInternals.activeServerSessionIds = new Set<string>();
        syncInternals.deferredMessagesFetchSessionIds = new Set<string>();

        await expect((sync as any).fetchMessages(sessionId)).resolves.toBeUndefined();
        expect(storage.getState().sessionMessages[sessionId]?.isLoaded).not.toBe(true);
        expect(syncInternals.deferredMessagesFetchSessionIds.has(sessionId)).toBe(true);
    });

    it('keeps storage-present sessions absent from the active-server snapshot on the normal fetch path', async () => {
        // The active-server list snapshot is partial (archived sessions and rows beyond the
        // snapshot page are absent). A storage-present session resolved to the active server
        // must stay on the normal fetch path (retry semantics, same as its snapshot-listed
        // siblings) instead of being classified as missing, and must never be deleted locally.
        const sessionId = 'off_snapshot_session_id';
        storage.getState().applySessions([createSession(sessionId)]);

        const { sync } = await import('./sync');
        (sync as any).encryption = {
            getSessionEncryption: () => null,
        };
        (sync as any).activeServerSessionIds = new Set<string>();
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = true;

        await expect((sync as any).fetchMessages(sessionId)).rejects.toThrow(
            `Session encryption not ready for ${sessionId}`,
        );
        expect(storage.getState().sessions[sessionId]).not.toBeUndefined();
    });

    it('keeps retry semantics before first session snapshot for the active server', async () => {
        const sessionId = 'before_snapshot_session';
        storage.getState().applySessions([createSession(sessionId)]);

        const { sync } = await import('./sync');
        (sync as any).encryption = {
            getSessionEncryption: () => null,
        };
        (sync as any).activeServerSessionIds = new Set<string>();
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = false;

        await expect((sync as any).fetchMessages(sessionId)).rejects.toThrow(
            `Session encryption not ready for ${sessionId}`,
        );
    });

    it('keeps retry semantics for active-server sessions with missing encryption', async () => {
        const sessionId = 'known_active_session';
        storage.getState().applySessions([createSession(sessionId)]);

        const { sync } = await import('./sync');
        (sync as any).encryption = {
            getSessionEncryption: () => null,
        };
        (sync as any).activeServerSessionIds = new Set<string>([sessionId]);

        await expect((sync as any).fetchMessages(sessionId)).rejects.toThrow(
            `Session encryption not ready for ${sessionId}`,
        );
    });

    it('fetches plaintext session messages without requiring session encryption', async () => {
        const sessionId = 'plain_active_session';
        storage.getState().applySessions([{ ...createSession(sessionId), encryptionMode: 'plain' } as Session]);
        requestMock.mockResolvedValueOnce(
            new Response(
                JSON.stringify({
                    messages: [
                        {
                            id: 'plain-message-1',
                            seq: 1,
                            localId: null,
                            sidechainId: null,
                            content: {
                                t: 'plain',
                                v: { role: 'user', content: { type: 'text', text: 'hello plain sync' } },
                            },
                            createdAt: 1_001,
                            updatedAt: 1_001,
                        },
                    ],
                    hasMore: false,
                    nextBeforeSeq: null,
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
        );
        const getSessionEncryption = vi.fn(() => null);

        const { sync } = await import('./sync');
        (sync as any).encryption = {
            getSessionEncryption,
        };
        (sync as any).activeServerSessionIds = new Set<string>([sessionId]);
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = true;

        await expect((sync as any).fetchMessages(sessionId)).resolves.toBeUndefined();

        expect(getSessionEncryption).not.toHaveBeenCalled();
        const messagesById = storage.getState().sessionMessages[sessionId]?.messagesById ?? {};
        expect(Object.values(messagesById).some((message) => message.kind === 'user-text' && message.text === 'hello plain sync')).toBe(true);
    });

    it('treats sessions applied after the initial snapshot as known on the active server', async () => {
        const sessionId = 'new_after_snapshot';
        const { sync } = await import('./sync');
        (sync as any).encryption = {
            getSessionEncryption: () => null,
        };
        // Snapshot already fetched, but the set does not yet include this newly applied session.
        (sync as any).activeServerSessionIds = new Set<string>();
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = true;
        (sync as any).applySessions([createSession(sessionId)]);

        await expect((sync as any).fetchMessages(sessionId)).rejects.toThrow(
            `Session encryption not ready for ${sessionId}`,
        );
    });

    it('loads direct session transcripts from provider-backed paging without requiring session encryption', async () => {
        const sessionId = 'direct_session_id';
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('server-owned');
        storage.getState().applySessions([createDirectSession(sessionId)]);
        machineDirectSessionTranscriptPageMock.mockResolvedValueOnce({
            ok: true,
            items: [
                {
                    id: 'direct-msg-1',
                    createdAtMs: 1,
                    raw: { role: 'user', content: { type: 'text', text: 'hello direct' } },
                },
            ],
            nextCursor: 'older-cursor-1',
            hasMore: true,
        });
        machineDirectSessionTranscriptReadAfterMock.mockResolvedValueOnce({
            ok: true,
            items: [],
            nextCursor: 'tail-cursor-1',
            truncated: false,
        });

        const { sync } = await import('./sync');
        (sync as any).encryption = {
            getSessionEncryption: () => null,
        };
        (sync as any).activeServerSessionIds = new Set<string>([sessionId]);
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = true;

        await expect((sync as any).fetchMessages(sessionId)).resolves.toBeUndefined();

        expect(machineDirectSessionTranscriptPageMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            providerId: 'codex',
            remoteSessionId: 'vendor-session-1',
            direction: 'older',
        }), { serverId: 'server-owned' });
        expect(machineDirectSessionTranscriptReadAfterMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            remoteSessionId: 'vendor-session-1',
            cursor: 'tail',
        }), { serverId: 'server-owned' });
        expect(storage.getState().sessionMessages[sessionId]?.isLoaded).toBe(true);
        const messagesById = storage.getState().sessionMessages[sessionId]?.messagesById ?? {};
        expect(Object.values(messagesById).some((message) => message.kind === 'user-text' && message.text === 'hello direct')).toBe(true);
    });

    it('fetches persisted session messages through the preferred owner server when the owner is not active', async () => {
        const sessionId = 'persisted_session_remote_messages';
        const activeServer = upsertServerProfile({ serverUrl: 'https://active.example', name: 'Active' });
        const ownerServer = upsertServerProfile({ serverUrl: 'https://owner.example', name: 'Owner' });
        setActiveServerId(activeServer.id, { scope: 'device' });
        resolvePreferredServerIdForSessionIdMock.mockReturnValue(ownerServer.id);

        storage.getState().applySessions([createSession(sessionId)]);

        const ownerToken = buildTokenWithSub('owner-account');
        getCredentialsForServerUrlMock.mockResolvedValue({ token: ownerToken, secret: 'owner-secret' });
        createEncryptionFromAuthCredentialsMock.mockResolvedValue({});
        runtimeFetchMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    messages: [
                        {
                            id: 'm1',
                            seq: 1,
                            localId: null,
                            sidechainId: null,
                            content: { t: 'encrypted', c: 'ciphertext-1' },
                            createdAt: 1_001,
                            updatedAt: 1_001,
                        },
                    ],
                    hasMore: false,
                    nextBeforeSeq: null,
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
        );

        const { sync } = await import('./sync');
        (sync as any).encryption = {
            getSessionEncryption: () => ({
                decryptMessages: async () => [
                    {
                        id: 'm1',
                        seq: 1,
                        localId: null,
                        createdAt: 1_001,
                        content: {
                            role: 'user',
                            content: { type: 'text', text: 'hello scoped' },
                        },
                    },
                ],
            }),
        };
        (sync as any).activeServerSessionIds = new Set<string>();
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = true;

        await expect((sync as any).fetchMessages(sessionId)).resolves.toBeUndefined();

        expect(requestMock).not.toHaveBeenCalled();
        const ownerMessagesCall = runtimeFetchMock.mock.calls.find(([url]) => (
            typeof url === 'string'
            && url.startsWith(`https://owner.example/v1/sessions/${sessionId}/messages?`)
            && new URL(url).searchParams.get('scope') === 'main'
        ));
        expect(ownerMessagesCall?.[1]).toEqual(expect.objectContaining({ method: 'GET' }));
        expectHeaderValue(ownerMessagesCall?.[1]?.headers, 'Authorization', `Bearer ${ownerToken}`);
        const messagesById = storage.getState().sessionMessages[sessionId]?.messagesById ?? {};
        expect(Object.values(messagesById).some((message) => message.kind === 'user-text' && message.text === 'hello scoped')).toBe(true);
    });

    it('pages older persisted session messages through the preferred owner server when the owner is not active', async () => {
        const sessionId = 'persisted_session_remote_older';
        const activeServer = upsertServerProfile({ serverUrl: 'https://active.example', name: 'Active' });
        const ownerServer = upsertServerProfile({ serverUrl: 'https://owner.example', name: 'Owner' });
        setActiveServerId(activeServer.id, { scope: 'device' });
        resolvePreferredServerIdForSessionIdMock.mockReturnValue(ownerServer.id);

        storage.getState().applySessions([createSession(sessionId)]);

        const ownerToken = buildTokenWithSub('owner-account');
        getCredentialsForServerUrlMock.mockResolvedValue({ token: ownerToken, secret: 'owner-secret' });
        createEncryptionFromAuthCredentialsMock.mockResolvedValue({});
        runtimeFetchMock
            .mockResolvedValueOnce(
                new Response(
                    JSON.stringify({
                        messages: [
                            {
                                id: 'm2',
                                seq: 2,
                                localId: null,
                                sidechainId: null,
                                content: { t: 'encrypted', c: 'ciphertext-2' },
                                createdAt: 1_002,
                                updatedAt: 1_002,
                            },
                        ],
                        hasMore: true,
                        nextBeforeSeq: 2,
                    }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } },
                ),
            )
            .mockResolvedValueOnce(
                new Response(
                    JSON.stringify({
                        messages: [
                            {
                                id: 'm1',
                                seq: 1,
                                localId: null,
                                sidechainId: null,
                                content: { t: 'encrypted', c: 'ciphertext-1' },
                                createdAt: 1_001,
                                updatedAt: 1_001,
                            },
                        ],
                        hasMore: false,
                        nextBeforeSeq: null,
                    }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } },
                ),
            );

        const { sync } = await import('./sync');
        (sync as any).encryption = {
            getSessionEncryption: () => ({
                decryptMessages: async (messages: Array<{ id: string; seq: number; createdAt: number }>) =>
                    messages.map((message) => ({
                        id: message.id,
                        seq: message.seq,
                        localId: null,
                        createdAt: message.createdAt,
                        content: {
                            role: 'user',
                            content: { type: 'text', text: message.id === 'm2' ? 'latest' : 'older' },
                        },
                    })),
            }),
        };
        (sync as any).activeServerSessionIds = new Set<string>();
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = true;

        await (sync as any).fetchMessages(sessionId);
        const result = await (sync as any).loadOlderMessages(sessionId);

        expect(result).toEqual({ loaded: 1, hasMore: false, status: 'no_more' });
        expect(requestMock).not.toHaveBeenCalled();
        expectRuntimeFetchMessagePageCall(runtimeFetchMock.mock.calls[1], {
            baseUrl: 'https://owner.example',
            sessionId,
            beforeSeq: '2',
            limit: '150',
        });
        expectHeaderValue(runtimeFetchMock.mock.calls[1]?.[1]?.headers, 'Authorization', `Bearer ${ownerToken}`);
    });

    it('fetches pending messages through the preferred owner server when the owner is not active', async () => {
        const sessionId = 'persisted_session_remote_pending_fetch';
        const activeServer = upsertServerProfile({ serverUrl: 'https://active.example', name: 'Active' });
        const ownerServer = upsertServerProfile({ serverUrl: 'https://owner.example', name: 'Owner' });
        setActiveServerId(activeServer.id, { scope: 'device' });
        resolvePreferredServerIdForSessionIdMock.mockReturnValue(ownerServer.id);

        storage.getState().applySessions([{
            ...createSession(sessionId),
            encryptionMode: 'plain',
        } as Session]);

        const ownerToken = buildTokenWithSub('owner-account');
        getCredentialsForServerUrlMock.mockResolvedValue({ token: ownerToken, secret: 'owner-secret' });
        createEncryptionFromAuthCredentialsMock.mockResolvedValue({});
        runtimeFetchMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    pending: [
                        {
                            localId: 'pending-1',
                            content: {
                                t: 'plain',
                                v: {
                                    role: 'user',
                                    content: { type: 'text', text: 'queued remotely' },
                                },
                            },
                            status: 'queued',
                            position: 0,
                            createdAt: 100,
                            updatedAt: 100,
                            discardedAt: null,
                            discardedReason: null,
                            authorAccountId: null,
                        },
                    ],
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
        );

        const { sync } = await import('./sync');

        await expect((sync as any).fetchPendingMessages(sessionId)).resolves.toBeUndefined();

        expect(requestMock).not.toHaveBeenCalled();
        expect(runtimeFetchMock).toHaveBeenCalledWith(
            `https://owner.example/v2/sessions/${sessionId}/pending?includeDiscarded=1`,
            expect.objectContaining({
                method: 'GET',
            }),
        );
        const ownerPendingCall = findRuntimeFetchCall(`https://owner.example/v2/sessions/${sessionId}/pending?includeDiscarded=1`);
        expectHeaderValue(ownerPendingCall?.[1]?.headers, 'Authorization', `Bearer ${ownerToken}`);
        expect(storage.getState().sessionPending[sessionId]?.messages.map((message) => message.text)).toEqual(['queued remotely']);
    });

    it('routes a pending mutation through the preferred owner server instead of active scope', async () => {
        const sessionId = 'persisted_session_remote_pending_update';
        const pendingId = 'remote-pending-1';
        const activeServer = upsertServerProfile({ serverUrl: 'https://active.example', name: 'Active' });
        const ownerServer = upsertServerProfile({ serverUrl: 'https://owner.example', name: 'Owner' });
        setActiveServerId(activeServer.id, { scope: 'device' });
        resolvePreferredServerIdForSessionIdMock.mockReturnValue(ownerServer.id);
        storage.getState().applySessions([{ ...createSession(sessionId), encryptionMode: 'plain' } as Session]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: pendingId,
            localId: pendingId,
            createdAt: 100,
            updatedAt: 100,
            source: 'server_pending',
            deliveryStatus: 'accepted',
            text: 'old',
            rawRecord: { role: 'user', content: { type: 'text', text: 'old' }, meta: {} },
        });
        const ownerToken = buildTokenWithSub('owner-account');
        getCredentialsForServerUrlMock.mockResolvedValue({ token: ownerToken, secret: 'owner-secret' });
        createEncryptionFromAuthCredentialsMock.mockResolvedValue({});
        runtimeFetchMock.mockResolvedValue(new Response('{}', { status: 200 }));

        const { sync } = await import('./sync');
        await expect((sync as any).updatePendingMessage(sessionId, pendingId, 'new')).resolves.toBeUndefined();

        expect(requestMock).not.toHaveBeenCalled();
        const call = findRuntimeFetchCall(`https://owner.example/v2/sessions/${sessionId}/pending/${pendingId}`);
        if (!call) throw new Error('Expected remote owner PATCH request');
        expect(call[1]).toEqual(expect.objectContaining({ method: 'PATCH' }));
        expectHeaderValue(call[1]?.headers, 'Authorization', `Bearer ${ownerToken}`);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({ id: pendingId, text: 'new' }),
        ]);

        runtimeFetchMock.mockClear();
        await expect(sync.updatePendingRequestedAction(sessionId, '.', { v: 1, kind: 'send_now' }))
            .rejects.toThrow('Pending message ID cannot be a dot path segment');
        expect(runtimeFetchMock).not.toHaveBeenCalled();
    });

    it('resolves exact scoped reorder projection ids while preserving unmatched canonical local ids', async () => {
        const sessionId = 'active_pending_reorder_projection_identity';
        const canonicalLocalId = 'reorder-canonical-local-id';
        const unmatchedCanonicalLocalId = 'reorder-unmatched-canonical-local-id';
        const syntheticProjectionId = 'pending-outbox:collision-allocated-reorder-projection';
        const server = upsertServerProfile({ serverUrl: 'https://active-reorder.example', name: 'Active reorder' });
        const scope = { serverId: server.id, accountId: 'account-a' } as const;
        setActiveServerId(server.id, { scope: 'device' });
        storage.getState().activateProfileScope(scope);
        storage.getState().applySessions([{ ...createSession(sessionId), encryptionMode: 'plain' } as Session]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: canonicalLocalId,
            localId: 'raw-id-collider-local-id',
            createdAt: 1,
            updatedAt: 1,
            source: 'server_pending',
            pendingOutboxScope: { serverId: server.id, accountId: 'other-account' },
            text: 'other-scope collider',
            rawRecord: { role: 'user', content: { type: 'text', text: 'other-scope collider' }, meta: {} },
        });
        storage.getState().upsertPendingMessage(sessionId, {
            id: syntheticProjectionId,
            localId: canonicalLocalId,
            createdAt: 2,
            updatedAt: 2,
            source: 'local_outbound',
            deliveryStatus: 'queued',
            pendingOutboxScope: scope,
            pendingOutboxOperation: 'enqueue',
            text: 'collision allocated projection',
            rawRecord: { role: 'user', content: { type: 'text', text: 'collision allocated projection' }, meta: {} },
        });
        requestMock.mockImplementation(async (path: string, init?: RequestInit) => {
            if (path.endsWith('/reorder')) {
                expect(JSON.parse(String(init?.body))).toEqual({
                    orderedLocalIds: [canonicalLocalId, unmatchedCanonicalLocalId],
                });
                return Response.json({ ok: true });
            }
            return Response.json({ pending: [] });
        });

        const { sync } = await import('./sync');
        await expect(sync.reorderPendingMessages(sessionId, [syntheticProjectionId, unmatchedCanonicalLocalId]))
            .resolves.toBeUndefined();

        expect(requestMock).toHaveBeenCalledWith(
            `/v2/sessions/${sessionId}/pending/reorder`,
            expect.objectContaining({ method: 'POST' }),
        );
    });

    it('fences a captured active-owner request before dynamic transport after an account switch', async () => {
        const sessionId = 'active_pending_scope_preflight';
        const server = upsertServerProfile({ serverUrl: 'https://active-owner.example', name: 'Active owner' });
        setActiveServerId(server.id, { scope: 'device' });
        storage.getState().activateProfileScope({ serverId: server.id, accountId: 'account-a' });
        storage.getState().applySessions([{ ...createSession(sessionId), encryptionMode: 'plain' } as Session]);
        requestMock.mockResolvedValue(Response.json({ didUpdate: true }));
        const { sync } = await import('./sync');
        const ownerAccess = sync as unknown as {
            resolvePendingQueueOwnerContext: (candidateSessionId: string) => Promise<{
                request: (path: string, init?: RequestInit) => Promise<Response>;
            }>;
        };
        const owner = await ownerAccess.resolvePendingQueueOwnerContext(sessionId);

        storage.getState().activateProfileScope({ serverId: server.id, accountId: 'account-b' });
        await expect(owner.request(`/v2/sessions/${sessionId}/pending/p1/action`, { method: 'PATCH' }))
            .rejects.toThrow('Pending queue owner scope changed');
        expect(requestMock).not.toHaveBeenCalled();
    });

    it('routes a requested-action update through the preferred Pending owner scope', async () => {
        const sessionId = 'persisted_session_remote_pending_action';
        const localId = 'remote-pending-action-1';
        const activeServer = upsertServerProfile({ serverUrl: 'https://active.example', name: 'Active' });
        const ownerServer = upsertServerProfile({ serverUrl: 'https://owner.example', name: 'Owner' });
        setActiveServerId(activeServer.id, { scope: 'device' });
        resolvePreferredServerIdForSessionIdMock.mockReturnValue(ownerServer.id);
        storage.getState().applySessions([{ ...createSession(sessionId), encryptionMode: 'plain' } as Session]);
        const ownerToken = buildTokenWithSub('owner-account');
        getCredentialsForServerUrlMock.mockResolvedValue({ token: ownerToken, secret: 'owner-secret' });
        createEncryptionFromAuthCredentialsMock.mockResolvedValue({});
        runtimeFetchMock.mockImplementation(async (input, init) => {
            const url = String(input);
            if (url.endsWith('/health')) {
                return Response.json({ ok: true });
            }
            if (url.endsWith('/v1/features')) {
                return Response.json(buildServerFeaturesResponse());
            }
            if (url === `https://owner.example/v2/sessions/${sessionId}/pending/${localId}/action`) {
                expect(init).toEqual(expect.objectContaining({
                    method: 'PATCH',
                    body: JSON.stringify({ requestedAction: { v: 1, kind: 'steer_now' } }),
                }));
                return Response.json({ didUpdate: true });
            }
            return new Response(null, { status: 404 });
        });

        const { sync } = await import('./sync');
        await expect(sync.updatePendingRequestedAction(
            sessionId,
            localId,
            { v: 1, kind: 'steer_now' },
        )).resolves.toBeUndefined();

        expect(requestMock).not.toHaveBeenCalled();
        const actionCall = findRuntimeFetchCall(
            `https://owner.example/v2/sessions/${sessionId}/pending/${localId}/action`,
        );
        expectHeaderValue(actionCall?.[1]?.headers, 'Authorization', `Bearer ${ownerToken}`);
    });

    it('refreshes the canonical session projection after changing resume-on-availability authorization', async () => {
        const sessionId = 'active_pending_activation_projection';
        const localId = 'pending-activation-row';
        const server = upsertServerProfile({ serverUrl: 'https://active-activation.example', name: 'Active activation' });
        setActiveServerId(server.id, { scope: 'device' });
        storage.getState().activateProfileScope({ serverId: server.id, accountId: 'account-a' });
        storage.getState().applySessions([{
            ...createSession(sessionId),
            active: false,
            activeAt: 100,
            encryptionMode: 'plain',
        } as Session]);
        requestMock.mockImplementation(async (path: string, init?: RequestInit) => {
            if (path === `/v2/sessions/${sessionId}/pending/${localId}/action`) {
                expect(init).toEqual(expect.objectContaining({
                    method: 'PATCH',
                    body: JSON.stringify({
                        requestedAction: { v: 1, kind: 'enqueue' },
                        resumeWhenAvailable: true,
                    }),
                }));
                return Response.json({ didUpdate: true });
            }
            if (path === `/v2/sessions/${sessionId}`) {
                return Response.json({
                    session: {
                        id: sessionId,
                        createdAt: 1,
                        updatedAt: 2,
                        seq: 3,
                        active: false,
                        activeAt: 100,
                        encryptionMode: 'plain',
                        dataEncryptionKey: null,
                        metadataVersion: 1,
                        metadata: JSON.stringify({ machineId: 'machine-1', path: '/repo', flavor: 'codex' }),
                        agentStateVersion: 1,
                        agentState: null,
                        share: null,
                        pendingCount: 1,
                        pendingVersion: 2,
                        pendingActivationAuthorization: {
                            requestId: localId,
                            requestedAt: 200,
                            status: 'waiting',
                        },
                    },
                });
            }
            return new Response(null, { status: 404 });
        });
        runtimeFetchMock.mockResolvedValue(Response.json(buildServerFeaturesResponse()));

        const { sync } = await import('./sync');
        const syncAccess = sync as unknown as SyncMetadataPatchTestAccess;
        syncAccess.credentials = { token: 'active-token', secret: 'active-secret' };
        syncAccess.encryption = {
            decryptEncryptionKey: async () => null,
            initializeSessions: async () => {},
            getSessionEncryption: () => null,
        };

        await expect(sync.updatePendingRequestedAction(
            sessionId,
            localId,
            { v: 1, kind: 'enqueue' },
            { resumeWhenAvailable: true },
        )).resolves.toBeUndefined();

        expect(requestMock).toHaveBeenCalledWith(
            `/v2/sessions/${sessionId}`,
            expect.objectContaining({ method: 'GET' }),
        );
        expect(storage.getState().sessions[sessionId]?.pendingActivationAuthorization).toEqual({
            requestId: localId,
            requestedAt: 200,
            status: 'waiting',
        });
    });

    it('rechecks a captured active-owner request before applying local completion', async () => {
        const sessionId = 'active_pending_scope_completion';
        const server = upsertServerProfile({ serverUrl: 'https://active-owner-completion.example', name: 'Active owner completion' });
        setActiveServerId(server.id, { scope: 'device' });
        storage.getState().activateProfileScope({ serverId: server.id, accountId: 'account-a' });
        storage.getState().applySessions([{ ...createSession(sessionId), encryptionMode: 'plain' } as Session]);
        requestMock.mockImplementation(async () => {
            storage.getState().activateProfileScope({ serverId: server.id, accountId: 'account-b' });
            return Response.json({ didUpdate: true });
        });
        runtimeFetchMock.mockResolvedValue(Response.json(buildServerFeaturesResponse()));

        const { sync } = await import('./sync');
        await expect(sync.updatePendingRequestedAction(sessionId, 'p1', { v: 1, kind: 'send_now' }))
            .rejects.toThrow('Pending queue owner scope changed');
        expect(requestMock).toHaveBeenCalledTimes(1);
    });

    it('rejects a non-active mutation refresh after the owner account changes on the same server', async () => {
        const sessionId = 'persisted_session_remote_pending_account_change';
        const pendingId = 'remote-pending-account-change';
        const activeServer = upsertServerProfile({ serverUrl: 'https://active.example', name: 'Active' });
        const ownerServer = upsertServerProfile({ serverUrl: 'https://owner.example', name: 'Owner' });
        setActiveServerId(activeServer.id, { scope: 'device' });
        resolvePreferredServerIdForSessionIdMock.mockReturnValue(ownerServer.id);
        storage.getState().applySessions([{ ...createSession(sessionId), encryptionMode: 'plain' } as Session]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: pendingId,
            localId: pendingId,
            createdAt: 100,
            updatedAt: 100,
            source: 'server_pending',
            deliveryStatus: 'accepted',
            text: 'must survive stale refresh',
            rawRecord: { role: 'user', content: { type: 'text', text: 'must survive stale refresh' }, meta: {} },
        });
        const accountAToken = buildTokenWithSub('owner-account-a');
        const accountBToken = buildTokenWithSub('owner-account-b');
        getCredentialsForServerUrlMock.mockResolvedValue({ token: accountAToken, secret: 'owner-secret-a' });
        createEncryptionFromAuthCredentialsMock.mockResolvedValue({});
        runtimeFetchMock.mockImplementation(async (input) => {
            const url = String(input);
            if (url.endsWith(`/pending/${pendingId}/discard`)) {
                getCredentialsForServerUrlMock.mockResolvedValue({ token: accountBToken, secret: 'owner-secret-b' });
                return Response.json({ ok: true });
            }
            if (url.endsWith('/pending?includeDiscarded=1')) {
                return Response.json({ pending: [] });
            }
            return new Response(null, { status: 404 });
        });

        const { sync } = await import('./sync');
        await expect(sync.discardPendingMessage(sessionId, pendingId)).resolves.toBeUndefined();

        expect(requestMock).not.toHaveBeenCalled();
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({ id: pendingId, text: 'must survive stale refresh' }),
        ]);
    });

    it('applies a non-active mutation refresh while the full owner account scope remains current', async () => {
        const sessionId = 'persisted_session_remote_pending_account_stable';
        const pendingId = 'remote-pending-account-stable';
        const activeServer = upsertServerProfile({ serverUrl: 'https://active.example', name: 'Active' });
        const ownerServer = upsertServerProfile({ serverUrl: 'https://owner.example', name: 'Owner' });
        setActiveServerId(activeServer.id, { scope: 'device' });
        resolvePreferredServerIdForSessionIdMock.mockReturnValue(ownerServer.id);
        storage.getState().applySessions([{ ...createSession(sessionId), encryptionMode: 'plain' } as Session]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: pendingId,
            localId: pendingId,
            createdAt: 100,
            updatedAt: 100,
            source: 'server_pending',
            deliveryStatus: 'accepted',
            text: 'remove after stable refresh',
            rawRecord: { role: 'user', content: { type: 'text', text: 'remove after stable refresh' }, meta: {} },
        });
        const ownerToken = buildTokenWithSub('owner-account-stable');
        getCredentialsForServerUrlMock.mockResolvedValue({ token: ownerToken, secret: 'owner-secret' });
        createEncryptionFromAuthCredentialsMock.mockResolvedValue({});
        runtimeFetchMock.mockImplementation(async (input) => String(input).endsWith('/pending?includeDiscarded=1')
            ? Response.json({ pending: [] })
            : Response.json({ ok: true }));

        const { sync } = await import('./sync');
        await expect(sync.discardPendingMessage(sessionId, pendingId)).resolves.toBeUndefined();

        expect(requestMock).not.toHaveBeenCalled();
        expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
    });

    it('routes abortSession through the preferred owner server scope', async () => {
        sessionRpcWithPreferredSessionScopeMock.mockResolvedValue(undefined);

        const { sync } = await import('./sync');

        await expect((sync as any).abortSession('session-1')).resolves.toBeUndefined();

        expect(sessionRpcWithPreferredSessionScopeMock).toHaveBeenCalledWith({
            sessionId: 'session-1',
            method: 'abort',
            payload: {
                reason: expect.stringContaining("The user doesn't want to proceed"),
            },
        });
    });

    it('routes patchSessionMetadataWithRetry through the scoped metadata updater', async () => {
        const sessionId = 'plain_metadata_session';
        storage.getState().applySessions([{
            ...createSession(sessionId),
            encryptionMode: 'plain',
            metadataVersion: 2,
            metadata: {
                path: '/tmp/repo',
                host: 'test-host',
            },
        } as Session]);
        emitSessionMetadataUpdateWithServerScopeMock.mockResolvedValue({
            result: 'success',
            version: 3,
            metadata: JSON.stringify({
                path: '/tmp/repo',
                host: 'test-host',
                summary: { text: 'Renamed session', updatedAt: 123 },
            }),
        });

        const { sync } = await import('./sync');

        await expect(
            sync.patchSessionMetadataWithRetry(sessionId, (metadata) => ({
                ...metadata,
                summary: { text: 'Renamed session', updatedAt: 123 },
            })),
        ).resolves.toBeUndefined();

        expect(emitSessionMetadataUpdateWithServerScopeMock).toHaveBeenCalledWith({
            sessionId,
            expectedVersion: 2,
            metadata: JSON.stringify({
                path: '/tmp/repo',
                host: 'test-host',
                summary: { text: 'Renamed session', updatedAt: 123 },
            }),
        });
        expect(storage.getState().sessions[sessionId]?.metadataVersion).toBe(3);
        expect((storage.getState().sessions[sessionId]?.metadata as any)?.summary?.text).toBe('Renamed session');
    });

    it('supports overriding the server scope used by patchSessionMetadataWithRetry', async () => {
        const sessionId = 'plain_metadata_session_override';
        storage.getState().applySessions([{
            ...createSession(sessionId),
            encryptionMode: 'plain',
            metadataVersion: 2,
            metadata: {
                path: '/tmp/repo',
                host: 'test-host',
            },
        } as Session]);
        emitSessionMetadataUpdateWithServerScopeMock.mockResolvedValue({
            result: 'success',
            version: 3,
            metadata: JSON.stringify({
                path: '/tmp/repo',
                host: 'test-host',
                summary: { text: 'Renamed session', updatedAt: 123 },
            }),
        });

        const { sync } = await import('./sync');

        await expect(
            sync.patchSessionMetadataWithRetry(
                sessionId,
                (metadata) => ({
                    ...metadata,
                    summary: { text: 'Renamed session', updatedAt: 123 },
                }),
                { serverId: 'server_override' },
            ),
        ).resolves.toBeUndefined();

        expect(emitSessionMetadataUpdateWithServerScopeMock).toHaveBeenCalledWith({
            sessionId,
            expectedVersion: 2,
            metadata: JSON.stringify({
                path: '/tmp/repo',
                host: 'test-host',
                summary: { text: 'Renamed session', updatedAt: 123 },
            }),
            serverId: 'server_override',
        });
    });

    it('hydrates lightweight session rows before patching metadata', async () => {
        const sessionId = 'plain_metadata_lightweight_row';
        requestMock.mockResolvedValueOnce(
            new Response(
                JSON.stringify({
                    session: {
                        id: sessionId,
                        seq: 1,
                        createdAt: 1_000,
                        updatedAt: 1_000,
                        active: true,
                        activeAt: 1_000,
                        encryptionMode: 'plain',
                        dataEncryptionKey: null,
                        metadataVersion: 2,
                        metadata: JSON.stringify({
                            path: '/tmp/repo',
                            host: 'test-host',
                        }),
                        agentStateVersion: 1,
                        agentState: JSON.stringify({ controlledByUser: true }),
                        share: null,
                    },
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
        );
        requestMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
        emitSessionMetadataUpdateWithServerScopeMock.mockResolvedValue({
            result: 'success',
            version: 3,
            metadata: JSON.stringify({
                path: '/tmp/repo',
                host: 'test-host',
                summary: { text: 'Renamed session', updatedAt: 123 },
            }),
        });

        const { sync } = await import('./sync');
        const syncForMetadataPatch = sync as unknown as SyncMetadataPatchTestAccess;
        syncForMetadataPatch.credentials = { token: 'active-token', secret: 'active-secret' };
        syncForMetadataPatch.encryption = {
            decryptEncryptionKey: vi.fn(async () => null),
            initializeSessions: vi.fn(async () => undefined),
            getSessionEncryption: vi.fn(() => null),
        };

        await expect(
            sync.patchSessionMetadataWithRetry(sessionId, (metadata) => ({
                ...metadata,
                summary: { text: 'Renamed session', updatedAt: 123 },
            })),
        ).resolves.toBeUndefined();

        expect(requestMock).toHaveBeenCalledWith(
            `/v2/sessions/${sessionId}`,
            expect.objectContaining({
                method: 'GET',
            }),
        );
        expect(emitSessionMetadataUpdateWithServerScopeMock).toHaveBeenCalledWith({
            sessionId,
            expectedVersion: 2,
            metadata: JSON.stringify({
                path: '/tmp/repo',
                host: 'test-host',
                summary: { text: 'Renamed session', updatedAt: 123 },
            }),
        });
        expect(storage.getState().sessions[sessionId]?.metadata?.summary?.text).toBe('Renamed session');
    });

    it('drops stale direct transcript fetch results after the server scope resets mid-request', async () => {
        const sessionId = 'direct_session_scope_reset';
        storage.getState().applySessions([createDirectSession(sessionId)]);
        storage.getState().applyAutomations([{ id: 'old-server-automation', updatedAt: 1 } as any]);
        storage.getState().setAutomationRuns('old-server-automation', [{ id: 'old-server-run', automationId: 'old-server-automation', scheduledAt: 1, updatedAt: 1 } as any]);

        let resolvePage: ((value: {
            ok: true;
            items: Array<{
                id: string;
                createdAtMs: number;
                raw: { role: 'user'; content: { type: 'text'; text: string } };
            }>;
            nextCursor: string | null;
            hasMore: boolean;
        }) => void) | null = null;

        machineDirectSessionTranscriptPageMock.mockImplementationOnce(
            () => new Promise((resolve) => {
                resolvePage = resolve;
            }),
        );
        machineDirectSessionTranscriptReadAfterMock.mockResolvedValueOnce({
            ok: true,
            items: [],
            nextCursor: 'tail-cursor-stale',
            truncated: false,
        });

        const { sync } = await import('./sync');
        (sync as any).encryption = {
            getSessionEncryption: () => null,
        };
        (sync as any).activeServerSessionIds = new Set<string>([sessionId]);
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = true;

        const fetchPromise = (sync as any).fetchMessages(sessionId);

        if (!resolvePage) {
            throw new Error('expected direct transcript page request to be pending');
        }
        (sync as any).resetServerScopedRuntimeState();

        const completePage = resolvePage as ((value: {
            ok: true;
            items: Array<{
                id: string;
                createdAtMs: number;
                raw: { role: 'user'; content: { type: 'text'; text: string } };
            }>;
            nextCursor: string | null;
            hasMore: boolean;
        }) => void) | null;
        if (!completePage) {
            throw new Error('expected direct transcript page request to remain pending');
        }
        completePage({
            ok: true,
            items: [
                {
                    id: 'direct-msg-stale',
                    createdAtMs: 1,
                    raw: { role: 'user', content: { type: 'text', text: 'stale direct' } },
                },
            ],
            nextCursor: 'older-cursor-stale',
            hasMore: true,
        });

        await expect(fetchPromise).resolves.toBeUndefined();
        expect(storage.getState().sessionMessages[sessionId]).toBeUndefined();
        expect(storage.getState().automations).toEqual({});
        expect(storage.getState().automationRunsByAutomationId).toEqual({});
        expect(machineDirectSessionTranscriptReadAfterMock).not.toHaveBeenCalled();
    });

    it('pages older direct transcript messages using provider cursors and the requested page limit', async () => {
        const sessionId = 'direct_session_paging';
        storage.getState().applySessions([createDirectSession(sessionId)]);
        machineDirectSessionTranscriptPageMock
            .mockResolvedValueOnce({
                ok: true,
                items: [
                    {
                        id: 'direct-msg-2',
                        createdAtMs: 2,
                        raw: { role: 'user', content: { type: 'text', text: 'latest' } },
                    },
                ],
                nextCursor: 'older-cursor-2',
                hasMore: true,
            })
            .mockResolvedValueOnce({
                ok: true,
                items: [
                    {
                        id: 'direct-msg-1',
                        createdAtMs: 1,
                        raw: { role: 'user', content: { type: 'text', text: 'older' } },
                    },
                ],
                nextCursor: null,
                hasMore: false,
            });
        machineDirectSessionTranscriptReadAfterMock.mockResolvedValueOnce({
            ok: true,
            items: [],
            nextCursor: 'tail-cursor-2',
            truncated: false,
        });

        const { sync } = await import('./sync');
        (sync as any).encryption = {
            getSessionEncryption: () => null,
        };
        (sync as any).activeServerSessionIds = new Set<string>([sessionId]);
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = true;

        await (sync as any).fetchMessages(sessionId);
        const result = await (sync as any).loadOlderMessages(sessionId, { limit: 37 });

        expect(result).toEqual({ loaded: 1, hasMore: false, status: 'no_more' });
        expect(machineDirectSessionTranscriptPageMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
            remoteSessionId: 'vendor-session-1',
            cursor: 'older-cursor-2',
            direction: 'older',
            maxItems: 37,
        }), expect.anything());
        const sessionMessages = storage.getState().sessionMessages[sessionId];
        const orderedTexts = (sessionMessages?.messageIdsOldestFirst ?? [])
            .map((id) => sessionMessages?.messagesById[id])
            .filter((message): message is NonNullable<typeof message> => Boolean(message))
            .filter((message) => message.kind === 'user-text')
            .map((message) => message.text);
        expect(orderedTexts).toEqual(['older', 'latest']);
    });

    it('replaces a direct transcript when older paging reports a discontinuity', async () => {
        const sessionId = 'direct_session_discontinuity';
        storage.getState().applySessions([createDirectSession(sessionId)]);
        machineDirectSessionTranscriptPageMock
            .mockResolvedValueOnce({
                ok: true,
                items: [{
                    id: 'stale-direct-msg',
                    createdAtMs: 1,
                    raw: { role: 'user', content: { type: 'text', text: 'stale branch' } },
                }],
                nextCursor: 'stale-older-cursor',
                tailCursor: 'stale-tail-cursor',
                hasMore: true,
            })
            .mockResolvedValueOnce({
                ok: true,
                items: [],
                nextCursor: null,
                tailCursor: 'current-tail-cursor',
                hasMore: false,
                truncated: true,
            })
            .mockResolvedValueOnce({
                ok: true,
                items: [{
                    id: 'current-direct-msg',
                    createdAtMs: 2,
                    raw: { role: 'user', content: { type: 'text', text: 'current branch' } },
                }],
                nextCursor: null,
                tailCursor: 'current-tail-cursor',
                hasMore: false,
            });

        const { sync } = await import('./sync');
        (sync as any).encryption = {
            getSessionEncryption: () => null,
        };
        (sync as any).activeServerSessionIds = new Set<string>([sessionId]);
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = true;

        await (sync as any).fetchMessages(sessionId);
        const result = await (sync as any).loadOlderMessages(sessionId);

        expect(result).toEqual({ loaded: 0, hasMore: false, status: 'not_ready' });
        expect(machineDirectSessionTranscriptPageMock).toHaveBeenNthCalledWith(3, expect.objectContaining({
            remoteSessionId: 'vendor-session-1',
            direction: 'older',
        }), expect.anything());
        expect(machineDirectSessionTranscriptPageMock.mock.calls[2]?.[0]).not.toHaveProperty('cursor');
        const sessionMessages = storage.getState().sessionMessages[sessionId];
        const orderedTexts = (sessionMessages?.messageIdsOldestFirst ?? [])
            .map((id) => sessionMessages?.messagesById[id])
            .filter((message): message is NonNullable<typeof message> => Boolean(message))
            .filter((message) => message.kind === 'user-text')
            .map((message) => message.text);
        expect(orderedTexts).toEqual(['current branch']);
    });

    it.each([true, false])('continues an older direct transcript page limit with legacy truncated=%s', async (truncated) => {
        const sessionId = `direct_session_older_page_limit_${truncated}`;
        storage.getState().applySessions([createDirectSession(sessionId)]);
        machineDirectSessionTranscriptPageMock
            .mockResolvedValueOnce({
                ok: true,
                items: [{ id: 'newer', createdAtMs: 2, raw: { role: 'user', content: { type: 'text', text: 'newer' } } }],
                nextCursor: 'older-page', tailCursor: 'tail', hasMore: true,
            })
            .mockResolvedValueOnce({
                ok: true,
                items: [{ id: 'older', createdAtMs: 1, raw: { role: 'user', content: { type: 'text', text: 'older' } } }],
                nextCursor: null, tailCursor: 'tail', hasMore: false,
                truncated, truncationReason: 'page_limit',
            });
        const { sync } = await import('./sync');
        const internals = sync as unknown as { fetchMessages: (id: string) => Promise<void> };
        await internals.fetchMessages(sessionId);

        await expect(sync.loadOlderMessages(sessionId)).resolves.toMatchObject({
            loaded: 1,
            hasMore: false,
            status: 'no_more',
        });

        expect(machineDirectSessionTranscriptPageMock).toHaveBeenCalledTimes(2);
        const messages = storage.getState().sessionMessages[sessionId];
        expect((messages?.messageIdsOldestFirst ?? []).map((id) => messages?.messagesById[id]?.realID))
            .toEqual(['older', 'newer']);
    });

    it('preserves the accepted direct transcript and cursors when replacement loading fails', async () => {
        const sessionId = 'direct_session_failed_replacement';
        storage.getState().applySessions([createDirectSession(sessionId)]);
        machineDirectSessionTranscriptPageMock.mockResolvedValueOnce({
            ok: true,
            items: [{ id: 'accepted-anchor', createdAtMs: 1, raw: { role: 'user', content: { type: 'text', text: 'accepted anchor' } } }],
            nextCursor: 'accepted-older',
            tailCursor: 'accepted-tail',
            hasMore: true,
        });
        const { sync } = await import('./sync');
        const internals = sync as unknown as {
            fetchMessages: (id: string) => Promise<void>;
            directSessionOlderCursorBySessionId: Map<string, string | null>;
            getDirectSessionTailCursor: (id: string) => string | null;
        };
        await internals.fetchMessages(sessionId);
        const accepted = storage.getState().sessionMessages[sessionId];
        machineDirectSessionTranscriptReadAfterMock.mockResolvedValueOnce({
            ok: true, items: [], nextCursor: 'replacement-tail', truncated: true,
        });
        machineDirectSessionTranscriptPageMock.mockRejectedValueOnce(new Error('machine unavailable'));

        await expect(internals.fetchMessages(sessionId)).rejects.toThrow('machine unavailable');

        expect(storage.getState().sessionMessages[sessionId]).toBe(accepted);
        expect(internals.directSessionOlderCursorBySessionId.get(sessionId)).toBe('accepted-older');
        expect(internals.getDirectSessionTailCursor(sessionId)).toBe('accepted-tail');
    });

    it.each([true, false])('defers direct history catch-up and keeps its anchor on a capped page with legacy truncated=%s', async (truncated) => {
        const sessionId = `direct_history_page_limit_${truncated}`;
        storage.getState().applySessions([createDirectSession(sessionId)]);
        machineDirectSessionTranscriptPageMock.mockResolvedValueOnce({
            ok: true,
            items: [{ id: 'anchor', createdAtMs: 1, raw: { role: 'user', content: { type: 'text', text: 'history anchor' } } }],
            nextCursor: 'older', tailCursor: 'tail-1', hasMore: true,
        });
        const { sync } = await import('./sync');
        const internals = sync as unknown as { fetchMessages: (id: string) => Promise<void> };
        await internals.fetchMessages(sessionId);
        sync.onSessionViewportChange(sessionId, {
            isPinned: false, offsetY: 123, shouldRestoreViewport: true,
            anchor: { kind: 'message', messageId: 'anchor', itemId: 'anchor', itemOffsetPx: 12, capturedAtMs: 1 },
        });
        const accepted = storage.getState().sessionMessages[sessionId];
        const viewport = sync.getSessionViewport(sessionId);
        machineDirectSessionTranscriptPageMock.mockResolvedValue({
            ok: true,
            items: [{ id: 'latest', createdAtMs: 3, raw: { role: 'user', content: { type: 'text', text: 'latest' } } }],
            nextCursor: null, tailCursor: 'latest-tail', hasMore: true,
        });
        machineDirectSessionTranscriptReadAfterMock.mockResolvedValueOnce({
            ok: true,
            items: [{ id: 'adjacent', createdAtMs: 2, raw: { role: 'user', content: { type: 'text', text: 'next history page' } } }],
            nextCursor: 'tail-2', truncated, truncationReason: 'page_limit',
        });

        await internals.fetchMessages(sessionId);
        expect(storage.getState().sessionMessages[sessionId]).toBe(accepted);
        expect(machineDirectSessionTranscriptReadAfterMock).not.toHaveBeenCalled();
        expect(sync.hasDeferredNewerMessages(sessionId)).toBe(true);
        await expect(sync.loadNewerMessages(sessionId)).resolves.toMatchObject({ loaded: 1, hasMore: true });
        expect(Object.values(storage.getState().sessionMessages[sessionId]?.messagesById ?? {}))
            .toEqual(expect.arrayContaining([expect.objectContaining({ realID: 'anchor' }), expect.objectContaining({ realID: 'adjacent' })]));
        expect(sync.getSessionViewport(sessionId)).toBe(viewport);
        expect(machineDirectSessionTranscriptPageMock).toHaveBeenCalledTimes(1);
        expect(requestMock).not.toHaveBeenCalled();
        await internals.fetchMessages(sessionId);
        expect(machineDirectSessionTranscriptReadAfterMock).toHaveBeenCalledTimes(1);
    });

    it.each(['push', 'older page'] as const)('keeps detached history through a source reset from %s until live-tail recovery succeeds', async (source) => {
        const sessionId = `direct_history_source_reset_${source}`;
        storage.getState().applySessions([createDirectSession(sessionId)]);
        // Index/offset cursors can become apparently valid again after a rewritten source regrows.
        machineDirectSessionTranscriptReadAfterMock.mockResolvedValue({
            ok: true, items: [], nextCursor: 'regrown-source-tail', truncated: false,
        });
        machineDirectSessionTranscriptPageMock.mockResolvedValueOnce({
            ok: true,
            items: [{ id: 'old-source', createdAtMs: 1, raw: { role: 'user', content: { type: 'text', text: 'old source' } } }],
            nextCursor: 'older', tailCursor: 'old-tail', hasMore: true,
        });
        const { sync } = await import('./sync');
        const internals = sync as unknown as {
            fetchMessages: (id: string) => Promise<void>;
            handleDirectSessionTranscriptEphemeralUpdate: (update: { sessionId: string; items: []; truncated: true; truncationReason: 'source_discontinuity' }) => Promise<void>;
            sessionViewport: Map<string, { isPinned: boolean }>;
        };
        await internals.fetchMessages(sessionId);
        sync.onSessionViewportChange(sessionId, { isPinned: false, offsetY: 100, shouldRestoreViewport: true });
        const accepted = storage.getState().sessionMessages[sessionId];
        machineDirectSessionTranscriptPageMock.mockResolvedValue({
            ok: true,
            items: [{ id: 'new-source', createdAtMs: 2, raw: { role: 'user', content: { type: 'text', text: 'new source' } } }],
            nextCursor: null, tailCursor: 'new-tail', hasMore: false,
        });
        if (source === 'push') {
            await internals.handleDirectSessionTranscriptEphemeralUpdate({ sessionId, items: [], truncated: true, truncationReason: 'source_discontinuity' });
        } else {
            machineDirectSessionTranscriptPageMock.mockResolvedValueOnce({ ok: true, items: [], nextCursor: null, truncated: true });
            await sync.loadOlderMessages(sessionId);
        }
        expect(storage.getState().sessionMessages[sessionId]).toBe(accepted);
        await expect(sync.loadNewerMessages(sessionId)).resolves.toMatchObject({ loaded: 0, status: 'not_ready' });
        expect(machineDirectSessionTranscriptReadAfterMock).not.toHaveBeenCalled();
        internals.sessionViewport.set(sessionId, { isPinned: true });
        machineDirectSessionTranscriptPageMock.mockRejectedValueOnce(new Error('offline'));
        await expect(internals.fetchMessages(sessionId)).rejects.toThrow('offline');
        expect(storage.getState().sessionMessages[sessionId]).toBe(accepted);
        machineDirectSessionTranscriptPageMock.mockResolvedValueOnce({
            ok: true,
            items: [{ id: 'new-source', createdAtMs: 2, raw: { role: 'user', content: { type: 'text', text: 'new source' } } }],
            nextCursor: null, tailCursor: 'new-tail', hasMore: false,
        });
        await internals.fetchMessages(sessionId);
        expect(Object.values(storage.getState().sessionMessages[sessionId]?.messagesById ?? {}))
            .toEqual([expect.objectContaining({ realID: 'new-source' })]);
        expect(sync.hasDeferredNewerMessages(sessionId)).toBe(false);
    });

    it.each([
        { direction: 'older', change: 'ordinary tail growth' },
        { direction: 'older', change: 'source replacement' },
        { direction: 'forward', change: 'ordinary tail growth' },
        { direction: 'forward', change: 'source replacement' },
        { direction: 'replacement', change: 'source replacement' },
    ] as const)('admits a held $direction direct page only while its accepted window and cursor survive $change', async ({ direction, change }) => {
        const sessionId = `direct_held_${direction}_${change}`;
        storage.getState().applySessions([createDirectSession(sessionId)]);
        const row = (text: string) => ({ id: text, createdAtMs: 1,
            raw: { role: 'user' as const, content: { type: 'text' as const, text } } });
        // Reuse both cursor strings after replacement: byte/index positions
        // alone cannot establish that this is still the same accepted window.
        const page = (text: string) => ({ ok: true as const, items: [row(text)],
            nextCursor: 'same-older', tailCursor: 'same-tail', hasMore: true, truncated: false });
        machineDirectSessionTranscriptPageMock.mockResolvedValueOnce(page('initial'));
        const { sync } = await import('./sync');
        const internals = sync as unknown as {
            fetchMessages: (id: string) => Promise<void>;
            getDirectSessionTailCursor: (id: string) => string | null;
            handleDirectSessionTranscriptEphemeralUpdate: (update: {
                sessionId: string; items: ReturnType<typeof row>[]; fromCursor: string; nextCursor: string;
                truncated: boolean; truncationReason?: 'source_discontinuity' | 'page_limit';
            }) => Promise<void>;
        };
        await internals.fetchMessages(sessionId);
        const held = createDeferred<ReturnType<typeof page>>();
        machineDirectSessionTranscriptPageMock.mockResolvedValue(page('replacement'));
        const readMock = direction === 'forward' ? machineDirectSessionTranscriptReadAfterMock : machineDirectSessionTranscriptPageMock;
        readMock.mockImplementationOnce(() => held.promise);
        const pending = direction === 'older'
            ? sync.loadOlderMessages(sessionId)
            : direction === 'forward'
                ? sync.loadNewerMessages(sessionId)
                : internals.handleDirectSessionTranscriptEphemeralUpdate({
                    sessionId, items: [], fromCursor: 'same-tail', nextCursor: 'grown-tail',
                    truncated: true, truncationReason: 'source_discontinuity',
                });
        await vi.waitFor(() => expect(readMock).toHaveBeenCalledTimes(direction === 'forward' ? 1 : 2));
        await internals.handleDirectSessionTranscriptEphemeralUpdate({
            sessionId, items: change === 'source replacement' ? [] : [row('tail-growth')],
            fromCursor: 'same-tail', nextCursor: 'grown-tail', truncated: change === 'source replacement',
            ...(change === 'source replacement' ? { truncationReason: 'source_discontinuity' as const } : {}),
        });
        const accepted = storage.getState().sessionMessages[sessionId];
        held.resolve(page('held-page'));
        const mustDropHeldPage = change === 'source replacement' || direction === 'forward';
        if (direction === 'replacement') await pending;
        else await expect(pending).resolves.toMatchObject({ loaded: mustDropHeldPage ? 0 : 1 });
        if (mustDropHeldPage) {
            expect(storage.getState().sessionMessages[sessionId]).toBe(accepted);
            expect(Object.values(accepted?.messagesById ?? {}).map((message) => message.realID))
                .toEqual(change === 'source replacement' ? ['replacement'] : ['initial', 'tail-growth']);
            expect(internals.getDirectSessionTailCursor(sessionId))
                .toBe(change === 'source replacement' ? 'same-tail' : 'grown-tail');
        } else {
            expect(Object.values(storage.getState().sessionMessages[sessionId]?.messagesById ?? {}).map((message) => message.realID))
                .toEqual(expect.arrayContaining(['initial', 'tail-growth', 'held-page']));
        }
    });

    it.each(['warmed', 'advanced by a push'] as const)('admits an initial direct snapshot only while its cursor is current when %s', async (change) => {
        const sessionId = `direct_initial_cursor_${change}`;
        storage.getState().applySessions([createDirectSession(sessionId)]);
        const { sync } = await import('./sync');
        const internals = sync as unknown as {
            serverID: string;
            fetchMessages: (id: string) => Promise<void>;
            getDirectSessionTailCursor: (id: string) => string | null;
            setDirectSessionTailCursor: (id: string, cursor: string) => void;
            directSessionTailStateBySessionId: { delete: (id: string) => boolean };
            handleDirectSessionTranscriptEphemeralUpdate: (update: {
                sessionId: string; items: typeof latestPage.items; fromCursor: string; nextCursor: string;
                truncated: false; truncationReason: 'page_limit';
            }) => Promise<void>;
        };
        const server = upsertServerProfile({ serverUrl: 'https://direct-cursor.test', name: 'Direct Cursor' });
        resolvePreferredServerIdForSessionIdMock.mockReturnValue(server.id);
        internals.serverID = 'direct-cursor-account';
        internals.setDirectSessionTailCursor(sessionId, 'persisted-tail');
        // Simulate a cold volatile cursor cache without deleting its durable value.
        internals.directSessionTailStateBySessionId.delete(sessionId);
        if (change === 'advanced by a push') {
            expect(internals.getDirectSessionTailCursor(sessionId)).toBe('persisted-tail');
        }
        const latestPage = {
            ok: true as const,
            items: [{ id: 'latest', createdAtMs: 1, raw: { role: 'user', content: { type: 'text', text: 'latest' } } }],
            nextCursor: null, tailCursor: 'latest-tail', hasMore: false,
        };
        const held = createDeferred<typeof latestPage>();
        machineDirectSessionTranscriptPageMock.mockReturnValueOnce(held.promise);
        const pending = internals.fetchMessages(sessionId);
        await vi.waitFor(() => expect(machineDirectSessionTranscriptPageMock).toHaveBeenCalledTimes(1));
        expect(internals.getDirectSessionTailCursor(sessionId)).toBe('persisted-tail');
        if (change === 'advanced by a push') {
            await internals.handleDirectSessionTranscriptEphemeralUpdate({
                sessionId, items: [{ ...latestPage.items[0]!, id: 'pushed' }],
                fromCursor: 'persisted-tail', nextCursor: 'grown-tail', truncated: false, truncationReason: 'page_limit',
            });
        }
        held.resolve(latestPage);
        await pending;
        if (change === 'warmed') expect(storage.getState().sessionMessages[sessionId]?.isLoaded).toBe(true);
        expect(Object.values(storage.getState().sessionMessages[sessionId]?.messagesById ?? {}).map((message) => message.realID))
            .toEqual(change === 'warmed' ? ['latest'] : ['pushed']);
        expect(internals.getDirectSessionTailCursor(sessionId)).toBe(change === 'warmed' ? 'latest-tail' : 'grown-tail');
    });

    it('resumes only direct transcripts with a current live-content consumer', async () => {
        const hiddenId = 'direct_resume_hidden';
        const visibleId = 'direct_resume_visible';
        storage.getState().applySessions([createDirectSession(hiddenId), createDirectSession(visibleId)]);
        machineDirectSessionTranscriptPageMock.mockResolvedValue({
            ok: true,
            items: [{ id: 'initial', createdAtMs: 1, raw: { role: 'user', content: { type: 'text', text: 'initial' } } }],
            nextCursor: null, tailCursor: 'initial-tail', hasMore: false,
        });
        const { sync } = await import('./sync');
        const internals = sync as unknown as {
            fetchMessages: (id: string) => Promise<void>;
            catchUpLoadedDirectSessionsOnResume: () => Promise<void>;
        };
        await internals.fetchMessages(hiddenId);
        await internals.fetchMessages(visibleId);
        const hiddenMessages = storage.getState().sessionMessages[hiddenId];
        machineDirectSessionTranscriptReadAfterMock.mockResolvedValue({
            ok: true,
            items: [{ id: 'newer', createdAtMs: 2, raw: { role: 'user', content: { type: 'text', text: 'newer' } } }],
            nextCursor: 'newer-tail', truncated: false,
        });
        markSessionVisible(visibleId);
        try {
            await internals.catchUpLoadedDirectSessionsOnResume();
            expect(storage.getState().sessionMessages[hiddenId]).toBe(hiddenMessages);
            expect(Object.values(storage.getState().sessionMessages[visibleId]?.messagesById ?? {}))
                .toContainEqual(expect.objectContaining({ realID: 'newer' }));
        } finally {
            markSessionHidden(visibleId);
        }
    });

    it('refreshes loaded direct session transcripts through the shared messages invalidation path', async () => {
        const sessionId = 'direct_session_refresh';
        storage.getState().applySessions([createDirectSession(sessionId)]);
        machineDirectSessionTranscriptPageMock.mockResolvedValueOnce({
            ok: true,
            items: [
                {
                    id: 'direct-msg-1',
                    createdAtMs: 1,
                    raw: { role: 'user', content: { type: 'text', text: 'hello direct' } },
                },
            ],
            nextCursor: 'older-cursor-1',
            tailCursor: 'page-tail-cursor-1',
            hasMore: false,
        });
        machineDirectSessionTranscriptReadAfterMock
            .mockResolvedValueOnce({
                ok: true,
                items: [
                    {
                        id: 'direct-msg-2',
                        createdAtMs: 2,
                        raw: { role: 'user', content: { type: 'text', text: 'followed direct' } },
                    },
                ],
                nextCursor: 'tail-cursor-2',
                truncated: false,
            });

        const { sync } = await import('./sync');
        (sync as any).encryption = {
            getSessionEncryption: () => null,
        };
        (sync as any).activeServerSessionIds = new Set<string>([sessionId]);
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = true;

        await (sync as any).fetchMessages(sessionId);
        await (sync as any).refreshSessionMessages(sessionId);

        expect(machineDirectSessionTranscriptReadAfterMock).toHaveBeenCalledTimes(1);
        expect(machineDirectSessionTranscriptReadAfterMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
            machineId: 'machine-1',
            remoteSessionId: 'vendor-session-1',
            cursor: 'page-tail-cursor-1',
        }), expect.anything());
        const sessionMessages = storage.getState().sessionMessages[sessionId];
        const orderedTexts = (sessionMessages?.messageIdsOldestFirst ?? [])
            .map((id) => sessionMessages?.messagesById[id])
            .filter((message): message is NonNullable<typeof message> => Boolean(message))
            .filter((message) => message.kind === 'user-text')
            .map((message) => message.text);
        expect(orderedTexts).toEqual(['hello direct', 'followed direct']);
    });

    it.each([
        { truncated: true, continuation: 'bridge' },
        { truncated: false, continuation: 'bridge' },
        { truncated: false, continuation: 'terminal' },
        { truncated: false, continuation: 'stacked' },
        { truncated: false, continuation: 'stalled' },
        { truncated: false, continuation: 'authority switch' },
    ] as const)('merges known capped live direct backlog and walks the gap ($continuation, legacy truncated=$truncated)', async ({ truncated, continuation }) => {
        const sessionId = `direct_session_read_after_page_limit_${truncated}_${continuation}`;
        storage.getState().applySessions([createDirectSession(sessionId)]);
        machineDirectSessionTranscriptPageMock.mockResolvedValueOnce({
            ok: true,
            items: [{ id: 'direct-msg-1', createdAtMs: 1, raw: { role: 'user', content: { type: 'text', text: 'initial direct' } } }],
            nextCursor: 'prefix-older',
            tailCursor: 'tail-cursor-1',
            hasMore: true,
        }).mockResolvedValueOnce({
            ok: true,
            items: [{ id: 'direct-msg-latest', createdAtMs: 10_000, raw: { role: 'user', content: { type: 'text', text: 'latest direct' } } }],
            nextCursor: 'latest-older',
            tailCursor: 'latest-tail',
            hasMore: true,
        });
        machineDirectSessionTranscriptReadAfterMock
            .mockResolvedValueOnce({
                ok: true,
                items: [{ id: 'direct-msg-2', createdAtMs: 2, raw: { role: 'user', content: { type: 'text', text: 'capped direct' } } }],
                nextCursor: 'tail-cursor-2',
                truncated,
                truncationReason: 'page_limit',
            })
            .mockResolvedValueOnce({
                ok: true,
                items: [{ id: 'direct-msg-3', createdAtMs: 3, raw: { role: 'user', content: { type: 'text', text: 'adjacent direct' } } }],
                nextCursor: 'tail-cursor-3',
                truncated: false,
            });

        const { sync } = await import('./sync');
        (sync as any).encryption = { getSessionEncryption: () => null };
        (sync as any).activeServerSessionIds = new Set<string>([sessionId]);
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = true;

        await (sync as any).fetchMessages(sessionId);
        await (sync as any).refreshSessionMessages(sessionId);

        expect(machineDirectSessionTranscriptPageMock).toHaveBeenCalledTimes(1);
        expect(sync.hasDeferredNewerMessages(sessionId)).toBe(true);
        if (!truncated) {
            // A loaded cache can predate raw-page receipts; recover its source witness
            // from the real reducer instead of requiring another complete replay.
            const internals = sync as unknown as {
                directSessionTailStateBySessionId: Map<string, { lastSourceMessageIds?: readonly string[] }>;
            };
            delete internals.directSessionTailStateBySessionId.get(sessionId)?.lastSourceMessageIds;
        }
        await sync.refreshSessionMessages(sessionId);
        expect(machineDirectSessionTranscriptPageMock).toHaveBeenCalledTimes(2);
        expect(sync.hasDeferredNewerMessages(sessionId)).toBe(false);
        expect(machineDirectSessionTranscriptReadAfterMock.mock.calls.map(([request]) => request.cursor))
            .toEqual(['tail-cursor-1']);
        const messages = storage.getState().sessionMessages[sessionId];
        const orderedTexts = (messages?.messageIdsOldestFirst ?? [])
            .map((id) => messages?.messagesById[id])
            .filter((message): message is NonNullable<typeof message> => Boolean(message))
            .filter((message) => message.kind === 'user-text')
            .map((message) => message.text);
        expect(orderedTexts).toEqual(['initial direct', 'capped direct', 'latest direct']);
        const latestId = messages?.reducerState.messageIds.get('direct-msg-latest');
        const boundary = storage.getState().getSessionTailContiguousBoundary(sessionId);
        expect(boundary).toEqual({ kind: 'messageIds', messageIds: [latestId] });
        expect(sync.getSessionTailDiscontinuityOlderAvailability(sessionId)).toBe(true);

        if (continuation === 'authority switch') {
            // Handoff changes the same session's storage authority by replacing
            // its metadata; the hosted transcript cannot inherit opaque cursors.
            storage.getState().applySessions([{ ...createSession(sessionId), encryptionMode: 'plain', seq: 1 }]);
            requestMock.mockResolvedValueOnce(new Response(JSON.stringify({
                messages: [{ id: 'hosted-row', seq: 1, localId: null, createdAt: 20_000,
                    content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hosted' } } } }],
                hasMore: false, nextBeforeSeq: null,
            }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
            markSessionVisible(sessionId);
            try {
                await sync.refreshSessionMessages(sessionId);
            } finally {
                markSessionHidden(sessionId);
            }
            expect(storage.getState().getSessionTailContiguousBoundary(sessionId)).toBeNull();
            expect(sync.getSessionTailDiscontinuityOlderAvailability(sessionId)).toBeNull();
            expect(Object.values(storage.getState().sessionMessages[sessionId]?.messagesById ?? {}).map((message) => message.realID))
                .toEqual(['hosted-row']);
            return;
        }
        if (continuation === 'terminal') {
            machineDirectSessionTranscriptPageMock.mockResolvedValueOnce({
                ok: true, items: [], nextCursor: null, hasMore: false,
            });
            await expect(sync.loadOlderMessages(sessionId)).resolves.toMatchObject({ loaded: 0, hasMore: false });
            const requests = machineDirectSessionTranscriptPageMock.mock.calls.length;
            await expect(sync.loadOlderMessages(sessionId)).resolves.toMatchObject({ loaded: 0, hasMore: false });
            expect(machineDirectSessionTranscriptPageMock).toHaveBeenCalledTimes(requests);
            expect(storage.getState().getSessionTailContiguousBoundary(sessionId)).toEqual(boundary);
            expect(sync.getSessionTailDiscontinuityOlderAvailability(sessionId)).toBe(false);
            return;
        }
        if (continuation === 'stalled') {
            machineDirectSessionTranscriptPageMock.mockResolvedValueOnce({
                ok: true,
                items: [{ id: 'direct-msg-latest', createdAtMs: 10_000, raw: { role: 'user', content: { type: 'text', text: 'latest direct' } } }],
                nextCursor: 'latest-older', hasMore: true,
            });
            const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
            try {
                await expect(sync.loadOlderMessages(sessionId)).resolves.toMatchObject({ loaded: 0, hasMore: true, status: 'not_ready' });
                expect(error).toHaveBeenCalled();
                expect(storage.getState().getSessionTailContiguousBoundary(sessionId)).toEqual(boundary);
            } finally {
                error.mockRestore();
            }
            return;
        }
        if (continuation === 'stacked') {
            // The earlier hypothetical incremental page must not satisfy this new probe.
            machineDirectSessionTranscriptReadAfterMock.mockReset();
            machineDirectSessionTranscriptReadAfterMock.mockResolvedValueOnce({
                ok: true, items: [], nextCursor: 'latest-tail', truncated: false, truncationReason: 'page_limit',
            });
            await sync.refreshSessionMessages(sessionId);
            machineDirectSessionTranscriptPageMock.mockResolvedValueOnce({
                ok: true,
                items: [{ id: 'stacked-latest', createdAtMs: 20_000, raw: { role: 'user', content: { type: 'text', text: 'stacked latest' } } }],
                nextCursor: 'stacked-older', tailCursor: 'stacked-tail', hasMore: true,
            });
            await sync.refreshSessionMessages(sessionId);
            machineDirectSessionTranscriptPageMock.mockResolvedValueOnce({
                ok: true,
                items: [{ id: 'direct-msg-latest', createdAtMs: 10_000, raw: { role: 'user', content: { type: 'text', text: 'latest direct' } } }],
                nextCursor: 'latest-older', hasMore: true,
            });
            await sync.loadOlderMessages(sessionId);
            expect(machineDirectSessionTranscriptPageMock).toHaveBeenLastCalledWith(
                expect.objectContaining({ cursor: 'stacked-older' }), expect.anything(),
            );
            // Reaching the intermediate island does not certify the original hole.
            expect(storage.getState().getSessionTailContiguousBoundary(sessionId)).toEqual(boundary);
        }

        machineDirectSessionTranscriptPageMock.mockResolvedValueOnce({
            ok: true,
            items: [{ id: 'gap-row', createdAtMs: 5, raw: { role: 'user', content: { type: 'text', text: 'gap row' } } }],
            nextCursor: 'gap-next', hasMore: true,
        });
        await sync.loadOlderMessages(sessionId);
        expect(machineDirectSessionTranscriptPageMock).toHaveBeenLastCalledWith(
            expect.objectContaining({ cursor: 'latest-older' }), expect.anything(),
        );
        machineDirectSessionTranscriptPageMock.mockResolvedValueOnce({
            ok: true,
            items: [{ id: 'direct-msg-2', createdAtMs: 2, raw: { role: 'user', content: { type: 'text', text: 'capped direct' } } }],
            nextCursor: 'overlap-page-older', hasMore: true,
        });
        await sync.loadOlderMessages(sessionId);
        expect(machineDirectSessionTranscriptPageMock).toHaveBeenLastCalledWith(
            expect.objectContaining({ cursor: 'gap-next' }), expect.anything(),
        );
        expect(storage.getState().getSessionTailContiguousBoundary(sessionId)).toBeNull();
        expect(sync.getSessionTailDiscontinuityOlderAvailability(sessionId)).toBeNull();
        machineDirectSessionTranscriptPageMock.mockResolvedValueOnce({
            ok: true, items: [], nextCursor: null, hasMore: false,
        });
        await sync.loadOlderMessages(sessionId);
        expect(machineDirectSessionTranscriptPageMock).toHaveBeenLastCalledWith(
            expect.objectContaining({ cursor: 'prefix-older' }), expect.anything(),
        );
    });

    it.each(['snapshot', 'forward', 'push'] as const)('bridges a direct source gap with raw tool-result identity and reveals visible %s tail rows', async (tailSource) => {
        const sessionId = `direct_tool_result_gap_${tailSource}`;
        storage.getState().applySessions([createDirectSession(sessionId)]);
        const toolCall = {
            id: 'source-call', createdAtMs: 1,
            raw: { role: 'agent', content: { type: 'codex', data: {
                type: 'tool-call', id: 'call-event', callId: 'tool-1', name: 'exec', input: {},
            } } },
        };
        const toolResult = (id: string, createdAtMs: number) => ({
            id, createdAtMs,
            raw: { role: 'agent', content: { type: 'codex', data: {
                type: 'tool-call-result', id, callId: 'tool-1', output: id,
            } } },
        });
        machineDirectSessionTranscriptPageMock.mockResolvedValueOnce({
            ok: true, items: [toolCall], nextCursor: 'original-older', tailCursor: 'initial-tail', hasMore: true,
        });
        const { sync } = await import('./sync');
        const internals = sync as unknown as {
            fetchMessages: (id: string) => Promise<void>;
            handleDirectSessionTranscriptEphemeralUpdate: (update: {
                sessionId: string;
                items: Array<{ id: string; createdAtMs: number; raw: { role: string; content: { type: string; text: string } } }>;
                fromCursor: string;
                nextCursor: string;
                truncated: boolean;
            }) => Promise<void>;
        };
        await internals.fetchMessages(sessionId);
        machineDirectSessionTranscriptReadAfterMock.mockResolvedValueOnce({
            ok: true, items: [toolResult('prefix-result', 2)], nextCursor: 'capped-tail', truncated: false, truncationReason: 'page_limit',
        });
        await sync.refreshSessionMessages(sessionId);
        const prefix = storage.getState().sessionMessages[sessionId];
        expect(prefix?.reducerState.messageIds.has('prefix-result')).toBe(false);
        const toolId = prefix?.reducerState.toolIdToMessageId.get('tool-1');
        expect(toolId).toBeDefined();
        const visibleTail = {
            id: 'island-text', createdAtMs: 11, raw: { role: 'user', content: { type: 'text', text: 'latest' } },
        };
        machineDirectSessionTranscriptPageMock.mockResolvedValueOnce({
            ok: true,
            items: [toolResult('island-result', 10), ...(tailSource === 'snapshot' ? [visibleTail] : [])],
            nextCursor: 'island-older', tailCursor: 'island-tail', hasMore: true,
        });
        await sync.refreshSessionMessages(sessionId);
        if (tailSource !== 'snapshot') {
            expect(storage.getState().getSessionTailContiguousBoundary(sessionId))
                .toEqual({ kind: 'messageIds', messageIds: [] });
            if (tailSource === 'forward') {
                machineDirectSessionTranscriptReadAfterMock.mockResolvedValueOnce({
                    ok: true, items: [visibleTail], nextCursor: 'visible-tail', truncated: false,
                });
                await sync.refreshSessionMessages(sessionId);
            } else {
                await internals.handleDirectSessionTranscriptEphemeralUpdate({
                    sessionId, items: [visibleTail], fromCursor: 'island-tail', nextCursor: 'visible-tail', truncated: false,
                });
            }
        }
        const accepted = storage.getState().sessionMessages[sessionId];
        const islandId = accepted?.reducerState.messageIds.get('island-text');
        expect(islandId).toBeDefined();
        expect(accepted?.messagesById[toolId!]).toBeDefined();
        const { resolveTranscriptRenderWindowProjection } = await import('@/components/sessions/transcript/viewport/window/resolveTranscriptRenderWindowProjection');
        const { createTranscriptWindowGapItem } = await import('@/components/sessions/transcript/viewport/window/transcriptWindowGapItem');
        const { collectTranscriptNavigationMessageIdsForItem } = await import('@/components/sessions/transcript/viewport/lifecycle/transcriptRowClassification');
        const items: TranscriptRowShellItem[] = (accepted?.messageIdsOldestFirst ?? []).map((messageId) => ({
            kind: 'message' as const, id: messageId, messageId, createdAt: accepted!.messagesById[messageId].createdAt, seq: null,
        }));
        const projection = resolveTranscriptRenderWindowProjection({
            activeThinkingMessageId: null, createWindowGapItem: createTranscriptWindowGapItem,
            entrySliceWindow: null, expandedToolCallsAnchorMessageIds: new Set<string>(),
            items, listOrientation: 'standard', platformOS: 'web', rendererKind: 'legendList', sessionId,
            targetWindowState: sync.getSessionTargetWindowState(sessionId),
            transcriptNativeHotTailItemCount: 0, transcriptWebHotTailItemCount: 0,
            tailContiguousBoundary: storage.getState().getSessionTailContiguousBoundary(sessionId),
            resolveMessageIds: collectTranscriptNavigationMessageIdsForItem,
        });
        expect(projection.listData.map((item) => item.id))
            .toEqual(['transcript-window-gap:tail:older', islandId]);
        expect(storage.getState().getSessionTailContiguousBoundary(sessionId))
            .toEqual({ kind: 'messageIds', messageIds: [islandId] });
        machineDirectSessionTranscriptPageMock.mockResolvedValueOnce({
            ok: true, items: [toolResult('prefix-result', 2)], nextCursor: 'island-older', hasMore: true,
        });
        // Real raw overlap bridges even when the returned opaque cursor is unchanged.
        await sync.loadOlderMessages(sessionId);
        expect(storage.getState().getSessionTailContiguousBoundary(sessionId)).toBeNull();
        machineDirectSessionTranscriptPageMock.mockResolvedValueOnce({ ok: true, items: [], nextCursor: null, hasMore: false });
        await sync.loadOlderMessages(sessionId);
        expect(machineDirectSessionTranscriptPageMock).toHaveBeenLastCalledWith(
            expect.objectContaining({ cursor: 'original-older' }), expect.anything(),
        );
    });

    it('applies pushed direct-session transcript deltas and advances the tail cursor for fallback paging', async () => {
        const sessionId = 'direct_session_push_delta';
        storage.getState().applySessions([createDirectSession(sessionId)]);
        machineDirectSessionTranscriptPageMock.mockResolvedValueOnce({
            ok: true,
            items: [
                {
                    id: 'direct-msg-1',
                    createdAtMs: 1,
                    raw: { role: 'user', content: { type: 'text', text: 'hello direct' } },
                },
            ],
            nextCursor: 'older-cursor-1',
            tailCursor: 'page-tail-cursor-1',
            hasMore: false,
        });

        const { sync } = await import('./sync');
        (sync as any).encryption = {
            getSessionEncryption: () => null,
        };
        (sync as any).activeServerSessionIds = new Set<string>([sessionId]);
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = true;

        await (sync as any).fetchMessages(sessionId);
        (sync as any).handleEphemeralUpdate({
            type: 'direct-session-transcript-delta',
            sessionId,
            items: [
                {
                    id: 'direct-msg-2',
                    createdAtMs: 2,
                    raw: { role: 'user', content: { type: 'text', text: 'followed direct' } },
                },
            ],
            fromCursor: 'page-tail-cursor-1',
            nextCursor: 'tail-cursor-2',
            truncated: false,
        });
        await new Promise((resolve) => setTimeout(resolve, 0));

        const sessionMessages = storage.getState().sessionMessages[sessionId];
        const orderedTexts = (sessionMessages?.messageIdsOldestFirst ?? [])
            .map((id) => sessionMessages?.messagesById[id])
            .filter((message): message is NonNullable<typeof message> => Boolean(message))
            .filter((message) => message.kind === 'user-text')
            .map((message) => message.text);
        expect(orderedTexts).toEqual(['hello direct', 'followed direct']);

        machineDirectSessionTranscriptReadAfterMock.mockResolvedValueOnce({
            ok: true,
            items: [],
            nextCursor: 'tail-cursor-3',
            truncated: false,
        });
        await (sync as any).refreshSessionMessages(sessionId);

        expect(machineDirectSessionTranscriptReadAfterMock).toHaveBeenCalledTimes(1);
        expect(machineDirectSessionTranscriptReadAfterMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            remoteSessionId: 'vendor-session-1',
            cursor: 'tail-cursor-2',
        }), expect.anything());
    });

    it('anchors an initial tail push and continues later reads from its next cursor', async () => {
        const sessionId = 'direct_session_initial_tail_push';
        storage.getState().applySessions([createDirectSession(sessionId)]);
        const { sync } = await import('./sync');
        (sync as any).encryption = { getSessionEncryption: () => null };
        const internals = sync as unknown as { getDirectSessionTailCursor: (id: string) => string | null };
        (sync as any).handleEphemeralUpdate({
            type: 'direct-session-transcript-delta',
            sessionId,
            items: [{
                id: 'direct-initial-push',
                createdAtMs: 1,
                raw: { role: 'user', content: { type: 'text', text: 'initial pushed direct' } },
            }],
            fromCursor: 'tail',
            nextCursor: 'tail-after-initial-push',
            truncated: false,
        });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(internals.getDirectSessionTailCursor(sessionId)).toBe('tail-after-initial-push');
        expect(Object.values(storage.getState().sessionMessages[sessionId]?.messagesById ?? {}))
            .toContainEqual(expect.objectContaining({ realID: 'direct-initial-push' }));
    });

    it('does not advance a direct-session tail cursor from a discontinuous pushed delta', async () => {
        const sessionId = 'direct_session_push_delta_cursor_gap';
        storage.getState().applySessions([createDirectSession(sessionId)]);
        machineDirectSessionTranscriptPageMock.mockResolvedValueOnce({
            ok: true,
            items: [
                {
                    id: 'direct-msg-1',
                    createdAtMs: 1,
                    raw: { role: 'user', content: { type: 'text', text: 'hello direct' } },
                },
            ],
            nextCursor: 'older-cursor-1',
            tailCursor: 'page-tail-cursor-1',
            hasMore: false,
        });

        const { sync } = await import('./sync');
        (sync as any).encryption = {
            getSessionEncryption: () => null,
        };
        (sync as any).activeServerSessionIds = new Set<string>([sessionId]);
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = true;

        await (sync as any).fetchMessages(sessionId);
        machineDirectSessionTranscriptReadAfterMock.mockResolvedValueOnce({
            ok: true,
            items: [
                {
                    id: 'direct-msg-2',
                    createdAtMs: 2,
                    raw: { role: 'user', content: { type: 'text', text: 'missed direct' } },
                },
                {
                    id: 'direct-msg-3',
                    createdAtMs: 3,
                    raw: { role: 'user', content: { type: 'text', text: 'later pushed direct' } },
                },
            ],
            nextCursor: 'tail-cursor-3',
            truncated: false,
        });
        (sync as any).handleEphemeralUpdate({
            type: 'direct-session-transcript-delta',
            sessionId,
            items: [
                {
                    id: 'direct-msg-3',
                    createdAtMs: 3,
                    raw: { role: 'user', content: { type: 'text', text: 'later pushed direct' } },
                },
            ],
            fromCursor: 'background-tail-cursor-late',
            nextCursor: 'tail-cursor-3',
            truncated: false,
        });
        await vi.waitFor(() => expect(machineDirectSessionTranscriptReadAfterMock).toHaveBeenCalledTimes(1));

        expect(machineDirectSessionTranscriptReadAfterMock).toHaveBeenCalledTimes(1);
        expect(machineDirectSessionTranscriptReadAfterMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            remoteSessionId: 'vendor-session-1',
            cursor: 'page-tail-cursor-1',
        }), expect.anything());

        const sessionMessages = storage.getState().sessionMessages[sessionId];
        const orderedTexts = (sessionMessages?.messageIdsOldestFirst ?? [])
            .map((id) => sessionMessages?.messagesById[id])
            .filter((message): message is NonNullable<typeof message> => Boolean(message))
            .filter((message) => message.kind === 'user-text')
            .map((message) => message.text);
        expect(orderedTexts).toEqual(['hello direct', 'missed direct', 'later pushed direct']);
    });

    it('emits activity ready notifications for pushed direct-session transcript deltas when voice is suppressed', async () => {
        const sessionId = 'direct_session_push_ready_notification';
        storage.getState().applySessions([createDirectSession(sessionId)]);

        const { sync } = await import('./sync');
        (sync as any).encryption = {
            getSessionEncryption: () => null,
        };

        (sync as any).handleEphemeralUpdate({
            type: 'direct-session-transcript-delta',
            sessionId,
            items: [
                {
                    id: 'direct-ready-1',
                    createdAtMs: 2,
                    raw: {
                        role: 'agent',
                        content: {
                            type: 'event',
                            id: 'direct-ready-event-1',
                            data: { type: 'ready' },
                        },
                    },
                },
            ],
            fromCursor: 'tail',
            nextCursor: 'ready-tail-cursor-1',
            truncated: false,
        });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(notifyActivityReadyMock).toHaveBeenCalledWith(sessionId, expect.any(Array));
    });

    it('emits activity notifications for pushed direct-session agent replies without requiring a ready event', async () => {
        const sessionId = 'direct_session_push_agent_reply_notification';
        storage.getState().applySessions([createDirectSession(sessionId)]);

        const { sync } = await import('./sync');
        (sync as any).encryption = {
            getSessionEncryption: () => null,
        };

        (sync as any).handleEphemeralUpdate({
            type: 'direct-session-transcript-delta',
            sessionId,
            items: [
                {
                    id: 'direct-agent-reply-1',
                    createdAtMs: 2,
                    raw: {
                        role: 'agent',
                        content: {
                            type: 'codex',
                            data: {
                                type: 'message',
                                message: 'followed direct reply',
                            },
                        },
                    },
                },
            ],
            fromCursor: 'tail',
            nextCursor: 'agent-reply-tail-cursor-1',
            truncated: false,
        });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(notifyActivityReadyMock).toHaveBeenCalledWith(sessionId, [
            expect.objectContaining({
                kind: 'agent-text',
                text: 'followed direct reply',
            }),
        ]);
    });

    it.each([true, false])('merges known capped live direct backlog after a push with legacy truncated=%s', async (truncated) => {
        const sessionId = `direct_session_truncated_delta_${truncated}`;
        storage.getState().applySessions([createDirectSession(sessionId)]);
        machineDirectSessionTranscriptPageMock.mockResolvedValueOnce({
                ok: true,
                items: [
                    {
                        id: 'direct-msg-1',
                        createdAtMs: 1,
                        raw: { role: 'user', content: { type: 'text', text: 'hello direct' } },
                    },
                ],
                nextCursor: null,
                tailCursor: 'tail-cursor-1',
                hasMore: false,
            });

        const { sync } = await import('./sync');
        (sync as any).encryption = {
            getSessionEncryption: () => null,
        };
        (sync as any).activeServerSessionIds = new Set<string>([sessionId]);
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = true;

        await (sync as any).fetchMessages(sessionId);
        (sync as any).handleEphemeralUpdate({
            type: 'direct-session-transcript-delta',
            sessionId,
            items: [
                {
                    id: 'direct-msg-2',
                    createdAtMs: 2,
                    raw: { role: 'user', content: { type: 'text', text: 'partial direct' } },
                },
            ],
            nextCursor: 'tail-cursor-2',
            fromCursor: 'tail-cursor-1',
            truncated,
            truncationReason: 'page_limit',
        });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(machineDirectSessionTranscriptPageMock).toHaveBeenCalledTimes(1);
        expect(sync.hasDeferredNewerMessages(sessionId)).toBe(true);

        const pushedTexts = (storage.getState().sessionMessages[sessionId]?.messageIdsOldestFirst ?? [])
            .map((id) => storage.getState().sessionMessages[sessionId]?.messagesById[id])
            .filter((message): message is NonNullable<typeof message> => Boolean(message))
            .filter((message) => message.kind === 'user-text')
            .map((message) => message.text);
        expect(pushedTexts).toEqual(['hello direct', 'partial direct']);

        machineDirectSessionTranscriptPageMock.mockResolvedValueOnce({
            ok: true,
            items: [{ id: 'direct-msg-latest', createdAtMs: 10_000, raw: { role: 'user', content: { type: 'text', text: 'latest direct' } } }],
            nextCursor: 'latest-older',
            tailCursor: 'latest-tail',
            hasMore: true,
        });
        machineDirectSessionTranscriptReadAfterMock.mockResolvedValueOnce({
            ok: true,
            items: [{
                id: 'direct-msg-3',
                createdAtMs: 3,
                raw: { role: 'user', content: { type: 'text', text: 'adjacent direct' } },
            }],
            nextCursor: 'tail-cursor-3',
            truncated: false,
        });
        await sync.refreshSessionMessages(sessionId);
        expect(machineDirectSessionTranscriptPageMock).toHaveBeenCalledTimes(2);
        expect(machineDirectSessionTranscriptReadAfterMock).not.toHaveBeenCalled();
        expect(sync.hasDeferredNewerMessages(sessionId)).toBe(false);

        const finalMessages = storage.getState().sessionMessages[sessionId];
        const orderedTexts = (finalMessages?.messageIdsOldestFirst ?? [])
            .map((id) => finalMessages?.messagesById[id])
            .filter((message): message is NonNullable<typeof message> => Boolean(message))
            .filter((message) => message.kind === 'user-text')
            .map((message) => message.text);
        expect(orderedTexts).toEqual(['hello direct', 'partial direct', 'latest direct']);
    });

    it('activates the account settings scope and reloads scoped pending settings for active credentials', async () => {
        const server = upsertServerProfile({ serverUrl: 'https://settings-scope.example', name: 'Settings Scope' });
        setActiveServerId(server.id, { scope: 'device' });
        const scope = createAccountSettingsScope(server.id, 'account-settings-user');
        expect(scope).not.toBeNull();
        saveAccountSettings(scope!, { ...settingsDefaults, viewInline: true }, 7);
        savePendingAccountSettings(scope!, { viewInline: false });

        const { sync } = await import('./sync');
        const credentials = {
            token: buildTokenWithSub('account-settings-user'),
            secret: encodeBase64(new Uint8Array(32).fill(3), 'base64url'),
        };

        (sync as any).activateAccountSettingsScopeForCredentials(credentials);

        expect(storage.getState().settingsScope).toEqual(scope);
        expect(storage.getState().settingsVersion).toBe(7);
        expect(storage.getState().settings.viewInline).toBe(true);
        expect((sync as any).pendingSettingsScope).toEqual(scope);
        expect((sync as any).pendingSettings).toEqual({ viewInline: false });
    });

    it('switches the active account pet library projection when credentials change account scope', async () => {
        const server = upsertServerProfile({ serverUrl: 'https://settings-scope.example', name: 'Settings Scope' });
        setActiveServerId(server.id, { scope: 'device' });

        const { sync } = await import('./sync');

        (sync as any).activateAccountSettingsScopeForCredentials({
            token: buildTokenWithSub('account-a'),
            secret: encodeBase64(new Uint8Array(32).fill(3), 'base64url'),
        });
        storage.getState().upsertAccountPet({
            accountPetId: 'pet-a',
            packageFormat: 'codex-compatible-atlas-v1',
            manifest: {
                id: 'blink-a',
                displayName: 'Blink A',
                description: 'Pet A',
                spritesheetPath: 'spritesheet.webp',
            },
            spritesheetAssetRef: {
                assetId: 'asset-a',
                mediaType: 'image/webp',
                digest: 'sha256:asset-a',
                sizeBytes: 5,
            },
            digest: 'sha256:pkg-a',
            sizeBytes: 128,
            createdAt: 1,
            updatedAt: 2,
            origin: { kind: 'manualImport' },
        });
        expect(Object.keys(storage.getState().accountPetsById)).toEqual(['pet-a']);

        (sync as any).activateAccountSettingsScopeForCredentials({
            token: buildTokenWithSub('account-b'),
            secret: encodeBase64(new Uint8Array(32).fill(4), 'base64url'),
        });

        expect(storage.getState().accountPetsById).toEqual({});
    });

    it('clears the account settings scope when credentials contain a malformed token', async () => {
        const server = upsertServerProfile({ serverUrl: 'https://settings-scope.example', name: 'Settings Scope' });
        setActiveServerId(server.id, { scope: 'device' });
        const scope = createAccountSettingsScope(server.id, 'account-settings-user');
        expect(scope).not.toBeNull();
        saveAccountSettings(scope!, { ...settingsDefaults, viewInline: true }, 7);
        savePendingAccountSettings(scope!, { viewInline: false });

        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const previousDebugFlag = process.env.EXPO_PUBLIC_HAPPIER_DEBUG_SETTINGS_SYNC;

        try {
            const { sync } = await import('./sync');
            (sync as any).activateAccountSettingsScopeForCredentials({
                token: buildTokenWithSub('account-settings-user'),
                secret: encodeBase64(new Uint8Array(32).fill(3), 'base64url'),
            });

            process.env.EXPO_PUBLIC_HAPPIER_DEBUG_SETTINGS_SYNC = '1';
            expect((sync as any).activateAccountSettingsScopeForCredentials({
                token: 'not-a-token',
                secret: encodeBase64(new Uint8Array(32).fill(4), 'base64url'),
            })).toBeNull();

            expect(storage.getState().settingsScope).toBeNull();
            expect(storage.getState().settingsVersion).toBeNull();
            expect(storage.getState().settings.viewInline).toBe(settingsDefaults.viewInline);
            expect(storage.getState().accountPetsById).toEqual({});
            expect((sync as any).pendingSettingsScope).toBeNull();
            expect((sync as any).pendingSettings).toEqual({});
            expect(warnSpy).toHaveBeenCalledWith(
                '[settings-sync] Sync.activateAccountSettingsScopeForCredentials: invalid token',
                expect.objectContaining({ error: expect.stringContaining('Invalid token') }),
            );
        } finally {
            if (previousDebugFlag === undefined) {
                delete process.env.EXPO_PUBLIC_HAPPIER_DEBUG_SETTINGS_SYNC;
            } else {
                process.env.EXPO_PUBLIC_HAPPIER_DEBUG_SETTINGS_SYNC = previousDebugFlag;
            }
            warnSpy.mockRestore();
        }
    });

    it('rejects create credentials with an empty token subject and clears the active settings scope', async () => {
        const server = upsertServerProfile({ serverUrl: 'https://settings-scope.example', name: 'Settings Scope' });
        setActiveServerId(server.id, { scope: 'device' });
        const scope = createAccountSettingsScope(server.id, 'account-settings-user');
        expect(scope).not.toBeNull();
        saveAccountSettings(scope!, { ...settingsDefaults, viewInline: true }, 7);
        savePendingAccountSettings(scope!, { viewInline: false });

        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const previousDebugFlag = process.env.EXPO_PUBLIC_HAPPIER_DEBUG_SETTINGS_SYNC;

        try {
            const { sync } = await import('./sync');
            (sync as any).activateAccountSettingsScopeForCredentials({
                token: buildTokenWithSub('account-settings-user'),
                secret: encodeBase64(new Uint8Array(32).fill(3), 'base64url'),
            });
            storage.getState().upsertAccountPet({
                accountPetId: 'pet-a',
                packageFormat: 'codex-compatible-atlas-v1',
                manifest: {
                    id: 'blink-a',
                    displayName: 'Blink A',
                    description: 'Pet A',
                    spritesheetPath: 'spritesheet.webp',
                },
                spritesheetAssetRef: {
                    assetId: 'asset-a',
                    mediaType: 'image/webp',
                    digest: 'sha256:asset-a',
                    sizeBytes: 5,
                },
                digest: 'sha256:pkg-a',
                sizeBytes: 128,
                createdAt: 1,
                updatedAt: 2,
                origin: { kind: 'manualImport' },
            });

            process.env.EXPO_PUBLIC_HAPPIER_DEBUG_SETTINGS_SYNC = '1';
            await expect(sync.create({
                token: buildTokenWithSub(''),
                secret: encodeBase64(new Uint8Array(32).fill(4), 'base64url'),
            }, {
                anonID: 'anon-empty-sub',
                initializeSessions: async () => undefined,
                getContentPrivateKey: () => new Uint8Array(32).fill(5),
            } as any)).rejects.toThrow('Invalid auth token');

            expect(storage.getState().settingsScope).toBeNull();
            expect(storage.getState().settingsVersion).toBeNull();
            expect(storage.getState().accountPetsById).toEqual({});
            expect((sync as any).pendingSettingsScope).toBeNull();
            expect((sync as any).pendingSettings).toEqual({});
            expect(warnSpy).toHaveBeenCalledWith(
                '[settings-sync] Sync.activateAccountSettingsScopeForCredentials: invalid token',
                expect.objectContaining({ error: expect.stringContaining('sub') }),
            );
        } finally {
            if (previousDebugFlag === undefined) {
                delete process.env.EXPO_PUBLIC_HAPPIER_DEBUG_SETTINGS_SYNC;
            } else {
                process.env.EXPO_PUBLIC_HAPPIER_DEBUG_SETTINGS_SYNC = previousDebugFlag;
            }
            warnSpy.mockRestore();
        }
    });

});
