import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { basename } from 'node:path';

import { resolveWindowsCommandInvocation } from '@happier-dev/cli-common/process';

import { logger } from '@/ui/logger';
import { resolveOpenCodeCliLaunchSpec } from '@/backends/opencode/utils/resolveOpenCodeCliCommand';

import { resolveOpenCodeServerAuthHeadersFromEnv } from './openCodeServerAuth';
import {
  resolveOpenCodeManagedServerChildEnv,
  OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV,
} from './openCodeManagedServerEnv';
import {
  OPEN_CODE_BROKER_LOAD_NONCE_ENV,
  OPEN_CODE_BROKER_PROVIDERS,
  OPEN_CODE_BROKER_SELECTIONS_ENV,
  parseOpenCodeBrokerSelections,
} from '@/backends/opencode/brokerPlugin/openCodeBrokerPluginEnv';
import {
  ensureOpenCodeBrokerPluginAssets,
  resolveOpenCodeV2BrokerPluginPath,
} from '@/backends/opencode/brokerPlugin/openCodeBrokerPluginAssets';
import { resolveOpenCodeManagedServerTrackedPid } from './resolveOpenCodeManagedServerTrackedPid';
import { terminateManagedOpenCodeServerPidBestEffort } from './terminateManagedOpenCodeServerPidBestEffort';
import { waitForOpenCodeServerHealth } from './waitForOpenCodeServerHealth';
import {
  createOpenCodeManagedServerLogCapture,
  pruneOpenCodeManagedServerLogs,
} from './managedServerLogs';
import { resolveOpenCodeManagedServerStartTimeoutMsFromEnv } from './openCodeManagedServerTimeouts';

async function resolveEphemeralPort(hostname: string): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, hostname, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to resolve ephemeral port')));
        return;
      }
      const port = address.port;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

export function buildOpenCodeV2BrokerConfigContent(
  providers: readonly (typeof OPEN_CODE_BROKER_PROVIDERS)[number][],
): string {
  return JSON.stringify({
    plugin: providers.map((provider) => resolveOpenCodeV2BrokerPluginPath(provider)),
  });
}

/**
 * For connected (config-isolated) sessions only, ensure the Happier-owned config home exists and the
 * broker plugin file(s) referenced by the materialized `OPENCODE_CONFIG_CONTENT` are written. Keyed
 * on the selection-identity env so NATIVE sessions (no selection identity) are a strict no-op and
 * keep loading the user's own config/plugins.
 */
async function ensureConnectedOpenCodeBrokerAssetsBeforeSpawn(
  env: NodeJS.ProcessEnv,
  apiGeneration: 'auto' | 'v2',
): Promise<Readonly<{ brokerLoadNonce: string | null; openCodeConfigContent?: string }>> {
  if (typeof env[OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV] !== 'string') {
    return { brokerLoadNonce: null };
  }
  const selections = parseOpenCodeBrokerSelections(env[OPEN_CODE_BROKER_SELECTIONS_ENV]);
  const providers = OPEN_CODE_BROKER_PROVIDERS.filter((provider) => selections[provider]);
  let brokerLoadNonce: string | null = null;
  if (providers.length > 0) {
    brokerLoadNonce = randomUUID();
    env[OPEN_CODE_BROKER_LOAD_NONCE_ENV] = brokerLoadNonce;
  }
  if (apiGeneration === 'auto') {
    // `opencode` names both the retained V1 line and released V2. Before the
    // health probe can distinguish their wire contracts, prepare each
    // generation's existing discovery path from the same source bytes. V1
    // consumes the auto-discovery leaf; V2 consumes the explicit config leaf.
    await Promise.all([
      ensureOpenCodeBrokerPluginAssets({ providers, apiGeneration: 'v1' }),
      ensureOpenCodeBrokerPluginAssets({ providers, apiGeneration: 'v2' }),
    ]);
  } else {
    await ensureOpenCodeBrokerPluginAssets({ providers, apiGeneration: 'v2' });
  }
  return {
    brokerLoadNonce,
    ...(providers.length > 0 ? {
      openCodeConfigContent: buildOpenCodeV2BrokerConfigContent(providers),
    } : {}),
  };
}

export async function startManagedOpenCodeServer(params: Readonly<{
  hostname?: string;
  port?: number;
  timeoutMs?: number;
  xdgRootDir?: string | null;
  isolateConfig?: boolean;
  /** Override the durable-log directory (defaults to `configuration.logsDir`). */
  logsDir?: string;
  /** Launch fingerprint recorded in the log header for cross-server diagnostics. */
  launchFingerprint?: string;
  onSpawned?: (started: Readonly<{
    baseUrl: string;
    pid: number;
    logPath: string;
    brokerLoadNonce?: string;
    apiGeneration: 'auto' | 'v2';
  }>) => void | Promise<void>;
}> = {}): Promise<{
  baseUrl: string;
  pid: number;
  close: () => Promise<void>;
  logPath: string;
  brokerLoadNonce?: string;
  apiGeneration: 'auto' | 'v2';
}> {
  const hostname = typeof params.hostname === 'string' && params.hostname.trim().length > 0 ? params.hostname.trim() : '127.0.0.1';
  const port = typeof params.port === 'number' && Number.isFinite(params.port) && params.port > 0
    ? Math.floor(params.port)
    : await resolveEphemeralPort(hostname);
  const timeoutMs = typeof params.timeoutMs === 'number' && Number.isFinite(params.timeoutMs) && params.timeoutMs > 0
    ? Math.floor(params.timeoutMs)
    : resolveOpenCodeManagedServerStartTimeoutMsFromEnv(process.env);

  const launch = resolveOpenCodeCliLaunchSpec();
  const cmd = launch.command;
  const args = [...launch.args, `serve`, `--hostname=${hostname}`, `--port=${port}`];
  const healthHeaders = resolveOpenCodeServerAuthHeadersFromEnv();

  logger.debug('[OpenCodeServer] Spawning managed server', { cmd, args });

  const xdgRootDir = typeof params.xdgRootDir === 'string' ? params.xdgRootDir.trim() : '';
  const isolateConfig = params.isolateConfig === true;

  // Connected sessions (selection identity present) are config-isolated: ensure the Happier-owned
  // empty config home exists and write the broker plugin file(s) before spawn. Native sessions have
  // no selection identity ⇒ this is a no-op ⇒ native HOME/XDG/config/plugins remain untouched.
  const brokerAssets = await ensureConnectedOpenCodeBrokerAssetsBeforeSpawn(
    process.env,
    launch.apiGeneration,
  );
  const brokerLoadNonce = brokerAssets.brokerLoadNonce;

  const childEnv = resolveOpenCodeManagedServerChildEnv({
    baseEnv: brokerAssets.openCodeConfigContent
      ? { ...process.env, OPENCODE_CONFIG_CONTENT: brokerAssets.openCodeConfigContent }
      : process.env,
    xdgRootDir: xdgRootDir.length > 0 ? xdgRootDir : null,
    isolateConfig,
  });
  const invocation = resolveWindowsCommandInvocation({
    command: cmd,
    args,
    env: childEnv,
    resolveCommandOnPath: false,
  });

  const proc = spawn(invocation.command, invocation.args, {
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
  const baseUrl = `http://${hostname}:${port}`;
  let trackedPid = proc.pid ?? -1;

  // Durable per-server log: tee post-start stdout/stderr to disk for future incident diagnosis.
  // The data listeners below double as the pipe drain, so the child never blocks on a full pipe.
  const logCapture = createOpenCodeManagedServerLogCapture({
    ...(typeof params.logsDir === 'string' ? { logsDir: params.logsDir } : {}),
    port,
    spawnPid: proc.pid ?? -1,
    commandBasename: basename(cmd),
    args,
    hostname,
    baseUrl,
    ...(typeof params.launchFingerprint === 'string' && params.launchFingerprint.trim().length > 0
      ? { launchFingerprint: params.launchFingerprint.trim() }
      : {}),
  });
  const logPath = logCapture.logPath;

  // Bounded startup buffer (used only for readiness/failure error messages). After readiness we
  // stop growing it but KEEP the listeners so output continues to drain + persist to the log.
  const MAX_STARTUP_OUTPUT_BYTES = 64 * 1024;
  const startupChunks: string[] = [];
  let startupOutputBytes = 0;
  let captureStartupOutput = true;
  const appendStartupOutput = (text: string): void => {
    if (!captureStartupOutput || startupOutputBytes >= MAX_STARTUP_OUTPUT_BYTES) return;
    startupChunks.push(text);
    startupOutputBytes += text.length;
  };
  const readStartupOutput = (): string => startupChunks.join('') || '<no output captured>';
  const onStdout = (chunk: Buffer): void => {
    appendStartupOutput(chunk.toString());
    logCapture.write('stdout', chunk);
  };
  const onStderr = (chunk: Buffer): void => {
    appendStartupOutput(chunk.toString());
    logCapture.write('stderr', chunk);
  };
  proc.stdout?.on('data', onStdout);
  proc.stderr?.on('data', onStderr);

  let closePromise: Promise<void> | null = null;
  const close = async () => {
    if (closePromise) {
      await closePromise;
      return;
    }
    closePromise = (async () => {
      try {
        if (trackedPid > 0) {
          try {
            await terminateManagedOpenCodeServerPidBestEffort(trackedPid);
            return;
          } catch {
            // fall through to direct kill
          }
        }
        try {
          proc.kill();
        } catch {
          // best-effort only
        }
      } finally {
        await logCapture.close().catch(() => {});
      }
    })();
    await closePromise;
  };

  await new Promise<void>((resolve, reject) => {
    const tag = randomUUID();
    const timer = setTimeout(() => {
      void close();
      reject(new Error(`Timeout waiting for OpenCode server to start after ${timeoutMs}ms (${tag}). Log: ${logPath}. Output:\n${readStartupOutput()}`));
    }, timeoutMs);
    timer.unref?.();

    proc.on('exit', (code, signal) => {
      clearTimeout(timer);
      void close();
      const codeLabel = code ?? 'unknown';
      const signalLabel = signal ?? 'none';
      reject(new Error(
        `OpenCode server exited before ready (code=${codeLabel}, signal=${signalLabel}). Log: ${logPath}. Output:
${readStartupOutput()}`,
      ));
    });
    proc.on('error', (error) => {
      clearTimeout(timer);
      void close();
      reject(error);
    });

    void waitForOpenCodeServerHealth({
      baseUrl,
      timeoutMs,
      pollIntervalMs: 200,
      headers: healthHeaders,
      apiGeneration: launch.apiGeneration,
    })
      .then(() => {
        clearTimeout(timer);
        resolve();
      })
      .catch((error) => {
        clearTimeout(timer);
        void close();
        const message = error instanceof Error ? error.message : String(error);
        reject(new Error(`OpenCode server did not become healthy: ${message}. Log: ${logPath}. Output:
${readStartupOutput()}`));
      });
  });

  // Readiness reached: stop growing the bounded startup buffer; the log listeners keep draining and
  // persisting subsequent output (this replaces the old removeAllListeners + resume drain-only path).
  captureStartupOutput = false;

  try {
    trackedPid = await resolveOpenCodeManagedServerTrackedPid({
      spawnPid: proc.pid ?? trackedPid,
      baseUrl,
      invocationCommand: invocation.command,
    });
  } catch {
    // keep the spawned pid best-effort
  }
  logCapture.recordTrackedPid(trackedPid);

  try {
    await params.onSpawned?.({
      baseUrl,
      pid: trackedPid,
      logPath,
      ...(brokerLoadNonce ? { brokerLoadNonce } : {}),
      apiGeneration: launch.apiGeneration,
    });
  } catch (error) {
    await close();
    throw error;
  }

  // Prune old managed-server logs by count (never the just-created one). Best-effort, non-blocking.
  void pruneOpenCodeManagedServerLogs({
    ...(typeof params.logsDir === 'string' ? { logsDir: params.logsDir } : {}),
    keepPath: logPath,
  }).catch(() => {});

  proc.unref?.();
  return {
    baseUrl,
    pid: trackedPid,
    close,
    logPath,
    ...(brokerLoadNonce ? { brokerLoadNonce } : {}),
    apiGeneration: launch.apiGeneration,
  };
}
