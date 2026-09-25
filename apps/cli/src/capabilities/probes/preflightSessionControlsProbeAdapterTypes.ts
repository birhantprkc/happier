import type { BackendTargetRefV1, ConnectedServiceBindingsV1 } from '@happier-dev/protocol';
import type { Credentials } from '@/persistence';

export type PreflightSessionControlsProbeFailureCacheStrategy = 'cooldown' | 'retry';
export type PreflightModelsProbeCachePolicy = 'generic' | 'provider-owned';

export type PreflightSessionControlsProbeParams = Readonly<{
  backendTarget?: BackendTargetRefV1;
  cwd: string;
  timeoutMs: number;
  bypassCache?: boolean;
  profileId?: string | null;
  accountSettings?: Readonly<Record<string, unknown>> | null;
  credentials?: Credentials | null;
  connectedServices?: ConnectedServiceBindingsV1 | null;
  processEnv?: NodeJS.ProcessEnv;
}>;

/**
 * Provider-owned adapter for probing dynamic session controls (models/modes/config options)
 * without starting a full ACP session.
 *
 * Models may return an array or { availableModels, source?, observedAt?, refreshError? } when the
 * provider owns cached observation provenance. Null means discovery failed.
 * A models hook owns its complete provider fallback; null does not trigger generic
 * CLI or ACP discovery. Providers without a hook retain the generic discovery path.
 * Callers must normalize/validate all raw payloads.
 */
export type PreflightSessionControlsProbeAdapter = Readonly<{
  connectedServiceAuth?: 'materialized-env';
  modelProbeCachePolicy?: PreflightModelsProbeCachePolicy;
  failureCacheStrategy?: PreflightSessionControlsProbeFailureCacheStrategy;
  probeModelsRaw?: (params: PreflightSessionControlsProbeParams) => Promise<unknown | null>;
  cliModelsCommandArgs?: ReadonlyArray<string>;
  probeModesRaw?: (params: PreflightSessionControlsProbeParams) => Promise<unknown | null>;
  probeConfigOptionsRaw?: (params: PreflightSessionControlsProbeParams) => Promise<unknown | null>;
}>;
