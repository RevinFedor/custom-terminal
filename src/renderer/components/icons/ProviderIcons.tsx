// Brand glyphs for LLM providers shown in the InfoPanel "КОНТРОЛЬ" header.
// Geometric symbols only — kept inline so they tint via `fill={color}` and don't
// pull in an icon library. ClaudeSparkle stays in CopySessionButton.tsx (older
// import site); the other two live here so future providers go to one file.

import React from 'react';

// DeepSeek — whale-silhouette wordmark. Approximated stylized "D" with whale curve
// using path geometry that fits a 100×100 box. Brand color #4D6BFE.
export function DeepSeekIcon({ size = 12, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" style={{ display: 'inline-block', flexShrink: 0 }}>
      <path
        fill={color}
        d="M27 9c-.7-.3-1 .4-1.4.8-.1.1-.3.3-.4.5-1-1-2.3-1.7-3.7-2.2-.6-.2-1.2-.3-1.8-.3-1.4-.2-2.8 0-4 .9-.3.3-.7.4-.7.8.2.4.7.3 1 .4 1.2.3 2.4.6 3.4 1.3.3.2.5.4.7.7-.5.7-.9 1.4-1.1 2.2-.3 1-.1 2 .3 2.9-.6.5-.7 1.2-.4 2 .4 1.1 1.4 1.8 2.6 1.9 1.4.2 2.5-.4 2.7-1.8 0-.4.1-.7.1-1 0-.5-.3-1-.6-1.2-.2-.2-.4-.4-.4-.7l.5-.5c.7-.7.6-1.7 0-2.3-.6-.6-1.5-.6-2.2 0l-.7.6c-.3 0-.5-.3-.8-.4-.4-.3-.7-.7-.9-1.2-.6-1.5-.3-3 .8-4.2.1-.1.3-.2.3-.5z M14 25c-3-.8-5.5-2.5-7.2-5.2-2-3-2.4-6.3-1-9.7C6.5 7.5 8.7 6 11.5 5.5c.5-.1 1-.1 1.5-.1.4 0 .5-.1.6-.5.2-.5.7-.7 1.2-.9.7-.3 1.5-.4 2.3-.4h.8c1.4.2 2.8.6 4 1.3.1 0 .2 0 .2.1 0 .1-.1.1-.2.1H21c-.9 0-1.7.2-2.5.5-.4.2-.8.5-1.1.8-.2.3-.4.2-.7.1-1.4-.7-3-.7-4.4-.2-1.6.5-2.9 1.5-3.7 3-.2.4-.4.8-.6 1.3-.3 1.1-.4 2.2-.2 3.3.3 1.5 1 2.7 2.1 3.7 1 1 2.1 1.6 3.4 2 1 .3 2 .4 3 .3.4 0 .8-.1 1.2-.2.2 0 .4-.1.5-.3.5-.5 1.1-.8 1.7-1 1.3-.5 2.7-.5 4-.1.4.1.8.2 1.1.4l.4.2c.1.2-.1.3-.2.4-.5.4-1 .6-1.6.7-1.1.3-2.2.3-3.3.1-.5-.1-.9-.3-1.3-.5-.5-.2-.9-.1-1 .4 0 .4-.2.4-.5.5l-.3.1c-.5.2-1 .3-1.5.3-.8.1-1.5 0-2-.2z"
      />
    </svg>
  );
}

// Zen / OpenCode — circular dot inside ring (zen-circle motif).
// Keep it abstract because Zen has no official symbol mark, just a wordmark.
export function ZenIcon({ size = 12, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" style={{ display: 'inline-block', flexShrink: 0 }}>
      <circle cx="12" cy="12" r="9" fill="none" stroke={color} strokeWidth="2" />
      <circle cx="12" cy="12" r="3" fill={color} />
    </svg>
  );
}
