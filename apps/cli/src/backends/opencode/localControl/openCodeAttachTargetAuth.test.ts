import { describe, expect, it } from 'vitest';

import {
  resolveOpenCodeAttachChildEnv,
  resolveOpenCodeAttachTargetAuthHeaders,
} from './openCodeAttachTargetAuth';

function basic(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

const ambientEnv: NodeJS.ProcessEnv = {
  OPENCODE_PASSWORD: 'operator-secret',
  OPENCODE_SERVER_USERNAME: 'reverse-proxy-user',
};

describe('OpenCode attach target authentication', () => {
  it('preserves the ambient reverse-proxy username for a remote target', async () => {
    await expect(resolveOpenCodeAttachTargetAuthHeaders({
      baseUrl: 'https://opencode.example.test',
      env: ambientEnv,
    })).resolves.toEqual({
      Authorization: basic('reverse-proxy-user', 'operator-secret'),
    });

    await expect(resolveOpenCodeAttachChildEnv({
      baseUrl: 'https://opencode.example.test',
      env: ambientEnv,
    })).resolves.toBe(ambientEnv);
  });

  it('preserves the ambient reverse-proxy username for a nonmatching loopback target', async () => {
    const state = {
      baseUrl: 'http://127.0.0.1:4100',
      pid: 123,
      startedAtMs: 1,
      authPassword: 'managed-secret',
    };
    const readManagedServerStateFn = async () => state;

    await expect(resolveOpenCodeAttachTargetAuthHeaders({
      baseUrl: 'http://127.0.0.1:4200',
      env: ambientEnv,
      readManagedServerStateFn,
    })).resolves.toEqual({
      Authorization: basic('reverse-proxy-user', 'operator-secret'),
    });

    await expect(resolveOpenCodeAttachChildEnv({
      baseUrl: 'http://127.0.0.1:4200',
      env: ambientEnv,
      readManagedServerStateFn,
    })).resolves.toBe(ambientEnv);
  });
});
