// Чип «Новая вкладка» — место в полосе окна, у которого ещё нет вкладки.
//
// Выглядит как чип, потому что ЛЕЖИТ в одном ряду с чипами и занимает там
// место: человек читает полосу как одну строку, и элемент другой высоты или
// другого кегля читался бы как посторонний виджет, случайно попавший в шапку.
// Поэтому размеры берутся из тех же настроек (Settings → Размеры) и через тот
// же резолвер, что у `PaneTabChip` — двух источников размера здесь быть не
// может, иначе строка начнёт прыгать при смене настроек.
//
// И при этом он НЕ выдаёт себя за вкладку: пунктирная рамка вместо заливки,
// серый вместо цвета агента, и никаких признаков жизни — ни полоски процесса,
// ни статуса, ни квадратиков задач. Их нечему показывать: за этим чипом нет ни
// сессии, ни процесса, ни истории. Пунктир — тот же язык, которым в приложении
// уже говорят «здесь пока ничего нет» (квадрат проекта без иконки).
//
// Гестуры ровно две, и обе про место, а не про вкладку: клик показывает его
// страницу выбора, средний клик закрывает — то же соответствие, что у чипа
// вкладки («показать» / «убрать из окна»). Переименования нет: имени нет.
// Перетаскивания нет намеренно: заготовка не может стать грузом переноса
// вкладок между окнами и проектами, и ей нечего нести.

import React from 'react';
import { useUIStore } from '../../store/useUIStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import {
  resolveTabCardMetrics,
  TAB_CARD_LINE_HEIGHT,
} from '../../utils/tabCardVisual.mjs';

export interface PaneChooserChipProps {
  slotId: string;
  paneIndex: number | null;
  /** Показана ли сейчас страница выбора именно этого места. */
  selected: boolean;
  /** Владеет ли фокусом окно, в котором стоит чип. */
  paneFocused: boolean;
}

export default function PaneChooserChip({
  slotId, paneIndex, selected, paneFocused,
}: PaneChooserChipProps) {
  const [hovered, setHovered] = React.useState(false);
  const tabGeo = useUIStore((s) => s.tabGeometry);
  const tabsFontSize = useUIStore((s) => s.tabsFontSize);
  const metrics = resolveTabCardMetrics(tabGeo, { fontSize: tabsFontSize });

  const active = selected && paneFocused;
  const border = active
    ? 'rgba(255,255,255,0.55)'
    : (hovered ? 'rgba(255,255,255,0.34)' : 'rgba(255,255,255,0.20)');
  const color = active ? '#e6e6ea' : (hovered ? '#c8c8ce' : '#8f8f94');

  return (
    <span
      data-pane-chooser-chip
      data-chooser-slot-id={slotId}
      data-chooser-selected={selected ? '1' : '0'}
      title="Новая вкладка — выберите, чем её начать. Средний клик закрывает."
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onPointerDown={(e) => {
        // Как у чипа вкладки: фокус забирает только левое нажатие, чтобы
        // правый клик не уводил поверхность из-под открываемого меню.
        e.stopPropagation();
        if (e.button !== 0) e.preventDefault();
      }}
      onClick={(e) => {
        e.stopPropagation();
        if (paneIndex === null || paneIndex === undefined) return;
        useWorkspaceStore.getState().selectWindowTabChooser(paneIndex, slotId);
      }}
      // Двойной клик по САМОМУ чипу — это про него, а не «ещё одно место сюда».
      // Без остановки он всплыл бы в полосу и открыл вторую заготовку под
      // пальцем человека, который целился в уже открытую.
      onDoubleClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onAuxClick={(e) => {
        if (e.button !== 1) return;
        e.preventDefault();
        e.stopPropagation();
        if (paneIndex === null || paneIndex === undefined) return;
        useWorkspaceStore.getState().closeWindowTabChooser(paneIndex, slotId);
      }}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: metrics.padding,
        borderRadius: metrics.borderRadius,
        fontSize: metrics.fontSize,
        lineHeight: TAB_CARD_LINE_HEIGHT,
        whiteSpace: 'nowrap',
        cursor: 'pointer',
        userSelect: 'none',
        color,
        background: active ? 'rgba(255,255,255,0.06)' : 'transparent',
        // Пунктир, а не заливка: чип занимает место, но ещё ничем не стал.
        border: `1px dashed ${border}`,
        // Рамка добавляет 2px к коробке, а чип вкладки её не имеет. Без
        // компенсации строка полосы стала бы на 2px выше именно из-за
        // заготовки — то есть открытие страницы выбора двигало бы шапку.
        margin: -1,
        flexShrink: 0,
      }}
    >
      <span aria-hidden style={{ fontSize: Math.max(10, metrics.fontSize - 1), lineHeight: 1 }}>+</span>
      <span>Новая вкладка</span>
    </span>
  );
}
