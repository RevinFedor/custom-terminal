// The "create a tab" rows shared by both right-click menus:
//
//   • sidebar tab list, empty space  → TabBar's empty-space menu;
//   • window strip, empty space      → PaneTabStrip's new-tab menu.
//
// One component because the user reads them as ONE menu that happens to open
// in two places: same width, same icons, same labels. The leading icon is the
// same 11px square the tab cards use (brand tints from tabChrome, never
// re-declared), and the terminal row shows a terminal glyph instead of a "+" —
// every row here creates something, so a plus said nothing while the other
// rows already showed WHAT gets created. Labels dropped the word "New" for the
// same reason.
//
// The sidebar variant splits each row in two:
//   left  — creates the tab where this menu's default puts it;
//   right — a narrow zone behind a hairline; hovering it opens the same
//           window-layout flyout as "Move to window", and picking a window
//           creates the tab straight into that window's strip.
// The strip variant has no right zone at all: that menu already belongs to one
// concrete window, so asking "which window?" would repeat the click's answer.

import React from 'react';
import { createPortal } from 'react-dom';
import { SquareTerminal, Columns2 } from 'lucide-react';
import SideFlyout from '../UI/SideFlyout';
import {
  CONTEXT_MENU_ICON_SLOT_STYLE,
  CONTEXT_MENU_METRICS,
  CONTEXT_MENU_ROW_STYLE,
} from '../UI/contextMenuMetrics.mjs';
import { WindowLayoutPicker, type WindowCell } from './MoveToWindowMenu';
import { TAB_COLORS } from './tabChrome';

export type NewTabAction = 'terminal' | 'claude' | 'codex';

const FLYOUT_GAP_PX = 4;
const FLYOUT_Z_INDEX = 100060;
const WINDOW_ZONE_WIDTH_PX = 28;

const ROWS: Array<{ action: NewTabAction; label: string }> = [
  { action: 'terminal', label: 'Terminal tab' },
  { action: 'claude', label: 'Claude tab' },
  { action: 'codex', label: 'Codex tab' },
];

const brandColor = (color: string, fallback: string) => (
  TAB_COLORS.find((entry) => entry.color === color)?.borderColor || fallback
);

/** Same 11px rounded square the tab cards use — the row previews the tab. */
const AgentSquare: React.FC<{ color: string }> = ({ color }) => (
  <span
    style={{
      width: 11,
      height: 11,
      borderRadius: 3,
      backgroundColor: color,
      border: `1px solid ${color}`,
    }}
  />
);

const rowIcon = (action: NewTabAction) => {
  if (action === 'terminal') {
    return <SquareTerminal size={12} strokeWidth={1.8} className="text-[#888]" />;
  }
  if (action === 'claude') return <AgentSquare color={brandColor('claude', '#DA7756')} />;
  return <AgentSquare color={brandColor('codex', '#10A37F')} />;
};

const pointInside = (x: number, y: number, rect: DOMRect, tolerance = 2) => (
  x >= rect.left - tolerance
  && x <= rect.right + tolerance
  && y >= rect.top - tolerance
  && y <= rect.bottom + tolerance
);

export interface NewTabMenuRowsProps {
  /** Left zone: create the tab where this menu's default places it. */
  onCreate: (action: NewTabAction) => void;
  /**
   * Right zone: create the tab straight into the picked window. Omit it and
   * the rows have no right zone at all.
   */
  onCreateInWindow?: (action: NewTabAction, target: WindowCell) => void;
  /** Follows the host menu's submenu side so every flyout opens the same way. */
  preferredSide?: 'left' | 'right';
  /** Existing per-menu data attributes stay: e2e addresses rows through them. */
  rowAttributes?: (action: NewTabAction) => Record<string, string>;
}

export default function NewTabMenuRows({
  onCreate,
  onCreateInWindow,
  preferredSide,
  rowAttributes,
}: NewTabMenuRowsProps) {
  const [pickerFor, setPickerFor] = React.useState<NewTabAction | null>(null);
  const triggerRefs = React.useRef<Partial<Record<NewTabAction, HTMLButtonElement | null>>>({});
  const flyoutRef = React.useRef<HTMLDivElement | null>(null);

  const getAnchorRect = React.useCallback(
    () => (pickerFor ? triggerRefs.current[pickerFor]?.getBoundingClientRect() || null : null),
    [pickerFor],
  );

  // The flyout is a portal, so DOM ancestry cannot answer "did the mouse
  // leave" — the same geometric guard MoveToWindowMenu uses owns closing.
  React.useEffect(() => {
    if (!pickerFor) return undefined;
    const onMove = (event: MouseEvent) => {
      const trigger = triggerRefs.current[pickerFor]?.getBoundingClientRect();
      const flyout = flyoutRef.current?.getBoundingClientRect();
      // The first move can arrive before the portal measured itself; wait for
      // both boxes instead of closing from incomplete geometry.
      if (!trigger || !flyout) return;
      if (
        pointInside(event.clientX, event.clientY, trigger)
        || pointInside(event.clientX, event.clientY, flyout)
      ) return;
      setPickerFor(null);
    };
    window.addEventListener('mousemove', onMove, true);
    return () => window.removeEventListener('mousemove', onMove, true);
  }, [pickerFor]);

  return (
    <>
      {ROWS.map(({ action, label }) => (
        <div
          key={action}
          data-context-menu-row="ordinary"
          style={{
            display: 'flex',
            alignItems: 'stretch',
            height: CONTEXT_MENU_METRICS.rowHeight,
          }}
        >
          <button
            type="button"
            role="menuitem"
            {...(rowAttributes ? rowAttributes(action) : {})}
            // Background lives in classes only: an inline background would win
            // over the hover variant and leave the row without hover feedback.
            className="text-left text-[13px] text-[#ccc] bg-transparent hover:bg-white/10 cursor-pointer flex items-center"
            style={{
              ...CONTEXT_MENU_ROW_STYLE,
              flex: 1,
              minWidth: 0,
              border: 0,
            }}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onCreate(action);
            }}
          >
            <span style={CONTEXT_MENU_ICON_SLOT_STYLE}>{rowIcon(action)}</span>
            {label}
          </button>
          {onCreateInWindow && (
            <button
              ref={(node) => { triggerRefs.current[action] = node; }}
              type="button"
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={pickerFor === action}
              aria-label={`${label} — в выбранное окно`}
              data-new-tab-window-zone={action}
              className="cursor-pointer bg-transparent hover:bg-white/10 flex items-center justify-center"
              style={{
                width: WINDOW_ZONE_WIDTH_PX,
                flex: `0 0 ${WINDOW_ZONE_WIDTH_PX}px`,
                border: 0,
                borderLeft: `1px solid ${CONTEXT_MENU_METRICS.dividerColor}`,
                // Open state pins the highlight inline (inline wins over the
                // hover class on purpose: the flyout is open, the zone reads
                // as pressed even when the mouse is inside the flyout).
                ...(pickerFor === action ? { background: 'rgba(255,255,255,0.10)' } : {}),
                color: pickerFor === action ? '#ccc' : '#777',
              }}
              onMouseDown={(e) => e.stopPropagation()}
              // Hover opens; a click only pins what hover already shows, so a
              // fast click cannot land between states.
              onMouseEnter={() => setPickerFor(action)}
              onFocus={() => setPickerFor(action)}
              onClick={(e) => {
                e.stopPropagation();
                setPickerFor(action);
              }}
            >
              <Columns2 size={12} />
            </button>
          )}
        </div>
      ))}

      {pickerFor && onCreateInWindow && createPortal(
        <SideFlyout
          ref={flyoutRef}
          data-new-tab-window-flyout={pickerFor}
          role="menu"
          getAnchorRect={getAnchorRect}
          side={preferredSide || 'right'}
          gap={FLYOUT_GAP_PX}
          edgePadding={CONTEXT_MENU_METRICS.viewportInset}
          zIndex={FLYOUT_Z_INDEX}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <WindowLayoutPicker
            mode="move"
            onPickWindow={(target) => {
              // Snapshot before closing: state is null after setPickerFor.
              const action = pickerFor;
              setPickerFor(null);
              if (action) onCreateInWindow(action, target);
            }}
            onDone={() => setPickerFor(null)}
          />
        </SideFlyout>,
        document.body,
      )}
    </>
  );
}
