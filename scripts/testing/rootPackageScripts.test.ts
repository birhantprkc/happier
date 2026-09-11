import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { ROOT_TYPECHECK_COMMANDS, runRootTypecheck } from './runTypecheck.ts';

const rootPackage = JSON.parse(readFileSync('package.json', 'utf8')) as {
  scripts?: Record<string, string>;
};

test('root typecheck script delegates workspace ownership to the all-settled runner', () => {
  assert.equal(
    rootPackage.scripts?.['typecheck:inner'],
    'node --experimental-strip-types scripts/testing/runTypecheck.ts',
  );
  assert.equal(
    rootPackage.scripts?.typecheck,
    'node scripts/runWithHeartbeat.mjs --label typecheck -- yarn -s typecheck:inner',
  );
});

test('root typecheck inventory preserves every existing workspace owner', () => {
  assert.deepEqual(ROOT_TYPECHECK_COMMANDS.map((command) => command.args), [
    ['workspace', 'privacy-kit', 'typecheck'],
    ['workspace', '@happier-dev/protocol', 'typecheck'],
    ['workspace', '@happier-dev/transfers', 'typecheck'],
    ['workspace', '@happier-dev/agents', 'typecheck'],
    ['workspace', '@happier-dev/cli-common', 'typecheck'],
    ['workspace', '@happier-dev/connection-supervisor', 'typecheck'],
    ['workspace', '@happier-dev/bootstrap', 'typecheck'],
    ['workspace', '@happier-dev/app', 'typecheck'],
    ['workspace', '@happier-dev/cli', 'typecheck'],
    ['--cwd', 'apps/server', 'typecheck'],
    ['workspace', '@happier-dev/tests', 'typecheck'],
  ]);
});

test('root typecheck attempts later workspaces after failures and reports the complete failure set', async () => {
  const executed: string[] = [];
  let active = 0;
  let maximumActive = 0;

  await assert.rejects(
    runRootTypecheck({
      commands: [
        { id: 'ui', args: ['workspace', '@happier-dev/app', 'typecheck'] },
        { id: 'cli', args: ['workspace', '@happier-dev/cli', 'typecheck'] },
        { id: 'server', args: ['--cwd', 'apps/server', 'typecheck'] },
      ],
      runCommand: async (command) => {
        executed.push(command.id);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise<void>((resolveRun) => setImmediate(resolveRun));
        active -= 1;
        if (command.id !== 'server') throw new Error(`${command.id} failed`);
      },
    }),
    (error: unknown) => {
      assert.match(String(error), /ui: ui failed/u);
      assert.match(String(error), /cli: cli failed/u);
      return true;
    },
  );

  assert.deepEqual(executed, ['ui', 'cli', 'server']);
  assert.equal(maximumActive, 1);
});

test('root import-cycle command delegates to the CLI guard', () => {
  assert.equal(
    rootPackage.scripts?.['test:import-cycles'],
    'yarn workspace @happier-dev/cli test:import-cycles',
  );
});

test('root provider aliases expose Cursor smoke and extended presets', () => {
  assert.equal(
    rootPackage.scripts?.['test:providers:cursor:smoke'],
    'yarn workspace @happier-dev/tests providers:cursor:smoke',
  );
  assert.equal(
    rootPackage.scripts?.['test:providers:cursor:extended'],
    'yarn workspace @happier-dev/tests providers:cursor:extended',
  );
});

test('root policy self-test covers workflow schedule policy', () => {
  assert.match(
    rootPackage.scripts?.['test:policy:self'] ?? '',
    /scripts\/testing\/workflowSchedulePolicy\.test\.ts/,
    'test:policy:self should run workflow schedule policy checks',
  );
});
