import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveOpenCodeCliLaunchSpec } from './resolveOpenCodeCliCommand';

describe('resolveOpenCodeCliLaunchSpec', () => {
  it('lets the OpenCode generation setting select between co-installed stable and V2 CLIs', () => {
    if (process.platform === 'win32') return;

    const root = mkdtempSync(join(tmpdir(), 'happier-opencode-generation-'));
    const stable = join(root, 'opencode');
    const v2 = join(root, 'opencode2');
    try {
      for (const command of [stable, v2]) {
        writeFileSync(command, '#!/bin/sh\nexit 0\n', 'utf8');
        chmodSync(command, 0o755);
      }

      expect(resolveOpenCodeCliLaunchSpec({ PATH: root, HOME: root })).toMatchObject({
        source: 'system',
        resolvedPath: stable,
        command: stable,
      });
      expect(resolveOpenCodeCliLaunchSpec({
        PATH: root,
        HOME: root,
        HAPPIER_OPENCODE_CLI_GENERATION: 'stable',
      })).toMatchObject({ resolvedPath: stable, command: stable, apiGeneration: 'auto' });
      expect(resolveOpenCodeCliLaunchSpec({
        PATH: root,
        HOME: root,
        HAPPIER_OPENCODE_CLI_GENERATION: 'v2',
      })).toMatchObject({ resolvedPath: v2, command: v2 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps an explicit path authoritative and rejects a conflicting generation selection', () => {
    if (process.platform === 'win32') return;

    const root = mkdtempSync(join(tmpdir(), 'happier-opencode-generation-override-'));
    const stable = join(root, 'opencode');
    const v2 = join(root, 'opencode2');
    try {
      for (const command of [stable, v2]) {
        writeFileSync(command, '#!/bin/sh\nexit 0\n', 'utf8');
        chmodSync(command, 0o755);
      }

      expect(resolveOpenCodeCliLaunchSpec({
        PATH: root,
        HOME: root,
        HAPPIER_OPENCODE_PATH: stable,
        HAPPIER_OPENCODE_CLI_GENERATION: 'v2',
      })).toMatchObject({
        resolvedPath: stable,
        command: stable,
        apiGeneration: 'v2',
      });

      expect(() => resolveOpenCodeCliLaunchSpec({
        PATH: root,
        HOME: root,
        HAPPIER_OPENCODE_PATH: v2,
        HAPPIER_OPENCODE_CLI_GENERATION: 'stable',
      })).toThrow(/explicit OpenCode path.*V2.*stable/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses the preview opencode2 executable for Auto when it is the only installed command', () => {
    if (process.platform === 'win32') return;

    const root = mkdtempSync(join(tmpdir(), 'happier-opencode-auto-preview-'));
    const previewV2 = join(root, 'opencode2');
    try {
      writeFileSync(previewV2, '#!/bin/sh\nexit 0\n', 'utf8');
      chmodSync(previewV2, 0o755);

      expect(resolveOpenCodeCliLaunchSpec({ PATH: root, HOME: root })).toMatchObject({
        resolvedPath: previewV2,
        command: previewV2,
        apiGeneration: 'v2',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses the released opencode executable for explicit V2 when no preview command is installed', () => {
    if (process.platform === 'win32') return;

    const root = mkdtempSync(join(tmpdir(), 'happier-opencode-released-v2-'));
    const releasedV2 = join(root, 'opencode');
    try {
      writeFileSync(releasedV2, '#!/bin/sh\nexit 0\n', 'utf8');
      chmodSync(releasedV2, 0o755);

      expect(resolveOpenCodeCliLaunchSpec({
        PATH: root,
        HOME: root,
        HAPPIER_OPENCODE_CLI_GENERATION: 'v2',
      })).toMatchObject({
        resolvedPath: releasedV2,
        command: releasedV2,
        apiGeneration: 'v2',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
