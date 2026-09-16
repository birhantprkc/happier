import { describe, expect, it, vi } from 'vitest';

import type { TerminalHostAdapter, TerminalHostHandle } from '@/integrations/terminalHost/_types';
import {
  resolveDisconnectedTerminalHostResumeGate,
  superviseDisconnectedTerminalHostCandidate,
} from './disconnectedTerminalHostSupervision';

const handle: TerminalHostHandle & { attachmentId: NonNullable<TerminalHostHandle['attachmentId']> } = {
  attachmentId: 'attachment-live-1' as NonNullable<TerminalHostHandle['attachmentId']>,
  kind: 'tmux',
  sessionName: 'happier-live-1',
  paneId: 'claude.1',
  attachMetadata: {
    attachStrategy: 'terminal_host',
    topology: 'shared',
    locality: 'same_machine',
    liveProbe: 'required',
  },
};

describe('disconnected terminal-host supervision', () => {
  it('requires explicit Stop before Resume when an exact preserved host is not controllable', () => {
    expect(resolveDisconnectedTerminalHostResumeGate({
      state: 'recoverable_unservable',
      reason: 'control_descriptor_missing',
    })).toEqual({
      action: 'fence',
      reason: 'control_descriptor_missing',
    });
    expect(resolveDisconnectedTerminalHostResumeGate({ state: 'servable' })).toEqual({ action: 'resume' });
    expect(resolveDisconnectedTerminalHostResumeGate({ state: 'stopped' })).toEqual({ action: 'resume' });
  });

  it('classifies a live bound provider host as running without mutating its attachment', async () => {
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(),
      injectUserPrompt: vi.fn(),
      interruptTurn: vi.fn(),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: 123 })),
      dispose: vi.fn(),
    };
    await expect(superviseDisconnectedTerminalHostCandidate({
      candidate: {
        sessionId: 'session-live-1',
        pid: 43214,
        happyHomeDir: '/tmp/happy',
        attachmentId: handle.attachmentId,
        handle,
        controlDescriptorStatus: 'not_applicable',
      },
      terminalHostAdapters: { tmux: adapter },
      readTerminalAttachmentInfo: async () => ({
        version: 2,
        attachmentId: handle.attachmentId,
        sessionId: 'session-live-1',
        handle,
        terminal: { mode: 'tmux', tmux: { target: 'happier-live-1:claude.1' } },
        updatedAt: 1,
      }),
      probeSessionServiceability: async () => ({ state: 'runner_present', control: { state: 'servable' } }),
    })).resolves.toEqual({ state: 'servable' });

    expect(adapter.dispose).not.toHaveBeenCalled();
  });

  it('classifies an alive host with unavailable exact-session controls as recoverable without mutation', async () => {
    const adapter: TerminalHostAdapter = {
      kind: 'tmux', createOrAttachHost: vi.fn(), injectUserPrompt: vi.fn(), interruptTurn: vi.fn(),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: 123 })), dispose: vi.fn(),
    };
    await expect(superviseDisconnectedTerminalHostCandidate({
      candidate: { sessionId: 'session-live-1', pid: 43214, happyHomeDir: '/tmp/happy', attachmentId: handle.attachmentId, handle, controlDescriptorStatus: 'available' },
      terminalHostAdapters: { tmux: adapter },
      readTerminalAttachmentInfo: async () => ({
        version: 2, attachmentId: handle.attachmentId, sessionId: 'session-live-1', handle,
        terminal: { mode: 'tmux', tmux: { target: 'happier-live-1:claude.1' } }, updatedAt: 1,
      }),
      probeSessionServiceability: async () => ({
        state: 'runner_present', control: { state: 'recoverable_unservable', reason: 'rpc_method_unavailable' },
      }),
    })).resolves.toEqual({ state: 'recoverable_unservable', reason: 'rpc_method_unavailable' });
    expect(adapter.dispose).not.toHaveBeenCalled();
  });

  it('classifies an exact alive host without its attachment-bound control descriptor as recoverable', async () => {
    const adapter: TerminalHostAdapter = {
      kind: 'tmux', createOrAttachHost: vi.fn(), injectUserPrompt: vi.fn(), interruptTurn: vi.fn(),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: 123 })), dispose: vi.fn(),
    };

    await expect(superviseDisconnectedTerminalHostCandidate({
      candidate: {
        sessionId: 'session-live-1',
        pid: 43214,
        happyHomeDir: '/tmp/happy',
        attachmentId: handle.attachmentId,
        handle,
        controlDescriptorStatus: 'missing',
      },
      terminalHostAdapters: { tmux: adapter },
      readTerminalAttachmentInfo: async () => ({
        version: 2, attachmentId: handle.attachmentId, sessionId: 'session-live-1', handle,
        terminal: { mode: 'tmux', tmux: { target: 'happier-live-1:claude.1' } }, updatedAt: 1,
      }),
      probeSessionServiceability: vi.fn(),
    })).resolves.toEqual({
      state: 'recoverable_unservable',
      reason: 'control_descriptor_missing',
    });
    expect(adapter.dispose).not.toHaveBeenCalled();
  });

  it('retains marker evidence after exact positive-dead retirement for awaited exact-turn staging', async () => {
    const calls: string[] = [];
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(),
      injectUserPrompt: vi.fn(),
      interruptTurn: vi.fn(),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: false, paneDead: true, observedAt: 123 })),
      dispose: vi.fn(async () => {}),
    };
    const attachmentInfo = {
      version: 2 as const,
      attachmentId: handle.attachmentId,
      sessionId: 'session-dead-1',
      handle,
      terminal: { mode: 'tmux' as const, tmux: { target: 'happier-live-1:claude.1' } },
      updatedAt: 1,
    };

    await expect(superviseDisconnectedTerminalHostCandidate({
      candidate: {
        sessionId: 'session-dead-1',
        pid: 43214,
        happyHomeDir: '/tmp/happy',
        attachmentId: handle.attachmentId,
        handle,
        controlDescriptorStatus: 'available',
      },
      terminalHostAdapters: { tmux: adapter },
      readTerminalAttachmentInfo: async () => attachmentInfo,
      removeTerminalAttachmentInfo: async () => {
        calls.push('local-descriptor');
        return true;
      },
      retireExactTerminalControlServiceability: async (input) => {
        calls.push('remote-serviceability');
        expect(input.attachmentInfo).toBe(attachmentInfo);
      },
      onExactTerminalAttachmentRetired: async (input) => {
        calls.push('provider');
        expect(input.attachmentInfo).toBe(attachmentInfo);
      },
    })).resolves.toEqual({ state: 'stopped' });

    expect(calls).toEqual(['remote-serviceability', 'local-descriptor', 'provider']);
  });

  it('retains exact local evidence when remote serviceability retirement fails', async () => {
    const removeTerminalAttachmentInfo = vi.fn(async () => true);
    const onExactTerminalAttachmentRetired = vi.fn(async () => undefined);
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(),
      injectUserPrompt: vi.fn(),
      interruptTurn: vi.fn(),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: false, paneDead: true, observedAt: 123 })),
      dispose: vi.fn(async () => {}),
    };

    await expect(superviseDisconnectedTerminalHostCandidate({
      candidate: {
        sessionId: 'session-dead-retirement-failed',
        pid: 43216,
        happyHomeDir: '/tmp/happy',
        attachmentId: handle.attachmentId,
        handle,
        controlDescriptorStatus: 'available',
      },
      terminalHostAdapters: { tmux: adapter },
      readTerminalAttachmentInfo: async () => ({
        version: 2,
        attachmentId: handle.attachmentId,
        sessionId: 'session-dead-retirement-failed',
        handle,
        terminal: { mode: 'tmux', tmux: { target: 'happier-live-1:claude.1' } },
        updatedAt: 1,
      }),
      removeTerminalAttachmentInfo,
      retireExactTerminalControlServiceability: async () => {
        throw new Error('metadata update failed');
      },
      onExactTerminalAttachmentRetired,
    })).resolves.toEqual({ state: 'unknown', reason: 'retirement_failed' });

    expect(removeTerminalAttachmentInfo).not.toHaveBeenCalled();
    expect(onExactTerminalAttachmentRetired).not.toHaveBeenCalled();
  });

  it('retains exact local evidence when remote serviceability retirement is superseded', async () => {
    const removeTerminalAttachmentInfo = vi.fn(async () => true);
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(),
      injectUserPrompt: vi.fn(),
      interruptTurn: vi.fn(),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: false, paneDead: true, observedAt: 123 })),
      dispose: vi.fn(async () => {}),
    };

    await expect(superviseDisconnectedTerminalHostCandidate({
      candidate: {
        sessionId: 'session-dead-retirement-superseded',
        pid: 43217,
        happyHomeDir: '/tmp/happy',
        attachmentId: handle.attachmentId,
        handle,
        controlDescriptorStatus: 'available',
      },
      terminalHostAdapters: { tmux: adapter },
      readTerminalAttachmentInfo: async () => ({
        version: 2,
        attachmentId: handle.attachmentId,
        sessionId: 'session-dead-retirement-superseded',
        handle,
        terminal: { mode: 'tmux', tmux: { target: 'happier-live-1:claude.1' } },
        updatedAt: 1,
      }),
      removeTerminalAttachmentInfo,
      retireExactTerminalControlServiceability: async () => 'superseded',
    })).resolves.toEqual({ state: 'unknown', reason: 'retirement_failed' });

    expect(removeTerminalAttachmentInfo).not.toHaveBeenCalled();
  });

  it('does not release marker evidence when provider cleanup fails after successful host retirement', async () => {
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(),
      injectUserPrompt: vi.fn(),
      interruptTurn: vi.fn(),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: false, paneDead: true, observedAt: 123 })),
      dispose: vi.fn(async () => {}),
    };
    await expect(superviseDisconnectedTerminalHostCandidate({
      candidate: {
        sessionId: 'session-dead-cleanup-failed',
        pid: 43215,
        happyHomeDir: '/tmp/happy',
        attachmentId: handle.attachmentId,
        handle,
        controlDescriptorStatus: 'available',
      },
      terminalHostAdapters: { tmux: adapter },
      readTerminalAttachmentInfo: async () => ({
        version: 2,
        attachmentId: handle.attachmentId,
        sessionId: 'session-dead-cleanup-failed',
        handle,
        terminal: { mode: 'tmux', tmux: { target: 'happier-live-1:claude.1' } },
        updatedAt: 1,
      }),
      removeTerminalAttachmentInfo: async () => true,
      onExactTerminalAttachmentRetired: async () => { throw new Error('provider cleanup failed'); },
    })).resolves.toEqual({ state: 'stopped' });
  });
});
