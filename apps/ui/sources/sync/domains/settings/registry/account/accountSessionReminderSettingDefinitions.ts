import { defineSettingDefinitions } from '@happier-dev/protocol';

import { SessionReminderPresetsV1Schema } from '@/sync/domains/session/organization/sessionReminderPreset';

export const ACCOUNT_SESSION_REMINDER_SETTING_DEFINITIONS = defineSettingDefinitions({
    sessionReminderPresetsV1: {
        schema: SessionReminderPresetsV1Schema,
        default: [],
        description: 'Ordered account-synced semantic session reminder presets',
        storageScope: 'account',
    },
});
