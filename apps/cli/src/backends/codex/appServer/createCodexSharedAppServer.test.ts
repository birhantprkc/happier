import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { createCodexSharedAppServer } from './createCodexSharedAppServer';

describe('createCodexSharedAppServer', () => {
  it('owns one socket app-server and gives Happier clients WebSocket transports to that server', async () => {
    const child = Object.assign(new EventEmitter(), { pid: 42, stderr: new EventEmitter() });
    const spawnProcess = vi.fn(() => child as never);
    const createClient = vi.fn(async (params: unknown) => ({ params, dispose: vi.fn() }));
    const terminateProcess = vi.fn(async () => undefined);
    const removeRuntimeDirectory = vi.fn(async () => undefined);
    const waitForSocket = vi.fn(async () => undefined);

    const server = await createCodexSharedAppServer({
      directory: '/workspace',
      processEnv: {
        HOME: '/home/test',
        HAPPIER_CODEX_APP_SERVER_STARTUP_RPC_TIMEOUT_MS: '90000',
      },
      configOverrides: ['model="gpt-5"'],
      dependencies: {
        createRuntimeDirectory: async () => '/tmp/happier-codex-private',
        resolveInvocation: async ({ args }) => ({ command: '/usr/bin/codex', args }),
        spawnProcess,
        waitForSocket,
        createClient: createClient as never,
        terminateProcess,
        removeRuntimeDirectory,
      },
    });

    expect(server.endpoint).toBe('unix:///tmp/happier-codex-private/private/app-server.sock');
    expect(spawnProcess).toHaveBeenCalledWith(
      '/usr/bin/codex',
      [
        'app-server', '--listen', 'unix:///tmp/happier-codex-private/private/app-server.sock',
        '-c', 'model="gpt-5"',
      ],
      expect.objectContaining({ cwd: '/workspace', stdio: ['ignore', 'ignore', 'pipe'] }),
    );
    expect(waitForSocket).toHaveBeenCalledWith(
      '/tmp/happier-codex-private/private/app-server.sock',
      child,
      90_000,
    );

    await server.createClient();
    expect(createClient).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/workspace',
      transport: { kind: 'unixWebSocket', socketPath: '/tmp/happier-codex-private/private/app-server.sock' },
    }));

    await server.dispose();
    expect(terminateProcess).toHaveBeenCalledWith(child);
    expect(removeRuntimeDirectory).toHaveBeenCalledWith('/tmp/happier-codex-private');
  });
});
