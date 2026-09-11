// @ts-check

import { basename } from 'node:path';

function fail(message) {
  throw new Error(message);
}

function isInstallablePayload(name) {
  return !name.endsWith('.sig')
    && !name.endsWith('.minisig')
    && !name.endsWith('.sha256')
    && !name.endsWith('.json')
    && !name.endsWith('.txt');
}

/**
 * Rolling stable and preview releases retain signed metadata and publish installable
 * payloads only under predictable channel-stable names.
 * Signed manifests, signatures, checksum sidecars, and updater metadata remain canonical
 * under their immutable names because renaming them would make their contents misleading.
 * The caller must upload each alias from sourceName and audit the two byte-for-byte.
 *
 * @param {{
 *   immutableNames: readonly string[];
 *   payloadNames: readonly string[];
 *   version: string;
 *   rollingTag: string;
 * }} params
 */
export function buildRollingAssetPlan({ immutableNames, payloadNames, version, rollingTag }) {
  if (!rollingTag.endsWith('-stable') && !rollingTag.endsWith('-preview')) {
    return immutableNames.map((name) => ({ name, sourceName: name }));
  }

  const payloadNameSet = new Set(payloadNames);
  const plan = immutableNames
    .filter((name) => !payloadNameSet.has(name) || !isInstallablePayload(name))
    .map((name) => ({ name, sourceName: name }));

  const versionToken = `-v${version}`;
  const occupied = new Set(plan.map(({ name }) => name));
  for (const sourceName of payloadNames) {
    if (!isInstallablePayload(sourceName)) continue;
    let name = sourceName;
    if (rollingTag === 'ui-mobile-stable' && sourceName === `happier-production-android-v${version}.apk`) {
      name = 'happier-android.apk';
    } else {
      const first = sourceName.indexOf(versionToken);
      if (first >= 0) {
        if (sourceName.indexOf(versionToken, first + versionToken.length) >= 0) {
          fail(`Immutable asset contains the version token more than once: ${sourceName}`);
        }
        name = `${sourceName.slice(0, first)}${sourceName.slice(first + versionToken.length)}`;
      }
    }
    if (!name || basename(name) !== name || name === '.' || name === '..') {
      fail(`Unable to derive a safe stable asset name from ${sourceName}.`);
    }
    if (occupied.has(name)) {
      fail(`Stable asset name collides with another release asset: ${name}`);
    }
    occupied.add(name);
    plan.push({ name, sourceName });
  }
  return plan.sort((left, right) => left.name.localeCompare(right.name));
}
