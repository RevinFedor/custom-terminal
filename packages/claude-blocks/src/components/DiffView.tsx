/* ============================================================
   @noted/claude-blocks — DiffView + HighlightedLine
   ------------------------------------------------------------
   Дифф редактирования файла. Перенос из ClaudeSDKTab.tsx::DiffLines.
   add/eq → Prism-подсветка; del → белый текст без подсветки
   (на красном фоне Prism-тона нечитаемы). Цвета — токены theme.css.
   ============================================================ */
import React from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import type { DiffEntry } from '../helpers';
import { numberDiff } from '../helpers';

function HighlightedLine({ line, language }: { line: string; language: string }) {
  return (
    <SyntaxHighlighter
      language={language}
      style={oneDark as any}
      PreTag="span"
      CodeTag="span"
      customStyle={{ margin: 0, padding: 0, background: 'transparent', fontSize: 'inherit', display: 'inline' }}
      codeTagProps={{ style: { fontFamily: 'inherit', background: 'transparent' } }}
    >
      {line || ' '}
    </SyntaxHighlighter>
  );
}

/**
 * Diff renderer with a real unified-diff gutter.
 *
 * `startLine` — the 1-based file line where this hunk begins (the matched
 * old_string's position). When provided, the gutter shows REAL file line
 * numbers: a `-` row carries its old-file line, a `+` row its new-file line,
 * an `eq` row its new-file line. del/add counters advance independently, so a
 * mixed hunk (e.g. 2 del + 3 add at line 3) numbers `-3 -4 / +3 +4 +5`, matching
 * what an editor shows — NOT a single counter that would mislabel the adds.
 *
 * When `startLine` is omitted the gutter falls back to per-row index (1..N),
 * preserving the original behaviour for callers that don't have a file offset.
 */
export function DiffView({ entries, language, startLine }: { entries: DiffEntry[]; language: string; startLine?: number }) {
  const hasReal = typeof startLine === 'number' && startLine > 0;
  const rows = hasReal ? numberDiff(entries, startLine, startLine) : null;
  return (
    <div className="cb-diff" data-diff-lang={language}>
      {entries.map((e, idx) => {
        const rowClass = e.tag === 'add' ? 'cb-diff-row cb-diff-row--add'
          : e.tag === 'del' ? 'cb-diff-row cb-diff-row--del'
          : 'cb-diff-row';
        const markClass = e.tag === 'add' ? 'cb-diff-mark cb-c-add'
          : e.tag === 'del' ? 'cb-diff-mark cb-c-del'
          : 'cb-diff-mark cb-c-dim';
        const sign = e.tag === 'add' ? '+' : e.tag === 'del' ? '-' : ' ';
        const bg = e.tag === 'add' ? 'var(--cb-diff-add-bg)' : e.tag === 'del' ? 'var(--cb-diff-del-bg)' : 'transparent';
        // del → old-file line; add/eq → new-file line. Fallback: idx+1.
        const r = rows?.[idx];
        const no = r ? (e.tag === 'del' ? r.oldNo : r.newNo) : idx + 1;
        return (
          <div key={idx} className={rowClass} style={{ background: bg }}>
            <span className="cb-diff-no">{no}</span>
            <span className={markClass}>{sign}</span>
            <span className="cb-diff-code" style={{ color: e.tag === 'del' ? 'var(--cb-diff-del-text)' : undefined }}>
              {e.tag === 'del' ? (e.line || ' ') : <HighlightedLine line={e.line} language={language} />}
            </span>
          </div>
        );
      })}
    </div>
  );
}
