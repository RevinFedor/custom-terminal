// ONE launch strip: «Claude | Claude-F | SDK | SDK-F | Codex | Codex-F | Терминал».
//
// It answers a single question — "start a session with which agent" — and it is
// asked in two places that used to answer it differently:
//
//   • the control bar of an EMPTY terminal tab (the historical home);
//   • the header of an EMPTY WORKSPACE PANE, which previously offered only
//     «Выберите вкладку» — i.e. it could adopt an existing tab but not start
//     anything, so the answer to "there is nothing here yet" depended on which
//     empty surface you were looking at.
//
// Юзер: *«при открытии нового окна у меня в баре должна быть та же самая
// полоска, что при новой вкладке… желательно сделай её именно той же самой,
// объедини это в один компонент»*.
//
// WHAT THIS FILE OWNS: how the strip looks and which action each chip means.
// WHAT THE CALLER OWNS: where a launch lands. That is the real difference
// between the two surfaces and the reason the actions are props, not internals:
//   • in a tab the launch converts THAT tab (the user is standing in it);
//   • in an empty pane there is no tab to convert, so the caller creates one at
//     the end of the project and fills the pane with it.
// Folding that decision into this component would make it need to know about
// panes, tabs and projects — and would put the two behaviours behind a boolean
// that reads as "which mode am I in" rather than "where does this land".

import React from 'react';
import ControlHint from '../UI/ControlHint';
import SessionActionChip from './SessionActionChip';

export type AiLaunchAction =
  | 'claude'
  | 'claude-fork'
  | 'sdk'
  | 'sdk-fork'
  | 'codex'
  | 'codex-fork'
  | 'terminal';

const CLAUDE_ACCENT = '#DA7756';
const CLAUDE_ACCENT_BRIGHT = '#FF9466';
const CODEX_ACCENT = '#10A37F';
const CODEX_ACCENT_BRIGHT = '#34d399';
// Серый, а не цвет агента: это единственный пункт, который НИЧЕГО не запускает.
const TERMINAL_ACCENT = '#8a8a92';
const TERMINAL_ACCENT_BRIGHT = '#c8c8ce';

interface ForkChipProps {
  label: string;
  hint: string;
  title: string;
  accent: string;
  accentBright: string;
  tint: string;
  border: string;
  busy?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children?: React.ReactNode;
}

/** A clipboard-fork chip. Outlined, small, tinted by its agent. */
function ForkChip({
  label, hint, title, accent, accentBright, tint, border,
  busy = false, disabled = false, onClick, children,
}: ForkChipProps) {
  return (
    <ControlHint label={hint}>
      <button
        type="button"
        data-ai-launch-action={label}
        aria-busy={busy}
        aria-disabled={disabled}
        className="text-[10px] px-1.5 py-0.5 rounded cursor-pointer leading-none flex items-center gap-0.5 transition-colors"
        style={{
          color: accent,
          backgroundColor: 'transparent',
          border: `1px solid ${border}`,
          flexShrink: 0,
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.backgroundColor = tint;
          (e.currentTarget as HTMLButtonElement).style.color = accentBright;
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent';
          (e.currentTarget as HTMLButtonElement).style.color = accent;
        }}
        onClick={onClick}
        title={title}
      >
        {children ?? label}
      </button>
    </ControlHint>
  );
}

export interface AiLaunchStripProps {
  /** Runs the chosen launch. The caller decides WHERE it lands. */
  onLaunch: (action: AiLaunchAction) => void;
  /**
   * Does the strip render the leading «Claude» chip itself?
   *
   * False in the control bar, where that chip is already drawn OUTSIDE the
   * strip: there it is the live-session control (it also says Continue/Resume/
   * Stop and can represent Gemini), and it must keep its place whether or not
   * the launch chips are shown at all. Drawing a second one here would put two
   * buttons for one action side by side.
   *
   * True in an empty pane, which has no live session and therefore no such
   * control — the strip is the whole answer to "start what?".
   */
  ownsClaudeChip?: boolean;
  /**
   * Wraps a chip's content while its action is in flight (spinner). Optional:
   * the pane header has no inline-action machinery and simply renders labels.
   */
  renderBusy?: (action: AiLaunchAction, content: React.ReactNode) => React.ReactNode;
  /** True while that action is running — drives aria-busy only. */
  isBusy?: (action: AiLaunchAction) => boolean;
  /** Greys the primary Claude/Codex chips (a lifecycle action is in flight). */
  disabled?: boolean;
  disabledTitle?: string;
  /**
   * Offer «Терминал» — explicitly commit this shell to the Terminal role?
   *
   * In an empty window the caller creates a terminal-committed tab. Inside a
   * launchable Blank tab the caller keeps the same shell and records
   * commandType=generic. A one-off shell command does not make this choice.
   */
  showTerminal?: boolean;
}

export default function AiLaunchStrip({
  onLaunch,
  renderBusy,
  isBusy,
  disabled = false,
  disabledTitle,
  ownsClaudeChip = false,
  showTerminal = false,
}: AiLaunchStripProps) {
  const busy = (action: AiLaunchAction) => !!isBusy?.(action);
  const wrap = (action: AiLaunchAction, content: React.ReactNode) => (
    renderBusy ? renderBusy(action, content) : content
  );

  return (
    <>
      {/* Claude — the same chip the live bar uses, so "start Claude" looks the
          same whether or not a session already exists. hasAnySession=false makes
          it read «Claude» and morph to «Start» on hover. */}
      {ownsClaudeChip && (
        <SessionActionChip
          sessionType="claude"
          mode="pty"
          isCommandRunning={false}
          hasAnySession={false}
          disabled={disabled}
          disabledTitle={disabledTitle}
          onStart={() => onLaunch('claude')}
          onContinue={() => onLaunch('claude')}
          onStop={() => {}}
        />
      )}
      <ForkChip
        label="Claude-F"
        hint="Создать Claude fork из session ID в буфере"
        title="Форк Claude из session ID в буфере обмена"
        accent={CLAUDE_ACCENT}
        accentBright={CLAUDE_ACCENT_BRIGHT}
        tint="rgba(218,119,86,0.15)"
        border="rgba(218,119,86,0.30)"
        busy={busy('claude-fork')}
        onClick={() => onLaunch('claude-fork')}
      >
        {wrap('claude-fork', 'Claude-F')}
      </ForkChip>
      <ForkChip
        label="SDK"
        hint="Открыть новую Claude SDK-вкладку"
        title="Открыть новый Claude SDK таб"
        accent={CLAUDE_ACCENT}
        accentBright={CLAUDE_ACCENT_BRIGHT}
        tint="rgba(218,119,86,0.15)"
        border="rgba(218,119,86,0.30)"
        onClick={() => onLaunch('sdk')}
      />
      <ForkChip
        label="SDK-F"
        hint="Создать SDK fork из session ID в буфере"
        title="Форк SDK из session ID в буфере обмена"
        accent={CLAUDE_ACCENT}
        accentBright={CLAUDE_ACCENT_BRIGHT}
        tint="rgba(218,119,86,0.15)"
        border="rgba(218,119,86,0.30)"
        busy={busy('sdk-fork')}
        onClick={() => onLaunch('sdk-fork')}
      >
        {wrap('sdk-fork', 'SDK-F')}
      </ForkChip>
      <SessionActionChip
        sessionType="codex"
        mode="pty"
        isCommandRunning={false}
        hasAnySession={false}
        disabled={disabled}
        disabledTitle={disabledTitle}
        onStart={() => onLaunch('codex')}
        onContinue={() => onLaunch('codex')}
        onStop={() => {}}
      />
      <ForkChip
        label="Codex-F"
        hint="Создать Codex fork из session ID в буфере"
        title="Форк Codex из session ID в буфере обмена"
        accent={CODEX_ACCENT}
        accentBright={CODEX_ACCENT_BRIGHT}
        tint="rgba(16,163,127,0.14)"
        border="rgba(16,163,127,0.35)"
        busy={busy('codex-fork')}
        onClick={() => onLaunch('codex-fork')}
      >
        {wrap('codex-fork', 'Codex-F')}
      </ForkChip>
      {/* «Терминал» ничего не запускает, но фиксирует роль существующего live
          shell. Стоит последним и серым: ответ на «каким агентом начать» —
          «никаким». После выбора AI-launch controls больше не возвращаются. */}
      {showTerminal && (
        <ForkChip
          label="Терминал"
          hint="Вкладка без агента: живой shell"
          title="Терминал: вкладка без агента"
          accent={TERMINAL_ACCENT}
          accentBright={TERMINAL_ACCENT_BRIGHT}
          tint="rgba(255,255,255,0.08)"
          border="rgba(255,255,255,0.18)"
          onClick={() => onLaunch('terminal')}
        />
      )}
    </>
  );
}
