import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AlertButton } from '@/modal';

const alertAsyncSpy = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { alertAsync: alertAsyncSpy } }).module;
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key),
    });
});

import { presentRelayReconciliationConsent } from './presentRelayReconciliationConsent';

function pressButtonLabelled(label: string): void {
    const buttons = (alertAsyncSpy.mock.calls[0] as unknown as [string, string, AlertButton[]])[2];
    const button = buttons.find((entry) => entry.text === label);
    expect(button).toBeTruthy();
    button?.onPress?.();
}

describe('presentRelayReconciliationConsent (UD5)', () => {
    beforeEach(() => {
        alertAsyncSpy.mockClear();
    });

    it('names the selected relay and returns the answer the user chose', async () => {
        alertAsyncSpy.mockImplementationOnce(async () => {
            pressButtonLabelled('setupSurface.relayMoveConfirm');
        });

        await expect(presentRelayReconciliationConsent({ relayUrl: 'https://new.example.test' })).resolves.toBe('move');
        const [title, body] = alertAsyncSpy.mock.calls[0] as unknown as [string, string];
        expect(title).toBe('setupSurface.relayMoveTitle');
        expect(body).toContain('https://new.example.test');
    });

    it('returns "always" only for the remember-this-device choice', async () => {
        alertAsyncSpy.mockImplementationOnce(async () => {
            pressButtonLabelled('setupSurface.relayMoveAlways');
        });

        await expect(presentRelayReconciliationConsent({ relayUrl: 'https://new.example.test' })).resolves.toBe('always');
    });

    it('keeps the service where it is when the alert is dismissed without a choice', async () => {
        await expect(presentRelayReconciliationConsent({ relayUrl: 'https://new.example.test' })).resolves.toBe('keep');
    });

    it('asks about moving the relay in its own words, never the service-replacement copy', async () => {
        // "Replace it" / "Keep the existing service" belong to the executor's ownership consent,
        // which is a different question about a different object.
        alertAsyncSpy.mockImplementationOnce(async () => {
            pressButtonLabelled('setupSurface.relayMoveKeep');
        });

        await expect(presentRelayReconciliationConsent({ relayUrl: 'https://new.example.test' })).resolves.toBe('keep');
        const buttons = (alertAsyncSpy.mock.calls[0] as unknown as [string, string, AlertButton[]])[2];
        expect(buttons.map((entry) => entry.text)).toEqual([
            'setupSurface.relayMoveKeep',
            'setupSurface.relayMoveAlways',
            'setupSurface.relayMoveConfirm',
        ]);
    });
});
