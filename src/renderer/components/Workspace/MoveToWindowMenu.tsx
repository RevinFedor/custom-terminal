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
import { describeWorkspace, paneColumns } from '../../utils/splitPanesModel.mjs';

interface WindowCell {
  index: number;
  column: number;
  row: number;
  focused: boolean;
  empty?: boolean;
  shownTabId: string | null;
  tabs: Array<{ projectId: string; tabId: string }>;
}

/** Строка меню + карта окон, которая появляется по наведению. */
export default function MoveToWindowMenu({
  projectId,
  tabId,
  onDone,
}: {
  projectId: string;
  tabId: string;
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
    const cells = view.windows as WindowCell[];
    // Одиночный центр: модель окон не знает про его полосу — она живёт у
    // проекта, — а картинка обязана показывать то же, что шапка на экране.
    if (st.splitPanes.length === 0 && cells.length === 1) {
      const strip = st.centerStrips[st.activeProjectId || ''] || [];
      if (strip.length > 1) return [{ ...cells[0], tabs: strip.map((e) => ({ ...e })) }];
    }
    return cells;
  }, [layoutKey]);

  const columnCount = React.useMemo(() => {
    const st = useWorkspaceStore.getState();
    return Math.max(1, paneColumns(st.splitPanes).length || 1);
  }, [layoutKey]);

  const moveTo = (target: WindowCell) => {
    const store = useWorkspaceStore.getState();
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
  const homeIndex = windows.find((w) => w.tabs.some((e) => e.tabId === tabId))?.index ?? -1;

  return (
    <div className="p-2">
      <div className="px-1 pb-2 text-[11px] text-[#888]">
        Наведите на окно — вкладка встанет в конец его полосы
      </div>
      <div
        data-move-to-window-map
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))`,
          gap: 4,
        }}
      >
        {/* Прямоугольники раскладываются по КОЛОНКАМ и строкам, как окна на
            экране: сетка по колонкам, а окна одной колонки идут друг под другом
            в своей ячейке. Плоский ряд нарисовал бы два окна рядом там, где они
            одно под другим, — то есть раскладку, которой нет. */}
        {Array.from({ length: columnCount }, (_, columnIndex) => (
          <div key={columnIndex} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
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
                  title={here ? 'Вкладка уже в этом окне' : `Перенести в окно ${w.index + 1}`}
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
                  onClick={() => { if (!here) moveTo(w); }}
                  style={{
                    height: 46,
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
                    {here ? 'вкладка здесь' : label}
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
