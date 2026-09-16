import { spawn } from 'node:child_process';

import { resolveWindowsCommandInvocation } from '@happier-dev/cli-common/process';

type SpawnedProcess = Readonly<{
  exitCode?: number | null;
  once: {
    (event: 'exit', handler: (code: number | null, signal: NodeJS.Signals | null) => void): void;
    (event: 'error', handler: (error: Error) => void): void;
  };
  kill: (signal?: NodeJS.Signals | number) => boolean;
}>;

export type AttachedTerminalSupervisor<TTarget> = Readonly<{
  isAttached: () => boolean;
  attach: (target: TTarget) => Promise<boolean>;
  detach: () => Promise<void>;
  dispose: () => Promise<void>;
}>;

async function waitForStartup(proc: SpawnedProcess): Promise<boolean> {
  if (proc.exitCode !== null && proc.exitCode !== undefined) return false;
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    proc.once('exit', () => finish(false));
    proc.once('error', () => finish(false));
    setImmediate(() => finish(true));
  });
}

async function waitForExit(proc: SpawnedProcess, timeoutMs: number): Promise<boolean> {
  if (proc.exitCode !== null && proc.exitCode !== undefined) return true;
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(false);
    }, timeoutMs);
    timer.unref?.();
    proc.once('exit', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(true);
    });
  });
}

export function createAttachedTerminalSupervisor<TTarget>(params: Readonly<{
  resolveInvocation: (target: TTarget) => Promise<Readonly<{ command: string; args: readonly string[] }>>
    | Readonly<{ command: string; args: readonly string[] }>;
  spawnProcess?: typeof spawn;
  env?: NodeJS.ProcessEnv;
  detachTimeoutMs?: number;
  onExit?: () => void | Promise<void>;
}>): AttachedTerminalSupervisor<TTarget> {
  const spawnProcess = params.spawnProcess ?? spawn;
  const env = params.env ?? process.env;
  const detachTimeoutMs = Math.max(100, Math.min(60_000, params.detachTimeoutMs ?? 3_000));
  let proc: SpawnedProcess | null = null;
  const intentionallyDetached = new WeakSet<SpawnedProcess>();

  const detach = async (): Promise<void> => {
    const child = proc;
    if (!child) return;
    intentionallyDetached.add(child);
    child.kill('SIGINT');
    const exitedGracefully = await waitForExit(child, detachTimeoutMs);
    if (!exitedGracefully) {
      child.kill('SIGKILL');
      await waitForExit(child, detachTimeoutMs);
    }
    if (proc === child) proc = null;
  };

  return {
    isAttached: () => proc !== null,
    attach: async (target) => {
      if (proc) return true;
      const resolution = params.resolveInvocation(target);
      const resolved = resolution && typeof (resolution as PromiseLike<unknown>).then === 'function'
        ? await resolution
        : resolution as Readonly<{ command: string; args: readonly string[] }>;
      const invocation = resolveWindowsCommandInvocation({
        command: resolved.command,
        args: [...resolved.args],
        env,
        resolveCommandOnPath: false,
      });
      const child = spawnProcess(invocation.command, invocation.args, {
        stdio: 'inherit',
        env,
        ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      }) as unknown as SpawnedProcess;
      proc = child;
      let startupCompleted = false;
      let closeHandled = false;
      const handleClosed = (): void => {
        if (closeHandled) return;
        closeHandled = true;
        if (proc === child) proc = null;
        const wasIntentionallyDetached = intentionallyDetached.delete(child);
        if (startupCompleted && !wasIntentionallyDetached) void params.onExit?.();
      };
      child.once('exit', handleClosed);
      child.once('error', handleClosed);
      const started = await waitForStartup(child);
      if (!started) {
        if (proc === child) proc = null;
        return false;
      }
      startupCompleted = true;
      return true;
    },
    detach,
    dispose: detach,
  };
}
