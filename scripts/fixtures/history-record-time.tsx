// Private source-snapshot fixture for History Cmd-hover record-time acceptance.
// It uses the real History leaf components and the real record-time overlay;
// all transcript data and obstacle surfaces are synthetic and disposable.
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Virtuoso } from 'react-virtuoso';
import {
  HistoryAssistantEntry,
  HistoryToolCallPart,
  HistoryUserEntry,
} from '../../src/renderer/components/Workspace/HistoryPanel';
import * as HistoryRecordTimeOverlayModule from '../../src/renderer/components/Workspace/HistoryRecordTimeOverlay';
import { useUIStore } from '../../src/renderer/store/useUIStore';
import { buildPromptChipWrapper } from '../../src/renderer/utils/composerChips.mjs';
import '../../packages/claude-blocks/src/theme.css';
import '../../packages/claude-blocks/src/styles.css';
import '../../packages/claude-blocks/src/blocks.css';

const fixture = (window as any).fixture;
const HistoryRecordTimeOverlay = (HistoryRecordTimeOverlayModule as any).HistoryRecordTimeOverlay
  || (HistoryRecordTimeOverlayModule as any).default;

const at = {
  user: '2026-10-07T07:43:15.599Z',
  toolCall: '2026-10-07T07:46:18.647Z',
  toolResult: '2026-10-07T07:46:23.699Z',
  text: '2026-10-07T07:47:01.000Z',
  exec: '2026-10-07T07:47:02.000Z',
};

const recordTime = (timestamp: string, kind: 'message' | 'tool-call', scope: 'record' | 'container' = 'record') => ({
  version: 1,
  timestamp,
  kind,
  scope,
});

const longText = [
  'A long assistant block keeps its last visible line available for the timestamp.',
  '',
  '- Markdown list item with enough text to wrap in a narrow pane.',
  '- Another list item with a long path: /Users/example/Desktop/custom-terminal/docs/knowledge/fact-history.md',
  '',
  '| column | value |',
  '| --- | --- |',
  '| long | value that wraps in the narrow fixture |',
  '',
  '```ts',
  'const result = await inspectHistoryRecordTime({ callAt, resultAt });',
  '```',
  '',
  'The final line is deliberately long enough to reach the right edge of the row.',
].join('\n');

const noop = () => {};

function TestRow({
  kind,
  time,
  scope = 'record',
  label,
  style,
  children,
}: {
  kind: 'tool' | 'text' | 'user';
  time?: string;
  scope?: 'record' | 'container';
  label: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
}) {
  return (
    <div
      data-history-test-row={kind}
      data-history-test-record-time={time || undefined}
      data-history-test-record-scope={scope}
      style={{ position: 'relative', padding: '12px 10px', borderBottom: '1px solid rgba(255,255,255,.08)', ...style }}
    >
      <div data-history-test-row-label style={{ fontSize: '0.82em', color: '#a1a1aa', marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

function UserRow({ chipCount, chipOnly, imageOnly }: { chipCount: number; chipOnly: boolean; imageOnly: boolean }) {
  const chips = Array.from({ length: chipCount }, (_, index) => ({
    id: `prompt-${index}`,
    kind: 'prompt' as const,
    label: `Attached prompt ${index + 1}`,
    text: `Prompt body ${index + 1}`,
    ...(index === 1 ? { contextUpdateId: 'context-update-many' } : {}),
  }));
  const imagePaths = imageOnly ? [{ id: 1, path: '/tmp/history-record-time.png', size: 1234 }] : [];
  const chipText = chips.map((chip) => buildPromptChipWrapper(chip)).join('\n\n');
  const canonicalContent = imageOnly
    ? '[Image #1]'
    : chipOnly
      ? chipText
      : chipText + '\n\nUser prompt with a long final line that should anchor its timestamp without changing the message geometry.';
  const entry: any = {
    uuid: 'user-record-time',
    role: 'user',
    timestamp: at.user,
    recordTime: recordTime(at.user, 'message'),
    content: canonicalContent,
    promptChips: chips,
    imagePaths,
    sessionId: 'history-record-time',
  };
  return (
    <TestRow kind="user" time={at.user} label={`user-${chipCount}-${chipOnly ? 'chip' : imageOnly ? 'image' : 'text'}`}
      style={chipOnly || imageOnly ? { paddingTop: 120 } : undefined}>
      <HistoryUserEntry
        entry={entry}
        tabId="history-record-time"
        toolType="codex"
        allowRewind={false}
        rewindLocked={false}
        allowHistoryRewriteRewind
        historyRewriteRewindLocked={false}
        onHistoryRewriteRewind={noop}
        allowDeleteIteration
        deleteIterationLocked={false}
        onDeleteIteration={noop}
        onDismissPromptPresentation={noop}
      />
    </TestRow>
  );
}

function FixtureApp() {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const scrollerRef = useRef<HTMLElement | null>(null);
  const [scrollerReady, setScrollerReady] = useState(false);
  const [config, setConfig] = useState({ font: 14, chipCount: 1, chipOnly: false, imageOnly: false, variant: 'normal', owner: 'owner-a', revision: 0 });
  const testRootKey = `${config.owner}:${config.revision}`;

  useEffect(() => {
    useUIStore.setState({ historyFontSize: config.font } as any);
  }, [config.font]);

  fixture.setConfig = (next: Partial<typeof config>) => setConfig((current) => ({ ...current, ...next }));
  fixture.remount = () => setConfig((current) => ({ ...current, revision: current.revision + 1 }));
  fixture.switchOwner = () => setConfig((current) => ({ ...current, owner: current.owner === 'owner-a' ? 'owner-b' : 'owner-a' }));
  fixture.updateStream = () => setConfig((current) => ({ ...current, variant: 'streamed', revision: current.revision + 1 }));

  const longAssistant: any = {
    uuid: `assistant-${config.revision}`,
    role: 'assistant',
    timestamp: at.text,
    recordTime: recordTime(at.text, 'message'),
    content: config.variant === 'streamed' ? longText + '\nStream update.' : longText,
    sessionId: 'history-record-time',
  };
  const toolArgs = { command: 'rg --hidden --glob **/*.md history-record-time /Users/example/Desktop/custom-terminal' };
  const toolAction: any = {
    toolUseId: 'exact-call',
    toolName: 'exec_command',
    args: toolArgs,
    result: `result recorded at ${at.toolResult}; the call was recorded at ${at.toolCall}`,
    recordTime: recordTime(at.toolCall, 'tool-call'),
    family: 'search',
  };
  const toolEntry: any = {
    uuid: `tool-entry-${config.revision}`,
    role: 'assistant',
    timestamp: at.toolResult,
    content: '',
    actions: [{ tool: '__raw__', rawTool: toolAction }],
    sessionId: 'history-record-time',
  };

  const rows: React.ReactNode[] = [
    <div key="top-spacer" data-history-test-row="filler" style={{ height: 76, padding: 12, color: '#71717a' }}>
      History record-time top spacer
    </div>,
    <TestRow key="tool" kind="tool" time={at.toolCall} scope="record" label="Read SKILL.md / result 07:46:23">
      <HistoryToolCallPart {...toolAction} recordTime={recordTime(at.toolCall, 'tool-call')} timeKey="tool-entry:exact-call" />
    </TestRow>,
    <UserRow key="user" chipCount={config.chipCount} chipOnly={config.chipOnly} imageOnly={config.imageOnly} />,
    <TestRow key="exec" kind="tool" time={at.exec} scope="container" label="Tool Search Inspect available tools">
      <HistoryToolCallPart {...toolAction} toolUseId="nested-exec" toolName="exec" recordTime={recordTime(at.exec, 'tool-call', 'container')} timeKey="tool-entry:nested-exec" />
    </TestRow>,
    <TestRow key="text" kind="text" time={at.text} label="assistant Markdown list/code/table">
      <HistoryAssistantEntry entry={longAssistant} />
    </TestRow>,
    ...Array.from({ length: 20 }, (_, index) => (
      <div key={`filler-${index}`} data-history-test-row="filler" style={{ height: 58, padding: 12, color: '#71717a' }}>
        Virtualized filler row {index + 1}
      </div>
    )),
  ];

  const blockers = (
    <>
      <div data-history-test-topbar style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 38, display: 'flex', justifyContent: 'flex-end', gap: 4, padding: 6, zIndex: 2 }}>
        <button type="button" data-history-test-copy onClick={() => { fixture.controlClicks += 1; }}>Copy</button>
        <button type="button" data-history-test-rewind onClick={() => { fixture.controlClicks += 1; }}>Rewind</button>
        <button type="button" data-history-test-menu onClick={() => { fixture.controlClicks += 1; }}>Menu</button>
      </div>
      <div data-history-composer-prompt-band style={{ position: 'absolute', left: 8, right: 8, bottom: 54, height: config.chipCount > 3 ? 70 : 28, zIndex: 2 }}>
        {Array.from({ length: config.chipCount }, (_, index) => <span key={index} data-history-test-chip style={{ display: 'inline-block', marginRight: 4, padding: '3px 6px', border: '1px solid #4f46e5' }}>chip {index + 1}</span>)}
      </div>
      <div data-history-composer-floating-status style={{ position: 'absolute', left: 8, right: 8, bottom: 28, height: 20, zIndex: 2 }}>Working</div>
      <button type="button" data-history-side-surface-toggle style={{ position: 'absolute', top: 620, right: 4, zIndex: 2 }} onClick={() => { fixture.controlClicks += 1; }}>Side</button>
      <div data-history-agent-dock style={{ position: 'absolute', left: 8, right: 8, bottom: 0, height: 24, zIndex: 2 }}>agent</div>
      <div data-history-controls data-history-test-composer style={{ position: 'absolute', left: 8, right: 8, bottom: 0, height: 24, border: '1px solid #333', pointerEvents: 'none' }} />
    </>
  );

  return (
    <div
      key={testRootKey}
      ref={panelRef}
      data-history-test-panel
      className="hp-history-transcript"
      style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden', fontSize: config.font, background: '#121212', color: '#e4e4e7' }}
    >
      {blockers}
      <Virtuoso
        totalCount={rows.length}
        initialItemCount={rows.length}
        defaultItemHeight={58}
        increaseViewportBy={500}
        style={{ position: 'absolute', inset: '40px 0 28px', padding: '0 8px' }}
        scrollerRef={(node) => { scrollerRef.current = node as HTMLElement | null; setScrollerReady(!!node); }}
        itemContent={(index) => rows[index]}
      />
      <HistoryRecordTimeOverlay panelRef={panelRef} scrollerRef={scrollerRef} ownerKey={config.owner} enabled={scrollerReady} />
    </div>
  );
}

fixture.controlClicks = 0;
fixture.render = () => createRoot(document.getElementById('root')!).render(<FixtureApp />);
fixture.render();
