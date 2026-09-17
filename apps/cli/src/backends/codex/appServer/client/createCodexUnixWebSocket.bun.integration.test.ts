import { execFile, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws-node';

import { withTempDir } from '@/testkit/fs/tempDir';

const bunExecutable = process.env.HAPPIER_TEST_BUN_EXECUTABLE?.trim() || 'bun';
const bunAvailable = spawnSync(bunExecutable, ['--version'], { encoding: 'utf8' }).status === 0;

describe('Codex Unix WebSocket under Bun', () => {
    it.skipIf(!bunAvailable && !process.env.CI).each(['source', 'bundle'] as const)('%s exchanges frames over IPC without negotiating compression', async (mode) => {
        await withTempDir('codex-ws-', async (root) => {
            const socketPath = process.platform === 'win32'
                ? `\\\\.\\pipe\\codex-ws-${process.pid}-${Date.now()}`
                : join(root, 'with space.sock');
            const server = createServer();
            const webSocketServer = new WebSocketServer({ server });
            const extensions: Array<string | string[] | undefined> = [];
            server.on('upgrade', (request) => extensions.push(request.headers['sec-websocket-extensions']));
            webSocketServer.on('connection', (socket) => {
                socket.on('message', (payload) => {
                    if (String(payload) === 'ping') socket.send('pong');
                });
            });

            try {
                await new Promise<void>((resolve, reject) => {
                    server.once('error', reject);
                    server.listen(socketPath, resolve);
                });
                const ownerPath = fileURLToPath(new URL('./createCodexUnixWebSocket.ts', import.meta.url));
                const loadOwner = mode === 'source'
                    ? `const { createCodexUnixWebSocket } = await import(${JSON.stringify(ownerPath)});`
                    : [
                        // Loading from a data URL prevents accidental resolution from the source node_modules.
                        `const build = await Bun.build({ entrypoints: [${JSON.stringify(ownerPath)}], target: 'bun', write: false });`,
                        'if (!build.success) throw new AggregateError(build.logs, "Transport bundle failed");',
                        'const code = Buffer.from(await build.outputs[0].text()).toString("base64");',
                        'const { createCodexUnixWebSocket } = await import("data:text/javascript;base64," + code);',
                    ].join('\n');
                const source = [
                    loadOwner,
                    `const socket = createCodexUnixWebSocket(${JSON.stringify(socketPath)});`,
                    'try {',
                    '  const [, reply] = await Promise.all([',
                    '    new Promise((resolve, reject) => {',
                    '      socket.once("error", reject);',
                    '      socket.once("open", () => socket.send("ping", (error) => error ? reject(error) : resolve()));',
                    '    }),',
                    '    new Promise((resolve, reject) => {',
                    '      socket.once("error", reject);',
                    '      socket.once("message", (payload) => resolve(String(payload)));',
                    '    }),',
                    '  ]);',
                    '  console.log(reply);',
                    '} finally { socket.terminate(); }',
                ].join('\n');
                const result = await promisify(execFile)(bunExecutable, ['--eval', source], { timeout: 5_000 });

                expect(result.stdout.trim()).toBe('pong');
                expect(extensions).toEqual([undefined]);
            } finally {
                for (const socket of webSocketServer.clients) socket.terminate();
                await new Promise<void>((resolve) => webSocketServer.close(resolve));
                await new Promise<void>((resolve) => server.close(() => resolve()));
            }
        });
    });
});
