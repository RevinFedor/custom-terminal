import React, { memo, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import {
  FAMILY_LABELS,
  classifyHistoryAction,
  historyActionHeadline,
  historyActionPresentationMeta,
} from '../../../shared/history-action-grammar.mjs';
import {
  buildHistoryDisplayUnits,
  groupFamilyBreakdown,
  isGroupUnit,
} from '../../utils/historyDisplayUnits.mjs';
import {
  BrainIcon,
  ChatMessage,
  ColoredToolIcon,
  ComposerChip,
  defaultOpenForTool,
  ThinkBlock,
  ToolCallPart,
  toolIcon,
} from '@noted/claude-blocks';

export interface HistoryPresentationFact {
  toolUseId?: string;
  toolName?: string;
  family?: string;
  bashWord?: string;
  bashDetail?: string;
  mcpServer?: string;
  mcpMethod?: string;
  subject?: string;
  targetKey?: string;
  targetLabel?: string;
  operationLabel?: string;
  aggregateKey?: string;
  docsKind?: string;
  isError?: boolean;
  inFlight?: boolean;
}

export interface HistoryPresentationGroup {
  key: string;
  level?: number;
  familyKey: string;
  docsKind?: string;
  entries: Array<any>;
  captionEntry?: any | null;
  facts: HistoryPresentationFact[];
  errorCount: number;
  thinkingSeconds?: number;
  expanded?: boolean;
  parentGroup?: {
    key: string;
    familyKey: string;
    uniform?: boolean;
    first: boolean;
    last: boolean;
  };
}

type HistoryGroupHeaderSegment = {
  key: string;
  label: string;
  ariaLabel?: string;
  qualifier?: string;
  count: number;
  errorCount?: number;
  docsKind?: string;
  docsAccent?: boolean;
  icon?: 'thinking';
};

type HistoryGroupHeaderData = {
  segments: HistoryGroupHeaderSegment[];
  digest: string;
};

const HISTORY_INNER_NAMES_MAX_CHARS = 70;
const historyFactFamily = (fact: HistoryPresentationFact): string => String(fact.family || 'other');
const historyFactErrorCount = (
  facts: HistoryPresentationFact[],
  matches: (fact: HistoryPresentationFact) => boolean,
): number => facts.reduce(
  (sum, fact) => sum + (fact.isError === true && matches(fact) ? 1 : 0),
  0,
);
const historyGroupSegmentCounts = (segment: HistoryGroupHeaderSegment) => {
  const count = Math.max(1, Number(segment.count) || 0);
  const errorCount = Math.min(count, Math.max(0, Number(segment.errorCount) || 0));
  return { successCount: count - errorCount, errorCount };
};
const historyGroupFamilyLabel = (family: string): string => (
  (FAMILY_LABELS as Record<string, string>)[family]
  || (FAMILY_LABELS as Record<string, string>).other
  || 'Tool'
);

const historyGroupTargetLabels = (facts: HistoryPresentationFact[], family: string): string[] => {
  const items: Array<{ key: string; label: string }> = [];
  const seen = new Set<string>();
  for (const fact of facts) {
    const operation = String(fact.operationLabel || fact.mcpMethod || fact.subject || '');
    const target = String(fact.targetKey || '');
    const key = family === 'mcp' || family === 'run' || family === 'git'
      ? (operation || fact.toolUseId || '')
      : (target || fact.targetLabel || operation || fact.toolUseId || '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const label = family === 'mcp'
      ? operation.replace(/_/g, ' ')
      : String(fact.targetLabel || operation || target);
    items.push({ key, label });
  }
  const labels: string[] = [];
  const seenLabels = new Set<string>();
  for (const item of items) {
    if (!item.label || seenLabels.has(item.label)) continue;
    seenLabels.add(item.label);
    labels.push(item.label);
  }
  return labels;
};

const historyInnerGroupHeaderData = (group: HistoryPresentationGroup): HistoryGroupHeaderData => {
  const family = String(group.familyKey || group.facts?.[0]?.family || 'run');
  const targets = historyGroupTargetLabels(group.facts || [], family);
  const joined = targets.join(', ');
  const showNames = targets.length > 0 && targets.length <= 3
    && joined.length <= HISTORY_INNER_NAMES_MAX_CHARS
    && !(family === 'mcp' && (group.facts?.length || 0) > 3);
  const count = Math.max(1, group.facts?.length || 0);
  const errorCount = Math.min(
    count,
    Math.max(0, Number(group.errorCount) || historyFactErrorCount(group.facts || [], () => true)),
  );
  const docsKind = String(group.docsKind || '');
  if (family === 'mcp') {
    const server = String(group.facts?.[0]?.mcpServer || 'mcp').replace(/_/g, ' ');
    return {
      segments: [{
        key: `mcp:${server}:${docsKind || 'regular'}`,
        label: 'MCP',
        qualifier: server.toLowerCase() === 'mcp' ? undefined : server,
        count,
        errorCount,
        docsKind,
      }],
      digest: '',
    };
  }
  return {
    segments: [{
      key: `${family}:${docsKind || 'regular'}`,
      label: historyGroupFamilyLabel(family),
      qualifier: showNames && (family === 'read' || family === 'search' || family === 'edit')
        ? joined
        : undefined,
      count,
      errorCount,
      docsKind,
      docsAccent: !!docsKind && (family === 'read' || family === 'search' || family === 'edit'),
    }],
    digest: '',
  };
};

const historyGroupHeaderData = (group: HistoryPresentationGroup): HistoryGroupHeaderData => {
  const breakdown = groupFamilyBreakdown(group.facts);
  const segments: HistoryGroupHeaderSegment[] = [];
  for (let bucketIndex = 0; bucketIndex < breakdown.length; bucketIndex += 1) {
    const bucket = breakdown[bucketIndex];
    if (bucket.family === 'mcp') {
      const servers: Array<[string, number]> = Array.from(
        bucket.words.entries() as Iterable<[string, number]>,
      );
      if (servers.length === 0) servers.push(['mcp', bucket.count]);
      for (let serverIndex = 0; serverIndex < servers.length; serverIndex += 1) {
        const [rawServer, count] = servers[serverIndex];
        const server = String(rawServer || 'mcp').replace(/_/g, ' ');
        const errorCount = historyFactErrorCount(group.facts || [], (fact) => (
          historyFactFamily(fact) === 'mcp'
          && String(fact.mcpServer || 'mcp') === String(rawServer || 'mcp')
        ));
        segments.push({
          key: `mcp:${bucket.docsKind || 'regular'}:${serverIndex}:${server}`,
          label: 'MCP',
          qualifier: server.toLowerCase() === 'mcp' ? undefined : server,
          count: Math.max(1, Number(count) || 0),
          errorCount,
          docsKind: bucket.docsKind || '',
        });
      }
      continue;
    }
    segments.push({
      key: `${bucket.family}:${bucket.docsKind || 'regular'}:${bucketIndex}`,
      label: historyGroupFamilyLabel(bucket.family),
      count: Math.max(1, Number(bucket.count) || 0),
      errorCount: historyFactErrorCount(
        group.facts || [],
        (fact) => historyFactFamily(fact) === bucket.family,
      ),
      docsKind: bucket.docsKind || '',
      docsAccent: !!bucket.docsKind
        && (bucket.family === 'read' || bucket.family === 'search' || bucket.family === 'edit'),
    });
  }

  const thinkingCount = group.entries.reduce(
    (sum, entry) => sum + ((entry?.thinking || entry?.hasThinking === true) ? 1 : 0),
    0,
  );
  if (thinkingCount > 0) {
    segments.push({
      key: 'thinking', label: '', ariaLabel: 'Thinking', count: thinkingCount, icon: 'thinking',
    });
  }
  if (segments.length === 0) {
    segments.push({
      key: 'work',
      label: 'Work',
      count: Math.max(1, group.entries.length),
      errorCount: group.errorCount,
    });
  }
  if (breakdown.length === 1) {
    const bucket = breakdown[0];
    const parts = bucket.subjects.length > 0
      ? bucket.subjects
      : Array.from(bucket.words.entries()).map(([word, n]) => (n > 1 ? `${word} ×${n}` : word));
    return { segments, digest: parts.join(', ') };
  }
  return { segments, digest: '' };
};

const historyGroupHeaderText = (segments: HistoryGroupHeaderSegment[]): string => (
  segments.map((segment) => {
    const { successCount, errorCount } = historyGroupSegmentCounts(segment);
    return [
      segment.ariaLabel || segment.label,
      segment.qualifier,
      successCount > 0 ? `×${successCount}` : '',
      errorCount > 0 ? `errors ×${errorCount}` : '',
    ].filter(Boolean).join(' ');
  }).join(' · ')
);

/** Presentation-only group header shared by the primary History and nested
 * subagent transcripts. It owns no scroll, persistence or virtualization. */
export const HistoryCollapsedGroupRow = memo(({
  group,
  expanded,
  liveBackgroundUuids = new Set<string>(),
  isTurnBusy = false,
  onToggle,
}: {
  group: HistoryPresentationGroup;
  expanded: boolean;
  liveBackgroundUuids?: ReadonlySet<string>;
  isTurnBusy?: boolean;
  isLastUnit?: boolean;
  onToggle: () => void;
}) => {
  const live = (isTurnBusy && group.facts.some((fact) => fact.inFlight === true))
    || group.entries.some((entry) => liveBackgroundUuids.has(entry.uuid));
  const inner = group.level === 2;
  const { segments, digest } = inner
    ? historyInnerGroupHeaderData(group)
    : historyGroupHeaderData(group);
  const headerText = historyGroupHeaderText(segments);
  const caption = group.captionEntry && typeof group.captionEntry.content === 'string'
    ? group.captionEntry.content.trim()
    : '';
  return (
    <div
      className={`hp-history-group${inner ? ' hp-history-group--inner' : ''}`}
      data-history-group-live={live ? '1' : undefined}
      data-history-group-level={inner ? '2' : '1'}
      data-history-docs-kind={group.docsKind || undefined}
    >
      <div className="hp-history-group-head">
        <div
          className="hp-history-group-head-inner"
          role="button"
          tabIndex={0}
          aria-expanded={expanded}
          onClick={onToggle}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              onToggle();
            }
          }}
        >
          <ColoredToolIcon
            icon={inner
              ? toolIcon(group.facts[0]?.toolName || 'Bash', 13, group.familyKey)
              : toolIcon('Bash', 13, 'group')}
            status={live && !expanded ? 'running' : 'done'}
          />
          <span className="hp-history-group-count" aria-label={headerText}>
            {segments.map((segment, index) => {
              const { successCount, errorCount } = historyGroupSegmentCounts(segment);
              return (
                <React.Fragment key={segment.key}>
                  {index > 0 && <span className="hp-history-group-separator"> · </span>}
                  <span className={`hp-history-group-token${segment.docsAccent ? ` hp-history-group-token--docs-${segment.docsKind}` : ''}`}>
                    {segment.icon === 'thinking'
                      ? <BrainIcon size={13} className="cb-think-ic hp-history-group-thinking-icon" />
                      : <span className="hp-history-group-token-label">{segment.label}</span>}
                    {segment.qualifier && (
                      <span className="hp-history-group-token-qualifier"> {segment.qualifier}</span>
                    )}
                    {successCount > 0 && (
                      <span className="hp-history-group-token-count"> {' '}×{successCount}</span>
                    )}
                    {errorCount > 0 && (
                      <span className="hp-history-group-token-count hp-history-group-token-count--error">
                        {' '}×{errorCount}
                      </span>
                    )}
                  </span>
                </React.Fragment>
              );
            })}
          </span>
          {expanded
            ? <ChevronDown size={11} style={{ color: '#6f6d68', flexShrink: 0 }} />
            : <ChevronRight size={11} style={{ color: '#6f6d68', flexShrink: 0 }} />}
        </div>
      </div>
      {!expanded && (caption || digest) && (
        <div className="hp-history-group-detail">
          <span aria-hidden style={{ flexShrink: 0 }}>└</span>
          <span>{caption || digest}</span>
        </div>
      )}
    </div>
  );
});

function setHistoryGroupRailHighlight(source: HTMLElement, groupKey: string, highlighted: boolean) {
  const transcript = source.closest<HTMLElement>('.hp-history-transcript, .hp-history-nested-transcript');
  if (!transcript) return;
  const members = transcript.querySelectorAll<HTMLElement>(
    '[data-history-group-member], [data-history-subgroup-member]',
  );
  for (const member of members) {
    const ownsGroup = member.getAttribute('data-history-group-member') === groupKey
      || member.getAttribute('data-history-subgroup-member') === groupKey;
    if (!ownsGroup) continue;
    if (highlighted) member.setAttribute('data-history-group-rail-hot', '1');
    else member.removeAttribute('data-history-group-rail-hot');
  }
}

function isHistoryGroupRailTarget(target: EventTarget | null, groupKey: string) {
  if (!(target instanceof Element)) return false;
  const control = target.closest<HTMLElement>('[data-history-group-rail], [data-history-group-foot]');
  return control?.getAttribute('data-history-group-rail') === groupKey
    || control?.getAttribute('data-history-group-foot') === groupKey;
}

export const HistoryGroupFoot = ({
  groupKey,
  onCollapse,
  title = 'Свернуть блок',
}: {
  groupKey: string;
  onCollapse: (groupKey: string, source?: 'foot' | 'rail') => void;
  title?: string;
}) => (
  <button
    type="button"
    className="hp-history-group-foot"
    data-history-group-foot={groupKey}
    aria-label={title}
    title={title}
    onPointerEnter={(event) => setHistoryGroupRailHighlight(event.currentTarget, groupKey, true)}
    onPointerLeave={(event) => {
      if (!isHistoryGroupRailTarget(event.relatedTarget, groupKey)) {
        setHistoryGroupRailHighlight(event.currentTarget, groupKey, false);
      }
    }}
    onFocus={(event) => setHistoryGroupRailHighlight(event.currentTarget, groupKey, true)}
    onBlur={(event) => {
      if (!isHistoryGroupRailTarget(event.relatedTarget, groupKey)) {
        setHistoryGroupRailHighlight(event.currentTarget, groupKey, false);
      }
    }}
    onClick={() => onCollapse(groupKey, 'foot')}
  >
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden focusable="false">
      <path d="M7 0 V6" fill="none" stroke="currentColor" strokeWidth="1" />
      <path d="M11 10 L7 6 L3 10" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  </button>
);

export const HistoryGroupRail = ({
  groupKey,
  onCollapse,
  title = 'Свернуть блок',
  nested = false,
}: {
  groupKey: string;
  onCollapse: (groupKey: string, source?: 'foot' | 'rail') => void;
  title?: string;
  nested?: boolean;
}) => (
  <button
    type="button"
    className="hp-history-group-rail-control"
    data-history-group-rail={groupKey}
    data-history-group-rail-level={nested ? 'inner' : 'outer'}
    aria-label={title}
    title={title}
    tabIndex={-1}
    onPointerEnter={(event) => setHistoryGroupRailHighlight(event.currentTarget, groupKey, true)}
    onPointerLeave={(event) => {
      if (!isHistoryGroupRailTarget(event.relatedTarget, groupKey)) {
        setHistoryGroupRailHighlight(event.currentTarget, groupKey, false);
      }
    }}
    onMouseDown={(event) => {
      event.preventDefault();
      event.stopPropagation();
    }}
    onClick={(event) => {
      event.preventDefault();
      event.stopPropagation();
      onCollapse(groupKey, 'rail');
    }}
  />
);

export interface HistoryTranscriptStep {
  id?: string;
  messageId?: string;
  kind: 'tool' | 'message' | 'thinking' | 'instruction' | 'boundary';
  role?: 'user' | 'assistant';
  text: string;
  timestamp?: string;
  sessionId?: string;
  phase?: string;
  turnId?: string;
  instructionFileName?: string;
  instructionScope?: string;
  tool?: string;
  args?: Record<string, any>;
  argsRef?: { payloadId: string; totalChars: number };
  result?: string;
  resultRef?: { payloadId: string; totalChars: number };
  family?: string;
  bashWord?: string;
  bashDetail?: string;
  mcpServer?: string;
  mcpMethod?: string;
  isError?: boolean;
  final?: boolean;
}

/** Incremental child readers emit a tool twice: once at call time and once
 * with the result. Stable ids update that existing visual row instead of
 * appending a second card. */
export function mergeHistoryTranscriptSteps(
  current: HistoryTranscriptStep[],
  incoming: HistoryTranscriptStep[],
  limit = 400,
): HistoryTranscriptStep[] {
  if (incoming.length === 0) return current;
  const next = [...current];
  const indexById = new Map<string, number>();
  next.forEach((step, index) => {
    if (step.id) indexById.set(step.id, index);
  });
  for (const step of incoming) {
    const id = String(step.id || '');
    const existingIndex = id ? indexById.get(id) : undefined;
    if (existingIndex !== undefined) {
      next[existingIndex] = { ...next[existingIndex], ...step };
      continue;
    }
    if (id) indexById.set(id, next.length);
    next.push(step);
  }
  return next.length > limit ? next.slice(next.length - limit) : next;
}

export interface HistoryTranscriptTurn {
  type: string;
  content?: string;
  tools?: string[];
}

/** Compatibility adapter for the compact TaskAction.history shape emitted by
 * older Claude parsers. New live readers already emit HistoryTranscriptStep;
 * both paths meet at the same visual component instead of maintaining a
 * second hand-written subagent renderer. */
export function historyTurnsToTranscriptSteps(turns: HistoryTranscriptTurn[] = []): HistoryTranscriptStep[] {
  const steps: HistoryTranscriptStep[] = [];
  turns.forEach((turn, turnIndex) => {
    if (turn.content) {
      steps.push({
        id: `turn-${turnIndex}-message`,
        kind: 'message',
        role: turn.type === 'user' ? 'user' : 'assistant',
        text: turn.content,
      });
    }
    (turn.tools || []).forEach((toolName, toolIndex) => {
      steps.push({
        id: `turn-${turnIndex}-tool-${toolIndex}`,
        kind: 'tool',
        tool: String(toolName || 'Tool'),
        text: '',
      });
    });
  });
  return steps;
}

const transcriptStepsToEntries = (steps: HistoryTranscriptStep[]) => steps.map((step, index) => {
  const uuid = step.id || `subagent-step-${index}`;
  if (step.kind === 'boundary') {
    return { uuid, role: 'boundary', content: '', actions: [], transcriptStep: step };
  }
  if (step.kind === 'instruction') {
    return {
      uuid,
      role: 'attachment',
      content: '',
      actions: [],
      transcriptStep: step,
    };
  }
  if (step.kind === 'thinking') {
    return { uuid, role: 'assistant', content: '', thinking: step.text, hasThinking: true, actions: [], transcriptStep: step };
  }
  if (step.kind === 'message') {
    return {
      uuid,
      role: step.role === 'user' ? 'user' : 'assistant',
      content: step.text,
      timestamp: step.timestamp,
      sessionId: step.sessionId,
      messageId: step.messageId,
      phase: step.phase,
      textPhase: step.phase || (step.final ? 'final_answer' : undefined),
      turnId: step.turnId,
      actions: [],
      transcriptStep: step,
    };
  }
  const toolName = String(step.tool || 'Tool');
  const args = step.args || (step.text ? { summary: step.text } : {});
  const classified = classifyHistoryAction({
    toolName,
    args,
    mcpServer: step.mcpServer,
    mcpMethod: step.mcpMethod,
  });
  const family = step.family || classified.family;
  return {
    uuid,
    role: 'assistant',
    content: '',
    transcriptStep: step,
    actions: [{
      tool: '__raw__',
      rawTool: {
        toolUseId: uuid,
        toolName,
        args,
        argsRef: step.argsRef,
        result: step.result,
        resultRef: step.resultRef,
        isError: step.isError,
        family,
        bashWord: step.bashWord || classified.bashWord,
        bashDetail: step.bashDetail || classified.bashDetail,
        mcpServer: step.mcpServer || classified.mcpServer,
        mcpMethod: step.mcpMethod || classified.mcpMethod,
      },
    }],
  };
});

const renderTranscriptStepEntry = (
  entry: any,
  onCopy?: (text: string) => void,
  loadPayload?: (ref: { payloadId: string; totalChars: number }) => Promise<string | null>,
  onMessageContextMenu?: (
    event: React.MouseEvent<HTMLDivElement>,
    step: HistoryTranscriptStep,
  ) => void,
) => {
  if (entry.transcriptStep?.kind === 'boundary') return null;
  if (entry.transcriptStep?.kind === 'instruction') {
    const step = entry.transcriptStep as HistoryTranscriptStep;
    return <HistoryTranscriptInstructionChip step={step} />;
  }
  if (entry.role === 'user') {
    return (
      <div
        data-history-transcript-message={entry.uuid}
        onContextMenu={onMessageContextMenu && entry.transcriptStep
          ? (event) => onMessageContextMenu(event, entry.transcriptStep)
          : undefined}
      >
        <ChatMessage entry={{
          kind: 'user',
          id: entry.uuid,
          entryUuid: entry.uuid,
          text: entry.content,
        }} />
      </div>
    );
  }
  if (entry.thinking) {
    return <ThinkBlock text={entry.thinking} onCopy={onCopy} />;
  }
  if (entry.content) {
    return (
      <div
        data-history-transcript-message={entry.uuid}
        onContextMenu={onMessageContextMenu && entry.transcriptStep
          ? (event) => onMessageContextMenu(event, entry.transcriptStep)
          : undefined}
      >
        <ChatMessage
          entry={{
            kind: 'assistant',
            id: entry.uuid,
            entryUuid: entry.uuid,
            text: entry.content,
          }}
          ctx={onCopy ? {
            actions: { onCopy: (item) => onCopy('text' in item ? item.text || '' : '') },
          } : undefined}
        />
      </div>
    );
  }
  const raw = entry.actions?.[0]?.rawTool;
  if (!raw) return null;
  return <HistoryTranscriptToolCall raw={raw} onCopy={onCopy} loadPayload={loadPayload} />;
};

const HistoryTranscriptInstructionChip = memo(({
  step,
}: {
  step: HistoryTranscriptStep;
}) => {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ padding: '2px 12px' }}>
      <ComposerChip
        kind="prompt"
        label={step.instructionFileName || 'AGENTS.md'}
        preview={step.instructionScope || undefined}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpen((value) => !value);
        }}
      />
      {open && (
        <pre className="cb-paste-chip-body" style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>
          {step.text}
        </pre>
      )}
    </div>
  );
});

const HistoryTranscriptToolCall = memo(({
  raw,
  onCopy,
  loadPayload,
}: {
  raw: any;
  onCopy?: (text: string) => void;
  loadPayload?: (ref: { payloadId: string; totalChars: number }) => Promise<string | null>;
}) => {
  const [open, setOpen] = useState(() => defaultOpenForTool(raw.toolName));
  const [fullResult, setFullResult] = useState<string | null>(null);
  const [fullArgs, setFullArgs] = useState<Record<string, any> | null>(null);
  const [resultPending, setResultPending] = useState(false);
  const [argsPending, setArgsPending] = useState(false);
  const [payloadFailed, setPayloadFailed] = useState(false);
  const resultRef = raw.resultRef as { payloadId: string; totalChars: number } | undefined;
  const argsRef = raw.argsRef as { payloadId: string; totalChars: number } | undefined;
  const resultRequestRef = React.useRef<{ id: string; promise: Promise<string | null> } | null>(null);
  const argsRequestRef = React.useRef<{ id: string; promise: Promise<Record<string, any> | null> } | null>(null);
  const currentResultIdRef = React.useRef('');
  const currentArgsIdRef = React.useRef('');
  currentResultIdRef.current = resultRef?.payloadId || '';
  currentArgsIdRef.current = argsRef?.payloadId || '';
  const presentedArgs = fullArgs ?? raw.args ?? {};
  const presentation = historyActionPresentationMeta({
    toolName: raw.toolName,
    args: raw.args,
    family: raw.family,
    bashWord: raw.bashWord,
    bashDetail: raw.bashDetail,
    mcpServer: raw.mcpServer,
    mcpMethod: raw.mcpMethod,
  });
  const hydrateResult = React.useCallback(async () => {
    if (!resultRef || !loadPayload) return fullResult;
    if (fullResult != null) return fullResult;
    const id = resultRef.payloadId;
    if (resultRequestRef.current?.id === id) return resultRequestRef.current.promise;
    setResultPending(true);
    setPayloadFailed(false);
    const promise = loadPayload(resultRef).then((loaded) => {
      if (typeof loaded === 'string' && currentResultIdRef.current === id) {
        setFullResult(loaded);
        return loaded;
      }
      if (currentResultIdRef.current === id) setPayloadFailed(true);
      return null;
    }).catch(() => {
      if (currentResultIdRef.current === id) setPayloadFailed(true);
      return null;
    }).finally(() => {
      if (resultRequestRef.current?.id === id) resultRequestRef.current = null;
      if (currentResultIdRef.current === id) setResultPending(false);
    });
    resultRequestRef.current = { id, promise };
    return promise;
  }, [fullResult, loadPayload, resultRef]);
  const hydrateArgs = React.useCallback(async () => {
    if (!argsRef || !loadPayload) return fullArgs;
    if (fullArgs != null) return fullArgs;
    const id = argsRef.payloadId;
    if (argsRequestRef.current?.id === id) return argsRequestRef.current.promise;
    setArgsPending(true);
    setPayloadFailed(false);
    const promise = loadPayload(argsRef).then((loaded) => {
      if (typeof loaded !== 'string') {
        if (currentArgsIdRef.current === id) setPayloadFailed(true);
        return null;
      }
      try {
        const parsed = JSON.parse(loaded);
        if (currentArgsIdRef.current === id && parsed && typeof parsed === 'object') {
          setFullArgs(parsed);
          return parsed;
        }
      } catch {
        if (currentArgsIdRef.current === id) setPayloadFailed(true);
      }
      return null;
    }).catch(() => {
      if (currentArgsIdRef.current === id) setPayloadFailed(true);
      return null;
    }).finally(() => {
      if (argsRequestRef.current?.id === id) argsRequestRef.current = null;
      if (currentArgsIdRef.current === id) setArgsPending(false);
    });
    argsRequestRef.current = { id, promise };
    return promise;
  }, [argsRef, fullArgs, loadPayload]);
  const toggleOpen = React.useCallback(() => {
    const next = !open;
    setOpen(next);
    if (next && resultRef) void hydrateResult();
    if (next && argsRef) void hydrateArgs();
  }, [argsRef?.payloadId, hydrateArgs, hydrateResult, open, resultRef?.payloadId]);
  const copy = React.useCallback(async (text: string) => {
    const [loadedResult, loadedArgs] = await Promise.all([
      resultRef ? hydrateResult() : Promise.resolve(null),
      argsRef ? hydrateArgs() : Promise.resolve(null),
    ]);
    let copyText = text;
    if (loadedArgs) {
      const previewCommand = typeof raw.args?.command === 'string' ? raw.args.command : '';
      const fullCommand = typeof loadedArgs.command === 'string' ? loadedArgs.command : '';
      if (previewCommand && fullCommand && copyText.startsWith(previewCommand)) {
        copyText = fullCommand + copyText.slice(previewCommand.length);
      } else if (raw.toolName === 'Write'
        && typeof raw.args?.content === 'string'
        && typeof loadedArgs.content === 'string'
        && copyText.endsWith(raw.args.content)) {
        copyText = copyText.slice(0, copyText.length - raw.args.content.length)
          + loadedArgs.content;
      } else {
        const previewJson = raw.args && Object.keys(raw.args).length > 0
          ? JSON.stringify(raw.args, null, 2)
          : '';
        const fullJson = JSON.stringify(loadedArgs, null, 2);
        if (previewJson && copyText.includes(previewJson)) {
          copyText = copyText.replace(previewJson, fullJson);
        }
      }
    }
    if (loadedResult != null && typeof raw.result === 'string' && copyText.endsWith(raw.result)) {
      copyText = copyText.slice(0, copyText.length - raw.result.length) + loadedResult;
    }
    onCopy?.(copyText);
  }, [argsRef, hydrateArgs, hydrateResult, onCopy, raw.args, raw.result, resultRef]);

  React.useEffect(() => {
    setOpen(defaultOpenForTool(raw.toolName));
  }, [raw.toolName, raw.toolUseId]);

  React.useEffect(() => {
    setFullResult(null);
    setResultPending(false);
    setPayloadFailed(false);
    resultRequestRef.current = null;
  }, [resultRef?.payloadId]);

  React.useEffect(() => {
    setFullArgs(null);
    setArgsPending(false);
    setPayloadFailed(false);
    argsRequestRef.current = null;
  }, [argsRef?.payloadId]);

  React.useEffect(() => {
    if (open && resultRef) void hydrateResult();
    if (open && argsRef) void hydrateArgs();
  }, [argsRef?.payloadId, hydrateArgs, hydrateResult, open, resultRef?.payloadId]);

  React.useEffect(() => {
    if (!open && fullResult != null) setFullResult(null);
    if (!open && fullArgs != null) setFullArgs(null);
  }, [fullArgs, fullResult, open]);

  return (
    <div className="hp-tool-scroll-scope" data-history-docs-kind={presentation.docsKind || undefined}>
      <ToolCallPart
        toolName={raw.toolName}
        args={presentedArgs}
        result={fullResult ?? raw.result}
        isError={raw.isError}
        family={raw.family}
        headline={historyActionHeadline({
          toolName: raw.toolName,
          args: raw.args,
          family: raw.family,
          bashWord: raw.bashWord,
          bashDetail: raw.bashDetail,
          mcpServer: raw.mcpServer,
          mcpMethod: raw.mcpMethod,
        })}
        mcpServer={raw.mcpServer}
        mcpMethod={raw.mcpMethod}
        collapse={{ open, onToggle: toggleOpen }}
        onCopy={onCopy ? copy : undefined}
      />
      {open && (resultPending || argsPending) && (
        <div style={{ padding: '2px 8px', color: '#818cf8', fontSize: '0.8em' }}>
          загружается полный вывод…
        </div>
      )}
      {open && payloadFailed && (
        <div style={{ padding: '2px 8px', color: '#d97706', fontSize: '0.8em' }}>
          полный вывод не загрузился — показан фрагмент
        </div>
      )}
    </div>
  );
});

/** Compact transcript renderer for nested surfaces such as a live subagent
 * pane. It uses the exact same action grammar, group projection, icons,
 * headers, rails and leaf cards as primary History, but owns no Virtuoso,
 * tail spacer, input or durable state. */
export const HistoryTranscriptPresentation = memo(({
  steps,
  isTurnBusy = false,
  onCopy,
  loadPayload,
  onMessageContextMenu,
  className = '',
}: {
  steps: HistoryTranscriptStep[];
  isTurnBusy?: boolean;
  onCopy?: (text: string) => void;
  loadPayload?: (ref: { payloadId: string; totalChars: number }) => Promise<string | null>;
  onMessageContextMenu?: (
    event: React.MouseEvent<HTMLDivElement>,
    step: HistoryTranscriptStep,
  ) => void;
  className?: string;
}) => {
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => new Set());
  const entries = useMemo(() => transcriptStepsToEntries(steps), [steps]);
  const units = useMemo(() => buildHistoryDisplayUnits(entries, { expandedKeys }), [entries, expandedKeys]);
  const toggleGroup = (groupKey: string) => {
    setExpandedKeys((current) => {
      const next = new Set(current);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      return next;
    });
  };
  const collapseGroup = (groupKey: string) => {
    setExpandedKeys((current) => {
      if (!current.has(groupKey)) return current;
      const next = new Set(current);
      next.delete(groupKey);
      return next;
    });
  };

  return (
    <div className={`hp-history-transcript hp-history-nested-transcript ${className}`.trim()}>
      {units.map((unit: any, index: number) => {
        if (isGroupUnit(unit)) {
          const group = unit as HistoryPresentationGroup;
          const header = (
            <HistoryCollapsedGroupRow
              group={group}
              expanded={group.expanded === true}
              isTurnBusy={isTurnBusy}
              isLastUnit={index === units.length - 1}
              onToggle={() => toggleGroup(group.key)}
            />
          );
          if (!group.parentGroup) return <React.Fragment key={group.key}>{header}</React.Fragment>;
          return (
            <div
              key={group.key}
              className="hp-history-group-member"
              data-history-group-member={group.parentGroup.key}
              data-history-group-last={group.parentGroup.last ? '1' : undefined}
            >
              <HistoryGroupRail groupKey={group.parentGroup.key} onCollapse={collapseGroup} />
              {header}
              {group.parentGroup.last && <HistoryGroupFoot groupKey={group.parentGroup.key} onCollapse={collapseGroup} />}
            </div>
          );
        }
        const entry = unit.entry;
        const expandedGroup = unit.expandedGroup;
        const expandedSubgroup = unit.expandedSubgroup;
        const body = renderTranscriptStepEntry(entry, onCopy, loadPayload, onMessageContextMenu);
        if (!expandedGroup && !expandedSubgroup) {
          return <React.Fragment key={entry.uuid}>{body}</React.Fragment>;
        }
        if (!expandedGroup && expandedSubgroup) {
          return (
            <div
              key={entry.uuid}
              className="hp-history-subgroup-member hp-history-subgroup-member--root"
              data-history-subgroup-member={expandedSubgroup.key}
              data-history-subgroup-last={expandedSubgroup.last ? '1' : undefined}
              data-history-docs-kind={expandedSubgroup.docsKind || undefined}
            >
              <HistoryGroupRail groupKey={expandedSubgroup.key} onCollapse={collapseGroup} title="Свернуть серию" nested />
              {body}
              {expandedSubgroup.last && (
                <HistoryGroupFoot groupKey={expandedSubgroup.key} onCollapse={collapseGroup} title="Свернуть серию" />
              )}
            </div>
          );
        }
        return (
          <div
            key={entry.uuid}
            className="hp-history-group-member"
            data-history-group-member={expandedGroup.key}
            data-history-group-last={expandedGroup.last ? '1' : undefined}
          >
            <HistoryGroupRail groupKey={expandedGroup.key} onCollapse={collapseGroup} />
            {expandedSubgroup ? (
              <div
                className="hp-history-subgroup-member"
                data-history-subgroup-member={expandedSubgroup.key}
                data-history-subgroup-last={expandedSubgroup.last ? '1' : undefined}
                data-history-docs-kind={expandedSubgroup.docsKind || undefined}
              >
                <HistoryGroupRail groupKey={expandedSubgroup.key} onCollapse={collapseGroup} title="Свернуть серию" nested />
                {body}
                {expandedSubgroup.last && (
                  <HistoryGroupFoot groupKey={expandedSubgroup.key} onCollapse={collapseGroup} title="Свернуть серию" />
                )}
              </div>
            ) : body}
            {expandedGroup.last && <HistoryGroupFoot groupKey={expandedGroup.key} onCollapse={collapseGroup} />}
          </div>
        );
      })}
    </div>
  );
});
