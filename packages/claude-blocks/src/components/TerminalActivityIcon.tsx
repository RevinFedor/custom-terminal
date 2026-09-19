import React from 'react';

/** The process indicator shared by History and external chat composers. */
export function TerminalActivityIcon({ size = 20, busy = false, color }: {
  size?: number;
  busy?: boolean;
  color?: string;
}) {
  return (
    <span className="cb-terminal-activity-icon" aria-hidden
      data-terminal-perimeter-loader={busy ? 'true' : undefined}
      style={{ width: size, height: size, fontSize: size, color }}>
      <svg width={size} height={size} viewBox="0 0 20 20" fill="none"
        stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="1" y="2" width="18" height="16" rx="2" opacity={busy ? 0.32 : 1} />
        <path d="m5 7 2.5 2L5 11" />
        <path d="M10 12h5" />
      </svg>
      {/* A transformed HTML dot can be composited independently. Animating an
          SVG child (even with transform) makes Chromium lay out its SVG every
          frame, then revisit the retained History layers around it. */}
      {busy && <span className="cb-terminal-perimeter-loader-dot" />}
    </span>
  );
}
