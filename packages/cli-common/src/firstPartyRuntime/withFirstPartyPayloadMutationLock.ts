import { randomUUID } from 'node:crypto';
import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

import type { FirstPartyInstallLayout } from './installLayout.js';

export class FirstPartyPayloadMutationLockError extends Error {
  readonly code = 'FIRST_PARTY_PAYLOAD_MUTATION_IN_PROGRESS';
  readonly holderPid: number | null;

  constructor(params: Readonly<{ installRoot: string; holderPid: number | null }>) {
    super(
      `Another Happier process is installing or updating '${params.installRoot}'`
      + `${params.holderPid ? ` (pid ${params.holderPid})` : ''}. Try again when it finishes.`,
    );
    this.name = 'FirstPartyPayloadMutationLockError';
    this.holderPid = params.holderPid;
  }
}

function readErrorCode(error: unknown): string | null {
  return error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : null;
}

async function readHolderPid(lockfilePath: string): Promise<number | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(lockfilePath, 'utf8'));
    const pid = parsed && typeof parsed === 'object' ? Number((parsed as { pid?: unknown }).pid) : Number.NaN;
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else — still a live holder.
    return readErrorCode(error) === 'EPERM';
  }
}

/** Create the lock file with its content in one step, so a reader never sees a half-written holder. */
async function tryCreateLockfile(lockfilePath: string, content: string): Promise<boolean> {
  const tempPath = `${lockfilePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, content, 'utf8');
  try {
    await link(tempPath, lockfilePath);
    return true;
  } catch (error) {
    if (readErrorCode(error) === 'EEXIST') return false;
    throw error;
  } finally {
    await rm(tempPath, { force: true });
  }
}

/**
 * The install mutation owner (plan R13 d/f): one process at a time installs into, updates or
 * restores a first-party install root. Same name and call shape as the 0.3 owner; 0.2 has no
 * `proper-lockfile`, so this is the minimal equivalent — a lock file beside the install root that
 * names its holder's pid.
 *
 * A second mutation fails at once with `FIRST_PARTY_PAYLOAD_MUTATION_IN_PROGRESS` rather than
 * waiting: the only concurrent writers are a second click on another surface and an installer run,
 * and either should be told, not queued. A lock whose holder process is gone (a crash, a killed
 * updater) is taken over, so it never needs a staleness timer.
 */
export async function withFirstPartyPayloadMutationLock<T>(params: Readonly<{
  layout: FirstPartyInstallLayout;
  operation: () => Promise<T>;
}>): Promise<T> {
  const { installRoot, happyHomeDir } = params.layout;
  const lockfilePath = `${installRoot}.mutation.lock`;
  await mkdir(happyHomeDir, { recursive: true });
  const content = `${JSON.stringify({ pid: process.pid, acquiredAt: Date.now() })}\n`;

  if (!(await tryCreateLockfile(lockfilePath, content))) {
    const holderPid = await readHolderPid(lockfilePath);
    if (holderPid !== null && holderPid !== process.pid && isProcessAlive(holderPid)) {
      throw new FirstPartyPayloadMutationLockError({ installRoot, holderPid });
    }
    if (holderPid === process.pid) {
      // This process already holds it: a nested mutation would interleave with its own caller.
      throw new FirstPartyPayloadMutationLockError({ installRoot, holderPid });
    }
    await rm(lockfilePath, { force: true });
    if (!(await tryCreateLockfile(lockfilePath, content))) {
      throw new FirstPartyPayloadMutationLockError({ installRoot, holderPid: await readHolderPid(lockfilePath) });
    }
  }

  try {
    return await params.operation();
  } finally {
    await rm(lockfilePath, { force: true });
  }
}
