import { afterEach, describe, expect, it, vi } from 'vitest';

import { createOpenCodeServerRuntimeClient } from './client';

/**
 * Wire fixtures are pinned to released OpenCode v2.0.15
 * (github.com/anomalyco/opencode @ 6f3639d82ed0760091792189b78f8eeb44f699b1), derived from
 * `packages/protocol/openapi.json`, `packages/schema/src/**` and frames captured from the real
 * binary. Anything the release does not publish must not appear on the wire here.
 */
type Call = { path: string; method: string; search: string; body?: unknown };

function stubReleasedV2Server(
  handle: (call: Call, url: URL) => Response | undefined,
): { calls: Call[] } {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = {
      path: url.pathname,
      method: init?.method ?? 'GET',
      search: url.search,
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    };
    calls.push(call);
    // The release exposes `/api/info`; `/api/health` and `/global/health` do not exist.
    if (url.pathname === '/api/info') {
      return Response.json({ version: '2.0.15', pid: 4242, urls: ['http://127.0.0.1:9999'], paths: { tmp: '/tmp' } });
    }
    if (url.pathname === '/api/health' || url.pathname === '/global/health' || url.pathname === '/mcp') {
      return new Response('{}', { status: 404 });
    }
    return handle(call, url) ?? new Response(null, { status: 204 });
  }));
  return { calls };
}

async function makeReleasedV2Client(env: NodeJS.ProcessEnv = {}) {
  return await createOpenCodeServerRuntimeClient({
    directory: '/repo',
    messageBuffer: { push: () => {} } as never,
    env: { HAPPIER_OPENCODE_SERVER_URL: 'http://127.0.0.1:9999', ...env },
  });
}

describe('OpenCodeServerRuntimeClient released V2 contract', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('drives the released session lifecycle with released routes, payloads and envelopes', async () => {
    const session = { id: 'ses_1', location: { directory: '/repo' }, title: 'first' };
    const { calls } = stubReleasedV2Server((call, url) => {
      if (call.path === '/api/session' && call.method === 'POST') return Response.json({ data: session });
      if (call.path === '/api/session' && call.method === 'GET') {
        return url.searchParams.get('cursor') === 'page-2'
          ? Response.json({ data: [{ id: 'ses_2', location: { directory: '/repo' } }], cursor: {} })
          : Response.json({ data: [session], cursor: { next: 'page-2' } });
      }
      if (call.path === '/api/session/ses_1' && call.method === 'GET') return Response.json({ data: session });
      if (call.path === '/api/session/ses_1' && call.method === 'PATCH') return new Response(null, { status: 204 });
      if (call.path === '/api/session/ses_1/diff') return Response.json({ data: [{ file: 'a.ts', patch: '@@', additions: 1, deletions: 0, status: 'modified' }] });
      if (call.path === '/api/session/ses_1/fork') return Response.json({ data: { id: 'ses_forked', location: { directory: '/repo' } } });
      if (call.path === '/api/session/ses_1/compact') return Response.json({ data: { id: 'inb_1', type: 'compaction' } });
      if (call.path === '/api/session/ses_1/interrupt') return Response.json({ interrupted: true });
      if (call.path === '/api/model/default') return Response.json({ location: { directory: '/repo' }, data: { id: 'gpt-5', modelID: 'gpt-5', providerID: 'openai' } });
      return undefined;
    });

    const client = await makeReleasedV2Client();
    const ruleset = [{ permission: 'bash', pattern: '*', action: 'ask' }];

    await expect(client.sessionCreate({ permission: ruleset })).resolves.toEqual({ id: 'ses_1', directory: '/repo', title: 'first' });
    // `Permission.Rule` is `{ action, resource, effect }`; Happier's V1 ruleset shape is renamed here.
    expect(calls.find((c) => c.path === '/api/session' && c.method === 'POST')?.body).toEqual({
      location: { directory: '/repo' },
      permissions: [{ action: 'bash', resource: '*', effect: 'ask' }],
    });

    // `GET /api/session` returns the newest 50 by default, so every page must be followed.
    await expect(client.sessionList()).resolves.toEqual([
      { id: 'ses_1', directory: '/repo', title: 'first' },
      { id: 'ses_2', directory: '/repo' },
    ]);
    const listCalls = calls.filter((c) => c.path === '/api/session' && c.method === 'GET');
    expect(listCalls.map((c) => c.search)).toEqual(['?directory=%2Frepo&order=asc', '?cursor=page-2']);

    await client.sessionUpdate({ sessionId: 'ses_1', title: 'renamed', permission: ruleset });
    expect(calls.find((c) => c.path === '/api/session/ses_1' && c.method === 'PATCH')?.body).toEqual({
      title: 'renamed',
      permissions: [{ action: 'bash', resource: '*', effect: 'ask' }],
    });

    await expect(client.sessionDiff({ sessionId: 'ses_1', messageId: 'msg_u1' })).resolves.toHaveLength(1);
    expect(calls.find((c) => c.path === '/api/session/ses_1/diff')?.search).toBe('?from=msg_u1');

    await expect(client.sessionFork({ sessionId: 'ses_1', messageId: 'msg_u1' })).resolves.toEqual({ id: 'ses_forked', directory: '/repo' });
    expect(calls.find((c) => c.path === '/api/session/ses_1/fork')?.body).toEqual({ before: 'msg_u1' });

    // Manual compaction exists in the release; it is not "unavailable".
    await client.sessionSummarize({ sessionId: 'ses_1', model: { providerID: 'openai', modelID: 'gpt-5' }, auto: false });
    expect(calls.find((c) => c.path === '/api/session/ses_1/compact')?.body).toEqual({ delivery: 'steer' });

    await client.sessionAbort({ sessionId: 'ses_1' });
    // `session.interrupt` declares no payload and parses strictly.
    expect(calls.find((c) => c.path === '/api/session/ses_1/interrupt')?.body).toBeUndefined();

    await expect(client.globalConfigGet()).resolves.toEqual({ model: 'openai/gpt-5' });

    expect(calls.map((c) => c.path)).not.toContain('/api/session/ses_1/history');
    expect(calls.map((c) => c.path)).not.toContain('/session/ses_1/diff');
    expect(calls.map((c) => c.path)).not.toContain('/session/ses_1/fork');
    await client.dispose();
  });

  it('sends a flat released prompt payload and pages messages into anchored turns', async () => {
    const { calls } = stubReleasedV2Server((call, url) => {
      if (call.path === '/api/session/ses_1/message') {
        return url.searchParams.get('cursor') === 'next'
          ? Response.json({
            data: [{ id: 'msg_a1', type: 'assistant', time: { created: 3 }, agent: 'build', content: [{ type: 'text', id: 'prt_1', text: 'hi' }] }],
            cursor: {},
          })
          : Response.json({
            data: [{ id: 'msg_u1', type: 'user', time: { created: 1 }, text: 'hello' }],
            cursor: { next: 'next' },
          });
      }
      if (call.path === '/api/session/ses_1/prompt') return Response.json({ data: { id: 'msg_u2', type: 'user' } });
      return undefined;
    });

    const client = await makeReleasedV2Client();

    await client.sessionPromptAsync({
      sessionId: 'ses_1',
      messageId: 'msg_u2',
      parts: [
        { type: 'text', text: 'ship it' },
        { type: 'file', url: 'file:///repo/a.png', mime: 'image/png', filename: 'a.png' },
      ],
      model: { providerID: 'openai', modelID: 'gpt-5' },
      variant: 'high',
      agent: 'build',
      delivery: 'steer',
    });

    // `PromptInput` is flat: nesting it under `prompt` is rejected by the released schema.
    expect(calls.find((c) => c.path === '/api/session/ses_1/prompt')?.body).toEqual({
      id: 'msg_u2',
      text: 'ship it',
      files: [{ uri: 'file:///repo/a.png', name: 'a.png' }],
      delivery: 'steer',
    });
    expect(calls.find((c) => c.path === '/api/session/ses_1/agent')?.body).toEqual({ agent: 'build' });
    expect(calls.find((c) => c.path === '/api/session/ses_1/model')?.body).toEqual({
      model: { id: 'gpt-5', providerID: 'openai', variant: 'high' },
    });

    // Released assistant messages carry no parentID; the turn anchor is inferred across pages.
    const messages = await client.sessionMessagesList({ sessionId: 'ses_1' }) as Array<{ info: Record<string, unknown> }>;
    expect(messages.map((m) => m.info.id)).toEqual(['msg_u1', 'msg_a1']);
    expect(messages[1]!.info.parentID).toBe('msg_u1');
    await client.dispose();
  });

  it('answers permissions and forms through the released routes and payloads', async () => {
    const form = {
      id: 'frm_1',
      sessionID: 'ses_1',
      title: 'Configure',
      fields: [
        { key: 'region', type: 'string', title: 'Region', options: [{ value: 'eu-west', label: 'Europe' }] },
        { key: 'tags', type: 'multiselect', title: 'Tags', options: [{ value: 't1', label: 'One' }, { value: 't2', label: 'Two' }] },
        { key: 'telemetry', type: 'boolean', title: 'Telemetry', default: true, hidden: true },
      ],
    };
    const { calls } = stubReleasedV2Server((call) => {
      if (call.path === '/api/form') return Response.json({ location: { directory: '/repo' }, data: [form] });
      if (call.path === '/api/permission/request') {
        return Response.json({
          location: { directory: '/repo' },
          data: [{ id: 'per_1', sessionID: 'ses_1', action: 'bash', resources: ['git status'], save: ['git *'], source: { type: 'tool', messageID: 'msg_a1', id: 'call_1' } }],
        });
      }
      return undefined;
    });

    const client = await makeReleasedV2Client();

    // `Permission.Request` renames every field Happier reads, and its tool source uses `id`.
    await expect(client.permissionList()).resolves.toEqual([{
      id: 'per_1',
      sessionID: 'ses_1',
      permission: 'bash',
      patterns: ['git status'],
      always: ['git *'],
      metadata: {},
      tool: { messageID: 'msg_a1', callID: 'call_1' },
    }]);

    await expect(client.permissionReply({ requestId: 'per_1', reply: 'once' })).resolves.toBe(true);
    expect(calls.find((c) => c.path === '/api/session/ses_1/permission/per_1/reply')?.body).toEqual({ decision: 'once' });

    // Questions became forms: `/api/question/request` does not exist in the release.
    const questions = await client.questionList() as Array<{ id: string; questions: Array<Record<string, unknown>> }>;
    expect(calls.map((c) => c.path)).toContain('/api/form');
    expect(calls.map((c) => c.path)).not.toContain('/api/question/request');
    expect(questions[0]!.id).toBe('frm_1');
    // The hidden field is not asked; it still contributes its default to the reply.
    expect(questions[0]!.questions.map((q) => q.header)).toEqual(['Region', 'Tags']);

    await expect(client.questionReply({ requestId: 'frm_1', answers: [['Europe'], ['One', 'Two']] })).resolves.toBe(true);
    expect(calls.find((c) => c.path === '/api/session/ses_1/form/frm_1/reply')?.body).toEqual({
      answer: { telemetry: true, region: 'eu-west', tags: ['t1', 't2'] },
    });

    await expect(client.questionReject({ requestId: 'frm_1' })).resolves.toBe(true);
    // Cancelling is a DELETE; there is no `/reject` route.
    expect(calls).toContainEqual(expect.objectContaining({ path: '/api/session/ses_1/form/frm_1', method: 'DELETE' }));
    await client.dispose();
  });

  it('registers dynamic MCP through the released experimental route and reports real readiness', async () => {
    let status: Record<string, unknown> = { status: 'pending' };
    const { calls } = stubReleasedV2Server((call) => {
      if (call.path === '/api/experimental/mcp/happier') return new Response(null, { status: 204 });
      if (call.path === '/api/mcp') {
        const body = Response.json({ location: { directory: '/repo' }, data: [{ name: 'happier', status }] });
        status = { status: 'connected' };
        return body;
      }
      return undefined;
    });

    const client = await makeReleasedV2Client();
    // Dynamic MCP exists on a pure released V2 server; it must not be declared unavailable.
    await expect(client.mcpAdd({
      name: 'happier',
      config: { type: 'local', enabled: true, command: ['happier', 'mcp'], environment: { A: 'b' } },
    })).resolves.toEqual({ status: 'connected' });

    const put = calls.find((c) => c.path === '/api/experimental/mcp/happier');
    expect(put?.method).toBe('PUT');
    expect(put?.search).toBe('?location%5Bdirectory%5D=%2Frepo');
    // `Mcp.LocalConfig` has no `enabled`; a strict parse rejects the unknown key.
    expect(put?.body).toEqual({ config: { type: 'local', command: ['happier', 'mcp'], environment: { A: 'b' } } });
    await client.mcpDisconnect({ directory: '/repo/other', name: 'happier' });
    expect(calls).toContainEqual(expect.objectContaining({
      path: '/api/experimental/mcp/happier',
      method: 'DELETE',
      search: '?location%5Bdirectory%5D=%2Frepo%2Fother',
    }));
    expect(calls.map((c) => c.path)).not.toContain('/mcp');
    await client.dispose();
  });

  it('surfaces a released MCP failure status truthfully instead of reporting readiness', async () => {
    stubReleasedV2Server((call) => {
      if (call.path === '/api/experimental/mcp/happier') return new Response(null, { status: 204 });
      if (call.path === '/api/mcp') {
        return Response.json({ location: { directory: '/repo' }, data: [{ name: 'happier', status: { status: 'failed', error: 'spawn ENOENT' } }] });
      }
      return undefined;
    });

    const client = await makeReleasedV2Client();
    await expect(client.mcpAdd({ name: 'happier', config: { type: 'local', command: ['nope'] } }))
      .resolves.toEqual({ status: 'failed', error: 'spawn ENOENT' });
    await client.dispose();
  });

  it('translates the released global event vocabulary into the runtime vocabulary', async () => {
    // Frames captured from the real v2.0.15 binary. Durable-definition frames arrive here too:
    // `Bus` defaults to `persist: false`, so the durable log holds nothing and dropping frames
    // that carry `durable` would discard every terminal, text and tool event.
    const frames = [
      { id: 'evt_0', type: 'server.connected', data: {} },
      { id: 'evt_1', type: 'session.execution.started', durable: { aggregateID: 'ses_1', seq: 1, version: 1 }, data: { sessionID: 'ses_1' } },
      { id: 'evt_2', type: 'session.text.started', durable: { aggregateID: 'ses_1', seq: 2, version: 1 }, data: { sessionID: 'ses_1', assistantMessageID: 'msg_a1', ordinal: 0 }, location: { directory: '/repo' } },
      { id: 'evt_3', type: 'session.text.delta', data: { sessionID: 'ses_1', assistantMessageID: 'msg_a1', ordinal: 0, delta: 'hel' }, location: { directory: '/repo' } },
      { id: 'evt_4', type: 'session.reasoning.delta', data: { sessionID: 'ses_1', assistantMessageID: 'msg_a1', ordinal: 1, delta: 'thinking' }, location: { directory: '/repo' } },
      { id: 'evt_5', type: 'session.tool.success', durable: { aggregateID: 'ses_1', seq: 3, version: 2 }, data: { sessionID: 'ses_1', assistantMessageID: 'msg_a1', id: 'call_1', executed: true, content: [{ type: 'text', text: 'ok' }] }, location: { directory: '/repo' } },
      { id: 'evt_6', type: 'permission.asked', data: { id: 'per_1', sessionID: 'ses_1', action: 'bash', resources: ['git status'] }, location: { directory: '/repo' } },
      { id: 'evt_7', type: 'form.created', data: { form: { id: 'frm_1', sessionID: 'ses_1', title: 'Pick', fields: [{ key: 'k', type: 'string', title: 'K' }] } }, location: { directory: '/repo' } },
      { id: 'evt_8', type: 'session.execution.succeeded', durable: { aggregateID: 'ses_1', seq: 4, version: 1 }, data: { sessionID: 'ses_1' } },
    ];
    const { calls } = stubReleasedV2Server((call) => {
      if (call.path !== '/api/event') return undefined;
      const encoder = new TextEncoder();
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('')));
          controller.close();
        },
      }), { headers: { 'content-type': 'text/event-stream' } });
    });

    const client = await makeReleasedV2Client();
    const abort = new AbortController();
    const received: Array<{ type: string; properties: any; provenance: string }> = [];
    await client.subscribeGlobalEvents({
      sessionId: 'ses_1',
      signal: abort.signal,
      onEvent: (event, delivery) => {
        received.push({ type: event.payload.type, properties: event.payload.properties, provenance: delivery.provenance });
        if (event.payload.type === 'session.idle') abort.abort();
      },
    });
    await vi.waitFor(() => expect(received.map((e) => e.type)).toContain('session.idle'), { timeout: 8_000 });

    // The release has no per-session durable stream worth reading, and no `/history` page.
    expect(calls.map((c) => c.path)).toContain('/api/event');
    expect(calls.map((c) => c.path).some((p) => p.includes('/log'))).toBe(false);
    expect(calls.map((c) => c.path).some((p) => p.includes('/history'))).toBe(false);

    expect(received.map((e) => e.type)).toEqual([
      'server.connected',
      'session.status',
      'session.next.text.started',
      'message.part.delta',
      'message.part.delta',
      'session.next.tool.success',
      'permission.asked',
      'question.asked',
      'session.idle',
    ]);
    expect(received[0]!.provenance).toBe('connection-boundary');
    expect(received.slice(1).every((e) => e.provenance === 'accepted-live')).toBe(true);

    // V2 identifies a streamed part by (assistantMessageID, ordinal) and states the part kind so a
    // live delta never depends on the `*.started` frame having arrived first.
    expect(received[3]!.properties).toEqual({ sessionID: 'ses_1', messageID: 'msg_a1', partID: 'msg_a1:text:0', delta: 'hel', partType: 'text' });
    expect(received[4]!.properties).toEqual({ sessionID: 'ses_1', messageID: 'msg_a1', partID: 'msg_a1:reasoning:1', delta: 'thinking', partType: 'reasoning' });
    expect(received[1]!.properties).toEqual({ sessionID: 'ses_1', status: { type: 'busy' } });
    expect(received[5]!.properties).toMatchObject({ id: 'call_1', assistantMessageID: 'msg_a1' });
    expect(received[6]!.properties).toMatchObject({ id: 'per_1', permission: 'bash', patterns: ['git status'] });
    expect(received[7]!.properties).toMatchObject({ id: 'frm_1', sessionID: 'ses_1' });
    await client.dispose();
  });
});
