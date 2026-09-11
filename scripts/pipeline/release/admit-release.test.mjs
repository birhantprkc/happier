import test from 'node:test';
import assert from 'node:assert/strict';

import { admitRelease } from './admit-release.mjs';

const base = {
  checksProfile: 'fast',
  environment: 'preview',
  plannedSourceSha: 'a'.repeat(40),
  validatedSourceSha: 'a'.repeat(40),
  ciResult: 'success',
  publishServerRuntimeNeeded: true,
  publishCliBinariesNeeded: true,
  publishStack: false,
  sourceChecksWaived: false,
  risks: { mysqlContract: false, platformServices: false, trustRoots: false },
  gates: { mysql: 'skipped', platform: 'skipped', trustRoots: 'skipped' },
};

test('admits a preview when no heavy risk gate applies', () => {
  assert.deepEqual(admitRelease(base), { admitted: true });
});

test('requires platform evidence when a stack artifact changes the self-host runtime', () => {
  assert.throws(() => admitRelease({
    ...base,
    publishServerRuntimeNeeded: false,
    publishCliBinariesNeeded: false,
    publishStack: true,
    risks: { ...base.risks, platformServices: true },
    gates: { ...base.gates, platform: 'skipped' },
  }), /platform gates/);
});

test('an explicit source-CI waiver also waives source-only MySQL and platform gates but not artifact trust', () => {
  assert.deepEqual(admitRelease({
    ...base,
    sourceChecksWaived: true,
    risks: { mysqlContract: true, platformServices: true, trustRoots: false },
  }), { admitted: true });

  assert.throws(() => admitRelease({
    ...base,
    sourceChecksWaived: true,
    risks: { mysqlContract: true, platformServices: true, trustRoots: true },
  }), /trust validation/);
});

test('requires full checks for production and successful selected risk gates', () => {
  assert.throws(() => admitRelease({ ...base, environment: 'production' }), /checks_profile=full/);
  assert.throws(() => admitRelease({
    ...base,
    risks: { ...base.risks, mysqlContract: true },
    gates: { ...base.gates, mysql: 'failure' },
  }), /MySQL gate/);
  assert.throws(() => admitRelease({
    ...base,
    risks: { ...base.risks, trustRoots: true },
    gates: { ...base.gates, trustRoots: 'skipped' },
  }), /trust validation/);
});

test('requires source validation for the exact planned SHA', () => {
  assert.throws(() => admitRelease({
    ...base,
    validatedSourceSha: 'b'.repeat(40),
  }), /validated source SHA.*planned source SHA/i);

  assert.throws(() => admitRelease({
    ...base,
    ciResult: 'failure',
  }), /successful exact-SHA CI evidence/i);

  assert.deepEqual(admitRelease({
    ...base,
    sourceChecksWaived: true,
    ciResult: 'skipped',
  }), { admitted: true });
});
