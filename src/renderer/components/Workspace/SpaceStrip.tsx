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
  // Второе число — сколько из этих вкладок СЕЙЧАС работают (агент отвечает).
  // Отвечает на «идёт ли там что-то, пока я смотрю в другое пространство»;
  // ноль не показывается вовсе — «0 работает» это не факт, а шум.
  const busy = useWorkspaceStore((s) => s.workspaceSpaceBusyTabCount(id));
  const [renaming, setRenaming] = useState(false);
  // Наведение подсвечивает чип: до этого единственным ответом на «я сейчас
  // попаду сюда» была форма курсора, и полоса читалась как неживая. Юзер:
  // *«при наведении должен как-то бэкграунд меняться… а не чисто
  // курсор-пойнтер»*.
  const [hovered, setHovered] = useState(false);
  // Клик принят — говорим это СРАЗУ, до тяжёлой работы. Само переключение
  // (перестройка списка вкладок и окон) блокирует главный поток на ~200мс,
  // поэтому крутящийся лоадер тут невозможен физически — кадры не рисуются.
  // Вместо него чип мгновенно принимает вид активного: сначала кадр с этой
  // подсветкой, потом работа (два rAF — первый гарантирует отрисовку, второй
  // выполняет переключение). Юзер: «отпускаю курсор и после отпускания ничего
  // не происходит ещё несколько сотен миллисекунд».
  const [pending, setPending] = useState(false);
  React.useEffect(() => {
    // Переключение состоялось (или не состоялось) — обещание чипа снимается.
    setPending(false);
  }, [active]);
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
        if (renaming || active || pending) return;
        setPending(true);
        // Кадр с подсветкой — ДО работы: rAF-колбэк выполняется до отрисовки
        // своего кадра, поэтому переключение уходит во второй.
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            useWorkspaceStore.getState().switchWorkspaceSpace(id);
          });
        });
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
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
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
        // Три состояния, и наведённое НЕ дотягивает до текущего: подсветка
        // отвечает «попадёшь сюда», а не «ты здесь». Сравняй их — и полоса
        // перестанет отвечать на вопрос, где человек находится.
        // `pending` рисуется как активное: решение принято, человек уже «там» —
        // это не наведение, а подтверждение клика в первом же кадре.
        color: (active || pending) ? '#e8e8ea' : (hovered ? '#cfcfd4' : '#9b9ba1'),
        background: (active || pending)
          ? 'rgba(255,255,255,0.10)'
          : (hovered ? 'rgba(255,255,255,0.055)' : 'transparent'),
        border: '1px solid ' + ((active || pending)
          ? 'rgba(255,255,255,0.22)'
          : (hovered ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.08)')),
        transition: 'background 90ms ease-out, color 90ms ease-out, border-color 90ms ease-out',
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
      {/* «·N» — сколько из них сейчас работают. Отделено точкой, а не скобками
          или дробью: это не «N из M», а второй, независимый факт о том же
          месте. Появляется только когда работа действительно идёт, и держит
          свой цвет в обоих состояниях чипа — «там что-то происходит» не должно
          тускнеть от того, что человек стоит в другом пространстве. */}
      {busy > 0 && (
        <span
          data-space-busy-count
          title={`Работают: ${busy}`}
          className="space-busy-glow"
          style={{
            flexShrink: 0,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 2,
            fontSize: Math.max(9, fontSize - 2.5),
            fontWeight: 700,
            fontVariantNumeric: 'tabular-nums',
            // ЯНТАРНЫЙ, литералом. `var(--color-accent)` — это синий #007acc
            // (юзер: «какой нахуй синий цвет, лоудер обозначается оранжевым,
            // желательно переливающимся»). Язык занятости в приложении —
            // янтарь #d97706; перелив — классом space-busy-glow (globals.css).
            color: '#d97706',
          }}
        >
          <span aria-hidden style={{ opacity: 0.55 }}>·</span>
          {busy}
        </span>
      )}
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
