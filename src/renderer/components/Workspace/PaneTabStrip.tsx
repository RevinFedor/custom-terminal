// Wrapped tab chips in a workflow window. Execution namespaces remain routing
// metadata; they do not add directory badges or extra spacing to the strip.

import {uiDragDiagnostic} from '../../utils/uiPerformanceDiagnostics.mjs';
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { dropTargetForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { groupStripByProject, paneStripRenderItems } from '../../utils/paneStripLayout.mjs';
import PaneTabChip from './PaneTabChip';
import PaneChooserChip from './PaneChooserChip';
import { TAB_STRIP_ROW_GAP } from '../../utils/tabCardVisual.mjs';
import { moveEntriesToIndex } from '../../utils/horizontalReorder.mjs';
import {
  beginPaneTabDrag,
  endPaneTabDrag,
  getPaneTabDragSnapshot,
  paneStripKey,
  paneTabSourceFromDragData,
  PANE_TAB_DND_TYPE,
  resolvePaneTabDropTarget,
  setPaneTabDragTarget,
  usePaneTabDragSnapshot,
} from '../../utils/paneTabDragBridge';
import { commitPaintedPaneTabDrop } from '../../utils/paneTabDropCommit';
import { useHorizontalOrderPreview } from '../../hooks/useHorizontalOrderPreview';
import type { SharedTabActivityMaps } from './TabSignals';
import { clampMenuToViewport } from '../../utils/menuViewportClamp.mjs';
import { splitPanesFingerprint } from '../../utils/splitPanesModel.mjs';
import {
  CONTEXT_MENU_PANEL_STYLE,
} from '../UI/contextMenuMetrics.mjs';
import NewTabMenuRows from './NewTabMenuRows';

export interface StripEntry { projectId: string; tabId: string }

export interface PaneTabStripProps {
  entries: StripEntry[];
  /** The tab filling the window — exactly one of `entries`. */
  shownTabId: string;
  /** Keyboard focus; each window highlights its own shown tab independently. */
  focused: boolean;
  paneIndex: number | null;
  inSplit: boolean;
  /** Double-click on empty space in the strip: one more tab in THIS window. */
  onCreateTab: () => void;
  /** App-wide tab activity maps from Workspace; stable across workflow switches. */
  sharedActivity?: SharedTabActivityMaps | null;
  /**
   * МЕСТА окна по порядку: чипы вкладок и открытые страницы выбора вместе.
   *
   * Полоса рисует их одной строкой, но порядок вкладок продолжает приходить в
   * `entries` — во время перетаскивания он отличается от сохранённого, и
   * читать порядок отсюда значило бы рисовать полосу до жеста. Пусто/не задано
   * = окно без заготовок, то есть ровно прежнее поведение.
   */
  slots?: Array<{ projectId?: string; tabId?: string; slotId?: string }>;
  /** Какая страница выбора сейчас показана в этом окне. */
  selectedSlotId?: string;
}

export default function PaneTabStrip({
  entries, shownTabId, focused, paneIndex, inSplit, onCreateTab,
  sharedActivity = null, slots, selectedSlotId = '',
}: PaneTabStripProps) {
  const stripRootRef = useRef<HTMLDivElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const activeSpaceId = useWorkspaceStore((s) => s.activeSpaceId);
  const paneKey = paneStripKey(paneIndex);
  const paneDrag = usePaneTabDragSnapshot();
  const baseEntriesKey = entries.map((entry) => `${entry.projectId}:${entry.tabId}`).join('|');
  const baseIds = React.useMemo(() => entries.map((entry) => entry.tabId), [baseEntriesKey]);
  const horizontalPreview = useHorizontalOrderPreview(
    baseIds,
    scrollerRef,
    '[data-strip-item]',
    'data-strip-tab-id',
    { animate: false },
  );
  const desiredPreviewEntries = React.useMemo(() => {
    if (!paneDrag.active || !paneDrag.source || paneDrag.target?.paneKey !== paneKey
      || paneDrag.target?.spaceId !== activeSpaceId) return null;
    return moveEntriesToIndex(entries, paneDrag.source.entries, paneDrag.target.at);
  }, [baseEntriesKey, paneDrag.active, paneDrag.revision, paneDrag.source, paneDrag.target, paneKey, activeSpaceId]);
  useLayoutEffect(() => {
    horizontalPreview.updatePreview(desiredPreviewEntries?.map((entry) => entry.tabId) || null);
  }, [desiredPreviewEntries, horizontalPreview.updatePreview]);
  const entryById = React.useMemo(() => {
    const out = new Map(entries.map((entry) => [entry.tabId, entry]));
    paneDrag.source?.entries.forEach((entry) => out.set(entry.tabId, entry));
    return out;
  }, [baseEntriesKey, paneDrag.source]);
  const previewEntries = horizontalPreview.displayedIds
    .map((tabId) => entryById.get(tabId))
    .filter((entry): entry is StripEntry => !!entry);
  const baseEntryIds = React.useMemo(() => new Set(entries.map((entry) => entry.tabId)), [entries]);
  const entriesKey = previewEntries.map((entry) => `${entry.projectId}:${entry.tabId}`).join('|');
  const inStrip = previewEntries.length > 1;
  useLayoutEffect(()=>{
    if(!desiredPreviewEntries || !paneDrag.source)return;
    const matches=desiredPreviewEntries.length===previewEntries.length
      && desiredPreviewEntries.every((entry,i)=>entry.tabId===previewEntries[i].tabId && entry.projectId===previewEntries[i].projectId);
    uiDragDiagnostic('layout-receipt',{gestureId:paneDrag.source.gestureId,revision:paneDrag.revision,
      workflowId:activeSpaceId,paneKey,zone:paneDrag.target?.zone,at:paneDrag.target?.at,matches,
      presentation:'react-strip-layout-not-compositor'});
  },[desiredPreviewEntries,entriesKey,paneDrag.revision,paneDrag.source,paneKey,activeSpaceId]);

  // Что рисуется в строке: группы вкладок и страницы выбора между ними.
  // Порядок вкладок — из предпросмотра перетаскивания, позиции заготовок — из
  // мест окна; склейка живёт в `paneStripLayout`, чтобы третьего порядка не
  // появилось (см. комментарий там). Окно без заготовок даёт ровно тот же
  // список групп, что и прежний `groupStripByProject`.
  const renderItems = React.useMemo(() => {
    const chooserSlots = (slots || []).filter((slot) => slot && !slot.tabId && slot.slotId);
    if (chooserSlots.length === 0) {
      return groupStripByProject(previewEntries).map((run) => ({ kind: 'run' as const, ...run }));
    }
    return paneStripRenderItems(slots || [], previewEntries);
  }, [slots, entriesKey, previewEntries]);
  const indexOfTab = new Map(previewEntries.map((entry, i) => [entry.tabId, i]));

  // Empty header space is a real target too. Chip targets own their own exact
  // edge; this parent handles gaps/trailing space and computes
  // the same insertion index from committed chip rectangles.
  useEffect(() => {
    const element = stripRootRef.current;
    if (!element) return undefined;
    return dropTargetForElements({
      element,
      getData: () => ({ type: 'PANE_TAB_STRIP_TARGET', paneKey, paneIndex }),
      canDrop: ({ source }) => !element.closest('[data-pane-focus-isolated="1"]')
        && source.data.type === PANE_TAB_DND_TYPE,
      onDrag: ({ source, location }) => {
        const sourceState = paneTabSourceFromDragData(source.data as Record<string, unknown>);
        if (!sourceState) return;
        beginPaneTabDrag(sourceState);
        const target = resolvePaneTabDropTarget(
          element,
          location.current.input.clientX,
          sourceState.entries.map((entry) => entry.tabId),
          location.current.input.clientY,
        );
        if (target) setPaneTabDragTarget(target);
      },
      onDragLeave: () => {
        const current = getPaneTabDragSnapshot();
        if (current.target?.paneKey === paneKey && current.target.zone === 'strip') {
          setPaneTabDragTarget(null);
        }
      },
      onDrop: ({ source }) => {
        const sourceState = paneTabSourceFromDragData(source.data as Record<string, unknown>);
        if (!sourceState) return;
        const result = commitPaintedPaneTabDrop(sourceState.rootTabId);
        console.log('[PaneTabDnd:drop] source=' + sourceState.rootTabId.slice(-12)
          + ' owner=strip pane=' + paneKey
          + ' at=' + (result.target?.at ?? '-')
          + ' claimed=' + (result.claimed ? 1 : 0)
          + ' committed=' + (result.committed ? 1 : 0));
        endPaneTabDrag(sourceState.rootTabId);
      },
    });
  }, [paneIndex, paneKey]);

  // Меню «что начать здесь» для свободного места полосы. Позиция — курсор;
  // прижимается к окну тем же резолвером, что и остальные меню шапки, потому
  // что шапка низкая и обрезает своё содержимое (портал + clamp).
  // Меню запоминает ТОЧНЫЙ адрес окна в момент открытия: workflow и позицию
  // полосы. Голого `paneIndex` мало — он означает «N-е окно текущей
  // раскладки», а раскладка под открытым меню может смениться.
  // Адрес меню — не только номер окна. Номер означает «N-е окно текущей
  // раскладки», а окна внутри ОДНОГО workflow можно закрыть или переставить,
  // и освободившийся номер тут же займёт другое окно: команда создала бы
  // вкладку не там, куда человек целился. Поэтому вместе с номером
  // запоминается отпечаток самой раскладки — он меняется при любой её правке.
  const [newTabMenu, setNewTabMenu] = useState<
    {
      x: number;
      y: number;
      spaceId: string | null;
      paneIndex: number | null;
      layoutRevision: string;
    } | null
  >(null);
  const newTabMenuRef = useRef<HTMLDivElement | null>(null);
  const [newTabMenuPos, setNewTabMenuPos] = useState<{ x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    if (!newTabMenu) { setNewTabMenuPos(null); return; }
    const el = newTabMenuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const next = clampMenuToViewport({
      x: newTabMenu.x,
      y: newTabMenu.y + 4,
      width: rect.width,
      height: rect.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });
    setNewTabMenuPos((prev) => (prev && prev.x === next.x && prev.y === next.y ? prev : next));
  }, [newTabMenu]);

  // Обычный жизненный цикл меню, а не только клик по подложке.
  //
  // Меню рисуется порталом в `document.body`, поэтому оно ПЕРЕЖИВАЕТ скрытие
  // своей шапки: уход в другой workflow оставлял его висеть над чужой
  // раскладкой, где его команды означали уже не то. Escape и потеря окна —
  // тот же контракт, что у остальных меню шапки.
  useEffect(() => {
    if (!newTabMenu) return undefined;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setNewTabMenu(null);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [newTabMenu]);

  // Меню закрывается, как только его адрес перестал существовать: сменился
  // workflow ИЛИ переставили/закрыли окна внутри текущего. Это подстраховка
  // показа; решает всё равно проверка в самом действии (см. `createTabHere`),
  // потому что эффект может не успеть выполниться до клика.
  const liveLayoutRevision = useWorkspaceStore((s) => splitPanesFingerprint(s.splitPanes));
  useEffect(() => {
    if (!newTabMenu) return;
    if (newTabMenu.spaceId !== activeSpaceId
      || newTabMenu.layoutRevision !== liveLayoutRevision) {
      setNewTabMenu(null);
    }
  }, [newTabMenu, activeSpaceId, liveLayoutRevision]);

  // Команда меню создаёт вкладку СРАЗУ, минуя страницу выбора: человек уже
  // назвал ответ. Место при этом всё равно заводится — оно и есть адрес, по
  // которому вкладка приземлится ровно сюда, а не «в текущее окно» после
  // ожидания. Открывается и материализуется одним жестом, поэтому чип со
  // страницей выбора на экране не мелькает.
  const createTabHere = useCallback((action: 'terminal' | 'claude' | 'codex') => {
    const menu = newTabMenu;
    setNewTabMenu(null);
    if (!menu) return;
    const store = useWorkspaceStore.getState();
    // Проверка стоит В ДЕЙСТВИИ, а не только в эффекте: эффект — следующий
    // кадр, а клик мог случиться в том же. Раскладка сверяется целиком, потому
    // что номер окна переиспользуется: закрыли соседа — и «второе окно» стало
    // другим окном.
    if (menu.spaceId !== store.activeSpaceId) return;
    if (menu.layoutRevision !== splitPanesFingerprint(store.splitPanes)) {
      console.log('[Split] newTabMenu stale layout — команда отменена');
      return;
    }
    const slotId = store.openWindowTabChooser(menu.paneIndex);
    if (!slotId) return;
    void store.createTabForWindowChooser(slotId, action);
  }, [newTabMenu]);

  return (
    <div
      ref={stripRootRef}
      data-pane-tab-strip
      data-pane-tab-drop-zone="strip"
      data-pane-key={paneKey}
      data-space-id={activeSpaceId}
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
      // ПКМ по свободному месту полосы — та же тема, что и двойной клик по
      // нему: «что здесь начать». Разница только в том, что меню называет
      // ответ сразу и пропускает страницу выбора: человек уже решил.
      //
      // Меню принадлежит СВОБОДНОМУ месту, а не всей шапке: у чипа вкладки
      // своё меню, у кнопок окна — свои, и перехват здесь отобрал бы их.
      // Открытие меню НЕ двигает фокус (см. onPointerDown ниже): рассматривать
      // окно — не то же, что перейти в него; фокусируется уже результат.
      onContextMenu={(e) => {
        if ((e.target as HTMLElement | null)?.closest?.('[data-strip-item], [data-pane-chooser-chip], button')) return;
        e.preventDefault();
        e.stopPropagation();
        setNewTabMenu({
          x: e.clientX,
          y: e.clientY,
          spaceId: activeSpaceId,
          paneIndex: paneIndex ?? null,
          layoutRevision: splitPanesFingerprint(useWorkspaceStore.getState().splitPanes),
        });
      }}
      style={{
        // Do not create a flex/BFC here: inline descendants must wrap beside
        // the header's action float, then below it at the FULL pane width.
        display: 'block',
        minWidth: 0,
      }}
    >
      <div
        ref={scrollerRef}
        data-pane-tab-strip-scroller
        data-pane-tab-strip-wrap="true"
        data-pane-tab-drop-zone="strip"
        data-pane-key={paneKey}
        data-space-id={activeSpaceId}
        style={{
          display: 'block',
          // Inline boxes flow around the first-row actions. Explicit spaces
          // supply the same 6px gap as before, and collapse at line breaks;
          // margins would also charge a trailing gap against each row's width.
          fontSize: 0,
          lineHeight: 0,
          wordSpacing: 6,
          // Keep the final row gutter inside the measured header as well:
          // subtracting it with a negative margin leaves the strip's hit box
          // over the content below and can steal its top controls' clicks.
          minWidth: 0,
          overflowX: 'clip',
          overflowY: 'clip',
        }}
      >
        {renderItems.map((item, itemIndex) => (item.kind === 'chooser' ? (
          <React.Fragment key={`chooser:${item.slotId}`}>
            {/* The chooser compensates its border with -1px margins. Keep its
                physical top/bottom aligned with the adjacent full cards. */}
            <span style={{ display: 'inline-flex', verticalAlign: 'top', padding: '1px 0', marginBottom: TAB_STRIP_ROW_GAP, wordSpacing: 'normal' }}>
              <PaneChooserChip
                slotId={item.slotId}
                paneIndex={paneIndex}
                selected={item.slotId === selectedSlotId}
                paneFocused={focused}
              />
            </span>{' '}
          </React.Fragment>
        ) : (
          <React.Fragment key={`${item.projectId}:${itemIndex}`}>
            {item.tabIds.map((tabId, tabIndex) => (
              <React.Fragment key={tabId}>
                <span
                  data-strip-item
                  data-strip-tab-id={tabId}
                  data-strip-project-start={tabIndex === 0 ? item.projectId : undefined}
                  style={{ display: 'inline-flex', alignItems: 'center',
                    verticalAlign: 'top', marginBottom: TAB_STRIP_ROW_GAP, wordSpacing: 'normal',
                    flexShrink: 0, minWidth: 0 }}
                >
                  <PaneTabChip
                    projectId={item.projectId}
                    tabId={tabId}
                    shown={tabId === shownTabId}
                    paneFocused={focused}
                    paneIndex={paneIndex}
                    inSplit={inSplit}
                    index={indexOfTab.get(tabId) ?? 0}
                    inStrip={inStrip}
                    sharedActivity={sharedActivity}
                    previewOnly={!baseEntryIds.has(tabId)}
                    dragPlaceholder={paneDrag.active && paneDrag.source?.entries.some((entry) => entry.tabId === tabId)}
                  />
                </span>{' '}
              </React.Fragment>
            ))}
          </React.Fragment>
        )))}
      </div>
      {/* Портал по той же причине, что и у прочих меню шапки: строка низкая и
          обрезает своё содержимое. */}
      {newTabMenu && createPortal(
        <>
          {/* Подложка ловит закрывающий клик ЦЕЛИКОМ: и нажатие, и сам click.
              Только `onMouseDown` закрывал меню на нажатии, после чего click
              долетал до элемента под курсором — то есть жест, которым человек
              всего лишь убирал меню, попутно нажимал вкладку или кнопку под
              ним. */}
          <div
            data-pane-new-tab-menu-backdrop
            onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); setNewTabMenu(null); }}
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
            onDoubleClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
            onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setNewTabMenu(null); }}
            style={{ position: 'fixed', inset: 0, zIndex: 9998 }}
          />
          <div
            ref={newTabMenuRef}
            data-pane-new-tab-menu
            role="menu"
            style={{
              ...CONTEXT_MENU_PANEL_STYLE,
              position: 'fixed',
              top: newTabMenuPos ? newTabMenuPos.y : newTabMenu.y + 4,
              left: newTabMenuPos ? newTabMenuPos.x : newTabMenu.x,
              zIndex: 9999,
              padding: '4px 0',
              background: '#242427',
              border: '1px solid rgba(255,255,255,0.12)',
              boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
              fontSize: 12,
              color: '#ddd',
              userSelect: 'none',
            }}
          >
            {/* No window zone here: this menu already belongs to ONE window —
                the strip the user right-clicked — so "which window?" is the
                question the click has answered. */}
            <NewTabMenuRows
              rowAttributes={(action) => ({ 'data-pane-new-tab-menu-item': action })}
              onCreate={createTabHere}
            />
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}
