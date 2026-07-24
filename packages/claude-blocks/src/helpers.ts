/* ============================================================
   @noted/claude-blocks — helpers (language detect, line diff)
   Портировано дословно из ClaudeSDKTab.tsx (канон-источник).
   ============================================================ */
import React from 'react';

// File extension → Prism language id. Only includes languages oneDark
// styles meaningfully; everything else falls back to plain text.
const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript',
  json: 'json', md: 'markdown', mdx: 'markdown', html: 'html', css: 'css', scss: 'scss',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', c: 'c', cpp: 'cpp', h: 'c',
  sh: 'bash', bash: 'bash', zsh: 'bash', yml: 'yaml', yaml: 'yaml', toml: 'toml',
  sql: 'sql', xml: 'xml', graphql: 'graphql', gql: 'graphql',
};

export function detectLanguage(filePath: string | undefined): string {
  if (!filePath) return 'text';
  const dot = filePath.lastIndexOf('.');
  if (dot < 0) return 'text';
  const ext = filePath.slice(dot + 1).toLowerCase();
  return EXT_LANG[ext] || 'text';
}

export type DiffEntry = { tag: 'eq' | 'add' | 'del'; line: string };
export type DiffHunk = {
  oldStart: number;
  newStart: number;
  entries: DiffEntry[];
};

/** A DiffEntry with resolved unified-diff gutter numbers. `oldNo` is the line's
 *  number in the OLD file (set on eq/del), `newNo` in the NEW file (set on
 *  eq/add); the other is undefined. Mirrors a GitHub-style two-column gutter. */
export type NumberedDiffEntry = DiffEntry & { oldNo?: number; newNo?: number };

/** Assign real file line numbers to a diff sequence. `startOld`/`startNew` are
 *  the 1-based file lines where the hunk begins (for a single edit both equal
 *  the matched old_string's start line). eq advances both counters, del advances
 *  old only, add advances new only — exactly how a unified diff gutter walks.
 *  Pass 1/1 (the default) to reproduce per-hunk-relative numbering. */
export function numberDiff(
  entries: DiffEntry[],
  startOld = 1,
  startNew = 1,
): NumberedDiffEntry[] {
  let oldNo = startOld;
  let newNo = startNew;
  return entries.map((e) => {
    if (e.tag === 'eq') return { ...e, oldNo: oldNo++, newNo: newNo++ };
    if (e.tag === 'del') return { ...e, oldNo: oldNo++ };
    return { ...e, newNo: newNo++ }; // add
  });
}

// LCS-based line diff. Returns a flat sequence of {tag, line} entries where
// tag ∈ 'eq' | 'add' | 'del'.
export function lineDiff(oldText: string, newText: string): DiffEntry[] {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  const n = a.length, m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffEntry[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ tag: 'eq', line: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ tag: 'del', line: a[i] }); i++; }
    else { out.push({ tag: 'add', line: b[j] }); j++; }
  }
  while (i < n) { out.push({ tag: 'del', line: a[i] }); i++; }
  while (j < m) { out.push({ tag: 'add', line: b[j] }); j++; }
  return out;
}

export function countDiffStats(entries: DiffEntry[]): { added: number; removed: number } {
  let added = 0, removed = 0;
  for (const e of entries) {
    if (e.tag === 'add') added++;
    else if (e.tag === 'del') removed++;
  }
  return { added, removed };
}

// Recursively walk react-children collecting only string-leaves. After
// rehypeHexHighlight a code-block may contain <span data-hex-chip> nodes;
// SyntaxHighlighter must NOT render those — it needs the original text.
export const extractRawText = (node: unknown): string => {
  if (node == null || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractRawText).join('');
  if (typeof node === 'object' && 'props' in (node as Record<string, unknown>)) {
    const props = (node as { props?: { children?: unknown } }).props;
    return extractRawText(props?.children);
  }
  return '';
};

export type ToolStatus = 'running' | 'done' | 'error' | 'waiting';

export function toolStatusFrom(result: any, isError?: boolean, awaitingApproval?: boolean): ToolStatus {
  if (awaitingApproval) return 'waiting';   // gated call paused for the user
  if (isError) return 'error';
  if (result === undefined || result === null) return 'running';
  return 'done';
}

// Default-open policy per tool. Edit/Write/MultiEdit → open (the diff IS the
// point of the call). Everything else → collapsed (header is the gist, click
// to drill in). Exported so controlled-collapse consumers (desktop scroll-
// stable, mobile persisted-Map) seed their initial open-state consistently.
export function defaultOpenForTool(toolName: string): boolean {
  return toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit';
}

// Clipboard helper: host-injected impl first (sandboxed Electron renderers
// can't window.require, and navigator.clipboard.writeText REJECTS when the
// document isn't focused — silent no-op in an always-on-top overlay; routing
// through a main-process IPC never fails) → raw Electron clipboard (legacy
// non-isolated windows) → Web Clipboard API (mobile-web).
let copyTextImpl: ((text: string) => void) | null = null;
export function setCopyTextImpl(fn: (text: string) => void): void { copyTextImpl = fn; }
export function copyText(text: string): void {
  if (copyTextImpl) { try { copyTextImpl(text); return; } catch { /* fall through */ } }
  try {
    const electron = (typeof window !== 'undefined') ? (window as any).require?.('electron') : null;
    if (electron?.clipboard?.writeText) { electron.clipboard.writeText(text); return; }
  } catch { /* not electron */ }
  try { navigator.clipboard?.writeText(text); } catch { /* ignore */ }
}

// Result → display string (tool_result content may be string | array | object).
export function resultToText(result: any): string {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  return JSON.stringify(result);
}

export type { React };
