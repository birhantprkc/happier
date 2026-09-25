import * as React from 'react';

import { getInstallablesRegistryEntries } from '@/capabilities/installablesRegistry';
import { buildAgentCliCapabilityId } from '@/capabilities/agentCliCapabilityId';
import { machineCapabilitiesInvoke } from '@/sync/ops';
import type { AgentId } from '@/agents/catalog/catalog';
import { t } from '@/text';

import type { UnseenUpdateCompletions } from './items/buildUpdatesSummary';
import type { UpdateItem, UpdateItemStep } from './items/updateItem';
import type { UpdateRunObservation } from './items/buildMachineUpdateItems';

/**
 * The one record of machine-side update runs started from this app (agent CLIs, helper
 * installables, another machine's Happier CLI). Each run is the executor's own call — a machine
 * capability invoke or the daemon's `cli.update.v1` system task — and the row reads its lifecycle
 * from here: in flight, failed with one sentence, or (a remote CLI) accepted and waiting for the
 * machine to report the result it persisted. Success is never taken from the call itself: the row
 * re-reads the machine's facts afterwards.
 *
 * Module-level on purpose: the popover and the screen are two views of the same runs.
 */
type RunRecord =
    | Readonly<{ status: 'running' }>
    | Readonly<{ status: 'failed'; message: string; logPath?: string | null }>
    /** A remote CLI update the daemon accepted; `baseline` is its last-update fact at that moment. */
    | Readonly<{ status: 'accepted'; baseline: string }>
    | Readonly<{ status: 'finished' }>;

let records: ReadonlyMap<string, RunRecord> = new Map();
const listeners = new Set<() => void>();

function setRecord(itemId: string, record: RunRecord): void {
    const next = new Map(records);
    next.set(itemId, record);
    records = next;
    for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

function readRecords(): ReadonlyMap<string, RunRecord> {
    return records;
}

export function useMachineUpdateRuns(): ReadonlyMap<string, RunRecord> {
    return React.useSyncExternalStore(subscribe, readRecords, readRecords);
}

/**
 * Completions the person has not seen yet: the pill says "Updated" until Updates is opened once
 * (the seen model, no dwell timer). In memory only — a restart is itself the confirmation.
 */
let completions: UnseenUpdateCompletions = new Map();
const completionListeners = new Set<() => void>();

function setCompletions(next: UnseenUpdateCompletions): void {
    completions = next;
    for (const listener of completionListeners) listener();
}

export function recordUpdateCompleted(itemId: string, kind: 'done' | 'pendingRemote' = 'done'): void {
    if (completions.get(itemId) === kind) return;
    const next = new Map(completions);
    next.set(itemId, kind);
    setCompletions(next);
}

/** Opening Updates shows every result, so nothing is unseen afterwards. */
export function markUpdateCompletionsSeen(): void {
    if (completions.size === 0) return;
    setCompletions(new Map());
}

function subscribeCompletions(listener: () => void): () => void {
    completionListeners.add(listener);
    return () => {
        completionListeners.delete(listener);
    };
}

function readCompletions(): UnseenUpdateCompletions {
    return completions;
}

export function useUnseenUpdateCompletions(): UnseenUpdateCompletions {
    return React.useSyncExternalStore(subscribeCompletions, readCompletions, readCompletions);
}

const IDLE: UpdateRunObservation = { running: false, step: null, errorMessage: null };

/**
 * What a row's executor currently says. `lastUpdateSignature` is the remote CLI's current
 * last-update fact, so an accepted run stays "running" only until the machine reports anything new.
 */
export function observeMachineUpdateRun(
    runs: ReadonlyMap<string, RunRecord>,
    itemId: string,
    options: Readonly<{ step?: UpdateItemStep; lastUpdateSignature?: string }> = {},
): UpdateRunObservation {
    const record = runs.get(itemId);
    if (!record || record.status === 'finished') return IDLE;
    if (record.status === 'running') return { running: true, step: options.step ?? 'installing', errorMessage: null };
    if (record.status === 'failed') return { running: false, step: null, errorMessage: record.message, logPath: record.logPath ?? null };
    return record.baseline === (options.lastUpdateSignature ?? '')
        ? { running: true, step: 'reconnecting', errorMessage: null }
        : IDLE;
}

export function signatureOfLastUpdate(lastUpdate: unknown): string {
    return lastUpdate == null ? '' : JSON.stringify(lastUpdate);
}

function describeRemoteFailure(code: string | undefined): string {
    if (code === 'cli_not_managed') return t('machine.thisComputer.cliNotManaged');
    if (code === 'cli_remote_update_unsupported') return t('updates.row.remoteUnsupported');
    return t('updates.row.failedGeneric');
}

/** K6 failure codes → one sentence; never the raw message or log path. */
function describeInstallFailure(code: string | undefined): string {
    if (code === 'update-not-verified') return t('updates.row.updateNotVerified');
    if (code === 'update-not-available') return t('updates.row.updateItYourWay');
    return t('updates.row.failedGeneric');
}

/** Five minutes: the existing installer invoke budget (`InstallableDepInstaller`). */
const INSTALL_INVOKE_TIMEOUT_MS = 5 * 60_000;

/**
 * Runs one machine row's update through its canonical executor. `refresh` re-reads that machine's
 * facts afterwards (success is re-read).
 */
export async function runMachineItemUpdate(
    item: UpdateItem,
    context: Readonly<{ lastUpdateSignature?: string; refresh: () => void }>,
): Promise<void> {
    const machineId = item.machineId;
    if (!machineId || item.action.kind !== 'run') return;
    if (records.get(item.id)?.status === 'running') return;
    setRecord(item.id, { status: 'running' });

    const subject = item.subject;
    try {
        if (subject.kind === 'happier-cli') {
            const result = await machineCapabilitiesInvoke(machineId, {
                id: 'tool.systemTasks',
                method: 'start',
                params: { spec: { protocolVersion: 1, kind: 'cli.update.v1', params: {} } },
            });
            if (!result.supported) {
                setRecord(item.id, { status: 'failed', message: describeRemoteFailure(undefined) });
                return;
            }
            if (!result.response.ok) {
                setRecord(item.id, { status: 'failed', message: describeRemoteFailure(result.response.error.code) });
                return;
            }
            setRecord(item.id, { status: 'accepted', baseline: context.lastUpdateSignature ?? '' });
            recordUpdateCompleted(item.id, 'pendingRemote');
            return;
        }

        const request = subject.kind === 'agent-cli'
            // K6 — the catalog install owner, asked for an update of what it installed.
            // A vendor updater (`native`) runs only after the person confirmed it (the caller asks).
            ? {
                id: buildAgentCliCapabilityId(subject.agentId as AgentId),
                method: 'install',
                params: item.vendorUpdater ? { intent: 'update', allowVendorRecipeExecution: true } : { intent: 'update' },
            }
            : subject.kind === 'installable'
                ? (() => {
                    const entry = getInstallablesRegistryEntries().find((candidate) => candidate.key === subject.key);
                    return entry ? { id: entry.capabilityId, method: 'upgrade' } : null;
                })()
                : null;
        if (!request) {
            setRecord(item.id, { status: 'failed', message: t('updates.row.failedGeneric') });
            return;
        }
        const result = await machineCapabilitiesInvoke(machineId, request, { timeoutMs: INSTALL_INVOKE_TIMEOUT_MS });
        if (!result.supported) {
            setRecord(item.id, {
                status: 'failed',
                message: result.reason === 'not-supported' ? t('deps.installNotSupported') : t('updates.row.failedGeneric'),
            });
            return;
        }
        if (!result.response.ok) {
            setRecord(item.id, {
                status: 'failed',
                message: describeInstallFailure(result.response.error.code),
                logPath: typeof result.response.logPath === 'string' ? result.response.logPath : null,
            });
            return;
        }
        setRecord(item.id, { status: 'finished' });
        recordUpdateCompleted(item.id);
    } catch {
        setRecord(item.id, { status: 'failed', message: t('updates.row.failedGeneric') });
    } finally {
        context.refresh();
    }
}
