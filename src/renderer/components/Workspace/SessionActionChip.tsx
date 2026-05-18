import React from 'react';

// State matrix (single button, label morphs on state + hover):
//   No session at all       → label "Claude" / "Gemini" (tinted), hover → "Start", click → onStart
//   Session in DB, no proc  → label "Continue", click → onContinue (resume)
//   Session live (process)  → label "Claude"/"Gemini" idle, hover → "Stop", click → onStop
//
// sessionType is required (never null) — caller decides which AI the chip
// represents when no session exists yet (e.g. fall back to commandType or
// default 'claude'). Старая ветка `onCopyId` для безсессионного клика убрана:
// «копировать пустой id» — мёртвая операция, юзер хотел стартовать процесс.
export default function SessionActionChip({
  sessionType, isCommandRunning, hasAnySession,
  onStart, onContinue, onStop,
}: {
  sessionType: 'claude' | 'gemini';
  isCommandRunning: boolean;
  hasAnySession: boolean;
  onStart: () => void;
  onContinue: () => void;
  onStop: () => void;
}) {
  const [hover, setHover] = React.useState(false);
  const accent = sessionType === 'claude' ? '#DA7756' : '#4E86F8';
  const accentBright = sessionType === 'claude' ? '#FF9466' : '#7BA3FF';
  const defaultLabel = sessionType === 'claude' ? 'Claude' : 'Gemini';

  const sessionIdle = hasAnySession && !isCommandRunning;
  const showStopOnHover = hover && isCommandRunning;
  const showStartOnHover = hover && !hasAnySession;

  const label = sessionIdle
    ? 'Continue'
    : showStopOnHover ? 'Stop'
    : showStartOnHover ? 'Start'
    : defaultLabel;
  const color = showStopOnHover
    ? '#ef4444'
    : sessionIdle || showStartOnHover ? accentBright : accent;

  const handleClick = () => {
    if (!hasAnySession) { onStart(); return; }
    if (isCommandRunning) onStop();
    else onContinue();
  };

  const idleTint = sessionType === 'claude' ? 'rgba(218,119,86,0.12)' : 'rgba(78,134,248,0.12)';
  const hoverTint = sessionType === 'claude' ? 'rgba(218,119,86,0.20)' : 'rgba(78,134,248,0.20)';
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
