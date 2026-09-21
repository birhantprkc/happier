import { logger } from '@/ui/logger';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';
import {
  OPEN_CODE_BROKER_LOAD_NONCE_ENV,
  OPEN_CODE_BROKER_PROVIDERS,
  OPEN_CODE_BROKER_SELECTIONS_ENV,
  parseOpenCodeBrokerSelections,
} from '@/backends/opencode/brokerPlugin';

import { resolveOpenCodeServerAuthHeadersFromEnv } from './openCodeServerAuth';
import { subscribeSseJson } from './openCodeSse';
import type { OpenCodeGlobalEvent, OpenCodeModelRef, OpenCodeSession } from './types';
import { waitForOpenCodeServerHealth } from './waitForOpenCodeServerHealth';
import {
  ensureSharedManagedOpenCodeServerBaseUrl,
  isLoopbackManagedOpenCodeBaseUrl,
  readSharedManagedOpenCodeServerStateBestEffort,
  type SharedManagedOpenCodeServerState,
} from './sharedManagedServer';
import {
  isSameOpenCodeManagedServerGeneration,
  resolveOpenCodeManagedServerIdentity,
  type OpenCodeManagedServerIdentity,
  type OpenCodeManagedServerIdentityChange,
  type OpenCodeManagedServerIdentityChangeReason,
} from './openCodeManagedServerIdentity';

type PermissionReply = 'once' | 'always' | 'reject';

function requiresOpenCodeBrokerLoadNonce(env: NodeJS.ProcessEnv): boolean {
  const selections = parseOpenCodeBrokerSelections(env[OPEN_CODE_BROKER_SELECTIONS_ENV]);
  return OPEN_CODE_BROKER_PROVIDERS.some((provider) => selections[provider]);
}

function applyManagedOpenCodeBrokerLoadNonce(
  env: NodeJS.ProcessEnv,
  state: SharedManagedOpenCodeServerState | null,
): void {
  const nonce = typeof state?.brokerLoadNonce === 'string' ? state.brokerLoadNonce.trim() : '';
  if (nonce) {
    env[OPEN_CODE_BROKER_LOAD_NONCE_ENV] = nonce;
    return;
  }
  if (requiresOpenCodeBrokerLoadNonce(env)) {
    delete env[OPEN_CODE_BROKER_LOAD_NONCE_ENV];
  }
}

function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  return trimmed;
}

function buildUrl(baseUrl: string, path: string, query?: Record<string, string | undefined>): string {
  const url = new URL(path, `${baseUrl}/`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (typeof v === 'string' && v.length > 0) url.searchParams.set(k, v);
    }
  }
  return url.toString();
}

function redactOpenCodeUrlForError(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (url.searchParams.has('directory')) {
      url.searchParams.set('directory', '<redacted>');
    }
    return url.toString();
  } catch {
    // Best-effort redaction for non-URL strings.
    return String(rawUrl ?? '').replace(/([?&]directory=)[^&#]*/gu, '$1<redacted>');
  }
}

function resolveOpenCodeServerHttpTimeoutMs(env: NodeJS.ProcessEnv): number | null {
  const raw = env.HAPPIER_OPENCODE_SERVER_HTTP_TIMEOUT_MS;
  const defaultTimeoutMs = 60_000;
  if (typeof raw !== 'string') return defaultTimeoutMs;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultTimeoutMs;
  // Fail closed on absurdly low timeouts: these tend to create flakey control-plane polling and
  // false-negative health probes under normal load.
  const clamped = Math.min(120_000, Math.trunc(parsed));
  if (clamped < 1000) return defaultTimeoutMs;
  return clamped;
}

export function resolveOpenCodeSseReadIdleTimeoutMs(env: NodeJS.ProcessEnv): number | null {
  const raw = env.HAPPIER_OPENCODE_SSE_READ_IDLE_TIMEOUT_MS;
  if (typeof raw !== 'string') return null;

  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  if (parsed === 0) return null;
  return Math.max(5_000, Math.min(120_000, Math.trunc(parsed)));
}

async function fetchJson<T>(params: {
  url: string;
  method: 'GET' | 'PATCH' | 'POST';
  headers: Record<string, string>;
  body?: unknown;
  timeoutMs?: number | null;
  signal?: AbortSignal;
}): Promise<T> {
  const timeoutMs = typeof params.timeoutMs === 'number' && Number.isFinite(params.timeoutMs) ? params.timeoutMs : null;
  const ctrl = timeoutMs ? new AbortController() : null;
  let timedOut = false;
  const timer = timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        ctrl?.abort();
      }, timeoutMs)
    : null;
  timer?.unref?.();

  let response: Response;
  try {
    response = await fetch(params.url, {
      method: params.method,
      headers: {
        ...params.headers,
        ...(params.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: params.body !== undefined ? JSON.stringify(params.body) : undefined,
      ...(ctrl || params.signal
        ? { signal: ctrl && params.signal ? AbortSignal.any([ctrl.signal, params.signal]) : (ctrl?.signal ?? params.signal) }
        : {}),
    });
  } catch (error) {
    if (timedOut && timeoutMs) {
      throw new Error(`OpenCode HTTP ${params.method} ${redactOpenCodeUrlForError(params.url)} timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!response.ok) {
    // Provider error bodies can echo prompt content or credentials. Keep request diagnostics to
    // method, redacted URL, and HTTP status; do not deserialize or log the response body.
    void response.body?.cancel().catch(() => {});
    throw new Error(
      `OpenCode HTTP ${params.method} ${redactOpenCodeUrlForError(params.url)} failed: ${response.status} ${response.statusText}`
    );
  }
  if (response.status === 204) return undefined as unknown as T;
  return (await response.json()) as T;
}

type ManagedServerTransportFailureKind =
  | 'fetch_failed'
  | 'connection_refused'
  | 'connection_reset'
  | 'socket_hang_up'
  | 'connect_error'
  | 'terminated'
  | 'network_error'
  | 'peer_closed';

type ManagedServerRetryOperation =
  | 'session_messages_list'
  | 'session_update'
  | 'session_todo'
  | 'session_diff'
  | 'session_status_list'
  | 'permission_list'
  | 'question_list';

function classifyRetryableManagedServerTransportError(error: unknown): ManagedServerTransportFailureKind | null {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const normalized = message.trim().toLowerCase();
  if (!normalized || normalized.startsWith('opencode http ')) return null;
  if (normalized.includes('fetch failed')) return 'fetch_failed';
  if (normalized.includes('econnrefused')) return 'connection_refused';
  if (normalized.includes('econnreset')) return 'connection_reset';
  if (normalized.includes('socket hang up')) return 'socket_hang_up';
  if (normalized.includes('connect_error')) return 'connect_error';
  if (normalized.includes('terminated')) return 'terminated';
  if (normalized.includes('networkerror')) return 'network_error';
  if (normalized.includes('other side closed')) return 'peer_closed';
  return null;
}

function isOpenCodeSseReadIdleTimeoutError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && (error as { code?: unknown }).code === 'OPENCODE_SSE_READ_IDLE_TIMEOUT',
  );
}

export type OpenCodeGlobalEventDelivery = Readonly<{
  /**
   * OpenCode's directory-scoped `/event` route establishes its own connection boundary. For V2
   * sessions owned by this runtime, Happier establishes the equivalent boundary only after the
   * replay-capable session stream opens. Frames after either boundary are accepted live.
   */
  provenance: 'connection-boundary' | 'untrusted-observation' | 'accepted-live';
  connectionGeneration: number;
}>;

export type OpenCodeMcpStatus = Readonly<
  | { status: 'connected' }
  | { status: 'disabled' }
  | { status: 'failed'; error: string }
  | { status: 'needs_auth' }
  | { status: 'needs_client_registration'; error: string }
>;

function readOpenCodeMcpStatus(response: unknown, serverName: string): OpenCodeMcpStatus {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw new Error(`OpenCode MCP registration returned an invalid status map for "${serverName}"`);
  }
  const rawStatus = (response as Record<string, unknown>)[serverName];
  if (!rawStatus || typeof rawStatus !== 'object' || Array.isArray(rawStatus)) {
    throw new Error(`OpenCode MCP registration response omitted status for "${serverName}"`);
  }
  const status = (rawStatus as Record<string, unknown>).status;
  if (status === 'connected' || status === 'disabled' || status === 'needs_auth') {
    return { status };
  }
  if (status === 'failed' || status === 'needs_client_registration') {
    const error = (rawStatus as Record<string, unknown>).error;
    if (typeof error !== 'string' || error.trim().length === 0) {
      throw new Error(`OpenCode MCP registration returned status "${status}" without an error for "${serverName}"`);
    }
    return { status, error: error.trim() };
  }
  throw new Error(`OpenCode MCP registration returned an unknown status for "${serverName}"`);
}

export type OpenCodeServerRuntimeClient = Readonly<{
  supportsInFlightSteer: () => boolean;
  /** Returns true when changing directory restarted the directory-scoped event stream. */
  setDirectoryOverride: (directory: string) => boolean;
  sessionList: () => Promise<unknown[]>;
  sessionCreate: (opts?: { permission?: unknown[] }) => Promise<OpenCodeSession>;
  sessionGet: (opts: { sessionId: string }) => Promise<OpenCodeSession>;
  sessionUpdate: (opts: { sessionId: string; permission?: unknown[]; title?: string; time?: { archived?: number } }) => Promise<OpenCodeSession>;
  sessionMessagesList: (opts: { sessionId: string }) => Promise<unknown[]>;
  /** Raw provider envelope reserved for fail-closed authoritative inventory readers. */
  sessionMessagesListRaw?: (opts: { sessionId: string }) => Promise<unknown>;
  sessionTodo: (opts: { sessionId: string }) => Promise<unknown[]>;
  sessionDiff: (opts: { sessionId: string; messageId?: string }) => Promise<unknown[]>;
  sessionStatusList: () => Promise<Record<string, { type?: string }>>;
  globalConfigGet: () => Promise<{ model?: string }>;
  agentsList: () => Promise<ReadonlyArray<{ name: string; description?: string }>>;
  appSkills: () => Promise<unknown[]>;
  providersList: () => Promise<ReadonlyArray<{ id: string; env?: readonly string[]; models?: Record<string, unknown> }>>;
  mcpAdd: (opts: { name: string; config: unknown }) => Promise<OpenCodeMcpStatus>;
  sessionPromptAsync: (opts: {
    sessionId: string;
    messageId?: string;
    parts: unknown[];
    agent?: string;
    model?: OpenCodeModelRef;
    variant?: string;
    config?: Record<string, unknown>;
    delivery?: 'steer' | 'queue';
  }) => Promise<void>;
  sessionSummarize: (opts: {
    sessionId: string;
    model: OpenCodeModelRef;
    auto?: boolean;
  }) => Promise<void>;
  sessionAbort: (opts: { sessionId: string }) => Promise<void>;
  sessionFork: (opts: { sessionId: string; messageId?: string }) => Promise<OpenCodeSession>;
  permissionList: () => Promise<unknown[]>;
  questionList: () => Promise<unknown[]>;
  questionReply: (opts: { requestId: string; answers: string[][] }) => Promise<boolean>;
  questionReject: (opts: { requestId: string }) => Promise<boolean>;
  permissionReply: (opts: { requestId: string; reply: PermissionReply }) => Promise<boolean>;
  subscribeGlobalEvents: (opts: {
    sessionId?: string | null;
    signal: AbortSignal;
    onEvent: (evt: OpenCodeGlobalEvent, delivery: OpenCodeGlobalEventDelivery) => void;
  }) => Promise<void>;
  getManagedServerIdentity: () => OpenCodeManagedServerIdentity | null;
  dispose: () => Promise<void>;
}>;

function resolveSseReconnectDelayMs(attempt: number, env: NodeJS.ProcessEnv): number {
  const baseRaw = Number.parseInt(String(env.HAPPIER_OPENCODE_SSE_RECONNECT_BASE_DELAY_MS ?? ''), 10);
  const maxRaw = Number.parseInt(String(env.HAPPIER_OPENCODE_SSE_RECONNECT_MAX_DELAY_MS ?? ''), 10);
  const baseMs = Number.isFinite(baseRaw) && baseRaw > 0 ? Math.trunc(baseRaw) : 250;
  const maxMs = Number.isFinite(maxRaw) && maxRaw > 0 ? Math.trunc(maxRaw) : 5_000;

  const clampedBase = Math.max(5, Math.min(30_000, baseMs));
  const clampedMax = Math.max(clampedBase, Math.min(120_000, maxMs));

  const exp = Math.min(20, Math.max(0, Math.trunc(attempt)));
  const rawDelay = Math.min(clampedMax, clampedBase * (2 ** exp));
  // Add a small jitter so multiple sessions don't reconnect in lockstep.
  const jitter = Math.floor(rawDelay * 0.15 * Math.random());
  return Math.min(clampedMax, rawDelay + jitter);
}

function readOpenCodeProviderList(raw: unknown): ReadonlyArray<{ id: string; env?: readonly string[]; models?: Record<string, unknown> }> {
  const record = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  const all = Array.isArray(record?.all)
    ? record.all as Array<{ id?: unknown; env?: readonly string[]; models?: Record<string, unknown> }>
    : [];
  const connectedRaw = Array.isArray(record?.connected) ? record.connected : null;
  if (!connectedRaw) return all as Array<{ id: string; env?: readonly string[]; models?: Record<string, unknown> }>;

  const connected = new Set(
    connectedRaw
      .map((value) => typeof value === 'string' ? value.trim() : '')
      .filter((value) => value.length > 0),
  );

  return all.filter((provider) => {
    const id = typeof provider?.id === 'string' ? provider.id.trim() : '';
    return id.length > 0 && connected.has(id);
  }) as Array<{ id: string; env?: readonly string[]; models?: Record<string, unknown> }>;
}

type OpenCodeApiGeneration = Readonly<{
  kind: 'v1' | 'v2';
  legacyApiCompatible: boolean;
  legacyMcpCompatible: boolean;
}>;

function readWrappedOpenCodeV2Data(raw: unknown): unknown {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>).data : undefined;
}

function normalizeOpenCodeV2Session(raw: unknown): OpenCodeSession {
  const record = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const location = record.location && typeof record.location === 'object' && !Array.isArray(record.location)
    ? record.location as Record<string, unknown>
    : null;
  const normalized: Record<string, unknown> = {
    ...record,
    id: typeof record.id === 'string' ? record.id : '',
    ...(typeof location?.directory === 'string' ? { directory: location.directory } : {}),
  };
  delete normalized.location;
  return normalized as OpenCodeSession;
}

function normalizeOpenCodeV2Message(raw: unknown, sessionId: string): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const message = raw as Record<string, unknown>;
  const type = typeof message.type === 'string' ? message.type : '';
  const role = type === 'user' || type === 'assistant' ? type : type;
  const info: Record<string, unknown> = { ...message, role, sessionID: sessionId };
  const model = message.model && typeof message.model === 'object' && !Array.isArray(message.model)
    ? message.model as Record<string, unknown>
    : null;
  if (typeof model?.id === 'string' && typeof model.providerID === 'string') {
    const normalizedModel: Record<string, unknown> = { ...model, modelID: model.id };
    delete normalizedModel.id;
    info.model = normalizedModel;
  }
  delete info.type;
  delete info.text;
  delete info.content;
  const parts = Array.isArray(message.content)
    ? message.content.map((part) => {
        if (!part || typeof part !== 'object' || Array.isArray(part)) return part;
        const record = part as Record<string, unknown>;
        return {
          ...record,
          sessionID: sessionId,
          messageID: message.id,
          ...(record.type === 'tool' ? { callID: record.id, tool: record.name } : {}),
        };
      })
    : type === 'user' && typeof message.text === 'string'
      ? [{ type: 'text', text: message.text }]
      : [];
  return { info, parts };
}

function normalizeOpenCodeV2PermissionRequest(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const record = raw as Record<string, unknown>;
  const normalized: Record<string, unknown> = {
    id: record.id,
    sessionID: record.sessionID,
    permission: record.action,
    patterns: Array.isArray(record.resources) ? record.resources : [],
    metadata: record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
      ? record.metadata
      : {},
    always: Array.isArray(record.save) ? record.save : [],
    ...(record.source && typeof record.source === 'object' && !Array.isArray(record.source)
      ? { tool: record.source }
      : record.tool && typeof record.tool === 'object' && !Array.isArray(record.tool)
        ? { tool: record.tool }
        : {}),
  };
  return normalized;
}

function normalizeOpenCodeV2Event(type: string, rawData: unknown): Readonly<{ type: string; properties: unknown }> {
  if (type === 'permission.v2.asked') {
    return { type: 'permission.asked', properties: normalizeOpenCodeV2PermissionRequest(rawData) };
  }
  if (type === 'question.v2.asked') {
    return { type: 'question.asked', properties: rawData };
  }
  if (
    (type === 'session.next.text.delta' || type === 'session.next.reasoning.delta')
    && rawData && typeof rawData === 'object' && !Array.isArray(rawData)
  ) {
    const data = rawData as Record<string, unknown>;
    return {
      type: 'message.part.delta',
      properties: {
        ...data,
        messageID: data.assistantMessageID,
        partID: type === 'session.next.text.delta' ? data.textID : data.reasoningID,
      },
    };
  }
  if (type === 'session.next.execution.settled' && rawData && typeof rawData === 'object' && !Array.isArray(rawData)) {
    const data = rawData as Record<string, unknown>;
    if (data.outcome === 'failure') {
      return {
        type: 'session.error',
        properties: { sessionID: data.sessionID, error: data.error ?? { message: 'OpenCode V2 execution failed' } },
      };
    }
    return { type: 'session.idle', properties: { sessionID: data.sessionID } };
  }
  return { type, properties: rawData };
}

function buildOpenCodeV2Prompt(parts: unknown[]): Record<string, unknown> {
  const text: string[] = [];
  const files: unknown[] = [];
  for (const part of parts) {
    const record = part && typeof part === 'object' && !Array.isArray(part) ? part as Record<string, unknown> : null;
    if (record?.type === 'text' && typeof record.text === 'string') text.push(record.text);
    else if (
      record?.type === 'file'
      && typeof record.url === 'string'
      && typeof record.mime === 'string'
    ) {
      files.push({
        uri: record.url,
        ...(typeof record.filename === 'string' ? { name: record.filename } : {}),
      });
    }
    else throw new Error('OpenCode V2 prompt contains an unsupported part');
  }
  return { text: text.join(''), ...(files.length > 0 ? { files } : {}) };
}

async function sleepUntilOrAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const cleanup = (onAbort: () => void, timer: ReturnType<typeof setTimeout>) => {
      signal.removeEventListener('abort', onAbort);
      clearTimeout(timer);
    };

    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup(onAbort, timer);
      resolve();
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup(onAbort, timer);
      resolve();
    }, ms);
    timer.unref?.();

    signal.addEventListener('abort', onAbort);
  });
}

export async function createOpenCodeServerRuntimeClient(params: Readonly<{
  directory: string;
  messageBuffer: MessageBuffer;
  baseUrlOverride?: string | null;
  env?: NodeJS.ProcessEnv;
  onManagedServerIdentityChanged?: (change: OpenCodeManagedServerIdentityChange) => void;
}>): Promise<OpenCodeServerRuntimeClient> {
  const env = params.env ?? process.env;
  const httpTimeoutMs = resolveOpenCodeServerHttpTimeoutMs(env);
  const readIdleTimeoutMs = resolveOpenCodeSseReadIdleTimeoutMs(env);
  const baseUrlOverrideRaw = typeof params.baseUrlOverride === 'string' ? params.baseUrlOverride.trim() : '';
  const envUrlRaw = typeof env.HAPPIER_OPENCODE_SERVER_URL === 'string' ? env.HAPPIER_OPENCODE_SERVER_URL.trim() : '';
  const usingManagedServer = baseUrlOverrideRaw.length === 0 && envUrlRaw.length === 0;

  const headers = resolveOpenCodeServerAuthHeadersFromEnv(env);

  let directoryOverride = '';
  const resolveDirectory = (): string => {
    const normalized = directoryOverride.trim() || params.directory.trim();
    return normalized;
  };

  const probeHealth = async (
    candidateBaseUrl: string,
    apiGeneration: 'auto' | 'v2' = 'auto',
  ): Promise<boolean> => {
    try {
      const probeTimeoutMs = httpTimeoutMs ? Math.min(2_000, httpTimeoutMs) : 900;
      const paths = apiGeneration === 'v2'
          ? ['/api/health']
          : ['/api/health', '/global/health'];
      for (const path of paths) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), probeTimeoutMs);
        timer.unref?.();
        const res = await fetch(buildUrl(candidateBaseUrl, path), { method: 'GET', headers, signal: ctrl.signal }).catch(() => null);
        clearTimeout(timer);
        if (res?.ok) {
          const body = await res.json().catch(() => null) as unknown;
          if (body && typeof body === 'object' && !Array.isArray(body) && (body as { healthy?: unknown }).healthy === true) {
            return true;
          }
        }
      }
      return false;
    } catch {
      return false;
    }
  };

  let baseUrl = normalizeBaseUrl(
    baseUrlOverrideRaw
      || envUrlRaw
      || await ensureSharedManagedOpenCodeServerBaseUrl({
        probeHealth,
        requireBrokerLoadNonce: requiresOpenCodeBrokerLoadNonce(env),
      }),
  );
  let apiGeneration: (OpenCodeApiGeneration & { key: string }) | null = null;
  let lastObservedExternalApiGeneration: OpenCodeApiGeneration['kind'] | null = null;
  const permissionSessionByRequestId = new Map<string, string>();
  const questionSessionByRequestId = new Map<string, string>();
  const todosBySessionId = new Map<string, unknown[]>();

  const clearGenerationSpecificRequestState = (): void => {
    permissionSessionByRequestId.clear();
    questionSessionByRequestId.clear();
    todosBySessionId.clear();
  };

  // Managed-server generation identity. The runtime uses this to detect mid-turn server replacement
  // (Lane E). It is tracked only in managed mode; explicit URL / override modes never emit changes.
  let managedServerIdentity: OpenCodeManagedServerIdentity | null = null;
  let managedServerApiGeneration: 'auto' | 'v2' | null = null;

  const captureManagedServerIdentityFromState = (
    state: SharedManagedOpenCodeServerState | null,
    reason: OpenCodeManagedServerIdentityChangeReason,
  ): void => {
    if (!usingManagedServer) return;
    if (!state || typeof state.baseUrl !== 'string' || !isLoopbackManagedOpenCodeBaseUrl(state.baseUrl)) {
      return;
    }
    const nextIdentity = resolveOpenCodeManagedServerIdentity(state);
    managedServerApiGeneration = nextIdentity.apiGeneration ?? null;
    if (isSameOpenCodeManagedServerGeneration(managedServerIdentity, nextIdentity)) {
      // Same process generation: refresh the normalized fields without surfacing a change.
      managedServerIdentity = nextIdentity;
      return;
    }
    const previous = managedServerIdentity;
    managedServerIdentity = nextIdentity;
    apiGeneration = null;
    clearGenerationSpecificRequestState();
    // The initial baseline must not surface as a "change"; only genuine replacements do.
    if (reason === 'initial') return;
    try {
      params.onManagedServerIdentityChanged?.({ previous, current: nextIdentity, reason });
    } catch {
      // Identity-change observers must never destabilize the client transport loop.
    }
  };

  if (usingManagedServer) {
    // Establish the baseline generation so a later replacement is detectable. Best-effort: a missing
    // state file simply leaves identity null until the first refresh observes a server.
    const initialState = await readSharedManagedOpenCodeServerStateBestEffort().catch(() => null);
    applyManagedOpenCodeBrokerLoadNonce(env, initialState);
    captureManagedServerIdentityFromState(initialState, 'initial');
  }

  const refreshBaseUrlIfManagedBestEffort = async (opts: Readonly<{
    allowEnsure: boolean;
    reason: OpenCodeManagedServerIdentityChangeReason;
  }>): Promise<void> => {
    if (!usingManagedServer) return;

    const state = await readSharedManagedOpenCodeServerStateBestEffort().catch(() => null);
    applyManagedOpenCodeBrokerLoadNonce(env, state);
    if (state?.baseUrl && isLoopbackManagedOpenCodeBaseUrl(state.baseUrl)) {
      const normalized = normalizeBaseUrl(state.baseUrl);
      if (normalized && normalized !== baseUrl) {
        baseUrl = normalized;
      }
    }

    if (!opts.allowEnsure) {
      // SSE-reconnect refresh: never ensures/replaces a server. Surface an identity change only if
      // the already-written state points at a new managed-server generation.
      captureManagedServerIdentityFromState(state, opts.reason);
      return;
    }

    // Transport-level request failures can refresh the managed server. SSE disconnects use
    // allowEnsure=false above so a quiet event stream cannot kill or replace a slow server.
    if (!state) {
      const healthy = await probeHealth(baseUrl).catch(() => false);
      if (healthy) return;
    } else {
      const pidAlive = (() => {
        try {
          process.kill(state.pid, 0);
          return true;
        } catch {
          return false;
        }
      })();
      if (pidAlive) {
        const healthy = await probeHealth(baseUrl).catch(() => false);
        if (healthy) return;
      }
    }

    try {
      baseUrl = normalizeBaseUrl(
        await ensureSharedManagedOpenCodeServerBaseUrl({
          probeHealth,
          requireBrokerLoadNonce: requiresOpenCodeBrokerLoadNonce(env),
        }),
      );
    } catch {
      // Ignore (caller will retry with backoff).
    }

    // After an ensure, the managed server may have been replaced on a new port/pid. Re-read the
    // freshly written state and surface a generation change if the process identity differs.
    const stateAfterEnsure = await readSharedManagedOpenCodeServerStateBestEffort().catch(() => null);
    applyManagedOpenCodeBrokerLoadNonce(env, stateAfterEnsure);
    captureManagedServerIdentityFromState(stateAfterEnsure, opts.reason);
  };

  const waitForManagedServerHealthAfterRefreshBestEffort = async (): Promise<void> => {
    if (!usingManagedServer) return;
    try {
      await waitForOpenCodeServerHealth({
        baseUrl,
        timeoutMs: 2_000,
        pollIntervalMs: 100,
        headers,
      });
    } catch {
      // best-effort only; caller will decide whether to propagate the original error
    }
  };

  const ensureApiGeneration = async (): Promise<OpenCodeApiGeneration> => {
    const key = `${baseUrl}:${managedServerIdentity?.generationKey ?? ''}`;
    if (apiGeneration?.key === key) return apiGeneration;
    const rememberDetectedGeneration = (detected: OpenCodeApiGeneration): OpenCodeApiGeneration & { key: string } => {
      if (!usingManagedServer) {
        if (lastObservedExternalApiGeneration !== null && lastObservedExternalApiGeneration !== detected.kind) {
          clearGenerationSpecificRequestState();
        }
        lastObservedExternalApiGeneration = detected.kind;
      }
      apiGeneration = { key, ...detected };
      return apiGeneration;
    };
    const probe = async (path: string): Promise<unknown> => {
      try {
        return await fetchJson<unknown>({
          url: buildUrl(baseUrl, path), method: 'GET', headers,
          timeoutMs: Math.min(2_000, httpTimeoutMs ?? 2_000),
        });
      } catch {
        return null;
      }
    };
    if (managedServerApiGeneration === 'v2') {
      const legacy = await probe('/global/health');
      const legacyRecord = legacy && typeof legacy === 'object' && !Array.isArray(legacy)
        ? legacy as Record<string, unknown>
        : null;
      const legacyMcp = legacyRecord?.healthy === true && typeof legacyRecord.version === 'string'
        ? await probe('/mcp')
        : null;
      return rememberDetectedGeneration({
        kind: 'v2',
        legacyApiCompatible: legacyRecord?.healthy === true && typeof legacyRecord.version === 'string',
        legacyMcpCompatible: Boolean(legacyMcp && typeof legacyMcp === 'object' && !Array.isArray(legacyMcp)),
      });
    }
    const v2 = await probe('/api/health');
    if (v2 && typeof v2 === 'object' && !Array.isArray(v2) && (v2 as Record<string, unknown>).healthy === true) {
      const legacy = await probe('/global/health');
      const legacyRecord = legacy && typeof legacy === 'object' && !Array.isArray(legacy) ? legacy as Record<string, unknown> : null;
      const legacyMcp = legacyRecord?.healthy === true && typeof legacyRecord.version === 'string'
        ? await probe('/mcp')
        : null;
      return rememberDetectedGeneration({
        kind: 'v2',
        legacyApiCompatible: legacyRecord?.healthy === true && typeof legacyRecord.version === 'string',
        legacyMcpCompatible: Boolean(legacyMcp && typeof legacyMcp === 'object' && !Array.isArray(legacyMcp)),
      });
    }
    const legacy = await probe('/global/health');
    const legacyRecord = legacy && typeof legacy === 'object' && !Array.isArray(legacy) ? legacy as Record<string, unknown> : null;
    if (legacyRecord?.healthy === true && typeof legacyRecord.version === 'string') {
      return rememberDetectedGeneration({ kind: 'v1', legacyApiCompatible: true, legacyMcpCompatible: true });
    }
    throw new Error('OpenCode server generation detection failed: neither authenticated V2 nor V1 health contract is available');
  };

  const refreshTransportForSseReconnect = async (): Promise<void> => {
    await refreshBaseUrlIfManagedBestEffort({ allowEnsure: false, reason: 'sse_reconnect_state_refresh' });
    if (!usingManagedServer) {
      apiGeneration = null;
    }
  };

  const fetchJsonWithManagedServerRetry = async <T>(
    diagnostic: Readonly<{
      operation: ManagedServerRetryOperation;
      method: 'GET' | 'PATCH';
    }>,
    request: (currentBaseUrl: string) => Promise<T>,
  ): Promise<T> => {
    try {
      return await request(baseUrl);
    } catch (error) {
      const failureKind = classifyRetryableManagedServerTransportError(error);
      if (!usingManagedServer || !failureKind) {
        throw error;
      }
      logger.debug('[OpenCodeServer] Retrying managed HTTP request after transient transport failure', {
        operation: diagnostic.operation,
        method: diagnostic.method,
        failedAttempt: 1,
        nextAttempt: 2,
        failureKind,
      });
      await refreshBaseUrlIfManagedBestEffort({ allowEnsure: true, reason: 'http_retry_ensure' });
      await waitForManagedServerHealthAfterRefreshBestEffort();
      return await request(baseUrl);
    }
  };

  // Detect once per server generation at the authenticated transport boundary.
  try {
    await ensureApiGeneration();
  } catch (error) {
    logger.debug('[OpenCodeServer] Health probe failed (non-fatal)', error);
  }

  let subscription: Awaited<ReturnType<typeof subscribeSseJson<OpenCodeGlobalEvent>>> | null = null;
  let liveSubscription: Awaited<ReturnType<typeof subscribeSseJson<unknown>>> | null = null;
  let subscriptionLoop: Promise<void> | null = null;
  let subscriptionLoopAbort: AbortController | null = null;
  let connectionGeneration = 0;
  let disposed = false;

  const readDurableSequence = (rawEvent: unknown, sessionId: string): number | null => {
    if (!rawEvent || typeof rawEvent !== 'object' || Array.isArray(rawEvent)) return null;
    const durableRaw = (rawEvent as Record<string, unknown>).durable;
    if (!durableRaw || typeof durableRaw !== 'object' || Array.isArray(durableRaw)) return null;
    const durable = durableRaw as Record<string, unknown>;
    const sequence = durable.seq;
    if (durable.aggregateID !== sessionId) return null;
    return typeof sequence === 'number' && Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : null;
  };

  const readV2SessionTail = async (sessionId: string, signal: AbortSignal): Promise<number | null> => {
    const path = `/api/session/${encodeURIComponent(sessionId)}/history`;
    let cursor: number | null = null;
    for (;;) {
      const raw = await fetchJson<unknown>({
        url: buildUrl(baseUrl, path, cursor === null ? undefined : { after: String(cursor) }),
        method: 'GET',
        headers,
        timeoutMs: httpTimeoutMs,
        signal,
      });
      const page = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
      const events = Array.isArray(page?.data) ? page.data : null;
      if (!events || typeof page?.hasMore !== 'boolean') {
        throw new Error('OpenCode V2 session history returned an invalid page');
      }
      let advanced = false;
      for (const event of events) {
        const sequence = readDurableSequence(event, sessionId);
        if (sequence === null || (cursor !== null && sequence <= cursor)) {
          throw new Error('OpenCode V2 session history returned an invalid durable sequence');
        }
        cursor = sequence;
        advanced = true;
      }
      if (!page.hasMore) return cursor;
      if (!advanced) throw new Error('OpenCode V2 session history did not advance its cursor');
    }
  };
  const rememberRequestSessions = (items: unknown[], target: Map<string, string>): void => {
    for (const item of items) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const record = item as Record<string, unknown>;
      if (typeof record.id === 'string' && typeof record.sessionID === 'string') {
        target.set(record.id, record.sessionID);
      }
    }
  };

  const fetchSessionMessagesListRaw = async (sessionId: string): Promise<unknown> => (
    await fetchJsonWithManagedServerRetry({ operation: 'session_messages_list', method: 'GET' }, async (currentBaseUrl) => {
      const api = await ensureApiGeneration();
      if (api.kind !== 'v2') {
        return await fetchJson<unknown>({
          url: buildUrl(currentBaseUrl, `/session/${encodeURIComponent(sessionId)}/message`, { directory: resolveDirectory() }),
          method: 'GET',
          headers,
          timeoutMs: httpTimeoutMs,
        });
      }

      const messages: unknown[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      for (;;) {
        const raw = await fetchJson<unknown>({
          url: buildUrl(currentBaseUrl, `/api/session/${encodeURIComponent(sessionId)}/message`, cursor ? { cursor } : { order: 'asc' }),
          method: 'GET',
          headers,
          timeoutMs: httpTimeoutMs,
        });
        const data = readWrappedOpenCodeV2Data(raw);
        if (!Array.isArray(data)) return data;
        messages.push(...data.map((message) => normalizeOpenCodeV2Message(message, sessionId)));

        const envelope = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
        const cursorEnvelope = envelope?.cursor && typeof envelope.cursor === 'object' && !Array.isArray(envelope.cursor)
          ? envelope.cursor as Record<string, unknown>
          : null;
        const nextCursor = typeof cursorEnvelope?.next === 'string' ? cursorEnvelope.next : '';
        if (!nextCursor) return messages;
        if (seenCursors.has(nextCursor)) {
          throw new Error('OpenCode V2 session message pagination returned a repeated cursor');
        }
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      }
    })
  );

  const client: OpenCodeServerRuntimeClient = {
    supportsInFlightSteer: () => apiGeneration?.kind === 'v2',
    setDirectoryOverride: (directory) => {
      const previousDirectory = resolveDirectory();
      directoryOverride = typeof directory === 'string' ? directory : '';
      if (resolveDirectory() === previousDirectory) return false;
      // `/event` is directory-scoped. Closing the active stream lets the subscription loop reopen
      // it with the new directory before the runtime admits another prompt.
      subscription?.close();
      return true;
    },
    sessionList: async () => {
      const api = await ensureApiGeneration();
      const raw = await fetchJson<unknown>({
        url: buildUrl(baseUrl, `${api.kind === 'v2' ? '/api' : ''}/session`, { directory: resolveDirectory() }),
        method: 'GET',
        headers,
        timeoutMs: httpTimeoutMs,
      });
      const data = api.kind === 'v2' ? readWrappedOpenCodeV2Data(raw) : raw;
      return Array.isArray(data) ? (api.kind === 'v2' ? data.map(normalizeOpenCodeV2Session) : data) : [];
    },
    sessionCreate: async (opts) => {
      const api = await ensureApiGeneration();
      const raw = await fetchJson<unknown>({
        url: buildUrl(baseUrl, `${api.kind === 'v2' ? '/api' : ''}/session`, api.kind === 'v2' ? undefined : { directory: resolveDirectory() }),
        method: 'POST',
        headers,
        body: api.kind === 'v2' ? {
          location: { directory: resolveDirectory() },
        } : {
          ...(Array.isArray(opts?.permission) ? { permission: opts?.permission } : {}),
        },
        timeoutMs: httpTimeoutMs,
      });
      return api.kind === 'v2' ? normalizeOpenCodeV2Session(readWrappedOpenCodeV2Data(raw)) : raw as OpenCodeSession;
    },
    sessionGet: async ({ sessionId }) => {
      const api = await ensureApiGeneration();
      const raw = await fetchJson<unknown>({
        url: buildUrl(baseUrl, `${api.kind === 'v2' ? '/api' : ''}/session/${encodeURIComponent(sessionId)}`, api.kind === 'v2' ? undefined : { directory: resolveDirectory() }),
        method: 'GET',
        headers,
        timeoutMs: httpTimeoutMs,
      });
      return api.kind === 'v2' ? normalizeOpenCodeV2Session(readWrappedOpenCodeV2Data(raw)) : raw as OpenCodeSession;
    },
    sessionUpdate: async ({ sessionId, permission, title, time }) => {
      const initialApi = await ensureApiGeneration();
      if (initialApi.kind === 'v2') {
        if (time) {
          throw new Error('OpenCode V2 session update does not support legacy archive-time fields');
        }
        if (typeof title === 'string') {
          throw new Error('OpenCode V2 session title updates are unavailable');
        }
        // V2 has no mutable session permission-ruleset field. Permission intent remains enforced by
        // the runtime's canonical permission request/reply owner, so the V1-only projection is omitted.
        const raw = await fetchJson<unknown>({
          url: buildUrl(baseUrl, `/api/session/${encodeURIComponent(sessionId)}`),
          method: 'GET', headers, timeoutMs: httpTimeoutMs,
        });
        return normalizeOpenCodeV2Session(readWrappedOpenCodeV2Data(raw));
      }
      const body: Record<string, unknown> = {};
      if (Array.isArray(permission)) {
        body.permission = permission;
      }
      if (typeof title === 'string') {
        body.title = title;
      }
      if (time && typeof time === 'object') {
        body.time = time;
      }

      const { api, raw } = await fetchJsonWithManagedServerRetry({ operation: 'session_update', method: 'PATCH' }, async (currentBaseUrl) => {
        const api = await ensureApiGeneration();
        const raw = await fetchJson<unknown>({
          url: buildUrl(currentBaseUrl, `/session/${encodeURIComponent(sessionId)}`, { directory: resolveDirectory() }),
          method: 'PATCH', headers, body, timeoutMs: httpTimeoutMs,
        });
        return { api, raw };
      });
      return api.kind === 'v2' ? normalizeOpenCodeV2Session(readWrappedOpenCodeV2Data(raw)) : raw as OpenCodeSession;
    },
    sessionMessagesList: async ({ sessionId }) => {
      const raw = await fetchSessionMessagesListRaw(sessionId);
      return Array.isArray(raw) ? raw : [];
    },
    sessionMessagesListRaw: async ({ sessionId }) => await fetchSessionMessagesListRaw(sessionId),
    sessionTodo: async ({ sessionId }) => {
      const initialApi = await ensureApiGeneration();
      if (initialApi.kind === 'v2') return todosBySessionId.get(sessionId) ?? [];
      const { api, raw } = await fetchJsonWithManagedServerRetry({ operation: 'session_todo', method: 'GET' }, async (currentBaseUrl) => {
        const api = await ensureApiGeneration();
        const raw = await fetchJson<unknown>({
          url: buildUrl(currentBaseUrl, `${api.kind === 'v2' ? '/api' : ''}/session/${encodeURIComponent(sessionId)}/todo`, { directory: resolveDirectory() }),
          method: 'GET', headers, timeoutMs: httpTimeoutMs,
        });
        return { api, raw };
      });
      const data = api.kind === 'v2' ? readWrappedOpenCodeV2Data(raw) : raw;
      return Array.isArray(data) ? data : [];
    },
    sessionDiff: async ({ sessionId, messageId }) => {
      const { raw } = await fetchJsonWithManagedServerRetry({ operation: 'session_diff', method: 'GET' }, async (currentBaseUrl) => {
        const api = await ensureApiGeneration();
        if (api.kind === 'v2' && !api.legacyApiCompatible) {
          throw new Error('OpenCode V2 session diff is unavailable without the legacy API surface');
        }
        const raw = await fetchJson<unknown>({
          url: buildUrl(currentBaseUrl, `/session/${encodeURIComponent(sessionId)}/diff`, {
            directory: resolveDirectory(),
            ...(messageId ? { messageID: messageId } : {}),
          }),
          method: 'GET', headers, timeoutMs: httpTimeoutMs,
        });
        return { raw };
      });
      return Array.isArray(raw) ? raw : [];
    },
    sessionStatusList: async () => {
      const { api, raw } = await fetchJsonWithManagedServerRetry({ operation: 'session_status_list', method: 'GET' }, async (currentBaseUrl) => {
        const api = await ensureApiGeneration();
        const raw = await fetchJson<unknown>({
          url: buildUrl(currentBaseUrl, api.kind === 'v2' ? '/api/session/active' : '/session/status', api.kind === 'v2' ? undefined : { directory: resolveDirectory() }),
          method: 'GET', headers, timeoutMs: httpTimeoutMs,
        });
        return { api, raw };
      });
      const data = api.kind === 'v2' ? readWrappedOpenCodeV2Data(raw) : raw;
      if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
      return data as Record<string, { type?: string }>;
    },
    globalConfigGet: async () => {
      const api = await ensureApiGeneration();
      if (api.kind === 'v2') return {};
      return await fetchJson<{ model?: string }>({
        url: buildUrl(baseUrl, '/global/config'),
        method: 'GET',
        headers,
        timeoutMs: httpTimeoutMs,
      });
    },
    agentsList: async () => {
      const api = await ensureApiGeneration();
      const raw = await fetchJson<unknown>({
        url: buildUrl(baseUrl, api.kind === 'v2' ? '/api/agent' : '/agent', api.kind === 'v2' ? { 'location[directory]': resolveDirectory() } : undefined),
        method: 'GET',
        headers,
        timeoutMs: httpTimeoutMs,
      });
      const agents = api.kind === 'v2' ? readWrappedOpenCodeV2Data(raw) : raw;
      return Array.isArray(agents) ? agents as Array<{ name: string; description?: string }> : [];
    },
    appSkills: async () => {
      const api = await ensureApiGeneration();
      const raw = await fetchJson<unknown>({
        url: buildUrl(baseUrl, api.kind === 'v2' ? '/api/skill' : '/skill', api.kind === 'v2' ? { 'location[directory]': resolveDirectory() } : { directory: resolveDirectory() }),
        method: 'GET',
        headers,
        timeoutMs: httpTimeoutMs,
      });
      const skills = api.kind === 'v2' ? readWrappedOpenCodeV2Data(raw) : raw;
      return Array.isArray(skills) ? skills : [];
    },
    providersList: async () => {
      const api = await ensureApiGeneration();
      if (api.kind !== 'v2') {
        const raw = await fetchJson<unknown>({
          url: buildUrl(baseUrl, '/provider'), method: 'GET', headers, timeoutMs: httpTimeoutMs,
        });
        return readOpenCodeProviderList(raw);
      }

      const locationQuery = { 'location[directory]': resolveDirectory() };
      const [providersRaw, modelsRaw] = await Promise.all([
        fetchJson<unknown>({
          url: buildUrl(baseUrl, '/api/provider', locationQuery), method: 'GET', headers, timeoutMs: httpTimeoutMs,
        }),
        fetchJson<unknown>({
          url: buildUrl(baseUrl, '/api/model', locationQuery), method: 'GET', headers, timeoutMs: httpTimeoutMs,
        }),
      ]);
      const providers = readWrappedOpenCodeV2Data(providersRaw);
      const models = readWrappedOpenCodeV2Data(modelsRaw);
      if (!Array.isArray(providers) || !Array.isArray(models)) return [];

      const modelsByProvider = new Map<string, Record<string, unknown>>();
      for (const model of models) {
        if (!model || typeof model !== 'object' || Array.isArray(model)) continue;
        const record = model as Record<string, unknown>;
        const providerID = typeof record.providerID === 'string' ? record.providerID.trim() : '';
        const id = typeof record.id === 'string' ? record.id.trim() : '';
        if (!providerID || !id) continue;
        const providerModels = modelsByProvider.get(providerID) ?? {};
        providerModels[id] = record;
        modelsByProvider.set(providerID, providerModels);
      }

      return providers.flatMap((provider) => {
        if (!provider || typeof provider !== 'object' || Array.isArray(provider)) return [];
        const record = provider as Record<string, unknown>;
        const id = typeof record.id === 'string' ? record.id.trim() : '';
        if (!id) return [];
        return [{ ...record, id, models: modelsByProvider.get(id) ?? {} }];
      }) as Array<{ id: string; env?: readonly string[]; models?: Record<string, unknown> }>;
    },
    mcpAdd: async ({ name, config }) => {
      const serverName = typeof name === 'string' ? name.trim() : '';
      if (!serverName) {
        throw new Error('OpenCode MCP registration requires a server name');
      }
      const api = await ensureApiGeneration();
      if (api.kind === 'v2' && !api.legacyMcpCompatible) {
        throw new Error('OpenCode V2 dynamic MCP is unavailable: this server does not expose the pinned legacy health and /mcp contracts');
      }
      const response = await fetchJson<unknown>({
        url: buildUrl(baseUrl, '/mcp', { directory: resolveDirectory() }),
        method: 'POST',
        headers,
        body: {
          name: serverName,
          config,
        },
        timeoutMs: httpTimeoutMs,
      });
      return readOpenCodeMcpStatus(response, serverName);
    },
    sessionPromptAsync: async ({ sessionId, messageId, parts, agent, model, variant, config, delivery }) => {
      const api = await ensureApiGeneration();
      const normalizedVariant = typeof variant === 'string' ? variant.trim() : '';
      if (api.kind === 'v2') {
        if (config) {
          throw new Error('OpenCode V2 prompt does not support legacy config fields');
        }
        if (normalizedVariant && !model) {
          throw new Error('OpenCode V2 prompt variant requires an explicit model');
        }
        if (agent) {
          await fetchJson<void>({
            url: buildUrl(baseUrl, `/api/session/${encodeURIComponent(sessionId)}/agent`),
            method: 'POST', headers, body: { agent }, timeoutMs: httpTimeoutMs,
          });
        }
        if (model) {
          await fetchJson<void>({
            url: buildUrl(baseUrl, `/api/session/${encodeURIComponent(sessionId)}/model`),
            method: 'POST', headers, body: {
              model: {
                id: model.modelID,
                providerID: model.providerID,
                ...(normalizedVariant ? { variant: normalizedVariant } : {}),
              },
            }, timeoutMs: httpTimeoutMs,
          });
        }
      } else if (delivery) {
        throw new Error('OpenCode V1 prompt delivery does not support steer or queue modes');
      }
      // prompt_async is effectful. Once its POST is attempted, transport loss is ambiguous and
      // must surface to the canonical Pending owner; replaying it can duplicate provider work.
      await fetchJson<void>({
        url: buildUrl(baseUrl, `${api.kind === 'v2' ? '/api' : ''}/session/${encodeURIComponent(sessionId)}/${api.kind === 'v2' ? 'prompt' : 'prompt_async'}`, api.kind === 'v2' ? undefined : { directory: resolveDirectory() }),
        method: 'POST',
        headers,
        body: api.kind === 'v2' ? {
          ...(messageId ? { id: messageId } : {}),
          prompt: buildOpenCodeV2Prompt(parts),
          ...(delivery ? { delivery } : {}),
        } : {
          ...(messageId ? { messageID: messageId } : {}),
          ...(agent ? { agent } : {}),
          ...(model ? { model } : {}),
          ...(normalizedVariant ? { variant: normalizedVariant } : {}),
          ...(config ? { config } : {}),
          parts,
        },
        timeoutMs: httpTimeoutMs,
      });
    },
    sessionSummarize: async ({ sessionId, model, auto }) => {
      const api = await ensureApiGeneration();
      if (api.kind === 'v2') {
        throw new Error('OpenCode V2 manual compaction is unavailable');
      }
      // Summarization is effectful. A transport failure after the POST is ambiguous, so replaying
      // it could duplicate provider work just like replaying prompt_async.
      await fetchJson<void>({
        url: buildUrl(baseUrl, `/session/${encodeURIComponent(sessionId)}/summarize`, { directory: resolveDirectory() }),
        method: 'POST',
        headers,
        body: {
          providerID: model.providerID,
          modelID: model.modelID,
          ...(typeof auto === 'boolean' ? { auto } : {}),
        },
        timeoutMs: httpTimeoutMs,
      });
    },
    sessionAbort: async ({ sessionId }) => {
      const api = await ensureApiGeneration();
      await fetchJson<void>({
        url: buildUrl(baseUrl, `${api.kind === 'v2' ? '/api' : ''}/session/${encodeURIComponent(sessionId)}/${api.kind === 'v2' ? 'interrupt' : 'abort'}`, api.kind === 'v2' ? undefined : { directory: resolveDirectory() }),
        method: 'POST',
        headers,
        body: {},
        timeoutMs: httpTimeoutMs,
      });
    },
    sessionFork: async ({ sessionId, messageId }) => {
      const api = await ensureApiGeneration();
      if (api.kind === 'v2' && !api.legacyApiCompatible) {
        throw new Error('OpenCode V2 session fork is unavailable without the legacy API surface');
      }
      return await fetchJson<OpenCodeSession>({
        url: buildUrl(baseUrl, `/session/${encodeURIComponent(sessionId)}/fork`, { directory: resolveDirectory() }),
        method: 'POST',
        headers,
        body: messageId ? { messageID: messageId } : {},
        timeoutMs: httpTimeoutMs,
      });
    },
    questionReply: async ({ requestId, answers }) => {
      const api = await ensureApiGeneration();
      const sessionId = questionSessionByRequestId.get(requestId);
      if (api.kind === 'v2' && !sessionId) throw new Error(`OpenCode V2 question ${requestId} has no known session`);
      const raw = await fetchJson<unknown>({
        url: buildUrl(baseUrl, api.kind === 'v2'
          ? `/api/session/${encodeURIComponent(sessionId!)}/question/${encodeURIComponent(requestId)}/reply`
          : `/question/${encodeURIComponent(requestId)}/reply`, api.kind === 'v2' ? undefined : { directory: resolveDirectory() }),
        method: 'POST',
        headers,
        body: { answers },
        timeoutMs: httpTimeoutMs,
      });
      return api.kind === 'v2' ? true : raw === true;
    },
    questionReject: async ({ requestId }) => {
      const api = await ensureApiGeneration();
      const sessionId = questionSessionByRequestId.get(requestId);
      if (api.kind === 'v2' && !sessionId) throw new Error(`OpenCode V2 question ${requestId} has no known session`);
      const raw = await fetchJson<unknown>({
        url: buildUrl(baseUrl, api.kind === 'v2'
          ? `/api/session/${encodeURIComponent(sessionId!)}/question/${encodeURIComponent(requestId)}/reject`
          : `/question/${encodeURIComponent(requestId)}/reject`, api.kind === 'v2' ? undefined : { directory: resolveDirectory() }),
        method: 'POST',
        headers,
        body: {},
        timeoutMs: httpTimeoutMs,
      });
      return api.kind === 'v2' ? true : raw === true;
    },
    permissionReply: async ({ requestId, reply }) => {
      const api = await ensureApiGeneration();
      const sessionId = permissionSessionByRequestId.get(requestId);
      if (api.kind === 'v2' && !sessionId) throw new Error(`OpenCode V2 permission ${requestId} has no known session`);
      const raw = await fetchJson<unknown>({
        url: buildUrl(baseUrl, api.kind === 'v2'
          ? `/api/session/${encodeURIComponent(sessionId!)}/permission/${encodeURIComponent(requestId)}/reply`
          : `/permission/${encodeURIComponent(requestId)}/reply`, api.kind === 'v2' ? undefined : { directory: resolveDirectory() }),
        method: 'POST',
        headers,
        body: { reply },
        timeoutMs: httpTimeoutMs,
      });
      return api.kind === 'v2' ? true : raw === true;
    },
    permissionList: async () => {
      const { api, raw } = await fetchJsonWithManagedServerRetry({ operation: 'permission_list', method: 'GET' }, async (currentBaseUrl) => {
        const api = await ensureApiGeneration();
        const raw = await fetchJson<unknown>({
          url: buildUrl(currentBaseUrl, api.kind === 'v2' ? '/api/permission/request' : '/permission', api.kind === 'v2' ? { 'location[directory]': resolveDirectory() } : { directory: resolveDirectory() }),
          method: 'GET', headers, timeoutMs: httpTimeoutMs,
        });
        return { api, raw };
      });
      const data = api.kind === 'v2' ? readWrappedOpenCodeV2Data(raw) : raw;
      if (!Array.isArray(data)) {
        throw new Error('OpenCode permission list returned invalid data');
      }
      const permissions = api.kind === 'v2' ? data.map(normalizeOpenCodeV2PermissionRequest) : data;
      rememberRequestSessions(permissions, permissionSessionByRequestId);
      return permissions;
    },
    questionList: async () => {
      const { api, raw } = await fetchJsonWithManagedServerRetry({ operation: 'question_list', method: 'GET' }, async (currentBaseUrl) => {
        const api = await ensureApiGeneration();
        const raw = await fetchJson<unknown>({
          url: buildUrl(currentBaseUrl, api.kind === 'v2' ? '/api/question/request' : '/question', api.kind === 'v2' ? { 'location[directory]': resolveDirectory() } : { directory: resolveDirectory() }),
          method: 'GET', headers, timeoutMs: httpTimeoutMs,
        });
        return { api, raw };
      });
      const data = api.kind === 'v2' ? readWrappedOpenCodeV2Data(raw) : raw;
      if (!Array.isArray(data)) {
        throw new Error('OpenCode question list returned invalid data');
      }
      rememberRequestSessions(data, questionSessionByRequestId);
      return data;
    },
    subscribeGlobalEvents: async ({ sessionId: rawSessionId, signal, onEvent }) => {
      if (disposed) return;
      if (subscriptionLoop) return;

      subscriptionLoop = (async () => {
        const localAbort = new AbortController();
        subscriptionLoopAbort = localAbort;

        let attempt = 0;
        const ownedSessionId = typeof rawSessionId === 'string' && rawSessionId.trim().length > 0
          ? rawSessionId
          : null;
        let durableCursor: number | null = null;
        let durableCursorInitialized = false;
        let subscribedApiGeneration: OpenCodeApiGeneration['kind'] | null = null;
        while (!disposed && !signal.aborted && !localAbort.signal.aborted) {
          const currentConnectionGeneration = connectionGeneration + 1;
          connectionGeneration = currentConnectionGeneration;
          let providerConnectionBoundarySeen = false;
          const combinedAbort = new AbortController();
          const onAbort = () => {
            try {
              combinedAbort.abort();
            } catch {
              // ignore
            }
          };
          signal.addEventListener('abort', onAbort, { once: true });
          localAbort.signal.addEventListener('abort', onAbort, { once: true });

          try {
            const api = await ensureApiGeneration();
            if (subscribedApiGeneration !== null && subscribedApiGeneration !== api.kind) {
              durableCursor = null;
              durableCursorInitialized = false;
            }
            subscribedApiGeneration = api.kind;
            const streamDirectory = resolveDirectory();
            const useDurableSessionStream = api.kind === 'v2' && ownedSessionId !== null;
            if (useDurableSessionStream && !durableCursorInitialized) {
              durableCursor = await readV2SessionTail(ownedSessionId, combinedAbort.signal);
              durableCursorInitialized = true;
            }
            const url = useDurableSessionStream
              ? buildUrl(
                  baseUrl,
                  `/api/session/${encodeURIComponent(ownedSessionId)}/event`,
                  durableCursor === null ? undefined : { after: String(durableCursor) },
                )
              : buildUrl(baseUrl, api.kind === 'v2' ? '/api/event' : '/event', api.kind === 'v2' ? undefined : { directory: streamDirectory });
            const nextHeaders: Record<string, string> = { ...headers };
            subscription = await subscribeSseJson<unknown>({
              url,
              headers: nextHeaders,
              signal: combinedAbort.signal,
              readIdleTimeoutMs,
              ...(useDurableSessionStream
                ? {
                    onOpen: () => {
                      providerConnectionBoundarySeen = true;
                      onEvent({
                        directory: streamDirectory,
                        payload: { type: 'server.connected', properties: {} },
                      }, {
                        provenance: 'connection-boundary',
                        connectionGeneration: currentConnectionGeneration,
                      });
                    },
                  }
                : {}),
              onMessage: (msg) => {
                if (currentConnectionGeneration !== connectionGeneration) return;
                if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
                const rawEvent = msg as Record<string, unknown>;
                if (useDurableSessionStream) {
                  const sequence = readDurableSequence(rawEvent, ownedSessionId);
                  if (sequence === null || (durableCursor !== null && sequence <= durableCursor)) return;
                  durableCursor = sequence;
                }
                const wireEventType = typeof rawEvent.type === 'string' ? rawEvent.type : '';
                if (!wireEventType) return;
                const normalizedEvent = api.kind === 'v2'
                  ? normalizeOpenCodeV2Event(wireEventType, rawEvent.data)
                  : { type: wireEventType, properties: rawEvent.properties };
                const eventType = normalizedEvent.type;
                const eventLocation = rawEvent.location && typeof rawEvent.location === 'object' && !Array.isArray(rawEvent.location)
                  ? rawEvent.location as Record<string, unknown>
                  : null;
                const properties = normalizedEvent.properties;
                if (api.kind === 'v2' && (eventType === 'permission.asked' || eventType === 'question.asked')) {
                  rememberRequestSessions(
                    [properties],
                    eventType === 'permission.asked' ? permissionSessionByRequestId : questionSessionByRequestId,
                  );
                }
                if (api.kind === 'v2' && eventType === 'todo.updated' && properties && typeof properties === 'object' && !Array.isArray(properties)) {
                  const todoEvent = properties as Record<string, unknown>;
                  if (typeof todoEvent.sessionID === 'string' && Array.isArray(todoEvent.todos)) {
                    todosBySessionId.set(todoEvent.sessionID, todoEvent.todos);
                  }
                }
                const event: OpenCodeGlobalEvent = {
                  directory: api.kind === 'v2' && typeof eventLocation?.directory === 'string'
                    ? eventLocation.directory
                    : streamDirectory,
                  payload: {
                    type: eventType,
                    properties,
                  },
                };
                if (eventType === 'server.connected') {
                  providerConnectionBoundarySeen = true;
                  onEvent(event, {
                    provenance: 'connection-boundary',
                    connectionGeneration: currentConnectionGeneration,
                  });
                  return;
                }
                if (!providerConnectionBoundarySeen && !useDurableSessionStream) return;
                onEvent(event, {
                  provenance: 'accepted-live',
                  connectionGeneration: currentConnectionGeneration,
                });
              },
            });
            if (useDurableSessionStream) {
              let liveConnectionBoundarySeen = false;
              liveSubscription = await subscribeSseJson<unknown>({
                url: buildUrl(baseUrl, '/api/event'),
                headers: nextHeaders,
                signal: combinedAbort.signal,
                readIdleTimeoutMs,
                onMessage: (msg) => {
                  if (currentConnectionGeneration !== connectionGeneration) return;
                  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
                  const rawEvent = msg as Record<string, unknown>;
                  if (rawEvent.durable !== undefined) return;
                  const wireEventType = typeof rawEvent.type === 'string' ? rawEvent.type : '';
                  if (!wireEventType) return;
                  if (wireEventType === 'server.connected') {
                    liveConnectionBoundarySeen = true;
                    return;
                  }
                  if (!liveConnectionBoundarySeen) return;
                  const normalizedEvent = normalizeOpenCodeV2Event(wireEventType, rawEvent.data);
                  const eventType = normalizedEvent.type;
                  const properties = normalizedEvent.properties;
                  if (eventType === 'permission.asked' || eventType === 'question.asked') {
                    rememberRequestSessions(
                      [properties],
                      eventType === 'permission.asked' ? permissionSessionByRequestId : questionSessionByRequestId,
                    );
                  }
                  if (eventType === 'todo.updated' && properties && typeof properties === 'object' && !Array.isArray(properties)) {
                    const todoEvent = properties as Record<string, unknown>;
                    if (typeof todoEvent.sessionID === 'string' && Array.isArray(todoEvent.todos)) {
                      todosBySessionId.set(todoEvent.sessionID, todoEvent.todos);
                    }
                  }
                  const eventLocation = rawEvent.location && typeof rawEvent.location === 'object' && !Array.isArray(rawEvent.location)
                    ? rawEvent.location as Record<string, unknown>
                    : null;
                  onEvent({
                    directory: typeof eventLocation?.directory === 'string'
                      ? eventLocation.directory
                      : streamDirectory,
                    payload: { type: eventType, properties },
                  }, {
                    provenance: 'untrusted-observation',
                    connectionGeneration: currentConnectionGeneration,
                  });
                },
              });
              await Promise.race([subscription.done, liveSubscription.done]);
            } else {
              await subscription.done;
            }
            if (!disposed && !signal.aborted && !localAbort.signal.aborted) {
              await refreshTransportForSseReconnect();
            }
            attempt = 0;
          } catch (error) {
            if (disposed || signal.aborted || localAbort.signal.aborted) break;
            logger.debug(
              isOpenCodeSseReadIdleTimeoutError(error)
                ? '[OpenCodeServer] SSE read idle timeout; reconnecting stream (best-effort)'
                : '[OpenCodeServer] SSE stream ended; reconnecting (best-effort)',
              error,
            );
            await refreshTransportForSseReconnect();
            const delayMs = resolveSseReconnectDelayMs(attempt, env);
            attempt += 1;
            await sleepUntilOrAbort(delayMs, combinedAbort.signal);
          } finally {
            if (subscription) {
              try {
                subscription.close();
              } catch {
                // ignore
              }
            }
            if (liveSubscription) {
              try {
                liveSubscription.close();
              } catch {
                // ignore
              }
            }
            subscription = null;
            liveSubscription = null;
            signal.removeEventListener('abort', onAbort);
            localAbort.signal.removeEventListener('abort', onAbort);
          }
        }
      })();
    },
    getManagedServerIdentity: () => managedServerIdentity,
    dispose: async () => {
      disposed = true;
      if (subscriptionLoopAbort) {
        try {
          subscriptionLoopAbort.abort();
        } catch {
          // ignore
        }
      }
      if (subscription) {
        try {
          subscription.close();
          await subscription.done.catch(() => {});
        } catch {
          // ignore
        }
        subscription = null;
      }
      if (liveSubscription) {
        try {
          liveSubscription.close();
          await liveSubscription.done.catch(() => {});
        } catch {
          // ignore
        }
        liveSubscription = null;
      }
      if (subscriptionLoop) {
        try {
          await subscriptionLoop.catch(() => {});
        } catch {
          // ignore
        }
        subscriptionLoop = null;
      }
      subscriptionLoopAbort = null;
    },
  };

  return client;
}
