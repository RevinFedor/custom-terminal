import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Folder } from 'lucide-react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useProjectsStore } from '../../store/useProjectsStore';
import { useUIStore } from '../../store/useUIStore';
import { isInboxProjectId, INBOX_PROJECT_NAME } from '../../constants/systemProjects';
import {
  buildSwitcherRows,
  initialCtrlIndex,
  selectableIndices,
  stepIndex,
} from '../../utils/tabSwitcherModel.mjs';
import { onScreenTabIds } from '../../utils/tabVisitHistoryRule.mjs';
import {
  ITERATION_MAX_PER_TAB,
  ITERATION_MAX_TOTAL,
  ITERATION_MIN_QUERY,
  buildIterationRows,
  collectIterationTargets,
  countIterationHits,
  countIterationTabs,
  iterationHitPosition,
  iterationPanelMaxHeight,
  mergeIterationChunk,
  resolveIterationTarget,
  splitByOffsets,
} from '../../utils/iterationSearchModel.mjs';
import { isFileMissing, probeFiles, subscribeMissingFiles } from '../../utils/missingFileTracker';
import { TOP_STRIP_H } from '../../constants/layout';
import { TabListProjectHeader, TabListTabRow } from './TabListRows';
import { useOrchestrationStore } from '../../store/useOrchestrationStore';

// Ctrl+Tab (MRU hold-and-release) + Cmd+P (search) switcher over ALL open
// projects. Projects render as non-selectable headers; tabs indent under
// them and carry the full tab visual language: chrome tint, process bar
// strip (+AI shimmer), session status marker, folder badge, file icon.
//
// Self-contained singleton: mounted once in App.tsx, owns its window-level
// key listeners (capture phase, so xterm/composer never see the keys). See
// методология "Глобальные события → singleton hook на корне".
//
// Mouse entry point: any surface can open the search-mode panel by dispatching
// TAB_SWITCHER_OPEN_EVENT. A window event, not a store field — the overlay owns
// its own transient open state (mode/query/selection), and lifting that into
// the store would make every keystroke in the search box a global update.

const { ipcRenderer } = window.require('electron');

export const TAB_SWITCHER_OPEN_EVENT = 'tab-switcher:open';

/** Open the full switcher panel (search mode) from a click anywhere in the UI. */
export function openTabSwitcherPanel(): void {
  window.dispatchEvent(new CustomEvent(TAB_SWITCHER_OPEN_EVENT));
}

type Mode = 'ctrl' | 'search';

// Что ищет поле ввода. Переключатель справа в самом поле.
//
// «tabs» — как называется вкладка: мгновенно, локально, по именам открытого.
// «iterations» — что в этих вкладках ПИСАЛИ: буквальный поиск по промптам, одна
// строка результата = один промпт. Это разные вопросы к одному набору данных,
// поэтому один поиск не может ответить на оба: имя вкладки не знает, о чём в
// ней писали, а промпт не знает, как назвали вкладку.
//
// По умолчанию всегда «tabs»: он мгновенный и локальный, а поиск по промптам
// читает файлы сессий. Режим намеренно НЕ запоминается между открытиями —
// переключатель чаще всего открывают, чтобы просто перейти на вкладку, и
// застать его в чужом режиме дороже, чем один клик.
type SearchScope = 'tabs' | 'iterations';

// Ctrl+Tab is ALWAYS global (one shared history). Per-pane scope existed for a
// while and was removed 2026-08-17: the user picks tabs by the sidebar's map,
// and a pane-local journal answered a question nobody asked.
//
// ── Ctrl+Tab = «ты здесь» + то, чего не видно ────────────────────────────
//
// ROW 1 is the tab you are on right now — an anchor, not a destination. The
// highlight starts on ROW 2, which is where releasing Ctrl takes you (Alt+Tab
// and VS Code's Ctrl+Tab read exactly this way). Without the anchor the panel
// opened straight onto the target and the gesture lost its reference point:
// the user saw where he was going but not what he was leaving, so the first
// row read as "the current tab" and pointed at the wrong one.
//
// EVERYTHING ELSE on screen stays out — the other panes' tabs. "Bring back what
// I cannot see" has no answer in a tab already filling half the screen. Such a
// tab returns to the list the moment it stops being visible: its pane emptied,
// the layout collapsed, another tab took its slot.
//
// Cmd+P is the OPPOSITE and must stay so: it is a search, so an existing tab
// has to be findable by name whatever is on screen. Same component, same rows —
// but the ctrl list is "here I am, where can I go back to" and the search list
// is "everything". Filtering the search would make it lie about what exists.

// Одно совпадение = один промпт. Приходит из main целиком готовым: и кусок для
// свёрнутой строки, и полный текст, и смещения подсветки для обоих. Renderer
// сам не ищет — своё правило подсветки разошлось бы с тем, по которому промпт
// вообще попал в список.
interface IterationHit {
  tabId: string;
  projectId: string;
  sessionId: string;
  toolType: 'claude' | 'codex';
  entryUuid: string;
  turnIndex: number;
  iterationIndex: number;
  /** Всего промптов во вкладке — знаменатель «#7/214». Считает main. */
  totalIterations: number;
  timestamp: string | null;
  matchCount: number;
  fullText: string;
  fullLines: number;
  fullOffsets: Array<{ start: number; end: number }>;
  snippetText: string;
  snippetOffsets: Array<{ start: number; end: number }>;
  snippetHeadTrimmed: boolean;
  snippetTailTrimmed: boolean;
}

interface SwitcherTab {
  id: string;
  name: string;
  color?: string;
  tabType?: string;
  commandType?: string;
  groupId?: string;
  sessionStatus?: string;
  sdkProcessAlive?: boolean;
  cwd?: string;
  filePath?: string;
  missing?: boolean;
}

interface RowProject { kind: 'project'; projectId: string; projectName: string; projectIcon?: string | null }
interface RowTab { kind: 'tab'; projectId: string; projectName: string; tab: SwitcherTab; missing?: boolean }
// Строки поиска по промптам живут в ТОМ ЖЕ списке, а не в отдельном:
// перемещение по клавишам, выбор и Enter обязаны работать одинаково, а два
// списка со своими индексами разошлись бы на первом же шаге.
//
// Заголовок вкладки — такой же разделитель, как заголовок проекта: он не
// выбирается и не ведёт никуда сам по себе. Найденное группируется по вкладкам
// именно потому, что «в какой вкладке я это писал» и есть тот ответ, за которым
// сюда приходят; плоский список десяти промптов из одной вкладки читался бы как
// десять разных мест.
interface RowIterationTab {
  kind: 'iteration-tab';
  tabId: string;
  projectId: string | null;
  projectName: string;
  projectIcon?: string | null;
  tabName: string;
  tabColor?: string | null;
  toolType: 'claude' | 'codex';
}
interface RowIteration { kind: 'iteration'; hit: IterationHit }
type Row = RowProject | RowTab | RowIterationTab | RowIteration;

const PANEL_BG = '#1d1d1f';
const PANEL_BORDER = '#3a3a3d';
// The panel's top edge sits flush against the bottom of the fixed top strip:
// it is opened from there, both by the toolbar button and by the keyboard.
// Height comes from constants/layout so adding a row to the strip cannot leave
// this panel overlapping it (see TOP_STRIP_H).
const SWITCHER_DOCK_TOP_PX = TOP_STRIP_H;
// Radius: only the bottom corners are rounded — the top edge is glued to the
// bar above it, and a rounded top would show the seam as a gap.
const SWITCHER_RADIUS = '0 0 8px 8px';
// Above FilePreview (z:100000) — the switcher is a top-level navigation
// surface and must never hide under an open markdown preview.
const Z_INDEX = 100500;

interface TabSwitcherOverlayProps {
  processStatus: Map<string, boolean>;
  busyTabs: Map<string, boolean>;
  pasteBusyTabs: Map<string, boolean>;
}

// Build switcher rows straight from store snapshots. Used by the fast-tap
// fallback: Ctrl can be released before React renders the first frame of the
// overlay, and the classic "toggle to previous tab" gesture must still land.
//
// `hideOnScreen` is what separates the two modes: the ctrl list drops every tab
// currently visible EXCEPT the current one, which is pinned to row 1 as the
// anchor (see the header note); the search list keeps everything, unpinned.
function computeRowsFromStores(query: string, hideOnScreen = false): Row[] {
  const ws = useWorkspaceStore.getState();
  const projectsMeta = useProjectsStore.getState().projects as Record<string, { name?: string; icon?: string | null }>;
  const recentFirst = [...ws.projectHistory].reverse();
  const orderedIds = [
    ...recentFirst.filter((id) => ws.openProjects.has(id)),
    ...Array.from(ws.openProjects.keys()).filter((id) => !recentFirst.includes(id)),
  ];
  const currentTabId = ws.activeProjectId
    ? ws.openProjects.get(ws.activeProjectId)?.activeTabId || null
    : null;
  // The anchor: the tab you are ON. It is not a destination — it is the
  // reference point row 2 is measured against ("here → there"), so it is exempt
  // from EVERY filter below. One condition decides that, and the pin below
  // decides where it lands; splitting the decision is how row 1 would end up
  // meaning different things depending on what the user happens to be looking at.
  const anchorTabId = hideOnScreen ? currentTabId : null;
  // Same answer to "what is on screen" the visit rule uses, so the list and the
  // history cannot disagree about which tabs count as visible.
  const hidden = hideOnScreen
    ? new Set(onScreenTabIds({ panes: ws.splitPanes, centerTabId: currentTabId }))
    : null;
  const blocks = orderedIds.map((projectId) => {
    const workspace = ws.openProjects.get(projectId)!;
    const projectName = projectsMeta[projectId]?.name
      || (isInboxProjectId(projectId) ? INBOX_PROJECT_NAME : (workspace.projectPath?.split('/').filter(Boolean).pop() || 'Project'));
    const tabs = (Array.from(workspace.tabs.values()) as any[])
      // The anchor is exempt from the on-screen filter only. A sub-agent child
      // is not a switcher row on any surface, so that filter stays universal —
      // and if the current tab ever were one, the pin simply matches nothing.
      .filter((t) => !t.parentTabId && (t.id === anchorTabId || !hidden || !hidden.has(t.id)))
      .map((t) => (
        t.tabType === 'file' && isFileMissing(t.filePath)
          ? { ...t, missing: true }
          : t
      )) as SwitcherTab[];
    return { projectId, projectName, projectIcon: projectsMeta[projectId]?.icon || null, tabs };
  }).filter((b) => b.tabs.length > 0);
  return buildSwitcherRows({
    projects: blocks,
    globalMru: ws.globalTabMru,
    query,
    // Anchor only in ctrl mode. In search the list must stay a plain answer to
    // the query — pinning the current tab above a match would read as a result.
    pinnedFirstTabId: anchorTabId,
  }) as Row[];
}

const ITERATION_ACCENT = (toolType: string) => (toolType === 'codex' ? '#10A37F' : '#DA7756');

/** Текст с подсвеченным найденным. Смещения считает main — см. splitByOffsets. */
function IterationText({
  text,
  offsets,
}: {
  text: string;
  offsets: Array<{ start: number; end: number }>;
}) {
  const parts = splitByOffsets(text, offsets) as Array<{ text: string; hit: boolean }>;
  return (
    <>
      {parts.map((part, index) => (part.hit ? (
        <mark
          key={index}
          style={{
            background: 'rgba(240,144,24,0.30)',
            color: '#ffd9a8',
            borderRadius: 2,
            padding: '0 1px',
          }}
        >
          {part.text}
        </mark>
      ) : (
        <React.Fragment key={index}>{part.text}</React.Fragment>
      )))}
    </>
  );
}

/**
 * Заголовок вкладки над её найденными промптами.
 *
 * Разделитель, не цель: кликать по нему некуда — переход даёт сама строка
 * промпта, и она же знает, куда прокрутить переписку. Слева цвет инструмента,
 * тот же язык, что у карточек вкладок.
 */
function IterationTabHeader({ row, count }: { row: RowIterationTab; count: number }) {
  return (
    <div
      data-switcher-iteration-tab={row.tabId}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '8px 8px 3px',
        fontSize: 11,
        fontWeight: 600,
        color: '#9a9aa0',
        pointerEvents: 'none',
        userSelect: 'none',
        whiteSpace: 'nowrap',
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: 2, background: ITERATION_ACCENT(row.toolType), flexShrink: 0 }} />
      {/* Иконка проекта, а без неё — папка: заголовок обязан отвечать «чей это
          проект» на любом проекте, а не только на настроенном. Тот же значок,
          что у чипов выбора выше, — один язык на обе строки. */}
      {row.projectIcon ? (
        <img
          src={row.projectIcon}
          alt=""
          draggable={false}
          title={row.projectName}
          style={{ width: 12, height: 12, borderRadius: 2, objectFit: 'cover', flexShrink: 0, opacity: 0.75 }}
        />
      ) : (
        <Folder size={11} strokeWidth={2} style={{ flexShrink: 0, opacity: 0.6 }} />
      )}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{row.tabName}</span>
      <span style={{ marginLeft: 'auto', flexShrink: 0, color: '#6f6f75', fontWeight: 500 }}>
        {count}
      </span>
    </div>
  );
}

/**
 * Строка найденного промпта.
 *
 * Это НЕ карточка вкладки, и выглядеть как карточка она не должна: карточка
 * отвечает «вот вкладка, перейти на неё», а здесь ответ — «вот место в
 * разговоре». Поэтому главное в строке — сам текст промпта, а адрес (номер
 * хода) уходит вправо мелким.
 *
 * СВЁРНУТО показываются ТРИ строки: строка с совпадением и по одной вокруг.
 * Ровно три, а не «сколько влезет»: у кусков разной высоты список перестаёт
 * читаться как список — глаз не находит, где кончается один результат и
 * начинается следующий. Окно берётся вокруг совпадения, а не от начала промпта:
 * длинные промпты часто начинаются одинаково.
 *
 * Многоточий по краям куска нет: обрезка и так очевидна — кусок начинается и
 * кончается посреди фразы, а два лишних значка в каждой строке длинного списка
 * читаются как часть текста.
 *
 * «Раскрыть полностью» стоит и сверху, и снизу — по той же причине, что в
 * переписке: у раскрытого промпта конец далеко, и свернуть его нужно и там, где
 * чтение началось, и там, где закончилось. У свёрнутого верхняя строка занята
 * другим: числом совпадений В ЭТОМ промпте.
 *
 * Слева — вертикальная линия отступа: она физически связывает промпт с
 * заголовком его вкладки. Без неё в длинном списке через десять строк уже не
 * видно, к какой вкладке относится то, что читаешь.
 */
function IterationResultRow({
  hit,
  index,
  selected,
  expanded,
  onToggleExpanded,
  onPointerEnter,
  onOpen,
}: {
  hit: IterationHit;
  index: number;
  selected: boolean;
  expanded: boolean;
  onToggleExpanded: () => void;
  onPointerEnter: () => void;
  onOpen: () => void;
}) {
  const canExpand = hit.fullText.length > hit.snippetText.length;
  return (
    <div
      data-switcher-index={index}
      data-switcher-iteration={hit.entryUuid}
      onPointerEnter={onPointerEnter}
      // Переход по КЛИКУ, а не по нажатию: текст промпта здесь выделяемый —
      // найденное часто нужно скопировать, не уходя со списка. На pointerdown
      // переход срывал бы выделение на первом же движении мышью.
      onClick={(event) => {
        if (event.button !== 0) return;
        // Тянули текст — это выделение, а не выбор строки.
        const selection = window.getSelection();
        if (selection && !selection.isCollapsed) return;
        onOpen();
      }}
      style={{
        // Отступ + линия = принадлежность вкладке из заголовка выше.
        marginLeft: 10,
        marginBottom: 1,
        paddingLeft: 8,
        borderLeft: `2px solid ${ITERATION_ACCENT(hit.toolType)}44`,
        cursor: 'pointer',
      }}
    >
      <div
        style={{
          padding: '6px 10px',
          borderRadius: 5,
          background: selected ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.035)',
          boxShadow: selected ? 'inset 0 0 0 1px rgba(255,255,255,0.30)' : 'none',
          overflow: 'hidden',
        }}
      >
        {/* ВЕРХНЯЯ строка: сколько совпадений внутри этого промпта. Место под
            неё зарезервировано всегда и одной ширины (до трёх цифр), поэтому
            появление «Свернуть» рядом не двигает текст под ней. Число нужно
            потому, что видно из промпта только три строки: «здесь этих слов
            двенадцать» — единственный способ узнать, что за пределами окна их
            больше. */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            height: 14,
            fontSize: 10,
            color: '#7c7c82',
            whiteSpace: 'nowrap',
          }}
        >
          <span
            data-switcher-iteration-matches
            style={{
              // Ширина под три цифры — фиксированная. Иначе строки с «7» и с
              // «112» ставили бы текст под собой на разные позиции, и левый
              // край списка «дышал» бы при каждом обновлении.
              minWidth: 46,
              flexShrink: 0,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {hit.matchCount} совп.
          </span>
          {canExpand && (
            <button
              type="button"
              data-switcher-iteration-toggle
              onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
              onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onToggleExpanded();
              }}
              style={{
                background: 'none',
                border: 'none',
                padding: 0,
                cursor: 'pointer',
                color: '#7aa2f7',
                fontSize: 10,
                textAlign: 'left',
              }}
            >
              {expanded ? 'Свернуть' : `Раскрыть полностью (${hit.fullLines.toLocaleString()} строк)`}
            </button>
          )}
        </div>
        <div
          style={{
            fontSize: 12,
            lineHeight: '16px',
            color: selected ? '#f0f0f0' : '#cfcfd4',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            userSelect: 'text',
          }}
        >
          <IterationText
            text={expanded ? hit.fullText : hit.snippetText}
            offsets={expanded ? hit.fullOffsets : hit.snippetOffsets}
          />
        </div>
        {/* НИЖНЯЯ строка: адрес промпта в разговоре. «#7/214» вместо «#7» —
            номер без знаменателя ничего не говорит: седьмой из десяти это
            начало, седьмой из трёхсот — тоже начало, но совсем другого
            масштаба. И «Свернуть» здесь же у раскрытого: конец длинного текста
            далеко от его начала. */}
        <div
          style={{
            marginTop: 3,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            height: 13,
            fontSize: 10,
            color: '#7c7c82',
            whiteSpace: 'nowrap',
          }}
        >
          {expanded && canExpand && (
            <button
              type="button"
              data-switcher-iteration-toggle-bottom
              onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
              onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onToggleExpanded();
              }}
              style={{
                background: 'none',
                border: 'none',
                padding: 0,
                cursor: 'pointer',
                color: '#7aa2f7',
                fontSize: 10,
                textAlign: 'left',
              }}
            >
              Свернуть
            </button>
          )}
          <span style={{ marginLeft: 'auto', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
            #{hit.iterationIndex + 1}/{hit.totalIterations || '?'}
          </span>
        </div>
      </div>
    </div>
  );
}

// ── ПАМЯТЬ ПОИСКА между открытиями ────────────────────────────────────────
//
// Поиск по промптам — это работа: набрать запрос, дождаться обхода вкладок,
// раскрыть найденное, проскроллить. Закрыть панель приходится постоянно —
// сходить в найденную вкладку, посмотреть, вернуться. Если каждое открытие
// начинается с чистого листа, эта работа выбрасывается по десять раз за сеанс,
// и человек перестаёт пользоваться поиском вовсе.
//
// Поэтому состояние поиска переживает закрытие. Хранится в МОДУЛЕ, а не в
// сторе: панель — единственный её читатель, а каждая буква запроса в глобальном
// сторе была бы обновлением для всего приложения. И не в `useRef` — компонент
// живёт всё время, но состояние должно пережить и его перемонтирование.
//
// Что НЕ хранится: режим (`scope`). Переключатель чаще всего открывают, чтобы
// просто перейти на вкладку, и застать его в режиме, который читает файлы
// сессий, дороже одного клика. Память при этом не теряется — вернувшись во
// вкладку «Итерации», человек находит там всё, что было.
interface IterationMemory {
  query: string;
  hits: IterationHit[];
  matchMode: 'phrase' | 'words';
  answeredQuery: string;
  expanded: Set<string>;
  projects: Set<string> | null;
  /** На какой (запрос + набор проектов) уже отвечали: подпись, чтобы возврат в
   *  режим не гонял тот же обход файлов сессий заново. */
  answeredSignature: string;
  selectedUuid: string | null;
  scrollTop: number;
}

const iterationMemory: IterationMemory = {
  query: '',
  hits: [],
  matchMode: 'phrase',
  answeredQuery: '',
  expanded: new Set(),
  projects: null,
  answeredSignature: '',
  selectedUuid: null,
  scrollTop: 0,
};

export default function TabSwitcherOverlay({ processStatus, busyTabs, pasteBusyTabs }: TabSwitcherOverlayProps) {
  const [mode, setMode] = useState<Mode | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<SearchScope>('tabs');
  const [iterationHits, setIterationHits] = useState<IterationHit[]>(() => iterationMemory.hits);
  const [iterationLoading, setIterationLoading] = useState(false);
  const [iterationError, setIterationError] = useState<string | null>(null);
  // Как именно нашли: целиком фразой или по отдельным словам. Показывается,
  // потому что «нашли по словам» — это ДРУГОЙ ответ: строки в нём не содержат
  // введённой фразы, и без подписи это читается как ошибка поиска.
  const [iterationMatchMode, setIterationMatchMode] = useState<'phrase' | 'words'>(() => iterationMemory.matchMode);
  // Запрос, которому принадлежат текущие результаты. Ответ приходит с
  // задержкой, а человек к этому моменту уже дописал строку — без этой метки
  // список показывал бы ответ на позавчерашний вопрос и молчал бы об этом.
  const [iterationAnsweredQuery, setIterationAnsweredQuery] = useState(() => iterationMemory.answeredQuery);
  // Раскрытые промпты — по uuid хода, а не по индексу строки: список
  // перестраивается на каждый ответ, и раскрытие «прыгнуло» бы на соседний
  // промпт вместе со сдвигом индексов.
  const [expandedHits, setExpandedHits] = useState<Set<string>>(() => iterationMemory.expanded);
  // Какие проекты спрашивать — ЯВНЫЙ набор, а не «пусто значит все». Пустой
  // набор здесь тоже настоящее состояние: человек снял выбор со всех, и поиску
  // негде искать. Подменять это на «искать везде» значило бы отвечать не на тот
  // вопрос, который задали, — и объём ответа менялся бы сам собой.
  const [iterationProjects, setIterationProjects] = useState<Set<string>>(() => iterationMemory.projects || new Set());
  const visible = mode !== null;

  const openProjects = useWorkspaceStore((s) => s.openProjects);
  const projectHistory = useWorkspaceStore((s) => s.projectHistory);
  const globalTabMru = useWorkspaceStore((s) => s.globalTabMru);
  // The tab pinned to row 1 in ctrl mode. A STRING selector (Fingerprint
  // Pattern) — reading the workspace object would re-render on every store write.
  const activeTabId = useWorkspaceStore((s) => (
    s.activeProjectId ? s.openProjects.get(s.activeProjectId)?.activeTabId || '' : ''
  ));
  const projectsMeta = useProjectsStore((s) => s.projects);
  const sessionStatuses = useUIStore((s) => s.sessionStatuses);
  // Tabs waiting for a delegated session. Read as a STRING (Fingerprint
  // Pattern) — a Set selector is a fresh reference on every store write and
  // would re-render the whole overlay for changes it does not care about.
  const inheritedBusyKey = useOrchestrationStore((s) => (
    Array.from(s.inheritedBusyTabIds).sort().join(' ')
  ));

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // ── Кто выбрал строку: клавиатура или мышь ──────────────────────────────
  //
  // Список подводит выбранную строку к видимой области — это нужно, когда её
  // выбрали стрелками: строка может быть за краем, и без прокрутки шаг вслепую
  // выглядел бы как «ничего не произошло».
  //
  // Но выбирает строку и НАВЕДЕНИЕ. А наведённая строка по определению уже под
  // курсором, то есть на экране: подводить её некуда, и любая прокрутка здесь —
  // это движение списка под неподвижной мышью. Дальше хуже: список уехал —
  // курсор оказался над другой строкой — она выделилась — список уехал снова.
  // Именно это читается как «раскрыл, скроллю вниз, а меня возвращает обратно».
  //
  // Поэтому источник выбора запоминается, и прокрутка разрешена только
  // клавиатуре. Флаг, а не «сравнить старую позицию с новой»: перерисовок между
  // выбором и прокруткой может быть сколько угодно (пришёл кусок результатов,
  // раскрыли строку), и любая из них имеет право НЕ двигать список.
  const selectionByKeyboardRef = useRef(false);
  const selectByKeyboard = useCallback((next: number | ((prev: number) => number)) => {
    selectionByKeyboardRef.current = true;
    setSelectedIndex(next as any);
  }, []);
  const selectByMouse = useCallback((next: number) => {
    selectionByKeyboardRef.current = false;
    setSelectedIndex(next);
  }, []);
  // Нажатие началось на фоне, а не внутри панели — см. обработчики фона.
  const backdropPressRef = useRef(false);
  // Phantom-hover guard: ignore pointerenter until the mouse REALLY moves
  // (opening under a static cursor must not steal keyboard selection).
  const mouseBlockedRef = useRef(true);
  const modeRef = useRef<Mode | null>(null);
  modeRef.current = mode;

  // Probe linked-file existence on every open; a vanished file turns its row
  // red and unselectable on the probe's next tick (cache → instant on reopen).
  // Declared before the rows memo that depends on it: a `const` referenced
  // above its own declaration throws at module evaluation, not at call time.
  const [missingProbeTick, setMissingProbeTick] = useState(0);
  useEffect(() => subscribeMissingFiles(() => setMissingProbeTick((v) => v + 1)), []);

  // ── rows ────────────────────────────────────────────────────────────────
  // Store subscriptions above keep this memo fresh; the builder itself reads
  // the same live snapshots so the fast-tap fallback shares one code path.
  //
  // Which tabs are on screen is part of the ctrl list's CONTENT, so the memo
  // must recompute when panes change. A string, not the array (Fingerprint
  // Pattern): a panes selector is a fresh reference on every store write.
  const onScreenKey = useWorkspaceStore((s) => onScreenTabIds({
    panes: s.splitPanes,
    centerTabId: s.activeProjectId ? s.openProjects.get(s.activeProjectId)?.activeTabId || null : null,
  }).join(','));
  const iterationMode = mode === 'search' && scope === 'iterations';
  const rows: Row[] = useMemo(() => {
    if (!visible) return [];
    // Поиск по промптам живёт своим списком: строки приходят из файлов сессий,
    // а группируются по ВКЛАДКЕ, а не по проекту — вопрос здесь «в какой моей
    // вкладке я это писал», и вкладка и есть ответ.
    if (iterationMode) {
      return buildIterationRows(iterationHits, (tabId: string) => {
        for (const [projectId, workspace] of openProjects) {
          const tab = workspace.tabs.get(tabId);
          if (!tab) continue;
          return {
            projectId,
            projectName: projectsMeta[projectId]?.name
              || (isInboxProjectId(projectId) ? INBOX_PROJECT_NAME : (workspace.projectPath?.split('/').filter(Boolean).pop() || 'Project')),
            projectIcon: projectsMeta[projectId]?.icon || null,
            tabName: tab.name,
            tabColor: tab.color,
          };
        }
        return null;
      }) as Row[];
    }
    return computeRowsFromStores(mode === 'search' ? query : '', mode === 'ctrl');
  }, [visible, openProjects, projectHistory, projectsMeta, globalTabMru, query, mode, missingProbeTick, onScreenKey, activeTabId, iterationMode, iterationHits]);
  useEffect(() => {
    if (!visible) return;
    const paths: string[] = [];
    openProjects.forEach((ws) => {
      ws.tabs.forEach((t: any) => {
        if (t.tabType === 'file' && t.filePath && !t.parentTabId) paths.push(t.filePath);
      });
    });
    probeFiles(paths, true);
  }, [visible, openProjects]);

  // Выделение при изменении списка.
  //
  // В поиске по вкладкам список целиком пересобирается на каждую букву, и
  // выделение честно уезжает на первую строку — там оно и должно быть.
  //
  // В поиске по промптам список ДОРАСТАЕТ: куски приходят по одному, и сброс на
  // первую строку при каждом куске отбирал бы у человека выбор ровно в тот
  // момент, когда он его сделал. Поэтому выделение держится за СТРОКУ (по uuid
  // промпта), а не за её номер: номер сдвигается, когда выше встаёт новая
  // группа. И только если удержаться не за что — встаём на первую строку.
  const iterationSelectedUuidRef = useRef<string | null>(null);
  useEffect(() => {
    if (mode !== 'search') return;
    const sel = selectableIndices(rows);
    if (!iterationMode) {
      setSelectedIndex(sel.length > 0 ? sel[0] : -1);
      return;
    }
    // Возврат в панель: восстанавливаем ту строку, на которой ушли.
    const wanted = iterationSelectedUuidRef.current || iterationMemory.selectedUuid;
    if (wanted) {
      const at = rows.findIndex((row) => row.kind === 'iteration' && row.hit.entryUuid === wanted);
      if (at >= 0) {
        setSelectedIndex(at);
        return;
      }
    }
    setSelectedIndex((prev) => (prev >= 0 && prev < rows.length && rows[prev]?.kind === 'iteration'
      ? prev
      : (sel.length > 0 ? sel[0] : -1)));
  }, [mode, rows, iterationMode]);

  // Зеркало «какая строка выделена» в терминах uuid: номер строки не переживает
  // приход нового куска, а uuid переживает.
  useEffect(() => {
    if (!iterationMode) return;
    const row = rows[selectedIndex];
    iterationSelectedUuidRef.current = row?.kind === 'iteration' ? row.hit.entryUuid : null;
  }, [iterationMode, rows, selectedIndex]);

  // Восстановление прокрутки при возврате. Один раз за открытие и только когда
  // список уже нарисован: назначить scrollTop пустому списку значит назначить
  // ноль. Дальше не трогаем — иначе любой приход куска возвращал бы человека к
  // сохранённой позиции, пока он листает.
  const scrollRestoredRef = useRef(false);
  useEffect(() => {
    if (!iterationMode) { scrollRestoredRef.current = false; return; }
    if (scrollRestoredRef.current) return;
    if (rows.length === 0 || !listRef.current) return;
    scrollRestoredRef.current = true;
    if (iterationMemory.scrollTop > 0) listRef.current.scrollTop = iterationMemory.scrollTop;
  }, [iterationMode, rows.length]);

  // ── поиск по промптам ───────────────────────────────────────────────────
  //
  // Спрашиваем ОТКРЫТЫЕ вкладки выбранных проектов. По умолчанию выбран тот
  // проект, из которого позвали: чаще всего искомое писали здесь же, а
  // расширить область — один клик. Обратное («сначала всё») дало бы длинный
  // список чужих вкладок там, где ждали свои три.
  //
  // Задержка — не оптимизация ради оптимизации: каждый заход читает и разбирает
  // файлы сессий всех открытых вкладок. Поиск на каждую букву превратил бы одно
  // слово в шесть таких обходов. Ответ помечается своим запросом, потому что к
  // моменту его прихода строка уже другая.
  const iterationRequestRef = useRef(0);
  // Зеркало результатов для проверки «уже отвечали»: класть сами результаты в
  // зависимости эффекта нельзя — он перезапускался бы на каждый пришедший кусок
  // и обрывал собственный обход.
  const iterationHitsRef = useRef<IterationHit[]>(iterationHits);
  iterationHitsRef.current = iterationHits;
  useEffect(() => {
    if (!iterationMode) return;
    const text = query.trim();
    if (text.length < ITERATION_MIN_QUERY) {
      setIterationHits([]);
      setIterationLoading(false);
      setIterationError(null);
      setIterationAnsweredQuery('');
      return;
    }
    // Тот же вопрос уже задан и на него уже ответили — возврат в режим не
    // должен повторять обход файлов сессий. Подпись включает и набор проектов:
    // сменил проекты — вопрос другой, даже если строка та же.
    const signature = text + '\u0000' + Array.from(iterationProjects).sort().join(',');
    if (signature === iterationMemory.answeredSignature && iterationHitsRef.current.length > 0) {
      setIterationLoading(false);
      return;
    }
    let cancelled = false;
    // Номер запроса живёт ДОЛЬШЕ этого эффекта: куски приходят отдельными
    // событиями, и опоздавший кусок прошлого поиска обязан быть отброшен по
    // номеру, а не по тому, отписался ли уже слушатель.
    const requestId = 'it-' + (++iterationRequestRef.current);
    setIterationLoading(true);
    setIterationError(null);

    // Порядок вкладок известен ДО ответа (его задаёт свежесть), поэтому куски
    // встают на своё место, а не в конец: иначе первый показанный результат
    // уезжал бы вниз каждый раз, когда доразобралась более свежая вкладка.
    const targetOrderRef = { current: [] as string[] };
    // Замену на второй проход делаем ОДИН раз: первый его кусок стирает список,
    // остальные уже дополняют.
    const replacedRef = { current: false };

    // Приём кусков: одна вкладка — одно событие, показываем сразу.
    const onChunk = (_event: unknown, chunk: any) => {
      if (cancelled || !chunk || chunk.requestId !== requestId) return;
      setIterationMatchMode(chunk.mode === 'words' ? 'words' : 'phrase');
      setIterationAnsweredQuery(chunk.query || text);
      setIterationHits((prev) => {
        // `replaces` — второй проход (поиск по отдельным словам) не дополняет
        // первый, а заменяет его: смешать точные совпадения с приблизительными
        // в одном списке значило бы соврать про половину строк.
        const base = chunk.replaces && !replacedRef.current ? [] : prev;
        if (chunk.replaces) replacedRef.current = true;
        return mergeIterationChunk(base, chunk, targetOrderRef.current) as IterationHit[];
      });
    };
    ipcRenderer.on('iteration-search:chunk', onChunk);

    const timer = window.setTimeout(async () => {
      const ws = useWorkspaceStore.getState();
      const targets = collectIterationTargets({
        openProjects: ws.openProjects,
        globalMru: ws.globalTabMru,
        projectFilter: iterationProjects,
      });
      targetOrderRef.current = targets.map((target: any) => target.tabId);
      if (targets.length === 0) {
        if (cancelled) return;
        setIterationHits([]);
        setIterationAnsweredQuery(text);
        setIterationLoading(false);
        return;
      }
      // Прошлые результаты гасим ровно здесь, на старте нового обхода: до сих
      // пор на экране висел ответ на предыдущий запрос, и это правильно —
      // пустой экран во время набора хуже устаревшего списка с подписью.
      setIterationHits([]);
      setExpandedHits(new Set());
      try {
        const res = await ipcRenderer.invoke('iteration-search:open-tabs', {
          requestId,
          query: text,
          targets,
          maxPerTab: ITERATION_MAX_PER_TAB,
          maxMatches: ITERATION_MAX_TOTAL,
        });
        if (cancelled) return;
        if (!res?.success) {
          setIterationHits([]);
          setIterationError(res?.error || 'Поиск по итерациям не удался');
          return;
        }
        // Итоговый ответ — не «ещё один кусок», а сверка: куски уже показали
        // всё, что нашлось, и переписывать список целиком значило бы моргнуть
        // им на ровном месте. Берём из него только то, чего в кусках нет.
        setIterationMatchMode(res.mode === 'words' ? 'words' : 'phrase');
        setIterationAnsweredQuery(text);
        iterationMemory.answeredSignature = signature;
      } catch (err: any) {
        if (cancelled) return;
        setIterationHits([]);
        setIterationError(err?.message || 'Поиск по итерациям не удался');
      } finally {
        if (!cancelled) setIterationLoading(false);
      }
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      ipcRenderer.removeListener('iteration-search:chunk', onChunk);
    };
  }, [iterationMode, query, iterationProjects]);

  // Проекты для выбора: те же, что открыты, в том же порядке свежести, что и
  // в списке вкладок. Иконки берём из общего хранилища проектов — свой второй
  // источник иконок разошёлся бы с сайдбаром.
  const iterationProjectChips = useMemo(() => {
    if (!iterationMode) return [];
    const recentFirst = [...projectHistory].reverse();
    const ordered = [
      ...recentFirst.filter((id) => openProjects.has(id)),
      ...Array.from(openProjects.keys()).filter((id) => !recentFirst.includes(id)),
    ];
    return ordered.map((projectId) => ({
      projectId,
      name: projectsMeta[projectId]?.name
        || (isInboxProjectId(projectId) ? INBOX_PROJECT_NAME : (openProjects.get(projectId)?.projectPath?.split('/').filter(Boolean).pop() || 'Project')),
      icon: projectsMeta[projectId]?.icon || null,
    }));
  }, [iterationMode, openProjects, projectHistory, projectsMeta]);

  // Клик по проекту добавляет/убирает его. Ровно так же, как выделение файлов:
  // «включить/выключить этот», без скрытых правил вроде «клик по выбранному
  // оставляет только его» — такое правило нельзя увидеть, его можно только
  // случайно обнаружить.
  const toggleIterationProject = useCallback((projectId: string) => {
    setIterationProjects((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  }, []);

  // «Все» — тот же переключатель, но на весь список: выбраны все → снять выбор
  // со всех; иначе → выбрать все. Второе нажатие поэтому предсказуемо снимает
  // то, что первое поставило.
  const toggleAllIterationProjects = useCallback(() => {
    setIterationProjects((prev) => {
      const all = iterationProjectChips.map((chip) => chip.projectId);
      const everySelected = all.length > 0 && all.every((id) => prev.has(id));
      return everySelected ? new Set() : new Set(all);
    });
  }, [iterationProjectChips]);

  // Проект по умолчанию ставится ОДИН раз за всё время — при самом первом входе
  // в режим. Дальше набор принадлежит человеку и переживает закрытие панели
  // вместе с остальной памятью поиска: переоткрытие не должно молча отменять
  // его выбор. Пустой набор при этом остаётся законным — он значит «нигде», и
  // подставлять туда текущий проект было бы тем же самым молчаливым отменом.
  useEffect(() => {
    if (!iterationMode) return;
    if (iterationMemory.projects) return;
    const current = useWorkspaceStore.getState().activeProjectId;
    const initial = current ? new Set([current]) : new Set<string>();
    iterationMemory.projects = initial;
    setIterationProjects(initial);
  }, [iterationMode]);

  // ── запись в память ─────────────────────────────────────────────────────
  // Пишем на КАЖДОЕ изменение, а не на закрытии: панель закрывают и по Escape,
  // и кликом мимо, и переходом по строке, и потерей фокуса окна — собрать все
  // выходы в одном месте нельзя, а пропущенный выход теряет работу целиком.
  useEffect(() => {
    if (!iterationMode) return;
    iterationMemory.query = query;
    iterationMemory.hits = iterationHits;
    iterationMemory.matchMode = iterationMatchMode;
    iterationMemory.answeredQuery = iterationAnsweredQuery;
    iterationMemory.expanded = expandedHits;
    iterationMemory.projects = iterationProjects;
  }, [iterationMode, query, iterationHits, iterationMatchMode, iterationAnsweredQuery, expandedHits, iterationProjects]);

  // ── open/close/commit ───────────────────────────────────────────────────
  const close = useCallback(() => {
    // Перед закрытием запоминаем, ГДЕ человек стоял: строку (по uuid промпта, а
    // не по индексу — список к возвращению может быть другим) и положение
    // прокрутки. Без этого «сходил во вкладку и вернулся» отбрасывает к началу
    // длинного списка, и найденное приходится искать глазами заново.
    const selected = rowsRef.current[selectedIndexRef.current];
    iterationMemory.selectedUuid = selected?.kind === 'iteration' ? selected.hit.entryUuid : null;
    iterationMemory.scrollTop = listRef.current?.scrollTop || 0;
    setMode(null);
    setSelectedIndex(-1);
    // Строка запроса и результаты НЕ стираются: см. `iterationMemory` — поиск
    // по промптам это работа, и выбрасывать её на каждом закрытии значит
    // заставлять делать её заново по десять раз за сеанс. Стирается только то,
    // что относится к незавершённому походу за ответом.
    setIterationLoading(false);
    setIterationError(null);
  }, []);

  // Переход по найденному промпту.
  //
  // Вкладка открыта по построению — искали только по открытым. Поэтому шага
  // два: перейти на вкладку и прокрутить её переписку на этот промпт. Прокрутка
  // идёт тем же механизмом, что и переход из Timeline (`historyScrollToUuid`) —
  // второй путь к тому же месту разошёлся бы с ним в первом же особом случае.
  const openIterationHit = useCallback((hit: IterationHit) => {
    const target = resolveIterationTarget(hit);
    if (!target.tabId || !target.projectId) return;
    useWorkspaceStore.getState().activateCenterTab(target.projectId, target.tabId);
    // Переписка — та поверхность, где промпт вообще виден; без неё переход
    // привёл бы в терминал, где найденного текста может уже не быть на экране.
    useUIStore.getState().setHistoryPanelOpen(target.tabId, true);
    requestAnimationFrame(() => useUIStore.getState().setHistoryScrollToUuid(target.entryUuid));
  }, []);

  const commitRow = useCallback((row: Row | undefined) => {
    close();
    if (!row) return;
    if (row.kind === 'iteration') {
      openIterationHit(row.hit);
      return;
    }
    if (row.kind !== 'tab') return;
    // Single activation entry point: applies the split rules (a tab already
    // visible in a pane → focus jumps to that pane; hidden → it replaces the
    // focused pane's slot) and the cross-project view switch. switchTab inside
    // puts the chosen tab at the MRU head FIRST, so showWorkspace's own touch
    // becomes a no-op — the toggle order stays correct.
    useWorkspaceStore.getState().activateCenterTab(row.projectId, row.tab.id);
  }, [close, openIterationHit]);

  // Middle-click on a row: FORGET the entry, keep the window open. Not a
  // navigation and not a close — the user is editing the list they look at.
  const forgetRow = useCallback((row: Row | undefined) => {
    if (!row || row.kind !== 'tab') return;
    useWorkspaceStore.getState().forgetGlobalTabVisit(row.projectId, row.tab.id);
  }, []);

  // Search mode is reachable from the keyboard (Cmd+P) and from a click on the
  // toolbar button; both go through this one function so the two entry points
  // cannot drift apart.
  const openSearch = useCallback(() => {
    mouseBlockedRef.current = true;
    // Строка ввода начинается пустой: открытие «по вкладкам» — это почти всегда
    // «перейти куда-то», и чужой текст в поле означал бы отфильтрованный список
    // вместо всех вкладок.
    setQuery('');
    // Всегда открываемся на поиске по вкладкам: он мгновенный, а переключатель
    // чаще всего открывают, чтобы просто перейти. Застать его в режиме поиска
    // по промптам (он читает файлы сессий) дороже, чем один клик. Память
    // поиска при этом цела — вернувшись во вкладку «Итерации», человек находит
    // там всё, что было.
    setScope('tabs');
    setIterationError(null);
    setMode('search');
    setSelectedIndex(-1);
    setTimeout(() => inputRef.current?.focus(), 30);
  }, []);

  // Возврат в режим поиска по промптам восстанавливает набранный запрос: он и
  // есть та работа, ради которой память существует. Список результатов уже
  // лежит в состоянии — повторный поход в файлы сессий не нужен, поэтому
  // сравниваем запрос с тем, на который отвечали, и не запускаем поиск заново.
  useEffect(() => {
    if (!iterationMode) return;
    if (query === '' && iterationMemory.query) setQuery(iterationMemory.query);
  }, [iterationMode]);

  const openCtrl = useCallback((shiftKey: boolean) => {
    mouseBlockedRef.current = true;
    setQuery('');
    setMode('ctrl');
    // rows are computed on next render; compute here from the same inputs to
    // pick the initial index synchronously (previous tab across projects).
    // We re-derive after mount via effect below instead — simpler and safe.
    setSelectedIndex(-2 - (shiftKey ? 1 : 0)); // sentinel: -2 fwd, -3 back
  }, []);

  // Resolve the sentinel initial index once rows exist.
  useEffect(() => {
    if (!visible) return;
    if (selectedIndex >= 0) return;
    if (mode === 'ctrl') {
      if (rows.length === 0) return;
      if (selectedIndex === -3) {
        // Shift+Ctrl+Tab opening: start from the LAST selectable row — stepping
        // backwards from the anchor wraps to the end of the list.
        const sel = selectableIndices(rows);
        selectByKeyboard(sel.length > 0 ? sel[sel.length - 1] : -1);
      } else {
        // Row 1 is the anchor (the current tab), and initialCtrlIndex skips it,
        // so this lands on row 2 — the freshest thing the user cannot see, i.e.
        // where releasing Ctrl right now would take him.
        selectByKeyboard(initialCtrlIndex(rows, globalTabMru, activeTabId || null));
      }
    }
  }, [visible, mode, rows, selectedIndex, globalTabMru, activeTabId]);

  // ── global key handling ─────────────────────────────────────────────────
  useEffect(() => {
    const swallow = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (typeof (e as any).stopImmediatePropagation === 'function') (e as any).stopImmediatePropagation();
    };

    const onKeyDown = (e: KeyboardEvent) => {
      const cur = modeRef.current;
      // Ctrl+Tab — open or step. Layout-agnostic (Tab is Tab everywhere).
      if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === 'Tab') {
        swallow(e);
        if (cur === null) {
          openCtrl(e.shiftKey);
        } else {
          selectByKeyboard((prev) => stepIndex(rowsRef.current, prev, e.shiftKey ? -1 : +1));
        }
        return;
      }
      // Cmd+P / Ctrl+P — open search mode (toggle). e.code → works on RU
      // layout. Ctrl+P is a synonym so the hand that just used Ctrl+Tab does
      // not have to change modifiers to reach the search.
      if ((e.metaKey !== e.ctrlKey) && !e.altKey && !e.shiftKey && e.code === 'KeyP') {
        swallow(e);
        if (cur === 'search') { close(); return; }
        openSearch();
        return;
      }
      if (cur === null) return;

      // Keys while open.
      if (e.key === 'Escape') {
        swallow(e);
        close();
        return;
      }
      if (cur === 'ctrl') {
        // Arrows also navigate in ctrl mode; everything else stays swallowed
        // so keystrokes don't leak into the terminal underneath.
        if (e.key === 'ArrowDown') { swallow(e); selectByKeyboard((p) => stepIndex(rowsRef.current, p, +1)); return; }
        if (e.key === 'ArrowUp') { swallow(e); selectByKeyboard((p) => stepIndex(rowsRef.current, p, -1)); return; }
        if (e.key === 'Enter') { swallow(e); commitRow(rowsRef.current[selectedIndexRef.current]); return; }
      }
      if (cur === 'search') {
        // Tab переключает, ЧТО ищет строка. Клавиша выбрана по смыслу жеста:
        // человек уже печатает, и уходить за мышью ради смены вопроса — потеря
        // набранного темпа. Строка при этом сохраняется: тот же текст обычно и
        // надо переспросить у другого поиска.
        if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey) {
          swallow(e);
          setScope((prev) => (prev === 'tabs' ? 'iterations' : 'tabs'));
          inputRef.current?.focus();
          return;
        }
        // Input owns typing; window-level capture handles list navigation so
        // it works даже когда фокус ушёл с input.
        if (e.key === 'ArrowDown') { swallow(e); selectByKeyboard((p) => stepIndex(rowsRef.current, p, +1)); return; }
        if (e.key === 'ArrowUp') { swallow(e); selectByKeyboard((p) => stepIndex(rowsRef.current, p, -1)); return; }
        if (e.key === 'Enter') { swallow(e); commitRow(rowsRef.current[selectedIndexRef.current]); return; }
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (modeRef.current !== 'ctrl') return;
      if (e.key === 'Control') {
        let effectiveRows = rowsRef.current;
        let idx = selectedIndexRef.current;
        if (idx < 0) {
          // Fast tap: Ctrl released before React rendered the first frame.
          // Rebuild rows from the live stores and resolve the "previous tab"
          // target inline so the classic toggle still fires. Same on-screen
          // filter as the rendered list — otherwise a fast tap would land on a
          // tab the slow gesture does not even offer.
          const st = useWorkspaceStore.getState();
          const activeWs = st.activeProjectId ? st.openProjects.get(st.activeProjectId) : null;
          effectiveRows = computeRowsFromStores('', true);
          idx = initialCtrlIndex(
            effectiveRows,
            st.globalTabMru,
            activeWs?.activeTabId || null,
          );
        }
        commitRow(effectiveRows[idx]);
      }
    };

    const onBlur = () => { if (modeRef.current === 'ctrl') close(); };

    // Mouse entry point (toolbar button). Toggles like Cmd+P so a second click
    // on the same button closes the panel instead of re-opening it.
    const onExternalOpen = () => {
      if (modeRef.current !== null) { close(); return; }
      openSearch();
    };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener(TAB_SWITCHER_OPEN_EVENT, onExternalOpen);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener(TAB_SWITCHER_OPEN_EVENT, onExternalOpen);
    };
  }, [openCtrl, openSearch, close, commitRow]);

  // Refs mirroring latest rows/selection for the stable key handlers above.
  const rowsRef = useRef<Row[]>(rows);
  rowsRef.current = rows;
  const selectedIndexRef = useRef(selectedIndex);
  selectedIndexRef.current = selectedIndex;

  // Unblock phantom hover on the first REAL mouse move; immediately select
  // the row under the cursor (GT pattern, see fix-tab-switcher-mru.md).
  useEffect(() => {
    if (!visible) return;
    mouseBlockedRef.current = true;
    const unblock = (e: MouseEvent) => {
      mouseBlockedRef.current = false;
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const item = el?.closest('[data-switcher-index]');
      if (item) {
        const idx = Number(item.getAttribute('data-switcher-index'));
        if (Number.isFinite(idx)) selectByMouse(idx);
      }
    };
    window.addEventListener('mousemove', unblock, { once: true });
    return () => window.removeEventListener('mousemove', unblock);
  }, [visible]);

  if (!visible) return null;

  const isBusy = (tabId: string) => !!(busyTabs.get(tabId) || pasteBusyTabs.get(tabId));
  const hasProcess = (tab: SwitcherTab) => !!(processStatus.get(tab.id) || tab.sdkProcessAlive);
  // Only the anchor left → the gesture has no destination. Counted from the
  // rows themselves, so it cannot disagree with what is drawn. Only ever true
  // in ctrl mode, where the list holds nothing but tab rows.
  const nothingToReturnTo = rows.filter((r) => r.kind === 'tab').length <= 1;
  const iterationHitCount = iterationMode ? countIterationHits(rows) : 0;
  const iterationTabCount = iterationMode ? countIterationTabs(rows) : 0;
  // «7/135» — номер выделенного среди всех найденных, как в любом поиске.
  // Считается ОТ СПИСКА, а не отдельным счётчиком: второй счётчик разошёлся бы
  // с выделением на первом же обновлении, и стрелки двигали бы одно, а число
  // показывало другое. Поэтому наведение мышью меняет его так же, как стрелки —
  // это одно и то же выделение.
  const iterationHitPos = iterationMode ? iterationHitPosition(rows, selectedIndex) : 0;
  // Что написать на разделительной линии. Три РАЗНЫХ факта, и они не
  // складываются в один: идёт обход (и список под ним — уже ответ, просто
  // неполный), точной фразы не нашлось нигде, и сколько всего найдено. Место
  // одно, поэтому важнейшее вытесняет остальное: пока ищем — говорим об этом.
  const iterationFrameNote: { text: string; tone: 'info' | 'warn' } | null = !iterationMode
    ? null
    : iterationLoading
      ? {
        text: iterationAnsweredQuery && iterationAnsweredQuery !== query.trim()
          ? `Ищу… (ниже — ответ на «${iterationAnsweredQuery}»)`
          : (iterationHitCount > 0 ? `Ищу… найдено ${iterationHitCount} в ${iterationTabCount}` : 'Ищу по промптам…'),
        tone: 'info',
      }
      : iterationMatchMode === 'words' && iterationHitCount > 0
        ? { text: `Точной фразы нет — по всем словам: ${iterationHitCount} в ${iterationTabCount}`, tone: 'warn' }
        : iterationHitCount > 0
          ? { text: `Найдено ${iterationHitCount} в ${iterationTabCount}`, tone: 'info' }
          : null;
  // Высота — доля экрана, а не пиксели: на 4K половина высоты больше, чем весь
  // экран ноутбука, а на ноутбуке та же половина не вмещает и трёх промптов.
  const panelMaxHeight = iterationMode
    ? iterationPanelMaxHeight(window.innerHeight, SWITCHER_DOCK_TOP_PX)
    : null;
  // Own work outranks waiting: a tab answering itself shows its own colour.
  const inheritedBusySet = new Set(inheritedBusyKey ? inheritedBusyKey.split(' ') : []);
  const isInheritedBusy = (tabId: string) => inheritedBusySet.has(tabId) && !isBusy(tabId);

  return (
    <div
      data-tab-switcher-root
      data-tab-switcher-mode={mode || ''}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: Z_INDEX,
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'flex-start',
        // Docked to the bottom edge of the system bars (titlebar 40 + project
        // toolbar 30) instead of floating at an arbitrary 90px: the panel is
        // opened FROM that strip, so it should read as hanging off it. Measured
        // from the real bars — if their height changes, update both constants.
        paddingTop: SWITCHER_DOCK_TOP_PX,
      }}
      // Закрытие по фону требует, чтобы НА ФОНЕ произошло и нажатие, и
      // отпускание. Текст найденного промпта выделяемый, а выделение часто
      // дотягивают за край панели: проверка одного только нажатия или одного
      // отпускания закрывала бы панель ровно в тот момент, когда человек тянет
      // выделение — то есть наказывала бы за то, ради чего текст и сделан
      // выделяемым.
      onPointerDown={(e) => { backdropPressRef.current = e.target === e.currentTarget; }}
      onPointerUp={(e) => {
        const onBackdrop = backdropPressRef.current && e.target === e.currentTarget;
        backdropPressRef.current = false;
        if (onBackdrop) close();
      }}
    >
      <div
        style={{
          // Поиск по промптам шире и выше обычного списка: строка результата —
          // это текст в несколько строк, а не имя вкладки, и в 480px он
          // превратился бы в столбик из обрывков.
          width: iterationMode ? 720 : 480,
          maxHeight: panelMaxHeight != null
            ? panelMaxHeight
            : `min(440px, calc(100vh - ${SWITCHER_DOCK_TOP_PX + 24}px))`,
          border: `1px solid ${PANEL_BORDER}`,
          borderTop: 'none',
          borderRadius: SWITCHER_RADIUS,
          background: PANEL_BG,
          boxShadow: '0 12px 34px rgba(0,0,0,0.55)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          fontSize: 13,
        }}
      >
        {/* No "Open Tabs" header — the list speaks for itself; search mode
            shows the input instead. */}
        {mode === 'search' && (
          // Поле и переключатель — одна строка: переключатель стоит В поле, у
          // правого края, потому что он меняет не панель, а смысл того, что вы
          // сейчас печатаете. Отдельная строка над списком читалась бы как
          // фильтр результатов, а это не фильтр — это другой вопрос.
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '0 8px 0 14px',
              borderBottom: `1px solid ${PANEL_BORDER}`,
            }}
          >
            <input
              ref={inputRef}
              type="text"
              value={query}
              placeholder={scope === 'iterations' ? 'Что я писал…' : 'Поиск по вкладкам…'}
              spellCheck={false}
              onChange={(e) => setQuery(e.target.value)}
              style={{
                flex: 1,
                minWidth: 0,
                padding: '10px 0',
                background: 'transparent',
                border: 'none',
                color: '#e8e8e8',
                fontSize: 13,
                outline: 'none',
              }}
            />
            {iterationMode && iterationHitCount > 0 && (
              // Счётчик и стрелки — в строке ввода, как в любом поиске: они
              // относятся к запросу, а не к списку. Стрелки двигают ту же
              // выделенную строку, что и клавиши: второго «текущего» результата
              // здесь нет, иначе Enter и стрелка вниз повели бы в разные места.
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                <span
                  data-switcher-iteration-count
                  title={`Найдено ${iterationHitCount} в ${iterationTabCount} вкладках`}
                  style={{ fontSize: 10.5, color: '#8a8a8f', fontVariantNumeric: 'tabular-nums' }}
                >
                  {iterationHitPos || '–'}/{iterationHitCount}
                </span>
                {([
                  { dir: -1 as const, glyph: '↑', hint: 'Предыдущий результат' },
                  { dir: +1 as const, glyph: '↓', hint: 'Следующий результат' },
                ]).map((step) => (
                  <button
                    key={step.dir}
                    type="button"
                    data-switcher-iteration-step={step.dir}
                    title={step.hint}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      selectByKeyboard((prev) => stepIndex(rowsRef.current, prev, step.dir));
                      inputRef.current?.focus();
                    }}
                    style={{
                      width: 18,
                      height: 18,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderRadius: 4,
                      border: 'none',
                      background: 'transparent',
                      color: '#8a8a8f',
                      fontSize: 11,
                      cursor: 'pointer',
                    }}
                  >
                    {step.glyph}
                  </button>
                ))}
              </div>
            )}
            <div
              data-switcher-scope-toggle
              role="tablist"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 2,
                padding: 2,
                borderRadius: 6,
                border: '1px solid rgba(255,255,255,0.10)',
                background: 'rgba(255,255,255,0.04)',
                flexShrink: 0,
              }}
            >
              {([
                { value: 'tabs' as const, label: 'Вкладки', hint: 'Искать по названиям открытых вкладок (Tab — переключить)' },
                { value: 'iterations' as const, label: 'Итерации', hint: 'Искать по тексту промптов в открытых вкладках (Tab — переключить)' },
              ]).map((option) => {
                const active = scope === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    data-switcher-scope={option.value}
                    title={option.hint}
                    onMouseDown={(e) => {
                      // Не отдаём фокус кнопке: человек печатает, и после
                      // переключения должен продолжить печатать, а не искать
                      // курсор. Поэтому переключение — на mousedown, и фокус
                      // сразу возвращается в поле.
                      e.preventDefault();
                      setScope(option.value);
                      inputRef.current?.focus();
                    }}
                    style={{
                      height: 20,
                      padding: '0 8px',
                      borderRadius: 4,
                      border: 'none',
                      background: active ? 'rgba(255,255,255,0.14)' : 'transparent',
                      color: active ? '#e8e8e8' : '#8a8a8f',
                      fontSize: 10.5,
                      fontWeight: 600,
                      cursor: 'pointer',
                      transition: 'background-color 0.12s ease, color 0.12s ease',
                    }}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {iterationMode && iterationProjectChips.length > 0 && (
          // ГДЕ искать — вторая строка, отдельно от того, ЧТО искать. Это не
          // фильтр результатов: он меняет объём работы ещё до запроса, поэтому
          // и стоит рядом со строкой ввода, а не над списком найденного.
          <div
            data-switcher-iteration-scope
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '6px 8px 6px 14px',
              borderBottom: `1px solid ${PANEL_BORDER}`,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1, minWidth: 0, flexWrap: 'wrap' }}>
              {iterationProjectChips.map((chip) => {
                const active = iterationProjects.has(chip.projectId);
                // ИКОНКА вместо названия. Проектов шесть-семь, они постоянные, и
                // человек узнаёт их по картинке быстрее, чем читает слово: в
                // сайдбаре и титлбаре он и так видит эти иконки каждый день.
                // Названия в ряд занимали всю строку и переносились на вторую —
                // управление стоило больше места, чем результаты. Название
                // остаётся в подсказке, а без иконки — проект показывается
                // словом, иначе его нельзя отличить от соседа.
                return (
                  <button
                    key={chip.projectId}
                    type="button"
                    data-switcher-iteration-project={chip.projectId}
                    data-active={active ? '1' : '0'}
                    title={chip.name}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      toggleIterationProject(chip.projectId);
                      inputRef.current?.focus();
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                      height: 22,
                      width: chip.icon ? 22 : undefined,
                      padding: chip.icon ? 0 : '0 6px',
                      justifyContent: 'center',
                      borderRadius: 4,
                      border: 'none',
                      background: active ? 'rgba(255,255,255,0.16)' : 'transparent',
                      color: active ? '#e8e8e8' : '#7c7c82',
                      // Невыбранный проект приглушён, а не спрятан: ряд должен
                      // отвечать и на «где ищу», и на «где мог бы».
                      opacity: active ? 1 : 0.4,
                      fontSize: 10.5,
                      fontWeight: 600,
                      cursor: 'pointer',
                      maxWidth: 120,
                      transition: 'background-color 0.12s ease, opacity 0.12s ease',
                    }}
                  >
                    {chip.icon ? (
                      <img
                        src={chip.icon}
                        alt=""
                        draggable={false}
                        style={{ width: 16, height: 16, borderRadius: 3, objectFit: 'cover', flexShrink: 0 }}
                      />
                    ) : (
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {chip.name}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              data-switcher-iteration-all
              title="Выбрать все проекты (повторно — снять выбор)"
              onMouseDown={(e) => {
                e.preventDefault();
                toggleAllIterationProjects();
                inputRef.current?.focus();
              }}
              style={{
                flexShrink: 0,
                height: 20,
                padding: '0 8px',
                borderRadius: 4,
                border: '1px solid rgba(255,255,255,0.10)',
                background: iterationProjectChips.every((chip) => iterationProjects.has(chip.projectId))
                  ? 'rgba(255,255,255,0.14)'
                  : 'transparent',
                color: '#9a9aa0',
                fontSize: 10.5,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Все
            </button>
          </div>
        )}

        {iterationMode && iterationFrameNote && (
          // Плашка НА разделительной линии, а не строкой в списке.
          //
          // Строкой она стоила бы места дважды: сама занимала бы ряд и сдвигала
          // весь список вниз при каждом появлении — а появляется она на каждый
          // запрос. Посаженная на линию, она не стоит раскладке ничего в обоих
          // направлениях и читается как подпись К ПАНЕЛИ, а не как первый
          // результат поиска. Тот же приём, что у подписи состояния на рамке
          // композера в переписке (`HistoryPanel::historyComposerFloatingStatus`).
          <div
            data-switcher-iteration-frame-note
            style={{
              position: 'relative',
              height: 0,
              // Поверх списка: линия под ней, текст над.
              zIndex: 1,
            }}
          >
            <span
              style={{
                position: 'absolute',
                // Слева, по тому же отступу, что и содержимое панели: служебная
                // подпись начинается там, где начинается всё остальное.
                left: 14,
                top: 0,
                transform: 'translate(0, -50%)',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                maxWidth: 'calc(100% - 28px)',
                padding: '0 6px',
                // Фон панели — линия исчезает за плашкой, а не перечёркивает
                // текст. Литерал здесь показал бы шов, если фон панели сменится,
                // поэтому берём ту же константу.
                background: PANEL_BG,
                borderRadius: 4,
                fontSize: 10,
                lineHeight: 1.35,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                color: iterationFrameNote.tone === 'warn' ? '#c58b3a' : '#8a8a8f',
                pointerEvents: 'none',
              }}
            >
              {iterationFrameNote.text}
            </span>
          </div>
        )}

        <div ref={listRef} className="tab-list-scroll" style={{ overflowY: 'auto', flex: 1, padding: '4px 6px 6px' }}>
          {rows.length === 0 && (
            <div style={{ padding: 14, textAlign: 'center', color: '#777', fontSize: 12.5 }}>
              {/* Пять РАЗНЫХ фактов, и путать их нельзя: «идёт поиск»,
                  «допишите запрос», «не выбран ни один проект», «ошибка» и
                  «ничего не нашлось». Одна строка «ничего не найдено» на все
                  случаи заставила бы человека гадать, ждать ему,
                  переформулировать или включить проект. */}
              {mode === 'ctrl'
                ? 'Нет открытых вкладок'
                : iterationMode
                  ? (iterationLoading
                    ? 'Ищу по промптам…'
                    : iterationError
                      ? iterationError
                      : query.trim().length < ITERATION_MIN_QUERY
                        ? 'Введите слово из промпта'
                        : iterationProjects.size === 0
                          ? 'Выберите хотя бы один проект'
                          : 'Ничего не нашлось')
                  : 'Вкладки не найдены'}
            </div>
          )}
          {mode === 'ctrl' && nothingToReturnTo && (
            // The list is not empty — it holds the anchor — but there is nothing
            // to GO to, and that is a different fact from "the search found
            // nothing". Said under the anchor rather than instead of it, so the
            // row the user is on stays on screen while he reads why the panel
            // ends there.
            <div style={{ padding: '10px 14px 6px', textAlign: 'center', color: '#777', fontSize: 12.5 }}>
              Все вкладки уже на экране
            </div>
          )}
          {rows.map((row, index) => {
            if (row.kind === 'project') {
              // TOC separator, not a landmark: the flat list follows global
              // tab recency, so the same project header can appear several
              // times per open. Icon deliberately small (12px) and dimmed —
              // frequent repetition must not shout. Non-clickable.
              return (
                <TabListProjectHeader
                  key={`p:${row.projectId}:${index}`}
                  projectName={row.projectName}
                  projectIcon={row.projectIcon}
                />
              );
            }

            if (row.kind === 'iteration-tab') {
              // Разделитель, как заголовок проекта: не выбирается и никуда не
              // ведёт сам — ведут строки промптов под ним.
              const hitsHere = rows
                .slice(index + 1)
                .findIndex((next) => next.kind !== 'iteration');
              return (
                <IterationTabHeader
                  key={`it:${row.tabId}:${index}`}
                  row={row}
                  count={hitsHere === -1 ? rows.length - index - 1 : hitsHere}
                />
              );
            }

            if (row.kind === 'iteration') {
              const hit = row.hit;
              const selected = index === selectedIndex;
              return (
                <div
                  key={`i:${hit.tabId}:${hit.entryUuid}`}
                  ref={selected ? (el) => {
                    if (el && selectionByKeyboardRef.current) el.scrollIntoView({ block: 'nearest' });
                  } : undefined}
                >
                  <IterationResultRow
                    hit={hit}
                    index={index}
                    selected={selected}
                    expanded={expandedHits.has(hit.entryUuid)}
                    onToggleExpanded={() => setExpandedHits((prev) => {
                      const next = new Set(prev);
                      if (next.has(hit.entryUuid)) next.delete(hit.entryUuid);
                      else next.add(hit.entryUuid);
                      return next;
                    })}
                    onPointerEnter={() => { if (!mouseBlockedRef.current) selectByMouse(index); }}
                    onOpen={() => commitRow(row)}
                  />
                </div>
              );
            }

            const tab = row.tab;
            const missing = !!row.missing;
            const selected = index === selectedIndex;
            // Row 1 in ctrl mode is the tab the user is ON — the reference point,
            // not a destination. It still commits on click (that is just "stay
            // here, close the panel"), it just does not look like a target.
            const anchor = mode === 'ctrl' && !!activeTabId && tab.id === activeTabId;

            // Row visuals live in TabListRows — the pane header's recent-tabs
            // list renders the same component, so the two lists cannot drift
            // into looking like different things.
            return (
              <div
                key={tab.id}
                ref={selected ? (el) => {
                  if (el && selectionByKeyboardRef.current) el.scrollIntoView({ block: 'nearest' });
                } : undefined}
              >
                <TabListTabRow
                  tab={tab}
                  index={index}
                  selected={selected}
                  missing={missing}
                  hasProcess={hasProcess(tab)}
                  busy={isBusy(tab.id)}
                  inheritedBusy={isInheritedBusy(tab.id)}
                  sessionStatuses={sessionStatuses}
                  anchor={anchor}
                  // Layout map: which pane this tab is already open in. Same mark
                  // as the sidebar card, so "this is the side pane's tab" is
                  // visible while choosing.
                  paneMapProjectId={row.projectId}
                  onPointerEnter={() => { if (!mouseBlockedRef.current && !missing) selectByMouse(index); }}
                  onPointerDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    // MIDDLE click = forget this row, and the window stays open:
                    // the user is editing the list, not navigating. Works on a
                    // missing-file row too — a dead row is exactly what one
                    // wants to clear out. Handled on pointerdown like the pick,
                    // so both gestures are answered by one handler.
                    if (e.button === 1) { forgetRow(row); return; }
                    if (e.button !== 0) return;
                    if (missing) return; // vanished file — dead row, not a target
                    commitRow(row);
                  }}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
