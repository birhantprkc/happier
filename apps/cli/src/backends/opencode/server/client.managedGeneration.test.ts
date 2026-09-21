import { createServer, type IncomingMessage, type RequestListener, type ServerResponse } from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';
import { MessageBuffer } from '@/ui/ink/messageBuffer';

import { createOpenCodeServerRuntimeClient } from './client';
import { resolveOpenCodeManagedServerLaunchFingerprint } from './openCodeManagedServerEnv';

type StartedServer = Readonly<{
  baseUrl: string;
  close: () => Promise<void>;
}>;

async function startServer(handler: RequestListener<typeof IncomingMessage, typeof ServerResponse>): Promise<StartedServer> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  return {
    baseUrl: `http://127.0.0.1:${(address satisfies AddressInfo).port}`,
    close: async () => await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

describe('createOpenCodeServerRuntimeClient managed generation authority', () => {
  const servers = new Set<StartedServer>();
  const tempDirs = new Set<string>();
  let envScope = createEnvKeyScope([
    'HAPPIER_OPENCODE_SERVER_STATE_PATH',
    'HAPPIER_OPENCODE_CLI_GENERATION',
    'HAPPIER_OPENCODE_SERVER_URL',
  ] as const);

  afterEach(async () => {
    envScope.restore();
    envScope = createEnvKeyScope([
      'HAPPIER_OPENCODE_SERVER_STATE_PATH',
      'HAPPIER_OPENCODE_CLI_GENERATION',
      'HAPPIER_OPENCODE_SERVER_URL',
    ] as const);
    for (const server of servers) await server.close().catch(() => {});
    servers.clear();
    for (const dir of tempDirs) removeTempDirSync(dir);
    tempDirs.clear();
  });

  it.each([
    ['auto', 'v1', '/api/health', '/session'],
    ['auto', 'v2', '/api/health', '/api/session'],
    ['v2', 'v2', '/api/health', '/api/session'],
  ] as const)('uses the canonical health probe for managed %s identity backed by a %s server', async (
    apiGeneration,
    serverGeneration,
    firstHealthPath,
    expectedSessionPath,
  ) => {
    const paths: string[] = [];
    const server = await startServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      paths.push(path);
      const body = path === '/global/health' && serverGeneration === 'v1'
        ? { healthy: true, version: '1.18.25' }
        : path === '/api/health' && serverGeneration === 'v2'
          ? { healthy: true }
          : path === '/api/session'
            ? { data: [] }
            : path === '/session'
              ? []
              : { error: 'not found' };
      const available = (path === '/global/health' && serverGeneration === 'v1')
        || (path === '/api/health' && serverGeneration === 'v2')
        || path === '/session'
        || path === '/api/session';
      res.writeHead(available ? 200 : 404, {
        'content-type': 'application/json',
      });
      res.end(JSON.stringify(body));
    });
    servers.add(server);

    const dir = createTempDirSync('happier-opencode-generation-');
    tempDirs.add(dir);
    const statePath = join(dir, 'managed-server.json');
    envScope.patch({
      HAPPIER_OPENCODE_SERVER_STATE_PATH: statePath,
      HAPPIER_OPENCODE_CLI_GENERATION: apiGeneration === 'auto' ? 'stable' : 'v2',
      HAPPIER_OPENCODE_SERVER_URL: undefined,
    });
    writeFileSync(statePath, JSON.stringify({
      baseUrl: server.baseUrl,
      pid: process.pid,
      startedAtMs: Date.now(),
      status: 'ready',
      launchEnvFingerprint: resolveOpenCodeManagedServerLaunchFingerprint({
        baseEnv: process.env,
        xdgRootDir: null,
        isolateConfig: false,
      }),
      apiGeneration,
    }));

    const client = await createOpenCodeServerRuntimeClient({
      directory: '/repo',
      messageBuffer: new MessageBuffer(),
    });
    await expect(client.sessionList()).resolves.toEqual([]);
    await client.dispose();

    expect(paths[0]).toBe(firstHealthPath);
    expect(paths).toContain(expectedSessionPath);
    expect(paths).not.toContain(serverGeneration === 'v1' ? '/api/session' : '/session');
  });
});
