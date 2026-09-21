import type { DaemonSpawnHooks } from '@/daemon/spawnHooks';
import { resolveOpenCodeCliLaunchSpec } from '@/backends/opencode/utils/resolveOpenCodeCliCommand';

export const opencodeDaemonSpawnHooks: DaemonSpawnHooks = {
  validateSpawn: async () => {
    try {
      resolveOpenCodeCliLaunchSpec();
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  },
};
