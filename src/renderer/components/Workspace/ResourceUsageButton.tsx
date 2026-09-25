import React, { useState, useEffect, useRef, useMemo, useCallback, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Activity, ChevronRight, ChevronDown, Folder, SquareTerminal, X } from 'lucide-react';
import Tooltip from '../UI/Tooltip';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useProjectsStore } from '../../store/useProjectsStore';
import { CUSTOM_ICONS } from '../../assets/icons/registry';
import { historyPreparationStatus, historyPreparationLabel } from '../../utils/historyPreparationStatus.mjs';

const { ipcRenderer } = window.require('electron');

// Названия вкладок пакуются в одну строку ради дешёвой подписки. Разделители
// берём управляющие — они не встречаются ни в идентификаторе, ни в имени.
const FIELD_SEPARATOR = String.fromCharCode(31);
const RECORD_SEPARATOR = String.fromCharCode(30);

const Portal: React.FC<{ children: React.ReactNode }> = ({ children }) =>
  createPortal(children, document.body);

type ToolRow = {
  count?: number;
  pid: number;
  label: string;
  bytes: number;
  cpu: number | null;
};

type TabGroup = {
  tabId: string;
  projectId: string | null;
  title: string;
  pid: number;
  alive: boolean;
  sharedWithOtherTab?: boolean;
  selfBytes: number;
  // Агент вкладки (Codex/Claude/Gemini) и команды, запущенные в ней (npm run
  // dev): main отдаёт их отдельными строками, чтобы «прочее» не съедало
  // гигабайты без имени. Поля опциональны: старый main их ещё не шлёт.
  agents?: ToolRow[];
  agentBytes?: number;
  commands?: ToolRow[];
  commandBytes?: number;
  toolsBytes: number;
  totalBytes: number;
  selfCpu: number | null;
  toolsCpu: number | null;
  totalCpu: number | null;
  tools: ToolRow[];
  otherBytes: number;
  toolCount: number;
};

type MetricsPayload = {
  ok: boolean;
  reason?: string;
  scannedAt?: number;
  durationMs?: number;
  hasCpu?: boolean;
  projectTabs?: TabGroup[];
  otherTabs?: TabGroup[];
  app?: { totalBytes: number; totalCpu: number | null; rows: ToolRow[] };
  orphans?: { count: number; totalBytes: number; rows: ToolRow[] };
  sharedServices?: ToolRow[];
  totals?: { projectBytes: number; otherBytes: number; allBytes?: number };
};

/** Итог для чипа: то же число, что в подписи панели, но без разбора по строкам. */
type AmbientPayload = {
  ok: boolean;
  reason?: string;
  scannedAt?: number | null;
  totalBytes?: number;
  orphanCount?: number;
};

type Mode = 'memory' | 'cpu';

// Ширина числа больше не резервируется под «99.99 ГБ». Резерв был виден не сам
// по себе, а той дырой, которую оставлял между значком и числом: под «6.5 ГБ»
// пустовало место ещё под два знака. Теперь ширину задаёт само содержимое, а
// `minWidth` держит только нижнюю границу, чтобы прочерк до первого замера не
// сжимал кнопку в точку.
//
// Дёрганья соседей это не даёт: с одним знаком после точки ширина меняется
// только на переходе «9.9 ГБ» → «10.1 ГБ», то есть при смене разряда, а не на
// каждом замере. Именно поэтому знак после точки один: со вторым («6.46 ГБ»)
// последняя цифра дрожала бы при каждом тике, ничего не сообщая — десятки
// мегабайт в шестигигабайтном итоге не решение пользователя, а шум.
const RESOURCE_CHIP_VALUE_MIN_WIDTH_CH = '4.4ch';

function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return '0 МБ';
  const mb = bytes / 1048576;
  if (mb >= 1024) return (mb / 1024).toFixed(1) + ' ГБ';
  return Math.round(mb) + ' МБ';
}

function formatCpu(value: number | null): string {
  // null и 0 — разные утверждения: «ещё не измерено» против «простаивает».
  // Показывать их одинаково значит врать в первую же секунду после открытия.
  if (value === null || value === undefined) return '—';
  if (value < 0.05) return '0 %';
  return value.toFixed(1) + ' %';
}

/**
 * Имя проекта из его идентификатора, когда проект не открыт в интерфейсе.
 * Идентификатор — это закодированный путь, из него достаётся последняя папка.
 */
function decodeProjectName(projectId: string): string {
  try {
    const path = atob(projectId.replace(/-/g, '+').replace(/_/g, '/'));
    // Только настоящий путь: у проектов-черновиков идентификатор не является
    // закодированным путём, и atob отдаёт бинарный мусор без исключения.
    if (path.startsWith('/')) {
      const base = path.split('/').pop();
      if (base) return base;
    }
  } catch { /* не путь — покажем общий ярлык */ }
  return 'проект';
}

/**
 * Значок агента вкладки. Берём те же изображения, что и остальное приложение
 * (`CUSTOM_ICONS`), а не рисуем свои: иначе одна и та же сессия выглядела бы
 * в панели не так, как в шапке и в дереве файлов.
 */
const AgentIcon: React.FC<{ agent: string }> = ({ agent }) => {
  const icon = agent === 'claude' ? CUSTOM_ICONS.claude
    : agent === 'codex' ? CUSTOM_ICONS.codex
    : agent === 'gemini' ? CUSTOM_ICONS.gemini
    : null;
  // Место под значок занято всегда, даже когда значка нет: иначе обычная
  // вкладка и вкладка с агентом начинались бы с разных отступов, и колонка
  // имён шла бы лесенкой.
  return (
    <span style={{ width: 12, height: 12, flexShrink: 0, display: 'inline-flex' }}>
      {icon}
    </span>
  );
};

/** Подпись вкладки: сначала имя из интерфейса, иначе — что за процесс. */
function tabLabel(group: TabGroup, storeTitle?: string): string {
  if (storeTitle) return storeTitle;
  if (group.title) return group.title;
  return 'вкладка ' + group.pid;
}

const ResourceUsageButton: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>('memory');
  const [metrics, setMetrics] = useState<MetricsPayload | null>(null);
  const [ambient, setAmbient] = useState<AmbientPayload | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [killing, setKilling] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const preparationStore = historyPreparationStatus();
  const preparation = useSyncExternalStore(preparationStore.subscribe, preparationStore.getActivitySnapshot);

  const activeProjectId = useWorkspaceStore(state => state.activeProjectId);

  // Названия вкладок живут в интерфейсе, а не в системе: main знает только
  // номера процессов. Берём подписи здесь, чтобы в панели читалось
  // «codex · main», а не «вкладка 37025».
  // Подписываемся на строку, а не на массив вкладок: подписка на объект
  // перерисовывала бы панель при любом изменении в любой вкладке.
  // Все проекты, не только активный: в списке есть каждый проект, и его
  // вкладкам тоже нужны имена.
  const tabTitles = useWorkspaceStore(state => {
    const records: string[] = [];
    for (const [, workspace] of state.openProjects) {
      for (const [tabId, tab] of workspace.tabs) {
        // Тип вкладки едет рядом с именем в той же строке: отдельная подписка
        // ради одного поля стоила бы второго обхода всех вкладок.
        records.push(
          tabId + FIELD_SEPARATOR + ((tab && tab.name) || '')
          + FIELD_SEPARATOR + ((tab && tab.commandType) || ''),
        );
      }
    }
    return records.join(RECORD_SEPARATOR);
  });

  // Имя и значок проекта — из каталога проектов: там лежит то же, что видно в
  // шапке, включая цветной значок. Резервный путь (папка из пути рабочей
  // области или из идентификатора) нужен для проекта, которого в каталоге ещё
  // нет — строка не должна остаться безымянной.
  const projects = useProjectsStore(state => state.projects);

  const workspacePaths = useWorkspaceStore(state => {
    const records: string[] = [];
    for (const [projectId, workspace] of state.openProjects) {
      records.push(projectId + FIELD_SEPARATOR + (workspace.projectPath || ''));
    }
    return records.join(RECORD_SEPARATOR);
  });

  const projectMeta = useMemo(() => {
    const map = new Map<string, { name: string; icon: string | null }>();
    for (const [projectId, project] of Object.entries(projects || {})) {
      if (project?.name) map.set(projectId, { name: project.name, icon: project.icon || null });
    }
    if (workspacePaths) {
      for (const record of workspacePaths.split(RECORD_SEPARATOR)) {
        const separatorIndex = record.indexOf(FIELD_SEPARATOR);
        if (separatorIndex < 0) continue;
        const projectId = record.slice(0, separatorIndex);
        if (map.has(projectId)) continue;
        const projectPath = record.slice(separatorIndex + 1);
        const base = projectPath && !projectPath.startsWith('__unset__')
          ? (projectPath.split('/').pop() || '')
          : '';
        if (base) map.set(projectId, { name: base, icon: null });
      }
    }
    return map;
  }, [projects, workspacePaths]);

  const tabInfoById = useMemo(() => {
    const map = new Map<string, { title: string; agent: string }>();
    if (!tabTitles) return map;
    for (const record of tabTitles.split(RECORD_SEPARATOR)) {
      const [tabId, title, agent] = record.split(FIELD_SEPARATOR);
      if (!tabId) continue;
      map.set(tabId, { title: title || '', agent: agent || '' });
    }
    return map;
  }, [tabTitles]);

  // Чип показывает число всегда, а не после клика. Раньше замер запускался
  // только вместе с панелью, поэтому у закрытой кнопки стоял прочерк — цифра
  // появлялась лишь тогда, когда её уже и так открыли посмотреть.
  //
  // Здесь приходит только итог (~75 байт против 5+ КБ полной раскладки), шаг —
  // 5 с. Замер в main общий с панелью: когда она открыта, её быстрый тик
  // кормит и этот канал тоже.
  useEffect(() => {
    let cancelled = false;
    const onAmbient = (_event: unknown, payload: AmbientPayload) => {
      if (!cancelled) setAmbient(payload);
    };

    ipcRenderer.on('system:process-metrics-ambient', onAmbient);
    ipcRenderer.invoke('system:process-metrics-ambient-start')
      .then((payload: AmbientPayload) => { if (!cancelled) setAmbient(payload); })
      .catch(() => {});

    return () => {
      cancelled = true;
      ipcRenderer.removeListener('system:process-metrics-ambient', onAmbient);
      // Чип живёт только в рабочей области: уходя на Home, гасим и замер,
      // иначе main продолжал бы тикать для того, кого уже нет на экране.
      ipcRenderer.invoke('system:process-metrics-ambient-stop').catch(() => {});
    };
  }, []);

  // Полная раскладка — только пока панель открыта: построчный разбор нужен
  // ровно тому, кто на него смотрит.
  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    const onUpdate = (_event: unknown, payload: MetricsPayload) => {
      if (!cancelled) setMetrics(payload);
    };

    ipcRenderer.on('system:process-metrics', onUpdate);
    ipcRenderer.invoke('system:process-metrics-subscribe', { projectId: activeProjectId })
      .then((payload: MetricsPayload) => { if (!cancelled) setMetrics(payload); })
      .catch(() => { if (!cancelled) setMetrics({ ok: false, reason: 'subscribe-failed' }); });

    return () => {
      cancelled = true;
      ipcRenderer.removeListener('system:process-metrics', onUpdate);
      ipcRenderer.invoke('system:process-metrics-unsubscribe').catch(() => {});
    };
  }, [open, activeProjectId]);

  const toggleExpanded = useCallback((tabId: string) => {
    setExpanded(previous => {
      const next = new Set(previous);
      if (next.has(tabId)) next.delete(tabId);
      else next.add(tabId);
      return next;
    });
  }, []);

  const handleKillOrphans = useCallback(async () => {
    const rows = metrics?.orphans?.rows || [];
    if (rows.length === 0 || killing) return;
    setKilling(true);
    try {
      // Переиспользуем общий путь остановки: в нём уже есть защита от
      // убийства процессов самого приложения.
      await Promise.all(rows.map(row =>
        ipcRenderer.invoke('system:kill-process', row.pid).catch(() => null)
      ));
    } finally {
      setKilling(false);
    }
  }, [metrics, killing]);

  // Неактивные вкладки — это пустые оболочки по несколько мегабайт. Их бывает
  // несколько десятков, и в общем списке они вытесняют то, ради чего панель
  // открывают. Показываем их одной свёрнутой строкой с суммой.
  const MINOR_TAB_LIMIT_BYTES = 12 * 1048576;

  const [showMinor, setShowMinor] = useState(false);

  // Проекты в одном списке: текущий и остальные различаются только подачей
  // (белая подпись), а не автоматическим раскрытием. Раньше
  // чужие проекты были тупиковой строкой «вкладок: 77» — состав приходилось
  // выяснивать, переключая проекты руками.
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const toggleProject = useCallback((projectId: string) => {
    setExpandedProjects(previous => {
      const next = new Set(previous);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  }, []);

  const projectSections = useMemo(() => {
    const currentId = activeProjectId || '';
    const byProject = new Map<string, TabGroup[]>();
    // Текущий проект показываем всегда, даже без вкладок: пустой список —
    // это ответ «вкладок нет», а пропавшая строка читается как «проекта нет».
    if (currentId) byProject.set(currentId, []);
    for (const group of [...(metrics?.projectTabs || []), ...(metrics?.otherTabs || [])]) {
      const key = group.projectId || currentId;
      if (!byProject.has(key)) byProject.set(key, []);
      byProject.get(key)!.push(group);
    }

    const sections = [...byProject.entries()].map(([projectId, tabs]) => {
      const sorted = [...tabs].sort((a, b) => mode === 'memory'
        ? b.totalBytes - a.totalBytes
        : (b.totalCpu || 0) - (a.totalCpu || 0));
      // В режиме нагрузки порог по памяти неуместен: простаивающая вкладка
      // интересна ровно тем, что она простаивает.
      const major = mode === 'cpu' ? sorted : sorted.filter(tab => tab.totalBytes >= MINOR_TAB_LIMIT_BYTES);
      const minor = mode === 'cpu' ? [] : sorted.filter(tab => tab.totalBytes < MINOR_TAB_LIMIT_BYTES);
      const meta = projectMeta.get(projectId);
      const isCurrent = projectId === currentId;
      return {
        projectId,
        isCurrent,
        name: meta?.name || decodeProjectName(projectId),
        icon: meta?.icon || null,
        tabs: major,
        minorTabs: minor,
        minorBytes: minor.reduce((total, tab) => total + tab.totalBytes, 0),
        totalBytes: sorted.reduce((total, tab) => total + tab.totalBytes, 0),
        totalCpu: sorted.reduce((total, tab) => total + (tab.totalCpu || 0), 0),
      };
    });

    // Текущий проект первым, остальные по убыванию веса.
    return sections.sort((a, b) => {
      if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
      return b.totalBytes - a.totalBytes;
    });
  }, [metrics, mode, activeProjectId, projectMeta]);

  // В заголовке проектов нужен вес всех проектов, включая свёрнутые и
  // скрытые мелкие вкладки. Брошенные инструменты лежат в отдельной группе.
  const projectsTotalBytes = metrics?.totals
    ? metrics.totals.projectBytes + metrics.totals.otherBytes
    : projectSections.reduce((total, project) => total + project.totalBytes, 0);
  const projectsTotalCpu = metrics?.hasCpu
    ? projectSections.reduce((total, project) => total + project.totalCpu, 0)
    : null;

  // Итог считает main (`totals.allBytes`) — это же число уходит в чип. Старое
  // сложение четырёх полей здесь оставлено запасным путём для payload прежнего
  // формата, чтобы подпись панели не обнулилась на несовпадении версий.
  const totalBytes = metrics?.totals?.allBytes ?? (
    (metrics?.totals?.projectBytes || 0)
    + (metrics?.app?.totalBytes || 0)
    + (metrics?.totals?.otherBytes || 0)
    + (metrics?.orphans?.totalBytes || 0)
  );

  // Пока панель открыта, она сама свежее фонового канала — берём её цифры.
  // Иначе чип живёт на лёгком итоге, который идёт всегда.
  const chipSource = (open && metrics?.ok)
    ? { ok: true, totalBytes, orphanCount: metrics?.orphans?.count || 0 }
    : ambient;
  const orphanCount = (open ? (metrics?.orphans?.count || 0) : (ambient?.orphanCount || 0));
  const chipValue = chipSource?.ok ? formatBytes(chipSource.totalBytes || 0) : '—';

  const valueOf = (bytes: number, cpu: number | null) =>
    mode === 'memory' ? formatBytes(bytes) : formatCpu(cpu);

  return (
    <>
      <Tooltip content={historyPreparationLabel(preparation, tabInfoById)}>
        <button
          ref={buttonRef}
          onClick={() => setOpen(value => !value)}
          className="flex h-[26px] shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1.5 text-[11px] transition-colors cursor-pointer"
          style={{
            border: '1px solid ' + (open ? 'rgba(56,189,248,0.28)' : 'rgba(255,255,255,0.10)'),
            background: open ? 'rgba(56,189,248,0.13)' : 'rgba(255,255,255,0.04)',
            color: open ? '#bae6fd' : '#aaa',
            fontVariantNumeric: 'tabular-nums',
            flexShrink: 0,
            whiteSpace: 'nowrap',
          }}
          // Наведение — как у соседей по шапке. Открытая панель уже красит
          // кнопку своим цветом, поверх него подсвечивать нечего.
          onMouseEnter={(event) => {
            if (open) return;
            event.currentTarget.style.background = 'rgba(255,255,255,0.10)';
            event.currentTarget.style.borderColor = 'rgba(255,255,255,0.22)';
            event.currentTarget.style.color = '#e4e4e7';
          }}
          onMouseLeave={(event) => {
            if (open) return;
            event.currentTarget.style.background = 'rgba(255,255,255,0.04)';
            event.currentTarget.style.borderColor = 'rgba(255,255,255,0.10)';
            event.currentTarget.style.color = '#aaa';
          }}
        >
          <Activity size={11} data-history-preparation={preparation.active ? 'active' : undefined}
            style={preparation.active ? { color: '#e879a8', flexShrink: 0 } : undefined} />
          {/* Ширину задаёт само число, `minWidth` — только пол, чтобы прочерк
              до первого замера не схлопнул кнопку. Один знак после точки
              означает, что подпись меняет длину лишь на смене разряда
              («9.9 ГБ» → «10.1 ГБ»), а не на каждом тике. */}
          <span
            style={{
              display: 'inline-flex',
              justifyContent: 'flex-end',
              flexShrink: 0,
              minWidth: RESOURCE_CHIP_VALUE_MIN_WIDTH_CH,
              whiteSpace: 'nowrap',
            }}
          >
            {chipValue}
          </span>
          {orphanCount > 0 && (
            <span style={{ color: '#fca5a5' }}>·{orphanCount}</span>
          )}
        </button>
      </Tooltip>

      {open && buttonRef.current && (() => {
        const rect = buttonRef.current.getBoundingClientRect();
        return (
          <Portal>
            <div
              onClick={() => setOpen(false)}
              style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'transparent' }}
            />
            <div
              onClick={event => event.stopPropagation()}
              onMouseDown={event => event.stopPropagation()}
              style={{
                position: 'fixed',
                top: rect.bottom + 6,
                right: Math.max(8, window.innerWidth - rect.right),
                zIndex: 10000,
                width: 'min(400px, calc(100vw - 24px))',
                maxHeight: 'min(560px, calc(100vh - 80px))',
                display: 'flex',
                flexDirection: 'column',
              }}
              className="bg-[#1a1a1a] border border-[#444] rounded-lg shadow-2xl"
            >
              {/* Шапка: итог и переключатель колонок */}
              <div style={{ padding: '8px 10px', borderBottom: '1px solid #2a2a2a', display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ fontSize: 9, textTransform: 'uppercase', fontWeight: 700, color: '#777', letterSpacing: '0.05em', flex: 1 }}>
                  Ресурсы
                </div>
                <div style={{ display: 'flex', gap: 2 }}>
                  {(['memory', 'cpu'] as Mode[]).map(item => (
                    <button
                      key={item}
                      onClick={() => setMode(item)}
                      style={{
                        height: 20,
                        padding: '0 7px',
                        borderRadius: 5,
                        border: '1px solid ' + (mode === item ? 'rgba(56,189,248,0.3)' : 'transparent'),
                        background: mode === item ? 'rgba(56,189,248,0.14)' : 'rgba(255,255,255,0.04)',
                        color: mode === item ? '#bae6fd' : '#888',
                        fontSize: 10,
                        fontWeight: 700,
                        cursor: 'pointer',
                      }}
                    >
                      {item === 'memory' ? 'Память' : 'ЦП'}
                    </button>
                  ))}
                </div>
              </div>

              <div className="resource-panel-scroll" style={{ overflowY: 'auto', padding: '6px 0' }}>
                {!metrics && (
                  <div style={{ padding: '14px 10px', fontSize: 11, color: '#888' }}>Измеряю…</div>
                )}

                {metrics && !metrics.ok && (
                  <div style={{ padding: '14px 10px', fontSize: 11, color: '#fca5a5' }}>
                    Не удалось получить данные{metrics.reason ? ' (' + metrics.reason + ')' : ''}
                  </div>
                )}

                {metrics && metrics.ok && (
                  <>
                    {/* Брошенное — наверху: единственное место, где один клик
                        реально освобождает память. */}
                    {orphanCount > 0 && (
                      <div style={{
                        margin: '0 8px 6px',
                        padding: '7px 8px',
                        borderRadius: 6,
                        border: '1px solid rgba(248,113,113,0.25)',
                        background: 'rgba(248,113,113,0.07)',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                      }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 11, color: '#fca5a5', fontWeight: 600 }}>
                            Брошенные инструменты
                          </div>
                          <div style={{ fontSize: 10, color: '#9a6a6a', fontVariantNumeric: 'tabular-nums' }}>
                            {orphanCount} шт · {formatBytes(metrics.orphans!.totalBytes)}
                          </div>
                        </div>
                        <button
                          onClick={handleKillOrphans}
                          disabled={killing}
                          style={{
                            height: 22,
                            padding: '0 8px',
                            borderRadius: 5,
                            border: '1px solid rgba(248,113,113,0.3)',
                            background: 'rgba(248,113,113,0.12)',
                            color: '#fca5a5',
                            fontSize: 10,
                            fontWeight: 700,
                            cursor: killing ? 'default' : 'pointer',
                            opacity: killing ? 0.6 : 1,
                            display: 'flex',
                            alignItems: 'center',
                            gap: 4,
                          }}
                        >
                          <X size={11} />
                          {killing ? 'Убираю' : 'Убрать'}
                        </button>
                      </div>
                    )}

                    {/* Проекты подряд, текущий первым. Заголовок проекта —
                        он же переключатель раскрытия: раньше чужие проекты
                        были тупиковой строкой «вкладок: 77». */}
                    <SectionTitle value={valueOf(projectsTotalBytes, projectsTotalCpu)}>Проекты</SectionTitle>
                    {projectSections.map(project => {
                      // При первом открытии все проекты свёрнуты. Текущий
                      // выделен стилем, а состав раскрывается только кликом.
                      const isOpen = expandedProjects.has(project.projectId);
                      const visibleTabs = showMinor
                        ? [...project.tabs, ...project.minorTabs]
                        : project.tabs;
                      return (
                        <div key={project.projectId}>
                          <button
                            onClick={() => toggleProject(project.projectId)}
                            style={{
                              width: '100%',
                              display: 'flex',
                              alignItems: 'center',
                              gap: 6,
                              padding: '5px 10px',
                              background: 'transparent',
                              border: 'none',
                              cursor: 'pointer',
                              textAlign: 'left',
                            }}
                            className="hover:bg-white/[0.03]"
                          >
                            <span style={{ width: 12, display: 'flex', color: '#666' }}>
                              {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                            </span>
                            {project.icon ? (
                              <img
                                src={project.icon}
                                alt=""
                                draggable={false}
                                style={{ width: 14, height: 14, borderRadius: 3, objectFit: 'cover', flexShrink: 0 }}
                              />
                            ) : (
                              <Folder size={13} style={{ color: '#6b7280', flexShrink: 0 }} />
                            )}
                            <span style={{
                              flex: 1,
                              minWidth: 0,
                              fontSize: 11,
                              // Текущий проект выделен подписью, а не отдельным
                              // разделом: список остаётся одним.
                              fontWeight: project.isCurrent ? 600 : 400,
                              color: project.isCurrent ? '#f4f4f5' : '#8a8a8a',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}>
                              {project.name}
                            </span>
                            <span style={{
                              fontSize: 11,
                              color: project.isCurrent ? '#ddd' : '#999',
                              fontVariantNumeric: 'tabular-nums',
                            }}>
                              {valueOf(project.totalBytes, project.totalCpu)}
                            </span>
                          </button>

                          {isOpen && visibleTabs.length === 0 && project.minorTabs.length === 0 && (
                            <EmptyRow>нет активных вкладок</EmptyRow>
                          )}

                          {isOpen && visibleTabs.map(group => {
                            const isExpanded = expanded.has(group.tabId);
                            const canExpand = group.tools.length > 0
                              || (group.agents || []).length > 0
                              || (group.commands || []).length > 0
                              || group.otherBytes > 0
                              || group.selfBytes > 0;
                            return (
                              <div key={group.tabId}>
                                <button
                                  onClick={() => canExpand && toggleExpanded(group.tabId)}
                                  style={{
                                    width: '100%',
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 6,
                                    padding: '4px 10px 4px 24px',
                                    background: 'transparent',
                                    border: 'none',
                                    cursor: canExpand ? 'pointer' : 'default',
                                    textAlign: 'left',
                                  }}
                                  className={canExpand ? 'hover:bg-white/[0.03]' : ''}
                                >
                                  <span style={{ width: 12, display: 'flex', color: '#666' }}>
                                    {canExpand && (isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />)}
                                  </span>
                                  <AgentIcon agent={tabInfoById.get(group.tabId)?.agent || ''} />
                                  <span style={{
                                    flex: 1,
                                    minWidth: 0,
                                    fontSize: 11,
                                    color: group.alive ? '#ddd' : '#777',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap',
                                  }}>
                                    {tabLabel(group, tabInfoById.get(group.tabId)?.title)}
                                    {!group.alive && <span style={{ color: '#666' }}> · завершена</span>}
                                    {group.sharedWithOtherTab && <span style={{ color: '#666' }}> · учтено выше</span>}
                                  </span>
                                  <span style={{ fontSize: 11, color: '#ddd', fontVariantNumeric: 'tabular-nums' }}>
                                    {valueOf(group.totalBytes, group.totalCpu)}
                                  </span>
                                </button>

                                {isExpanded && (
                                  <div style={{ padding: '0 10px 6px 42px' }}>
                                    {/* «Сессия Codex» — сам агент; «оболочка
                                        терминала» — корень вкладки на пару
                                        мегабайт. Раньше всё, кроме оболочки,
                                        безымянно лежало в «прочем». */}
                                    {(group.agents || []).map(agent => (
                                      <DetailRow
                                        key={'agent-' + agent.pid}
                                        label={'сессия ' + agent.label}
                                        value={valueOf(agent.bytes, agent.cpu)}
                                      />
                                    ))}
                                    {/* Команды, запущенные во вкладке: по имени
                                        видно, почему вкладка потяжелела. */}
                                    {(group.commands || []).map(command => (
                                      <DetailRow
                                        key={'cmd-' + command.pid}
                                        icon={<SquareTerminal size={11} strokeWidth={1.8} aria-hidden />}
                                        label={command.label}
                                        value={valueOf(command.bytes, command.cpu)}
                                      />
                                    ))}
                                    {group.tools.map(tool => (
                                      <DetailRow
                                        key={tool.pid}
                                        label={tool.label}
                                        value={valueOf(tool.bytes, tool.cpu)}
                                      />
                                    ))}
                                    <DetailRow
                                      label="оболочка терминала"
                                      value={valueOf(group.selfBytes, group.selfCpu)}
                                      muted
                                    />
                                    {group.otherBytes > 0 && (
                                      <DetailRow label="прочее" value={formatBytes(group.otherBytes)} muted />
                                    )}
                                  </div>
                                )}
                              </div>
                            );
                          })}

                          {isOpen && !showMinor && project.minorTabs.length > 0 && (
                            <button
                              onClick={() => setShowMinor(true)}
                              style={{
                                width: '100%',
                                display: 'flex',
                                alignItems: 'center',
                                gap: 6,
                                padding: '4px 10px 4px 36px',
                                background: 'transparent',
                                border: 'none',
                                cursor: 'pointer',
                                textAlign: 'left',
                              }}
                              className="hover:bg-white/[0.03]"
                            >
                              <span style={{ flex: 1, fontSize: 10.5, color: '#777' }}>
                                неактивные вкладки ({project.minorTabs.length})
                              </span>
                              <span style={{ fontSize: 10.5, color: '#888', fontVariantNumeric: 'tabular-nums' }}>
                                {formatBytes(project.minorBytes)}
                              </span>
                            </button>
                          )}
                        </div>
                      );
                    })}

                    <SectionTitle value={valueOf(metrics.app?.totalBytes || 0, metrics.app?.totalCpu ?? null)}>
                      Общее для приложения
                    </SectionTitle>
                    {(metrics.app?.rows || []).map(row => (
                      <div key={row.pid} style={{ display: 'flex', padding: '4px 10px 4px 28px', gap: 8 }}>
                        <span style={{ flex: 1, fontSize: 11, color: '#aaa' }}>
                          {row.label}
                          {(row.count || 1) > 1 && (
                            <span style={{ color: '#666' }}> ×{row.count}</span>
                          )}
                        </span>
                        <span style={{ fontSize: 11, color: '#bbb', fontVariantNumeric: 'tabular-nums' }}>
                          {valueOf(row.bytes, row.cpu)}
                        </span>
                      </div>
                    ))}

                  </>
                )}
              </div>

              {metrics?.ok && (
                <div style={{
                  padding: '6px 10px',
                  borderTop: '1px solid #2a2a2a',
                  display: 'flex',
                  gap: 8,
                  fontSize: 10,
                  color: '#666',
                  fontVariantNumeric: 'tabular-nums',
                }}>
                  <span style={{ flex: 1 }}>всего {formatBytes(totalBytes)}</span>
                  {mode === 'cpu' && !metrics.hasCpu && <span>замеряю нагрузку…</span>}
                  {metrics.durationMs !== undefined && <span>{metrics.durationMs.toFixed(0)} мс</span>}
                </div>
              )}
            </div>
          </Portal>
        );
      })()}
    </>
  );
};

const SectionTitle: React.FC<{ children: React.ReactNode; value: string }> = ({ children, value }) => (
  <div style={{
    padding: '8px 10px 4px',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontSize: 9,
    textTransform: 'uppercase',
    fontWeight: 700,
    color: '#666',
    letterSpacing: '0.05em',
  }}>
    <span style={{ flex: 1 }}>{children}</span>
    <span style={{ color: '#888', fontSize: 10.5, fontWeight: 400, letterSpacing: 'normal', textTransform: 'none', fontVariantNumeric: 'tabular-nums' }}>
      {value}
    </span>
  </div>
);

const EmptyRow: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ padding: '4px 10px 4px 28px', fontSize: 11, color: '#666' }}>{children}</div>
);

const DetailRow: React.FC<{
  label: string;
  value: string;
  muted?: boolean;
  icon?: React.ReactNode;
}> = ({ label, value, muted, icon }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' }}>
    {icon && (
      <span style={{
        width: 12,
        height: 12,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        color: muted ? '#666' : '#858585',
      }}>
        {icon}
      </span>
    )}
    <span style={{ flex: 1, fontSize: 10.5, color: muted ? '#666' : '#8a8a8a' }}>{label}</span>
    <span style={{ fontSize: 10.5, color: muted ? '#777' : '#999', fontVariantNumeric: 'tabular-nums' }}>{value}</span>
  </div>
);

export default ResourceUsageButton;
