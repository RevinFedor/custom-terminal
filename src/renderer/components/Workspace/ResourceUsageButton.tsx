import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Activity, ChevronRight, ChevronDown, X } from 'lucide-react';
import Tooltip from '../UI/Tooltip';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';

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
  totals?: { projectBytes: number; otherBytes: number };
};

type Mode = 'memory' | 'cpu';

// Самая длинная подпись, которую эта кнопка может показать: «99.99 ГБ» —
// два знака до точки, два после, пробел и две буквы. `ch` берёт ширину цифры
// текущего шрифта, а `tabular-nums` на кнопке делает все цифры одинаковыми,
// поэтому мерка держится и на другом размере шрифта. Единица «ГБ» шире цифры,
// отсюда небольшой запас.
const RESOURCE_CHIP_VALUE_WIDTH_CH = '7.6ch';

function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return '0 МБ';
  const mb = bytes / 1048576;
  if (mb >= 1024) return (mb / 1024).toFixed(2) + ' ГБ';
  return Math.round(mb) + ' МБ';
}

function formatCpu(value: number | null): string {
  // null и 0 — разные утверждения: «ещё не измерено» против «простаивает».
  // Показывать их одинаково значит врать в первую же секунду после открытия.
  if (value === null || value === undefined) return '—';
  if (value < 0.05) return '0 %';
  return value.toFixed(1) + ' %';
}

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
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [killing, setKilling] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const activeProjectId = useWorkspaceStore(state => state.activeProjectId);

  // Названия вкладок живут в интерфейсе, а не в системе: main знает только
  // номера процессов. Берём подписи здесь, чтобы в панели читалось
  // «codex · main», а не «вкладка 37025».
  // Подписываемся на строку, а не на массив вкладок: подписка на объект
  // перерисовывала бы панель при любом изменении в любой вкладке.
  const tabTitles = useWorkspaceStore(state => {
    const workspace = state.activeProjectId ? state.openProjects.get(state.activeProjectId) : null;
    if (!workspace) return '';
    const records: string[] = [];
    for (const [tabId, tab] of workspace.tabs) {
      records.push(tabId + FIELD_SEPARATOR + ((tab && tab.name) || ''));
    }
    return records.join(RECORD_SEPARATOR);
  });

  const titleByTabId = useMemo(() => {
    const map = new Map<string, string>();
    if (!tabTitles) return map;
    for (const record of tabTitles.split(RECORD_SEPARATOR)) {
      const separatorIndex = record.indexOf(FIELD_SEPARATOR);
      if (separatorIndex < 0) continue;
      map.set(record.slice(0, separatorIndex), record.slice(separatorIndex + 1));
    }
    return map;
  }, [tabTitles]);

  // Замер идёт только пока панель открыта — фоновый опрос ради закрытой панели
  // был бы тратой без адресата.
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

  const { majorTabs, minorTabs } = useMemo(() => {
    const tabs = [...(metrics?.projectTabs || [])];
    tabs.sort((a, b) => mode === 'memory'
      ? b.totalBytes - a.totalBytes
      : (b.totalCpu || 0) - (a.totalCpu || 0));

    // В режиме нагрузки порог по памяти неуместен: простаивающая вкладка
    // интересна ровно тем, что она простаивает.
    if (mode === 'cpu') return { majorTabs: tabs, minorTabs: [] as TabGroup[] };

    return {
      majorTabs: tabs.filter(tab => tab.totalBytes >= MINOR_TAB_LIMIT_BYTES),
      minorTabs: tabs.filter(tab => tab.totalBytes < MINOR_TAB_LIMIT_BYTES),
    };
  }, [metrics, mode]);

  const [showMinor, setShowMinor] = useState(false);
  const minorBytes = useMemo(
    () => minorTabs.reduce((total, tab) => total + tab.totalBytes, 0),
    [minorTabs],
  );
  const projectTabs = showMinor ? [...majorTabs, ...minorTabs] : majorTabs;

  const totalBytes = (metrics?.totals?.projectBytes || 0)
    + (metrics?.app?.totalBytes || 0)
    + (metrics?.totals?.otherBytes || 0)
    + (metrics?.orphans?.totalBytes || 0);

  const orphanCount = metrics?.orphans?.count || 0;
  const chipValue = metrics?.ok ? formatBytes(totalBytes) : '—';

  const valueOf = (bytes: number, cpu: number | null) =>
    mode === 'memory' ? formatBytes(bytes) : formatCpu(cpu);

  return (
    <>
      <Tooltip content="Потребление ресурсов: вкладки, их инструменты и само приложение">
        <button
          ref={buttonRef}
          onClick={() => setOpen(value => !value)}
          className="flex h-[22px] items-center gap-1 rounded-md px-1.5 text-[11px] transition-colors cursor-pointer"
          style={{
            border: '1px solid ' + (open ? 'rgba(56,189,248,0.28)' : 'rgba(255,255,255,0.10)'),
            background: open ? 'rgba(56,189,248,0.13)' : 'rgba(255,255,255,0.04)',
            color: open ? '#bae6fd' : '#aaa',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          <Activity size={11} />
          {/* Место под число зарезервировано ЗАРАНЕЕ, а не подгоняется под
              текущее значение: кнопка стоит в ряду других, и когда число
              меняется каждые пару секунд («980 МБ» → «1.02 ГБ»), меняющаяся
              ширина двигает всё, что справа. Ширина берётся от самой длинной
              подписи, какая тут вообще бывает — «99.99 ГБ». */}
          <span
            style={{
              display: 'inline-flex',
              justifyContent: 'flex-end',
              minWidth: RESOURCE_CHIP_VALUE_WIDTH_CH,
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

              <div style={{ overflowY: 'auto', padding: '6px 0' }}>
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

                    <SectionTitle>Вкладки проекта</SectionTitle>
                    {projectTabs.length === 0 && minorTabs.length === 0 && (
                      <EmptyRow>нет активных вкладок</EmptyRow>
                    )}
                    {projectTabs.map(group => {
                      const isExpanded = expanded.has(group.tabId);
                      const canExpand = group.tools.length > 0 || group.otherBytes > 0;
                      return (
                        <div key={group.tabId}>
                          <button
                            onClick={() => canExpand && toggleExpanded(group.tabId)}
                            style={{
                              width: '100%',
                              display: 'flex',
                              alignItems: 'center',
                              gap: 6,
                              padding: '5px 10px',
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
                            <span style={{
                              flex: 1,
                              minWidth: 0,
                              fontSize: 11,
                              color: group.alive ? '#ddd' : '#777',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}>
                              {tabLabel(group, titleByTabId.get(group.tabId))}
                              {!group.alive && <span style={{ color: '#666' }}> · завершена</span>}
                              {group.sharedWithOtherTab && <span style={{ color: '#666' }}> · учтено выше</span>}
                            </span>
                            <span style={{ fontSize: 11, color: '#ddd', fontVariantNumeric: 'tabular-nums' }}>
                              {valueOf(group.totalBytes, group.totalCpu)}
                            </span>
                          </button>

                          {isExpanded && (
                            <div style={{ padding: '0 10px 6px 28px' }}>
                              <DetailRow
                                label="сама сессия"
                                value={valueOf(group.selfBytes, group.selfCpu)}
                              />
                              {group.tools.map(tool => (
                                <DetailRow
                                  key={tool.pid}
                                  label={tool.label}
                                  value={valueOf(tool.bytes, tool.cpu)}
                                />
                              ))}
                              {group.otherBytes > 0 && (
                                <DetailRow label="прочее" value={formatBytes(group.otherBytes)} muted />
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}

                    {minorTabs.length > 0 && (
                      <button
                        onClick={() => setShowMinor(value => !value)}
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
                          {showMinor ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                        </span>
                        <span style={{ flex: 1, fontSize: 11, color: '#777' }}>
                          неактивные вкладки ({minorTabs.length})
                        </span>
                        <span style={{ fontSize: 11, color: '#888', fontVariantNumeric: 'tabular-nums' }}>
                          {formatBytes(minorBytes)}
                        </span>
                      </button>
                    )}

                    <SectionTitle>Общее для приложения</SectionTitle>
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

                    {(metrics.otherTabs || []).length > 0 && (
                      <>
                        <SectionTitle>Другие проекты</SectionTitle>
                        <div style={{ display: 'flex', padding: '4px 10px 4px 28px', gap: 8 }}>
                          <span style={{ flex: 1, fontSize: 11, color: '#888' }}>
                            вкладок: {metrics.otherTabs!.length}
                          </span>
                          <span style={{ fontSize: 11, color: '#999', fontVariantNumeric: 'tabular-nums' }}>
                            {formatBytes(metrics.totals?.otherBytes || 0)}
                          </span>
                        </div>
                      </>
                    )}
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

const SectionTitle: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{
    padding: '8px 10px 4px',
    fontSize: 9,
    textTransform: 'uppercase',
    fontWeight: 700,
    color: '#666',
    letterSpacing: '0.05em',
  }}>
    {children}
  </div>
);

const EmptyRow: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ padding: '4px 10px 4px 28px', fontSize: 11, color: '#666' }}>{children}</div>
);

const DetailRow: React.FC<{ label: string; value: string; muted?: boolean }> = ({ label, value, muted }) => (
  <div style={{ display: 'flex', gap: 8, padding: '3px 0' }}>
    <span style={{ flex: 1, fontSize: 10.5, color: muted ? '#666' : '#8a8a8a' }}>{label}</span>
    <span style={{ fontSize: 10.5, color: muted ? '#777' : '#999', fontVariantNumeric: 'tabular-nums' }}>{value}</span>
  </div>
);

export default ResourceUsageButton;
