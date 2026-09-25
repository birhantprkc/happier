import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeHappierCliChoice } from '@happier-dev/cli-common/firstPartyRuntime';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveManagedDaemonServiceShimPath } from './resolveDaemonServiceInstallRuntimeTarget';

const tempDirs: string[] = [];

async function createHappierHomeWithManagedShim(): Promise<Readonly<{ processEnv: NodeJS.ProcessEnv; shimPath: string }>> {
  const happierHomeDir = await mkdtemp(join(tmpdir(), 'happier-service-runtime-choice-'));
  tempDirs.push(happierHomeDir);
  const shimPath = join(happierHomeDir, 'bin', process.platform === 'win32' ? 'happier.exe' : 'happier');
  await mkdir(join(happierHomeDir, 'bin'), { recursive: true });
  await writeFile(shimPath, '#!/bin/sh\n', 'utf8');
  return { processEnv: { HAPPIER_HOME_DIR: happierHomeDir }, shimPath };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async (dir) => rm(dir, { recursive: true, force: true })));
});

describe('the managed shim a background service runs (R12)', () => {
  it('is the installed managed shim while this computer has not chosen its own CLI', async () => {
    const { processEnv, shimPath } = await createHappierHomeWithManagedShim();

    expect(await resolveManagedDaemonServiceShimPath({ targetMode: 'default-following', processEnv })).toBe(shimPath);

    await writeHappierCliChoice({ choice: { mode: 'managed' }, processEnv });
    expect(await resolveManagedDaemonServiceShimPath({ targetMode: 'default-following', processEnv })).toBe(shimPath);
  });

  it('is none once this computer chose "Keep my own", so the service runs the CLI that installs it', async () => {
    const { processEnv } = await createHappierHomeWithManagedShim();
    await writeHappierCliChoice({ choice: { mode: 'own', command: '/usr/local/bin/happier' }, processEnv });

    expect(await resolveManagedDaemonServiceShimPath({ targetMode: 'default-following', processEnv })).toBeNull();
    expect(await resolveManagedDaemonServiceShimPath({ targetMode: 'pinned', channel: 'stable', processEnv })).toBeNull();
  });
});
