import React from 'react';

// Idle:                 shows "Claude" / "Gemini" (the tab's AI label)
// Hover, no process:    shows "Continue"  → resume session
// Hover, process alive: shows "Stop"      → send Ctrl+C
// Click: invokes Continue/Stop. The default label is also clickable — copies
// the session ID (preserves old behaviour where clicking "Claude" copied the UUID).
// The session ID tooltip floats above the chip on hover.
export default function SessionActionChip({
  sessionType, sessionId, isCommandRunning, hasAnySession,
  onContinue, onStop, onCopyId,
}: {
  sessionType: 'claude' | 'gemini' | null;
  sessionId: string | null;
  isCommandRunning: boolean;
  hasAnySession: boolean;
  onContinue: () => void;
  onStop: () => void;
  onCopyId: () => void;
}) {
  const [hover, setHover] = React.useState(false);
  const accent = sessionType === 'claude' ? '#DA7756' : '#4E86F8';
  const accentBright = sessionType === 'claude' ? '#FF9466' : '#7BA3FF';
  const defaultLabel = sessionType === 'claude' ? 'Claude' : 'Gemini';
  const sessionIdle = hasAnySession && !isCommandRunning;
  const showStopOnHover = hover && isCommandRunning;
  const label = sessionIdle ? 'Continue' : (showStopOnHover ? 'Stop' : defaultLabel);
  const color = showStopOnHover ? '#ef4444' : (sessionIdle ? accentBright : accent);

  const handleClick = () => {
    if (!hasAnySession) { onCopyId(); return; }
    if (isCommandRunning) onStop();
    else onContinue();
  };

  const idleTint = sessionType === 'claude' ? 'rgba(218,119,86,0.12)' : 'rgba(78,134,248,0.12)';
  const hoverTint = sessionType === 'claude' ? 'rgba(218,119,86,0.20)' : 'rgba(78,134,248,0.20)';
  const bg = showStopOnHover
    ? 'rgba(239, 68, 68, 0.18)'
    : sessionIdle ? (hover ? hoverTint : idleTint)
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
