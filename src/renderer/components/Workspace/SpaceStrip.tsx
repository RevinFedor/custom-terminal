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
// пустому месту создаёт, правый клик открывает меню действий, колёсико удаляет.
// Переименование начинается из меню и выделяет имя целиком.

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useProjectsStore } from '../../store/useProjectsStore';
import { useUIStore } from '../../store/useUIStore';
import { resolveStripOverflow, scrollOffsetForChip } from '../../utils/paneStripLayout.mjs';
import { PROJECT_CARD_MAX_H, SPACE_STRIP_H } from '../../constants/layout';
import { clampMenuToViewport } from '../../utils/menuViewportClamp.mjs';
import { resolveWorkflowActivityCounts } from '../../utils/workflowActivityCounts.mjs';
import WorkflowActivityBadges from './WorkflowActivityBadges';
import {
  CONTEXT_MENU_METRICS,
  CONTEXT_MENU_METRICS_HOOK,
  CONTEXT_MENU_PANEL_STYLE,
  CONTEXT_MENU_ROW_STYLE,
  contextMenuEstimatedHeight,
} from '../UI/contextMenuMetrics.mjs';

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

type SpaceActivityProps = {
  processStatus: ReadonlyMap<string, boolean>;
  busyTabs: ReadonlyMap<string, boolean>;
  pasteBusyTabs: ReadonlyMap<string, boolean>;
  inheritedBusyTabIds: ReadonlySet<string>;
};

function SpaceChip({
  id,
  active,
  onRename,
  processStatus,
  busyTabs,
  pasteBusyTabs,
  inheritedBusyTabIds,
}: {
  id: string;
  active: boolean;
  onRename: (id: string, name: string) => void;
} & SpaceActivityProps) {
  // Metadata подписана по одному workflow. Родитель держит только fingerprint
  // списка id, поэтому выбор большой data-URL иконки не заставляет всю полосу
  // подписываться на массив `spaces` целиком.
  const name = useWorkspaceStore((s) => s.spaces.find((space) => space.id === id)?.name || 'Workflow');
  const configuredIcon = useWorkspaceStore((s) => s.spaces.find((space) => space.id === id)?.icon);
  const projectIdsKey = useWorkspaceStore((s) => (
    s.spaces.find((space) => space.id === id)?.projectIds?.join('\u0000') || ''
  ));
  const defaultProjectId = projectIdsKey ? projectIdsKey.split('\u0000')[0] : '';
  const fallbackProjectIcon = useProjectsStore((s) => (
    defaultProjectId ? (s.projects[defaultProjectId]?.icon || null) : null
  ));
  // undefined = legacy workflow, которому ещё не успели скопировать старую
  // цветную иконку. null = пользователь явно очистил иконку.
  const icon = configuredIcon === undefined ? fallbackProjectIcon : configuredIcon;
  // Кегль и мера карточки — те же, что у карточек проектов наверху. Полоса
  // пространств и полоса проектов это две строки одного языка: свой мелкий
  // размер делал бы её похожей на служебную подпись, а не на переключатель.
  const fontSize = useUIStore((s) => s.projectTabsFontSize);
  // Зелёный badge физически ПЕРЕЕХАЛ с project-row на workflow-row, поэтому
  // считает тот же сигнал всех вкладок дочерних проектов, а не только вкладки,
  // которые сейчас разложены в окнах. Иначе фоновый процесс исчезал бы из
  // навигации, стоило его вкладке не попасть в текущую раскладку.
  //
  // SDK alive хранится в самой вкладке и участвует в fingerprint: terminal
  // process/busy карты приходят из App пропсами, а SDK-переход при неизменном
  // layout иначе не перерисовал бы chip.
  const activityKey = useWorkspaceStore((s) => {
    const projectIds = s.spaces.find((space) => space.id === id)?.projectIds || [];
    const entries: string[] = [];
    projectIds.forEach((projectId) => {
      s.openProjects.get(projectId)?.tabs.forEach((tab, tabId) => {
        entries.push(`${tabId}\u001f${tab.sdkProcessAlive ? '1' : '0'}`);
      });
    });
    return entries.join('\u001e');
  });
  const activity = React.useMemo(() => {
    const entries = activityKey
      ? activityKey.split('\u001e').map((part) => {
        const at = part.lastIndexOf('\u001f');
        return { tabId: part.slice(0, at), sdkAlive: part.slice(at + 1) === '1' };
      })
      : [];
    return resolveWorkflowActivityCounts(entries.map(({ tabId, sdkAlive }) => ({
      tabId,
      sdkAlive,
      processAlive: processStatus.get(tabId) === true,
      busy: busyTabs.get(tabId) === true,
      pasteBusy: pasteBusyTabs.get(tabId) === true,
      inheritedBusy: inheritedBusyTabIds.has(tabId),
    })));
  }, [activityKey, processStatus, busyTabs, pasteBusyTabs, inheritedBusyTabIds]);
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
  const canDelete = useWorkspaceStore((s) => s.spaces.length > 1);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!contextMenu) return undefined;
    const close = () => setContextMenu(null);
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [contextMenu]);

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
        e.preventDefault();
        e.stopPropagation();
        const point = clampMenuToViewport({
          x: e.clientX,
          y: e.clientY,
          width: CONTEXT_MENU_METRICS.minWidth,
          height: contextMenuEstimatedHeight({ rows: 3 }),
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
        });
        setContextMenu(point);
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
        <>
          {icon ? (
            <img
              data-workflow-icon={id}
              src={icon}
              alt=""
              draggable={false}
              style={{ width: 16, height: 16, borderRadius: 4, objectFit: 'cover', flexShrink: 0 }}
            />
          ) : (
            <span
              aria-hidden
              style={{
                width: 16,
                height: 16,
                borderRadius: 4,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                border: '1px solid rgba(255,255,255,0.16)',
                background: 'rgba(255,255,255,0.06)',
                color: '#9b9ba1',
                fontSize: 9,
                fontWeight: 700,
              }}
            >
              {name.trim().slice(0, 1).toUpperCase() || 'W'}
            </span>
          )}
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</span>
        </>
      )}
      <WorkflowActivityBadges
        activeCount={activity.activeCount}
        busyCount={activity.busyCount}
        active={active}
      />
      {contextMenu && ReactDOM.createPortal(
        <div
          data-workflow-context-menu={id}
          data-context-menu-metrics={CONTEXT_MENU_METRICS_HOOK}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}
          style={{
            ...CONTEXT_MENU_PANEL_STYLE,
            position: 'fixed',
            left: contextMenu.x,
            top: contextMenu.y,
            zIndex: 10020,
            border: '1px solid #3a3a3a',
            background: '#252526',
            boxShadow: '0 10px 26px rgba(0,0,0,0.45)',
            overflow: 'hidden',
          }}
        >
          <button
            type="button"
            data-context-menu-row="ordinary"
            data-workflow-context-action="rename"
            className="hover:bg-white/10"
            onClick={() => {
              setContextMenu(null);
              setDraft(name);
              setRenaming(true);
            }}
            style={{ ...CONTEXT_MENU_ROW_STYLE, ...workflowMenuItemStyle }}
          >
            Переименовать
          </button>
          <button
            type="button"
            data-context-menu-row="ordinary"
            data-workflow-context-action="settings"
            className="hover:bg-white/10"
            onClick={() => {
              setContextMenu(null);
              window.dispatchEvent(new CustomEvent('settings:open', { detail: { tab: 'projects' } }));
            }}
            style={{ ...CONTEXT_MENU_ROW_STYLE, ...workflowMenuItemStyle }}
          >
            Иконка и проекты…
          </button>
          <button
            type="button"
            data-context-menu-row="ordinary"
            data-workflow-context-action="delete"
            className={canDelete ? 'hover:bg-red-500/10' : ''}
            disabled={!canDelete}
            onClick={() => {
              if (!canDelete) return;
              setContextMenu(null);
              useWorkspaceStore.getState().removeWorkspaceSpace(id);
            }}
            style={{
              ...CONTEXT_MENU_ROW_STYLE,
              ...workflowMenuItemStyle,
              color: canDelete ? '#f87171' : '#626262',
              cursor: canDelete ? 'pointer' : 'not-allowed',
            }}
          >
            Удалить workflow
          </button>
        </div>,
        document.body,
      )}
    </span>
  );
}

const workflowMenuItemStyle: React.CSSProperties = {
  width: '100%',
  display: 'flex',
  alignItems: 'center',
  border: 'none',
  background: 'transparent',
  color: '#d6d6d6',
  fontSize: 11,
  textAlign: 'left',
  cursor: 'pointer',
};

export default function SpaceStrip({
  processStatus,
  busyTabs,
  pasteBusyTabs,
  inheritedBusyTabIds,
}: SpaceActivityProps) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [overflow, setOverflow] = useState({ left: 0, right: 0 });
  const chipMetricsRef = useRef<Array<{ id: string; left: number; width: number }>>([]);
  const viewportWidthRef = useRef(0);
  const scrollLeftRef = useRef(0);
  // Строковый отпечаток, не массив: селектор, отдающий объекты, — новая ссылка
  // на каждую запись в стор (правило Fingerprint).
  const spacesKey = useWorkspaceStore((s) => s.spaces.map((space) => space.id).join('\u0000'));
  const activeSpaceId = useWorkspaceStore((s) => s.activeSpaceId);
  const spaceIds = React.useMemo(() => spacesKey.split('\u0000').filter(Boolean), [spacesKey]);
  const renameSpace = useCallback((id: string, name: string) => {
    useWorkspaceStore.getState().renameWorkspaceSpace(id, name);
  }, []);

  const applyCachedOverflow = useCallback((scrollLeft?: number) => {
    const el = scrollerRef.current;
    if (!el) return;
    const next = resolveStripOverflow({
      chips: chipMetricsRef.current,
      scrollLeft: scrollLeft ?? scrollLeftRef.current,
      viewportWidth: viewportWidthRef.current || el.clientWidth,
    });
    setOverflow((prev) => (
      prev.left === next.hiddenLeft && prev.right === next.hiddenRight
        ? prev
        : { left: next.hiddenLeft, right: next.hiddenRight }
    ));
  }, []);

  // DOM geometry is read only when chips/container actually resize. Active
  // space changes do not alter chip widths, so consulting offsetLeft in their
  // layout-effect merely forced a full workspace layout (48ms self-time in the
  // switch CPU profile).
  const measure = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    chipMetricsRef.current = Array.from(el.querySelectorAll<HTMLElement>('[data-space-chip]'))
      .map((node) => ({
        id: node.dataset.spaceChip || '',
        left: node.offsetLeft,
        width: node.offsetWidth,
      }));
    viewportWidthRef.current = el.clientWidth;
    scrollLeftRef.current = el.scrollLeft;
    applyCachedOverflow();
  }, [applyCachedOverflow]);

  const revealActiveFromCache = useCallback((spaceId: string) => {
    const el = scrollerRef.current;
    if (!el) return;
    const chip = chipMetricsRef.current.find((candidate) => candidate.id === spaceId);
    if (!chip) return;
    const next = scrollOffsetForChip({
      chip,
      scrollLeft: scrollLeftRef.current,
      viewportWidth: viewportWidthRef.current || el.clientWidth,
    });
    if (next !== scrollLeftRef.current) {
      scrollLeftRef.current = next;
      el.scrollLeft = next;
    }
    applyCachedOverflow(next);
  }, [applyCachedOverflow]);

  // Текущее пространство должно быть ВИДНО: полоса говорит, где ты находишься,
  // и уехавший за край активный чип отвечает на этот вопрос молчанием.
  useLayoutEffect(() => {
    measure();
    revealActiveFromCache(activeSpaceId);
  }, [spacesKey, measure, revealActiveFromCache]);

  useLayoutEffect(() => {
    revealActiveFromCache(activeSpaceId);
  }, [activeSpaceId, revealActiveFromCache]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    el.querySelectorAll<HTMLElement>('[data-space-chip]').forEach((chip) => observer.observe(chip));
    return () => observer.disconnect();
  }, [measure, spacesKey]);

  const scrollBy = (direction: -1 | 1) => {
    const el = scrollerRef.current;
    if (!el) return;
    const next = scrollLeftRef.current + direction * Math.max(80, viewportWidthRef.current * 0.6);
    scrollLeftRef.current = next;
    el.scrollLeft = next;
    applyCachedOverflow(next);
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
        onScroll={(event) => {
          scrollLeftRef.current = event.currentTarget.scrollLeft;
          applyCachedOverflow(scrollLeftRef.current);
        }}
        onWheel={(e) => {
          const el = scrollerRef.current;
          if (!el || el.scrollWidth <= el.clientWidth) return;
          const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
          if (!delta) return;
          e.preventDefault();
          const next = scrollLeftRef.current + delta;
          scrollLeftRef.current = next;
          el.scrollLeft = next;
          applyCachedOverflow(next);
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
        {spaceIds.map((spaceId) => (
          <SpaceChip
            key={spaceId}
            id={spaceId}
            active={spaceId === activeSpaceId}
            onRename={renameSpace}
            processStatus={processStatus}
            busyTabs={busyTabs}
            pasteBusyTabs={pasteBusyTabs}
            inheritedBusyTabIds={inheritedBusyTabIds}
          />
        ))}
      </div>
      <SpaceOverflowCount side="right" count={overflow.right} onClick={() => scrollBy(1)} />
    </div>
  );
}
