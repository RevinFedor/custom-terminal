import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * SDKAskQuestion — interactive AskUserQuestion dialog for the Claude SDK tab.
 *
 * Ports the Ink/TUI dialog that PTY-Claude shows (where the composer is covered
 * by the question) into the SDK tab. While this is mounted the SDKComposer is
 * unmounted (see ClaudeSDKTab footer ternary) so the user cannot type — they
 * must answer or stop, exactly like PTY.
 *
 * Navigation (matches Claude Code Ink):
 *   ↑ / ↓        move between OPTIONS of the current question (incl. the
 *                "Type something" stop-row appended after the real options)
 *   ← / →        move between QUESTIONS, and to the Submit tab (≥2 questions)
 *   Enter        single-select: pick the focused option and advance; multiSelect:
 *                toggle the focused option; on "Type something": STOP; on the
 *                Submit tab: submit
 *   Space        multiSelect: toggle focused option
 *   Esc          STOP the turn (deny+interrupt) and return to the composer
 *
 * Product decisions (confirmed with the user):
 *   - "Type something" is KEPT and means STOP: abort the turn and focus the
 *     composer so the user types free text (e.g. "decide the architecture
 *     yourself"). It is NOT an inline free-text answer.
 *   - "Chat about this" is REMOVED entirely.
 *   - Single question  → no Submit tab (Enter on the last/only answer submits).
 *   - 2+ questions      → a final Submit tab ("Review your answers").
 *
 * Answers are returned as Record<questionText, label> (multiSelect → comma+space
 * joined), matching AskUserQuestionTool's `answers` schema. See
 * docs/knowledge/fact-claude-sdk-tab.md::AskUserQuestion via canUseTool.
 */

export interface SDKQuestionOption {
  label: string;
  description?: string;
  preview?: string;
}
export interface SDKQuestion {
  question: string;
  header: string;
  multiSelect?: boolean;
  options: SDKQuestionOption[];
}

interface Props {
  questions: SDKQuestion[];
  /** answers keyed by question text; multiSelect joined with ", " */
  onSubmit: (answers: Record<string, string>) => void;
  /** Type-something / Esc / Cancel — abort the turn, return to composer */
  onStop: () => void;
  /** font-size root (px) inherited from the SDK tab terminalFontSize */
  fontPx?: number;
}

const PERMISSION_BLUE = '#b1b9f9';
const SELECT_BG = 'rgba(147, 51, 234, 0.22)';
const SELECT_BORDER = 'rgba(168, 85, 247, 0.9)';
const DIM = '#8a8a8a';
const TEXT = '#e8e8e8';

const STOP_VALUE = '__stop__';
const SUBMIT_TAB = '__submit__';

// Per-question selection state.
type Selection = Record<number, string[]>; // questionIndex → selected labels

export default function SDKAskQuestion({ questions, onSubmit, onStop, fontPx = 13 }: Props) {
  const multi = questions.length > 1;
  // Tabs: one per question, plus a trailing Submit tab when ≥2 questions.
  const tabCount = multi ? questions.length + 1 : questions.length;

  const [tabIndex, setTabIndex] = useState(0); // which question / submit tab
  const [optionIndex, setOptionIndex] = useState(0); // focused option within question
  const [selection, setSelection] = useState<Selection>({});
  const rootRef = useRef<HTMLDivElement>(null);

  const onSubmitTab = multi && tabIndex === questions.length;
  const curQ = onSubmitTab ? null : questions[tabIndex];
  const curMulti = !!curQ?.multiSelect;

  // Rows of the current question = real options + the "Type something" stop row.
  const rowCount = curQ ? curQ.options.length + 1 : 0;
  const isStopRow = !!curQ && optionIndex === curQ.options.length;

  const answeredCount = useMemo(
    () => questions.reduce((n, _q, i) => n + ((selection[i]?.length ?? 0) > 0 ? 1 : 0), 0),
    [questions, selection],
  );
  const allAnswered = answeredCount === questions.length;

  // Keep focus so keydown lands here, not the (now-unmounted) composer.
  useEffect(() => {
    rootRef.current?.focus();
  }, [tabIndex]);

  const buildAnswers = useCallback((): Record<string, string> => {
    const out: Record<string, string> = {};
    questions.forEach((q, i) => {
      const sel = selection[i];
      if (sel && sel.length) out[q.question] = sel.join(', ');
    });
    return out;
  }, [questions, selection]);

  const commitSelect = useCallback((qIndex: number, label: string, toggle: boolean) => {
    setSelection((prev) => {
      const cur = prev[qIndex] ?? [];
      if (toggle) {
        // multiSelect: flip membership
        const next = cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label];
        return { ...prev, [qIndex]: next };
      }
      // single-select: replace
      return { ...prev, [qIndex]: [label] };
    });
  }, []);

  const goToTab = useCallback((next: number) => {
    const clamped = Math.max(0, Math.min(tabCount - 1, next));
    setTabIndex(clamped);
    setOptionIndex(0);
  }, [tabCount]);

  const advanceAfterAnswer = useCallback(() => {
    // single-select Enter advances to the next question (or Submit tab / submit).
    if (multi) {
      goToTab(tabIndex + 1); // lands on next Q, or the Submit tab if this was last Q
    } else {
      // single question: answering IS submitting
      onSubmit(buildAnswers());
    }
  }, [multi, tabIndex, goToTab, onSubmit, buildAnswers]);

  const trySubmit = useCallback(() => {
    onSubmit(buildAnswers());
  }, [onSubmit, buildAnswers]);

  const handleKey = useCallback((e: React.KeyboardEvent) => {
    // Esc → stop the turn entirely.
    if (e.key === 'Escape' || (e.ctrlKey && e.key === '[')) {
      e.preventDefault();
      onStop();
      return;
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      goToTab(tabIndex - 1);
      return;
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      goToTab(tabIndex + 1);
      return;
    }

    if (onSubmitTab) {
      if (e.key === 'Enter') {
        e.preventDefault();
        trySubmit();
      }
      return;
    }

    // Within a question
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setOptionIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOptionIndex((i) => Math.min(rowCount - 1, i + 1));
      return;
    }
    if (e.key === ' ' && curMulti && !isStopRow) {
      e.preventDefault();
      commitSelect(tabIndex, curQ!.options[optionIndex].label, true);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (isStopRow) {
        onStop();
        return;
      }
      const label = curQ!.options[optionIndex].label;
      if (curMulti) {
        // multiSelect Enter toggles AND, if this was the last question with at
        // least one selection, allows moving on via ←/→ to Submit. We toggle
        // here; advancing is explicit (←/→ or Submit tab).
        commitSelect(tabIndex, label, true);
      } else {
        commitSelect(tabIndex, label, false);
        advanceAfterAnswer();
      }
    }
  }, [onSubmitTab, onStop, goToTab, tabIndex, trySubmit, rowCount, curMulti, isStopRow, curQ, optionIndex, commitSelect, advanceAfterAnswer]);

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      onKeyDown={handleKey}
      className="outline-none"
      style={{
        fontSize: `${fontPx}px`,
        padding: '10px 14px 12px',
        color: TEXT,
        // claim the footer slot; composer is unmounted while we're here
        userSelect: 'none',
      }}
    >
      {/* Nav bar — per-question chips with ☐/✔ + Submit, framed by ← → */}
      <div className="flex items-center gap-2 mb-3" style={{ fontSize: '0.92em' }}>
        <span style={{ color: tabIndex > 0 ? TEXT : DIM }}>←</span>
        {questions.map((q, i) => {
          const answered = (selection[i]?.length ?? 0) > 0;
          const active = i === tabIndex;
          return (
            <span
              key={i}
              onClick={() => goToTab(i)}
              className="cursor-pointer px-2 py-0.5 rounded"
              style={{
                background: active ? SELECT_BG : 'transparent',
                color: active ? '#fff' : TEXT,
                border: active ? `1px solid ${SELECT_BORDER}` : '1px solid transparent',
                whiteSpace: 'nowrap',
              }}
              title={q.question}
            >
              {answered ? '✔' : '☐'} {q.header || `Q${i + 1}`}
            </span>
          );
        })}
        {multi && (
          <span
            onClick={() => goToTab(questions.length)}
            className="cursor-pointer px-2 py-0.5 rounded"
            style={{
              background: onSubmitTab ? SELECT_BG : 'transparent',
              color: onSubmitTab ? '#fff' : (allAnswered ? PERMISSION_BLUE : DIM),
              border: onSubmitTab ? `1px solid ${SELECT_BORDER}` : '1px solid transparent',
            }}
          >
            {allAnswered ? '✔' : '☐'} Submit
          </span>
        )}
        <span style={{ color: tabIndex < tabCount - 1 ? TEXT : DIM }}>→</span>
      </div>

      {onSubmitTab ? (
        <SubmitReview
          questions={questions}
          selection={selection}
          allAnswered={allAnswered}
          onSubmit={trySubmit}
          onStop={onStop}
        />
      ) : (
        <QuestionBody
          q={curQ!}
          qMulti={curMulti}
          optionIndex={optionIndex}
          selected={selection[tabIndex] ?? []}
          isStopRow={isStopRow}
          onPick={(label, idx) => {
            setOptionIndex(idx);
            if (curMulti) commitSelect(tabIndex, label, true);
            else { commitSelect(tabIndex, label, false); advanceAfterAnswer(); }
          }}
          onHoverRow={setOptionIndex}
          onStop={onStop}
          fontPx={fontPx}
        />
      )}

      {/* footer help */}
      <div className="mt-3 pt-2" style={{ borderTop: '1px solid rgba(255,255,255,0.08)', color: DIM, fontSize: '0.78em' }}>
        ↑/↓ выбор · {multi ? '←/→ вопросы · ' : ''}Enter подтвердить · Esc остановить и ввести вручную
      </div>
    </div>
  );
}

function QuestionBody({
  q, qMulti, optionIndex, selected, isStopRow, onPick, onHoverRow, onStop, fontPx,
}: {
  q: SDKQuestion;
  qMulti: boolean;
  optionIndex: number;
  selected: string[];
  isStopRow: boolean;
  onPick: (label: string, idx: number) => void;
  onHoverRow: (idx: number) => void;
  onStop: () => void;
  fontPx: number;
}) {
  const focusedOption = !isStopRow ? q.options[optionIndex] : null;
  return (
    <div>
      <div className="font-bold mb-2" style={{ color: '#fff' }}>{q.question}</div>
      <div className="flex flex-col gap-0.5">
        {q.options.map((opt, idx) => {
          const isFocused = idx === optionIndex;
          const isChecked = selected.includes(opt.label);
          const marker = qMulti ? (isChecked ? '☒' : '☐') : (isChecked ? '◉' : '○');
          return (
            <div
              key={idx}
              onMouseEnter={() => onHoverRow(idx)}
              onClick={() => onPick(opt.label, idx)}
              className="cursor-pointer rounded px-2 py-1"
              style={{
                background: isFocused ? SELECT_BG : 'transparent',
                border: isFocused ? `1px solid ${SELECT_BORDER}` : '1px solid transparent',
              }}
            >
              <div className="flex items-baseline gap-2">
                <span style={{ color: isChecked ? PERMISSION_BLUE : DIM }}>{marker}</span>
                <span style={{ color: isFocused ? '#fff' : TEXT, fontWeight: isChecked ? 600 : 400 }}>{opt.label}</span>
              </div>
              {opt.description && (
                <div style={{ color: DIM, marginLeft: '1.5em', fontSize: '0.88em' }}>{opt.description}</div>
              )}
            </div>
          );
        })}

        {/* Type something = STOP */}
        <div
          onMouseEnter={() => onHoverRow(q.options.length)}
          onClick={onStop}
          className="cursor-pointer rounded px-2 py-1 mt-1"
          style={{
            background: isStopRow ? SELECT_BG : 'transparent',
            border: isStopRow ? `1px solid ${SELECT_BORDER}` : '1px solid transparent',
          }}
        >
          <div className="flex items-baseline gap-2">
            <span style={{ color: DIM }}>›</span>
            <span style={{ color: isStopRow ? '#fff' : DIM, fontStyle: 'italic' }}>Type something… (остановить и ввести вручную)</span>
          </div>
        </div>
      </div>

      {/* Preview for the focused single-select option (markdown / ascii box) */}
      {focusedOption?.preview && !qMulti && (
        <div
          className="mt-2 rounded"
          style={{
            border: '1px solid rgba(255,255,255,0.1)',
            background: 'rgba(255,255,255,0.02)',
            padding: '8px 10px',
            maxHeight: '40vh',
            overflow: 'auto',
          }}
        >
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'inherit', color: TEXT, fontSize: '0.9em' }}>{focusedOption.preview}</pre>
        </div>
      )}
    </div>
  );
}

function SubmitReview({
  questions, selection, allAnswered, onSubmit, onStop,
}: {
  questions: SDKQuestion[];
  selection: Selection;
  allAnswered: boolean;
  onSubmit: () => void;
  onStop: () => void;
}) {
  return (
    <div>
      <div className="font-bold mb-2" style={{ color: '#fff' }}>Review your answers</div>
      {!allAnswered && (
        <div className="mb-2" style={{ color: '#d97706' }}>⚠ Вы ответили не на все вопросы</div>
      )}
      <div className="flex flex-col gap-1 mb-3">
        {questions.map((q, i) => {
          const ans = selection[i]?.join(', ');
          return (
            <div key={i} className="flex items-baseline gap-2">
              <span style={{ color: DIM }}>●</span>
              <span style={{ color: TEXT }}>{q.header || q.question}:</span>
              <span style={{ color: ans ? PERMISSION_BLUE : DIM }}>{ans || '—'}</span>
            </div>
          );
        })}
      </div>
      <div className="flex flex-col gap-0.5">
        <div
          onClick={onSubmit}
          className="cursor-pointer rounded px-2 py-1"
          style={{ background: SELECT_BG, border: `1px solid ${SELECT_BORDER}` }}
        >
          <span style={{ color: PERMISSION_BLUE }}>Submit answers</span>
        </div>
        <div onClick={onStop} className="cursor-pointer rounded px-2 py-1" style={{ color: DIM }}>
          Cancel (остановить и ввести вручную)
        </div>
      </div>
    </div>
  );
}
