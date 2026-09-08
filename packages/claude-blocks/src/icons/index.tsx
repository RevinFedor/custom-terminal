/* ============================================================
   @noted/claude-blocks — ICONS
   ------------------------------------------------------------
   Иконки заинлайнены как SVG (геометрия из lucide-react), чтобы
   пакет НЕ зависел от icon-библиотеки. mobile-web не тянет
   lucide — поэтому встроенный SVG это единственный переносимый
   путь. Цвет берётся через `currentColor`, размер — проп `size`.
   ============================================================ */
import React from 'react';

export interface IconProps {
  size?: number;
  strokeWidth?: number;
  className?: string;
  style?: React.CSSProperties;
}

const base = (size: number, strokeWidth: number): React.SVGProps<SVGSVGElement> => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
});

export const TerminalIcon: React.FC<IconProps> = ({ size = 13, strokeWidth = 2, className, style }) => (
  <svg {...base(size, strokeWidth)} className={className} style={style}>
    <polyline points="4 17 10 11 4 5" />
    <line x1="12" y1="19" x2="20" y2="19" />
  </svg>
);

export const RotateCcwIcon: React.FC<IconProps> = ({ size = 11, strokeWidth = 2, className, style }) => (
  <svg {...base(size, strokeWidth)} className={className} style={style}>
    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
    <path d="M3 3v5h5" />
  </svg>
);

export const FileEditIcon: React.FC<IconProps> = ({ size = 13, strokeWidth = 2, className, style }) => (
  <svg {...base(size, strokeWidth)} className={className} style={style}>
    <path d="M4 13.5V4a2 2 0 0 1 2-2h8.5L20 7.5V20a2 2 0 0 1-2 2h-5.5" />
    <polyline points="14 2 14 8 20 8" />
    <path d="M10.42 12.61a2.1 2.1 0 1 1 2.97 2.97L7.95 21 4 22l.99-3.95 5.43-5.44Z" />
  </svg>
);

export const FileTextIcon: React.FC<IconProps> = ({ size = 13, strokeWidth = 2, className, style }) => (
  <svg {...base(size, strokeWidth)} className={className} style={style}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="16" y1="13" x2="8" y2="13" />
    <line x1="16" y1="17" x2="8" y2="17" />
    <line x1="10" y1="9" x2="8" y2="9" />
  </svg>
);

export const FolderSearchIcon: React.FC<IconProps> = ({ size = 13, strokeWidth = 2, className, style }) => (
  <svg {...base(size, strokeWidth)} className={className} style={style}>
    <path d="M10.7 4 9 2H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h7.5" />
    <path d="M16.5 16.5 21 21" />
    <circle cx="13.5" cy="13.5" r="3.5" />
  </svg>
);

export const SearchIcon: React.FC<IconProps> = ({ size = 13, strokeWidth = 2, className, style }) => (
  <svg {...base(size, strokeWidth)} className={className} style={style}>
    <circle cx="11" cy="11" r="8" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
);

export const GlobeIcon: React.FC<IconProps> = ({ size = 13, strokeWidth = 2, className, style }) => (
  <svg {...base(size, strokeWidth)} className={className} style={style}>
    <circle cx="12" cy="12" r="10" />
    <line x1="2" y1="12" x2="22" y2="12" />
    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
  </svg>
);

export const BrainIcon: React.FC<IconProps> = ({ size = 13, strokeWidth = 2, className, style }) => (
  <svg {...base(size, strokeWidth)} className={className} style={style}>
    <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z" />
    <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z" />
  </svg>
);

export const Loader2Icon: React.FC<IconProps> = ({ size = 14, strokeWidth = 2.75, className, style }) => (
  <svg {...base(size, strokeWidth)} className={className} style={style}>
    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
  </svg>
);

// Awaiting-approval indicator (gated tool call paused for the user). Triangle
// with a bang — distinct from the running spinner and the error icon.
export const AlertTriangleIcon: React.FC<IconProps> = ({ size = 14, strokeWidth = 2.5, className, style }) => (
  <svg {...base(size, strokeWidth)} className={className} style={style}>
    <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
    <line x1="12" y1="9" x2="12" y2="13" />
    <line x1="12" y1="17" x2="12.01" y2="17" />
  </svg>
);

export const CopyIcon: React.FC<IconProps> = ({ size = 11, strokeWidth = 2, className, style }) => (
  <svg {...base(size, strokeWidth)} className={className} style={style}>
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);

export const CheckIcon: React.FC<IconProps> = ({ size = 11, strokeWidth = 2, className, style }) => (
  <svg {...base(size, strokeWidth)} className={className} style={style}>
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

export const RefreshCwIcon: React.FC<IconProps> = ({ size = 11, strokeWidth = 2, className, style }) => (
  <svg {...base(size, strokeWidth)} className={className} style={style}>
    <polyline points="23 4 23 10 17 10" />
    <polyline points="1 20 1 14 7 14" />
    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
  </svg>
);

export const PencilIcon: React.FC<IconProps> = ({ size = 11, strokeWidth = 2, className, style }) => (
  <svg {...base(size, strokeWidth)} className={className} style={style}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </svg>
);

export const ScissorsIcon: React.FC<IconProps> = ({ size = 11, strokeWidth = 2, className, style }) => (
  <svg {...base(size, strokeWidth)} className={className} style={style}>
    <circle cx="6" cy="7" r="3" />
    <circle cx="6" cy="17" r="3" />
    <line x1="8.6" y1="8.5" x2="20" y2="15" />
    <line x1="8.6" y1="15.5" x2="20" y2="9" />
  </svg>
);

export const XIcon: React.FC<IconProps> = ({ size = 11, strokeWidth = 2, className, style }) => (
  <svg {...base(size, strokeWidth)} className={className} style={style}>
    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

/* Plug — the MCP glyph. External tool servers get their own icon so an MCP
   row never borrows the terminal icon (which made two thirds of the feed
   visually identical). Geometry from lucide `plug`. */
export const PlugIcon: React.FC<IconProps> = ({ size = 13, strokeWidth = 2, className, style }) => (
  <svg {...base(size, strokeWidth)} className={className} style={style}>
    <path d="M12 22v-5" />
    <path d="M9 8V2" />
    <path d="M15 8V2" />
    <path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" />
  </svg>
);

/* Git branch — the git-family glyph. Version-control commands are their own
   entity in the feed grammar (user decision: "git отдельно от прочего bash").
   Geometry from lucide `git-branch`. */
export const GitBranchIcon: React.FC<IconProps> = ({ size = 13, strokeWidth = 2, className, style }) => (
  <svg {...base(size, strokeWidth)} className={className} style={style}>
    <line x1="6" y1="3" x2="6" y2="15" />
    <circle cx="18" cy="6" r="3" />
    <circle cx="6" cy="18" r="3" />
    <path d="M18 9a9 9 0 0 1-9 9" />
  </svg>
);

/* Stack — the single, memorable mark of a COLLAPSED GROUP of work: several
   sheets seen edge-on. Deliberately unlike every family glyph (file, search,
   git branch, terminal, plug) so a group never reads as one of the cards it
   contains; the families themselves are named in words next to it. */
export const StackIcon: React.FC<IconProps> = ({ size = 13, strokeWidth = 2, className, style }) => (
  <svg {...base(size, strokeWidth)} className={className} style={style}>
    {/* Top sheet FILLED: a container reads "heavier" than the outline glyphs
        of atomic cards at a glance — same size, same column, zero layout
        shift. The two lower sheets stay strokes so the shape still reads as
        a stack, not a blob. */}
    <path d="M12 3 3 7.5l9 4.5 9-4.5L12 3z" fill="currentColor" stroke="none" />
    <path d="M3 12.5 12 17l9-4.5" />
    <path d="M3 17.5 12 22l9-4.5" />
  </svg>
);

/* Compress — the context-compaction glyph: two chevrons folding toward the
   middle line (history squeezed into a summary). A real mark in the shared
   icon column — the row used to wear a bare disclosure chevron, which is a
   control, not an identity. */
export const CompressIcon: React.FC<IconProps> = ({ size = 13, strokeWidth = 2, className, style }) => (
  <svg {...base(size, strokeWidth)} className={className} style={style}>
    <path d="m7 2 5 5 5-5" />
    <line x1="4" y1="12" x2="20" y2="12" />
    <path d="m7 22 5-5 5 5" />
  </svg>
);

/* Checklist — the Plan/task-plan glyph. Plan is not a shell command; wearing
   the terminal icon lied about what the row is. */
export const ChecklistIcon: React.FC<IconProps> = ({ size = 13, strokeWidth = 2, className, style }) => (
  <svg {...base(size, strokeWidth)} className={className} style={style}>
    <path d="m3 5 2 2 3.5-3.5" />
    <path d="m3 12 2 2 3.5-3.5" />
    <line x1="12" y1="6" x2="21" y2="6" />
    <line x1="12" y1="13" x2="21" y2="13" />
    <line x1="12" y1="20" x2="21" y2="20" />
    <path d="M4 19h.01" />
  </svg>
);

/* Sparkles — the "applied prompt / AI instruction" glyph. Same geometry as the
   desktop prompt-chip (voice-record prompt.tsx ChipIcon kind='prompt') so a
   prompt chip looks identical on desktop and mobile. */
/* Chevron — expand affordance (rotates 90° via CSS when open). */
export const ChevronRightIcon: React.FC<IconProps> = ({ size = 11, strokeWidth = 2, className, style }) => (
  <svg {...base(size, strokeWidth)} className={className} style={style}>
    <polyline points="9 18 15 12 9 6" />
  </svg>
);

export const SparklesIcon: React.FC<IconProps> = ({ size = 14, strokeWidth = 2, className, style }) => (
  <svg {...base(size, strokeWidth)} className={className} style={style}>
    <path d="M12 3l1.9 4.6L18.5 9.5 13.9 11.4 12 16l-1.9-4.6L5.5 9.5l4.6-1.9z" />
    <path d="M19 14l.7 1.8L21.5 16.5l-1.8.7L19 19l-.7-1.8L16.5 16.5l1.8-.7z" />
  </svg>
);

/* Per-tool icon resolver — имя tool'а → React-нода. Цвет/размер
   переопределяются обёрткой ColoredToolIcon (clone в blocks).

   `family` (optional) is the parser-stamped grouping family — it refines the
   icon beyond the tool name: a Bash that actually reads gets the file icon,
   a searching Bash the magnifier, git its branch glyph, MCP the plug. The
   shape carries the MEANING of the action; color stays the status channel. */
export function toolIcon(name: string, size = 13, family?: string): React.ReactNode {
  if (name.startsWith('mcp__') || name === 'MCP' || family === 'mcp') {
    return <PlugIcon size={size} />;
  }
  switch (family) {
    case 'plan':
      return <ChecklistIcon size={size} />;
    case 'group':
    case 'mixed':
      // Every collapsed run of work wears this one glyph, whatever families
      // are inside: the row's identity is "a group you can open", and the
      // families are already spelled out in words beside it.
      return <StackIcon size={size} />;
    case 'read':
      return <FileTextIcon size={size} />;
    case 'search':
      return <SearchIcon size={size} />;
    case 'git':
      return <GitBranchIcon size={size} />;
    case 'edit':
      return <FileEditIcon size={size} />;
    case 'web':
      return <GlobeIcon size={size} />;
    default:
      break;
  }
  switch (name) {
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
      return <FileEditIcon size={size} />;
    case 'Read':
      return <FileTextIcon size={size} />;
    case 'Bash':
      return <TerminalIcon size={size} />;
    case 'Glob':
      return <FolderSearchIcon size={size} />;
    case 'Grep':
      return <SearchIcon size={size} />;
    case 'WebSearch':
    case 'WebFetch':
      return <GlobeIcon size={size} />;
    default:
      return <TerminalIcon size={size} />;
  }
}
