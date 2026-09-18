import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    createSetupServiceConsentPromptData,
    SYSTEM_TASK_PROTOCOL_VERSION,
    type SystemTaskSpec,
} from '@happier-dev/protocol';

import { encodeBase64 } from '@/encryption/base64';
import { renderHook } from '@/dev/testkit';

const mocks = vi.hoisted(() => ({
    serverFetch: vi.fn(),
    getCredentialsForServerUrl: vi.fn(),
}));

// The two genuine boundaries beneath the exchange: the relay (network) and secure storage.
vi.mock('@/sync/http/client', () => ({
    serverFetch: mocks.serverFetch,
}));

vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/auth/storage/tokenStorage')>();
    return {
        ...actual,
        TokenStorage: {
            ...actual.TokenStorage,
            getCredentialsForServerUrl: mocks.getCredentialsForServerUrl,
        },
    };
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

import { createDeterministicSystemTaskBridge, type DeterministicScenarioStep } from './createDeterministicSystemTaskBridge';
import { createSystemTaskRunner } from './createSystemTaskRunner';
import { useThisComputerSetupTask, type SetupServiceConsentPrompt } from './useThisComputerSetupTask';

const RELAY_URL = 'https://relay.example.test';
const SERVER_ID = 'custom-2';
const ACCOUNT_ID = 'account-1';
const SENSITIVE_KEY_PATTERN = /secret|token|password|statefile/i;

function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
}

function buildSetupSpec(): SystemTaskSpec {
    return {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind: 'setup.thisComputer.v1',
        params: {
            activeRelayUrl: RELAY_URL,
            activeWebappUrl: RELAY_URL,
            activeLocalRelayUrl: null,
            channel: 'stable',
            expectedAccountId: ACCOUNT_ID,
            surface: 'desktop.ui',
        },
    };
}

async function advance(ms: number): Promise<void> {
    await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
    });
}

function collectKeys(value: unknown, into: string[] = []): string[] {
    if (Array.isArray(value)) {
        for (const entry of value) collectKeys(entry, into);
    } else if (value && typeof value === 'object') {
        for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
            into.push(key);
            collectKeys(entry, into);
        }
    }
    return into;
}

beforeEach(() => {
    vi.useFakeTimers();
    mocks.serverFetch.mockReset();
    mocks.getCredentialsForServerUrl.mockReset();
    mocks.getCredentialsForServerUrl.mockResolvedValue({
        token: 'app-token',
        encryption: {
            publicKey: encodeBase64(new Uint8Array(32).fill(1)),
            machineKey: encodeBase64(new Uint8Array(32).fill(9)),
        },
    });
    mocks.serverFetch.mockImplementation(async (path: string) => {
        if (String(path).includes('/v1/auth/request/status')) {
            return jsonResponse({ status: 'pending', supportsV2: true });
        }
        return jsonResponse({ ok: true });
    });
});

afterEach(() => {
    vi.useRealTimers();
});

describe('useThisComputerSetupTask automatic approval (R4 / INV2, end to end)', () => {
    it('completes an unauthenticated-CLI setup with no user interaction when the app is authenticated', async () => {
        const bridge = createDeterministicSystemTaskBridge();
        const respondSpy = vi.spyOn(bridge, 'respond');
        const runner = createSystemTaskRunner({ bridge, mode: 'dev' });

        const hook = await renderHook(() => useThisComputerSetupTask({
            runner,
            authRequestApproval: {
                expectedRelayUrl: RELAY_URL,
                expectedAccountId: ACCOUNT_ID,
                serverId: SERVER_ID,
            },
        }));

        await act(async () => {
            await hook.getCurrent().start(buildSetupSpec());
        });

        // Let the whole simulated exchange run: prompt → approval → resume → result.
        await advance(2_000);

        const snapshot = hook.getCurrent().activeTaskSnapshot;
        expect(snapshot?.status).toBe('succeeded');
        expect(snapshot?.awaitingInput).toBe(false);
        // A task result's `machineId` is not readiness and is not read anywhere (INV8): the proof
        // is `verifyCurrentTarget`'s alone.
        expect(snapshot?.result?.ok).toBe(true);

        // The task was answered exactly once, with a boolean and nothing else.
        expect(respondSpy).toHaveBeenCalledTimes(1);
        expect(respondSpy.mock.calls[0]?.[1]).toEqual({ approved: true });

        // The relay received the sealed response, addressed at the app's relay.
        const posted = mocks.serverFetch.mock.calls.find((call) => String(call[0]).endsWith('/v1/auth/response'));
        expect(String(posted?.[0])).toBe(`${RELAY_URL}/v1/auth/response`);

        // The prompt this exchange consumed was raised by the setup task itself.
        const prompts = snapshot?.events.filter((event) => event.type === 'prompt') ?? [];
        expect(prompts).toHaveLength(1);
    });

    it('never places secret, token, password or state-file material in the emitted events', async () => {
        const bridge = createDeterministicSystemTaskBridge();
        const runner = createSystemTaskRunner({ bridge, mode: 'dev' });
        const hook = await renderHook(() => useThisComputerSetupTask({
            runner,
            authRequestApproval: { expectedRelayUrl: RELAY_URL, expectedAccountId: ACCOUNT_ID, serverId: SERVER_ID },
        }));

        await act(async () => {
            await hook.getCurrent().start(buildSetupSpec());
        });
        await advance(2_000);

        const events = hook.getCurrent().activeTaskSnapshot?.events ?? [];
        expect(events.length).toBeGreaterThan(0);
        const keys = collectKeys(events);
        for (const key of keys) {
            expect(key).not.toMatch(SENSITIVE_KEY_PATTERN);
        }
    });

    it('declines the prompt instead of hanging when the caller wired no approval', async () => {
        const bridge = createDeterministicSystemTaskBridge();
        const respondSpy = vi.spyOn(bridge, 'respond');
        const runner = createSystemTaskRunner({ bridge, mode: 'dev' });
        const hook = await renderHook(() => useThisComputerSetupTask({ runner }));

        await act(async () => {
            await hook.getCurrent().start(buildSetupSpec());
        });
        await advance(2_000);

        const snapshot = hook.getCurrent().activeTaskSnapshot;
        expect(respondSpy).toHaveBeenCalledTimes(1);
        expect(respondSpy.mock.calls[0]?.[1]).toEqual({ approved: false, reason: 'approval_unavailable' });
        expect(snapshot?.status).toBe('failed');
        expect(snapshot?.result?.ok === false ? snapshot.result.error.code : null).toBe('pairing_declined');
        expect(mocks.serverFetch).not.toHaveBeenCalled();
    });

    it('refuses a prompt raised for another account, and never reads that account\'s credentials', async () => {
        const bridge = createDeterministicSystemTaskBridge();
        const respondSpy = vi.spyOn(bridge, 'respond');
        const runner = createSystemTaskRunner({ bridge, mode: 'dev' });
        const hook = await renderHook(() => useThisComputerSetupTask({
            runner,
            authRequestApproval: {
                expectedRelayUrl: RELAY_URL,
                expectedAccountId: 'account-other',
                serverId: SERVER_ID,
            },
        }));

        await act(async () => {
            await hook.getCurrent().start(buildSetupSpec());
        });
        await advance(2_000);

        expect(respondSpy).toHaveBeenCalledTimes(1);
        expect(respondSpy.mock.calls[0]?.[1]).toEqual({ approved: false, reason: 'account_mismatch' });
        expect(hook.getCurrent().activeTaskSnapshot?.status).toBe('failed');
        expect(mocks.getCredentialsForServerUrl).not.toHaveBeenCalled();
        expect(mocks.serverFetch).not.toHaveBeenCalled();
    });

    it('refuses a prompt whose relay is not the one the app sent, and the task fails by name', async () => {
        const bridge = createDeterministicSystemTaskBridge();
        const runner = createSystemTaskRunner({ bridge, mode: 'dev' });
        const hook = await renderHook(() => useThisComputerSetupTask({
            runner,
            authRequestApproval: {
                expectedRelayUrl: 'https://other.example.test',
                expectedAccountId: ACCOUNT_ID,
                serverId: SERVER_ID,
            },
        }));

        await act(async () => {
            await hook.getCurrent().start(buildSetupSpec());
        });
        await advance(2_000);

        const snapshot = hook.getCurrent().activeTaskSnapshot;
        expect(snapshot?.status).toBe('failed');
        expect(mocks.getCredentialsForServerUrl).not.toHaveBeenCalled();
        expect(mocks.serverFetch).not.toHaveBeenCalled();
    });
});

describe('useThisComputerSetupTask service consent (UD5 / C6)', () => {
    function createConsentBridge() {
        return createDeterministicSystemTaskBridge({
            buildScenario: (_spec, taskId): DeterministicScenarioStep[] => [
                {
                    delayMs: 10,
                    type: 'prompt',
                    payload: {
                        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                        taskId,
                        tsMs: 10,
                        type: 'prompt',
                        stepId: 'setup.thisComputer.serviceConsent',
                        message: 'Allow Happier to take over the existing background service on this computer?',
                        // The shared wire contract the executor builds through, so this fixture
                        // cannot drift from the live prompt.
                        data: createSetupServiceConsentPromptData({
                            takeover: 'Taking over happier-daemon.',
                            message: 'A pinned service already exists.',
                            competingServices: ['pinned'],
                            servicesToRemove: [],
                        }),
                    },
                },
                {
                    delayMs: 40,
                    type: 'result',
                    payload: { protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION, taskId, ok: true, data: { machineId: 'machine-local-1' } },
                },
            ],
        });
    }

    it('asks the caller once and answers the task with the decision', async () => {
        const bridge = createConsentBridge();
        const respondSpy = vi.spyOn(bridge, 'respond');
        const runner = createSystemTaskRunner({ bridge, mode: 'dev' });
        const seen: SetupServiceConsentPrompt[] = [];
        const hook = await renderHook(() => useThisComputerSetupTask({
            runner,
            onServiceConsentRequired: async (prompt) => {
                seen.push(prompt);
                return true;
            },
        }));

        await act(async () => {
            await hook.getCurrent().start(buildSetupSpec());
        });
        await advance(500);

        expect(seen).toHaveLength(1);
        expect(seen[0]?.message).toBe('A pinned service already exists.');
        expect(seen[0]?.competingServices).toEqual(['pinned']);
        expect(respondSpy).toHaveBeenCalledTimes(1);
        expect(respondSpy.mock.calls[0]?.[1]).toEqual({ approved: true });
        expect(hook.getCurrent().activeTaskSnapshot?.status).toBe('succeeded');
    });

    it('declines by name instead of hanging when nobody can present the consent', async () => {
        const bridge = createConsentBridge();
        const respondSpy = vi.spyOn(bridge, 'respond');
        const runner = createSystemTaskRunner({ bridge, mode: 'dev' });
        const hook = await renderHook(() => useThisComputerSetupTask({ runner }));

        await act(async () => {
            await hook.getCurrent().start(buildSetupSpec());
        });
        await advance(500);

        expect(respondSpy).toHaveBeenCalledTimes(1);
        expect(respondSpy.mock.calls[0]?.[1]).toEqual({ approved: false, reason: 'consent_unavailable' });
        expect(hook.getCurrent().activeTaskSnapshot?.status).toBe('failed');
    });
});
