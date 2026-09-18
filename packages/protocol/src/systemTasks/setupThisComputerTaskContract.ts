/**
 * Wire contract for the desktop `setup.thisComputer.v1` system task's prompts.
 *
 * Both sides of this seam live in different packages: the producer is the bundled `hsetup`
 * executor (`apps/bootstrap/src/systemTasks/kinds/setupThisComputer.ts`) and the readers are the
 * desktop app's automatic approval helper and setup task hook (`apps/ui/sources/auth/terminal/`,
 * `apps/ui/sources/components/systemTasks/`). Before this module each side hand-maintained its own
 * copy of the payload shape and they had already drifted apart, so no prompt the executor emitted
 * could be recognised by the app. One builder and one parser per prompt keep them in lockstep: a
 * field added on one side does not compile on the other.
 *
 * Scope: shapes only. No task catalog, no execution policy, no approval decision — the refusal
 * rules stay with the approval owner in the app, and the prompts stay owned by the executor. The
 * envelope (`protocolVersion`, task id, redaction) is `./spec.ts`'s and is unchanged.
 */

import type { SystemTaskJsonObject } from './spec.js';

export const SETUP_THIS_COMPUTER_SYSTEM_TASK_KIND = 'setup.thisComputer.v1' as const;

/** Prompt kind for the daemon's pairing request, answered automatically by the app (plan R4). */
export const SETUP_PAIRING_PROMPT_KIND = 'setup.pairThisComputer' as const;

/** Prompt kind for the service-ownership decision the executor obtains before mutating (UD5). */
export const SETUP_SERVICE_CONSENT_PROMPT_KIND = 'setup.serviceConsent' as const;

/**
 * Where the CLI the executor is driving came from: this machine's desktop-managed install layout
 * (`managed`) or an explicit env/repo override (`override`).
 *
 * This is an install-ownership record, not verified publisher provenance. `managed` is derived
 * from a plain text marker under the user's own home, so it states that the desktop app's install
 * path put the binary there — never that the binary was cryptographically proven to be official
 * Happier. The approval owner uses it to choose between approving silently and asking the person
 * at the keyboard once; it is not a signature check.
 */
export type SetupCliProvenance = 'managed' | 'override';

/**
 * The CLI's pairing requirement, classified here so both sides read one vocabulary.
 * `unsupported` covers every value this contract does not know, so an unknown requirement is
 * refused by name instead of silently treated as compatible.
 */
export type SetupPairingRequirement = 'compatible' | 'v3' | 'unsupported';

/**
 * Public pairing material. Nothing secret is ever present: the pairing secret is redacted by the
 * runner by design, and V2 approval needs none of it.
 */
export type SetupPairingPromptPayload = Readonly<{
  publicKeyB64Url: string;
  /** The relay the executor was asked to configure, minus any userinfo credentials. */
  relayUrl: string;
  /** The relay the CLI is actually configured for, as the CLI's own comparable key. */
  serverIdentityKey: string;
  /**
   * The account this setup run is pairing the computer to — the executor's required
   * `expectedAccountId` param. An approval that is not bound to an account would seal the account
   * content key for whatever pairing happened to be pending, so a prompt that does not state it
   * reaches the reader as `null` and the approval owner refuses it by name (INV2).
   */
  accountId: string | null;
  pairingRequirement: SetupPairingRequirement;
  cliProvenance: SetupCliProvenance | null;
  /**
   * The command the executor actually resolved and is driving. Shown verbatim to the person asked
   * to vouch for a CLI the desktop install path did not place, so the decision is about the
   * program that is really asking. A local filesystem path, never a credential; `null` when the
   * executor named none.
   */
  cliCommand: string | null;
}>;

/** What `happier service install --dry-run --json` reported and needs a decision on (INV9). */
export type SetupServiceConsentPromptPayload = Readonly<{
  /** The CLI's takeover notice, or `null` when no takeover is involved. */
  takeover: string | null;
  /** The CLI's conflict message, or `null` when it gave none. */
  message: string | null;
  competingServices: readonly string[];
  servicesToRemove: readonly string[];
}>;

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value.trim() : '';
}

function readNullableString(record: Record<string, unknown>, key: string): string | null {
  const value = readString(record, key);
  return value ? value : null;
}

function readStringList(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function readPromptRecord(data: unknown, kind: string): Record<string, unknown> | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  return record.kind === kind ? record : null;
}

export function classifySetupPairingRequirement(value: unknown): SetupPairingRequirement {
  if (value === 'compatible' || value === 'v3') return value;
  return 'unsupported';
}

function classifySetupCliProvenance(value: unknown): SetupCliProvenance | null {
  return value === 'managed' || value === 'override' ? value : null;
}

/**
 * A relay URL with any `user:pass@` userinfo removed.
 *
 * The prompt becomes a task event, and the runner's redaction matches sensitive *key names*
 * (`/secret|token|password|statefile/i`) — `relayUrl` is not one of them, so a credential-bearing
 * relay would reach event snapshots and logs verbatim. Stripping happens here, at the one builder
 * every producer of this prompt goes through, so no call site can forget it. Identity is
 * unaffected: `createServerUrlComparableKey` ignores userinfo, so producer and approver still
 * compare the same relay.
 */
function stripRelayUrlCredentials(rawRelayUrl: string): string {
  const value = String(rawRelayUrl ?? '').trim();
  try {
    const parsed = new URL(value);
    if (!parsed.username && !parsed.password) {
      return value;
    }
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    // Unparseable here means unverifiable, so drop the whole userinfo segment rather than emit it.
    return value.replace(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/?#]*@/, '$1');
  }
}

/**
 * Builds the complete prompt event data, discriminator included. The runner merges the prompt
 * request's own `kind` over this object, so passing `SETUP_PAIRING_PROMPT_KIND` as the request kind
 * writes the same value twice rather than two different ones.
 */
export function createSetupPairingPromptData(payload: Readonly<{
  publicKeyB64Url: string;
  relayUrl: string;
  serverIdentityKey: string;
  /** The account the executor was told to set this computer up for. */
  accountId: string;
  /** The CLI's raw requirement string; classified here so the wire carries a known token. */
  pairingRequirement: string;
  cliProvenance: SetupCliProvenance;
  /** The resolved command the executor is driving. */
  cliCommand: string;
}>): SystemTaskJsonObject {
  return {
    kind: SETUP_PAIRING_PROMPT_KIND,
    publicKeyB64Url: payload.publicKeyB64Url,
    relayUrl: stripRelayUrlCredentials(payload.relayUrl),
    serverIdentityKey: payload.serverIdentityKey,
    accountId: payload.accountId,
    pairingRequirement: classifySetupPairingRequirement(payload.pairingRequirement),
    cliProvenance: payload.cliProvenance,
    cliCommand: payload.cliCommand,
  };
}

/**
 * Recognises the pairing prompt. Anything that is not this prompt kind carrying all three
 * identifying strings is `null` — a caller must not guess at partial data.
 */
export function parseSetupPairingPromptData(data: unknown): SetupPairingPromptPayload | null {
  const record = readPromptRecord(data, SETUP_PAIRING_PROMPT_KIND);
  if (!record) return null;

  const publicKeyB64Url = readString(record, 'publicKeyB64Url');
  const relayUrl = readString(record, 'relayUrl');
  const serverIdentityKey = readString(record, 'serverIdentityKey');
  if (!publicKeyB64Url || !relayUrl || !serverIdentityKey) return null;

  return {
    publicKeyB64Url,
    relayUrl,
    serverIdentityKey,
    accountId: readNullableString(record, 'accountId'),
    pairingRequirement: classifySetupPairingRequirement(record.pairingRequirement),
    cliProvenance: classifySetupCliProvenance(record.cliProvenance),
    cliCommand: readNullableString(record, 'cliCommand'),
  };
}

/** Builds the complete consent prompt event data, discriminator included. */
export function createSetupServiceConsentPromptData(
  payload: SetupServiceConsentPromptPayload,
): SystemTaskJsonObject {
  return {
    kind: SETUP_SERVICE_CONSENT_PROMPT_KIND,
    takeover: payload.takeover,
    message: payload.message,
    competingServices: [...payload.competingServices],
    servicesToRemove: [...payload.servicesToRemove],
  };
}

/** Recognises the service-consent prompt. Lists and messages may legitimately be empty. */
export function parseSetupServiceConsentPromptData(
  data: unknown,
): SetupServiceConsentPromptPayload | null {
  const record = readPromptRecord(data, SETUP_SERVICE_CONSENT_PROMPT_KIND);
  if (!record) return null;

  return {
    takeover: readNullableString(record, 'takeover'),
    message: readNullableString(record, 'message'),
    competingServices: readStringList(record.competingServices),
    servicesToRemove: readStringList(record.servicesToRemove),
  };
}
