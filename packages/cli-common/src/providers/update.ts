import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type {
  AgentId,
  ProviderCliInstallSource,
  ProviderCliRuntimeInstallPlatform as ProviderCliInstallPlatform,
} from '@happier-dev/agents';
import {
  getProviderCliRuntimeSpec,
  resolveProviderCliLatestVersionSource,
  resolveProviderCliNpmPackageName,
} from '@happier-dev/agents';
import { fetchGitHubLatestRelease } from '@happier-dev/release-runtime';

import { resolveHomeDirFromEnvironment, type ProviderCliResolutionSource } from './resolution.js';

export type ProviderCliUpdateFacts = Readonly<{
  installSource: ProviderCliInstallSource;
  /** Happier can run the update itself (managed reinstall, or the verified vendor updater). */
  updateSupported: boolean;
  /** The command a person can run to update this install, when one is known. */
  updateCommand: string | null;
  /** Arguments for the vendor updater, run against the resolved executable. */
  nativeUpdateArgs: ReadonlyArray<string> | null;
}>;

const OTHER: ProviderCliUpdateFacts = {
  installSource: 'other',
  updateSupported: false,
  updateCommand: null,
  nativeUpdateArgs: null,
};

function toComparablePath(path: string, platform: ProviderCliInstallPlatform): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isSameOrWithin(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

function quoteCommandPath(path: string, platform: ProviderCliInstallPlatform): string {
  if (!/[\s'"&;|()$`]/.test(path)) return path;
  if (platform === 'win32') return `& "${path.replaceAll('"', '`"')}"`;
  return `'${path.replaceAll("'", `'\\''`)}'`;
}

function packageManagerFacts(
  installSource: Extract<ProviderCliInstallSource, 'npm' | 'pnpm' | 'bun' | 'brew'>,
  updateCommand: string,
): ProviderCliUpdateFacts {
  // Happier does not spawn package managers from product runtime paths; the
  // owner's command is surfaced for the person to run.
  return { installSource, updateSupported: false, updateCommand, nativeUpdateArgs: null };
}

/**
 * Attributes an installed agent CLI to the owner that can update it, from the
 * exact executable the detect owner resolved (and its real path) plus catalog
 * facts. Anything unproven stays `other` with no command, so Happier never runs
 * or suggests an updater that does not own the install.
 */
export function classifyProviderCliInstall(params: Readonly<{
  providerId: AgentId;
  command: string;
  source: ProviderCliResolutionSource;
  platform: ProviderCliInstallPlatform;
  env?: NodeJS.ProcessEnv;
}>): ProviderCliUpdateFacts {
  const spec = getProviderCliRuntimeSpec(params.providerId);
  if (params.source === 'managed') {
    return {
      installSource: 'managed',
      updateSupported: spec.managedInstall !== null,
      updateCommand: null,
      nativeUpdateArgs: null,
    };
  }
  if (params.source === 'override') return OTHER;

  const env = params.env ?? process.env;
  const platform = params.platform;
  const realPath = (() => {
    try {
      return realpathSync(params.command);
    } catch {
      return params.command;
    }
  })();
  const paths = [params.command, realPath].map((path) => toComparablePath(path, platform));
  const home = toComparablePath(resolveHomeDirFromEnvironment(env), platform);

  const nativeUpdate = spec.nativeUpdate ?? null;
  if (nativeUpdate) {
    const roots = nativeUpdate.installPaths.map((relative) => toComparablePath(`${home}/${relative}`, platform));
    if (paths.some((path) => roots.some((root) => isSameOrWithin(path, root)))) {
      return {
        installSource: 'native',
        updateSupported: true,
        updateCommand: [quoteCommandPath(params.command, platform), ...nativeUpdate.args].join(' '),
        nativeUpdateArgs: [...nativeUpdate.args],
      };
    }
  }

  const packageName = resolveProviderCliNpmPackageName(spec);
  if (packageName) {
    const comparablePackageName = toComparablePath(packageName, platform);
    const packageSegment = `/node_modules/${comparablePackageName}/`;
    const insidePackage = paths.some((path) => `${path}/`.includes(packageSegment));
    if (insidePackage && paths.some((path) => path.includes('/.bun/install/global/'))) {
      return packageManagerFacts('bun', `bun add -g ${packageName}@latest`);
    }
    const pnpmHome = typeof env.PNPM_HOME === 'string' && env.PNPM_HOME.trim()
      ? toComparablePath(env.PNPM_HOME.trim(), platform)
      : null;
    if (
      (insidePackage && paths.some((path) => path.includes('/pnpm/global/')))
      || (pnpmHome !== null && toComparablePath(dirname(params.command), platform) === pnpmHome)
    ) {
      return packageManagerFacts('pnpm', `pnpm add -g ${packageName}@latest`);
    }
    // POSIX npm links `<prefix>/bin/<cmd>` into the package, so the real path is the
    // proof; Windows npm writes a `.cmd` shim beside `node_modules/<pkg>`.
    const windowsShimProof = existsSync(join(dirname(params.command), 'node_modules', ...packageName.split('/'), 'package.json'));
    if (insidePackage || windowsShimProof) {
      return packageManagerFacts('npm', `npm install -g ${packageName}@latest`);
    }
  }

  const keg = /\/(Cellar|Caskroom)\/([^/]+)\//i.exec(toComparablePath(realPath, platform));
  if (keg) {
    const name = keg[2]!;
    return packageManagerFacts('brew', keg[1]!.toLowerCase() === 'caskroom' ? `brew upgrade --cask ${name}` : `brew upgrade ${name}`);
  }

  return OTHER;
}

function extractVersion(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/.exec(value);
  return match?.[0] ?? null;
}

function buildNpmLatestUrl(packageName: string): string {
  return `https://registry.npmjs.org/${packageName.replace('/', '%2F')}/latest`;
}

/**
 * Reads the newest published version from the catalog's latest-version source
 * (the managed owner's source, else the vendor npm package). Resolves `null`
 * when the catalog declares no source or the payload carries no version, and
 * rejects on transport/registry failure so callers can decide what to cache.
 */
export async function fetchProviderCliLatestVersion(params: Readonly<{
  providerId: AgentId;
  env?: NodeJS.ProcessEnv;
  deps?: Readonly<{
    fetchImpl?: typeof fetch;
    fetchGitHubLatestRelease?: typeof fetchGitHubLatestRelease;
  }>;
}>): Promise<string | null> {
  const source = resolveProviderCliLatestVersionSource(getProviderCliRuntimeSpec(params.providerId));
  if (!source) return null;
  const env = params.env ?? process.env;

  if (source.kind === 'github_release') {
    const release = await (params.deps?.fetchGitHubLatestRelease ?? fetchGitHubLatestRelease)({
      githubRepo: source.githubRepo,
      userAgent: 'happier-cli',
      githubToken: env.GITHUB_TOKEN,
    });
    const tag = release && typeof release === 'object' ? (release as { tag_name?: unknown }).tag_name : null;
    return extractVersion(tag);
  }

  const fetchImpl = params.deps?.fetchImpl ?? globalThis.fetch;
  const url = buildNpmLatestUrl(source.packageName);
  const response = await fetchImpl(url, {
    headers: { accept: 'application/json', 'user-agent': 'happier-cli' },
  });
  if (!response.ok) {
    throw new Error(`[npm] failed to resolve latest ${source.packageName} (${response.status})`);
  }
  const payload = (await response.json()) as { version?: unknown } | null;
  return extractVersion(payload?.version);
}
