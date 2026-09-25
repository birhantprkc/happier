import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RELEASE_VALIDATION_PROFILES,
  RELEASE_VALIDATION_SOURCE_KINDS,
  RELEASE_VALIDATION_SUITE_IDS,
  resolveAutomaticReleaseValidationExecution,
  resolveReleaseValidationSourceKind,
  resolveReleaseValidationSuite,
} from '../pipeline/release-validation/registry.mjs';

test('release-validation registry exposes the canonical suite and source ids', () => {
  assert.deepEqual(RELEASE_VALIDATION_SUITE_IDS, [
    'installers-smoke',
    'binary-smoke',
    'artifact-verify',
    'docker-release-assets',
    'cli-update',
    'daemon-continuity',
    'session-continuity',
    'desktop-setup',
  ]);

  assert.deepEqual(RELEASE_VALIDATION_SOURCE_KINDS, [
    'published-channel',
    'published-tag',
    'local-build',
    'local-pack',
    'git-ref-build',
  ]);

  assert.equal(resolveReleaseValidationSourceKind(' local-build '), 'local-build');
  assert.equal(resolveReleaseValidationSourceKind('unknown'), null);
  assert.equal(resolveReleaseValidationSuite(' cli-update ')?.executorId, 'cli-update');
  assert.equal(resolveReleaseValidationSuite('unknown'), null);
});

test('release-validation registry is the single owner of candidate-aware automatic suite selection', () => {
  assert.deepEqual(resolveAutomaticReleaseValidationExecution('integrated', {
    hasCliCandidate: true,
    hasServerCandidate: false,
    hasDesktopCandidate: false,
    hasPublishedRelayPredecessor: true,
    risks: { cliUpgrade: true, sessionContinuity: true, relayUpgrade: true },
  }), {
    selectedSuiteIds: ['artifact-verify', 'binary-smoke', 'cli-update'],
    skippedSuiteIds: ['session-continuity', 'docker-release-assets', 'desktop-setup'],
    skipReasons: {
      'session-continuity': 'no server candidate',
      'docker-release-assets': 'no server candidate',
      'desktop-setup': 'no desktop candidate',
    },
  });

  assert.deepEqual(resolveAutomaticReleaseValidationExecution('stable', {
    hasCliCandidate: false,
    hasServerCandidate: true,
    hasDesktopCandidate: false,
    hasPublishedRelayPredecessor: true,
    risks: { cliUpgrade: true, sessionContinuity: true, relayUpgrade: true },
  }), {
    selectedSuiteIds: ['binary-smoke', 'session-continuity', 'docker-release-assets'],
    skippedSuiteIds: ['artifact-verify', 'cli-update', 'desktop-setup'],
    skipReasons: {
      'artifact-verify': 'no CLI candidate',
      'cli-update': 'no CLI candidate',
      'desktop-setup': 'no desktop candidate',
    },
  });

  // desktop-setup can only execute where its upgrade scenario has a pinned predecessor (a stable,
  // i.e. production, candidate): elsewhere it is skipped with that reason, never selected to BLOCK.
  const desktop = (candidateChannel) => resolveAutomaticReleaseValidationExecution('integrated', {
    hasCliCandidate: true,
    hasServerCandidate: false,
    hasDesktopCandidate: true,
    candidateChannel,
    hasPublishedRelayPredecessor: false,
    risks: { cliUpgrade: false, sessionContinuity: false, relayUpgrade: false },
  });
  assert.ok(desktop('production').selectedSuiteIds.includes('desktop-setup'));
  for (const channel of ['preview', 'dev', undefined]) {
    const execution = desktop(channel);
    assert.ok(execution.skippedSuiteIds.includes('desktop-setup'), `desktop-setup selected for ${channel}`);
    assert.match(execution.skipReasons['desktop-setup'], /no pinned (preview|dev|unknown) predecessor/);
  }

  assert.throws(() => resolveAutomaticReleaseValidationExecution('deep', {
    hasCliCandidate: true,
    hasServerCandidate: true,
    hasPublishedRelayPredecessor: true,
    risks: { cliUpgrade: true, sessionContinuity: true, relayUpgrade: true },
  }), /normal release profile/);
});

test('release-validation registry encodes supported cli-update source direction', () => {
  const cliUpdate = resolveReleaseValidationSuite('cli-update');

  assert.deepEqual(cliUpdate?.supportedUpdateSourcePairs, [
    { from: 'published-channel', to: 'published-channel' },
    { from: 'published-channel', to: 'published-tag' },
    { from: 'published-channel', to: 'local-build' },
    { from: 'published-channel', to: 'local-pack' },
    { from: 'published-tag', to: 'published-channel' },
    { from: 'published-tag', to: 'published-tag' },
    { from: 'published-tag', to: 'local-build' },
    { from: 'published-tag', to: 'local-pack' },
  ]);
});

test('normal release profiles only name executable canonical suites automatically', () => {
  for (const profile of RELEASE_VALIDATION_PROFILES) {
    for (const suiteId of profile.automaticSuiteIds) {
      assert.ok(
        resolveReleaseValidationSuite(suiteId)?.executorId,
        `${profile.id} automatic suite '${suiteId}' must resolve to an executable canonical suite`,
      );
    }
  }
});

test('desktop-setup is executable, declares its time budget, and runs for every normal profile exactly when a desktop and a CLI candidate of the production channel exist', () => {
  const suite = resolveReleaseValidationSuite('desktop-setup');
  assert.equal(suite?.executorId, 'desktop-setup');
  assert.ok((suite?.timeBudgetMinutes ?? 0) > 0);
  const base = {
    hasServerCandidate: false,
    hasPublishedRelayPredecessor: false,
    risks: { cliUpgrade: false, sessionContinuity: false, relayUpgrade: false },
  };
  for (const profile of RELEASE_VALIDATION_PROFILES.filter((candidate) => candidate.normalRelease)) {
    const run = (hasDesktopCandidate, hasCliCandidate) => resolveAutomaticReleaseValidationExecution(profile.id, { ...base, hasDesktopCandidate, hasCliCandidate, candidateChannel: 'production' });
    assert.ok(run(true, true).selectedSuiteIds.includes('desktop-setup'), `${profile.id} selects desktop-setup for a desktop + CLI candidate`);
    // The shipped hsetup only acquires a CLI signed with the real key: without a CLI candidate
    // there is nothing it can install, so the suite is skipped rather than run against a guess.
    assert.ok(run(true, false).skippedSuiteIds.includes('desktop-setup'), `${profile.id} skips desktop-setup without a CLI candidate`);
    assert.ok(run(false, true).skippedSuiteIds.includes('desktop-setup'), `${profile.id} skips desktop-setup without a desktop candidate`);
  }
});
