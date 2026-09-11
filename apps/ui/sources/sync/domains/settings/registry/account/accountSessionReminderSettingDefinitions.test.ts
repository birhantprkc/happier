import { describe, expect, it } from 'vitest';

import { ACCOUNT_SESSION_REMINDER_SETTING_DEFINITIONS } from './accountSessionReminderSettingDefinitions';

describe('ACCOUNT_SESSION_REMINDER_SETTING_DEFINITIONS', () => {
    it('owns semantic reminder presets as an account-synced ordered collection', () => {
        const definition = ACCOUNT_SESSION_REMINDER_SETTING_DEFINITIONS.sessionReminderPresetsV1;
        expect(definition.storageScope).toBe('account');
        expect(definition.default).toEqual([]);
        expect(definition.schema.parse([
            { rule: { kind: 'relative_day', daysAhead: 1, minuteOfDay: 14 * 60 } },
        ])).toEqual([
            { rule: { kind: 'relative_day', daysAhead: 1, minuteOfDay: 14 * 60 } },
        ]);
    });
});
