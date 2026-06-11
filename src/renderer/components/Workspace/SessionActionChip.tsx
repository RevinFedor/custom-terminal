import React from 'react';

// ============================================================================
// SessionActionChip — единственная кнопка в ControlBar для управления
// процессом/сессией. Лейбл и поведение зависят от `mode` (pty vs sdk),
// потому что у этих двух систем фундаментально разные lifecycle'ы.
// ============================================================================
//
// === PTY MODE (claude/gemini CLI в живой TUI) ===
// Три состояния, label morphs on (state, hover):
//   No session at all          → label "Claude"/"Gemini" (tinted), hover "Start", click → onStart
//   Session in DB, proc dead   → label "Continue", click → onContinue (claude --resume)
//   Session live (proc alive)  → label "Claude"/"Gemini" idle, hover "Stop", click → onStop
//
// === SDK MODE (Anthropic Agent SDK, без PTY) ===
// SDK таб — это всегда «conversation», нет lifecycle «процесс/нет процесса».
// Query живёт ровно один turn (от submit до result). Между turn'ами процесса
// НЕТ — но юзер может в любой момент писать следующее сообщение.
//
// Поэтому в SDK режиме всего ДВА состояния:
//   Query NOT running (idle / between turns) → label "Claude", click → focus composer
//                                              hover ничего не делает (нет «Start»,
//                                              нет «Continue», нет «Stop»).
//   Query running (мы в середине turn'а)     → label "Claude", hover "Stop",
//                                              click → onStop (cancel current query).
//
// Юзер: «должна отображаться просто кнопка Claude которая по идее никакого
// функционала не выполняет (когда процесс не запущен)». Это про SDK режим:
// «Continue» / «Start» НЕ имеют семантики для SDK — там нечего continue'ить
// (новое сообщение и есть continue) и нечего start'ить (таб уже создан).
//
// sessionType is required (never null) — caller decides which AI the chip
// represents when no session exists yet (e.g. fall back to commandType or
// default 'claude').
export default function SessionActionChip({
  sessionType, isCommandRunning, hasAnySession,
  mode = 'pty',
  onStart, onContinue, onStop,
}: {
  sessionType: 'claude' | 'gemini' | 'codex';
  isCommandRunning: boolean;
  hasAnySession: boolean;
  /** 'pty' = CLI в живой TUI (Start/Continue/Stop матрица).
   *  'sdk' = Anthropic Agent SDK (только Stop при isRunning, иначе passive). */
  mode?: 'pty' | 'sdk';
  onStart: () => void;
  onContinue: () => void;
  onStop: () => void;
}) {
  const [hover, setHover] = React.useState(false);
  const accent = sessionType === 'claude' ? '#DA7756' : sessionType === 'codex' ? '#10A37F' : '#4E86F8';
  const accentBright = sessionType === 'claude' ? '#FF9466' : sessionType === 'codex' ? '#34d399' : '#7BA3FF';
  const defaultLabel = sessionType === 'claude' ? 'Claude' : sessionType === 'codex' ? 'Codex' : 'Gemini';

  // PTY matrix: Continue появляется когда сессия есть, но процесс мёртв.
  // SDK matrix: Continue не существует — нечего возобновлять (нет процесса
  // между turn'ами как концепта). idle всегда показывает defaultLabel.
  const sessionIdle = mode === 'pty' && hasAnySession && !isCommandRunning;
  const showStopOnHover = hover && isCommandRunning;
  // Start hover есть только в PTY mode. В SDK Start = «создать таб» — но
  // chip живёт ВНУТРИ уже созданного таба, кнопка-Start в этом контексте
  // бессмысленна.
  const showStartOnHover = mode === 'pty' && hover && !hasAnySession;

  const label = sessionIdle
    ? 'Continue'
    : showStopOnHover ? 'Stop'
    : showStartOnHover ? 'Start'
    : defaultLabel;
  const color = showStopOnHover
    ? '#ef4444'
    : sessionIdle || showStartOnHover ? accentBright : accent;

  const handleClick = () => {
    if (mode === 'sdk') {
      // SDK: Stop когда query живёт, фокус композера когда нет.
      if (isCommandRunning) onStop();
      else onContinue(); // в SDK onContinue === focus composer (см. ClaudeControlBar)
      return;
    }
    // PTY-классика.
    if (isCommandRunning) onStop();
    else if (!hasAnySession) onStart();
    else onContinue();
  };

  const idleTint = sessionType === 'claude' ? 'rgba(218,119,86,0.12)' : sessionType === 'codex' ? 'rgba(16,163,127,0.12)' : 'rgba(78,134,248,0.12)';
  const hoverTint = sessionType === 'claude' ? 'rgba(218,119,86,0.20)' : sessionType === 'codex' ? 'rgba(16,163,127,0.20)' : 'rgba(78,134,248,0.20)';
  const bg = showStopOnHover
    ? 'rgba(239, 68, 68, 0.18)'
    : sessionIdle ? (hover ? hoverTint : idleTint)
      : showStartOnHover ? hoverTint
      : (hover ? 'rgba(255,255,255,0.08)' : 'transparent');
  return (
    <span
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={handleClick}
      className="text-xs font-medium cursor-pointer relative inline-flex items-center justify-center"
      style={{
        color,
        width: 64,
        height: 18,
        backgroundColor: bg,
        transition: 'background-color 0.12s, color 0.12s',
        userSelect: 'none',
      }}
    >
      {label}
    </span>
  );
}
