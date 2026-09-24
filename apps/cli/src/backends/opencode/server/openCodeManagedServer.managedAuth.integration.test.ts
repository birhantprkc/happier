import { statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { writeExecutableShim } from '@/testkit/fs/executableShim';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';

import { startManagedOpenCodeServer } from './openCodeManagedServer';
import { resolveOpenCodeManagedServerStateCredential } from './openCodeManagedServerCredential';
import {
  resolveOpenCodeServerAuthHeaders,
  type OpenCodeServerAuthCredential,
} from './openCodeServerAuth';
import {
  ensureSharedManagedOpenCodeServerBaseUrl,
  stopSharedManagedOpenCodeServerFromEnvBestEffort,
} from './sharedManagedServer';

/**
 * Fake `opencode serve` that mirrors the released OpenCode 2.0.15 server-process contract
 * (`packages/cli/src/server-process.ts` + `packages/server/src/{auth,process}.ts` at
 * 6f3639d82ed0760091792189b78f8eeb44f699b1):
 *  - every default `serve` is password protected: the supplied `OPENCODE_PASSWORD`
 *    (legacy `OPENCODE_SERVER_PASSWORD` as fallback) or a freshly generated random secret,
 *  - the Basic username is fixed to `opencode`,
 *  - `/api/info` is the released readiness surface and is authenticated,
 *  - the generated secret is printed ONLY when no password came from the environment.
 */
const FAKE_OPEN_CODE_V2_SERVE = `#!/usr/bin/env node
const http = require('node:http');
const { randomBytes } = require('node:crypto');

function parseArg(name) {
  const prefix = name + '=';
  const raw = process.argv.find((arg) => typeof arg === 'string' && arg.startsWith(prefix)) || '';
  return raw.slice(prefix.length);
}

const hostname = parseArg('--hostname') || '127.0.0.1';
const port = Number(parseArg('--port') || '0');
if (!Number.isFinite(port) || port <= 0) {
  console.error('missing --port');
  process.exit(2);
}

const environmentPassword = process.env.OPENCODE_PASSWORD || process.env.OPENCODE_SERVER_PASSWORD || '';
const password = environmentPassword || randomBytes(32).toString('base64url');
const expected = 'Basic ' + Buffer.from('opencode:' + password, 'utf8').toString('base64');

const server = http.createServer((req, res) => {
  if ((req.headers.authorization || '') !== expected) {
    res.writeHead(401, { 'www-authenticate': 'Basic realm="Secure Area"' });
    res.end();
    return;
  }
  if (req.url && req.url.startsWith('/api/info')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ version: '2.0.15', pid: process.pid, urls: [], paths: {} }));
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

server.listen(port, hostname, () => {
  console.log('server listening on http://' + hostname + ':' + port);
  if (!environmentPassword) console.log('server password ' + password);
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
`;

const envKeys = [
  'PATH',
  'HOME',
  'HAPPIER_HOME_DIR',
  'HAPPIER_OPENCODE_PATH',
  'HAPPIER_OPENCODE_CLI_GENERATION',
  'HAPPIER_OPENCODE_SERVER_STATE_PATH',
  'OPENCODE_PASSWORD',
  'OPENCODE_SERVER_PASSWORD',
  'OPENCODE_SERVER_USERNAME',
] as const;

const TEMP_DIRS = new Set<string>();
let envScope = createEnvKeyScope(envKeys);

async function prepareManagedServerEnv(): Promise<Readonly<{ root: string; logsDir: string }>> {
  const root = createTempDirSync('happier-opencode-managed-auth-');
  TEMP_DIRS.add(root);
  const shimPath = await writeExecutableShim({
    dir: root,
    fileName: 'fake-opencode',
    contents: FAKE_OPEN_CODE_V2_SERVE,
  });
  process.env.HAPPIER_HOME_DIR = join(root, 'happier-home');
  process.env.HAPPIER_OPENCODE_PATH = shimPath;
  delete process.env.HAPPIER_OPENCODE_SERVER_STATE_PATH;
  delete process.env.OPENCODE_PASSWORD;
  delete process.env.OPENCODE_SERVER_PASSWORD;
  delete process.env.OPENCODE_SERVER_USERNAME;
  return { root, logsDir: join(root, 'logs') };
}

afterEach(() => {
  envScope.restore();
  envScope = createEnvKeyScope(envKeys);
  for (const dir of TEMP_DIRS) removeTempDirSync(dir);
  TEMP_DIRS.clear();
});

describe('startManagedOpenCodeServer managed credential', () => {
  it('reaches readiness against a password-protected server without any password in the environment', async () => {
    const { logsDir } = await prepareManagedServerEnv();

    const started = await startManagedOpenCodeServer({ timeoutMs: 15_000, logsDir });
    try {
      expect(started.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(started.authPassword?.length ?? 0).toBeGreaterThanOrEqual(32);

      const unauthenticated = await fetch(`${started.baseUrl}/api/info`);
      expect(unauthenticated.status).toBe(401);

      // Any later reader of THIS server (reuse probe, restarted daemon, attaching terminal) resolves
      // the credential from the retained state and reaches the same running server.
      const retained = resolveOpenCodeManagedServerStateCredential({
        state: { baseUrl: started.baseUrl, ...(started.authPassword ? { authPassword: started.authPassword } : {}) },
        baseUrl: started.baseUrl,
        env: {},
      });
      expect(retained).toEqual({ username: 'opencode', password: started.authPassword });
      const authenticated = await fetch(`${started.baseUrl}/api/info`, {
        headers: resolveOpenCodeServerAuthHeaders(retained),
      });
      expect(authenticated.status).toBe(200);
    } finally {
      await started.close();
    }
  }, 25_000);

  it('keeps the managed credential out of the durable managed-server log', async () => {
    const { logsDir } = await prepareManagedServerEnv();

    const started = await startManagedOpenCodeServer({ timeoutMs: 15_000, logsDir });
    try {
      const log = await readFile(started.logPath, 'utf8');
      expect(log).toContain('server listening on');
      expect(log).not.toContain('server password');
      expect(log).not.toContain(started.authPassword ?? '<no credential>');
    } finally {
      await started.close();
    }
  }, 25_000);

  it('retains the credential in a private managed-server state file and authenticates the reuse probe', async () => {
    const { root } = await prepareManagedServerEnv();
    const statePath = join(root, 'managed-server.json');
    process.env.HAPPIER_OPENCODE_SERVER_STATE_PATH = statePath;
    const probedCredentials: Array<unknown> = [];

    const probeHealth = async (
      candidateBaseUrl: string,
      _apiGeneration?: 'auto' | 'v2',
      auth?: OpenCodeServerAuthCredential | null,
    ): Promise<boolean> => {
      probedCredentials.push(auth ?? null);
      const response = await fetch(`${candidateBaseUrl}/api/info`, {
        headers: resolveOpenCodeServerAuthHeaders(auth ?? null),
      }).catch(() => null);
      return response?.status === 200;
    };

    const baseUrl = await ensureSharedManagedOpenCodeServerBaseUrl({ probeHealth });
    try {
      const state = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>;
      expect(state.baseUrl).toBe(baseUrl);
      expect(typeof state.authPassword).toBe('string');
      expect((state.authPassword as string).length).toBeGreaterThanOrEqual(32);
      if (process.platform !== 'win32') {
        expect(statSync(statePath).mode & 0o777).toBe(0o600);
      }

      // A second resolution reuses the running server, and the probe that decides reuse authenticates
      // with the retained credential (an unauthenticated probe would 401 and force a replacement).
      const reusedBaseUrl = await ensureSharedManagedOpenCodeServerBaseUrl({ probeHealth });
      expect(reusedBaseUrl).toBe(baseUrl);
      expect(probedCredentials).toEqual([{ username: 'opencode', password: state.authPassword }]);
    } finally {
      await stopSharedManagedOpenCodeServerFromEnvBestEffort();
    }
  }, 30_000);

  it('uses an operator-configured legacy server password instead of minting one', async () => {
    const { logsDir } = await prepareManagedServerEnv();
    process.env.OPENCODE_SERVER_PASSWORD = 'operator-legacy-secret';

    const started = await startManagedOpenCodeServer({ timeoutMs: 15_000, logsDir });
    try {
      // Nothing to retain: the operator credential is re-derived from the environment.
      expect(started.authPassword).toBeUndefined();
      const authenticated = await fetch(`${started.baseUrl}/api/info`, {
        headers: resolveOpenCodeServerAuthHeaders({ username: 'opencode', password: 'operator-legacy-secret' }),
      });
      expect(authenticated.status).toBe(200);
    } finally {
      await started.close();
    }
  }, 25_000);
});
