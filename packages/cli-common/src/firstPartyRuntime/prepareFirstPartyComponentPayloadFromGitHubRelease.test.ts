import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  fetchGitHubReleaseByTagMock,
  resolveReleaseAssetBundleMock,
  downloadVerifiedReleaseAssetBundleMock,
  extractReleasePayloadRootFromArchiveMock,
} = vi.hoisted(() => ({
  fetchGitHubReleaseByTagMock: vi.fn(),
  resolveReleaseAssetBundleMock: vi.fn(),
  downloadVerifiedReleaseAssetBundleMock: vi.fn(),
  extractReleasePayloadRootFromArchiveMock: vi.fn(),
}));

vi.mock('@happier-dev/release-runtime/github', () => ({
  fetchGitHubReleaseByTag: fetchGitHubReleaseByTagMock,
}));

vi.mock('@happier-dev/release-runtime/assets', () => ({
  resolveReleaseAssetBundle: resolveReleaseAssetBundleMock,
}));

vi.mock('@happier-dev/release-runtime/verifiedDownload', () => ({
  downloadVerifiedReleaseAssetBundle: downloadVerifiedReleaseAssetBundleMock,
}));

vi.mock('./extractReleasePayloadRootFromArchive.js', () => ({
  extractReleasePayloadRootFromArchive: extractReleasePayloadRootFromArchiveMock,
}));

import {
  normalizeReleaseAssetArch,
  prepareFirstPartyComponentPayloadFromGitHubRelease,
} from './prepareFirstPartyComponentPayloadFromGitHubRelease';

describe('normalizeReleaseAssetArch', () => {
  it.each([
    ['aarch64', 'arm64'],
    ['arm64', 'arm64'],
    ['amd64', 'x64'],
    ['x86_64', 'x64'],
  ] as const)('normalizes %s to %s', (input, expected) => {
    expect(normalizeReleaseAssetArch(input)).toBe(expected);
  });

  it('rejects unsupported architectures', () => {
    expect(() => normalizeReleaseAssetArch('sparc')).toThrow(/unsupported/i);
  });
});

describe('prepareFirstPartyComponentPayloadFromGitHubRelease', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('does not suggest a GitHub token when the release exists but its assets are incomplete', async () => {
    fetchGitHubReleaseByTagMock.mockResolvedValue({ assets: [] });
    resolveReleaseAssetBundleMock.mockImplementation(() => {
      throw new Error('missing release asset: happier-v0.2.12-preview.1-darwin-arm64.tar.gz');
    });

    const error = await prepareFirstPartyComponentPayloadFromGitHubRelease({
      componentId: 'happier-cli',
      channel: 'preview',
      os: 'darwin',
      arch: 'arm64',
      artifactSource: {
        kind: 'github-release',
        githubRepo: 'happier-dev/happier',
        githubToken: '',
      },
    }).then(
      () => null,
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('missing release asset');
    expect((error as Error).message).not.toContain('No GitHub token was configured');
  });

  it('still suggests a GitHub token when release lookup itself returns 404', async () => {
    const notFound = new Error('Not Found');
    Reflect.set(notFound, 'status', 404);
    fetchGitHubReleaseByTagMock.mockRejectedValue(notFound);

    const error = await prepareFirstPartyComponentPayloadFromGitHubRelease({
      componentId: 'happier-cli',
      channel: 'preview',
      os: 'darwin',
      arch: 'arm64',
      artifactSource: {
        kind: 'github-release',
        githubRepo: 'acme/private-happier',
        githubToken: '',
      },
    }).then(
      () => null,
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('No GitHub token was configured');
  });
});
