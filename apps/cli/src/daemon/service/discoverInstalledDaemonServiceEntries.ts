import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, join, win32 as win32Path } from 'node:path';

import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';
import { readPositiveIntEnv } from '@/utils/readPositiveIntEnv';

import { DAEMON_SERVICE_AUTOSTART_ENV_KEY, type DaemonServiceAutostartMode, type DaemonServiceMode, type DaemonServiceTargetMode } from './plan';

export type InstalledDaemonServiceEntry = Readonly<{
  serverId: string;
  activeServerId?: string | null;
  name: string;
  relayUrl?: string | null;
  installed: true;
  path: string;
  platform: 'darwin' | 'linux' | 'win32';
  mode?: DaemonServiceMode;
  happierHomeDir?: string | null;
  releaseChannel: PublicReleaseRingId;
  label: string;
  targetMode: DaemonServiceTargetMode;
}>;

type InstalledServicePathMatch = Readonly<{
  serverId: string;
  releaseChannel: PublicReleaseRingId;
  label: string;
  targetMode: DaemonServiceTargetMode;
}>;

function parseInstalledServicePath(platform: 'darwin' | 'linux' | 'win32', path: string): InstalledServicePathMatch | null {
  const fileName = platform === 'win32' ? win32Path.basename(path) : basename(path);
  const rawLegacyMatch =
    platform === 'linux'
      ? /^happier-daemon\.service$/i.test(fileName)
      : platform === 'darwin'
        ? /^com\.happier\.cli\.daemon\.plist$/i.test(fileName)
        : /^happier-daemon\.ps1$/i.test(fileName);
  if (rawLegacyMatch) {
    const label = platform === 'win32'
      ? `Happier\\${win32Path.basename(path, '.ps1')}`
      : platform === 'darwin'
        ? basename(path, '.plist')
        : basename(path, '.service');
    return {
      serverId: 'default',
      releaseChannel: 'stable',
      label,
      targetMode: 'default-following',
    };
  }

  const match =
    platform === 'linux'
      ? /^happier-daemon(?:\.(preview|dev))?\.(.+)\.service$/i.exec(fileName)
      : platform === 'darwin'
        ? /^com\.happier\.cli\.daemon(?:\.(preview|dev))?\.(.+)\.plist$/i.exec(fileName)
        : /^happier-daemon(?:\.(preview|dev))?\.(.+)\.ps1$/i.exec(fileName);
  if (!match) {
    return null;
  }
  const channelSegment = String(match[1] ?? '').trim().toLowerCase();
  const serverId = String(match[2] ?? '').trim();
  if (!serverId) {
    return null;
  }
  const releaseChannel = channelSegment === 'preview'
    ? 'preview'
    : channelSegment === 'dev'
      ? 'publicdev'
      : 'stable';
  const targetMode: DaemonServiceTargetMode = serverId === 'default' ? 'default-following' : 'pinned';
  const label = platform === 'win32'
    ? `Happier\\${win32Path.basename(path, '.ps1')}`
    : platform === 'darwin'
      ? basename(path, '.plist')
      : basename(path, '.service');
  return { serverId, releaseChannel, label, targetMode };
}

function normalizeParsedReleaseChannel(value: string | null): PublicReleaseRingId | null {
  if (value === 'preview') return 'preview';
  if (value === 'dev') return 'publicdev';
  if (value === 'stable') return 'stable';
  return null;
}

function isLegacyEnvHashServiceId(serverId: string): boolean {
  return /^env_[0-9a-f]+$/iu.test(String(serverId ?? '').trim());
}

function resolveDiscoveredServiceIdentity(params: Readonly<{
  parsed: InstalledServicePathMatch;
  activeServerId: string | null;
}>): string {
  if (
    params.parsed.targetMode === 'pinned'
    && params.activeServerId
    && isLegacyEnvHashServiceId(params.parsed.serverId)
  ) {
    return params.activeServerId;
  }
  return params.parsed.serverId;
}

function readInstalledServiceFile(path: string): string | null {
  try {
    return fs.readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function unescapeSystemdValue(value: string): string {
  return String(value ?? '')
    .replaceAll('%%', '%')
    .replaceAll('\\n', '\n')
    .replaceAll('\\"', '"')
    .replaceAll('\\\\', '\\');
}

function stripSystemdQuotes(value: string): string {
  const s = String(value ?? '').trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return unescapeSystemdValue(s.slice(1, -1));
  }
  return unescapeSystemdValue(s);
}

function parseLinuxUnitValue(contents: string, key: string): string | null {
  const normalizedKey = String(key ?? '').trim();
  if (!normalizedKey) return null;

  const lines = String(contents ?? '').split(/\r?\n/u);
  for (const lineRaw of lines) {
    const line = String(lineRaw ?? '').trim();
    if (!line || !/^Environment=/i.test(line)) continue;

    let assignment = line.slice('Environment='.length).trim();
    assignment = stripSystemdQuotes(assignment);

    const eqIdx = assignment.indexOf('=');
    if (eqIdx <= 0) continue;

    const foundKey = assignment.slice(0, eqIdx).trim();
    if (foundKey !== normalizedKey) continue;

    const rawValue = assignment.slice(eqIdx + 1);
    const value = stripSystemdQuotes(rawValue).trim();
    return value || null;
  }

  return null;
}

function parseDarwinPlistValue(contents: string, key: string): string | null {
  const match = new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`, 'i').exec(contents);
  return String(match?.[1] ?? '').trim() || null;
}

/** A `<true/>`/`<false/>` plist key, or `null` when the definition declares neither. */
function parseDarwinPlistBoolean(contents: string, key: string): boolean | null {
  const match = new RegExp(`<key>${key}</key>\\s*<(true|false)\\s*/>`, 'i').exec(contents);
  const value = String(match?.[1] ?? '').trim().toLowerCase();
  return value === 'true' ? true : value === 'false' ? false : null;
}

function parseWindowsWrapperValue(contents: string, key: string): string | null {
  const match = new RegExp(`\\$env:${key}\\s*=\\s*['"]([^'"]+)['"]`, 'i').exec(contents);
  return String(match?.[1] ?? '').trim() || null;
}

function parseCsvFirstField(line: string): string | null {
  const trimmed = String(line ?? '').trim();
  if (!trimmed) return null;
  const match = /^"((?:[^"]|"")*)"/u.exec(trimmed);
  if (!match) return null;
  return match[1]?.replaceAll('""', '"').trim() || null;
}

function normalizeWindowsScheduledTaskName(taskName: string): string | null {
  const normalized = String(taskName ?? '')
    .trim()
    .replaceAll('/', '\\')
    .replace(/\\+/gu, '\\')
    .replace(/^\\+/u, '');
  return normalized || null;
}

function parseWindowsScheduledTaskWrapperPathFromXml(contents: string): string | null {
  const argumentsMatch = /<Arguments>([\s\S]*?)<\/Arguments>/iu.exec(String(contents ?? ''));
  if (!argumentsMatch) return null;
  const argumentsText = argumentsMatch[1]
    ?.replaceAll('&quot;', '"')
    ?.replaceAll('&apos;', '\'')
    ?.replaceAll('&amp;', '&')
    ?.trim();
  if (!argumentsText) return null;

  const quotedMatch = /-File\s+"([^"]+\.ps1)"/iu.exec(argumentsText);
  if (quotedMatch?.[1]) {
    return quotedMatch[1].trim();
  }
  const bareMatch = /-File\s+([^\s]+\.ps1)/iu.exec(argumentsText);
  return bareMatch?.[1]?.trim() || null;
}

function parseWindowsScheduledTaskWrapperPathFromTaskToRun(taskToRunText: string): string | null {
  const taskToRun = String(taskToRunText ?? '').trim();
  if (!taskToRun) {
    return null;
  }
  const quotedMatch = /-File\s+"([^"]+\.ps1)"/iu.exec(taskToRun);
  if (quotedMatch?.[1]) {
    return quotedMatch[1].trim();
  }
  const bareMatch = /-File\s+([^\s]+\.ps1)/iu.exec(taskToRun);
  return bareMatch?.[1]?.trim() || null;
}

function runWindowsSchtasksCommand(args: readonly string[]): ReturnType<typeof spawnSync> {
  const timeoutMs = readPositiveIntEnv('HAPPIER_WINDOWS_SCHTASKS_TIMEOUT_MS', 15_000);
  return spawnSync('schtasks', [...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
  });
}

function readWindowsScheduledTaskWrapperPath(taskName: string): string | null {
  const normalizedTaskName = normalizeWindowsScheduledTaskName(taskName);
  if (!normalizedTaskName) return null;

  try {
    const result = runWindowsSchtasksCommand(['/Query', '/TN', normalizedTaskName, '/XML']);
    if (result.status !== 0) {
      const fallback = runWindowsSchtasksCommand(['/Query', '/TN', normalizedTaskName, '/FO', 'LIST', '/V']);
      if (fallback.status !== 0) {
        return null;
      }
      return parseWindowsScheduledTaskWrapperPathFromTaskToRun(String(fallback.stdout ?? ''));
    }
    return parseWindowsScheduledTaskWrapperPathFromXml(String(result.stdout ?? ''))
      ?? (() => {
        const fallback = runWindowsSchtasksCommand(['/Query', '/TN', normalizedTaskName, '/FO', 'LIST', '/V']);
        if (fallback.status !== 0) {
          return null;
        }
        return parseWindowsScheduledTaskWrapperPathFromTaskToRun(String(fallback.stdout ?? ''));
      })();
  } catch {
    return null;
  }
}

function deriveWindowsScheduledTaskWrapperPath(taskName: string, servicesDir: string): string | null {
  const normalizedTaskName = normalizeWindowsScheduledTaskName(taskName);
  if (!normalizedTaskName) return null;

  const resolvedWrapperPath = readWindowsScheduledTaskWrapperPath(normalizedTaskName);
  if (resolvedWrapperPath) {
    return resolvedWrapperPath;
  }
  return null;
}

function deriveWindowsServiceHomeDirFromWrapperPath(wrapperPath: string | null): string | null {
  const normalizedPath = String(wrapperPath ?? '').trim();
  if (!normalizedPath) return null;
  const servicesSuffix = `${String.raw`\services`}`.toLowerCase();
  const normalizedLower = normalizedPath.toLowerCase();
  const index = normalizedLower.lastIndexOf(servicesSuffix);
  if (index <= 0) {
    return null;
  }
  return normalizedPath.slice(0, index);
}

function listWindowsScheduledTaskWrapperPaths(servicesDir: string): readonly string[] {
  try {
    const result = runWindowsSchtasksCommand(['/Query', '/FO', 'CSV', '/NH']);
    if (result.status !== 0) {
      return [];
    }

    return String(result.stdout ?? '')
      .split(/\r?\n/u)
      .map((line) => parseCsvFirstField(line))
      .filter((taskName): taskName is string => Boolean(taskName))
      .map((taskName) => normalizeWindowsScheduledTaskName(taskName))
      .filter((taskName): taskName is string => Boolean(taskName))
      .filter((taskName) => taskName.toLowerCase().startsWith('happier\\happier-daemon'))
      .map((taskName) => deriveWindowsScheduledTaskWrapperPath(taskName, servicesDir))
      .filter((wrapperPath): wrapperPath is string => Boolean(wrapperPath));
  } catch {
    return [];
  }
}

function hasDaemonStartSyncCommand(contents: string): boolean {
  return /\bdaemon\b[\s"']+\bstart-sync\b/i.test(contents);
}

function hasDarwinDaemonStartSyncCommand(contents: string): boolean {
  return /<string>\s*daemon\s*<\/string>\s*<string>\s*start-sync\s*<\/string>/i.test(contents);
}

function hasLegacyManagedLinuxServiceEnv(path: string): boolean {
  return readInstalledDaemonServiceEnvValue({ platform: 'linux', path, key: 'HAPPIER_HOME_DIR' }) !== null
    || readInstalledDaemonServiceEnvValue({ platform: 'linux', path, key: 'HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR' }) !== null;
}

function hasLegacyManagedDarwinServiceEnv(path: string): boolean {
  return readInstalledDaemonServiceEnvValue({ platform: 'darwin', path, key: 'HAPPIER_HOME_DIR' }) !== null
    || readInstalledDaemonServiceEnvValue({ platform: 'darwin', path, key: 'HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR' }) !== null;
}

function hasLegacyManagedWindowsServiceEnv(path: string): boolean {
  return readInstalledDaemonServiceEnvValue({ platform: 'win32', path, key: 'HAPPIER_HOME_DIR' }) !== null
    || readInstalledDaemonServiceEnvValue({ platform: 'win32', path, key: 'HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR' }) !== null;
}

export function readInstalledDaemonServiceEnvValue(params: Readonly<{
  platform: 'darwin' | 'linux' | 'win32';
  path: string;
  key: string;
}>): string | null {
  const contents = readInstalledServiceFile(params.path);
  if (!contents) {
    return null;
  }

  if (params.platform === 'linux') {
    return parseLinuxUnitValue(contents, params.key);
  }
  if (params.platform === 'darwin') {
    return parseDarwinPlistValue(contents, params.key);
  }
  return parseWindowsWrapperValue(contents, params.key);
}

export function isValidInstalledDaemonServiceFile(params: Readonly<{
  platform: 'darwin' | 'linux' | 'win32';
  path: string;
  expectedLabel: string;
}>): boolean {
  const contents = readInstalledServiceFile(params.path);
  if (!contents) {
    return false;
  }

  if (params.platform === 'darwin') {
    return parseDarwinPlistValue(contents, 'Label') === params.expectedLabel
      && hasDarwinDaemonStartSyncCommand(contents)
      && (
        parseDarwinPlistValue(contents, 'HAPPIER_DAEMON_STARTUP_SOURCE') === 'background-service'
        || hasLegacyManagedDarwinServiceEnv(params.path)
      );
  }

  if (params.platform === 'linux') {
    return /(^|\n)ExecStart=/.test(contents)
      && hasDaemonStartSyncCommand(contents)
      && (
        parseLinuxUnitValue(contents, 'HAPPIER_DAEMON_STARTUP_SOURCE') === 'background-service'
        || hasLegacyManagedLinuxServiceEnv(params.path)
      );
  }

  return hasDaemonStartSyncCommand(contents)
    && (
      parseWindowsWrapperValue(contents, 'HAPPIER_DAEMON_STARTUP_SOURCE') === 'background-service'
      || hasLegacyManagedWindowsServiceEnv(params.path)
    );
}

/**
 * The one rule for reading an installed service definition's target mode.
 *
 * The definition declares the mode the installer chose, so that declaration decides. The file
 * name is only the fallback for a definition that predates the declaration: it cannot decide on
 * its own, because a stable-ring service pinned to the profile named `default` occupies exactly
 * the file name the default-following installation uses.
 */
function resolveInstalledDaemonServiceTargetMode(params: Readonly<{
  platform: 'darwin' | 'linux' | 'win32';
  path: string;
  pathTargetMode: DaemonServiceTargetMode;
}>): DaemonServiceTargetMode {
  const declared = readInstalledDaemonServiceEnvValue({
    platform: params.platform,
    path: params.path,
    key: 'HAPPIER_DAEMON_SERVICE_TARGET_MODE',
  });
  if (declared === 'default-following' || declared === 'pinned') {
    return declared;
  }
  return params.pathTargetMode;
}

/**
 * The autostart mode of the service installed at `path`, or `null` when nothing proves one —
 * every definition written before the autostart dimension existed proves none, and `null` is
 * unknown rather than a mode a caller may act on.
 *
 * On darwin the login trigger IS the plist's own `RunAtLoad`, so that key decides: the recorded
 * declaration cannot outvote what launchd will actually do, which is what makes a hand-edited or
 * `launchctl`-rewritten plist report honestly. Linux and Windows keep the recorded declaration,
 * because their real trigger is a systemd enable symlink / a scheduled-task trigger and reading
 * either needs a `systemctl is-enabled` / `schtasks /Query` subprocess — this reader is
 * synchronous and runs on the healthy `daemon status` fast path, so it does not spawn one.
 *
 * This is the one rule for recovering the mode of an installed service, so a reinstall,
 * drift-refresh or repair preserves the choice the user made instead of silently restoring the
 * login trigger.
 */
export function readInstalledDaemonServiceAutostartMode(params: Readonly<{
  platform: 'darwin' | 'linux' | 'win32';
  path: string;
}>): DaemonServiceAutostartMode | null {
  if (params.platform === 'darwin') {
    const contents = readInstalledServiceFile(params.path);
    const runAtLoad = contents ? parseDarwinPlistBoolean(contents, 'RunAtLoad') : null;
    if (runAtLoad !== null) {
      return runAtLoad ? 'at-login' : 'on-demand';
    }
    return null;
  }

  const declared = readInstalledDaemonServiceEnvValue({
    platform: params.platform,
    path: params.path,
    key: DAEMON_SERVICE_AUTOSTART_ENV_KEY,
  });
  const normalized = String(declared ?? '').trim().toLowerCase();
  if (normalized === 'on-demand' || normalized === 'at-login') {
    return normalized;
  }
  return null;
}

/**
 * The target mode of the service definition installed at `path`, or `null` when this path holds
 * no readable Happier service definition. `null` is unknown — never a mode a caller may act on.
 */
export function readInstalledDaemonServiceTargetMode(params: Readonly<{
  platform: 'darwin' | 'linux' | 'win32';
  path: string;
}>): DaemonServiceTargetMode | null {
  const parsed = parseInstalledServicePath(params.platform, params.path);
  if (!parsed) {
    return null;
  }
  if (!isValidInstalledDaemonServiceFile({
    platform: params.platform,
    path: params.path,
    expectedLabel: parsed.label,
  })) {
    return null;
  }
  return resolveInstalledDaemonServiceTargetMode({
    platform: params.platform,
    path: params.path,
    pathTargetMode: parsed.targetMode,
  });
}

function parseInstalledServiceMetadata(params: Readonly<{
  platform: 'darwin' | 'linux' | 'win32';
  path: string;
  initialReleaseChannel: PublicReleaseRingId;
  initialTargetMode: DaemonServiceTargetMode;
}>): Readonly<{
  activeServerId: string | null;
  happierHomeDir: string | null;
  relayUrl: string | null;
  releaseChannel: PublicReleaseRingId;
  targetMode: DaemonServiceTargetMode;
}> {
  const contents = readInstalledServiceFile(params.path);
  if (!contents) {
    return {
      activeServerId: null,
      happierHomeDir: null,
      relayUrl: null,
      releaseChannel: params.initialReleaseChannel,
      targetMode: params.initialTargetMode,
    };
  }

  const readValue = (key: string) => readInstalledDaemonServiceEnvValue({
    platform: params.platform,
    path: params.path,
    key,
  });

  const parsedServerId = readValue('HAPPIER_ACTIVE_SERVER_ID');
  const parsedHappierHomeDir = readValue('HAPPIER_HOME_DIR') ?? readValue('HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR');
  const parsedRelayUrl = readValue('HAPPIER_PUBLIC_SERVER_URL') ?? readValue('HAPPIER_SERVER_URL');
  const parsedReleaseChannel = normalizeParsedReleaseChannel(readValue('HAPPIER_PUBLIC_RELEASE_CHANNEL'));
  return {
    activeServerId: parsedServerId,
    happierHomeDir: parsedHappierHomeDir,
    relayUrl: parsedRelayUrl,
    releaseChannel: parsedReleaseChannel ?? params.initialReleaseChannel,
    targetMode: resolveInstalledDaemonServiceTargetMode({
      platform: params.platform,
      path: params.path,
      pathTargetMode: params.initialTargetMode,
    }),
  };
}

export async function discoverInstalledDaemonServiceEntries(params: Readonly<{
  platform: 'darwin' | 'linux' | 'win32';
  userHomeDir: string;
  happierHomeDir: string;
  mode: DaemonServiceMode;
  serversById: Readonly<Record<string, unknown>>;
}>): Promise<readonly InstalledDaemonServiceEntry[]> {
  const servicesDir =
    params.platform === 'linux'
      ? params.mode === 'system'
        ? join('/etc', 'systemd', 'system')
        : join(params.userHomeDir, '.config', 'systemd', 'user')
      : params.platform === 'darwin'
        ? join(params.userHomeDir, 'Library', 'LaunchAgents')
        : join(params.happierHomeDir, 'services');

  let fileNames: string[] = [];
  try {
    fileNames = fs.readdirSync(servicesDir);
  } catch {
    return [];
  }

  const discoveredCandidates = [
    ...fileNames.map((fileName) => ({ path: join(servicesDir, fileName), source: 'file' as const })),
    ...(params.platform === 'win32'
      ? listWindowsScheduledTaskWrapperPaths(servicesDir).map((path) => ({ path, source: 'task' as const }))
      : []),
  ].filter((candidate, index, allCandidates) => allCandidates.findIndex((other) => other.path === candidate.path) === index);

  return discoveredCandidates
    .flatMap(({ path, source }) => {
      const parsed = parseInstalledServicePath(params.platform, path);
      if (!parsed) {
        return [];
      }
      const definitionExists = isValidInstalledDaemonServiceFile({
        platform: params.platform,
        path,
        expectedLabel: parsed.label,
      });
      if (!definitionExists && source !== 'task') {
        return [];
      }
      const metadata = parseInstalledServiceMetadata({
        platform: params.platform,
        path,
        initialReleaseChannel: parsed.releaseChannel,
        initialTargetMode: parsed.targetMode,
      });
      const activeServerId = String(metadata.activeServerId ?? '').trim() || null;
      const serviceServerId = resolveDiscoveredServiceIdentity({ parsed, activeServerId });
      const profileServerId = activeServerId ?? serviceServerId;
      const profile = params.serversById[profileServerId];
      const profileRelayUrl = typeof profile === 'object'
        && profile
        && !Array.isArray(profile)
        && typeof (profile as { serverUrl?: unknown }).serverUrl === 'string'
          ? String((profile as { serverUrl: string }).serverUrl).trim() || null
          : null;
      const name = metadata.targetMode === 'default-following'
        ? 'Default automatic startup'
        : typeof profile === 'object' && profile && !Array.isArray(profile) && typeof (profile as { name?: unknown }).name === 'string'
          ? String((profile as { name: string }).name).trim() || profileServerId
          : profileServerId;
      return [{
        serverId: serviceServerId,
        ...(activeServerId ? { activeServerId } : {}),
        name,
        relayUrl: metadata.relayUrl ?? profileRelayUrl,
        installed: true as const,
        path,
        platform: params.platform,
        mode: params.mode,
        happierHomeDir: metadata.happierHomeDir ?? (
          params.platform === 'win32' && !definitionExists
            ? deriveWindowsServiceHomeDirFromWrapperPath(path)
            : null
        ),
        releaseChannel: metadata.releaseChannel,
        label: parsed.label,
        targetMode: metadata.targetMode,
      }];
    });
}
