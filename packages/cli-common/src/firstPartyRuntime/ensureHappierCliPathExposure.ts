import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { basename, join, win32 } from 'node:path';

/**
 * PATH exposure for the managed Happier CLI, with provenance.
 *
 * The policy is a transcription of `apps/website/public/install.sh` (`append_path_hint`) and
 * `install.ps1` (user PATH update) so that Desktop and the shell installers deduplicate against
 * the same exact line / entry. Desktop marks only what it created and removes only that.
 * PATH exposure never gates readiness: every failure is returned as a message, never thrown.
 */

export interface HappierCliPathExposureResult {
  changed: boolean;
  shellReloadHint: string | null;
  failure: string | null;
}

export interface HappierCliPathRemovalResult {
  removed: boolean;
  failure: string | null;
}

export const HAPPIER_DESKTOP_PATH_MARKER_LINE = '# Added by Happier Desktop';

/** User-scoped environment variable holding the PATH entries Desktop added on Windows. */
export const HAPPIER_DESKTOP_WINDOWS_PATH_PROVENANCE_VARIABLE = 'HAPPIER_DESKTOP_PATH_ENTRIES';

const DESKTOP_EXPORT_LINE_PATTERN = /^export PATH="[^"\n]+:\$PATH"$/u;

export function renderHappierCliPathExportLine(binDir: string): string {
  return `export PATH="${binDir}:$PATH"`;
}

export function resolveHappierCliShellProfilePlan(params: Readonly<{
  shell: string | undefined;
  homeDir: string;
  fileExists: (path: string) => boolean;
}>): Readonly<{ rcFiles: readonly string[]; reloadFile: string }> {
  const shellName = basename(String(params.shell ?? '').trim());
  const home = params.homeDir;
  if (shellName === 'zsh') {
    return { rcFiles: [join(home, '.zshrc'), join(home, '.zprofile')], reloadFile: join(home, '.zshrc') };
  }
  if (shellName === 'bash') {
    const bashProfile = join(home, '.bash_profile');
    return {
      rcFiles: [join(home, '.bashrc'), params.fileExists(bashProfile) ? bashProfile : join(home, '.profile')],
      reloadFile: join(home, '.bashrc'),
    };
  }
  return { rcFiles: [join(home, '.profile')], reloadFile: join(home, '.profile') };
}

/**
 * Every profile file the table above can target, for any supported shell.
 *
 * `ensure` writes for the shell the user runs today; `remove` must undo what Desktop wrote under
 * whatever shell was current then, so it works over this union instead. `fileExists: () => true`
 * yields the maximal set (`.bash_profile` and `.profile` both appear); removal skips files that
 * are absent, so no probe is needed here.
 */
function resolveHappierCliShellProfileUnion(homeDir: string): readonly string[] {
  const files = new Set<string>();
  for (const shell of ['zsh', 'bash', '']) {
    for (const rcFile of resolveHappierCliShellProfilePlan({ shell, homeDir, fileExists: () => true }).rcFiles) {
      files.add(rcFile);
    }
  }
  return [...files];
}

function isPathUpdateDisabled(processEnv: NodeJS.ProcessEnv): boolean {
  return String(processEnv.HAPPIER_NO_PATH_UPDATE ?? '').trim() === '1';
}

function describeError(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message.trim() : String(error);
}

export async function ensureHappierCliPathExposure(params: Readonly<{
  binDir: string;
  processEnv: NodeJS.ProcessEnv;
}>): Promise<HappierCliPathExposureResult> {
  if (isPathUpdateDisabled(params.processEnv)) {
    return { changed: false, shellReloadHint: null, failure: null };
  }
  if (process.platform === 'win32') {
    return await ensureWindowsUserPathExposure(params);
  }
  return await ensurePosixProfileExposure(params);
}

export async function removeHappierCliPathExposure(params: Readonly<{
  processEnv: NodeJS.ProcessEnv;
}>): Promise<HappierCliPathRemovalResult> {
  if (process.platform === 'win32') {
    return await removeWindowsUserPathExposure(params);
  }
  return await removePosixProfileExposure(params);
}

// POSIX: shell profiles ------------------------------------------------------------------------

function resolvePosixHomeDir(processEnv: NodeJS.ProcessEnv): string {
  return String(processEnv.HOME ?? '').trim() || homedir();
}

function resolvePosixProfilePlan(processEnv: NodeJS.ProcessEnv) {
  // A desktop app launched from a launcher may not inherit $SHELL; the login shell is the same
  // fact `$SHELL` carries in a terminal, so it is the equivalent input for the installer's table.
  const shell = String(processEnv.SHELL ?? '').trim() || readLoginShell();
  return resolveHappierCliShellProfilePlan({ shell, homeDir: resolvePosixHomeDir(processEnv), fileExists: existsSync });
}

function readLoginShell(): string | undefined {
  try {
    return userInfo().shell ?? undefined;
  } catch {
    return undefined;
  }
}

function profileContainsLine(content: string, line: string): boolean {
  return content.split('\n').some((candidate) => candidate.trim() === line);
}

async function ensurePosixProfileExposure(params: Readonly<{
  binDir: string;
  processEnv: NodeJS.ProcessEnv;
}>): Promise<HappierCliPathExposureResult> {
  const plan = resolvePosixProfilePlan(params.processEnv);
  const exportLine = renderHappierCliPathExportLine(params.binDir);
  let changed = false;
  const failures: string[] = [];

  for (const rcFile of plan.rcFiles) {
    try {
      const existing = existsSync(rcFile) ? await readFile(rcFile, 'utf8') : null;
      if (existing !== null && profileContainsLine(existing, exportLine)) {
        continue;
      }
      // Same shape as the installer's `printf '\n%s\n'`, with the provenance marker directly above.
      await appendFile(rcFile, `\n${HAPPIER_DESKTOP_PATH_MARKER_LINE}\n${exportLine}\n`, 'utf8');
      changed = true;
    } catch (error) {
      failures.push(`${rcFile}: ${describeError(error)}`);
    }
  }

  return {
    changed,
    shellReloadHint: changed ? `Open a new terminal, or run: source "${plan.reloadFile}"` : null,
    failure: failures.length > 0 ? `Could not update shell profile ${failures.join('; ')}` : null,
  };
}

function stripDesktopCreatedLines(content: string): Readonly<{ content: string; removed: boolean }> {
  const lines = content.split('\n');
  const kept: string[] = [];
  let removed = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const next = lines[index + 1];
    if (line.trim() === HAPPIER_DESKTOP_PATH_MARKER_LINE && next !== undefined && DESKTOP_EXPORT_LINE_PATTERN.test(next.trim())) {
      if (kept.length > 0 && kept[kept.length - 1] === '') {
        // Drop the separator blank line the append wrote in front of the marker.
        kept.pop();
      }
      index += 1;
      removed = true;
      continue;
    }
    kept.push(line);
  }
  return { content: removed ? kept.join('\n') : content, removed };
}

async function removePosixProfileExposure(params: Readonly<{
  processEnv: NodeJS.ProcessEnv;
}>): Promise<HappierCliPathRemovalResult> {
  let removed = false;
  const failures: string[] = [];

  for (const rcFile of resolveHappierCliShellProfileUnion(resolvePosixHomeDir(params.processEnv))) {
    try {
      if (!existsSync(rcFile)) {
        continue;
      }
      const stripped = stripDesktopCreatedLines(await readFile(rcFile, 'utf8'));
      if (!stripped.removed) {
        continue;
      }
      await writeFile(rcFile, stripped.content, 'utf8');
      removed = true;
    } catch (error) {
      failures.push(`${rcFile}: ${describeError(error)}`);
    }
  }

  return {
    removed,
    failure: failures.length > 0 ? `Could not update shell profile ${failures.join('; ')}` : null,
  };
}

// Windows: user PATH in the environment (HKCU\Environment) --------------------------------------

function splitWindowsPathEntries(value: string | null): string[] {
  return String(value ?? '').split(';').map((entry) => entry.trim()).filter(Boolean);
}

function sameWindowsPathEntry(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

export function planWindowsUserPathExposure(params: Readonly<{
  userPath: string | null;
  provenance: string | null;
  binDir: string;
}>): Readonly<{ changed: boolean; userPath: string; provenance: string | null }> {
  const currentPath = params.userPath ?? '';
  const entries = splitWindowsPathEntries(currentPath);
  if (entries.some((entry) => sameWindowsPathEntry(entry, params.binDir))) {
    return { changed: false, userPath: currentPath, provenance: params.provenance };
  }
  const provenanceEntries = splitWindowsPathEntries(params.provenance);
  return {
    changed: true,
    userPath: [params.binDir, ...entries].join(';'),
    provenance: [...provenanceEntries, params.binDir].join(';'),
  };
}

export function planWindowsUserPathRemoval(params: Readonly<{
  userPath: string | null;
  provenance: string | null;
}>): Readonly<{ removed: boolean; userPath: string; provenance: string | null }> {
  const currentPath = params.userPath ?? '';
  const desktopCreated = splitWindowsPathEntries(params.provenance);
  if (desktopCreated.length === 0) {
    return { removed: false, userPath: currentPath, provenance: params.provenance };
  }
  const remaining = splitWindowsPathEntries(currentPath)
    .filter((entry) => !desktopCreated.some((created) => sameWindowsPathEntry(created, entry)));
  return { removed: true, userPath: remaining.join(';'), provenance: null };
}

type WindowsUserEnvironmentSnapshot = Readonly<{
  userPath: string | null;
  userPathKind: 'String' | 'ExpandString';
  provenance: string | null;
}>;

/**
 * Names of the environment variables the PowerShell scripts read their inputs from.
 *
 * The values travel through the child environment, never as argv: `powershell.exe -Command` folds
 * every argument after the script into the command text it parses, and a user `Path` contains `;`
 * — PowerShell's statement separator — so passing it positionally truncates the value and then
 * evaluates the rest as code.
 */
const WINDOWS_SCRIPT_ENV = {
  provenanceName: 'HAPPIER_PATH_PROVENANCE_NAME',
  userPath: 'HAPPIER_PATH_USER_PATH',
  valueKind: 'HAPPIER_PATH_VALUE_KIND',
  provenanceValue: 'HAPPIER_PATH_PROVENANCE_VALUE',
} as const;

const WINDOWS_READ_USER_ENVIRONMENT_SCRIPT = [
  '& {',
  `$ProvenanceName = $env:${WINDOWS_SCRIPT_ENV.provenanceName}`,
  "$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $false)",
  '$userPath = $null',
  "$kind = 'ExpandString'",
  '$provenance = $null',
  'if ($key) {',
  "  $userPath = $key.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)",
  "  if ($null -ne $userPath -and ($key.GetValueNames() -contains 'Path')) { $kind = $key.GetValueKind('Path').ToString() }",
  '  $provenance = $key.GetValue($ProvenanceName, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)',
  '  $key.Close()',
  '}',
  '[pscustomobject]@{ userPath = $userPath; userPathKind = $kind; provenance = $provenance } | ConvertTo-Json -Compress',
  '}',
].join('\n');

// Writes Path with its existing registry kind (so %VAR% entries keep expanding), then writes the
// provenance variable through [Environment], whose user-scope write broadcasts WM_SETTINGCHANGE so
// new terminals see both values.
const WINDOWS_WRITE_USER_ENVIRONMENT_SCRIPT = [
  '& {',
  `$UserPath = $env:${WINDOWS_SCRIPT_ENV.userPath}`,
  `$Kind = $env:${WINDOWS_SCRIPT_ENV.valueKind}`,
  `$ProvenanceName = $env:${WINDOWS_SCRIPT_ENV.provenanceName}`,
  `$Provenance = $env:${WINDOWS_SCRIPT_ENV.provenanceValue}`,
  // Refuse to write rather than clear the user PATH if the value did not arrive.
  `if (-not $UserPath) { throw '${WINDOWS_SCRIPT_ENV.userPath} is not set.' }`,
  "$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)",
  "if (-not $key) { $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment') }",
  "$valueKind = if ($Kind -eq 'String') { [Microsoft.Win32.RegistryValueKind]::String } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }",
  "$key.SetValue('Path', $UserPath, $valueKind)",
  '$key.Close()',
  "if ($Provenance) { [Environment]::SetEnvironmentVariable($ProvenanceName, $Provenance, [EnvironmentVariableTarget]::User) }",
  "else { [Environment]::SetEnvironmentVariable($ProvenanceName, $null, [EnvironmentVariableTarget]::User) }",
  '}',
].join('\n');

function parseWindowsUserEnvironmentSnapshot(stdout: string): WindowsUserEnvironmentSnapshot {
  const parsed: unknown = JSON.parse(stdout.trim());
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Unexpected user environment snapshot shape.');
  }
  const record = parsed as Record<string, unknown>;
  return {
    userPath: typeof record.userPath === 'string' ? record.userPath : null,
    userPathKind: record.userPathKind === 'String' ? 'String' : 'ExpandString',
    provenance: typeof record.provenance === 'string' && record.provenance.trim() ? record.provenance : null,
  };
}

function resolveWindowsPowerShellPath(processEnv: NodeJS.ProcessEnv): string {
  const systemRoot = String(processEnv.SystemRoot ?? processEnv.SYSTEMROOT ?? processEnv.windir ?? processEnv.WINDIR ?? '').trim();
  if (!systemRoot) {
    throw new Error('SystemRoot is unavailable; cannot locate powershell.exe.');
  }
  return win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function runWindowsPowerShell(
  processEnv: NodeJS.ProcessEnv,
  script: string,
  scriptEnv: Readonly<Record<string, string>>,
): Promise<string> {
  const powershell = resolveWindowsPowerShellPath(processEnv);
  return new Promise((resolve, reject) => {
    execFile(
      powershell,
      // The script is the last token on purpose — see WINDOWS_SCRIPT_ENV.
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { encoding: 'utf8', windowsHide: true, env: { ...processEnv, ...scriptEnv } },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`powershell.exe failed: ${String(stderr).trim() || error.message}`));
          return;
        }
        resolve(String(stdout));
      },
    );
  });
}

async function readWindowsUserEnvironment(processEnv: NodeJS.ProcessEnv): Promise<WindowsUserEnvironmentSnapshot> {
  const stdout = await runWindowsPowerShell(processEnv, WINDOWS_READ_USER_ENVIRONMENT_SCRIPT, {
    [WINDOWS_SCRIPT_ENV.provenanceName]: HAPPIER_DESKTOP_WINDOWS_PATH_PROVENANCE_VARIABLE,
  });
  return parseWindowsUserEnvironmentSnapshot(stdout);
}

async function writeWindowsUserEnvironment(processEnv: NodeJS.ProcessEnv, value: Readonly<{
  userPath: string;
  userPathKind: WindowsUserEnvironmentSnapshot['userPathKind'];
  provenance: string | null;
}>): Promise<void> {
  await runWindowsPowerShell(processEnv, WINDOWS_WRITE_USER_ENVIRONMENT_SCRIPT, {
    [WINDOWS_SCRIPT_ENV.userPath]: value.userPath,
    [WINDOWS_SCRIPT_ENV.valueKind]: value.userPathKind,
    [WINDOWS_SCRIPT_ENV.provenanceName]: HAPPIER_DESKTOP_WINDOWS_PATH_PROVENANCE_VARIABLE,
    [WINDOWS_SCRIPT_ENV.provenanceValue]: value.provenance ?? '',
  });
}

async function ensureWindowsUserPathExposure(params: Readonly<{
  binDir: string;
  processEnv: NodeJS.ProcessEnv;
}>): Promise<HappierCliPathExposureResult> {
  try {
    const snapshot = await readWindowsUserEnvironment(params.processEnv);
    const planned = planWindowsUserPathExposure({
      userPath: snapshot.userPath,
      provenance: snapshot.provenance,
      binDir: params.binDir,
    });
    if (!planned.changed) {
      return { changed: false, shellReloadHint: null, failure: null };
    }
    await writeWindowsUserEnvironment(params.processEnv, {
      userPath: planned.userPath,
      userPathKind: snapshot.userPathKind,
      provenance: planned.provenance,
    });
    return { changed: true, shellReloadHint: 'Open a new terminal to use happier.', failure: null };
  } catch (error) {
    return { changed: false, shellReloadHint: null, failure: `Could not update the user PATH: ${describeError(error)}` };
  }
}

async function removeWindowsUserPathExposure(params: Readonly<{
  processEnv: NodeJS.ProcessEnv;
}>): Promise<HappierCliPathRemovalResult> {
  try {
    const snapshot = await readWindowsUserEnvironment(params.processEnv);
    const planned = planWindowsUserPathRemoval({ userPath: snapshot.userPath, provenance: snapshot.provenance });
    if (!planned.removed) {
      return { removed: false, failure: null };
    }
    await writeWindowsUserEnvironment(params.processEnv, {
      userPath: planned.userPath,
      userPathKind: snapshot.userPathKind,
      provenance: planned.provenance,
    });
    return { removed: true, failure: null };
  } catch (error) {
    return { removed: false, failure: `Could not update the user PATH: ${describeError(error)}` };
  }
}
