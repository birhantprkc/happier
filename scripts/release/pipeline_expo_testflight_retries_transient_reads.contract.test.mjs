import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const groupId = '78315e16-c539-43ae-a65e-4f465dccaf68';

test('TestFlight distribution retries transient App Store Connect reads without retrying mutations', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-testflight-read-retry-'));
  const preloadPath = path.join(fixtureRoot, 'mock-asc.mjs');
  const requestsPath = path.join(fixtureRoot, 'requests.jsonl');
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();

  fs.writeFileSync(
    preloadPath,
    `import fs from 'node:fs';

let groupReads = 0;
globalThis.fetch = async (url, init = {}) => {
  const pathname = new URL(url).pathname;
  const method = String(init.method ?? 'GET');
  fs.appendFileSync(process.env.HAPPIER_TEST_ASC_REQUESTS_PATH, JSON.stringify({ method, pathname }) + '\\n');

  if (pathname === '/v1/apps/6761304097/betaGroups' && method === 'GET') {
    groupReads += 1;
    if (groupReads === 1) {
      throw new TypeError('fetch failed', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } });
    }
    return Response.json({
      data: [{
        type: 'betaGroups',
        id: '${groupId}',
        attributes: { name: 'Happier (dev)', isInternalGroup: false },
      }],
    });
  }
  if (pathname === '/v1/builds' && method === 'GET') {
    return Response.json({
      data: [{
        type: 'builds',
        id: 'build-1',
        attributes: { version: '296', uploadedDate: '2026-09-10T00:00:00Z', processingState: 'VALID' },
        relationships: {
          preReleaseVersion: { data: { type: 'preReleaseVersions', id: 'version-1' } },
          betaGroups: { data: [] },
        },
      }],
      included: [{ type: 'preReleaseVersions', id: 'version-1', attributes: { version: '0.2.12' } }],
    });
  }
  if (pathname === '/v1/betaGroups/${groupId}/relationships/builds' && method === 'POST') {
    throw new TypeError('fetch failed', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } });
  }
  return Response.json({ errors: [{ code: 'UNEXPECTED_TEST_URL', detail: method + ' ' + pathname }] }, { status: 500 });
};
`,
  );

  try {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        preloadPath,
        'scripts/pipeline/expo/testflight-distribute.mjs',
        '--environment=dev',
        `--external-groups=${groupId}`,
        '--build-number=296',
        '--app-version=0.2.12',
        '--wait-processing=false',
        '--submit-beta-review=false',
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          APPLE_API_PRIVATE_KEY: privateKeyPem,
          HAPPIER_TEST_ASC_REQUESTS_PATH: requestsPath,
          HAPPIER_TESTFLIGHT_READ_RETRY_DELAY_MS: '0',
        },
      },
    );

    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const requests = fs.readFileSync(requestsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(requests.filter(({ method, pathname }) => method === 'GET' && pathname.endsWith('/betaGroups')).length, 2);
    assert.equal(requests.filter(({ method }) => method === 'POST').length, 1);
    assert.match(result.stdout, /retrying transient App Store Connect read/i);
    assert.match(result.stderr, /UND_ERR_CONNECT_TIMEOUT/);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
