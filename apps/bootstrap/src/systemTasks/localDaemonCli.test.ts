import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createSetupCliScope, previewServiceInstall } from './localDaemonCli.js';

describe('previewServiceInstall', () => {
  /**
   * The dry-run decides takeover and ownership conflicts for the relay it is scoped to. Setup runs
   * it before `server set`, so it must be scoped to the relay the app selected through the CLI's
   * own env server selection — never the relay the CLI happens to be configured for (R4).
   */
  it.skipIf(process.platform === 'win32')('runs the dry-run with the CLI scoped to the target relay', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'hsetup-preview-target-relay-'));
    const cliPath = join(rootDir, 'happier');
    try {
      writeFileSync(
        cliPath,
        [
          '#!/bin/sh',
          'printf \'{"ok":true,"plan":{},"takeover":"%s|%s|%s|%s"}\\n\' "$HAPPIER_SERVER_URL" "$HAPPIER_WEBAPP_URL" "$HAPPIER_LOCAL_SERVER_URL" "$HAPPIER_PUBLIC_SERVER_URL"',
          '',
        ].join('\n'),
        'utf8',
      );
      chmodSync(cliPath, 0o755);

      const scope = createSetupCliScope({
        cli: { command: cliPath, provenance: 'managed', version: '0.2.13' },
        target: { serverUrl: 'https://relay-a.example.test', webappUrl: 'https://app-a.example.test', localServerUrl: null },
        processEnv: { ...process.env, HAPPIER_PUBLIC_SERVER_URL: 'https://inherited.example.test', HAPPIER_LOCAL_SERVER_URL: 'http://127.0.0.1:9' },
      });
      const preview = await previewServiceInstall('stable', scope.target);

      expect(preview.takeover).toBe('https://relay-a.example.test|https://app-a.example.test||');
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
