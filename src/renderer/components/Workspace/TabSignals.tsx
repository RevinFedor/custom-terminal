// ONE implementation of the visual signals a tab card carries. Every surface
// that draws a "tab" renders these through this file — the vertical sidebar
// list, the pane header, the Ctrl+Tab switcher, the Run after picker.
//
// Why this file exists: the same three signals used to be re-declared in each
// of those surfaces, sharing only the color table in tabChrome.ts. They drifted
// exactly as duplicated code does — the pane-header copy anchored its process
// bar to the ROW (1215px wide) instead of the tab chip (195px), so the bar sat
// ~900px away from the tab it described while still being the right width, the
// right color and on the right edge. A fifth copy would have drifted the same
// way, so the geometry now lives in one place and the callers only say WHERE
// the box is.
//
// Contract for callers:
//   • The host element must be `position: relative` (or otherwise a containing
//     block) and should be the element the signal is ABOUT — the tab chip, the
//     card, the row — never a wider layout wrapper.
//   • Edge is not a per-surface choice: it comes from Settings
//     (processBar.position) so every bar in the app points the same way. A bar
//     on the opposite edge reads as a different signal.
//   • Orientation is fixed VERTICAL, full height of the host. A horizontal bar
//     along the bottom seam is a different signal to the eye, even with the
//     same color and thickness.

import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useUIStore } from '../../store/useUIStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useOrchestrationStore } from '../../store/useOrchestrationStore';
import { contextUsageColor, contextUsageDisplayValue } from '../../utils/contextUsageMeter.mjs';
import { isStaleAgainstPending } from '../../utils/pendingResume';

const { ipcRenderer } = window.require('electron');

/** Width of the process bar. Same on every surface. */
export const TAB_PROCESS_BAR_W_PX = 3;
// Every clickable square on a tab uses one hover acknowledgement. Status and
// task markers answer different questions, but both must visibly say “this
// exact square is clickable” before the user presses it.
const TAB_MARKER_HOVER_SCALE = 1.32;

export interface TabProcessBarProps {
  /** A PTY/SDK runtime is alive → static colored bar. */
  hasProcess: boolean;
  /** The AI turn is streaming → shimmer crawls over the bar. */
  busy: boolean;
  /** Busy inherited from a linked tab → purple base + purple-safe shimmer. */
  inheritedBusy?: boolean;
  /** Rounded corners on the bar's own side; pass the host's radius. */
  radius?: number | string;
  /**
   * Pull the bar outward by N px. Cards reserving a transparent border for
   * dashed drag states need this so the bar lands on the visible edge.
   */
  outset?: number;
  zIndex?: number;
  /**
   * Local overrides of the process-bar CSS variables. Only the Settings preview
   * uses this: it must show CANDIDATE values the user is dragging, before they
   * are committed to :root. Live surfaces must never pass this — they inherit
   * the committed values so every bar in the app looks the same.
   */
  cssVars?: React.CSSProperties;
  /** Force the bar's edge, ignoring Settings. Settings preview only. */
  positionOverride?: 'left' | 'right';
}

/**
 * Process / AI-busy bar: a vertical strip on the configured edge of its host,
 * carrying two INDEPENDENT signals at once — a static color while a runtime is
 * alive, and a moving shimmer while the agent is thinking. Either can show
 * without the other (an SDK tab thinks with no PTY at all).
 *
 * Renders nothing when there is no signal, so callers can mount it
 * unconditionally.
 */
export function TabProcessBar({
  hasProcess,
  busy,
  inheritedBusy = false,
  radius = 0,
  outset = 0,
  zIndex = 5,
  cssVars,
  positionOverride,
}: TabProcessBarProps) {
  const position = useUIStore((s) => s.processBar.position);
  if (!hasProcess && !busy && !inheritedBusy) return null;
  const onRight = (positionOverride ?? position) === 'right';
  const edge = outset ? `${-outset}px` : 0;
  return (
    <span
      className="tab-process-bar-static"
      data-tab-process-bar
      aria-hidden
      style={{
        position: 'absolute',
        ...(onRight ? { right: edge } : { left: edge }),
        top: 0,
        bottom: 0,
        width: `${TAB_PROCESS_BAR_W_PX}px`,
        // Clips the shimmer overlay to the strip.
        overflow: 'hidden',
        pointerEvents: 'none',
        zIndex,
        ...(inheritedBusy
          ? { backgroundColor: 'var(--process-bar-inherited-color, #A855F7)' }
          : null),
        ...(onRight
          ? { borderTopRightRadius: radius, borderBottomRightRadius: radius }
          : { borderTopLeftRadius: radius, borderBottomLeftRadius: radius }),
        ...cssVars,
      }}
    >
      {busy && <span className="tab-process-bar-ai-shimmer-overlay" />}
      {inheritedBusy && (
        <span className="tab-process-bar-ai-shimmer-overlay tab-process-bar-inherited-shimmer-overlay" />
      )}
    </span>
  );
}

/**
 * Codex Fast (priority service tier) — жёлтая молния на ВЕРХНЕМ конце полоски
 * процесса.
 *
 * Почему именно там, а не по центру и не отдельным значком в строке: полоска
 * процесса — единственный элемент карточки, который принадлежит только ей и
 * тянется на всю её высоту. Молния на её конце читается как «свойство ЭТОЙ
 * вкладки», а не как ещё один значок в общей строке названия.
 *
 * Ключевое требование пользователя — принадлежность: значок стоит у ВЕРХНЕЙ
 * границы, не по центру шва между вкладками, и выходит за границу лишь частью
 * своей высоты. Стой он серединой на шве — было бы не понять, к верхней вкладке
 * он относится или к нижней.
 */
export const TAB_FAST_BADGE_SIZE_PX = 11;
/**
 * Какая доля значка вылезает НАРУЖУ за верхнюю границу карточки.
 *
 * 0.3 — верх диапазона, названного пользователем («выходить за границу только на
 * 20-30%»). Больше — значок начинает делить шов пополам и терять хозяина.
 */
export const TAB_FAST_BADGE_OUTSIDE_RATIO = 0.3;

/**
 * Наружный выступ, ОГРАНИЧЕННЫЙ зазором между карточками.
 *
 * Зазор настраивается пользователем (Settings → Размеры, 0-16px). При зазоре
 * меньше выступа значок заходил бы на ПРЕДЫДУЩУЮ вкладку — то есть возвращалась
 * бы ровно та неоднозначность, из-за которой его и не ставят серединой на шов
 * (замерено: при зазоре 0 значок накрывал соседа на 3px, при 2 — на 1px).
 * При нулевом зазоре выступа нет вовсе: значок садится вплотную к верхнему
 * краю внутри своей карточки — места снаружи просто нет.
 */
export function tabFastBadgeOutsidePx(gapPx: number, size = TAB_FAST_BADGE_SIZE_PX) {
  const wanted = Math.round(size * TAB_FAST_BADGE_OUTSIDE_RATIO);
  return Math.max(0, Math.min(wanted, Math.floor(Number(gapPx) || 0)));
}

/**
 * Подпись на ВЕРХНЕЙ границе карточки — что сделает ⌘-клик.
 *
 * Тем же приёмом, что молния Fast: садится на границу карточки, а не внутрь и
 * не снаружи. Отличия два, и оба намеренные.
 *
 * Первое: смещена ВНУТРЬ вкладки, а не поровну по шву. Подпись длинная, и
 * ровно по границе она делила бы шов пополам — было бы не понять, к какой из
 * двух вкладок она относится. У молнии эта же задача решена долей высоты
 * снаружи; здесь — тем, что бо́льшая часть строки лежит на своей карточке.
 *
 * Второе: появляется только при зажатом Shift, потому что описывает не состояние
 * вкладки, а то, что произойдёт от жеста. Постоянная подпись на каждой карточке
 * была бы шумом.
 */
export const TAB_CMD_HINT_FONT_PX = 12;

export function TabCmdHint({ text, visible }: { text: string; visible: boolean }) {
  if (!visible) return null;
  return (
    <span
      data-tab-cmd-hint
      aria-hidden
      style={{
        position: 'absolute',
        // Смещение ВНУТРЬ: строка стоит на границе, но бо́льшей частью лежит на
        // своей карточке, а не на шве между двумя.
        top: -Math.round(TAB_CMD_HINT_FONT_PX * 0.28),
        left: 8,
        maxWidth: 'calc(100% - 16px)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        padding: '0 4px',
        borderRadius: 3,
        // Фон под текстом обязателен: строка ложится и на рамку карточки, и на
        // зазор, и на соседнюю вкладку — без подложки она читалась бы как часть
        // чужого имени.
        background: 'rgba(20,20,24,0.94)',
        boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.22)',
        color: '#e8e8ea',
        fontSize: TAB_CMD_HINT_FONT_PX,
        fontWeight: 600,
        lineHeight: 1.35,
        pointerEvents: 'none',
        zIndex: 9,
      }}
    >
      {text}
    </span>
  );
}

export function TabFastBadge({
  active,
  title = 'Codex Fast: priority',
  zIndex = 7,
}: {
  /** Точно доказанный priority-tier текущего writer'а. Ничего не рисуем на unknown. */
  active: boolean;
  title?: string;
  zIndex?: number;
}) {
  if (!active) return null;
  const size = TAB_FAST_BADGE_SIZE_PX;
  return (
    <span
      data-tab-fast-badge
      title={title}
      aria-hidden
      style={{
        position: 'relative',
        width: size,
        height: size,
        display: 'block',
        flexShrink: 0,
        pointerEvents: 'none',
        zIndex,
        color: '#fbbf24',
        // Тонкая тёмная окантовка глифа: молния ложится и на полоску процесса, и
        // на фон вкладки, и на зазор между вкладками — без неё она теряется на
        // светлой зелёной полоске.
        filter: 'drop-shadow(0 0 1px rgba(0,0,0,0.85))',
      }}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="currentColor"
        stroke="rgba(0,0,0,0.55)"
        strokeWidth="1.1"
        strokeLinejoin="round"
      >
        {/* Тот же контур, что у кнопки Fast в панели управления, — один и тот же
            смысл обязан выглядеть одинаково. Там он обводкой, здесь залит:
            на 11px поверх полоски обводка сливается в пятно. */}
        <path d="M13 2 4 14h7l-1 8 10-13h-7l0-7Z" />
      </svg>
    </span>
  );
}

/**
 * Маркер статуса, по которому МОЖНО КЛИКНУТЬ: открывает выбор статуса на месте,
 * не активируя вкладку.
 *
 * Раньше маркер был чисто индикатором, и смена статуса жила только в
 * контекстном меню вкладки — три шага ради одного цвета. Юзер: *«при наведении
 * должен быть курсор pointer, я на него нажимаю, при этом никакого фокуса по
 * вкладке, перехода нет… выбираю нужный тип, и он сменяется, при этом фокус не
 * меняется вообще никак»*.
 *
 * ОДИН компонент на все три поверхности (карточка списка, чип в шапке окна,
 * строка плана задач использует свой пикер задачных статусов — это другой
 * словарь). Список статусов и его вид — те же, что в контекстном меню вкладки:
 * второй набор строк разошёлся бы с первым на первом же изменении палитры.
 *
 * Событийная изоляция — обе фазы: pointerdown (фокус окон и панелей живёт на
 * capture-фазе pointerdown) и click (активация вкладки). stopPropagation на
 * одном click недостаточен — карточка взяла бы фокус ещё на нажатии.
 */
export function TabStatusMarkerButton({
  projectId,
  tabId,
  color,
  title,
  sizePx,
  left = 5,
  topOffsetPx = 1,
  zIndex = 6,
}: TabStatusMarkerProps & { projectId: string; tabId: string }) {
  const shape = useUIStore((s) => s.statusMarker.shape);
  const settingsSize = useUIStore((s) => s.statusMarker.sizePx);
  const statuses = useUIStore((s) => s.sessionStatuses);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [markerHovered, setMarkerHovered] = useState(false);
  const markerRef = useRef<HTMLSpanElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!menu) return undefined;
    const close = () => setMenu(null);
    const closeOutside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menuRef.current?.contains(target) || markerRef.current?.contains(target)) return;
      setMenu(null);
    };
    // Capture is essential: controlled inputs and terminal/editor surfaces can
    // stop bubbling. The overlay must still close before that outside gesture
    // reaches its target, while a click INSIDE the portal remains untouched.
    window.addEventListener('pointerdown', closeOutside, true);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('pointerdown', closeOutside, true);
      window.removeEventListener('blur', close);
    };
  }, [menu]);
  if (!color) return null;
  const size = sizePx ?? settingsSize;
  const currentId = useWorkspaceStore.getState()
    .openProjects.get(projectId)?.tabs.get(tabId)?.sessionStatus;
  return (
    <>
      <span
        ref={markerRef}
        data-tab-status-marker
        data-tab-status-marker-button
        title={title}
        onPointerDown={(e) => {
          // Никакого фокуса вкладке/окну: фокус живёт на capture-pointerdown,
          // и одного stopPropagation на click уже поздно.
          e.stopPropagation();
          if (e.button !== 0) e.preventDefault();
        }}
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          setMenu((current) => current ? null : { x: e.clientX, y: e.clientY });
        }}
        onDoubleClick={(e) => e.stopPropagation()}
        onMouseEnter={() => setMarkerHovered(true)}
        onMouseLeave={() => setMarkerHovered(false)}
        style={{
          position: 'absolute',
          left: `${left}px`,
          top: `calc(50% + ${topOffsetPx}px)`,
          transform: `translateY(-50%) scale(${markerHovered ? TAB_MARKER_HOVER_SCALE : 1})`,
          transformOrigin: 'center',
          transition: 'transform 90ms ease, filter 90ms ease',
          filter: markerHovered ? 'brightness(1.18)' : 'none',
          width: `${size}px`,
          height: `${size}px`,
          borderRadius: shape === 'square' ? '2px' : '50%',
          backgroundColor: color,
          border: '1px solid rgba(0,0,0,0.4)',
          cursor: 'pointer',
          zIndex,
        }}
      />
      {menu && createPortal(
        <div
          ref={menuRef}
          data-tab-status-marker-menu
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'fixed',
            left: Math.max(8, Math.min(menu.x, window.innerWidth - 228)),
            top: Math.max(8, Math.min(menu.y + 6, window.innerHeight - Math.min(320, 16 + statuses.length * 30))),
            width: 220,
            maxHeight: 312,
            overflowY: 'auto',
            zIndex: 2147482600,
            padding: 3,
            borderRadius: 8,
            background: '#18181b',
            border: '1px solid #3a3a40',
            boxShadow: '0 14px 34px rgba(0,0,0,0.6)',
          }}
        >
          {statuses.map((s) => {
            const selected = currentId === s.id;
            return (
              <button
                key={s.id}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  // Повторный клик на активный статус снимает его — как в
                  // контекстном меню вкладки (один жест, один смысл).
                  useWorkspaceStore.getState()
                    .setTabSessionStatus(projectId, tabId, selected ? null : s.id);
                  setMenu(null);
                }}
                style={{
                  display: 'flex', alignItems: 'center', width: '100%', gap: 8,
                  padding: '5px 7px', color: '#ccc', background: 'transparent',
                  border: 0, borderRadius: 5, cursor: 'pointer', textAlign: 'left',
                  fontSize: 12, outline: 'none',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.07)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              >
                <span style={{
                  width: 11, height: 11, flexShrink: 0,
                  borderRadius: shape === 'square' ? 2 : '50%',
                  backgroundColor: s.color, border: '1px solid rgba(0,0,0,0.4)',
                }} />
                <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.label}</span>
                {selected && <span style={{ marginLeft: 'auto', color: '#fff' }}>✓</span>}
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </>
  );
}

/**
 * Заполнение контекстного окна — число в левом НИЖНЕМ углу карточки.
 *
 * Та же механика, что у молнии Fast: абсолютная позиция у угла, часть высоты
 * снаружи, выступ ограничен зазором между карточками. Отличается только угол
 * (низ вместо верха) и то, что содержимое — число, а не глиф.
 *
 * Цвет и формат НЕ решаются здесь: они берутся из `contextUsageMeter.mjs`, из
 * которого их берёт и панель управления. Иначе одно и то же число показывалось
 * бы в двух местах разными цветами — в панели ещё зелёное, на карточке уже
 * жёлтое, и пользователь перестал бы верить обоим.
 *
 * Знак процента опущен намеренно: в углу карточки он не добавляет смысла (число
 * тут может значить только одно), а места занимает столько же, сколько цифра.
 */
export const TAB_CONTEXT_BADGE_FONT_PX = 8;

/**
 * На сколько число заезжает ЗА левый край карточки, чтобы лечь на полоску
 * процесса.
 *
 * Это не «красивый отступ», а ширина самой полоски минус пиксель. Поэтому
 * смещение считается от ширины полоски,
 * а не подбирается на глаз: поменяется полоска — поедет и число.
 */
export const CONTEXT_BADGE_BAR_OVERLAP_PX = TAB_PROCESS_BAR_W_PX - 1;

/**
 * Фон плашки под числом — тот же, что у панели управления под терминалом.
 *
 * Взят оттуда, а не подобран заново: это одна и та же роль — спокойная подложка
 * служебного показания, — и два независимо выбранных серых различались бы ровно
 * настолько, чтобы это читалось как небрежность.
 */
export const TAB_CONTEXT_BADGE_BG = '#161616';

/**
 * Заполнение контекста ОДНОЙ вкладки, по тем же каналам, что у панели
 * управления, и с тем же durable-стартом.
 *
 * Три канала, потому что их три у самого значения: Claude присылает его в
 * bridge-кадре, Codex — своим IPC, SDK — оконным событием. Слушать надо все:
 * подписка на один канал даёт пустой угол у половины вкладок.
 *
 * Начальное значение читается из БД, а не ждёт первого события. События несут
 * только ИЗМЕНЕНИЯ: вкладка, у которой ход прошёл раньше (или процесс уже
 * закрыт), не пришлёт ничего, и без чтения её число не появилось бы никогда —
 * та же ловушка, что описана в `useTabActivitySignals` про «стартовое значение».
 */
export function useTabContextUsage(tabId: string): number | null {
  const [pct, setPct] = useState<number | null>(null);
  // Сессия, которой вкладка принадлежит СЕЙЧАС. Нужна не для показа, а для
  // отказа: см. проверку владения ниже. Селектор гранулярный (возвращает
  // строку), поэтому подписка не тянет за собой Map.
  const boundClaudeSessionId = useWorkspaceStore((s) => {
    for (const workspace of s.openProjects.values()) {
      const tab = workspace.tabs.get(tabId);
      if (tab) return tab.claudeSessionId || '';
    }
    return '';
  });

  useEffect(() => {
    let disposed = false;
    setPct(null);
    ipcRenderer.invoke('tab:get-context-pct', { tabId })
      .then((r: any) => {
        if (disposed) return;
        const seeded = Number(r?.pct);
        if (Number.isFinite(seeded) && seeded > 0) setPct((prev) => prev ?? seeded);
      })
      .catch(() => {});

    const apply = (data: any) => {
      if (disposed || data?.tabId !== tabId) return;
      const next = Number(data?.contextPct);
      if (Number.isFinite(next) && next >= 0) setPct(next);
    };
    // Совпадения по вкладке НЕДОСТАТОЧНО, чтобы принять число.
    //
    // Claude никогда не удаляет свои bridge-файлы, и при повторном
    // использовании PID кадр давно мёртвой сессии приходит с ЭТИМ tabId —
    // именно тот шрам, что описан в fix-bridge-stale-takeover.md. Панель
    // управления такие кадры отбрасывает по двум признакам сразу, а карточка
    // раньше принимала любой: в итоге на одну и ту же вкладку в двух местах
    // показывались РАЗНЫЕ числа, причём неверное — на более заметном.
    //
    // Проверка ровно та же, что в панели, чтобы поверхности не разошлись снова:
    //   • кадр называет не ту сессию, к которой вкладка уже привязана;
    //   • для вкладки идёт resume, и кадр пришёл от другой сессии.
    const ownsFrame = (data: any) => {
      const frameSessionId = typeof data?.sessionId === 'string' ? data.sessionId : '';
      if (!frameSessionId) return true;
      if (isStaleAgainstPending(tabId, frameSessionId)) return false;
      return true;
    };
    const onClaudeBridge = (_: unknown, data: any) => {
      const frameSessionId = typeof data?.sessionId === 'string' ? data.sessionId : '';
      if (boundClaudeSessionId && frameSessionId && frameSessionId !== boundClaudeSessionId) return;
      if (!ownsFrame(data)) return;
      apply(data);
    };
    const onCodexContext = (_: unknown, data: any) => {
      if (!ownsFrame(data)) return;
      apply(data);
    };
    // SDK-вкладка шлёт своё значение окном и без id сессии: у неё нет ни
    // bridge-файла, ни повторно используемого PID, поэтому и подменить кадр
    // нечем — проверять здесь нечего.
    const onWindowEvent = (event: Event) => apply((event as CustomEvent).detail || {});

    ipcRenderer.on('claude:bridge-update', onClaudeBridge);
    ipcRenderer.on('codex:context-update', onCodexContext);
    window.addEventListener('sdk-context-update', onWindowEvent);
    return () => {
      disposed = true;
      ipcRenderer.removeListener('claude:bridge-update', onClaudeBridge);
      ipcRenderer.removeListener('codex:context-update', onCodexContext);
      window.removeEventListener('sdk-context-update', onWindowEvent);
    };
  }, [boundClaudeSessionId, tabId]);

  return pct;
}

export function TabContextUsageBadge({
  pct,
  zIndex = 7,
}: {
  /** Доля заполнения. Ничего не рисуем, пока измерения не было. */
  pct?: number | null;
  zIndex?: number;
}) {
  const value = contextUsageDisplayValue(pct);
  if (value === null) return null;
  return (
    <span
      data-tab-context-usage
      title={`Использовано ${value}% контекстного окна`}
      aria-hidden
      style={{
        position: 'relative',
        display: 'inline-block',
        flexShrink: 0,
        // `line-height: 1` — без него строка свисает на лишние ~40% кегля и
        // число уезжает на соседнюю карточку даже при достаточном зазоре.
        lineHeight: 1,
        fontSize: TAB_CONTEXT_BADGE_FONT_PX,
        fontVariantNumeric: 'tabular-nums',
        fontWeight: 600,
        color: contextUsageColor(pct),
        pointerEvents: 'none',
        zIndex,
        // Плашка под числом — тот же фон, что у панели управления внизу, чтобы
        // число читалось одинаково на любом фоне: на цвете вкладки, на полоске
        // процесса, на строке задач у нижнего шва.
        //
        // Заменила тёмное свечение вокруг глифа: свечение размывалось поверх
        // цветной полоски и на светлых вкладках не давало нужного контраста.
        //
        // Своих отступов у плашки НЕТ намеренно (просьба пользователя): её
        // границы — это строчный бокс числа и ничего сверх него. Блок при этом
        // не может вырасти в принципе: элемент вынут из потока, поэтому на
        // размеры карточки он не влияет ни при каких значениях.
        backgroundColor: TAB_CONTEXT_BADGE_BG,
        // Скругление не занимает места: оно срезает углы плашки внутрь.
        borderRadius: 2,
      }}
    >
      {value}
    </span>
  );
}

/** One shared top-left signal lane for sidebar rows and pane chips. */
export function TabTopLeftSignals({
  fastActive,
  contextPct,
  minContextPct = 0,
  zIndex = 8,
}: {
  fastActive: boolean;
  contextPct?: number | null;
  /** Pane strips suppress low-value noise; sidebar keeps the complete reading. */
  minContextPct?: number;
  zIndex?: number;
}) {
  const gapPx = useUIStore((s) => s.tabGeometry.gap);
  const numericPct = Number(contextPct);
  const showContext = Number.isFinite(numericPct) && numericPct >= minContextPct;
  if (!showContext && !fastActive) return null;
  return (
    <span
      data-tab-top-left-signals
      aria-hidden
      style={{
        position: 'absolute',
        // Same boundary crossing the old right-bottom value had, now shared by
        // the whole left lane. Context comes first, Fast second.
        left: -CONTEXT_BADGE_BAR_OVERLAP_PX,
        top: 1 - tabFastBadgeOutsidePx(gapPx, TAB_FAST_BADGE_SIZE_PX),
        display: 'inline-flex',
        alignItems: 'center',
        gap: 1,
        height: TAB_FAST_BADGE_SIZE_PX,
        pointerEvents: 'none',
        zIndex,
      }}
    >
      {showContext && <TabContextUsageBadge pct={numericPct} zIndex={zIndex} />}
      <TabFastBadge active={fastActive} zIndex={zIndex} />
    </span>
  );
}

/**
 * Live process / AI-busy signals for ONE tab, read from the same broadcasts the
 * sidebar list consumes.
 *
 * THREE signals, not two. The third — "this tab is waiting for a delegated
 * session it started" — used to be missing here, so every surface built on this
 * hook (the pane header chip, the pane's recent-tabs list) drew an idle tab
 * while the sidebar card drew the purple waiting strip for the SAME tab at the
 * SAME moment. The sidebar was not more correct, only better wired: it asked
 * the orchestration store itself. Asking it once, here, is what keeps the
 * surfaces from disagreeing again — the whole reason this file exists.
 *
 * Subscribed per surface rather than threaded down as props: the pane header is
 * rendered from three call sites, and a prop chain left some of them silently
 * without a loader.
 *
 * THE STARTING VALUE IS THE HARD PART. The broadcasts carry only TRANSITIONS —
 * "this tab just started answering", "it just finished". A surface that mounts
 * while an answer is already in flight has missed the start and will hear
 * nothing until the end, so it renders an idle tab for as long as the work
 * lasts. That is exactly what the pane header did: the sidebar showed the
 * loader, the header for the SAME tab showed none, because the header had been
 * mounted after the turn began.
 *
 * So neither signal is bootstrapped from the broadcasts:
 *   • "a process is alive"   ← asked from the main process on mount;
 *   • "an answer is running" ← read from the tab record in the store, which the
 *     app-wide listeners keep current for EVERY tab regardless of which one is
 *     on screen (store.setAiBusy).
 * After that, transitions keep both up to date as before.
 */
export type SharedTabActivityMaps = {
  processStatus?: ReadonlyMap<string, boolean>;
  busyTabs?: ReadonlyMap<string, boolean>;
  pasteBusyTabs?: ReadonlyMap<string, boolean>;
};

export function useTabActivitySignals(
  tabId: string,
  shared: SharedTabActivityMaps | null = null,
): {
  hasProcess: boolean;
  busy: boolean;
  inheritedBusy: boolean;
} {
  const [localHasProcess, setLocalHasProcess] = useState(false);
  const hasSharedProcess = shared?.processStatus !== undefined;
  const hasSharedBusy = shared?.busyTabs !== undefined;
  // Waiting for a delegated session. Same source and same precedence as the
  // sidebar card: a tab answering itself shows its OWN colour, so the two
  // states never paint over each other.
  const orchestrationBusy = useOrchestrationStore((s) => s.inheritedBusyTabIds.has(tabId));
  // Seed from the durable per-tab flag, then follow the live edges. Subscribing
  // to the store here (instead of reading it once) also covers the tabs whose
  // busy state arrives through a channel this hook does not listen to — SDK
  // tabs have no PTY broadcast of their own.
  const storeBusy = useWorkspaceStore((s) => {
    for (const workspace of s.openProjects.values()) {
      const tab = workspace.tabs.get(tabId);
      if (tab) return !!tab.aiBusy;
    }
    return false;
  });
  const [busyEdge, setBusyEdge] = useState<boolean | null>(null);
  const busy = busyEdge ?? storeBusy;

  useEffect(() => {
    // Workspace already owns one app-wide process/busy snapshot. Pane chips
    // must read it instead of polling again when a workflow swaps its chrome:
    // six freshly addressed chips used to issue six process-tree lookups on
    // every return to `main`. Standalone surfaces keep the event/IPC fallback.
    if (hasSharedProcess && hasSharedBusy) return undefined;
    let disposed = false;
    if (!hasSharedProcess) setLocalHasProcess(false);
    if (!hasSharedBusy) setBusyEdge(null);
    const onBusy = (_: unknown, data: { tabId?: string; busy?: boolean; reason?: string }) => {
      if (disposed || data?.tabId !== tabId) return;
      // Spinner frames are a presentation heuristic, not a turn boundary — the
      // same exclusion the queue runner applies.
      if (data.reason === 'spinner') return;
      if (!hasSharedBusy) setBusyEdge(data.busy === true);
    };
    const onStarted = (_: unknown, data: { tabId?: string }) => {
      if (!hasSharedProcess && !disposed && data?.tabId === tabId) setLocalHasProcess(true);
    };
    const onFinished = (_: unknown, data: { tabId?: string }) => {
      if (!hasSharedProcess && !disposed && data?.tabId === tabId) setLocalHasProcess(false);
    };
    if (!hasSharedBusy) {
      ipcRenderer.on('claude:busy-state', onBusy);
      ipcRenderer.on('codex:busy-state', onBusy);
      ipcRenderer.on('gemini:busy-state', onBusy);
    }
    if (!hasSharedProcess) {
      ipcRenderer.on('terminal:command-started', onStarted);
      ipcRenderer.on('terminal:command-finished', onFinished);
      ipcRenderer.invoke('terminal:getCommandState', { tabId, caller: 'TabSignals' })
        .then((state: any) => { if (!disposed) setLocalHasProcess(!!state?.isRunning); })
        .catch(() => {});
    }
    return () => {
      disposed = true;
      if (!hasSharedBusy) {
        ipcRenderer.removeListener('claude:busy-state', onBusy);
        ipcRenderer.removeListener('codex:busy-state', onBusy);
        ipcRenderer.removeListener('gemini:busy-state', onBusy);
      }
      if (!hasSharedProcess) {
        ipcRenderer.removeListener('terminal:command-started', onStarted);
        ipcRenderer.removeListener('terminal:command-finished', onFinished);
      }
    };
  }, [hasSharedBusy, hasSharedProcess, tabId]);

  const hasProcess = hasSharedProcess
    ? shared?.processStatus?.get(tabId) === true
    : localHasProcess;
  const sharedBusy = shared?.busyTabs?.get(tabId) === true
    || shared?.pasteBusyTabs?.get(tabId) === true;
  const effectiveBusy = hasSharedBusy ? sharedBusy : busy;

  return {
    hasProcess,
    busy: effectiveBusy,
    inheritedBusy: orchestrationBusy && !effectiveBusy,
  };
}

// Task squares along the card's bottom seam. Geometry is shared so the pane
// header and the sidebar card draw the same lane; only the host differs.
export const TASK_MARKER_SIZE_PX = 8;
export const TASK_MARKER_GAP_PX = 3;
export const TASK_MARKER_HOVER_SCALE = TAB_MARKER_HOVER_SCALE;
export const TASK_MARKER_LANE_HEIGHT_PX = Math.ceil(TASK_MARKER_SIZE_PX * TASK_MARKER_HOVER_SCALE);
export const TASK_MARKER_DEFAULT_COLOR = '#73737a';

/** One task square. Click is the caller's business (navigate, focus, …). */
export function TabTaskMarker({
  color,
  shape,
  title,
  onClick,
}: {
  color: string;
  shape: 'dot' | 'square';
  title: string;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      data-task-plan-tab-marker
      title={title}
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'block',
        width: TASK_MARKER_SIZE_PX,
        height: TASK_MARKER_SIZE_PX,
        flex: `0 0 ${TASK_MARKER_SIZE_PX}px`,
        padding: 0,
        borderRadius: shape === 'square' ? 1 : '50%',
        backgroundColor: color,
        border: '1px solid rgba(0,0,0,0.38)',
        boxSizing: 'border-box',
        pointerEvents: 'auto',
        cursor: 'pointer',
        outline: 'none',
        transform: `scale(${hovered ? TASK_MARKER_HOVER_SCALE : 1})`,
        transformOrigin: 'center bottom',
        transition: 'transform 90ms ease, filter 90ms ease',
        filter: hovered ? 'brightness(1.18)' : 'none',
      }}
    />
  );
}

export interface TabStatusMarkerProps {
  /** Resolved status color; falsy → nothing renders. */
  color?: string | null;
  title?: string;
  /** Overrides the size from Settings (task lane needs a slightly larger dot). */
  sizePx?: number;
  /** Distance from the host's left edge. Clears the process bar by default. */
  left?: number;
  /** Vertical nudge, compensating optical baseline shift of lowercase text. */
  topOffsetPx?: number;
  zIndex?: number;
}

/**
 * Session status marker — a dot or square whose shape and size come from
 * Settings. Always on the LEFT, even when the process bar is on the right: it
 * belongs next to the tab NAME, and reading it means reading the name.
 */
export function TabStatusMarker({
  color,
  title,
  sizePx,
  left = 5,
  topOffsetPx = 1,
  zIndex = 6,
}: TabStatusMarkerProps) {
  const shape = useUIStore((s) => s.statusMarker.shape);
  const settingsSize = useUIStore((s) => s.statusMarker.sizePx);
  if (!color) return null;
  const size = sizePx ?? settingsSize;
  return (
    <span
      data-tab-status-marker
      title={title}
      style={{
        position: 'absolute',
        left: `${left}px`,
        top: `calc(50% + ${topOffsetPx}px)`,
        transform: 'translateY(-50%)',
        width: `${size}px`,
        height: `${size}px`,
        borderRadius: shape === 'square' ? '2px' : '50%',
        backgroundColor: color,
        border: '1px solid rgba(0,0,0,0.4)',
        pointerEvents: 'none',
        zIndex,
      }}
    />
  );
}
