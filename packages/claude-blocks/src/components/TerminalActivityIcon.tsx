import React from 'react';

/** The process indicator shared by History and external chat composers. */
export function TerminalActivityIcon({ size = 20, busy = false, color }: {
  size?: number;
  busy?: boolean;
  color?: string;
}) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden data-terminal-perimeter-loader={busy ? 'true' : undefined}
      style={{ display: 'block', flexShrink: 0, color }}>
      <rect x="1" y="2" width="18" height="16" rx="2" opacity={busy ? 0.32 : 1} />
      <path d="m5 7 2.5 2L5 11" />
      <path d="M10 12h5" />
      {busy && <circle className="cb-terminal-perimeter-loader-dot" r="1.1"
        fill="#d97706" stroke="none" opacity="0.78" />}
    </svg>
  );
}
