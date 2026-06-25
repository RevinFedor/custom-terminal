import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { MarkdownEditor } from '@gt-editor/markdown-editor';
import { useUIStore } from '../../store/useUIStore';
import { getPopoverPosition } from '../../hooks/useCmdHoverPopover';
import HoverBridgeDebug from '../HoverBridgeDebug';

// CMD+hover preview shared by TabBar and ProjectHome (Active + History cards).
//
// Sizing: balanced fit-content в пределах cap'ов из настроек.
//
//   tabPreviewMaxWidth  → жёсткий потолок ширины
//   tabPreviewMaxHeight → жёсткий потолок высоты
//
// Между этими потолками layout сам подбирает форму под контент с прицелом на
// умеренно вытянутую коробку (target ratio width:height ≈ 3:2). Алгоритм
// (computeBalancedSize):
//   1. Измеряем natural-width контента при `width: max-content`.
//   2. Если контент влезает в одну строку И эта строка короче cap'а — берём
//      natural-width. Маленькая заметка не растягивается в широкую коробку.
//   3. Если контент шире cap'а — ширина = cap, высота = max-content в этом cap'е.
//      Получается высокая узкая коробка; чтобы выправить пропорцию, расширяем
//      ширину пока height/width не уменьшится до target ratio (cap height ставит
//      потолок снизу — высота при максимальной ширине ограничена tabPreviewMaxHeight).
//   4. Высота в любом случае ≤ tabPreviewMaxHeight (внутренний scroll).
//
// Title-блок (имя вкладки bold сверху) удалён — имя уже видно на trigger-карточке.
//
// Persistence: cap'ы живут в useUIStore (`noted-terminal-tab-preview-max-{width,height}`).
// Меняются ТОЛЬКО из Settings → секция «Превью таба». Никаких resize handles
// на самой компоненте — балансировка целиком на алгоритме, юзер настраивает
// только границы пространства.

const VIEWPORT_MARGIN = 8;
const NOTES_MIN_WIDTH = 80;   // не уже одной средней «строки» в notes

export interface MetaRow {
  label?: string;
  value: React.ReactNode;
  wrap?: boolean;
  muted?: boolean;
}

interface TabPreviewPopoverProps {
  rect: DOMRect;
  popoverProps: { onMouseEnter: () => void; onMouseLeave: () => void };
  metaRows?: MetaRow[];
  notes?: string | null;
  smartPosition?: boolean;
  forceAbove?: boolean;
  /**
   * Side relative to trigger:
   *   'below'  — popover ниже trigger'а, выровнен по левому краю (горизонтальный TabBar).
   *   'above'  — popover выше trigger'а (legacy `forceAbove`-режим в Home).
   *   'right'  — popover справа от trigger'а, по вертикальному центру (вертикальный TabSidebar).
   * Если не указано — поведение прежнее (below или smart).
   */
  placement?: 'below' | 'above' | 'right';
  /**
   * Split-режим (используется в ProjectHome): два независимых блока вокруг trigger'а.
   *   Верхний (above) — notes.
   *   Нижний (below) — metadata.
   * Если нет notes — верхний блок не рендерится. Если нет metaRows — нижний не рендерится.
   */
  split?: boolean;
  /**
   * Сделать popover прозрачным для курсора (`pointer-events: none`). Визуально
   * рендерится как обычно, но hover проходит сквозь — на сеточном Home это
   * пропускает курсор к карточке под/над текущей. В locked-режиме отключается:
   * закреплённый popover становится интерактивным.
   */
  pointerThrough?: boolean;
  /**
   * Popover закреплён через CMD+Shift. Белая рамка, pointer-events возвращается
   * даже при `pointerThrough`.
   */
  isLocked?: boolean;
  /** Debug: откуда вызван — `tabbar` / `home-active` / `home-history`. */
  source?: string;
}

export default function TabPreviewPopover({
  rect,
  popoverProps,
  metaRows,
  notes,
  smartPosition,
  forceAbove,
  placement,
  split,
  pointerThrough,
  isLocked,
  source,
}: TabPreviewPopoverProps) {
  // Три независимых шрифта на трёх поверхностях tab.notes — здесь tooltip-вариант
  // (notesTooltipFontSize). Padding'и единые для всех трёх (notesEditorPadding*).
  const fontSize = useUIStore((s) => s.notesTooltipFontSize);
  const paddingX = useUIStore((s) => s.notesEditorPaddingX);
  const paddingY = useUIStore((s) => s.notesEditorPaddingY);
  const showLineNumbers = useUIStore((s) => s.notesPreviewShowLineNumbers);
  // previewWidth — потолок переноса текста, задаётся resize-ручкой на правом
  // крае превью (персист в store). maxHeight — потолок скролла по высоте.
  const previewWidth = useUIStore((s) => s.tabPreviewMaxWidth);
  const setPreviewWidth = useUIStore((s) => s.setTabPreviewMaxWidth);
  const maxHeight = useUIStore((s) => s.tabPreviewMaxHeight);

  // heightCap — фактический потолок высоты = min(настройка, место до края экрана).
  // Если вкладка близко к низу/верху и контент не влезает даже в maxHeight —
  // скролл наступает раньше. Берём бОльшую из двух сторон (popover флипается
  // вверх/вниз туда где места больше).
  const heightCap = useMemo(() => {
    const margin = VIEWPORT_MARGIN + 8;
    const spaceBelow = window.innerHeight - rect.bottom - margin;
    const spaceAbove = rect.top - margin;
    const avail = Math.max(spaceBelow, spaceAbove, 120); // не уже 120px даже у самого края
    return Math.min(maxHeight, avail);
  }, [rect.bottom, rect.top, maxHeight]);

  // Hidden probe: рендерим notes в скрытом контейнере с `width: max-content`
  // чтобы измерить natural-width при текущем шрифте. После measure пересчитываем
  // финальные размеры (computeBalancedSize) и помещаем результат в state.
  const probeRef = useRef<HTMLDivElement | null>(null);
  const [notesBox, setNotesBox] = useState<{ width: number; height: number } | null>(null);

  const hasNotes = Boolean(notes && notes.trim().length > 0);

  // Measure после paint — MarkdownEditor рендерится через несколько микрозадач
  // (внутри Vite + react-markdown), `scrollWidth` сразу после mount часто 0.
  // Двухпроходный замер: первый тик useLayoutEffect + второй через rAF на случай
  // если контент ещё не отлэйаутился. Без rAF ловили баг «первый hover — полоска,
  // переключился на другую вкладку и обратно → нормально» (DOM-нода переиспользована,
  // scrollWidth уже стабильный).
  useLayoutEffect(() => {
    if (!hasNotes) { setNotesBox(null); return; }
    const probe = probeRef.current;
    if (!probe) return;
    let cancelled = false;

    // Wait-for-stable measure. MarkdownEditor рендерит блок-контент через
    // react-markdown асинхронно — за первый кадр в probe может оказаться
    // частично-собранный layout (одно слово вместо абзаца) или вообще остаток
    // предыдущей вкладки (probe-DOM переиспользуется). Поэтому ждём пока
    // scrollWidth не зафинализируется: одно и то же значение >0 в трёх кадрах
    // подряд. MAX_FRAMES — страховка от бесконечного цикла.
    const notesPreview = (notes || '').slice(0, 30).replace(/\n/g, '\\n');
    console.log('[TabPreviewSize:enter]', JSON.stringify({
      notesLen: (notes || '').length,
      source: source || '?', notesPreview,
      previewWidth, maxHeight, heightCap, fontSize, paddingX, paddingY,
      rect: { l: Math.round(rect.left), t: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) },
      split: !!split,
    }));
    const MAX_FRAMES = 40;
    const STABLE_REQUIRED = 3;
    let prevW = -1;
    let stableHits = 0;
    let frame = 0;

    const settle = () => {
      if (cancelled) return;
      probe.style.width = '';
      const w = Math.ceil(probe.scrollWidth);
      if (w > 0 && w === prevW) {
        stableHits++;
      } else {
        stableHits = 0;
        prevW = w;
      }
      console.log('[TabPreviewSize:settle]', JSON.stringify({
        source: source || '?', notesPreview, frame, w, prevW, stableHits,
      }));
      if (stableHits < STABLE_REQUIRED && frame < MAX_FRAMES) {
        frame++;
        requestAnimationFrame(settle);
        return;
      }
      finalize(w);
    };

    // Sizing model (no proportion balancing):
    //   • Width = ПОТОЛОК переноса = `previewWidth` (resizable via drag, persisted).
    //     Если контент уже этого потолка (короткая заметка в одну строку) — коробка
    //     ужимается до natural-width (обрезка пустого места справа). Иначе = потолок.
    //   • Height = ДИНАМИЧЕСКАЯ построчно: высота контента при chosenW. Скроллится
    //     при упоре в `heightCap` (= min(maxHeight, доступное место до края экрана)).
    const measureAt = (w: number) => {
      probe.style.width = `${w}px`;
      return Math.ceil(probe.scrollHeight);
    };
    const finalize = (naturalW: number) => {
      if (cancelled || naturalW <= 0) return;
      // Width: clamp natural-width к resize-потолку. Короче потолка → shrink
      // (нет пустого места справа). Шире → перенос в потолок.
      const chosenW = Math.max(NOTES_MIN_WIDTH, Math.min(naturalW, previewWidth));
      const contentH = measureAt(chosenW);
      const finalH = Math.min(contentH, heightCap);
      console.log('[TabPreviewSize:final]', JSON.stringify({
        source: source || '?', notesPreview, naturalW,
        previewWidth, chosenW, contentH, heightCap, finalH, framesUsed: frame,
      }));
      if (!cancelled) setNotesBox({ width: chosenW, height: finalH });
    };

    settle();
    return () => { cancelled = true; };
  }, [notes, hasNotes, previewWidth, heightCap, fontSize, paddingX, paddingY, showLineNumbers]);

  // Synthetic ref для HoverBridgeDebug — у нас только rect от trigger'а.
  const triggerRefShim = useMemo(
    () => ({
      current: {
        getBoundingClientRect: () => rect,
      } as unknown as HTMLElement,
    }),
    [rect],
  );

  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // ─── Resize ширины перетаскиванием правого края превью ──────────────────
  // Ширина — это потолок переноса (previewWidth в store). Тянем правый край →
  // пишем новое значение в store live (как у заметок). resizingRef глушит
  // mouse-leave-close popover'а на время drag'а (курсор гуляет по window).
  const resizingRef = useRef(false);
  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    resizingRef.current = true;
    const startX = e.clientX;
    const startW = useUIStore.getState().tabPreviewMaxWidth;
    const onMove = (ev: MouseEvent) => {
      const next = startW + (ev.clientX - startX);
      setPreviewWidth(next); // store сам clamp'ит [120, 900]
    };
    const onUp = () => {
      resizingRef.current = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [setPreviewWidth]);

  // Mouse-leave для popover-обёрток: во время resize-drag игнорируем (иначе
  // курсор, выехавший за край при перетаскивании, закрыл бы превью).
  const guardedMouseLeave = useCallback(() => {
    if (resizingRef.current) return;
    popoverProps.onMouseLeave();
  }, [popoverProps]);

  // Right-edge resize handle — узкая полоса по правому краю карточки, ew-resize,
  // подсветка на hover. JSX inline (не вложенный компонент) чтобы не ремаунтить
  // на каждый рендер. data-cmd-hover-popover уже на обёртке — mousedown внутри
  // не разлочивает закреплённый popover.
  const resizeHandle = (
    <div
      onMouseDown={startResize}
      title="Потянуть — ширина превью"
      style={{
        position: 'absolute', top: 0, bottom: 0, right: 0, width: 7,
        cursor: 'ew-resize', zIndex: 5,
      }}
      onMouseEnter={(ev) => { (ev.currentTarget as HTMLDivElement).style.backgroundColor = 'rgba(99,102,241,0.4)'; }}
      onMouseLeave={(ev) => { (ev.currentTarget as HTMLDivElement).style.backgroundColor = ''; }}
    />
  );

  // Финальная ширина popover'а: max между notesBox.width и шириной meta-карточки.
  // Если есть только metadata (split=false и hasNotes=false) — даём metaRows
  // занять до previewWidth и определиться по контенту.
  const metadataOnlyWidth = source?.startsWith('home-')
    ? Math.min(420, Math.max(240, window.innerWidth - VIEWPORT_MARGIN * 2))
    : Math.min(previewWidth, 320);
  const popoverWidth = notesBox?.width ?? metadataOnlyWidth;

  // Placement резолвится так: явный prop `placement` (новый API) > legacy `split/forceAbove`
  // (Home above-режим) > `smartPosition` > дефолт ниже. `'right'` рендерит сбоку справа от
  // trigger'а с вертикальным центрированием — используется в вертикальном TabSidebar'е.
  const effectivePlacement: 'below' | 'above' | 'right' =
    placement ?? (split || forceAbove ? 'above' : 'below');

  const isRight = effectivePlacement === 'right';
  const isAboveLayout = effectivePlacement === 'above';

  const pos = isRight
    ? {
        style: {
          position: 'fixed' as const,
          left: rect.right,
          top: rect.top + rect.height / 2,
          paddingLeft: '6px',
          transform: 'translateY(-50%)',
          zIndex: 100,
        } as React.CSSProperties,
        showAbove: false,
      }
    : isAboveLayout
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

  // Viewport clamp. Для below/above — горизонталь по left. Для right — горизонталь по
  // left=rect.right (адаптируем), вертикаль по rect.top + height/2 ± height (адаптируем).
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let adjustedLeft = isRight ? rect.right : rect.left;
  let adjustedTop = isRight ? rect.top + rect.height / 2 : (pos.style.top as number);

  if (isRight) {
    // Если справа не помещается — флипаем налево от сайдбара.
    if (adjustedLeft + popoverWidth + VIEWPORT_MARGIN > vw - VIEWPORT_MARGIN) {
      adjustedLeft = rect.left - popoverWidth - 6;
    }
    if (adjustedLeft < VIEWPORT_MARGIN) {
      adjustedLeft = VIEWPORT_MARGIN;
    }
    // Высота popover'а ≤ maxHeight — но клампим центрирование чтобы не вылетал за viewport.
    const halfH = (notesBox?.height ?? maxHeight) / 2;
    if (adjustedTop - halfH < VIEWPORT_MARGIN) adjustedTop = VIEWPORT_MARGIN + halfH;
    if (adjustedTop + halfH > vh - VIEWPORT_MARGIN) adjustedTop = vh - VIEWPORT_MARGIN - halfH;
  } else {
    if (adjustedLeft + popoverWidth > vw - VIEWPORT_MARGIN) {
      adjustedLeft = vw - VIEWPORT_MARGIN - popoverWidth;
    }
    if (adjustedLeft < VIEWPORT_MARGIN) {
      adjustedLeft = VIEWPORT_MARGIN;
    }
  }

  const isAbove = pos.showAbove;
  const wrapperStyle: React.CSSProperties = {
    ...pos.style,
    left: adjustedLeft,
    ...(isRight ? { top: adjustedTop } : {}),
    paddingTop: isRight ? 0 : (isAbove ? 0 : '4px'),
    paddingBottom: isRight ? 0 : (isAbove ? '4px' : 0),
    paddingLeft: isRight ? '6px' : undefined,
    ...(pointerThrough && !isLocked ? { pointerEvents: 'none' as const } : null),
  };

  const metaWrapperStyle: React.CSSProperties = {
    position: 'fixed',
    left: adjustedLeft,
    top: rect.bottom,
    paddingTop: '4px',
    zIndex: 100,
    ...(pointerThrough && !isLocked ? { pointerEvents: 'none' as const } : null),
  };

  const showSplitMeta = split && metaRows && metaRows.length > 0;
  const showMainWrapper = split
    ? hasNotes
    : hasNotes || (metaRows && metaRows.length > 0);

  // Стили карточек (общие для main и meta-wrapper'а).
  const cardStyle = (extra: React.CSSProperties = {}): React.CSSProperties => ({
    backgroundColor: '#1e1e1e',
    border: isLocked ? '1px solid #fff' : '1px solid #333',
    borderRadius: '6px',
    boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    ...extra,
  });

  return (
    <>
      {/* Скрытый probe для замера natural-width / height. Рендерится вне
          потока (visibility: hidden + abs position) с теми же стилями что
          реальный MarkdownEditor — fontSize, padding, line-height. */}
      {hasNotes && (
        <div
          ref={probeRef}
          aria-hidden
          style={{
            position: 'fixed',
            visibility: 'hidden',
            pointerEvents: 'none',
            top: -99999,
            left: -99999,
            width: 'max-content',
            maxWidth: `${previewWidth}px`,
            zIndex: -1,
          }}
        >
          <MarkdownEditor
            key={`probe::${notes}`}
            content={notes!}
            onChange={() => {}}
            readOnly
            compact
            fontSize={fontSize}
            contentPaddingX={paddingX}
            contentPaddingY={paddingY}
            wordWrap
            showLineNumbers={showLineNumbers}
          />
        </div>
      )}

      {showMainWrapper && notesBox && (
        <div
          ref={wrapperRef}
          style={wrapperStyle}
          onMouseEnter={popoverProps.onMouseEnter}
          onMouseLeave={guardedMouseLeave}
          data-cmd-hover-popover
        >
          <HoverBridgeDebug
            containerRef={triggerRefShim}
            menuRef={wrapperRef}
            direction={isAbove ? 'above' : 'below'}
          />
          <div style={cardStyle({ width: `${popoverWidth}px`, position: 'relative' })}>
            {hasNotes && (
              <div
                style={{
                  width: `${notesBox.width}px`,
                  height: `${notesBox.height}px`,
                  overflow: 'auto',
                  flexShrink: 0,
                  borderBottom: !split && metaRows && metaRows.length > 0 ? '1px solid #2a2a2a' : 'none',
                }}
              >
                <MarkdownEditor
                  content={notes!}
                  onChange={() => {}}
                  readOnly
                  compact
                  fontSize={fontSize}
                  contentPaddingX={paddingX}
                  contentPaddingY={paddingY}
                  wordWrap
                  showLineNumbers={showLineNumbers}
                />
              </div>
            )}

            {!split && metaRows && metaRows.length > 0 && (
              <div style={{ padding: '6px 10px', flexShrink: 0 }}>
                <MetaList rows={metaRows} />
              </div>
            )}
            {hasNotes && resizeHandle}
          </div>
        </div>
      )}

      {showSplitMeta && (
        <div
          style={metaWrapperStyle}
          onMouseEnter={popoverProps.onMouseEnter}
          onMouseLeave={popoverProps.onMouseLeave}
          data-cmd-hover-popover
        >
          <div style={cardStyle({ width: `${popoverWidth}px`, padding: '6px 10px' })}>
            <MetaList rows={metaRows!} />
          </div>
        </div>
      )}
    </>
  );
}

// Стандартный рендер metadata-rows — отдельным компонентом чтобы не дублировать
// между split-meta-wrapper'ом и inline-под-notes.
function MetaList({ rows }: { rows: MetaRow[] }) {
  return (
    <div style={{ fontSize: '10px', color: '#888', display: 'flex', flexDirection: 'column', gap: '2px' }}>
      {rows.map((row, idx) => (
        <div
          key={idx}
          style={{
            wordBreak: row.wrap === false ? 'normal' : 'break-word',
            color: row.muted ? '#888' : '#ccc',
            whiteSpace: row.wrap === false ? 'nowrap' : 'normal',
            overflow: row.wrap === false ? 'hidden' : 'visible',
            overflowWrap: row.wrap === false ? 'normal' : 'anywhere',
            textOverflow: row.wrap === false ? 'ellipsis' : 'clip',
          }}
        >
          {row.label ? <span style={{ color: '#666' }}>{row.label}: </span> : null}
          {row.value}
        </div>
      ))}
    </div>
  );
}
