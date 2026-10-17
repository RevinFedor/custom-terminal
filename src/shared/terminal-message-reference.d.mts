export declare const TERMINAL_MESSAGE_MIME: 'application/x-noted-terminal-message-reference';
export declare const TERMINAL_MESSAGE_HTML_PREFIX: '<!--noted-terminal-message-reference:';
export declare const TERMINAL_MESSAGE_HTML_ATTRIBUTE: 'data-noted-terminal-message-reference';

export interface TerminalMessageTarget {
  tabId: string;
  messageId: string;
  sessionId: string;
  provider: 'claude' | 'codex' | 'gemini';
  tabName: string;
  iteration: number | null;
  messageTimestamp: string | null;
  timeLabel: string | null;
  role: string | null;
  terminalInstancePid?: number;
  physicalSessionId?: string;
  rawUuid?: string;
  viewOwnerSessionId?: string;
  transcriptSegmentId?: string;
  sourceIdentity?: string;
  handoffId?: string;
}

export interface TerminalMessageSnapshot {
  version: 1;
  kind: 'noted-terminal-message';
  referenceId: string;
  source: TerminalMessageTarget;
  detailsText: string;
}

export declare function normalizeTerminalMessageTarget(value: unknown): TerminalMessageTarget | null;
export declare function makeTerminalMessageSnapshot(detailsText: string, source: unknown, referenceId: string): TerminalMessageSnapshot | null;
export declare function normalizeTerminalMessageSnapshot(value: unknown, expectedText?: string): TerminalMessageSnapshot | null;
export declare function terminalMessageLabel(value: Partial<TerminalMessageTarget> | { source: Partial<TerminalMessageTarget> }): string;
export declare function terminalMessageClipboard(detailsText: string, source: unknown, referenceId: string): { text: string; html?: string };
export declare function readTerminalMessageClipboard(data: { getData(type: string): unknown } | null | undefined, expectedText: string): TerminalMessageSnapshot | null;
export declare function buildTerminalMessageBlock(value: unknown): string | null;
export declare function collectTerminalMessageBlocks(documentText: string): Array<{ from: number; to: number; snapshot: TerminalMessageSnapshot }>;
export declare function expandTerminalMessageBlocks(value: unknown): string;
