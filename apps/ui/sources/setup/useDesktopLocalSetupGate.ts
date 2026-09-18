import * as React from 'react';

import { useAuth } from '@/auth/context/AuthContext';
import { useThisComputerSetupTask } from '@/components/systemTasks/useThisComputerSetupTask';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { getActiveServerSnapshot, subscribeActiveServer } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storage';

import {
    deriveDesktopLocalSetupSnapshot,
    desktopLocalRuntimeConverged,
    type DesktopLocalInspection,
    type DesktopLocalSetupSnapshot,
    type DesktopSetupExpectation,
} from './deriveDesktopLocalSetupSnapshot';
import { desktopSetupCoordinator, type DesktopSetupVerificationFailure } from './desktopSetupCoordinator';
import { startBackgroundService } from './desktopBackgroundServiceControl';
import {
    consumeDirectRelaySelectionIntent,
    readDirectRelaySelectionIntentGeneration,
    subscribeDirectRelaySelectionIntent,
} from './directRelaySelectionIntent';
import { appOwnedServiceContradictsTarget } from './relayReconciliationConsent';
import { presentRelayReconciliationConsent } from './presentRelayReconciliationConsent';
import { presentUnmanagedCliConsent } from './presentUnmanagedCliConsent';
import { presentSetupServiceConsent } from './presentSetupServiceConsent';

/**
 * Where the readiness proof stands for the current attempt. The proof itself is the coordinator's
 * one `verifyCurrentTarget()` operation (INV8 + INV10); this only records what it answered.
 * `blocked` always carries a name, so a proof can never leave the surface working forever.
 */
export type DesktopSetupVerification =
    | Readonly<{ status: 'idle' }>
    | Readonly<{ status: 'verifying' }>
    | Readonly<{ status: 'blocked'; code: DesktopSetupVerificationFailure }>
    | Readonly<{ status: 'verified' }>;

export type DesktopLocalSetupGate = Readonly<{
    snapshot: DesktopLocalSetupSnapshot;
    inspection: DesktopLocalInspection;
    verification: DesktopSetupVerification;
    setupTask: ReturnType<typeof useThisComputerSetupTask>;
    /** Re-runs a failed inspection, or a failed setup, visibly. */
    retry: () => void;
}>;

function subscribeAccountScope(listener: () => void): () => void {
    const unsubscribeStore = storage.subscribe(listener);
    const unsubscribeServer = subscribeActiveServer(() => listener());
    return () => {
        unsubscribeStore();
        unsubscribeServer();
    };
}

function readExpectationKey(): string {
    const server = getActiveServerSnapshot();
    const accountId = getActiveServerAccountScope()?.accountId ?? '';
    return `${server.serverId}\x00${server.serverUrl}\x00${server.activeLocalRelayUrl ?? ''}\x00${accountId}`;
}

/**
 * What the app is on right now. It is only ever a description of the current identity: nothing
 * here says who moved the app there, because no persisted fact can (R8/INV7) — the durable
 * selection target names the user's default relay, so an ambient change that lands back on it is
 * indistinguishable from the user picking it. That question is answered by
 * `consumeDirectRelaySelectionIntent`, recorded by the direct Relay/Home action itself.
 */
type DesktopSetupGateExpectation = DesktopSetupExpectation & Readonly<{ serverId: string }>;

function useDesktopSetupExpectation(): DesktopSetupGateExpectation {
    const key = React.useSyncExternalStore(subscribeAccountScope, readExpectationKey, readExpectationKey);
    return React.useMemo(() => {
        const [serverId = '', relayUrl = '', localRelayUrl = '', accountId = ''] = key.split('\x00');
        return {
            serverId,
            relayUrl,
            localRelayUrl: localRelayUrl || null,
            accountId: accountId || null,
        };
    }, [key]);
}

const PENDING_INSPECTION: DesktopLocalInspection = { status: 'pending' };

/**
 * Drives the desktop entry decision for the authenticated root (R2/R14). Reads the one ambient
 * inspection, derives the pure snapshot against the app's current relay/account, starts the
 * executor automatically when facts prove this computer is not ready (UD2), and reveals only once
 * re-read facts converge (INV8) **and** the machine answers one read-only RPC (INV10).
 */
export function useDesktopLocalSetupGate(options: Readonly<{ enabled: boolean }>): DesktopLocalSetupGate {
    const auth = useAuth();
    const expectation = useDesktopSetupExpectation();
    // The one observation, read where every other consumer reads it (F6). The gate used to keep a
    // private copy taken from the promise, so a fresh read by the settings toggle or the drift
    // banner never reached it — and its own post-setup re-read never reached them.
    const settledInspection = React.useSyncExternalStore(
        desktopSetupCoordinator.subscribe,
        desktopSetupCoordinator.readInspectionSnapshot,
        desktopSetupCoordinator.readInspectionSnapshot,
    );
    const inspectionRefreshing = React.useSyncExternalStore(
        desktopSetupCoordinator.subscribe,
        desktopSetupCoordinator.readInspectionRefreshing,
        desktopSetupCoordinator.readInspectionRefreshing,
    );
    // The coordinator keeps the last established facts while it reads again, because a surface
    // already showing true facts must not flash an empty state (`apps/ui/AGENTS.md`). This gate is
    // the one reader for which being mid-check IS the thing to show: Retry has to be acknowledged
    // on the next frame, and nothing here may act on facts a re-read is about to replace.
    const inspection = inspectionRefreshing ? PENDING_INSPECTION : settledInspection;
    // R8/INV7 — how many times the person has directly picked a Relay/Home in this app run. A pick
    // of the relay the app is already on changes no identity, so without this the gate would never
    // re-run its trigger and the deliberate choice would do nothing (B1).
    const intentGeneration = React.useSyncExternalStore(
        subscribeDirectRelaySelectionIntent,
        readDirectRelaySelectionIntentGeneration,
        readDirectRelaySelectionIntentGeneration,
    );
    const [inspectionAttempt, setInspectionAttempt] = React.useState(0);
    const [verification, setVerification] = React.useState<DesktopSetupVerification>({ status: 'idle' });
    const [declinedAttempt, setDeclinedAttempt] = React.useState<string | null>(null);
    /** The attempt whose on-demand quiet start has already had its turn (H6). */
    const [quietStartAttempted, setQuietStartAttempted] = React.useState<string | null>(null);
    const setupAttemptRef = React.useRef<string | null>(null);
    const proofAttemptRef = React.useRef<string | null>(null);
    /** The facts the last settled proof was about, so a newer read can retire its verdict (F1). */
    const provedInspectionRef = React.useRef<DesktopLocalInspection | null>(null);
    const quietStartRef = React.useRef<string | null>(null);
    // UD4 — monotonic for this app run: `authenticatedThisRun` is set once at sign-in and never
    // cleared, so it cannot say whether the user has seen the app yet. The opaque ground belongs
    // to a first run only; every later blocking maintenance keeps the user's context under the
    // veil. The gate owns the shell it renders, so this survives navigation within the app.
    const hasPresentedShellRef = React.useRef(false);
    const attemptKey = `${inspectionAttempt}:${expectation.serverId}:${expectation.accountId ?? ''}`;
    // One attempt of the gate's own work, plus the choices the person has made since. The proof is
    // keyed by identity alone — reaching this machine does not become a different question because
    // the user pressed a relay they were already on — but what the gate may DO is re-asked, so a
    // refusal cannot swallow the answer that follows it (B1).
    const triggerKey = `${attemptKey}:${intentGeneration}`;

    // Whoever mounts first starts the one read of this app open; the pre-auth warm-up usually has
    // already. `inspectionAttempt` is in the deps because Retry asks again — a failed read is the
    // only one the coordinator will actually redo.
    React.useEffect(() => {
        if (!options.enabled) {
            return;
        }
        void desktopSetupCoordinator.inspect();
    }, [inspectionAttempt, options.enabled]);

    // Read by callbacks that fire long after the render that created them — a consent answer, a
    // proof settling — so they record the attempt the app is on now rather than the one that was
    // current when the callback was made.
    const triggerKeyRef = React.useRef(triggerKey);
    triggerKeyRef.current = triggerKey;
    const attemptKeyRef = React.useRef(attemptKey);
    attemptKeyRef.current = attemptKey;

    /**
     * The one readiness proof, asked of its one owner. Task success is never readiness (INV8), so
     * `fresh` re-reads the runtime after the executor changed it; the entry path reuses this app
     * open's ambient read. It always settles — verified, or a named blocked state the surface can
     * show with a Retry — so the gate can never sit in an unanswerable working state.
     */
    const runProof = React.useCallback((options: Readonly<{ fresh: boolean }>) => {
        const key = attemptKeyRef.current;
        proofAttemptRef.current = key;
        setVerification({ status: 'verifying' });
        void desktopSetupCoordinator
            .verifyCurrentTarget(options.fresh ? { fresh: true } : undefined)
            .then((outcome) => {
                if (proofAttemptRef.current !== key) {
                    return;
                }
                provedInspectionRef.current = outcome.inspection;
                setVerification(outcome.status === 'verified'
                    ? { status: 'verified' }
                    : { status: 'blocked', code: outcome.code });
            });
    }, []);

    // The approval target is the identity this run is for, nothing more. It is wired whenever the
    // relay and account are known, independent of the ambient inspection: the executor's own
    // prompt describes the CLI asking, and gating the target on an observation that had to resolve
    // first left a failed inspection unable to answer its own pairing request.
    const setupTask = useThisComputerSetupTask({
        ...(expectation.relayUrl && expectation.accountId
            ? {
                authRequestApproval: {
                    expectedRelayUrl: expectation.relayUrl,
                    expectedAccountId: expectation.accountId,
                    serverId: expectation.serverId,
                },
            }
            : {}),
        // Keeping the existing service is a decision, not a failure — the same shape as declining
        // the relay move. Nothing is ready and nothing claims to be, but the shell comes back so
        // the user is not held on a blocking surface by a Retry that reopens the question they
        // just answered. The drift and settings repair entries carry it until they return.
        onServiceConsentRequired: async (prompt) => {
            const approved = await presentSetupServiceConsent(prompt);
            if (!approved) {
                setDeclinedAttempt(triggerKeyRef.current);
            }
            return approved;
        },
        // Declining is a decision, not a failure: the run stops and the shell comes back with
        // setup deferred, exactly as declining the relay move does. Retrying identically forever
        // was the old behaviour and it never had a second outcome.
        onUnmanagedCliConsentRequired: async (decision) => {
            const approved = await presentUnmanagedCliConsent(decision);
            if (!approved) {
                setDeclinedAttempt(triggerKeyRef.current);
            }
            return approved;
        },
        // Task success is never readiness (INV8): a service command can succeed while the running
        // daemon carries the wrong identity, ownership has not converged, or the relay cannot
        // reach the machine at all. The same proof the settings flow uses decides it here.
        onSucceeded: () => runProof({ fresh: true }),
    });

    // The entry path: this app open's ambient facts already describe a converged runtime, so the
    // only thing left to prove is that the relay can reach it. Nothing re-reads here — an
    // already-ready computer reveals without a second inspection (D3/C3).
    React.useEffect(() => {
        if (!options.enabled || proofAttemptRef.current === attemptKey) {
            return;
        }
        if (!desktopLocalRuntimeConverged(inspection, expectation)) {
            return;
        }
        runProof({ fresh: false });
    }, [attemptKey, expectation, inspection, options.enabled, runProof]);

    // A verdict belongs to the facts it answered for. Any other reader can replace those facts —
    // Machines › Refresh, the background-service toggle's install, a settings verify or adopt, a
    // settings Start — and a computer that has since stopped converging then derived `setup` while
    // the trigger below stayed gated on a settled verification: a blocking veil over the whole app
    // with nothing running and no Retry, until the app was restarted. Retiring the stale verdict
    // lets the existing effects do the right thing — re-prove it if it still converges, run setup
    // or reconciliation if it does not. Only a SETTLED verdict is retired: a proof in flight owns
    // its own window and must be allowed to answer.
    React.useEffect(() => {
        if (verification.status !== 'verified' && verification.status !== 'blocked') {
            return;
        }
        if (provedInspectionRef.current === settledInspection) {
            return;
        }
        proofAttemptRef.current = null;
        setupAttemptRef.current = null;
        setVerification({ status: 'idle' });
    }, [settledInspection, verification.status]);

    const expectationIdentity = `${expectation.serverId}:${expectation.accountId ?? ''}`;
    const provedIdentityRef = React.useRef(expectationIdentity);
    React.useEffect(() => {
        if (provedIdentityRef.current === expectationIdentity) {
            return;
        }
        provedIdentityRef.current = expectationIdentity;
        // The finished attempt proved a relay and account the app has since left; reaching that
        // machine says nothing about the new one. Releasing it is what lets the next direct
        // Relay/Home selection reconcile (R8) instead of parking the gate on a stale proof. The
        // proof key goes with it, so returning to a previously proven identity re-proves it
        // rather than sitting on a reachability answer from before the app moved away.
        proofAttemptRef.current = null;
        setVerification({ status: 'idle' });
    }, [expectationIdentity]);

    const reachability = verification.status === 'verified'
        ? 'reachable'
        : verification.status === 'blocked' && verification.code === 'machine_unreachable'
            ? 'unreachable'
            : undefined;
    const snapshot = React.useMemo(
        () => deriveDesktopLocalSetupSnapshot(
            {
                inspection,
                expected: expectation,
                ...(reachability ? { reachability } : {}),
                ...(quietStartAttempted === attemptKey ? { backgroundServiceStartAttempted: true } : {}),
            },
            {
                authenticatedThisRun: auth.authenticatedThisRun,
                hasPresentedShell: hasPresentedShellRef.current,
                userDeclinedThisAttempt: declinedAttempt === triggerKey,
            },
        ),
        [attemptKey, auth.authenticatedThisRun, declinedAttempt, expectation, inspection, quietStartAttempted, reachability, triggerKey],
    );
    React.useEffect(() => {
        if (snapshot.presentation === 'shell') {
            hasPresentedShellRef.current = true;
        }
    }, [snapshot.presentation]);

    // H6 - the app's own on-demand service is installed for this relay and account and is simply
    // not running yet, which is the deal the settings toggle made: it answers while the app is
    // open. The existing service command is enough; the executor has nothing to configure. The
    // surface stays the ordinary shell because this is a check, not maintenance, and the same
    // readiness proof as every other path decides the outcome (INV8/INV10).
    React.useEffect(() => {
        if (!options.enabled || snapshot.reason !== 'service_start_pending' || quietStartRef.current === attemptKey) {
            return;
        }
        quietStartRef.current = attemptKey;
        const key = attemptKey;
        void startBackgroundService().then(
            () => {
                // The proof re-reads first, so the facts are never briefly both stale and settled.
                runProof({ fresh: true });
                setQuietStartAttempted(key);
            },
            () => {
                // The command could not even run. Let the facts settle so the surface carries it
                // and ordinary convergence can take over, rather than checking a service nothing
                // is going to start.
                setQuietStartAttempted(key);
            },
        );
    }, [attemptKey, options.enabled, runProof, snapshot.reason]);

    const setupStart = setupTask.start;
    React.useEffect(() => {
        if (!options.enabled || snapshot.state !== 'setup' || verification.status !== 'idle') {
            return;
        }
        // Nothing below may run twice for one trigger, and the intent is spent inside it, so the
        // de-duplication guard comes first: a run this gate already started or refused must never
        // be able to swallow a fresh direct choice.
        const setupInFlight = setupTask.activeTaskSnapshot != null && setupTask.activeTaskSnapshot.result == null;
        if (setupAttemptRef.current === triggerKey || setupInFlight || setupTask.isStarting) {
            return;
        }
        // The one trigger question: would the executor MOVE a background service that is already
        // this user's, or converge a computer that has none? The app's own expectation answers it
        // within a run - a different relay, or the same relay under a different account - but it
        // cannot answer it across a relaunch, because an ambient device-scope switch is persisted:
        // on the next open the expectation and the current identity agree while the daemon is
        // still elsewhere. The facts answer it in either case, so they decide it (B2/UD5).
        const observed = desktopSetupCoordinator.readObservedExpectation();
        const relayChanged = observed !== null && observed.serverId !== '' && observed.serverId !== expectation.serverId;
        const accountChanged = observed !== null
            && !relayChanged
            && observed.accountId !== null
            && expectation.accountId !== null
            && observed.accountId !== expectation.accountId;
        // R8/INV7 - a relay change may repoint the daemon only when the user performed the direct
        // Relay/Home action themselves. The intent comes from that action and is spent here, so a
        // navigation-, notification-, deep-link-, voice- or focus-driven change mutates nothing,
        // including when it lands back on the relay the durable preference already named. Refusing
        // is the same answer as declining the move: nothing is ready, nothing claims to be, and
        // the shell comes back with the drift banner carrying it instead of a veil over no run.
        if (relayChanged && !consumeDirectRelaySelectionIntent(expectation.serverId)) {
            setupAttemptRef.current = triggerKey;
            setDeclinedAttempt(triggerKey);
            return;
        }
        // The choice the user just made replaces the refusal that came before it.
        setDeclinedAttempt(null);
        const isReconciliation = relayChanged
            || accountChanged
            || appOwnedServiceContradictsTarget({ inspection, target: expectation });
        setupAttemptRef.current = triggerKey;
        if (!isReconciliation) {
            void desktopSetupCoordinator.startSetup({ start: setupStart }).catch(() => {
                // `setupTask.startError` carries the failure; the surface renders it as blocked.
            });
            return;
        }
        void desktopSetupCoordinator
            .reconcile({ start: setupStart, confirm: presentRelayReconciliationConsent })
            .then((outcome) => {
                if (outcome === null) {
                    setDeclinedAttempt(triggerKey);
                }
            })
            .catch(() => {
                // `setupTask.startError` carries the failure; the surface renders it as blocked.
            });
    }, [expectation, inspection, options.enabled, setupStart, setupTask.activeTaskSnapshot, setupTask.isStarting, snapshot.state, triggerKey, verification.status]);

    const retry = React.useCallback(() => {
        setupAttemptRef.current = null;
        proofAttemptRef.current = null;
        quietStartRef.current = null;
        setDeclinedAttempt(null);
        setQuietStartAttempted(null);
        setVerification({ status: 'idle' });
        setInspectionAttempt((value) => value + 1);
    }, []);

    return {
        snapshot,
        inspection,
        verification,
        setupTask,
        retry,
    };
}
