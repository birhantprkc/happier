import chalk from 'chalk';
import os from 'node:os';

import { formatAccountIdentity, formatRelayHost } from '@/auth/describeSignedInIdentity';
import { resolveActiveServerAuthReadiness } from '@/auth/resolveActiveServerAuthReadiness';
import { configuration } from '@/configuration';
import { checkIfDaemonRunningAndCleanupStaleState } from '@/daemon/controlClient';
import { printJsonEnvelope, wantsJson } from '@/cli/output/jsonEnvelope';
import { applyServerSelectionFromArgs } from '@/server/serverSelection';

export async function handleAuthStatus(argv: string[] = []): Promise<void> {
  const args = await applyServerSelectionFromArgs(argv);
  const json = wantsJson(args);
  const readiness = await resolveActiveServerAuthReadiness();
  const credentials = readiness.credentials;
  const relayHost = formatRelayHost(configuration.serverUrl);

  if (json && !credentials) {
    await printJsonEnvelope({ ok: false, kind: 'auth_status', error: { code: 'not_authenticated' } });
    return;
  }

  if (!json) {
    console.log(chalk.bold('\nAuthentication Status\n'));
  }

  if (!credentials) {
    console.log(chalk.red(`✗ Not authenticated on ${relayHost}`));
    console.log(chalk.gray('  Run "happier auth login" to authenticate'));
    return;
  }

  if (readiness.unusableReason === 'credentials-rejected') {
    if (json) {
      await printJsonEnvelope({ ok: false, kind: 'auth_status', error: { code: 'not_authenticated' } });
      return;
    }

    console.log(chalk.red(`✗ Not authenticated on ${relayHost}`));
    console.log(chalk.gray('  Stored credentials were rejected by the selected relay'));
    console.log(chalk.gray('  Run "happier auth login --force" to authenticate again'));
    return;
  }

  if (readiness.credentialState === 'unknown') {
    if (json) {
      await printJsonEnvelope({
        ok: false,
        kind: 'auth_status',
        error: {
          code: 'auth_unavailable',
          message: 'The selected relay did not answer; stored credentials were kept.',
          machineRegistered: readiness.machineRegistered,
          ...(readiness.machineRegistered && readiness.machineId ? { machineId: readiness.machineId } : {}),
        },
      });
      return;
    }

    console.log(chalk.yellow(`⚠️  Authentication could not be verified because ${relayHost} did not answer`));
    console.log(chalk.gray('  Stored credentials were kept unchanged. Retry when the relay is available.'));
    return;
  }

  const { machineId, machineRegistered, validatedAccountId, validatedAccountLabel } = readiness;
  const accountIdentity = formatAccountIdentity({ accountLabel: validatedAccountLabel, accountId: validatedAccountId });

  let daemonRunning = false;
  try {
    daemonRunning = await checkIfDaemonRunningAndCleanupStaleState();
  } catch {
    daemonRunning = false;
  }

  if (json) {
    await printJsonEnvelope({
      ok: true,
      kind: 'auth_status',
      data: {
        authenticated: true,
        ...(validatedAccountId ? { accountId: validatedAccountId } : {}),
        accountLabel: validatedAccountLabel,
        relayHost,
        encryption: { type: credentials.encryption.type },
        machineRegistered,
        ...(machineRegistered && machineId ? { machineId } : {}),
        host: os.hostname(),
        happyHomeDir: configuration.happyHomeDir,
        daemonRunning,
      },
    });
    return;
  }

  console.log(chalk.green(accountIdentity ? `✓ Authenticated as ${accountIdentity} on ${relayHost}` : `✓ Authenticated on ${relayHost}`));

  if (machineRegistered) {
    console.log(chalk.green('✓ Machine registered'));
    console.log(chalk.gray(`  Machine ID: ${machineId}`));
    console.log(chalk.gray(`  Host: ${os.hostname()}`));
  } else {
    console.log(chalk.yellow('⚠️  Machine not registered'));
    console.log(chalk.gray('  Run "happier auth login --force" to fix this'));
  }

  console.log(chalk.gray(`\n  Data directory: ${configuration.happyHomeDir}`));

  if (daemonRunning) {
    console.log(chalk.green('✓ Daemon running'));
  } else {
    console.log(chalk.gray('✗ Daemon not running'));
  }
}
