// «Move to window» — выбор окна КАРТИНКОЙ текущей раскладки.
//
// Перенос вкладки между окнами мог быть перетаскиванием, и это был бы третий
// drag в одном приложении: карточки проектов, чипы внутри полосы — и ещё один,
// через всю рабочую область, мимо чужих окон, с промахами. Юзер: *«перетаскивание
// пока слишком сложно»*.
//
// Вместо жеста — НАЗВАННАЯ цель. Меню повторяет то, что на экране: столько
// прямоугольников, сколько окон, в тех же местах, где они стоят. Наводишь на
// прямоугольник — вкладка уходит в конец его полосы. Читается без расшифровки
// ровно потому же, почему читается карта на карточке вкладки: позиция клетки и
// есть ответ.
//
// Это тот же способ мышления, что у `arrange_windows` в Terminal MCP: сначала
// посмотреть раскладку, потом назвать место. Разница только в том, кто смотрит.

import React from 'react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { describeWorkspace, paneColumns, paneGridRects, splitSizesFingerprint } from '../../utils/splitPanesModel.mjs';

// Высота всего рисунка. Окна делят её В ТЕХ ЖЕ долях, что и на экране, поэтому
// число здесь одно: пропорции приходят из раскладки, а не задаются тут.
const MAP_HEIGHT_PX = 104;

interface WindowCell {
  index: number;
  column: number;
  row: number;
  focused: boolean;
  empty?: boolean;
  shownTabId: string | null;
  tabs: Array<{ projectId: string; tabId: string }>;
  /** Доля окна в его колонке, в процентах — та же, что на экране. */
  heightPct: number;
  /** Доля колонки в ширине — тоже с экрана. */
  widthPct: number;
}

/**
 * Что делает выбор окна.
 *
 * `move` — перенести НАЗВАННУЮ ВКЛАДКУ в конец полосы выбранного окна (пункт
 * меню вкладки). `swap` — поменять местами два ОКНА целиком, со всеми их
 * вкладками (пункт меню перегородки).
 *
 * Картинка одна и та же, потому что вопрос один и тот же: «какое окно». Разное
 * — что произойдёт с выбранным, и это сказано подписями на самих прямоугольниках
 * и тем, какое из них помечено как своё. Юзер про обмен: *«я нажимаю на эту
 * кнопку, выбираю другое окно, и эти два окна меняются местами»*.
 */
export type WindowPickMode = 'move' | 'swap';

/** Карта окон: наводишь на прямоугольник — выбрал окно. */
export default function MoveToWindowMenu({
  projectId,
  tabId,
  mode = 'move',
  sourcePaneIndex = null,
  onDone,
}: {
  projectId?: string;
  tabId?: string;
  mode?: WindowPickMode;
  /** Для обмена: окно, ОТКУДА меняем. Его прямоугольник помечен как своё. */
  sourcePaneIndex?: number | null;
  onDone: () => void;
}) {
  // Строковый отпечаток, не массив: селектор, возвращающий объекты, — новая
  // ссылка на каждую запись в стор (правило Fingerprint).
  const layoutKey = useWorkspaceStore((s) => (
    s.splitPanes.map((p, i) => `${i}:${p.column ?? i}:${p.tabId}:${(p.tabs || []).map((e) => e.tabId).join('~')}`).join('|')
      + '#' + s.splitFocusedIndex
      + '#' + (s.activeProjectId || '')
      // Полоса одиночного центра — тоже раскладка: без неё картинка показала бы
      // одну вкладку там, где на экране их три.
      + '#' + (s.centerStrips[s.activeProjectId || ''] || []).map((e) => e.tabId).join('~')
      // Перегородки двигает человек, и рисунок обязан двигаться следом.
      + '#' + splitSizesFingerprint(s.splitSizes)
  ));
  const windows: WindowCell[] = React.useMemo(() => {
    const st = useWorkspaceStore.getState();
    const centerTabId = st.activeProjectId
      ? st.openProjects.get(st.activeProjectId)?.activeTabId || ''
      : '';
    const view = describeWorkspace(
      st.splitPanes,
      st.splitFocusedIndex,
      st.activeProjectId && centerTabId
        ? { projectId: st.activeProjectId, tabId: centerTabId }
        : null,
    );
    // Пропорции берём У САМОЙ рабочей области, а не пересчитываем: доли окон и
    // колонок уже посчитаны для экрана, вместе с перетянутыми перегородками.
    // Свой расчёт был бы вторым ответом на тот же вопрос и разошёлся бы с
    // первым — что и произошло, когда рисунок раздавал всем окнам одну высоту.
    const rects = paneGridRects(st.splitPanes, st.splitSizes);
    const cells = (view.windows as WindowCell[]).map((w) => ({
      ...w,
      heightPct: rects[w.index]?.heightPct ?? 100,
      widthPct: rects[w.index]?.widthPct ?? 100,
    }));
    // Одиночный центр: модель окон не знает про его полосу — она живёт у
    // проекта, — а картинка обязана показывать то же, что шапка на экране.
    if (st.splitPanes.length === 0 && cells.length === 1) {
      const strip = st.centerStrips[st.activeProjectId || ''] || [];
      const only = { ...cells[0], heightPct: 100, widthPct: 100 };
      return strip.length > 1 ? [{ ...only, tabs: strip.map((e) => ({ ...e })) }] : [only];
    }
    return cells;
  }, [layoutKey]);

  // Ширина каждой колонки — как на экране. Берём с ЛЮБОГО её окна: доля колонки
  // общая для всех её строк.
  const columnWidths = React.useMemo(() => {
    const st = useWorkspaceStore.getState();
    const count = Math.max(1, paneColumns(st.splitPanes).length || 1);
    return Array.from({ length: count }, (_, columnIndex) => (
      windows.find((w) => w.column === columnIndex)?.widthPct ?? (100 / count)
    ));
  }, [windows]);
  const columnCount = columnWidths.length;

  const pick = (target: WindowCell) => {
    const store = useWorkspaceStore.getState();
    if (mode === 'swap') {
      if (sourcePaneIndex === null || sourcePaneIndex === undefined) return;
      store.swapSplitPanes(sourcePaneIndex, target.index);
      onDone();
      return;
    }
    if (!projectId || !tabId) return;
    if (store.splitPanes.length === 0) {
      // Разделения нет — единственное окно это центр, и его полоса живёт у
      // проекта. Тот же путь, что у двойного клика по шапке.
      store.addTabToCenterStrip(projectId, tabId);
    } else {
      store.addTabToSplitPaneStrip(target.index, projectId, tabId);
    }
    onDone();
  };

  // Уже здесь — переносить некуда. Строка остаётся видимой (её исчезновение
  // читалось бы как «пункт пропал»), но помечена и не выбирается.
  //
  // Берём НОМЕР ОКНА (`index`), а не позицию в списке: список идёт в экранном
  // порядке, и как только он разойдётся с порядком хранения, сравнение начнёт
  // гасить чужой прямоугольник — тот, куда человек как раз и целился.
  //
  // При обмене «своё» — это окно, ОТКУДА меняем: поменять окно с самим собой
  // нельзя, и прямоугольник должен об этом сказать, а не молча ничего не делать.
  const homeIndex = mode === 'swap'
    ? (sourcePaneIndex ?? -1)
    : (windows.find((w) => w.tabs.some((e) => e.tabId === tabId))?.index ?? -1);

  return (
    <div className="p-2">
      {/* Строки-объяснения здесь нет намеренно (юзер, 2026-08-18): картинка
          повторяет раскладку на экране и читается без расшифровки, а подпись
          пересказывала жест, который человек как раз и делает. */}
      <div
        data-move-to-window-map
        style={{
          display: 'grid',
          // Колонки в тех же долях, что на экране, а не поровну.
          gridTemplateColumns: columnWidths.map((w) => `${Math.max(w, 8)}fr`).join(' '),
          gap: 4,
          // Общая высота фиксирована, а делят её окна по своим долям: только так
          // «окно на всю высоту колонки» и рисуется на всю высоту.
          height: MAP_HEIGHT_PX,
        }}
      >
        {/* Прямоугольники раскладываются по КОЛОНКАМ и строкам, как окна на
            экране: сетка по колонкам, а окна одной колонки идут друг под другом
            в своей ячейке. Плоский ряд нарисовал бы два окна рядом там, где они
            одно под другим, — то есть раскладку, которой нет. */}
        {Array.from({ length: columnCount }, (_, columnIndex) => (
          <div key={columnIndex} style={{ display: 'flex', flexDirection: 'column', gap: 4, minHeight: 0 }}>
            {windows.filter((w) => w.column === columnIndex).map((w) => {
              const here = w.index === homeIndex;
              const label = w.empty
                ? 'Пустое окно'
                : (w.tabs.length > 1 ? `${w.tabs.length} вкладки` : 'Одна вкладка');
              return (
                <button
                  key={w.index}
                  type="button"
                  disabled={here}
                  data-move-to-window={w.index}
                  title={mode === 'swap'
                    ? (here ? 'Это и есть текущее окно' : `Поменять местами с окном ${w.index + 1}`)
                    : (here ? 'Вкладка уже в этом окне' : `Перенести в окно ${w.index + 1}`)}
                  onMouseEnter={(e) => {
                    if (here) return;
                    (e.currentTarget as HTMLElement).style.borderColor = 'rgba(255,255,255,0.75)';
                    (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.10)';
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLElement).style.borderColor = w.focused
                      ? 'rgba(255,255,255,0.45)'
                      : 'rgba(255,255,255,0.15)';
                    (e.currentTarget as HTMLElement).style.background = here
                      ? 'rgba(255,255,255,0.03)'
                      : 'rgba(255,255,255,0.06)';
                  }}
                  onClick={() => { if (!here) pick(w); }}
                  style={{
                    // Доля высоты — с экрана. Фиксированная высота у всех и была
                    // тем самым враньём: окно во всю колонку рисовалось
                    // половиной, потому что рядом стояло второе такое же.
                    flex: `${Math.max(w.heightPct, 1)} 1 0`,
                    minHeight: 0,
                    borderRadius: 5,
                    // Рамка ярче у окна в фокусе — тот же язык, что у самой
                    // рабочей области: белый контур значит «здесь фокус».
                    border: `1px solid ${w.focused ? 'rgba(255,255,255,0.45)' : 'rgba(255,255,255,0.15)'}`,
                    background: here ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.06)',
                    color: here ? '#5f5f65' : '#c8c8ce',
                    fontSize: 10,
                    lineHeight: 1.2,
                    padding: '4px 6px',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'space-between',
                    alignItems: 'flex-start',
                    overflow: 'hidden',
                    cursor: here ? 'default' : 'pointer',
                    transition: 'background-color 0.12s, border-color 0.12s',
                    textAlign: 'left',
                    minWidth: 0,
                  }}
                >
                  <span style={{ opacity: 0.7 }}>{`Окно ${w.index + 1}`}</span>
                  <span style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    maxWidth: '100%',
                  }}>
                    {here ? (mode === 'swap' ? 'это окно' : 'вкладка здесь') : label}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
