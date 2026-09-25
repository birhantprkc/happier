import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveReleaseValidationPlan } from './resolve-validation-plan.mjs';

test('validation plan keeps fast evidence and selects heavy suites only from changed seams', () => {
  assert.deepEqual(resolveReleaseValidationPlan({
    profileId: 'integrated',
    hasCliCandidate: true,
    hasServerCandidate: true,
    hasPublishedRelayPredecessor: true,
    risks: { cliUpgrade: false, sessionContinuity: false, relayUpgrade: false },
  }), {
    run_installers_smoke: 'false',
    run_artifact_verify: 'true',
    run_binary_smoke: 'true',
    run_cli_update_continuity: 'false',
    run_daemon_continuity: 'false',
    run_session_continuity: 'false',
    run_release_assets_docker: 'false',
    run_desktop_setup: 'false',
    run_self_host_systemd: 'false',
    run_self_host_launchd: 'false',
    run_self_host_schtasks: 'false',
    run_self_host_daemon: 'false',
    waivedSuiteIds: [],
    skippedSuites: [
      'session-continuity (no session-continuity risk)',
      'cli-update (no CLI-upgrade risk)',
      'docker-release-assets (no relay-upgrade risk)',
      'desktop-setup (no desktop candidate)',
    ],
  });

  const affected = resolveReleaseValidationPlan({
    profileId: 'stable',
    hasCliCandidate: true,
    hasServerCandidate: true,
    hasPublishedRelayPredecessor: true,
    risks: { cliUpgrade: true, sessionContinuity: true, relayUpgrade: true },
  });
  assert.equal(affected.run_cli_update_continuity, 'true');
  assert.equal(affected.run_session_continuity, 'true');
  assert.equal(affected.run_release_assets_docker, 'true');
  assert.equal(affected.run_desktop_setup, 'false', 'desktop-setup needs a desktop candidate to run');
});

test('validation plan runs desktop-setup for a desktop candidate paired with a CLI candidate', () => {
  const plan = (overrides) => resolveReleaseValidationPlan({
    profileId: 'integrated',
    hasCliCandidate: true,
    hasServerCandidate: false,
    hasDesktopCandidate: true,
    candidateChannel: 'production',
    hasPublishedRelayPredecessor: false,
    risks: { cliUpgrade: false, sessionContinuity: false, relayUpgrade: false },
    ...overrides,
  });
  assert.equal(plan({}).run_desktop_setup, 'true');
  assert.deepEqual(plan({}).skippedSuites.filter((entry) => entry.startsWith('desktop-setup')), []);
  // Unexecutable for a preview/dev candidate (no pinned predecessor): skipped, with the reason.
  assert.equal(plan({ candidateChannel: 'preview' }).run_desktop_setup, 'false');
  assert.ok(plan({ candidateChannel: 'dev' }).skippedSuites.includes('desktop-setup (no pinned dev predecessor for the upgrade scenario)'));
  assert.equal(plan({ hasCliCandidate: false }).run_desktop_setup, 'false');
  assert.equal(plan({ hasDesktopCandidate: false }).run_desktop_setup, 'false');
  // An explicit request is honoured; the job then fails loudly if no desktop artifact reaches it.
  assert.equal(plan({ hasDesktopCandidate: false, includeSuiteIds: ['desktop-setup'] }).run_desktop_setup, 'true');
  assert.equal(plan({ waiveSuiteIds: ['desktop-setup'] }).run_desktop_setup, 'false');
});

test('validation plan supports explicit reasoned refinements without a legacy flag matrix', () => {
  const result = resolveReleaseValidationPlan({
    profileId: 'integrated',
    hasCliCandidate: true,
    hasServerCandidate: true,
    hasPublishedRelayPredecessor: true,
    risks: { cliUpgrade: true, sessionContinuity: true, relayUpgrade: true },
    includeSuiteIds: ['installers-smoke'],
    waiveSuiteIds: ['docker-release-assets'],
  });
  assert.equal(result.run_installers_smoke, 'true');
  assert.equal(result.run_release_assets_docker, 'false');
  assert.deepEqual(result.waivedSuiteIds, ['docker-release-assets']);
  assert.throws(() => resolveReleaseValidationPlan({
    profileId: '',
    hasCliCandidate: false,
    hasServerCandidate: false,
    hasPublishedRelayPredecessor: false,
    risks: { cliUpgrade: false, sessionContinuity: false, relayUpgrade: false },
  }), /profile is required/);
  assert.throws(() => resolveReleaseValidationPlan({
    profileId: 'integrated',
    hasCliCandidate: true,
    hasServerCandidate: false,
    hasPublishedRelayPredecessor: false,
    risks: { cliUpgrade: false, sessionContinuity: false, relayUpgrade: false },
    waiveSuiteIds: ['artifact-verify'],
  }), /cannot be waived/);
});
