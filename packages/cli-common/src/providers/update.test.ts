import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { classifyProviderCliInstall, fetchProviderCliLatestVersion } from './update.js';

function writeExecutable(path: string): string {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, '#!/bin/sh\necho 1.0.0\n', { mode: 0o755 });
  return path;
}

describe.skipIf(process.platform === 'win32')('classifyProviderCliInstall', () => {
  let root: string;
  let home: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'happier-provider-cli-update-'));
    home = join(root, 'home');
    mkdirSync(home, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('attributes a launcher linked into the vendor install root to the native updater', () => {
    const versioned = writeExecutable(join(home, '.local', 'share', 'claude', 'versions', '2.1.0'));
    const launcher = join(home, '.local', 'bin', 'claude');
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    symlinkSync(versioned, launcher);

    expect(classifyProviderCliInstall({
      providerId: 'claude',
      command: launcher,
      source: 'system',
      platform: 'linux',
      env: { HOME: home },
    })).toEqual({
      installSource: 'native',
      updateSupported: true,
      updateCommand: `${launcher} update`,
      nativeUpdateArgs: ['update'],
    });
  });

  it('proves an npm global install by the real path and offers only the npm command', () => {
    const packageBin = writeExecutable(join(root, 'prefix', 'lib', 'node_modules', 'opencode-ai', 'bin', 'opencode'));
    const shim = join(root, 'prefix', 'bin', 'opencode');
    mkdirSync(join(root, 'prefix', 'bin'), { recursive: true });
    symlinkSync(packageBin, shim);

    expect(classifyProviderCliInstall({
      providerId: 'opencode',
      command: shim,
      source: 'system',
      platform: 'linux',
      env: { HOME: home },
    })).toEqual({
      installSource: 'npm',
      updateSupported: false,
      updateCommand: 'npm install -g opencode-ai@latest',
      nativeUpdateArgs: null,
    });
  });

  it('names the Homebrew cask that owns the executable', () => {
    const caskBin = writeExecutable(join(root, 'homebrew', 'Caskroom', 'claude-code', '2.1.0', 'claude'));
    const link = join(root, 'homebrew', 'bin', 'claude');
    mkdirSync(join(root, 'homebrew', 'bin'), { recursive: true });
    symlinkSync(caskBin, link);

    expect(classifyProviderCliInstall({
      providerId: 'claude',
      command: link,
      source: 'system',
      platform: 'darwin',
      env: { HOME: home },
    })).toMatchObject({
      installSource: 'brew',
      updateSupported: false,
      updateCommand: 'brew upgrade --cask claude-code',
    });
  });

  it('updates a Happier-managed install through the managed owner and leaves overrides alone', () => {
    expect(classifyProviderCliInstall({
      providerId: 'gemini',
      command: join(home, 'tools', 'gemini'),
      source: 'managed',
      platform: 'linux',
      env: { HOME: home },
    })).toEqual({ installSource: 'managed', updateSupported: true, updateCommand: null, nativeUpdateArgs: null });

    expect(classifyProviderCliInstall({
      providerId: 'claude',
      command: writeExecutable(join(root, 'custom', 'claude')),
      source: 'override',
      platform: 'linux',
      env: { HOME: home },
    })).toEqual({ installSource: 'other', updateSupported: false, updateCommand: null, nativeUpdateArgs: null });
  });
});

describe('fetchProviderCliLatestVersion', () => {
  it('reads the npm registry latest dist-tag for npm-published agents', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request) => new Response(JSON.stringify({ version: '1.14.2' }), { status: 200 }));

    await expect(fetchProviderCliLatestVersion({ providerId: 'claude', deps: { fetchImpl } })).resolves.toBe('1.14.2');
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe('https://registry.npmjs.org/@anthropic-ai%2Fclaude-code/latest');
  });

  it('reads the GitHub latest release tag for release-binary agents', async () => {
    const fetchGitHubLatestRelease = vi.fn(async () => ({ tag_name: 'rust-v0.157.0' }));

    await expect(fetchProviderCliLatestVersion({
      providerId: 'codex',
      deps: { fetchGitHubLatestRelease },
    })).resolves.toBe('0.157.0');
    expect(fetchGitHubLatestRelease).toHaveBeenCalledWith(expect.objectContaining({ githubRepo: 'openai/codex' }));
  });

  it('returns null when the catalog declares no latest-version source and rejects on registry failure', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 503 }));

    await expect(fetchProviderCliLatestVersion({ providerId: 'kiro', deps: { fetchImpl } })).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(fetchProviderCliLatestVersion({ providerId: 'gemini', deps: { fetchImpl } })).rejects.toThrow('503');
  });
});
