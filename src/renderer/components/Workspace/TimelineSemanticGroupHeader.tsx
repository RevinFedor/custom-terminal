import React from 'react';
import { ChevronDown } from 'lucide-react';
// The same ordinary header body serves the array and indexed Timeline owners.
export function TimelineSemanticGroupHeader({ title, count, expanded, hovered = false, cmdHeld = false,
  searchMatch = false, elementRef, onToggle, onMouseEnter, onMouseLeave }: {
  title: string; count: number; expanded: boolean; hovered?: boolean; cmdHeld?: boolean; searchMatch?: boolean;
  elementRef?: React.Ref<HTMLDivElement>; onToggle: () => void;
  onMouseEnter?: React.MouseEventHandler; onMouseLeave?: React.MouseEventHandler;
}) {
  return (
    <div
      data-history-search-match={searchMatch ? 'true' : undefined}
      ref={elementRef}
      className="relative w-full flex items-center select-none"
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 6,
        flex: '0 0 auto',
        minHeight: 30,
        padding: '5px 6px 5px 2px',
        gap: 4,
        alignItems: 'flex-start',
        cursor: 'pointer',
        borderTop: '1px solid rgba(192,132,252,0.18)',
        boxShadow: searchMatch ? 'inset 3px 0 #eab308' : undefined,
        borderBottom: '1px solid rgba(192,132,252,0.12)',
        background: hovered
          ? 'linear-gradient(90deg, rgba(217,70,239,0.18), rgba(139,92,246,0.11)), #18131d'
          : 'linear-gradient(90deg, rgba(217,70,239,0.11), rgba(139,92,246,0.07)), #18131d',
      }}
      title={cmdHeld ? undefined : '⌘ + hover — описание группы'}
      onClick={event => { event.stopPropagation(); onToggle(); }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <ChevronDown
        size={12}
        style={{
          color: '#d8b4fe',
          flexShrink: 0,
          marginTop: 1,
          transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)',
          transition: 'transform 120ms ease-out',
        }}
      />
      <span
        className="min-w-0 flex-1"
        style={{
          color: '#f5d0fe',
          fontSize: 11,
          fontWeight: 700,
          lineHeight: 1.25,
          overflow: 'visible',
          whiteSpace: 'normal',
          overflowWrap: 'anywhere',
        }}
      >
        {title}
      </span>
      <span style={{ color: 'rgba(216,180,254,0.7)', fontSize: 9, fontFamily: 'monospace', flexShrink: 0, marginTop: 2 }}>
        {count}
      </span>
    </div>
  );
}
