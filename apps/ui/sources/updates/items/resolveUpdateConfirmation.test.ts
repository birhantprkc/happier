import { describe, expect, it } from 'vitest';

import { resolveUpdateConfirmation } from './resolveUpdateConfirmation';
import type { UpdateItem } from './updateItem';

const base: UpdateItem = {
    id: 'studio:happier-cli',
    subject: { kind: 'happier-cli' },
    machineId: 'studio',
    title: 'Happier CLI',
    currentVersion: '0.2.12',
    latestVersion: '0.2.14',
    state: 'available',
    progressPercent: null,
    step: null,
    managedBy: 'happier',
    action: { kind: 'run', verb: 'update' },
    failure: null,
    skipped: false,
    vendorUpdater: false,
};

describe('resolveUpdateConfirmation', () => {
    it('asks the same remote question for Retry as for Update (both restart that daemon)', () => {
        expect(resolveUpdateConfirmation(base, 'laptop')).toBe('remote');
        expect(resolveUpdateConfirmation({ ...base, state: 'failed', action: { kind: 'run', verb: 'retry' } }, 'laptop')).toBe('remote');
    });

    it('asks about a vendor updater first, and nothing for local rows', () => {
        expect(resolveUpdateConfirmation({ ...base, vendorUpdater: true }, 'laptop')).toBe('vendor');
        expect(resolveUpdateConfirmation({ ...base, machineId: 'laptop' }, 'laptop')).toBeNull();
        expect(resolveUpdateConfirmation({ ...base, machineId: null, subject: { kind: 'app' } }, 'laptop')).toBeNull();
    });
});
