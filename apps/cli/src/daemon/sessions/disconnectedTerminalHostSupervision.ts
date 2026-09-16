import type { TerminalHostAdapter, TerminalHostHandle } from '@/integrations/terminalHost/_types';
import { evaluateTerminalHostLivenessForRecovery } from '@/integrations/terminalHost/livenessPolicy';
import {
  readTerminalAttachmentInfo as readDefaultTerminalAttachmentInfo,
  removeTerminalAttachmentInfo as removeDefaultTerminalAttachmentInfo,
  type BoundTerminalAttachmentInfo,
  type TerminalAttachmentInfo,
} from '@/terminal/attachment/terminalAttachmentInfo';
import { notifyTerminalAttachmentRetiredThroughCatalog } from '@/backends/catalog';
import { logger } from '@/ui/logger';
import { executeTerminalHostDisposition } from '@/terminal/attachment/terminalHostDisposition';
import type { SessionRunnerServiceabilityProbe } from './isSessionRunnerActive';
import type { TerminalAttachmentControlDescriptorStatus } from '@/backends/types';
import {
  requireExactTerminalControlServiceabilityRetirement,
  type ExactTerminalControlServiceabilityRetirement,
} from './retireTerminalControlServiceability';

export type DisconnectedTerminalHostCandidate = Readonly<{
  sessionId: string;
  pid: number;
  activeTurnId?: string;
  happyHomeDir: string;
  attachmentId: NonNullable<TerminalHostHandle['attachmentId']>;
  handle: TerminalHostHandle & Readonly<{ attachmentId: NonNullable<TerminalHostHandle['attachmentId']> }>;
  /** Provider applicability and exact descriptor proof, distinct from immutable host identity. */
  controlDescriptorStatus: TerminalAttachmentControlDescriptorStatus;
}>;

export type DisconnectedTerminalHostSupervisionResult =
  | Readonly<{ state: 'servable' }>
  | Readonly<{ state: 'recoverable_unservable'; reason: string }>
  | Readonly<{ state: 'stopped' }>
  | Readonly<{ state: 'unknown'; reason: 'attachment_changed' | 'adapter_unavailable' | 'probe_inconclusive' | 'retirement_failed' }>;

export type DisconnectedTerminalHostResumeGate =
  | Readonly<{ action: 'resume' }>
  | Readonly<{ action: 'fence'; reason: string }>;

export function resolveDisconnectedTerminalHostResumeGate(
  result: DisconnectedTerminalHostSupervisionResult,
): DisconnectedTerminalHostResumeGate {
  return result.state === 'stopped' || result.state === 'servable'
    ? { action: 'resume' }
    : { action: 'fence', reason: result.reason };
}

type TerminalHostAdapters = Readonly<Partial<Record<TerminalHostAdapter['kind'], TerminalHostAdapter>>>;

export async function superviseDisconnectedTerminalHostCandidate(input: Readonly<{
  candidate: DisconnectedTerminalHostCandidate;
  terminalHostAdapters: TerminalHostAdapters;
  readTerminalAttachmentInfo?: (input: Readonly<{ happyHomeDir: string; sessionId: string }>) => Promise<TerminalAttachmentInfo | null>;
  removeTerminalAttachmentInfo?: typeof removeDefaultTerminalAttachmentInfo;
  probeSessionServiceability?: (sessionId: string) => Promise<SessionRunnerServiceabilityProbe>;
  onExactTerminalAttachmentRetired?: (input: Readonly<{
    happyHomeDir: string;
    sessionId: string;
    attachmentInfo: BoundTerminalAttachmentInfo;
  }>) => Promise<void>;
  retireExactTerminalControlServiceability?: (input: Readonly<{
    happyHomeDir: string;
    sessionId: string;
    attachmentInfo: BoundTerminalAttachmentInfo;
  }>) => Promise<ExactTerminalControlServiceabilityRetirement | void>;
}>): Promise<DisconnectedTerminalHostSupervisionResult> {
  const readAttachment = input.readTerminalAttachmentInfo ?? readDefaultTerminalAttachmentInfo;
  const current = await readAttachment({
    happyHomeDir: input.candidate.happyHomeDir,
    sessionId: input.candidate.sessionId,
  });
  if (
    current?.version !== 2
    || current.attachmentId !== input.candidate.attachmentId
    || current.handle.attachmentId !== input.candidate.attachmentId
  ) {
    return { state: 'unknown', reason: 'attachment_changed' };
  }

  const adapter = input.terminalHostAdapters[current.handle.kind];
  if (!adapter) return { state: 'unknown', reason: 'adapter_unavailable' };

  const probe = await evaluateTerminalHostLivenessForRecovery(adapter, current.handle);
  if (probe.status === 'alive') {
    if (input.candidate.controlDescriptorStatus === 'missing') {
      return { state: 'recoverable_unservable', reason: 'control_descriptor_missing' };
    }
    if (!input.probeSessionServiceability) return { state: 'unknown', reason: 'probe_inconclusive' };
    const serviceability = await input.probeSessionServiceability(input.candidate.sessionId);
    if (serviceability.state === 'runner_absent') {
      return { state: 'recoverable_unservable', reason: 'runner_absent' };
    }
    if (serviceability.state === 'runner_unknown') {
      return { state: 'unknown', reason: 'probe_inconclusive' };
    }
    if (serviceability.control.state === 'servable') return { state: 'servable' };
    if (serviceability.control.state === 'recoverable_unservable') {
      return { state: 'recoverable_unservable', reason: serviceability.control.reason };
    }
    return { state: 'unknown', reason: 'probe_inconclusive' };
  }
  if (probe.status === 'inconclusive') return { state: 'unknown', reason: 'probe_inconclusive' };

  const disposition = await executeTerminalHostDisposition({
    happyHomeDir: input.candidate.happyHomeDir,
    sessionId: input.candidate.sessionId,
    expectedAttachmentId: input.candidate.attachmentId,
    intent: { kind: 'retire_confirmed_dead_attachment', reason: 'positive_dead_recovery' },
    adapter,
    readAttachmentInfo: readAttachment,
    removeAttachmentInfo: input.removeTerminalAttachmentInfo ?? removeDefaultTerminalAttachmentInfo,
    beforeDescriptorRetirement: input.retireExactTerminalControlServiceability
      ? async ({ attachmentInfo }) => {
          try {
            const retirement = await input.retireExactTerminalControlServiceability!({
              happyHomeDir: input.candidate.happyHomeDir,
              sessionId: input.candidate.sessionId,
              attachmentInfo,
            });
            requireExactTerminalControlServiceabilityRetirement(retirement);
          } catch (error) {
            logger.debug('[DAEMON RUN] Confirmed-dead terminal host retained for serviceability retirement retry', {
              sessionId: input.candidate.sessionId,
              attachmentId: input.candidate.attachmentId,
              error,
            });
            throw error;
          }
        }
      : undefined,
  });
  if (disposition.status !== 'retired') return { state: 'unknown', reason: 'retirement_failed' };
  try {
    await (input.onExactTerminalAttachmentRetired ?? notifyTerminalAttachmentRetiredThroughCatalog)({
      happyHomeDir: input.candidate.happyHomeDir,
      sessionId: input.candidate.sessionId,
      attachmentInfo: current,
    });
  } catch (error) {
    logger.debug('[DAEMON RUN] Terminal host retired but provider cleanup remains pending', {
      sessionId: input.candidate.sessionId,
      attachmentId: input.candidate.attachmentId,
      error,
    });
  }
  return { state: 'stopped' };
}
