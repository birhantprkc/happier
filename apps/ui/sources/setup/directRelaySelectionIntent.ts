import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

/**
 * R8/INV7 — the one record of "the user just chose this Relay/Home themselves".
 *
 * Reconciliation must originate from the direct action, not be inferred afterwards from state.
 * The durable selection target cannot carry that meaning: it names the user's *default* relay, so
 * any navigation-, notification-, deep-link-, voice- or focus-driven change that happens to land
 * back on that default looks identical to the user picking it, and repointing the daemon there is
 * a mutation nobody asked for. The direct action records the intent; the authenticated setup gate
 * consumes it exactly once.
 *
 * It is one in-memory slot, valid only within this app run. Nothing establishes a requirement for
 * a relay choice to survive a restart — a choice the user made before quitting is carried by the
 * durable preference, which the gate still reads for *what* relay the app is on, never for *who*
 * moved it — so nothing here is persisted, and there is no expiry, generation or workflow to
 * maintain. A run that ends with an unconsumed intent simply forgets it.
 */
let pendingDirectRelaySelection: string | null = null;

/**
 * Counts the choices a person has made in this app run, so the gate can notice one it has not
 * acted on yet.
 *
 * The gate reacts to the app's identity changing. A direct pick of the relay the app is ALREADY on
 * changes nothing about that identity — which is exactly the case that matters after an ambient
 * switch moved the app there and the gate refused to repoint the daemon for it. Counting the
 * choices gives that answer a value the gate can subscribe to. Only recording moves it; spending
 * the intent does not, so the gate never reads its own consumption as another answer.
 */
let directRelaySelectionGeneration = 0;
const directRelaySelectionListeners = new Set<() => void>();

export function subscribeDirectRelaySelectionIntent(listener: () => void): () => void {
    directRelaySelectionListeners.add(listener);
    return () => {
        directRelaySelectionListeners.delete(listener);
    };
}

export function readDirectRelaySelectionIntentGeneration(): number {
    return directRelaySelectionGeneration;
}

function normalize(serverIdRaw: string | null | undefined): string | null {
    const serverId = String(serverIdRaw ?? '').trim();
    return serverId.length > 0 ? serverId : null;
}

/**
 * Called by the direct Relay/Home action **before** it switches the connection, so the intent is
 * already armed when the gate re-renders against the new identity. Only the latest choice is kept:
 * a user who picks again has replaced the question, not queued a second one.
 */
export function recordDirectRelaySelectionIntent(serverId: string): void {
    pendingDirectRelaySelection = normalize(serverId);
    directRelaySelectionGeneration += 1;
    for (const listener of Array.from(directRelaySelectionListeners)) {
        listener();
    }
}

/**
 * Whether the user directly chose this relay in this app run. Answering `true` spends the intent,
 * so a later ambient return to the same relay cannot replay the mutation. A choice for a different
 * relay is left armed — it has not been acted on yet.
 */
export function consumeDirectRelaySelectionIntent(serverId: string): boolean {
    const requested = normalize(serverId);
    if (pendingDirectRelaySelection === null || requested === null) {
        return false;
    }
    if (!areServerProfileIdentifiersEquivalent(pendingDirectRelaySelection, requested)) {
        return false;
    }
    pendingDirectRelaySelection = null;
    return true;
}
