import { INSTALLABLE_KEYS } from '@happier-dev/protocol';

import type { AgentCatalogEntry } from '@/backends/types';
import { createCatalogDefinedAcpEntry } from '@/agent/acp/catalog/createCatalogDefinedAcpEntry';
import { createCatalogDefinedAcpBackend } from '@/agent/acp/catalog/createCatalogDefinedAcpBackend';
import type { AccountSettings } from '@happier-dev/protocol';
import { agyDaemonSpawnHooks } from './daemon/spawnHooks';

const genericEntry = createCatalogDefinedAcpEntry('agy');

export const agent = {
  ...genericEntry,
  getCapabilities: async () => (await import('./cli/extraCapabilities')).capabilities,
  getAcpBackendFactory: async () => {
    return async (opts) => {
      const options = opts as Parameters<typeof createCatalogDefinedAcpBackend>[1] & {
        accountSettings?: AccountSettings | null;
      };
      const { ensureAgyAcpServerForLaunch } = await import('./acp/ensureAgyAcpServerForLaunch');
      const launch = await ensureAgyAcpServerForLaunch({
        accountSettings: options.accountSettings,
        env: options.env,
      });
      return { backend: createCatalogDefinedAcpBackend('agy', { ...options, launch }) };
    };
  },
  getDaemonSpawnHooks: async () => agyDaemonSpawnHooks,
  runtimeInstallableKeys: [INSTALLABLE_KEYS.AGY_ACP_SERVER],
} satisfies AgentCatalogEntry;
