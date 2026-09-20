import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebScriptFetchTotalTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { mutateUiE2eLocalSettings } from '../../src/testkit/uiE2e/localSettingsStorage';
import { mutateUiE2eScopedAccountSettings } from '../../src/testkit/uiE2e/scopedAccountSettingsStorage';
import { createGitRepoWithChanges } from '../../src/testkit/uiE2e/gitRepoFixtures';
import { spawnSessionFromDaemon } from '../../src/testkit/uiE2e/spawnSessionFromDaemon';
import { toTestIdSafeValue } from '../../src/testkit/uiE2e/testIdSafeValue';
import { waitForInitialAppUi } from '../../src/testkit/uiE2e/waitForInitialAppUi';
import { ensureAccountReadyForConnect } from '../../src/testkit/uiE2e/ensureAccountReadyForConnect';
import { authenticateAndStartDaemon } from '../../src/testkit/uiE2e/authenticateAndStartDaemon';
import { appendBrowserDiagnostics, collectBrowserDiagnostics } from '../../src/testkit/uiE2e/browserDiagnostics';

const run = createRunDirs({ runLabel: 'ui-e2e' });

function detailsPaneLocator(page: Page) {
  return page
    .getByTestId('multi-pane-details-docked')
    .or(page.getByTestId('multi-pane-details-overlay'));
}

function rightPaneLocator(page: Page) {
  return page
    .getByTestId('multi-pane-right-docked')
    .or(page.getByTestId('multi-pane-right-overlay'));
}

test.describe('ui e2e: session action rail', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('session-action-rail-suite');
  const cliHomeDir = resolve(join(suiteDir, 'cli-home'));

  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let uiBaseUrl: string | null = null;
  let daemon: StartedDaemon | null = null;

  test.beforeAll(async () => {
    // Expo web bundling + first-run Metro startup can exceed 7 minutes on cold caches.
    // Keep this generous to avoid flaking the suite before we even reach UI assertions.
    test.setTimeout(900_000);
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(resolve(join(cliHomeDir, 'AGENTS.md')), '# UI e2e fixture\n', 'utf8');

    server = await startServerLight({
      testDir: suiteDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_BUILD_FEATURES_DENY: 'sharing.contentKeys',
        HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
        HAPPIER_FEATURE_TERMINAL_EMBEDDED_PTY__ENABLED: '1',
        HAPPIER_PRESENCE_SESSION_TIMEOUT_MS: '60000',
        HAPPIER_PRESENCE_MACHINE_TIMEOUT_MS: '60000',
        HAPPIER_PRESENCE_TIMEOUT_TICK_MS: '1000',
        HAPPIER_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT: '1',
      },
    });

    ui = await startUiWeb({
      testDir: suiteDir,
      env: {
        ...process.env,
        EXPO_PUBLIC_DEBUG: '1',
        EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl,
        EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-${run.runId}`,
        // On cold caches, the initial Metro web bundle can take >2 minutes; avoid aborting the request
        // before it has a chance to complete (which can cause repeated restarts and flakiness).
        HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS: process.env.HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS ?? '420000',
      },
    });

    uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
  });

  test.afterAll(async () => {
    test.setTimeout(120_000);
    await daemon?.stop().catch(() => {});
    await ui?.stop().catch(() => {});
    await server?.stop().catch(() => {});
  });

  test('opens independent panes and preserves access across responsive layouts', async ({ page }, testInfo) => {
    test.setTimeout(900_000);
    if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

    const browserDiagnostics = collectBrowserDiagnostics({ page });

    let runDaemon: StartedDaemon | null = null;
    try {
      await page.setViewportSize({ width: 1920, height: 900 });
      await gotoDomContentLoadedWithRetries(page, uiBaseUrl);
      await waitForInitialAppUi({ page, browserDiagnostics });

      await ensureAccountReadyForConnect({ page, timeoutMs: 120_000 });

      const testDir = resolve(join(suiteDir, 't1-review-scroll'));
      await mkdir(testDir, { recursive: true });

      const fakeClaudeLogPath = resolve(join(testDir, 'fake-claude.jsonl'));
      const fakeClaudePath = fakeClaudeFixturePath();

      runDaemon = await authenticateAndStartDaemon({
        page,
        testDir,
        cliHomeDir,
        serverUrl: server.baseUrl,
        uiBaseUrl,
        extraEnv: {
          HOME: cliHomeDir,
          // Machine-scoped RPC (used as a fallback when a newly-spawned session has no encryption context yet)
          // must be allowed to read the repo fixture directory.
          HAPPIER_MACHINE_RPC_WORKING_DIRECTORY: testDir,
          HAPPIER_CLAUDE_PATH: fakeClaudePath,
          HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeClaudeLogPath,
          HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: `fake-claude-session-${run.runId}`,
          HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: `fake-claude-invocation-${run.runId}`,
        },
      });
      daemon = runDaemon;

      const repoDir = resolve(join(testDir, 'repo'));
      await createGitRepoWithChanges({ repoDir, fileCount: 2 });

      const sessionId = await spawnSessionFromDaemon({ daemon: runDaemon, directory: repoDir });
      const sessionUrl = `${uiBaseUrl}/session/${sessionId}`;

      await mutateUiE2eScopedAccountSettings({ page, experiments: true, featureToggles: { 'terminal.embeddedPty': true } });
      await mutateUiE2eLocalSettings({ page, settingsPatch: { themePreference: 'light', embeddedTerminalDockLocation: 'bottom' } });
      await page.goto(sessionUrl, { waitUntil: 'domcontentloaded' });
      const rail = page.getByTestId('session-action-rail');
      const review = page.getByTestId('session-action-rail:review');
      const files = page.getByTestId('session-action-rail:files');
      await expect(rail).toBeVisible({ timeout: 180_000 });
      // These live dimensions prove the current rail bundle is loaded and its targets remain compact.
      expect((await rail.boundingBox())?.width).toBe(44);
      expect((await review.boundingBox())?.width).toBe(36);
      expect((await review.boundingBox())?.height).toBe(36);
      expect((await review.locator('svg').boundingBox())?.width).toBe(18);
      await expect(rightPaneLocator(page)).toHaveCount(0);
      await expect(detailsPaneLocator(page)).toHaveCount(0);
      await review.click();
      await expect(detailsPaneLocator(page)).toBeVisible();
      await expect(rightPaneLocator(page)).toHaveCount(0);
      const reviewTab = page.getByTestId(`session-details-tab-${toTestIdSafeValue('scmReview:working')}`);
      await expect(reviewTab).toBeVisible();
      await review.click();
      await expect(detailsPaneLocator(page)).toHaveCount(0);
      await review.click();
      await expect(reviewTab).toBeVisible();
      await test.step('Review content loads without opening the sidebar', async () => {
        await expect(page.getByTestId('scm-review-list')).toBeVisible({ timeout: resolveUiWebScriptFetchTotalTimeoutMs(process.env) });
        await expect(rightPaneLocator(page)).toHaveCount(0);
      });
      await files.click();
      await expect(rightPaneLocator(page)).toBeVisible();
      await expect(detailsPaneLocator(page)).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath('rail-light-wide.png') });
      await review.hover();
      const tooltip = page.getByRole('tooltip');
      await expect(tooltip).toBeVisible();
      const tooltipBox = await tooltip.boundingBox();
      const reviewBox = await review.boundingBox();
      expect(tooltipBox!.x + tooltipBox!.width).toBeLessThanOrEqual(reviewBox!.x);
      expect(reviewBox!.x - tooltipBox!.x - tooltipBox!.width).toBeLessThanOrEqual(12);
      await page.screenshot({ path: testInfo.outputPath('rail-tooltip.png') });
      await review.focus();
      await expect(review).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(files).toBeFocused();
      await page.screenshot({ path: testInfo.outputPath('rail-keyboard-focus.png') });
      const terminal = page.getByTestId('session-action-rail:terminal');
      await expect(terminal).toBeVisible();
      await terminal.click();
      await expect(page.getByTestId('multi-pane-bottom-dock')).toBeVisible();
      await terminal.click();
      await expect(page.getByTestId('multi-pane-bottom-dock')).toHaveCount(0);
      await mutateUiE2eLocalSettings({ page, settingsPatch: { themePreference: 'dark' } });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(rail).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId('scm-review-list')).toBeVisible({ timeout: resolveUiWebScriptFetchTotalTimeoutMs(process.env) });
      await expect(page.getByTestId('repository-tree-row-src')).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath('rail-dark-wide.png') });
      await review.click();
      await expect(detailsPaneLocator(page)).toHaveCount(0);
      await page.setViewportSize({ width: 900, height: 900 });
      await expect(rail).toBeVisible();
      await page.getByTestId('session-action-rail:git').click();
      await review.click();
      await expect(page.getByTestId('multi-pane-details-overlay')).toBeVisible();
      // The host parks the right pane mounted to preserve its state while Review occludes it.
      await expect(page.getByTestId('multi-pane-right-overlay').locator('..')).toHaveCSS('opacity', '0');
      await files.click();
      await expect(detailsPaneLocator(page)).toHaveCount(0);
      await expect(rightPaneLocator(page)).toBeVisible();
      await expect(page.getByTestId('repository-tree-row-src')).toBeVisible({ timeout: 60_000 });
      await page.screenshot({ path: testInfo.outputPath('rail-narrow-files.png') });
      await mutateUiE2eLocalSettings({ page, settingsPatch: { embeddedTerminalDockLocation: 'sidebar' } });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(terminal).toBeVisible({ timeout: 60_000 });
      await terminal.click();
      await expect(rightPaneLocator(page)).toBeVisible();
      await review.click();
      await expect(page.getByTestId('multi-pane-details-overlay')).toBeVisible();
      // The host parks the right pane mounted to preserve its state while Review occludes it.
      await expect(page.getByTestId('multi-pane-right-overlay').locator('..')).toHaveCSS('opacity', '0');
      await terminal.click();
      await expect(detailsPaneLocator(page)).toHaveCount(0);
      await expect(rightPaneLocator(page)).toBeVisible();
      await review.click();
      await expect(reviewTab).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath('rail-narrow-review.png') });
    } catch (error) {
      throw appendBrowserDiagnostics(error, browserDiagnostics());
    } finally {
      await runDaemon?.stop().catch(() => {});
      if (daemon === runDaemon) daemon = null;
    }
  });
});
