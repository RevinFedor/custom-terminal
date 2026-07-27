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

/**
 * Below this row count a diff is cheap enough to build in full; deferring it
 * would only add containment bookkeeping. Roughly two screenfuls of the 320px
 * diff box.
 */
const DIFF_DEFER_MIN_ROWS = 40;

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
 * `oldStart` / `newStart` — the 1-based file lines where this hunk begins.
 * When provided, the gutter shows REAL file line
 * numbers: a `-` row carries its old-file line, a `+` row its new-file line,
 * an `eq` row its new-file line. del/add counters advance independently, so a
 * mixed hunk (e.g. 2 del + 3 add at line 3) numbers `-3 -4 / +3 +4 +5`, matching
 * what an editor shows — NOT a single counter that would mislabel the adds.
 *
 * `startLine` remains as a backwards-compatible shorthand for callers where
 * old/new offsets are equal. When no trustworthy offset exists, callers can
 * set `unknownLineNumbers`: the gutter keeps its layout but stays blank instead
 * of presenting hunk-relative `1..N` as original file coordinates.
 */
export function DiffView({
  entries,
  language,
  startLine,
  oldStart,
  newStart,
  unknownLineNumbers = false,
  cardRowCount,
}: {
  entries: DiffEntry[];
  language: string;
  startLine?: number;
  oldStart?: number;
  newStart?: number;
  unknownLineNumbers?: boolean;
  /**
   * Total rows across ALL hunks of the owning card, when the card renders more
   * than one. The cost that matters is what a single card paints, and a card is
   * split into one DiffView per hunk — so judging each hunk on its own size
   * lets a card of 38 small hunks (341 rows, prod 26.07) escape deferral
   * entirely while a single 45-row diff gets deferred. Defaults to this
   * DiffView's own length for single-hunk callers.
   */
  cardRowCount?: number;
}) {
  const resolvedOldStart = oldStart ?? startLine;
  const resolvedNewStart = newStart ?? startLine;
  const hasReal =
    typeof resolvedOldStart === 'number' && resolvedOldStart > 0 &&
    typeof resolvedNewStart === 'number' && resolvedNewStart > 0;
  const rows = hasReal
    ? numberDiff(entries, resolvedOldStart, resolvedNewStart)
    : null;
  // Highlighting splits every line into one wrapper per colour, so a row costs
  // ~42 layout nodes instead of 1 — a 280-line diff builds ~12k of them while
  // its own 320px scroll box shows about 20. Measured cost: 0.4-0.8s of paint
  // after the loader had already been hidden (prod 26.07). Tokenising is NOT
  // the expensive part (4.4ms for 280 lines), so the fix must not touch
  // colour: rows below the fold simply must not be built until they approach
  // the viewport. `cb-diff-defer` hands that decision to the browser — it
  // skips offscreen rows, builds them slightly before they scroll in, and
  // reclaims them after, with no scroll listeners and no second virtualiser
  // nested inside Virtuoso. Cheap diffs stay eager: below this size the
  // containment bookkeeping costs more than the rows it would save.
  const deferRows = (cardRowCount ?? entries.length) > DIFF_DEFER_MIN_ROWS;
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
        // del → old-file line; add/eq → new-file line. Unknown metadata must
        // not masquerade as original file line 1.
        const r = rows?.[idx];
        const no = r
          ? (e.tag === 'del' ? r.oldNo : r.newNo)
          : unknownLineNumbers ? '' : idx + 1;
        return (
          <div
            key={idx}
            className={deferRows ? rowClass + ' cb-diff-defer' : rowClass}
            style={{ background: bg }}
          >
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
