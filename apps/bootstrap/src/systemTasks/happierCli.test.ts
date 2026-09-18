import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const { preparePayloadMock, installPayloadMock, runCommandCaptureMock } = vi.hoisted(() => ({
  preparePayloadMock: vi.fn(),
  installPayloadMock: vi.fn(),
  runCommandCaptureMock: vi.fn(),
}));

// Only the two genuine boundaries are replaced: the release download and the payload install that
// writes outside the test's control. Path resolution and the install record it reads stay real, so
// a fixture that does not look like a real install is classified like one.
vi.mock('@happier-dev/cli-common/firstPartyRuntime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happier-dev/cli-common/firstPartyRuntime')>();
  return {
    ...actual,
    prepareFirstPartyComponentPayloadFromGitHubRelease: preparePayloadMock,
    installVersionedPayload: installPayloadMock,
  };
});

/** The on-disk shape `installVersionedPayload` leaves behind: payload, pointer and version record. */
function writeInstalledPayloadFixture(params: Readonly<{
  happyHomeDir: string;
  versionId: string;
  binaryContents: string;
}>): void {
  const installRoot = join(params.happyHomeDir, 'cli');
  const versionPath = join(installRoot, 'versions', params.versionId);
  const currentPath = join(installRoot, 'current');
  for (const dir of [versionPath, currentPath]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'happier'), params.binaryContents, 'utf8');
    chmodSync(join(dir, 'happier'), 0o755);
  }
  writeFileSync(join(installRoot, 'current.version'), `${params.versionId}\n`, 'utf8');
}

vi.mock('./taskRuntime.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./taskRuntime.js')>();
  return {
    ...actual,
    runCommandCapture: runCommandCaptureMock,
  };
});

import { ensureSetupCapableLocalHappierCli, runLocalHappierJsonCommand, SETUP_CLI_VERSION_FLOOR } from './happierCli.js';

afterEach(() => {
  vi.clearAllMocks();
});

describe('runLocalHappierJsonCommand', () => {
  it('acquires the managed happier cli on demand before running local bootstrap commands', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'hsetup-cli-install-'));
    const happyHomeDir = join(rootDir, '.happier-home');
    const payloadRoot = join(rootDir, 'payload');
    const installedBinaryPath = join(payloadRoot, 'happier');

    try {
      mkdirSync(payloadRoot, { recursive: true });
      writeFileSync(
        installedBinaryPath,
        '#!/bin/sh\nprintf \'%s\\n\' \'{"ok":true,"data":{"authenticated":true,"machineId":"machine-auto-installed"}}\'\n',
        'utf8',
      );
      chmodSync(installedBinaryPath, 0o755);
      mkdirSync(join(payloadRoot, 'package-dist'), { recursive: true });
      writeFileSync(join(payloadRoot, 'package-dist', 'index.mjs'), 'export default "machine-auto-installed";\n', 'utf8');

      preparePayloadMock.mockResolvedValue({
        versionId: '1.2.3',
        payloadRoot,
        cleanup: async () => {},
      });
      installPayloadMock.mockImplementation(async (params: Readonly<{
        processEnv?: NodeJS.ProcessEnv;
        versionId: string;
      }>) => {
        writeInstalledPayloadFixture({
          happyHomeDir: String(params.processEnv?.HAPPIER_HOME_DIR ?? happyHomeDir),
          versionId: params.versionId,
          binaryContents: '#!/bin/sh\nprintf \'%s\\n\' \'{"ok":true,"data":{"authenticated":true,"machineId":"machine-auto-installed"}}\'\n',
        });
      });
      runCommandCaptureMock.mockResolvedValue({
        status: 0,
        stdout: '{"ok":true,"data":{"authenticated":true,"machineId":"machine-auto-installed"}}\n',
        stderr: '',
      });

      await expect(runLocalHappierJsonCommand({
        releaseRing: 'stable',
        args: ['auth', 'status', '--json'],
        processEnv: {
          ...process.env,
          HAPPIER_HOME_DIR: happyHomeDir,
        },
      })).resolves.toMatchObject({
        ok: true,
        data: {
          authenticated: true,
          machineId: 'machine-auto-installed',
        },
      });
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('treats a signal-terminated happier process as a failed command', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'hsetup-cli-signal-'));
    const cliPath = join(rootDir, 'fake-happier');

    try {
      writeFileSync(cliPath, '#!/usr/bin/env node\nprocess.kill(process.pid, "SIGTERM");\n', 'utf8');
      chmodSync(cliPath, 0o755);
      runCommandCaptureMock.mockResolvedValue({
        status: 1,
        stdout: '',
        stderr: '',
      });

      await expect(runLocalHappierJsonCommand({
        releaseRing: 'stable',
        args: ['auth', 'status', '--json'],
        processEnv: {
          ...process.env,
          HAPPIER_BOOTSTRAP_CLI_PATH: cliPath,
        },
      })).rejects.toMatchObject({
        code: 'cli_command_failed',
      });
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('treats ok:false json responses as failed commands', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'hsetup-cli-json-failure-'));
    const cliPath = join(rootDir, 'fake-happier');

    try {
      writeFileSync(
        cliPath,
        '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ ok: false, error: { code: "not_installed" }, message: "service missing" }) + "\\n");\n',
        'utf8',
      );
      chmodSync(cliPath, 0o755);
      runCommandCaptureMock.mockResolvedValue({
        status: 0,
        stdout: '{"ok":false,"error":{"code":"not_installed"},"message":"service missing"}\n',
        stderr: '',
      });

      await expect(runLocalHappierJsonCommand({
        releaseRing: 'stable',
        args: ['daemon', 'service', 'start', '--json'],
        processEnv: {
          ...process.env,
          HAPPIER_BOOTSTRAP_CLI_PATH: cliPath,
        },
      })).rejects.toMatchObject({
        code: 'cli_command_failed',
        message: 'service missing',
      });
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('returns ok:false json envelopes when allowJsonFailure is set even if the CLI exits non-zero', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'hsetup-cli-json-exit-1-'));
    const cliPath = join(rootDir, 'fake-happier');

    try {
      writeFileSync(
        cliPath,
        '#!/usr/bin/env node\nprocess.exitCode = 1;\nprocess.stdout.write(JSON.stringify({ ok: false, kind: "auth_status", error: { code: "not_authenticated" } }) + "\\n");\n',
        'utf8',
      );
      chmodSync(cliPath, 0o755);
      runCommandCaptureMock.mockResolvedValue({
        status: 1,
        stdout: '{"ok":false,"kind":"auth_status","error":{"code":"not_authenticated"}}\n',
        stderr: '',
      });

      await expect(runLocalHappierJsonCommand({
        releaseRing: 'stable',
        args: ['auth', 'status', '--json'],
        allowJsonFailure: true,
        processEnv: {
          ...process.env,
          HAPPIER_BOOTSTRAP_CLI_PATH: cliPath,
        },
      })).resolves.toMatchObject({
        ok: false,
        kind: 'auth_status',
        error: {
          code: 'not_authenticated',
        },
      });
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

describe('ensureSetupCapableLocalHappierCli', () => {
  function withOverrideCli(run: (params: Readonly<{ cliPath: string; processEnv: NodeJS.ProcessEnv }>) => Promise<void>) {
    const rootDir = mkdtempSync(join(tmpdir(), 'hsetup-setup-floor-'));
    const cliPath = join(rootDir, 'happier-override');
    writeFileSync(cliPath, '#!/bin/sh\nprintf "0.2.13\\n"\n', 'utf8');
    chmodSync(cliPath, 0o755);
    return run({
      cliPath,
      processEnv: { ...process.env, HAPPIER_HOME_DIR: join(rootDir, 'home'), HAPPIER_BOOTSTRAP_CLI_PATH: cliPath },
    }).finally(() => rmSync(rootDir, { recursive: true, force: true }));
  }

  it('reports an env-resolved CLI as an override and never reacquires it, even below the floor', async () => {
    await withOverrideCli(async ({ cliPath, processEnv }) => {
      const readVersion = vi.fn(async () => '0.2.12');
      await expect(ensureSetupCapableLocalHappierCli({ releaseRing: 'stable', processEnv }, { readVersion }))
        .rejects.toMatchObject({ code: 'cli_override_below_setup_floor' });
      expect(preparePayloadMock).not.toHaveBeenCalled();

      readVersion.mockResolvedValue(`${SETUP_CLI_VERSION_FLOOR}-dev.4`);
      await expect(ensureSetupCapableLocalHappierCli({ releaseRing: 'stable', processEnv }, { readVersion }))
        .resolves.toEqual({ command: cliPath, provenance: 'override', version: `${SETUP_CLI_VERSION_FLOOR}-dev.4` });
    });
  });

  /**
   * The release path knows the newest version on the ring before it writes anything, so a ring
   * that cannot satisfy the floor must fail there. Installing it first would re-download and
   * re-promote a CLI setup cannot drive, on every attempt, and then fail anyway.
   */
  it('fails without installing when the ring\'s newest CLI is below the floor', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'hsetup-setup-floor-managed-'));
    const happyHomeDir = join(rootDir, '.happier-home');
    try {
      writeInstalledPayloadFixture({
        happyHomeDir,
        versionId: '0.2.12',
        binaryContents: '#!/bin/sh\nprintf "0.2.12\\n"\n',
      });
      preparePayloadMock.mockResolvedValue({ versionId: '0.2.12', payloadRoot: rootDir, cleanup: async () => {} });
      installPayloadMock.mockResolvedValue(undefined);
      const readVersion = vi.fn(async () => '0.2.12');
      const processEnv = { ...process.env, HAPPIER_HOME_DIR: happyHomeDir };

      await expect(ensureSetupCapableLocalHappierCli({ releaseRing: 'stable', processEnv }, { readVersion }))
        .rejects.toMatchObject({ code: 'cli_below_setup_floor' });
      expect(preparePayloadMock).toHaveBeenCalledTimes(1);
      expect(installPayloadMock).not.toHaveBeenCalled();
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('reacquires a managed CLI below the floor when the ring has a newer one', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'hsetup-setup-floor-reacquire-'));
    const happyHomeDir = join(rootDir, '.happier-home');
    const binaryPath = join(happyHomeDir, 'cli', 'current', 'happier');
    try {
      writeInstalledPayloadFixture({
        happyHomeDir,
        versionId: '0.2.12',
        binaryContents: '#!/bin/sh\nprintf "0.2.12\\n"\n',
      });
      preparePayloadMock.mockResolvedValue({ versionId: SETUP_CLI_VERSION_FLOOR, payloadRoot: rootDir, cleanup: async () => {} });
      installPayloadMock.mockResolvedValue(undefined);
      const readVersion = vi.fn()
        .mockResolvedValueOnce('0.2.12')
        .mockResolvedValueOnce(SETUP_CLI_VERSION_FLOOR);
      const processEnv = { ...process.env, HAPPIER_HOME_DIR: happyHomeDir };

      await expect(ensureSetupCapableLocalHappierCli({ releaseRing: 'stable', processEnv }, { readVersion }))
        .resolves.toEqual({ command: binaryPath, provenance: 'managed', version: SETUP_CLI_VERSION_FLOOR });
      expect(installPayloadMock).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
