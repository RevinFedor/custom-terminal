import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
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
  const maxWidth = useUIStore((s) => s.tabPreviewMaxWidth);
  const maxHeight = useUIStore((s) => s.tabPreviewMaxHeight);
  const ratioW = useUIStore((s) => s.tabPreviewRatioW);
  const ratioH = useUIStore((s) => s.tabPreviewRatioH);
  const targetRatio = ratioW / ratioH; // width / height

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
      maxWidth, maxHeight, fontSize, paddingX, paddingY,
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

    // Балансировка по целевой пропорции (`targetRatio = ratioW/ratioH`).
    // Идея: при разных пробных ширинах форма меняется немонотонно для краткого
    // контента, но монотонно для текста с word-wrap (узкая ширина → высокий
    // столбец, широкая → плоский). Бисекцией ищем chosenW в [MIN, maxWidth]
    // такую что фактическое отношение W/H ≤ targetRatio (минимально близкое
    // к target сверху). Контент сам диктует возможный диапазон высот.
    const measureAt = (w: number) => {
      probe.style.width = `${w}px`;
      return Math.ceil(probe.scrollHeight);
    };
    const finalize = (naturalW: number) => {
      if (cancelled || naturalW <= 0) return;
      // Стартовая ширина = min(naturalW, maxWidth). Если контент уже шире cap'а,
      // потолок = cap. Если меньше — возможно надо СУЗИТЬ для пропорции.
      const startW = Math.min(naturalW, maxWidth);
      let chosenW = startW;
      let chosenH = measureAt(chosenW);

      // Если коробка получается слишком ПЛОСКАЯ (W/H > target → шире чем надо):
      // сужаем chosenW пока W/H ≤ target ИЛИ chosenW = MIN. С `wordWrap`
      // более узкая ширина увеличивает H → ratio падает.
      if (chosenW / chosenH > targetRatio && chosenW > NOTES_MIN_WIDTH) {
        let lo = NOTES_MIN_WIDTH;
        let hi = chosenW;
        for (let i = 0; i < 8; i++) {
          const mid = Math.round((lo + hi) / 2);
          if (mid <= lo) break;
          const h = measureAt(mid);
          if (mid / h > targetRatio) hi = mid;
          else lo = mid;
        }
        chosenW = lo;
        chosenH = measureAt(chosenW);
      }
      // Если коробка слишком ВЫСОКАЯ (W/H < target → нужна шире) и есть запас
      // до maxWidth — расширяем. Word-wrap на большей ширине уменьшает H.
      else if (chosenW / chosenH < targetRatio && chosenW < maxWidth) {
        let lo = chosenW;
        let hi = maxWidth;
        for (let i = 0; i < 8; i++) {
          const mid = Math.round((lo + hi) / 2);
          if (mid <= lo) break;
          const h = measureAt(mid);
          if (mid / h < targetRatio) lo = mid;
          else hi = mid;
        }
        chosenW = hi;
        chosenH = measureAt(chosenW);
      }
      const finalH = Math.min(chosenH, maxHeight);
      console.log('[TabPreviewSize:final]', JSON.stringify({
        source: source || '?', notesPreview, naturalW, startW,
        chosenW, chosenH: finalH, targetRatio: +targetRatio.toFixed(3),
        actualRatio: +(chosenW / chosenH).toFixed(3), framesUsed: frame,
      }));
      if (!cancelled) setNotesBox({ width: chosenW, height: finalH });
    };

    settle();
    return () => { cancelled = true; };
  }, [notes, hasNotes, maxWidth, maxHeight, fontSize, paddingX, paddingY, ratioW, ratioH]);

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

  // Финальная ширина popover'а: max между notesBox.width и шириной meta-карточки.
  // Если есть только metadata (split=false и hasNotes=false) — даём metaRows
  // занять до maxWidth и определиться по контенту.
  const popoverWidth = notesBox?.width ?? Math.min(maxWidth, 320);

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
            maxWidth: `${maxWidth}px`,
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
          />
        </div>
      )}

      {showMainWrapper && notesBox && (
        <div
          ref={wrapperRef}
          style={wrapperStyle}
          onMouseEnter={popoverProps.onMouseEnter}
          onMouseLeave={popoverProps.onMouseLeave}
          data-cmd-hover-popover
        >
          <HoverBridgeDebug
            containerRef={triggerRefShim}
            menuRef={wrapperRef}
            direction={isAbove ? 'above' : 'below'}
          />
          <div style={cardStyle({ width: `${popoverWidth}px` })}>
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
                />
              </div>
            )}

            {!split && metaRows && metaRows.length > 0 && (
              <div style={{ padding: '6px 10px', flexShrink: 0 }}>
                <MetaList rows={metaRows} />
              </div>
            )}
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
  );
}
