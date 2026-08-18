// The strip of tab chips in a window's header.
//
// A window used to show one tab, so its header named that tab. It now holds a
// LIST with one of them shown, and this draws the list: project icon per RUN of
// same-project chips, the chips themselves, and — instead of a scrollbar — a
// count of what has scrolled out of sight on each side.
//
// Юзер: *«если будет много вкладок горизонтальный скролл. Скролл не показывать,
// это он будет ещё высоту занимать, показывать вместо этого слева либо справа
// +1, +2… ограничения по ширине во вкладке нет и не будет»*.
//
// The arithmetic of both rules lives in paneStripLayout.mjs, so it can be held
// by tests without a DOM; this file owns only how it is drawn and what the
// gestures do.

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useProjectsStore } from '../../store/useProjectsStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { isInboxProjectId, INBOX_PROJECT_NAME } from '../../constants/systemProjects';
import { groupStripByProject, resolveStripOverflow, scrollOffsetForChip } from '../../utils/paneStripLayout.mjs';
import PaneTabChip from './PaneTabChip';

export interface StripEntry { projectId: string; tabId: string }

/** The project icon that labels a RUN of chips. Inert — it is a label. */
function StripProjectIcon({ projectId }: { projectId: string }) {
  const meta = useProjectsStore((s) => s.projects[projectId]);
  const path = useWorkspaceStore((s) => s.openProjects.get(projectId)?.projectPath || '');
  const name = meta?.name
    || (isInboxProjectId(projectId) ? INBOX_PROJECT_NAME : null)
    || path.split('/').filter(Boolean).pop()
    || 'Project';
  return (
    <span
      data-strip-project-icon={projectId}
      title={name + (path ? `\n${path}` : '')}
      // Иконка — подпись группы чипов, а не пустое место полосы: двойной клик по
      // ней означал бы «ещё одну вкладку сюда», хотя человек целился в метку.
      onDoubleClick={(e) => e.stopPropagation()}
      style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}
    >
      {meta?.icon ? (
        <img
          src={meta.icon}
          alt=""
          draggable={false}
          style={{ width: 12, height: 12, borderRadius: 2, objectFit: 'cover', flexShrink: 0, opacity: 0.65 }}
        />
      ) : (
        // No icon set (or Inbox): the same dashed placeholder square as the
        // titlebar card, so the header never reads as "icon failed to load"
        // and the chip's left edge does not shift between projects.
        <span
          aria-hidden
          style={{
            width: 12,
            height: 12,
            borderRadius: 2,
            flexShrink: 0,
            border: '1px dashed rgba(148,163,184,0.8)',
            background: 'rgba(148,163,184,0.08)',
          }}
        />
      )}
    </span>
  );
}

/** «+N» — chips that scrolled fully out of view on one side. */
function StripOverflowCount({ side, count, onClick }: {
  side: 'left' | 'right';
  count: number;
  onClick: () => void;
}) {
  if (count <= 0) return null;
  return (
    <button
      type="button"
      data-strip-overflow={side}
      title={`Ещё ${count} ${count === 1 ? 'вкладка' : 'вкладок'} ${side === 'left' ? 'слева' : 'справа'} — клик прокрутит`}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      // Двойной клик по счётчику — это два клика прокрутки, а не «ещё одна
      // вкладка сюда»: жест полосы принадлежит её ПУСТОМУ месту, а здесь стоит
      // кнопка. Без этого быстрая двойная прокрутка молча создавала вкладку.
      onDoubleClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        flexShrink: 0,
        padding: '0 4px',
        height: 14,
        lineHeight: '14px',
        fontSize: 10,
        fontWeight: 600,
        color: '#9b9ba1',
        background: 'rgba(255,255,255,0.06)',
        border: 'none',
        borderRadius: 3,
        cursor: 'pointer',
        userSelect: 'none',
      }}
    >
      +{count}
    </button>
  );
}

export interface PaneTabStripProps {
  entries: StripEntry[];
  /** The tab filling the window — exactly one of `entries`. */
  shownTabId: string;
  paneIndex: number | null;
  inSplit: boolean;
  /** Double-click on empty space in the strip: one more tab in THIS window. */
  onCreateTab: () => void;
}

export default function PaneTabStrip({
  entries, shownTabId, paneIndex, inSplit, onCreateTab,
}: PaneTabStripProps) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [overflow, setOverflow] = useState({ hiddenLeft: 0, hiddenRight: 0 });
  const inStrip = entries.length > 1;

  const measure = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const chips = Array.from(el.querySelectorAll<HTMLElement>('[data-strip-item]'))
      .map((node) => ({ left: node.offsetLeft, width: node.offsetWidth }));
    const next = resolveStripOverflow({
      chips,
      scrollLeft: el.scrollLeft,
      viewportWidth: el.clientWidth,
    });
    setOverflow((prev) => (
      prev.hiddenLeft === next.hiddenLeft && prev.hiddenRight === next.hiddenRight ? prev : next
    ));
  }, []);

  // Measured after layout, not on a timer: the counts are a statement about what
  // is on screen RIGHT NOW, and a frame of "+0" while the numbers catch up reads
  // as "nothing is hidden" — the one thing they exist to deny.
  useLayoutEffect(measure, [measure, entries.length, shownTabId]);
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  // The SHOWN chip must be legible: the window's content is that tab, so a header
  // where its chip has scrolled away contradicts what is underneath it. Only
  // matters when the change came from elsewhere (sidebar, Ctrl+Tab, a closing
  // neighbour) — a click on a visible chip moves nothing, by construction.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el || !inStrip) return;
    const node = el.querySelector<HTMLElement>(`[data-strip-item][data-strip-tab-id="${CSS.escape(shownTabId)}"]`);
    if (!node) return;
    const next = scrollOffsetForChip({
      chip: { left: node.offsetLeft, width: node.offsetWidth },
      scrollLeft: el.scrollLeft,
      viewportWidth: el.clientWidth,
    });
    if (next !== el.scrollLeft) { el.scrollLeft = next; measure(); }
  }, [shownTabId, inStrip, measure]);

  const runs = groupStripByProject(entries);
  const indexOfTab = new Map(entries.map((entry, i) => [entry.tabId, i]));

  const scrollBy = (direction: -1 | 1) => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollLeft += direction * Math.max(80, el.clientWidth * 0.6);
    measure();
  };

  return (
    <div
      data-pane-tab-strip
      // The empty space right of the last chip belongs to the STRIP, so the
      // double-click that means "one more tab here" has somewhere to land even
      // when the chips do not fill the row. It is also why this wrapper — not
      // the scroller — carries the gesture: the scroller's empty area is inside
      // its content box only while the content is narrower than the viewport.
      onDoubleClick={(e) => {
        // A double-click ON a chip is that chip's rename; it stops there.
        e.stopPropagation();
        onCreateTab();
      }}
      style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0, flex: 1 }}
    >
      <StripOverflowCount side="left" count={overflow.hiddenLeft} onClick={() => scrollBy(-1)} />
      <div
        ref={scrollerRef}
        data-pane-tab-strip-scroller
        onScroll={measure}
        // Wheel over the strip scrolls it sideways: the row is one line tall and
        // there is nothing to scroll vertically here, so a vertical wheel that
        // did nothing would read as a dead surface.
        onWheel={(e) => {
          const el = scrollerRef.current;
          if (!el || el.scrollWidth <= el.clientWidth) return;
          const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
          if (!delta) return;
          e.preventDefault();
          e.stopPropagation();
          el.scrollLeft += delta;
          measure();
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          minWidth: 0,
          flex: 1,
          overflowX: 'auto',
          overflowY: 'hidden',
          // No visible bar: the counts on either side say the same thing in a
          // line that is already there. See the header note.
          scrollbarWidth: 'none',
        }}
      >
        {runs.map((run, runIndex) => (
          <React.Fragment key={`${run.projectId}:${runIndex}`}>
            <StripProjectIcon projectId={run.projectId} />
            {run.tabIds.map((tabId) => (
              <span
                key={tabId}
                data-strip-item
                data-strip-tab-id={tabId}
                style={{ display: 'inline-flex', minWidth: 0 }}
              >
                <PaneTabChip
                  projectId={run.projectId}
                  tabId={tabId}
                  shown={tabId === shownTabId}
                  paneIndex={paneIndex}
                  inSplit={inSplit}
                  index={indexOfTab.get(tabId) ?? 0}
                  inStrip={inStrip}
                />
              </span>
            ))}
          </React.Fragment>
        ))}
      </div>
      <StripOverflowCount side="right" count={overflow.hiddenRight} onClick={() => scrollBy(1)} />
    </div>
  );
}
