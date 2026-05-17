import React, { useCallback, useMemo, useRef, useState } from 'react';
import { MarkdownEditor } from '@gt-editor/markdown-editor';
import { useUIStore } from '../../store/useUIStore';
import { getPopoverPosition } from '../../hooks/useCmdHoverPopover';
import HoverBridgeDebug from '../HoverBridgeDebug';

// Resize behavior matches TabNotesSlideout: live React preview during drag, single
// store flush on mouseup (60 sync writes/sec to localStorage+SQLite was producing
// jerky drag in earlier iterations — см. fact-notes.md `Drag-preview буфер`).
//
// Шрамы этой компоненты:
// 1. Drag вниз/влево/etc → курсор уходит за пределы popover-обёртки → React `onMouseLeave`
//    на wrapper'е → useCmdHoverPopover.popoverProps.onMouseLeave() → setHoveredItem(null)
//    → popover unmount'ится посреди drag'а. Лекарство: isDraggingRef guard в обёртке
//    handleWrapperMouseLeave — пока drag активен, mouseLeave игнорируется.
// 2. После mouseup курсор может оказаться вне popover'а. Если просто оставить — popover
//    залипнет (для CMD не зажат, isPinned=true, ничего не закрывает). Лекарство:
//    elementFromPoint(release.x, release.y) — если вне обёртки, имитируем onMouseLeave.
// 3. Микро-движения сразу после mouseup могут трогать handle (offset -5px вне rectangle):
//    переход на handle никогда не закрывает popover (handle — child outer wrapper, не
//    triggers mouseleave). НО переход с handle мимо обоих в пустоту — да. Grace period
//    200ms после mouseup гасит первое-же ложное mouseLeave.
const MIN_W = 240;
const MAX_W = 900;
const MIN_LINES = 2;
const MAX_LINES = 40;
const VIEWPORT_MARGIN = 8;
const HANDLE_EDGE_THICKNESS = 6;    // 4px outside + 2px inside рамки (визуально тонкая)
const HANDLE_EDGE_OFFSET = -4;
const HANDLE_CORNER_SIZE = 14;
const HANDLE_CORNER_OFFSET = -5;
const HANDLE_EDGE_INSET = 14;       // edge handle отступает от corner
const DRAG_GRACE_MS = 200;

export interface MetaRow {
  label?: string;
  value: React.ReactNode;
  /** Force value to wrap on long content (Path-style). Defaults to truncate. */
  wrap?: boolean;
  muted?: boolean;
}

interface TabPreviewPopoverProps {
  rect: DOMRect;
  popoverProps: { onMouseEnter: () => void; onMouseLeave: () => void };
  /** Metadata rows (Path/Closed/Created/Type/Messages). Rendered above notes. */
  metaRows?: MetaRow[];
  /** Optional markdown content rendered as a resizable notes block. */
  notes?: string | null;
  /** When true, popover may flip above the trigger if there's not enough space below. */
  smartPosition?: boolean;
  /** When true, popover is forced ABOVE trigger regardless of available space. */
  forceAbove?: boolean;
  /**
   * Split-режим (используется в ProjectHome): два независимых блока вокруг trigger'а.
   *   Верхний (above) — title + notes (resizable).
   *   Нижний (below) — metadata.
   * Если нет notes — верхний блок не рендерится. Если нет metaRows — нижний не рендерится.
   */
  split?: boolean;
  /**
   * Отключить resize handles. Размеры всё равно читаются из store (`tabPreviewWidth`/
   * `tabPreviewMaxLines`), но изменить их с этой поверхности нельзя. Используется
   * в ProjectHome — настройки превью живут только на странице проекта (TabBar),
   * Home отображает результат.
   */
  disableResize?: boolean;
  /**
   * Сделать popover прозрачным для курсора (`pointer-events: none`). Визуально
   * рендерится как обычно, но hover-эффект проходит сквозь — на сеточном Home
   * это даёт перейти курсором к карточке под/над текущей: блоки превью больше
   * не перегораживают путь. Контент превью на Home всё равно нередактируем
   * и некликабелен, поэтому функциональность не теряется (выделение текста
   * сознательно пропускаем).
   *
   * Когда `isLocked === true`, pointer-through автоматически отключается —
   * закреплённый popover становится интерактивным (выделение текста, скролл).
   */
  pointerThrough?: boolean;
  /**
   * Popover закреплён через CMD+Shift. Отображается белая рамка (визуальный
   * сигнал «прибито»), pointer-events возвращается даже при `pointerThrough`.
   */
  isLocked?: boolean;
}

type ResizeEdge = 'right' | 'left' | 'bottom' | 'corner-br' | 'corner-bl';

// CMD+hover preview shared by TabBar and ProjectHome (Active + History cards).
//
// Layout (top → bottom):
//   1. Notes block  — MarkdownEditor read-only. Resizable со всех сторон + 2 угла.
//   2. Metadata     — fixed-size block (Closed → Created → Path → Type → Messages).
//
// Title-блок (имя вкладки bold сверху) был удалён по запросу юзера: имя уже видно
// на самой trigger-карточке (TabBar таб или ProjectHome card), дублировать его
// в popover'е — visual noise.
//
// Persistence: `tabPreviewWidth` / `tabPreviewMaxLines` живут в useUIStore (mirror
// в SQLite через standard `noted-terminal-*` localStorage). `localLeftShift` — только
// в local state, не персистится: при следующем open popover'а left возвращается к
// rect.left + viewport-clamp. Юзер тянет влево → popover растёт влево; после mouseup
// width в store, но позиция остаётся pending до закрытия popover'а.
export default function TabPreviewPopover({
  rect,
  popoverProps,
  metaRows,
  notes,
  smartPosition,
  forceAbove,
  split,
  disableResize,
  pointerThrough,
  isLocked,
}: TabPreviewPopoverProps) {
  const fontSize = useUIStore((s) => s.notesEditorFontSize);
  const paddingX = useUIStore((s) => s.notesEditorPaddingX);
  const paddingY = useUIStore((s) => s.notesEditorPaddingY);
  const widthFromStore = useUIStore((s) => s.tabPreviewWidth);
  const maxLinesFromStore = useUIStore((s) => s.tabPreviewMaxLines);
  const setTabPreviewWidth = useUIStore((s) => s.setTabPreviewWidth);
  const setTabPreviewMaxLines = useUIStore((s) => s.setTabPreviewMaxLines);

  // Live drag preview — пишем сюда каждый mousemove. Store обновляется один раз
  // на mouseup. `previewRef` зеркалит state, потому что в React StrictMode
  // функциональный setState double-invokes: захват `captured = prev` внутри
  // updater'а во второй проход даёт `prev=null` и затирает значение. Безопасный
  // путь — параллельный ref, который пишется при каждом setDragPreview.
  const [dragPreview, _setDragPreview] = useState<{
    width: number; maxLines: number; leftShift: number;
  } | null>(null);
  const previewRef = useRef<{ width: number; maxLines: number; leftShift: number } | null>(null);
  const setDragPreview = useCallback((next: { width: number; maxLines: number; leftShift: number } | null) => {
    previewRef.current = next;
    _setDragPreview(next);
  }, []);
  // Persistent left shift — растёт пока popover открыт, сбрасывается на следующий open.
  // Хранит pending leftward growth от drag'ов на left/corner-bl handles.
  const [localLeftShift, setLocalLeftShift] = useState(0);

  const dragRef = useRef<null | {
    edge: ResizeEdge;
    startX: number; startY: number;
    startWidth: number; startMaxLines: number;
    startLeftShift: number;
    pxPerLine: number;
  }>(null);

  // Mouse-leave guard. Pinned by setIsPinned in useCmdHoverPopover keeps popover
  // alive while CMD released, но как только cursor уходит ЗА outer wrapper —
  // popoverProps.onMouseLeave убивает state. Во время drag это убивает drag.
  const isDraggingRef = useRef(false);
  const graceUntilRef = useRef(0);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  // Ref на handle, который сейчас тянется — для очистки `data-resize-handle-active`
  // на mouseup. Закрепляется на mousedown в `startResize`.
  const activeHandleRef = useRef<HTMLElement | null>(null);

  // Synthetic ref для HoverBridgeDebug — у нас только `rect: DOMRect` от
  // trigger'а (snapshot), не живой DOM. Делаем shim-объект который HoverBridgeDebug
  // воспринимает как ref на trigger element. `getBoundingClientRect` возвращает
  // переданный rect, остальные props не нужны (HoverBridgeDebug читает только rect).
  const triggerRefShim = useMemo(
    () => ({
      current: {
        getBoundingClientRect: () => rect,
      } as unknown as HTMLElement,
    }),
    [rect],
  );

  const effectiveWidth = dragPreview ? dragPreview.width : widthFromStore;
  const effectiveMaxLines = dragPreview ? dragPreview.maxLines : maxLinesFromStore;
  const effectiveLeftShift = dragPreview ? dragPreview.leftShift : localLeftShift;

  // Approximate line height in px используется для maxHeight cap и для конверсии
  // vertical drag → строки. MarkdownEditor использует 1.5em line-height.
  const lineHeightPx = fontSize * 1.5;
  const notesMaxHeight = Math.max(lineHeightPx * effectiveMaxLines, lineHeightPx * MIN_LINES);

  const startResize = useCallback(
    (edge: ResizeEdge, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      isDraggingRef.current = true;
      // data-resize-handle-active атрибут на самом handle → CSS-селектор держит
      // подсветку во время drag, даже когда курсор физически вне handle area.
      // Стандартный паттерн (react-resizable-panels by Brian Vaughn): атрибут
      // навешивается на mousedown, снимается на mouseup. CSS `:hover` обрабатывает
      // покоящееся состояние.
      const handleEl = e.currentTarget as HTMLElement;
      handleEl.dataset.resizeHandleActive = 'true';
      activeHandleRef.current = handleEl;
      dragRef.current = {
        edge,
        startX: e.clientX,
        startY: e.clientY,
        startWidth: widthFromStore,
        startMaxLines: maxLinesFromStore,
        startLeftShift: localLeftShift,
        pxPerLine: lineHeightPx,
      };
      setDragPreview({
        width: widthFromStore,
        maxLines: maxLinesFromStore,
        leftShift: localLeftShift,
      });

      const onMove = (ev: MouseEvent) => {
        const d = dragRef.current;
        if (!d) return;
        const dx = ev.clientX - d.startX;
        const dy = ev.clientY - d.startY;

        let nextWidth = d.startWidth;
        let nextLines = d.startMaxLines;
        let nextLeftShift = d.startLeftShift;

        const isRight = d.edge === 'right' || d.edge === 'corner-br';
        const isLeft = d.edge === 'left' || d.edge === 'corner-bl';
        const isBottom = d.edge === 'bottom' || d.edge === 'corner-br' || d.edge === 'corner-bl';

        if (isRight) {
          nextWidth = Math.max(MIN_W, Math.min(MAX_W, d.startWidth + dx));
        }
        if (isLeft) {
          // Width растёт ВЛЕВО: mouse moves left (dx<0) → width растёт.
          // Одновременно сдвигаем popover влево на тот же дельта, чтобы правый край
          // остался на месте (intuitive «тяну за левый край»). После clamp width
          // фиксируется в [MIN_W, MAX_W] — leftShift корректируется пропорционально.
          const desired = d.startWidth - dx;
          nextWidth = Math.max(MIN_W, Math.min(MAX_W, desired));
          const appliedDelta = nextWidth - d.startWidth; // положит. = растянули; отриц. = сжали
          nextLeftShift = d.startLeftShift - appliedDelta;
        }
        if (isBottom) {
          // Дробное значение для плавного follow за курсором. Высота блока =
          // lineHeight * nextLines, поэтому при dy=50px height вырастет ровно на
          // 50px (без снапа к ближайшей строке во время drag'а). На mouseup
          // округляем для store. Раньше Math.round тут давал рывки по 19.5px и
          // несоответствие позиции курсора и рамки в момент отпускания.
          const deltaLines = dy / d.pxPerLine;
          nextLines = Math.max(MIN_LINES, Math.min(MAX_LINES, d.startMaxLines + deltaLines));
        }

        setDragPreview({ width: nextWidth, maxLines: nextLines, leftShift: nextLeftShift });
      };

      const onUp = (ev: MouseEvent) => {
        // Flush. previewRef хранит последнее preview-значение (зеркало state'а,
        // safe от React StrictMode double-invocation функционального updater'а).
        // Прямой setDragPreview(null) не теряет данные — setters вызываются ПОСЛЕ
        // захвата через ref.
        const captured = previewRef.current;
        setDragPreview(null);
        if (captured) {
          if (captured.width !== widthFromStore) setTabPreviewWidth(captured.width);
          if (captured.maxLines !== maxLinesFromStore) setTabPreviewMaxLines(captured.maxLines);
          if (captured.leftShift !== localLeftShift) setLocalLeftShift(captured.leftShift);
        }
        dragRef.current = null;
        isDraggingRef.current = false;
        graceUntilRef.current = Date.now() + DRAG_GRACE_MS;
        // Снимаем `data-resize-handle-active` с handle'а. CSS `:hover` правило
        // продолжит подсвечивать handle, пока курсор находится над ним; иначе
        // подсветка естественно исчезнет.
        if (activeHandleRef.current) {
          delete activeHandleRef.current.dataset.resizeHandleActive;
          activeHandleRef.current = null;
        }

        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);

        // Если курсор отпущен ЗА пределами popover'а — имитируем mouseleave
        // (без этого popover залипнет с CMD не зажат).
        const wrapper = wrapperRef.current;
        if (wrapper) {
          const el = document.elementFromPoint(ev.clientX, ev.clientY);
          const inside = !!(el && wrapper.contains(el));
          if (!inside) {
            // Grace period сбрасываем сразу — мы сами имитируем уход.
            graceUntilRef.current = 0;
            popoverProps.onMouseLeave();
          }
        }
      };

      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [widthFromStore, maxLinesFromStore, localLeftShift, setTabPreviewWidth, setTabPreviewMaxLines, lineHeightPx, popoverProps],
  );

  // Wrapper handlers — перехватываем mouseLeave чтобы не закрывать popover во время
  // drag'а или в grace period сразу после.
  const handleWrapperMouseEnter = useCallback(() => {
    popoverProps.onMouseEnter();
  }, [popoverProps]);
  const handleWrapperMouseLeave = useCallback(() => {
    if (isDraggingRef.current) return;
    if (Date.now() < graceUntilRef.current) return;
    popoverProps.onMouseLeave();
  }, [popoverProps]);

  // Clamp в viewport с обоих сторон. Если popover не влезает справа — сдвигаем влево
  // (или ограничиваем шириной). Если выехал слева — прижимаем к VIEWPORT_MARGIN.
  const vw = window.innerWidth;
  const desiredLeft = rect.left + effectiveLeftShift;
  let adjustedLeft = desiredLeft;
  if (adjustedLeft + effectiveWidth > vw - VIEWPORT_MARGIN) {
    adjustedLeft = vw - VIEWPORT_MARGIN - effectiveWidth;
  }
  if (adjustedLeft < VIEWPORT_MARGIN) {
    adjustedLeft = VIEWPORT_MARGIN;
  }

  // Position resolution:
  //   split=true → главный wrapper (title+notes) ВСЕГДА выше trigger'а.
  //                 metadata уходит во второй wrapper ниже trigger'а (рендерится отдельно).
  //   forceAbove=true → popover ВСЕГДА над trigger'ом (translate(-100%))
  //   smartPosition=true → выше или ниже в зависимости от spaceBelow
  //   default → below trigger.
  const pos = split || forceAbove
    ? {
        style: {
          position: 'fixed' as const,
          left: rect.left,
          top: rect.top,
          paddingBottom: '4px',
          transform: 'translateY(-100%)',
          zIndex: 100,
        } as React.CSSProperties,
        showAbove: true,
      }
    : smartPosition
    ? getPopoverPosition(rect, { maxHeight: 9999 })
    : {
        style: {
          position: 'fixed' as const,
          left: rect.left,
          top: rect.bottom,
          paddingTop: '4px',
          zIndex: 100,
        } as React.CSSProperties,
        showAbove: false,
      };
  // Wrapper расширяется на 8px по бокам и снизу/сверху (вместо стандартного 4px
  // hover-bridge'а от getPopoverPosition), чтобы handles (offset -5px от card)
  // оставались ВНУТРИ wrapper.boundingRect. Иначе курсор на handle регистрируется
  // как «вне wrapper'а» → triggerProps.onMouseLeave timer (150ms) убивает popover
  // до того, как mousedown даже стартанёт drag. Top-padding для below mode сохраняем
  // как hover-bridge между trigger и popover (4px вверх). Bottom-padding 8px (для
  // bottom resize handle). Симметрично для above mode.
  const WRAPPER_PAD = 8;
  const isAbove = pos.showAbove;
  const wrapperStyle: React.CSSProperties = {
    ...pos.style,
    left: adjustedLeft - WRAPPER_PAD,
    paddingLeft: WRAPPER_PAD,
    paddingRight: WRAPPER_PAD,
    // Для below mode: top=4 (hover-bridge), bottom=WRAPPER_PAD (для bottom handle).
    // Для above mode: bottom=4 (hover-bridge), top=WRAPPER_PAD.
    paddingTop: isAbove ? WRAPPER_PAD : '4px',
    paddingBottom: isAbove ? '4px' : WRAPPER_PAD,
    // pointerThrough: курсор проходит сквозь весь wrapper насквозь (Home grid).
    // Влияет на ВЕСЬ wrapper включая padding и внутреннюю карточку — иначе
    // padding-зоны ловили бы mousemove и блокировали карточку под popover'ом.
    // В locked-режиме pointer-through автоматически отключается: закреплённый
    // popover должен быть интерактивным (text selection, scroll).
    ...(pointerThrough && !isLocked ? { pointerEvents: 'none' as const } : null),
  };

  const hasNotes = Boolean(notes && notes.trim().length > 0);

  // Edge / corner handles. Тонкие (6px на офсете -4), corners 14×14 на -5.
  // Подсветка через CSS-классы `tab-preview-handle` + `data-resize-handle-active`
  // (см. <style> ниже + cleanup в onUp). JS hover handlers удалены — `:hover`
  // правило корректно отображает курсор-под-handle, а dataset-атрибут держит
  // подсветку во время drag даже когда курсор уехал.
  const edgeHandleStyle = (cssProps: React.CSSProperties): React.CSSProperties => ({
    position: 'absolute',
    zIndex: 2,
    ...cssProps,
  });
  const cornerHandleStyle = (cssProps: React.CSSProperties): React.CSSProperties => ({
    position: 'absolute',
    width: HANDLE_CORNER_SIZE,
    height: HANDLE_CORNER_SIZE,
    zIndex: 3,
    ...cssProps,
  });

  // Стиль для metadata-wrapper'а (нижний блок в split-режиме). Параллелен
  // основному wrapperStyle, но прибит к bottom edge trigger'а через `top:
  // rect.bottom`. left+padding такой же что у основного — оба блока вертикально
  // align'нуты.
  const metaWrapperStyle: React.CSSProperties = {
    position: 'fixed',
    left: adjustedLeft - WRAPPER_PAD,
    top: rect.bottom,
    paddingTop: '4px',
    paddingLeft: WRAPPER_PAD,
    paddingRight: WRAPPER_PAD,
    paddingBottom: WRAPPER_PAD,
    zIndex: 100,
    ...(pointerThrough && !isLocked ? { pointerEvents: 'none' as const } : null),
  };

  const showSplitMeta = split && metaRows && metaRows.length > 0;
  // Верхний wrapper имеет смысл только если внутри есть контент:
  //   • split-режим (Home) — рендерим лишь когда есть notes; metadata живёт
  //     в отдельном нижнем wrapper'е.
  //   • обычный режим (TabBar) — рендерим если есть notes ИЛИ metaRows.
  // Без этого условия пустая card с `border: 1px solid #333` выдавала тонкую
  // полоску над карточкой trigger'а на ProjectHome для табов без заметок.
  const showMainWrapper = split
    ? hasNotes
    : hasNotes || (metaRows && metaRows.length > 0);

  return (
    <>
    {showMainWrapper && (
    <div
      ref={wrapperRef}
      style={wrapperStyle}
      onMouseEnter={handleWrapperMouseEnter}
      onMouseLeave={handleWrapperMouseLeave}
      data-cmd-hover-popover
    >
      {/* Debug hover-bridge visualizer (StatusBar toggle «bridges»). Покажет
          красную полупрозрачную область между trigger-карточкой и popover'ом,
          чтобы видеть гэп, в котором юзер может свободно двигать мышь. */}
      <HoverBridgeDebug
        containerRef={triggerRefShim}
        menuRef={wrapperRef}
        direction={pos.showAbove ? 'above' : 'below'}
      />
      {/* card-wrap нужен потому что card имеет `overflow: hidden` для скруглённых
          углов — это обрезало handles, которые торчат на -5px за пределы card'а.
          card-wrap без overflow и с position: relative — handles живут на нём,
          торчат за card на 5px и остаются кликабельными. */}
      <div
        style={{
          width: `${effectiveWidth}px`,
          position: 'relative',
        }}
      >
      <div
        style={{
          width: '100%',
          backgroundColor: '#1e1e1e',
          // В locked-режиме (CMD+Shift) рисуем белую рамку — визуальный сигнал
          // «прибито». Без сдвига layout'а: толщина та же 1px.
          border: isLocked ? '1px solid #fff' : '1px solid #333',
          borderRadius: '6px',
          boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Notes block — единственный контент popover'а сверху. Title удалён
            (имя вкладки видно на trigger-карточке). Resizable, высота
            фиксирована maxLines*lineHeight. */}
        {hasNotes && (
          <div
            style={{
              height: notesMaxHeight,
              flex: '0 0 auto',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              // В split mode metadata живёт в отдельном wrapper'е ниже trigger'а,
              // border-разделитель не нужен.
              borderBottom: !split && metaRows && metaRows.length > 0 ? '1px solid #2a2a2a' : 'none',
            }}
          >
            <MarkdownEditor
              content={notes!}
              onChange={() => {}}
              readOnly
              compact
              showLineNumbers={false}
              fontSize={fontSize}
              contentPaddingX={paddingX}
              contentPaddingY={paddingY}
              wordWrap
            />
          </div>
        )}

        {/* Metadata block — внизу popover'а. Технические поля сессии (путь, даты,
            тип). Фиксированная высота — не resizable. В split-режиме рендерится
            в отдельный wrapper НИЖЕ trigger'а (см. ниже return-block), здесь
            скипаем чтобы не дублировать. */}
        {!split && metaRows && metaRows.length > 0 && (
          <div
            style={{
              padding: '6px 10px',
              flexShrink: 0,
            }}
          >
            <div style={{ fontSize: '10px', color: '#888', display: 'flex', flexDirection: 'column', gap: '2px' }}>
              {metaRows.map((row, idx) => (
                <div
                  key={idx}
                  style={{
                    wordBreak: row.wrap === false ? 'normal' : 'break-all',
                    color: row.muted ? '#888' : '#ccc',
                    whiteSpace: row.wrap === false ? 'nowrap' : 'normal',
                    overflow: row.wrap === false ? 'hidden' : 'visible',
                    textOverflow: row.wrap === false ? 'ellipsis' : 'clip',
                  }}
                >
                  {row.label ? <span style={{ color: '#666' }}>{row.label}: </span> : null}
                  {row.value}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Resize handles — render только если есть notes. Title + metadata
          fixed-size, нечего тянуть. Handles живут на card-WRAP (без overflow),
          а не на card (там overflow: hidden обрезал бы их offset -5px).
          Подсветка через CSS-классы — устраняет «потерю hover после mouseup»:
          `:hover` всегда правильный для текущей позиции курсора, а
          `data-resize-handle-active` держит подсветку во время drag (когда
          курсор уехал за handle area). */}
      {hasNotes && !disableResize && (
        <>
          <style>{`
            .tab-preview-handle:hover,
            .tab-preview-handle[data-resize-handle-active='true'] {
              background-color: rgba(99,102,241,0.4);
            }
          `}</style>
          {/* Right edge */}
          <div
            className="tab-preview-handle"
            onMouseDown={(e) => startResize('right', e)}
            style={edgeHandleStyle({
              top: HANDLE_EDGE_INSET,
              bottom: HANDLE_EDGE_INSET,
              right: HANDLE_EDGE_OFFSET,
              width: HANDLE_EDGE_THICKNESS,
              cursor: 'ew-resize',
            })}
          />
          {/* Left edge */}
          <div
            className="tab-preview-handle"
            onMouseDown={(e) => startResize('left', e)}
            style={edgeHandleStyle({
              top: HANDLE_EDGE_INSET,
              bottom: HANDLE_EDGE_INSET,
              left: HANDLE_EDGE_OFFSET,
              width: HANDLE_EDGE_THICKNESS,
              cursor: 'ew-resize',
            })}
          />
          {/* Bottom edge */}
          <div
            className="tab-preview-handle"
            onMouseDown={(e) => startResize('bottom', e)}
            style={edgeHandleStyle({
              left: HANDLE_EDGE_INSET,
              right: HANDLE_EDGE_INSET,
              bottom: HANDLE_EDGE_OFFSET,
              height: HANDLE_EDGE_THICKNESS,
              cursor: 'ns-resize',
            })}
          />
          {/* Corner BR */}
          <div
            className="tab-preview-handle"
            onMouseDown={(e) => startResize('corner-br', e)}
            style={cornerHandleStyle({
              right: HANDLE_CORNER_OFFSET,
              bottom: HANDLE_CORNER_OFFSET,
              cursor: 'nwse-resize',
            })}
          />
          {/* Corner BL */}
          <div
            className="tab-preview-handle"
            onMouseDown={(e) => startResize('corner-bl', e)}
            style={cornerHandleStyle({
              left: HANDLE_CORNER_OFFSET,
              bottom: HANDLE_CORNER_OFFSET,
              cursor: 'nesw-resize',
            })}
          />
        </>
      )}
      </div>
    </div>
    )}
    {/* Split-mode: отдельный wrapper с metadata НИЖЕ trigger'а. Использует те же
        popoverProps (onMouseEnter/Leave) для общего pin state — обе части
        ведут себя как единый popover при mouse-over. */}
    {showSplitMeta && (
      <div
        style={metaWrapperStyle}
        onMouseEnter={handleWrapperMouseEnter}
        onMouseLeave={handleWrapperMouseLeave}
        data-cmd-hover-popover
      >
        <div
          style={{
            backgroundColor: '#1e1e1e',
            border: isLocked ? '1px solid #fff' : '1px solid #333',
            borderRadius: '6px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
            width: `${effectiveWidth}px`,
            padding: '6px 10px',
          }}
        >
          <div style={{ fontSize: '10px', color: '#888', display: 'flex', flexDirection: 'column', gap: '2px' }}>
            {metaRows!.map((row, idx) => (
              <div
                key={idx}
                style={{
                  wordBreak: row.wrap === false ? 'normal' : 'break-all',
                  color: row.muted ? '#888' : '#ccc',
                  whiteSpace: row.wrap === false ? 'nowrap' : 'normal',
                  overflow: row.wrap === false ? 'hidden' : 'visible',
                  textOverflow: row.wrap === false ? 'ellipsis' : 'clip',
                }}
              >
                {row.label ? <span style={{ color: '#666' }}>{row.label}: </span> : null}
                {row.value}
              </div>
            ))}
          </div>
        </div>
      </div>
    )}
    </>
  );
}
