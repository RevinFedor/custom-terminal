// Полоса рабочих пространств — первая строка рабочей области.
//
// Пространство это ВИД на раскладку окон: свои окна, свои полосы вкладок, свои
// перегородки. Вкладки ему не принадлежат — они живут в списке слева, поэтому
// удалить пространство дёшево: исчезает раскладка, вкладки и процессы целы. Из
// этого же следует, что подтверждения при удалении нет.
//
// Стоит НАД окнами и внутри рабочей области, а не над боковым списком: полоса
// про то, что справа от него. Высота та же, что у полосы проектов наверху, —
// две строки-«переключателя» одной меры читаются как один язык.
//
// Жесты повторяют вкладки, и это не совпадение, а условие: двойной клик по
// пустому месту создаёт, правый клик переименовывает прямо в чипе с выделенным
// текстом, колёсико удаляет. Человек уже умеет это делать этажом ниже.

import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useUIStore } from '../../store/useUIStore';
import { resolveStripOverflow, scrollOffsetForChip } from '../../utils/paneStripLayout.mjs';
import { PROJECT_CARD_MAX_H, SPACE_STRIP_H } from '../../constants/layout';

/** «×N» — пространства, полностью ушедшие за край. Тот же ответ, что в шапке окна. */
function SpaceOverflowCount({ side, count, onClick }: {
  side: 'left' | 'right';
  count: number;
  onClick: () => void;
}) {
  if (count <= 0) return null;
  return (
    <button
      type="button"
      data-space-overflow={side}
      title={`${side === 'left' ? 'Слева' : 'Справа'} ещё ${count} — клик прокрутит`}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      onDoubleClick={(e) => e.stopPropagation()}
      style={{
        flexShrink: 0,
        minWidth: 15,
        height: 13,
        lineHeight: '13px',
        padding: '0 3px',
        fontSize: 9.5,
        fontWeight: 700,
        color: '#c2c2c8',
        background: 'rgba(255,255,255,0.10)',
        border: 'none',
        borderRadius: 3,
        cursor: 'pointer',
      }}
    >
      {'×' + count}
    </button>
  );
}

function SpaceChip({ id, name, index, active, onRename }: {
  id: string;
  name: string;
  index: number;
  active: boolean;
  onRename: (id: string, name: string) => void;
}) {
  // Кегль и мера карточки — те же, что у карточек проектов наверху. Полоса
  // пространств и полоса проектов это две строки одного языка: свой мелкий
  // размер делал бы её похожей на служебную подпись, а не на переключатель.
  const fontSize = useUIStore((s) => s.projectTabsFontSize);
  // Число рядом с именем — сколько РАЗНЫХ вкладок разложено здесь. Показывается
  // всегда, включая «1»: число, которое то появляется, то исчезает, читается как
  // оповещение о событии, а это просто размер.
  const count = useWorkspaceStore((s) => s.workspaceSpaceTabCount(id));
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');
  // Выделять текст можно ровно ОДИН раз, при появлении поля: `ref` зовётся на
  // каждой перерисовке, то есть на каждую букву, и повторный `select()` привёл
  // бы к тому, что следующая буква стирает предыдущую.
  const focusedRef = useRef(false);

  const commit = () => {
    const next = draft.trim();
    setRenaming(false);
    focusedRef.current = false;
    if (next && next !== name) onRename(id, next);
  };

  return (
    <span
      data-space-chip={id}
      data-space-active={active ? '1' : '0'}
      title={active ? `${name} — это пространство` : `Перейти в «${name}»`}
      onClick={(e) => {
        e.stopPropagation();
        if (renaming) return;
        useWorkspaceStore.getState().switchWorkspaceSpace(id);
      }}
      onContextMenu={(e) => {
        // Правый клик = переименовать. Отдельного меню на один пункт здесь нет:
        // меню из одной строки — это лишний шаг до того же действия.
        e.preventDefault();
        e.stopPropagation();
        setDraft(name);
        setRenaming(true);
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      onAuxClick={(e) => {
        if (e.button !== 1) return;
        e.preventDefault();
        e.stopPropagation();
        useWorkspaceStore.getState().removeWorkspaceSpace(id);
      }}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        flexShrink: 0,
        maxWidth: 220,
        height: PROJECT_CARD_MAX_H,
        padding: '0 8px',
        borderRadius: 4,
        fontSize,
        lineHeight: `${PROJECT_CARD_MAX_H}px`,
        whiteSpace: 'nowrap',
        cursor: 'pointer',
        userSelect: 'none',
        color: active ? '#e8e8ea' : '#9b9ba1',
        background: active ? 'rgba(255,255,255,0.10)' : 'transparent',
        border: '1px solid ' + (active ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.08)'),
      }}
    >
      {renaming ? (
        <input
          ref={(node) => {
            if (!node || focusedRef.current) return;
            focusedRef.current = true;
            node.focus();
            node.select();
          }}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onBlur={commit}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') commit();
            else if (e.key === 'Escape') { setRenaming(false); focusedRef.current = false; }
          }}
          style={{
            width: Math.max(60, draft.length * 6.5 + 12),
            minWidth: 60,
            padding: '0 4px',
            border: 'none',
            outline: 'none',
            background: '#333',
            borderRadius: 3,
            // Рамка тенью, а не border'ом: тень не занимает места, и чип не
            // раздувается на время правки, сдвигая соседей.
            boxShadow: 'inset 0 0 0 1px var(--color-accent)',
            color: '#fff',
            font: 'inherit',
          }}
        />
      ) : (
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</span>
      )}
      <span
        data-space-tab-count
        style={{
          flexShrink: 0,
          fontSize: Math.max(9, fontSize - 2.5),
          fontWeight: 700,
          fontVariantNumeric: 'tabular-nums',
          color: active ? '#b9b9c0' : '#75757c',
        }}
      >
        {count}
      </span>
    </span>
  );
}

export default function SpaceStrip() {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [overflow, setOverflow] = useState({ left: 0, right: 0 });
  // Строковый отпечаток, не массив: селектор, отдающий объекты, — новая ссылка
  // на каждую запись в стор (правило Fingerprint).
  const spacesKey = useWorkspaceStore((s) => s.spaces.map((x) => `${x.id}:${x.name}`).join(','));
  const activeSpaceId = useWorkspaceStore((s) => s.activeSpaceId);
  const spaces = React.useMemo(
    () => spacesKey.split(',').filter(Boolean).map((pair) => {
      const at = pair.indexOf(':');
      return { id: pair.slice(0, at), name: pair.slice(at + 1) };
    }),
    [spacesKey],
  );
  const renameSpace = useCallback((id: string, name: string) => {
    useWorkspaceStore.getState().renameWorkspaceSpace(id, name);
  }, []);

  const measure = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const chips = Array.from(el.querySelectorAll<HTMLElement>('[data-space-chip]'))
      .map((node) => ({ left: node.offsetLeft, width: node.offsetWidth }));
    const next = resolveStripOverflow({
      chips,
      scrollLeft: el.scrollLeft,
      viewportWidth: el.clientWidth,
    });
    setOverflow((prev) => (
      prev.left === next.hiddenLeft && prev.right === next.hiddenRight
        ? prev
        : { left: next.hiddenLeft, right: next.hiddenRight }
    ));
  }, []);

  // Текущее пространство должно быть ВИДНО: полоса говорит, где ты находишься,
  // и уехавший за край активный чип отвечает на этот вопрос молчанием.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    measure();
    const node = el.querySelector<HTMLElement>(`[data-space-chip="${CSS.escape(activeSpaceId)}"]`);
    if (!node) return;
    const next = scrollOffsetForChip({
      chip: { left: node.offsetLeft, width: node.offsetWidth },
      scrollLeft: el.scrollLeft,
      viewportWidth: el.clientWidth,
    });
    if (next !== el.scrollLeft) { el.scrollLeft = next; measure(); }
  }, [activeSpaceId, spacesKey, measure]);

  const scrollBy = (direction: -1 | 1) => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollLeft += direction * Math.max(80, el.clientWidth * 0.6);
    measure();
  };

  return (
    <div
      data-space-strip
      // Двойной клик по ПУСТОМУ месту — новое пространство. Тот же жест, что
      // создаёт вкладку в шапке окна, и по той же причине: пустое место полосы
      // принадлежит полосе.
      onDoubleClick={(e) => {
        e.stopPropagation();
        useWorkspaceStore.getState().addWorkspaceSpace();
      }}
      style={{
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        height: SPACE_STRIP_H,
        padding: '0 8px',
        boxSizing: 'border-box',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        userSelect: 'none',
      }}
    >
      <SpaceOverflowCount side="left" count={overflow.left} onClick={() => scrollBy(-1)} />
      <div
        ref={scrollerRef}
        data-space-strip-scroller
        onScroll={measure}
        onWheel={(e) => {
          const el = scrollerRef.current;
          if (!el || el.scrollWidth <= el.clientWidth) return;
          const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
          if (!delta) return;
          e.preventDefault();
          el.scrollLeft += delta;
          measure();
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          minWidth: 0,
          flex: 1,
          overflowX: 'auto',
          overflowY: 'hidden',
          scrollbarWidth: 'none',
        }}
      >
        {spaces.map((space, index) => (
          <SpaceChip
            key={space.id}
            id={space.id}
            name={space.name}
            index={index}
            active={space.id === activeSpaceId}
            onRename={renameSpace}
          />
        ))}
      </div>
      <SpaceOverflowCount side="right" count={overflow.right} onClick={() => scrollBy(1)} />
    </div>
  );
}
