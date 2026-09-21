export type DeferredTranscriptUpdateType = 'new-message' | 'message-updated';

export type DeferredTranscriptMarker = Readonly<{
    updateType: DeferredTranscriptUpdateType;
    seq: number | null;
    messageId?: string;
}>;

export type DeferredTranscriptGap = Readonly<{
    afterSeq: number;
    throughSeq: number;
}>;

export type DeferredTranscriptState = Readonly<{
    knownRemoteSeqBySessionId: Readonly<Record<string, number>>;
    deferredDurableSeqBySessionId: Readonly<Record<string, number>>;
    staleMessageIdsBySessionId: Readonly<Record<string, readonly string[]>>;
    staleMessageSeqsBySessionId: Readonly<Record<string, Readonly<Record<string, number>>>>;
    staleMarkerVersionBySessionId: Readonly<Record<string, number>>;
    // Retain the lower bound for snapshots and the exact hints for bounded sparse repair.
    staleMinSeqBySessionId: Readonly<Record<string, number>>;
    gapsBySessionId: Readonly<Record<string, DeferredTranscriptGap>>;
}>;

export function createDeferredTranscriptState(): DeferredTranscriptState {
    return {
        knownRemoteSeqBySessionId: {},
        deferredDurableSeqBySessionId: {},
        staleMessageIdsBySessionId: {},
        staleMessageSeqsBySessionId: {},
        staleMarkerVersionBySessionId: {},
        staleMinSeqBySessionId: {},
        gapsBySessionId: {},
    };
}

function normalizeSeq(value: number | null | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, Math.trunc(value))
        : null;
}

export function readTranscriptGap(state: DeferredTranscriptState, sessionId: string): DeferredTranscriptGap | null {
    return state.gapsBySessionId[sessionId] ?? null;
}

export function markTranscriptGap(
    state: DeferredTranscriptState,
    sessionId: string,
    gap: Readonly<{ afterSeq: number; throughSeq: number | null }>,
): DeferredTranscriptState {
    const afterSeq = normalizeSeq(gap.afterSeq);
    const throughSeq = normalizeSeq(gap.throughSeq);
    if (!sessionId || afterSeq === null || throughSeq === null || throughSeq <= afterSeq) return state;
    const current = readTranscriptGap(state, sessionId);
    const next = {
        afterSeq: Math.min(current?.afterSeq ?? afterSeq, afterSeq),
        throughSeq: Math.max(current?.throughSeq ?? throughSeq, throughSeq),
    };
    if (current?.afterSeq === next.afterSeq && current.throughSeq === next.throughSeq) return state;
    return { ...state, gapsBySessionId: { ...state.gapsBySessionId, [sessionId]: next } };
}

/**
 * A live row can advance materialized max without covering the interval before it.
 * Only a connected successful page (or a snapshot transferred to the existing tail
 * discontinuity owner) can advance this gap. An exhausted main page also covers the
 * captured session-wide hint: intervening sequence numbers may belong to sidechains.
 */
export function acknowledgeTranscriptGap(
    state: DeferredTranscriptState,
    sessionId: string,
    coverage: Readonly<{
        afterSeq: number;
        expectedGap: DeferredTranscriptGap | null;
        page: Readonly<{ messages: readonly Readonly<{ seq: number }>[]; nextAfterSeq?: number | null }>;
    }>,
): DeferredTranscriptState {
    const current = readTranscriptGap(state, sessionId);
    if (!current || coverage.afterSeq > current.afterSeq) return state;
    const coveredThroughSeq = Math.max(
        coverage.page.messages.reduce((maxSeq, message) => Math.max(maxSeq, normalizeSeq(message.seq) ?? 0), coverage.afterSeq),
        // Do not acknowledge a gap learned while the HTTP request was in flight.
        coverage.page.nextAfterSeq == null ? (coverage.expectedGap?.throughSeq ?? coverage.afterSeq) : coverage.afterSeq,
    );
    if (coveredThroughSeq >= current.throughSeq) {
        const { [sessionId]: _gap, ...gapsBySessionId } = state.gapsBySessionId;
        return { ...state, gapsBySessionId };
    }
    if (coveredThroughSeq <= current.afterSeq) return state;
    return {
        ...state,
        gapsBySessionId: {
            ...state.gapsBySessionId,
            [sessionId]: { ...current, afterSeq: coveredThroughSeq },
        },
    };
}

export function markDeferredTranscriptRemoteSeq(
    state: DeferredTranscriptState,
    sessionId: string,
    seq: number | null | undefined,
): DeferredTranscriptState {
    const normalizedSeq = normalizeSeq(seq);
    if (!sessionId || normalizedSeq === null) return state;
    const prev = state.knownRemoteSeqBySessionId[sessionId] ?? 0;
    if (normalizedSeq <= prev) return state;
    return {
        ...state,
        knownRemoteSeqBySessionId: {
            ...state.knownRemoteSeqBySessionId,
            [sessionId]: normalizedSeq,
        },
    };
}

export function markTranscriptDeferred(
    state: DeferredTranscriptState,
    sessionId: string,
    marker: DeferredTranscriptMarker,
): DeferredTranscriptState {
    const normalizedSeq = normalizeSeq(marker.seq);
    if (!sessionId || normalizedSeq === null) return state;
    const remoteState = markDeferredTranscriptRemoteSeq(state, sessionId, normalizedSeq);
    const prev = remoteState.deferredDurableSeqBySessionId[sessionId] ?? 0;
    if (normalizedSeq <= prev) return remoteState;
    return {
        ...remoteState,
        deferredDurableSeqBySessionId: {
            ...remoteState.deferredDurableSeqBySessionId,
            [sessionId]: normalizedSeq,
        },
    };
}

export function markTranscriptStale(
    state: DeferredTranscriptState,
    sessionId: string,
    marker: DeferredTranscriptMarker,
): DeferredTranscriptState {
    const remoteState = markTranscriptDeferred(state, sessionId, marker);
    if (!sessionId || !marker.messageId) return remoteState;
    const normalizedSeq = normalizeSeq(marker.seq);
    const existingMinSeq = remoteState.staleMinSeqBySessionId[sessionId];
    const nextMinSeq = normalizedSeq === null
        ? existingMinSeq
        : (existingMinSeq === undefined ? normalizedSeq : Math.min(existingMinSeq, normalizedSeq));
    const staleMinSeqBySessionId = nextMinSeq === existingMinSeq
        ? remoteState.staleMinSeqBySessionId
        : { ...remoteState.staleMinSeqBySessionId, ...(nextMinSeq !== undefined ? { [sessionId]: nextMinSeq } : {}) };
    const existingSeqs = remoteState.staleMessageSeqsBySessionId[sessionId] ?? {};
    const staleMessageSeqsBySessionId = normalizedSeq === null || existingSeqs[marker.messageId] === normalizedSeq
        ? remoteState.staleMessageSeqsBySessionId
        : { ...remoteState.staleMessageSeqsBySessionId, [sessionId]: { ...existingSeqs, [marker.messageId]: normalizedSeq } };
    const staleMarkerVersionBySessionId = {
        ...remoteState.staleMarkerVersionBySessionId,
        [sessionId]: (remoteState.staleMarkerVersionBySessionId[sessionId] ?? 0) + 1,
    };
    const existing = remoteState.staleMessageIdsBySessionId[sessionId] ?? [];
    if (existing.includes(marker.messageId)) {
        return { ...remoteState, staleMinSeqBySessionId, staleMessageSeqsBySessionId, staleMarkerVersionBySessionId };
    }
    return {
        ...remoteState,
        staleMessageIdsBySessionId: {
            ...remoteState.staleMessageIdsBySessionId,
            [sessionId]: [...existing, marker.messageId],
        },
        staleMinSeqBySessionId,
        staleMessageSeqsBySessionId,
        staleMarkerVersionBySessionId,
    };
}

export function hasStaleTranscriptMarkers(state: DeferredTranscriptState, sessionId: string): boolean {
    return (state.staleMessageIdsBySessionId[sessionId]?.length ?? 0) > 0;
}

export function readStaleTranscriptMessageIds(
    state: DeferredTranscriptState,
    sessionId: string,
): readonly string[] {
    return state.staleMessageIdsBySessionId[sessionId] ?? [];
}

export function readStaleTranscriptMinSeq(
    state: DeferredTranscriptState,
    sessionId: string,
): number | null {
    return normalizeSeq(state.staleMinSeqBySessionId[sessionId]);
}

export function readStaleTranscriptMessageSeqs(
    state: DeferredTranscriptState,
    sessionId: string,
): Readonly<Record<string, number>> {
    return state.staleMessageSeqsBySessionId[sessionId] ?? {};
}

export function readStaleTranscriptMarkerVersion(state: DeferredTranscriptState, sessionId: string): number {
    return state.staleMarkerVersionBySessionId[sessionId] ?? 0;
}

export function readDeferredTranscriptDurableSeq(state: DeferredTranscriptState, sessionId: string): number | null {
    return normalizeSeq(state.deferredDurableSeqBySessionId[sessionId]);
}

function areStringArraysEqual(a: readonly string[], b: readonly string[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

export function acknowledgeStaleTranscriptRepair(
    state: DeferredTranscriptState,
    sessionId: string,
    expected: Readonly<{ messageIds: readonly string[]; minSeq: number | null; markerVersion?: number }>,
): DeferredTranscriptState {
    const currentMessageIds = state.staleMessageIdsBySessionId[sessionId] ?? [];
    if (currentMessageIds.length === 0) return state;
    if (!areStringArraysEqual(currentMessageIds, expected.messageIds)) return state;
    if (readStaleTranscriptMinSeq(state, sessionId) !== expected.minSeq) return state;
    if (
        expected.markerVersion !== undefined
        && readStaleTranscriptMarkerVersion(state, sessionId) !== expected.markerVersion
    ) return state;

    const { [sessionId]: _stale, ...staleMessageIdsBySessionId } = state.staleMessageIdsBySessionId;
    const { [sessionId]: _staleMinSeq, ...staleMinSeqBySessionId } = state.staleMinSeqBySessionId;
    const { [sessionId]: _staleMessageSeqs, ...staleMessageSeqsBySessionId } = state.staleMessageSeqsBySessionId;
    const { [sessionId]: _staleMarkerVersion, ...staleMarkerVersionBySessionId } = state.staleMarkerVersionBySessionId;
    return {
        ...state,
        staleMessageIdsBySessionId,
        staleMinSeqBySessionId,
        staleMessageSeqsBySessionId,
        staleMarkerVersionBySessionId,
    };
}

export function clearDeferredTranscriptStateForSession(
    state: DeferredTranscriptState,
    sessionId: string,
): DeferredTranscriptState {
    if (
        !(sessionId in state.deferredDurableSeqBySessionId)
        && !(sessionId in state.staleMessageIdsBySessionId)
        && !(sessionId in state.staleMinSeqBySessionId)
        && !(sessionId in state.staleMessageSeqsBySessionId)
        && !(sessionId in state.staleMarkerVersionBySessionId)
        && !(sessionId in state.gapsBySessionId)
    ) {
        return state;
    }
    const { [sessionId]: _deferred, ...deferredDurableSeqBySessionId } = state.deferredDurableSeqBySessionId;
    const { [sessionId]: _stale, ...staleMessageIdsBySessionId } = state.staleMessageIdsBySessionId;
    const { [sessionId]: _staleMinSeq, ...staleMinSeqBySessionId } = state.staleMinSeqBySessionId;
    const { [sessionId]: _staleMessageSeqs, ...staleMessageSeqsBySessionId } = state.staleMessageSeqsBySessionId;
    const { [sessionId]: _staleMarkerVersion, ...staleMarkerVersionBySessionId } = state.staleMarkerVersionBySessionId;
    const { [sessionId]: _gap, ...gapsBySessionId } = state.gapsBySessionId;
    return {
        ...state,
        deferredDurableSeqBySessionId,
        staleMessageIdsBySessionId,
        staleMinSeqBySessionId,
        staleMessageSeqsBySessionId,
        staleMarkerVersionBySessionId,
        gapsBySessionId,
    };
}
