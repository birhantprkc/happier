import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { ensureAccountReadyForConnect } from '../../src/testkit/uiE2e/ensureAccountReadyForConnect';

const run = createRunDirs({ runLabel: 'ui-e2e' });

async function setFakeTauriInternalsInExistingDocument(page: Page) {
    // Avoid making the app "desktop" at initial load, which can activate desktop-only runtimes.
    // Instead, load the web app normally first, then switch setup routes into desktop mode by
    // toggling isTauriDesktop() for subsequent renders (without a full-page reload).
    await page.evaluate(() => {
        (window as any).__TAURI_INTERNALS__ = {
            invoke: async (command: string, args?: Record<string, unknown>) => {
                switch (command) {
                    case 'desktop_fetch_update':
                        return null;
                    case 'desktop_install_update':
                        return false;
                    case 'desktop_set_tray_state':
                        return null;
                    case 'desktop_get_autostart_enabled':
                        return false;
                    case 'desktop_set_autostart_enabled': {
                        const enabled = Boolean(args && (args as any).enabled);
                        return enabled;
                    }
                    default:
                        return null;
                }
            },
        };
    });
}

async function navigateSpa(page: Page, path: string) {
    await page.evaluate((nextPath) => {
        window.history.pushState({}, '', nextPath);
        window.dispatchEvent(new PopStateEvent('popstate'));
    }, path);
}

async function materializeDeterministicTerminalAuthRequest(params: Readonly<{
    page: Page;
    serverBaseUrl: string;
}>): Promise<void> {
    await params.page.route('**/v1/auth/request/status?**', async (route) => {
        const statusUrl = new URL(route.request().url());
        const publicKey = statusUrl.searchParams.get('publicKey');
        if (!publicKey) {
            await route.continue();
            return;
        }

        // The deterministic desktop bridge stands in for the CLI process. Materialize the CLI's
        // real unauthenticated request at the server boundary before the app checks it, then let
        // the product's real status/approval path run unchanged.
        const response = await fetch(`${params.serverBaseUrl}/v1/auth/request`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ publicKey, supportsV2: true }),
        });
        if (!response.ok) {
            throw new Error(`failed to materialize deterministic auth request (status=${response.status})`);
        }
        await route.continue();
    });
}

test.describe('ui e2e: setup control panel flow (deterministic runner)', () => {
    test.describe.configure({ mode: 'serial' });

    const suiteDir = run.testDir('setup-control-panel-deterministic-runner-suite');

    let server: StartedServer | null = null;
    let ui: StartedUiWeb | null = null;
    let uiBaseUrl: string | null = null;

    const uiWebEnv = {
        ...process.env,
        EXPO_PUBLIC_DEBUG: '1',
        EXPO_PUBLIC_HAPPY_SERVER_URL: '',
        EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-${run.runId}`,
        EXPO_PUBLIC_SYSTEM_TASKS_RUNNER_MODE: 'dev',
        HAPPIER_E2E_UI_WEB_MODE: 'metro',
    };

    test.beforeAll(async () => {
        test.setTimeout(resolveUiWebBeforeAllTimeoutMs(uiWebEnv));
        await mkdir(suiteDir, { recursive: true });

        server = await startServerLight({
            testDir: suiteDir,
            dbProvider: 'sqlite',
            extraEnv: {
                // UI web E2E create-account can be blocked by content-keys binding; keep this suite focused on setup surfaces.
                HAPPIER_BUILD_FEATURES_DENY: 'sharing.contentKeys',
                HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
            },
        });

        ui = await startUiWeb({
            testDir: suiteDir,
            env: {
                ...uiWebEnv,
                EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl,
            },
        });

        uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
    });

    test.afterAll(async () => {
        test.setTimeout(120_000);
        await ui?.stop().catch(() => {});
        await server?.stop().catch(() => {});
    });

    test('runs deterministic setup through pairing and fails closed until the simulated machine is reachable', async ({ page }) => {
        test.setTimeout(420_000);
        if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

        await page.setViewportSize({ width: 1440, height: 900 });
        await materializeDeterministicTerminalAuthRequest({ page, serverBaseUrl: server.baseUrl });
        const pairingResponses: string[] = [];
        page.on('request', (request) => {
            if (request.method() === 'POST' && request.url().includes('/v1/auth/response')) {
                pairingResponses.push(request.url());
            }
        });

        await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 180_000);
        await setFakeTauriInternalsInExistingDocument(page);
        await navigateSpa(page, '/setup?happier_hmr=0');

        // Pre-auth setup route continues into the auth flow.
        await expect(page.getByTestId('setup.continueToAuth')).toHaveCount(1, { timeout: 120_000 });
        await page.getByTestId('setup.continueToAuth').click();

        await ensureAccountReadyForConnect({ page, timeoutMs: 180_000 });
        await navigateSpa(page, '/?happier_hmr=0');

        // The deterministic bridge exercises the real pairing request and approval exchange.
        // It deliberately does not register a live machine socket with the relay, so the final
        // reachability proof must block instead of treating task completion as readiness.
        await expect.poll(() => pairingResponses.length, { timeout: 120_000 }).toBeGreaterThan(0);
        await expect(page.getByTestId('desktop-setup-gate:retry')).toHaveCount(1, { timeout: 120_000 });
    });
});
