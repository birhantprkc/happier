// @ts-check

/**
 * @typedef {{
 *   id: string;
 *   supportsDirectSource: boolean;
 *   supportsUpdateSources: boolean;
 *   supportedDirectSourceKinds?: readonly string[];
 *   supportedUpdateSourceKinds?: readonly string[];
 *   supportedUpdateSourcePairs?: readonly { from: string; to: string }[];
 *   executorId?: string | null;
 *   timeBudgetMinutes?: number;
 * }} ReleaseValidationSuiteDefinition
 */

/**
 * @typedef {{
 *   id: 'integrated' | 'stable' | 'deep';
 *   normalRelease: boolean;
 *   checksProfile: 'fast' | 'full' | null;
 *   automaticSuiteIds: readonly string[];
 *   manualEntrypoint?: string;
 * }} ReleaseValidationProfileDefinition
 */

const INTEGRATED_AUTOMATIC_SUITE_IDS = Object.freeze([
  'artifact-verify',
  'binary-smoke',
  'session-continuity',
  'cli-update',
  'docker-release-assets',
  'desktop-setup',
]);

const STABLE_AUTOMATIC_SUITE_IDS = Object.freeze([
  ...INTEGRATED_AUTOMATIC_SUITE_IDS,
]);

/** @type {readonly ReleaseValidationProfileDefinition[]} */
export const RELEASE_VALIDATION_PROFILES = Object.freeze([
  Object.freeze({
    id: 'integrated',
    normalRelease: true,
    checksProfile: 'fast',
    automaticSuiteIds: INTEGRATED_AUTOMATIC_SUITE_IDS,
  }),
  Object.freeze({
    id: 'stable',
    normalRelease: true,
    checksProfile: 'full',
    automaticSuiteIds: STABLE_AUTOMATIC_SUITE_IDS,
  }),
  Object.freeze({
    id: 'deep',
    normalRelease: false,
    checksProfile: null,
    automaticSuiteIds: Object.freeze([]),
    manualEntrypoint: '.agents/skills/happier-release-validation/SKILL.md',
  }),
]);

/** @type {readonly ReleaseValidationSuiteDefinition[]} */
export const RELEASE_VALIDATION_SUITES = [
  {
    id: 'installers-smoke',
    supportsDirectSource: true,
    supportsUpdateSources: false,
    supportedDirectSourceKinds: ['published-channel', 'published-tag', 'local-build'],
    executorId: 'installers-smoke',
  },
  {
    id: 'binary-smoke',
    supportsDirectSource: true,
    supportsUpdateSources: false,
    supportedDirectSourceKinds: ['local-build'],
    executorId: 'binary-smoke',
  },
  {
    id: 'artifact-verify',
    supportsDirectSource: true,
    supportsUpdateSources: false,
    supportedDirectSourceKinds: ['local-build'],
    executorId: 'artifact-verify',
  },
  {
    id: 'docker-release-assets',
    supportsDirectSource: true,
    supportsUpdateSources: true,
    supportedDirectSourceKinds: ['local-build', 'published-channel'],
    supportedUpdateSourceKinds: ['published-channel', 'published-tag', 'local-build'],
    supportedUpdateSourcePairs: [
      { from: 'published-channel', to: 'local-build' },
      { from: 'published-channel', to: 'published-tag' },
    ],
    executorId: 'docker-release-assets',
  },
  {
    id: 'cli-update',
    supportsDirectSource: false,
    supportsUpdateSources: true,
    supportedUpdateSourceKinds: ['published-channel', 'published-tag', 'local-build', 'local-pack'],
    supportedUpdateSourcePairs: [
      { from: 'published-channel', to: 'published-channel' },
      { from: 'published-channel', to: 'published-tag' },
      { from: 'published-channel', to: 'local-build' },
      { from: 'published-channel', to: 'local-pack' },
      { from: 'published-tag', to: 'published-channel' },
      { from: 'published-tag', to: 'published-tag' },
      { from: 'published-tag', to: 'local-build' },
      { from: 'published-tag', to: 'local-pack' },
    ],
    executorId: 'cli-update',
  },
  {
    id: 'daemon-continuity',
    supportsDirectSource: true,
    supportsUpdateSources: false,
    supportedDirectSourceKinds: ['local-build'],
    executorId: 'daemon-continuity',
  },
  {
    id: 'session-continuity',
    supportsDirectSource: true,
    supportsUpdateSources: false,
    supportedDirectSourceKinds: ['local-build'],
    executorId: 'session-continuity',
  },
  {
    // A downloaded desktop app setting up a fresh systemd machine, and upgrading one an earlier
    // app version set up (scripts/release/release-assets-e2e/desktop-setup.mjs). Selected when
    // release verification receives a desktop candidate (its build-tauri run) together with the
    // CLI candidate that desktop's hsetup installs; tests.yml `desktop-setup` runs it.
    id: 'desktop-setup',
    supportsDirectSource: true,
    supportsUpdateSources: false,
    supportedDirectSourceKinds: ['published-tag', 'local-build'],
    executorId: 'desktop-setup',
    timeBudgetMinutes: 10,
  },
];

export const RELEASE_VALIDATION_SUITE_IDS = RELEASE_VALIDATION_SUITES.map((suite) => suite.id);
export const RELEASE_VALIDATION_PROFILE_IDS = RELEASE_VALIDATION_PROFILES.map((profile) => profile.id);

/**
 * @param {string} raw
 * @returns {ReleaseValidationSuiteDefinition | null}
 */
export function resolveReleaseValidationSuite(raw) {
  const id = String(raw ?? '').trim();
  return RELEASE_VALIDATION_SUITES.find((suite) => suite.id === id) ?? null;
}

/**
 * @param {string} raw
 * @returns {ReleaseValidationProfileDefinition | null}
 */
export function resolveReleaseValidationProfile(raw) {
  const id = String(raw ?? '').trim();
  return RELEASE_VALIDATION_PROFILES.find((profile) => profile.id === id) ?? null;
}

/**
 * Resolve automatic suites reachable for one exact candidate. Profiles own
 * eligibility; this function is the only candidate-applicability owner. A suite is selected only
 * where it can execute; every other suite is skipped with the reason, so a plan never reports an
 * unexecutable selection (one that could only end BLOCKED) as coverage.
 * @param {string} profileId
 * @param {{
 *   hasCliCandidate: boolean;
 *   hasServerCandidate: boolean;
 *   hasDesktopCandidate?: boolean;
 *   candidateChannel?: string;
 *   hasPublishedRelayPredecessor: boolean;
 *   risks: { cliUpgrade: boolean; sessionContinuity: boolean; relayUpgrade: boolean };
 * }} context
 */
export function resolveAutomaticReleaseValidationExecution(profileId, context) {
  const profile = RELEASE_VALIDATION_PROFILES.find((candidate) => candidate.id === String(profileId ?? '').trim());
  if (!profile?.normalRelease) throw new Error(`Automatic execution requires a normal release profile: ${profileId}`);
  /** The first unmet precondition, or `null` when the suite can execute. @param {Array<[boolean, string]>} conditions */
  const firstUnmet = (conditions) => conditions.find(([met]) => !met)?.[1] ?? null;
  const candidateChannel = String(context.candidateChannel ?? '').trim() || 'unknown';
  /** @type {Record<string, string | null>} */
  const skipReason = {
    'artifact-verify': firstUnmet([[context.hasCliCandidate, 'no CLI candidate']]),
    'binary-smoke': firstUnmet([[context.hasCliCandidate || context.hasServerCandidate, 'no CLI or server candidate']]),
    'session-continuity': firstUnmet([
      [context.hasServerCandidate, 'no server candidate'],
      [context.risks.sessionContinuity, 'no session-continuity risk'],
    ]),
    'cli-update': firstUnmet([
      [context.hasCliCandidate, 'no CLI candidate'],
      [context.risks.cliUpgrade, 'no CLI-upgrade risk'],
    ]),
    'docker-release-assets': firstUnmet([
      [context.hasServerCandidate, 'no server candidate'],
      [context.hasPublishedRelayPredecessor, 'no published relay predecessor'],
      [context.risks.relayUpgrade, 'no relay-upgrade risk'],
    ]),
    // The shipped hsetup acquires only a CLI signed with the release key, so the desktop under
    // test is exercised with the candidate CLI's immutable release. Its upgrade scenario needs a
    // pinned predecessor, which exists only for a stable (production) candidate
    // (desktop-setup.mjs resolves ui-desktop-stable/cli-stable); elsewhere it could only BLOCK.
    'desktop-setup': firstUnmet([
      [context.hasDesktopCandidate === true, 'no desktop candidate'],
      [context.hasCliCandidate, 'no CLI candidate'],
      [candidateChannel === 'production', `no pinned ${candidateChannel} predecessor for the upgrade scenario`],
    ]),
  };
  const selectedSuiteIds = [];
  const skippedSuiteIds = [];
  /** @type {Record<string, string>} */
  const skipReasons = {};
  for (const suiteId of profile.automaticSuiteIds) {
    if (!Object.hasOwn(skipReason, suiteId)) throw new Error(`Automatic suite ${suiteId} has no applicability owner`);
    const reason = skipReason[suiteId];
    if (reason === null) {
      selectedSuiteIds.push(suiteId);
    } else {
      skippedSuiteIds.push(suiteId);
      skipReasons[suiteId] = reason;
    }
  }
  return { selectedSuiteIds, skippedSuiteIds, skipReasons };
}

export const RELEASE_VALIDATION_SOURCE_KINDS = [
  'published-channel',
  'published-tag',
  'local-build',
  'local-pack',
  'git-ref-build',
];

/**
 * @param {string} raw
 * @returns {string | null}
 */
export function resolveReleaseValidationSourceKind(raw) {
  const value = String(raw ?? '').trim();
  return RELEASE_VALIDATION_SOURCE_KINDS.includes(value) ? value : null;
}
