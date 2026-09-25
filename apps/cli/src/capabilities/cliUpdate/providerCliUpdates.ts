import type { AgentId } from '@happier-dev/agents';
import {
  classifyProviderCliInstall,
  fetchProviderCliLatestVersion,
  resolvePlatformFromNodePlatform,
  type ProviderCliResolutionSource,
} from '@happier-dev/cli-common/providers';
import { AsyncTtlCache } from '@happier-dev/protocol';

import { configuration } from '@/configuration';
import { buildDetectContext } from '@/capabilities/context/buildDetectContext';
import type { Capability, CapabilitiesDetectContextBuilder } from '@/capabilities/service';
import type { CapabilitiesInvokeResponse, CapabilityDetectRequest } from '@/capabilities/types';
import { invokeProviderCliInstall } from '@/runtime/managedTools/invokeProviderCliInstall';
import { logger } from '@/ui/logger';

type InstalledCli = Readonly<{
  command: string;
  source: ProviderCliResolutionSource;
  version: string | null;
}>;

export type ProviderCliUpdatesDeps = Readonly<{
  env?: NodeJS.ProcessEnv;
  nodePlatform?: string;
  buildContext?: CapabilitiesDetectContextBuilder;
  installProviderCli?: Parameters<typeof invokeProviderCliInstall>[0]['installProviderCli'];
  fetchLatestVersion?: (agentId: AgentId) => Promise<string | null>;
  latestVersionTtlMs?: number;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readInstalledCli(data: unknown): InstalledCli | null {
  if (!isRecord(data) || data.available !== true || typeof data.resolvedPath !== 'string') return null;
  const source = data.resolutionSource;
  if (source !== 'system' && source !== 'managed' && source !== 'override') return null;
  return {
    command: data.resolvedPath,
    source,
    version: typeof data.version === 'string' ? data.version : null,
  };
}

/**
 * Adds agent-CLI update facts (contract K6) to a `cli.<agentId>` capability:
 *
 * - detect: `installSource`, `updateSupported`, `updateCommand` for the executable the
 *   capability reports, plus `latestVersion` when `includeLatestVersion` is requested
 *   (cached per daemon for the installables update-check interval; failures are not cached).
 * - invoke `install` with `intent: 'update'`: updates that exact executable through the
 *   provider install owner and succeeds only when a fresh detect reports a different version.
 *
 * Every other request passes through unchanged, so provider-specific capabilities keep
 * their own detect/invoke behavior.
 */
export function withProviderCliUpdates(cap: Capability, agentId: AgentId, deps: ProviderCliUpdatesDeps = {}): Capability {
  const env = deps.env ?? process.env;
  const nodePlatform = deps.nodePlatform ?? process.platform;
  const platform = resolvePlatformFromNodePlatform(nodePlatform);
  const fetchLatestVersion = deps.fetchLatestVersion
    ?? ((id: AgentId) => fetchProviderCliLatestVersion({ providerId: id, env }));
  const latestVersionCache = new AsyncTtlCache<string | null>({
    successTtlMs: deps.latestVersionTtlMs ?? configuration.installablesRuntimeAutoUpdateCheckIntervalMs,
    errorTtlMs: 0,
  });

  const readLatestVersion = async (bypassCache: boolean): Promise<string | null> => {
    const cached = latestVersionCache.get(agentId);
    if (!bypassCache && cached?.kind === 'success' && latestVersionCache.isFresh(cached)) return cached.value;
    return await latestVersionCache.runDedupe(agentId, async () => {
      try {
        const latestVersion = await fetchLatestVersion(agentId);
        latestVersionCache.setSuccess(agentId, latestVersion);
        return latestVersion;
      } catch (error) {
        logger.debug(`[capabilities] latest version lookup failed for ${agentId}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    });
  };

  const detect: Capability['detect'] = async (args) => {
    const data = await cap.detect(args);
    const installed = readInstalledCli(data);
    if (!installed || !platform || !isRecord(data)) return data;

    const params = args.request.params ?? {};
    const facts = classifyProviderCliInstall({
      providerId: agentId,
      command: installed.command,
      source: installed.source,
      platform,
      env,
    });
    return {
      ...data,
      installSource: facts.installSource,
      updateSupported: facts.updateSupported,
      updateCommand: facts.updateCommand,
      ...(params.includeLatestVersion === true
        ? { latestVersion: await readLatestVersion(params.bypassCache === true) }
        : {}),
    };
  };

  const detectFresh = async (): Promise<InstalledCli | null> => {
    const request: CapabilityDetectRequest = { id: cap.descriptor.id, params: { bypassCache: true } };
    const context = await (deps.buildContext ?? buildDetectContext)([request]);
    return readInstalledCli(await cap.detect({ request, context }));
  };

  const update = async (params: Record<string, unknown> | undefined): Promise<CapabilitiesInvokeResponse> => {
    const before = await detectFresh();
    if (!before) {
      return { ok: false, error: { message: `${agentId} is not installed on this machine.`, code: 'update-not-available' } };
    }

    const result = await invokeProviderCliInstall({
      agentId,
      params: {
        intent: 'update',
        updateTarget: { command: before.command, source: before.source },
        allowVendorRecipeExecution: params?.allowVendorRecipeExecution === true,
      },
      env,
      nodePlatform,
      ...(deps.installProviderCli ? { installProviderCli: deps.installProviderCli } : {}),
    });
    if (!result.ok) {
      return {
        ok: false,
        error: { message: result.errorMessage, code: result.errorCode },
        ...(result.logPath ? { logPath: result.logPath } : {}),
      };
    }

    const after = await detectFresh();
    if (!after?.version || after.version === before.version) {
      return {
        ok: false,
        error: {
          message: after?.version
            ? `The update finished, but ${agentId} still reports version ${after.version}.`
            : `The update finished, but ${agentId} no longer reports a version.`,
          code: 'update-not-verified',
        },
        ...(result.logPath ? { logPath: result.logPath } : {}),
      };
    }

    const facts = platform
      ? classifyProviderCliInstall({ providerId: agentId, command: after.command, source: after.source, platform, env })
      : null;
    return {
      ok: true,
      result: {
        previousVersion: before.version,
        version: after.version,
        installSource: facts?.installSource ?? null,
        logPath: result.logPath,
      },
    };
  };

  const invoke: Capability['invoke'] = async (args) => {
    if (args.method === 'install' && args.params?.intent === 'update') {
      return await update(args.params);
    }
    if (cap.invoke) return await cap.invoke(args);
    return { ok: false, error: { message: `Unsupported method: ${args.method}`, code: 'unsupported-method' } };
  };

  return { ...cap, detect, invoke };
}
