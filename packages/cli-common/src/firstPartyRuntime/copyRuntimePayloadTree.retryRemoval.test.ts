import { rm } from 'node:fs/promises';

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return {
        ...actual,
        rm: vi.fn(),
    };
});

import { removeRuntimePayloadPath } from './copyRuntimePayloadTree';

describe('removeRuntimePayloadPath', () => {
    beforeEach(() => {
        vi.mocked(rm).mockReset();
    });

    it('retries a transient ENOTEMPTY failure while replacing a runtime payload', async () => {
        vi.mocked(rm)
            .mockRejectedValueOnce(Object.assign(new Error('directory not empty'), { code: 'ENOTEMPTY' }))
            .mockResolvedValueOnce(undefined);

        await expect(removeRuntimePayloadPath('/runtime/payload')).resolves.toBeUndefined();

        expect(rm).toHaveBeenCalledTimes(2);
        expect(rm).toHaveBeenCalledWith('/runtime/payload', { recursive: true, force: true });
    });

    it('keeps retrying Windows executable lock release beyond the short cross-platform cleanup budget', async () => {
        vi.mocked(rm)
            .mockRejectedValueOnce(Object.assign(new Error('access denied'), { code: 'EACCES' }))
            .mockRejectedValueOnce(Object.assign(new Error('access denied'), { code: 'EACCES' }))
            .mockRejectedValueOnce(Object.assign(new Error('access denied'), { code: 'EACCES' }))
            .mockRejectedValueOnce(Object.assign(new Error('access denied'), { code: 'EACCES' }))
            .mockRejectedValueOnce(Object.assign(new Error('access denied'), { code: 'EACCES' }))
            .mockRejectedValueOnce(Object.assign(new Error('access denied'), { code: 'EACCES' }))
            .mockResolvedValueOnce(undefined);

        await expect(removeRuntimePayloadPath('C:\\runtime\\happier-server.exe', 'win32')).resolves.toBeUndefined();

        expect(rm).toHaveBeenCalledTimes(7);
    });
});
