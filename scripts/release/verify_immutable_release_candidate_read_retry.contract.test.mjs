import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import YAML from 'yaml';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const candidateTag = 'cli-v0.2.12-preview.1';

test('immutable candidate verification retries read-only asset downloads without retaining partial bytes', async (t) => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'happier-candidate-read-retry-'));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const binDir = path.join(fixtureRoot, 'bin');
  await mkdir(binDir);
  const outputPath = path.join(fixtureRoot, 'github-output');
  const requestLog = path.join(fixtureRoot, 'requests.log');

  const nodeMock = path.join(binDir, 'node');
  await writeFile(nodeMock, `#!/usr/bin/env bash
set -euo pipefail
for ((index=1; index <= \$#; index += 1)); do
  if [ "\${!index}" = --github-output ]; then
    next=\$((index + 1))
    printf 'candidate_tag=${candidateTag}\\n' > "\${!next}"
    break
  fi
done
`);
  await chmod(nodeMock, 0o755);

  const ghMock = path.join(binDir, 'gh');
  await writeFile(ghMock, `#!/usr/bin/env bash
set -euo pipefail
endpoint="\${2:-}"
printf '%s\\n' "\$endpoint" >> "\$HAPPIER_TEST_REQUEST_LOG"
case "\$endpoint" in
  repos/happier-dev/happier/releases/tags/${candidateTag})
    printf '101\\t${candidateTag}\\tfalse\\n201\\thappier-cli.tar.gz\\n'
    ;;
  repos/happier-dev/happier/releases/assets/201)
    count="\$(grep -c 'releases/assets/201' "\$HAPPIER_TEST_REQUEST_LOG")"
    if [ "\$count" -eq 1 ]; then
      printf 'partial-bytes'
      printf 'unexpected end of JSON input\\n' >&2
      exit 1
    fi
    printf 'complete-candidate-bytes'
    ;;
  repos/happier-dev/happier/releases/101)
    printf '101\\t${candidateTag}\\tfalse\\n201\\thappier-cli.tar.gz\\n'
    ;;
  *)
    printf 'unexpected mock endpoint: %s\\n' "\$endpoint" >&2
    exit 2
    ;;
esac
`);
  await chmod(ghMock, 0o755);

  const action = YAML.parse(await readFile(
    path.join(repoRoot, '.github', 'actions', 'verify-immutable-release-candidate', 'action.yml'),
    'utf8',
  ));
  const downloadStep = action.runs.steps.find((step) => step.id === 'download');
  assert.ok(downloadStep?.run);
  const portableDownloadRun = downloadStep.run
    // macOS ships Bash 3.2; this test has one controlled asset, so its harness can
    // bypass only the unrelated Bash 4 associative-array duplicate-name guard.
    .replace('declare -A observed_asset_names=()', 'observed_asset_names=""')
    .replace('[ -n "${observed_asset_names[$asset_name]+x}" ]', 'false')
    .replace('observed_asset_names["$asset_name"]=1', ':');
  const mapfilePolyfill = `mapfile() {
  [ "\$1" = -t ] || return 2
  local target="\$2" line quoted index=0
  eval "\${target}=()"
  while IFS= read -r line; do
    printf -v quoted '%q' "\$line"
    eval "\${target}[\${index}]=\${quoted}"
    index=\$((index + 1))
  done
}
`;
  const result = spawnSync('bash', ['-c', `${mapfilePolyfill}\n${portableDownloadRun}`], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      GITHUB_OUTPUT: outputPath,
      GITHUB_WORKSPACE: repoRoot,
      RUNNER_TEMP: fixtureRoot,
      REPOSITORY: 'happier-dev/happier',
      RELEASE_CHANNEL: 'preview',
      CANDIDATE_SOURCE_SHA: 'a'.repeat(40),
      CANDIDATE_PRODUCT: 'cli',
      CANDIDATE_VERSION: '0.2.12-preview.1',
      HAPPIER_GITHUB_READ_RETRY_DELAY_SECONDS: '0',
      HAPPIER_TEST_REQUEST_LOG: requestLog,
    },
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const githubOutput = await readFile(outputPath, 'utf8');
  const candidateDir = githubOutput.match(/^candidate_dir=(.+)$/m)?.[1];
  assert.ok(candidateDir);
  assert.equal(await readFile(path.join(candidateDir, 'happier-cli.tar.gz'), 'utf8'), 'complete-candidate-bytes');
  const requests = await readFile(requestLog, 'utf8');
  assert.equal(requests.match(/releases\/assets\/201/g)?.length, 2);
  assert.match(result.stderr, /retrying transient GitHub release read/i);
});
