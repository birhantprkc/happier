import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';

import { runDesktopSetupValidation } from '../pipeline/release-validation/executors/desktop-setup.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const validateScript = resolve(repoRoot, 'scripts', 'pipeline', 'release-validation', 'validate-release.mjs');
const suiteScript = resolve(repoRoot, 'scripts', 'release', 'release-assets-e2e', 'desktop-setup.mjs');

function dryRun(args) {
  return spawnSync(process.execPath, [validateScript, '--suite', 'desktop-setup', '--dry-run', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 30_000,
  });
}

test('release-validate plans desktop-setup against a published CLI tag and the desktop artifact under test', () => {
  const out = dryRun(['--platform', 'linux', '--source', 'published-tag', '--ref', 'cli-v0.2.13', '--desktop-artifact', 'dist/tauri/app.deb']);
  assert.equal(out.status, 0, out.stderr);
  const parsed = JSON.parse(out.stdout);
  assert.deepEqual(parsed.execution, {
    type: 'command',
    command: process.execPath,
    args: [suiteScript, '--desktop-artifact', resolve(repoRoot, 'dist/tauri/app.deb'), '--cli-tag', 'cli-v0.2.13'],
    cwd: repoRoot,
  });
});

test('release-validate plans desktop-setup local builds from the CLI release asset directory', () => {
  const out = dryRun(['--platform', 'linux', '--source', 'local-build', '--ref', '.', '--desktop-artifact', 'app.AppImage', '--release-channel', 'preview']);
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout).execution.args.slice(3), ['--cli-assets-dir', resolve(repoRoot, 'dist', 'release-assets', 'cli'), '--channel', 'preview']);
});

test('release-validate refuses desktop-setup without an artifact, off Linux, or from a rolling tag', () => {
  assert.match(dryRun(['--platform', 'linux', '--source', 'published-tag', '--ref', 'cli-v0.2.13']).stderr, /--desktop-artifact/);
  assert.match(dryRun(['--platform', 'darwin', '--source', 'published-tag', '--ref', 'cli-v0.2.13', '--desktop-artifact', 'a.deb']).stderr, /--platform linux only/);
  assert.match(dryRun(['--platform', 'linux', '--source', 'published-tag', '--ref', 'cli-stable', '--desktop-artifact', 'a.deb']).stderr, /immutable cli-v<version>/);
  assert.match(
    spawnSync(process.execPath, [validateScript, '--suite', 'binary-smoke', '--source', 'local-build', '--ref', '.', '--desktop-artifact', 'a.deb', '--dry-run'], { cwd: repoRoot, encoding: 'utf8' }).stderr,
    /only for --suite desktop-setup/,
  );
});

test('a run over the registry budget warns instead of failing; a failed run still fails', () => {
  const warnings = [];
  let clock = 0;
  const base = {
    repoRoot,
    platform: 'linux',
    source: { kind: 'published-tag', ref: 'cli-v0.2.13' },
    options: { desktopArtifact: 'a.deb' },
    timeBudgetMinutes: 10,
    assertDockerAvailable: () => {},
    now: () => clock,
    warn: (message) => warnings.push(message),
  };
  runDesktopSetupValidation({ ...base, exec: () => { clock += 11 * 60_000; } });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /over its 10-minute release-validation budget/);

  clock = 0;
  assert.throws(() => runDesktopSetupValidation({ ...base, exec: () => { throw new Error('suite failed'); } }), /suite failed/);
  assert.throws(() => runDesktopSetupValidation({ ...base, timeBudgetMinutes: undefined, exec: () => {} }), /timeBudgetMinutes/);
});

test('tests.yml runs a selected desktop-setup on x86_64 with the staged desktop candidate and fails when it has none', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'tests.yml'), 'utf8');
  const workflow = YAML.parse(raw, { prettyErrors: true });
  const inputs = workflow.on.workflow_call.inputs;
  assert.deepEqual(inputs.run_desktop_setup, { required: false, default: false, type: 'boolean' });
  assert.deepEqual(inputs.desktop_setup_artifact, { required: false, default: '', type: 'string' });
  assert.deepEqual(inputs.desktop_setup_cli_ref, { required: false, default: '', type: 'string' });

  const job = workflow.jobs['desktop-setup'];
  assert.ok(job, 'tests.yml must own one desktop-setup job');
  assert.equal(job.if, '${{ inputs.select_jobs_explicitly && inputs.run_desktop_setup }}');
  // Linux desktop bundles ship for x86_64 only.
  assert.equal(job['runs-on'], 'ubuntu-latest');
  // A same-run artifact needs no token scope, so no caller of tests.yml has to grant more.
  assert.equal(job.permissions, undefined);

  const steps = job.steps;
  const guard = steps.findIndex((step) => /DESKTOP_SETUP_ARTIFACT/.test(String(step.run ?? '')) && /exit 1/.test(String(step.run ?? '')));
  const download = steps.findIndex((step) => String(step.uses ?? '').startsWith('actions/download-artifact@'));
  const runStep = steps.findIndex((step) => /--suite desktop-setup/.test(String(step.run ?? '')));
  assert.ok(guard >= 0 && guard < download && download < runStep, 'a selected run without its inputs fails before anything else runs');
  assert.equal(steps[download].with.name, '${{ inputs.desktop_setup_artifact }}');
  assert.equal(steps[download].with['run-id'], undefined);
  const run = String(steps[runStep].run);
  assert.match(run, /--platform linux/);
  assert.match(run, /--source published-tag/);
  assert.match(run, /--ref "\$\{DESKTOP_SETUP_CLI_REF\}"/);
  assert.match(run, /--desktop-artifact "\$\{desktop_artifact\}"/);
  assert.equal(steps[runStep].env?.DESKTOP_SETUP_CLI_REF, '${{ inputs.desktop_setup_cli_ref }}');

  // Selected ⇒ must have executed: the collector treats a requested lane GitHub skipped as a failure.
  assert.match(raw, /REQUEST_RUN_DESKTOP_SETUP: \$\{\{ inputs\.run_desktop_setup \}\}/);
  assert.match(raw, /REQUEST_RUN_DESKTOP_SETUP: \['desktop-setup'\]/);
});

test('release-verify stages the candidate desktop build into its own run for desktop-setup', async () => {
  const workflow = YAML.parse(await readFile(join(repoRoot, '.github', 'workflows', 'release-verify.yml'), 'utf8'), { prettyErrors: true });
  const stage = workflow.jobs.stage_desktop_candidate;
  assert.ok(stage, 'one job owns the cross-run download');
  assert.equal(stage.if, "${{ inputs.candidate_desktop_run_id != '' }}");
  assert.equal(stage['runs-on'], 'ubuntu-latest');
  assert.equal(stage.permissions?.actions, 'read');
  const download = stage.steps.find((step) => String(step.uses ?? '').startsWith('actions/download-artifact@'));
  assert.equal(download.with['run-id'], '${{ inputs.candidate_desktop_run_id }}');
  assert.equal(download.with.name, 'tauri-updates-linux-x86_64');
  assert.equal(download.with['github-token'], '${{ github.token }}');
  const upload = stage.steps.find((step) => String(step.uses ?? '').startsWith('actions/upload-artifact@'));
  assert.equal(upload.with.name, 'desktop-setup-candidate');
  assert.equal(upload.with['if-no-files-found'], 'error');

  const verify = workflow.jobs.verify;
  assert.ok(verify.needs.includes('stage_desktop_candidate'));
  assert.match(verify.if, /needs\.stage_desktop_candidate\.result == 'success' \|\| needs\.stage_desktop_candidate\.result == 'skipped'/);
  assert.equal(verify.with.desktop_setup_artifact, "${{ inputs.candidate_desktop_run_id != '' && 'desktop-setup-candidate' || '' }}");
});
