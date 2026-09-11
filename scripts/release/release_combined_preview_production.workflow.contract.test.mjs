import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

async function workflow(name) {
  return parse(await readFile(join(repoRoot, '.github', 'workflows', name), 'utf8'));
}

test('combined preview and production release reuses the canonical channel workflow concurrently', async () => {
  const [release, combined, sourceValidation] = await Promise.all([
    workflow('release.yml'),
    workflow('release-preview-and-production.yml'),
    workflow('release-source-validation.yml'),
  ]);

  assert.ok(release.on.workflow_call, 'the canonical channel workflow must be reusable');
  assert.equal(release.on.workflow_call.inputs.combined_preview_production.default, false);
  assert.equal(release.concurrency.group, 'release-unified-${{ inputs.environment }}');
  assert.equal(release.concurrency['cancel-in-progress'], false);

  const preview = combined.jobs.release_preview;
  const production = combined.jobs.release_production;
  assert.equal(preview.uses, './.github/workflows/release.yml');
  assert.equal(production.uses, './.github/workflows/release.yml');
  assert.deepEqual(preview.needs, ['snapshot_release_issues', 'source_validation']);
  assert.deepEqual(production.needs, ['snapshot_release_issues', 'source_validation']);
  assert.notEqual(preview.needs, 'release_production', 'preview must not wait for the production channel');
  assert.notEqual(production.needs, 'release_preview', 'production must not wait for the preview channel');
  assert.equal(preview.with.environment, 'preview');
  assert.equal(preview.with.confirm, 'release dev to preview');
  assert.equal(production.with.environment, 'production');
  assert.equal(production.with.confirm, 'release dev to main');
  assert.equal(preview.with.authorized_promotion_source_sha, '${{ inputs.authorized_promotion_source_sha }}');
  assert.equal(production.with.authorized_promotion_source_sha, '${{ inputs.authorized_promotion_source_sha }}');
  assert.equal(preview.with.ci_run_id, '${{ inputs.ci_run_id }}');
  assert.equal(production.with.ci_run_id, '${{ inputs.ci_run_id }}');
  assert.equal(preview.with.combined_preview_production, true);
  assert.equal(production.with.combined_preview_production, true);
  assert.equal(preview.with.shared_source_validation, true);
  assert.equal(production.with.shared_source_validation, true);
  assert.equal(preview.with.shared_source_validation_sha, '${{ needs.source_validation.outputs.source_sha }}');
  assert.equal(production.with.shared_source_validation_sha, '${{ needs.source_validation.outputs.source_sha }}');

  const sharedValidation = combined.jobs.source_validation;
  assert.equal(sharedValidation.uses, './.github/workflows/release-source-validation.yml');
  assert.equal(sharedValidation.with.base_refs, 'preview,main');
  assert.equal(sharedValidation.with.source_sha, '${{ inputs.authorized_promotion_source_sha }}');
  assert.equal(sharedValidation.with.ci_run_id, '${{ inputs.ci_run_id }}');
  assert.equal(sourceValidation.on.workflow_dispatch, undefined, 'source validation is reusable control, not a second public release entry point');
  assert.ok(sourceValidation.on.workflow_call.outputs.source_sha);

  assert.equal(release.jobs.ci, undefined, 'exact-SHA CI verification belongs to the shared source validator');
  assert.equal(release.jobs.mysql_db_contract, undefined, 'MySQL validation belongs to the shared source validator');
  assert.equal(release.jobs.platform_service_validation, undefined, 'platform validation belongs to the shared source validator');
  assert.equal(release.jobs.trust_root_validation, undefined, 'trust-root validation belongs to the shared source validator');
  assert.equal(release.jobs.source_validation.uses, './.github/workflows/release-source-validation.yml');
  const trustedRefGuard = release.jobs.trusted_ref_guard.steps.find((step) => step.name === 'Reject cross-repository or untrusted release control');
  assert.equal(trustedRefGuard.env.CALLER_WORKFLOW_REF, '${{ github.workflow_ref }}');
  assert.match(trustedRefGuard.run, /shared_source_validation=true/);
  assert.match(trustedRefGuard.run, /release-preview-and-production\.yml@refs\/heads\/(?:dev|preview|main)/);

  const advance = combined.jobs.advance_release_issues;
  assert.deepEqual(advance.needs, ['snapshot_release_issues', 'release_preview', 'release_production']);
  assert.match(String(advance.if), /needs\.release_preview\.result == 'success'/u);
  assert.match(String(advance.if), /needs\.release_production\.result == 'success'/u);
  const reconcile = advance.steps.find((step) => step.name === 'Advance the initially eligible issues directly to stable')?.run ?? '';
  assert.match(reconcile, /--from-stage "stage:source"[\s\S]*--to-stage "stage:stable"/u);
  assert.match(reconcile, /--from-stage "stage:dev"[\s\S]*--to-stage "stage:stable"/u);

  for (const forbiddenJob of ['plan', 'publish_cli_binaries', 'publish_server_runtime', 'deploy_ui']) {
    assert.equal(combined.jobs[forbiddenJob], undefined, `combined workflow must not copy the canonical ${forbiddenJob} job`);
  }
});
