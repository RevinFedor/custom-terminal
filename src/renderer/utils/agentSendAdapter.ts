import type {
  AgentHistoryTool,
  AgentPtyStatus,
  AgentSendPromptOptions,
  AgentSendTarget,
  HistoryAgentRuntime,
} from './historyAgentRuntimes';
import { getAgentSendProviderContract } from './agentSendProviderContract';
import { prepareAgentRecordContext } from './agentRecordContextPreparation';
import {
  prepareAgentRuntimeForSend,
  proveAgentComposerForSend,
} from './agentSendPreparation';
import { normalizeAgentSendOutcome } from './agentSendOutcome.mjs';
import type { AgentSettingsIntent } from './agentSendSettingsContract';

type RecordContextInput = Omit<
  Parameters<typeof prepareAgentRecordContext>[0],
  'tabId' | 'runtime' | 'providerContract' | 'assertSendNotCancelled'
>;
type ReadyInput = Omit<
  Parameters<typeof prepareAgentRuntimeForSend>[0],
  'tabId' | 'runtime' | 'providerContract'
>;
type ComposerInput = Omit<
  Parameters<typeof proveAgentComposerForSend>[0],
  'tabId' | 'toolType' | 'runtime' | 'providerContract' | 'assertSendNotCancelled'
>;

export interface AgentProviderOperationInput {
  prompt: string;
  handoffId?: string;
  sendAttemptId?: string | null;
  sendOperationKey?: string | null;
  source?: string;
  promptQueueAction?: 'send-now';
  statusForSend: AgentPtyStatus;
  submitCapability: 'direct' | 'queue';
  settingsIntent: AgentSettingsIntent;
  runtimeSnapshot?: unknown;
  expectedTarget?: AgentSendTarget;
  composer?: {
    exactEmptyEvidence?: Record<string, unknown> | null;
    refreshExactEmptyEvidence?: AgentSendPromptOptions['refreshClaudeExactEmptyEvidence'];
  };
  presentationSnapshot?: AgentSendPromptOptions['presentationSnapshot'];
}

export interface AgentSendAdapter {
  provider: AgentHistoryTool;
  prepareRecordContext(input: RecordContextInput): ReturnType<typeof prepareAgentRecordContext>;
  ensureReady(input: ReadyInput): ReturnType<typeof prepareAgentRuntimeForSend>;
  proveComposer(input: ComposerInput): ReturnType<typeof proveAgentComposerForSend>;
  /**
   * One provider-owned atomic operation:
   * settings proof → post-mutation composer proof → physical Enter → provider
   * audit. It may return audit-pending/unknown; only main receipts own durable
   * confirmation across renderer restart.
   */
  runProviderOperation(input: AgentProviderOperationInput): Promise<any>;
}

/**
 * Compatibility adapter over the existing Claude/Codex runtimes.
 *
 * Product code calls only these four operations. Provider-specific startup
 * gates, exact draft proof, settings/picker mechanics and transport result
 * shapes stay behind this boundary. Low-level PTY/main primitives are not
 * moved or duplicated here.
 */
export function createAgentSendAdapter({
  tabId,
  toolType,
  runtime,
  assertSendNotCancelled,
}: {
  tabId: string;
  toolType: AgentHistoryTool;
  runtime: HistoryAgentRuntime;
  assertSendNotCancelled: () => void;
}): AgentSendAdapter {
  const contract = getAgentSendProviderContract(toolType, runtime);
  return {
    provider: contract.toolType,
    prepareRecordContext: (input) => prepareAgentRecordContext({
      ...input,
      tabId,
      runtime,
      providerContract: contract,
      assertSendNotCancelled,
    }),
    ensureReady: (input) => prepareAgentRuntimeForSend({
      ...input,
      tabId,
      runtime,
      providerContract: contract,
    }),
    proveComposer: (input) => proveAgentComposerForSend({
      ...input,
      tabId,
      toolType: contract.toolType,
      runtime,
      providerContract: contract,
      assertSendNotCancelled,
    }),
    async runProviderOperation(input) {
      assertSendNotCancelled();
      const explicitSettings = input.settingsIntent.kind === 'explicit-change'
        ? input.settingsIntent
        : null;
      const options: AgentSendPromptOptions = {
        handoffId: typeof input.handoffId === 'string' ? input.handoffId : undefined,
        sendAttemptId: typeof input.sendAttemptId === 'string' ? input.sendAttemptId : undefined,
        sendOperationKey: typeof input.sendOperationKey === 'string' ? input.sendOperationKey : undefined,
        source: typeof input.source === 'string' ? input.source : 'mobile-native',
        promptQueueAction: input.promptQueueAction,
        statusAtSend: input.statusForSend as AgentPtyStatus,
        queue: input.submitCapability === 'queue',
        model: explicitSettings?.model,
        effort: explicitSettings?.effort,
        thinking: explicitSettings?.thinking,
        runtimeSnapshot: input.runtimeSnapshot,
        expectedTarget: input.expectedTarget,
        claudeExactEmptyEvidence: input.composer?.exactEmptyEvidence,
        refreshClaudeExactEmptyEvidence: input.composer?.refreshExactEmptyEvidence,
        presentationSnapshot: input.presentationSnapshot,
        ...(contract.passCancellationGuardToTransport
          ? { assertNotCancelled: assertSendNotCancelled }
          : {}),
      };
      const result = await runtime.sendPrompt(tabId, input.prompt, options);
      return {
        ...(result || {}),
        deliveryOutcome: normalizeAgentSendOutcome(result),
      };
    },
  };
}
