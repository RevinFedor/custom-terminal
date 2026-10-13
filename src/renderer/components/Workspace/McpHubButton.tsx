import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Server, RotateCw, Cloud, Terminal, Puzzle, Loader2 } from 'lucide-react';
import Tooltip from '../UI/Tooltip';
import { externalMcpServers, mcpCatalogErrorMessage } from '../../utils/mcpCatalogPresentation.mjs';

const { ipcRenderer } = window.require('electron');

const Portal: React.FC<{ children: React.ReactNode }> = ({ children }) =>
  createPortal(children, document.body);

type HubServer = {
  name: string;
  up: boolean;
  pid: number | null;
  startedAt: number | null;
  restarts: number;
  lastExit: { code: number | null; signal: string | null; at: number } | null;
  lastError: string | null;
  pendingRequests: number;
  initialized: boolean;
  recovering?: boolean;
};

type HubStatus = {
  port?: number;
  pid?: number;
  servers?: HubServer[];
  clients?: { tabId: string; lastSeen: number }[];
  down?: boolean;
};

type CodexMcpServer = {
  id: string;
  name: string;
  enabled: boolean;
  source: 'config' | 'plugin';
  pluginName?: string;
  transport: 'http' | 'stdio' | 'plugin' | 'unknown';
  address: string | null;
  hubServer: string | null;
};

type CodexMcpCatalog = {
  servers: CodexMcpServer[];
  fetchedAt: string | null;
  stale: boolean;
  error: string | null;
};

function formatUptime(startedAt: number | null): string {
  if (!startedAt) return '—';
  const sec = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  if (sec < 60) return sec + 'с';
  if (sec < 3600) return Math.floor(sec / 60) + 'м';
  if (sec < 86400) return Math.floor(sec / 3600) + 'ч ' + Math.floor((sec % 3600) / 60) + 'м';
  return Math.floor(sec / 86400) + 'д';
}

// Чип статуса общего MCP-бэкенда (хаба): зелёная точка — все шесть серверов
// живы, янтарная — часть упала, красная — хаб недоступен. Панель показывает
// каждый сервер с аптаймом и кнопкой рестарта. Опрос идёт только пока панель
// открыта (или раз в 30с для цвета точки — дешёвый fetch статуса).
const McpHubButton: React.FC<{ cwd?: string | null }> = ({ cwd = null }) => {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<HubStatus | null>(null);
  const [restarting, setRestarting] = useState<string | null>(null);
  const [restartError, setRestartError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<CodexMcpCatalog | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const catalogScopeRef = useRef<string | null>(cwd);
  const restartInFlight = useRef(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelPos, setPanelPos] = useState<{ top: number; right: number } | null>(null);

  const refresh = useCallback(() => {
    ipcRenderer.invoke('mcp-hub:status')
      .then((st: HubStatus) => setStatus(st))
      .catch(() => setStatus({ down: true }));
  }, []);

  // Редкий фоновый опрос для цвета точки; частый — только при открытой панели.
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, open ? 3000 : 30000);
    return () => clearInterval(id);
  }, [open, refresh]);

  useEffect(() => {
    if (catalogScopeRef.current !== cwd) {
      catalogScopeRef.current = cwd;
      setCatalog(null);
    }
    if (!open) return;
    let cancelled = false;
    let reading = false;
    const read = async () => {
      if (reading) return;
      reading = true;
      setCatalogLoading(true);
      try {
        const next = await ipcRenderer.invoke('mcp-hub:codex-catalog', { cwd });
        if (!cancelled) setCatalog(next);
      } catch {
        if (!cancelled) setCatalog(previous => ({ servers: previous?.servers || [],
          fetchedAt: previous?.fetchedAt || null, stale: true, error: 'catalog_unavailable' }));
      } finally {
        reading = false;
        if (!cancelled) setCatalogLoading(false);
      }
    };
    void read();
    const timer = setInterval(read, 3000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [open, cwd]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (buttonRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  useEffect(() => {
    if (!open || !buttonRef.current) { setPanelPos(null); return; }
    const rect = buttonRef.current.getBoundingClientRect();
    setPanelPos({ top: rect.bottom + 6, right: Math.max(8, window.innerWidth - rect.right) });
  }, [open]);

  const servers = status?.servers || [];
  const visibleCatalog = catalogScopeRef.current === cwd ? catalog : null;
  const externalServers: CodexMcpServer[] = externalMcpServers(visibleCatalog);
  const isReady = (server: HubServer) => server.up && server.initialized && !server.recovering;
  const readyCount = servers.filter(isReady).length;
  const allUp = !status?.down && servers.length > 0 && readyCount === servers.length;
  const dotColor = status?.down || readyCount === 0
    ? '#f87171'
    : allUp ? '#4ade80' : '#fbbf24';

  const restart = async (name?: string) => {
    if (restartInFlight.current) return;
    restartInFlight.current = true;
    setRestarting(name || '__hub__');
    setRestartError(null);
    try {
      const result = await ipcRenderer.invoke(name ? 'mcp-hub:restart-server' : 'mcp-hub:restart-all', name);
      if (Array.isArray(result?.servers)) setStatus(previous => ({ ...previous, ...result, down: false }));
      if (result?.ok !== true) {
        const failures = result?.servers?.filter((server: HubServer) => !isReady(server))
          .map((server: HubServer) => server.name + ': ' + (server.lastError || 'не готов')).join('; ');
        setRestartError(result?.error || failures || 'Перезапуск не подтверждён');
      }
    } catch (error: any) {
      setRestartError(String(error?.message || error));
    } finally {
      restartInFlight.current = false;
      setRestarting(null);
      refresh();
    }
  };

  return (
    <>
      <Tooltip content="Общий MCP-хаб и внешние подключения Codex">
        <button
          ref={buttonRef}
          aria-label="Статус MCP-хаба"
          onClick={() => setOpen(v => !v)}
          className="flex h-[26px] items-center gap-1 rounded-md px-1.5 text-[11px] transition-colors cursor-pointer"
          style={{
            border: '1px solid ' + (open ? 'rgba(56,189,248,0.28)' : 'rgba(255,255,255,0.10)'),
            background: open ? 'rgba(56,189,248,0.13)' : 'rgba(255,255,255,0.04)',
            color: open ? '#bae6fd' : '#aaa',
            flexShrink: 0,
            whiteSpace: 'nowrap',
          }}
          onMouseEnter={(e) => {
            if (open) return;
            e.currentTarget.style.background = 'rgba(255,255,255,0.10)';
            e.currentTarget.style.borderColor = 'rgba(255,255,255,0.22)';
            e.currentTarget.style.color = '#e4e4e7';
          }}
          onMouseLeave={(e) => {
            if (open) return;
            e.currentTarget.style.background = 'rgba(255,255,255,0.04)';
            e.currentTarget.style.borderColor = 'rgba(255,255,255,0.10)';
            e.currentTarget.style.color = '#aaa';
          }}
        >
          <Server size={12} />
          <span
            className="inline-block h-[7px] w-[7px] rounded-full"
            style={{ background: dotColor }}
          />
        </button>
      </Tooltip>

      {open && panelPos && (
        <Portal>
          <div
            ref={panelRef}
            // mousedown+click stopPropagation: панель живёт под click-outside
            // родителей; см. сценарии-багов-design.md::4.6
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            className="fixed z-[9999] w-[340px] rounded-lg border p-2.5 text-[12px] shadow-2xl"
            style={{
              top: panelPos.top,
              right: panelPos.right,
              background: 'rgba(24,24,27,0.98)',
              borderColor: 'rgba(255,255,255,0.12)',
              color: '#d4d4d8',
              maxHeight: 'min(560px, calc(100vh - 80px))',
              overflowY: 'auto',
            }}
          >
            <div className="mb-2 flex items-center justify-between">
              <div className="font-medium" style={{ color: '#e4e4e7' }}>
                MCP-хаб {status?.down ? '· недоступен' : '· порт ' + (status?.port ?? '?')}
              </div>
              <div className="text-[11px]" style={{ color: '#71717a' }}>
                {status?.down ? '' : readyCount + '/' + servers.length}
              </div>
            </div>

            {status?.down && (
              <div className="mb-2 rounded-md border p-2 text-[11px]"
                style={{ borderColor: 'rgba(248,113,113,0.35)', background: 'rgba(248,113,113,0.08)', color: '#fca5a5' }}>
                Хаб не отвечает. MCP-инструменты недоступны до восстановления.
              </div>
            )}

            <button
              className="mb-2 flex items-center gap-1.5 rounded px-2 py-1 text-[11px] cursor-pointer"
              style={{ border: '1px solid rgba(56,189,248,0.3)', color: '#bae6fd', opacity: restarting ? 0.65 : 1 }}
              disabled={restarting !== null}
              onClick={() => restart()}
            >
              <RotateCw size={12} className={restarting === '__hub__' ? 'animate-spin' : ''} />
              {restarting === '__hub__' ? 'Перезапускаю хаб…' : status?.down ? 'Восстановить хаб' : 'Перезапустить MCP хаба'}
            </button>
            {restartError && (
              <div role="alert" className="mb-2 rounded border p-2 text-[11px] break-words"
                style={{ color: '#fca5a5', borderColor: 'rgba(248,113,113,0.3)' }}>
                {restartError}
              </div>
            )}

            {servers.map((s) => (
              <div key={s.name} className="flex items-center gap-2 rounded px-1 py-[3px]"
                style={{ opacity: isReady(s) ? 1 : 0.75 }}>
                <span className="inline-block h-[7px] w-[7px] flex-none rounded-full"
                  style={{ background: s.recovering ? '#fbbf24' : isReady(s) ? '#4ade80' : '#f87171' }} />
                <span className="w-[92px] flex-none font-mono text-[11px]" style={{ color: '#e4e4e7' }}>
                  {s.name}
                </span>
                <span className="flex-1 truncate text-[11px]" title={s.lastError || undefined} style={{ color: '#71717a' }}>
                  {s.recovering
                    ? 'восстанавливается · запросов: ' + s.pendingRequests
                    : isReady(s)
                    ? 'pid ' + s.pid + ' · ' + formatUptime(s.startedAt) + (s.restarts > 0 ? ' · рестартов: ' + s.restarts : '')
                    : (s.lastError || 'остановлен')}
                </span>
                <Tooltip content={'Перезапустить ' + s.name}>
                  <button
                    className="flex-none rounded p-1 cursor-pointer"
                    style={{ color: restarting === s.name ? '#38bdf8' : '#71717a' }}
                    disabled={restarting !== null}
                    aria-label={'Перезапустить ' + s.name}
                    onClick={() => restart(s.name)}
                    onMouseEnter={(e) => { e.currentTarget.style.color = '#e4e4e7'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.color = restarting === s.name ? '#38bdf8' : '#71717a'; }}
                  >
                    <RotateCw size={12} className={restarting === s.name ? 'animate-spin' : ''} />
                  </button>
                </Tooltip>
              </div>
            ))}

            {!status?.down && (
              <div className="mt-2 border-t pt-1.5 text-[11px]" style={{ borderColor: 'rgba(255,255,255,0.08)', color: '#71717a' }}>
                Активных клиентов-вкладок: {status?.clients?.length ?? 0}
              </div>
            )}

            <section className="mt-2 border-t pt-2" aria-label="Внешние MCP Codex"
              style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
              <div className="mb-1 flex items-center gap-1.5 text-[11px]" style={{ color: '#a1a1aa' }}>
                <span title={cwd || undefined}>Codex · конфигурация</span>
                {catalogLoading && !visibleCatalog && <Loader2 size={11} className="animate-spin noted-infinite-animation" />}
              </div>
              {visibleCatalog?.error && (
                <div role="status" className="mb-1 text-[11px]" style={{ color: '#fbbf24' }}>
                  {mcpCatalogErrorMessage(visibleCatalog.error)}
                </div>
              )}
              {externalServers.map(server => {
                const Icon = server.transport === 'http' ? Cloud : server.source === 'plugin' ? Puzzle : Terminal;
                return (
                  <div key={server.id} className="flex items-center gap-2 rounded px-1 py-[3px]"
                    style={{ opacity: server.enabled ? 1 : 0.6 }}
                    title={[server.address, server.pluginName ? 'Плагин: ' + server.pluginName : null].filter(Boolean).join(' · ')}>
                    <Icon size={12} className="flex-none" style={{ color: '#71717a' }} />
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px]" style={{ color: '#e4e4e7' }}>{server.name}</span>
                    <span className="flex-none text-[11px]" style={{ color: '#71717a' }}>
                      {server.enabled ? 'настроен' : 'отключён'}
                    </span>
                  </div>
                );
              })}
              {visibleCatalog && !visibleCatalog.error && !externalServers.length && (
                <div className="px-1 py-1 text-[11px]" style={{ color: '#71717a' }}>Нет внешних MCP</div>
              )}
              <div className="mt-1 text-[10px]" style={{ color: '#71717a' }}>
                Активные подключения вкладки: /mcp
              </div>
            </section>
          </div>
        </Portal>
      )}
    </>
  );
};

export default McpHubButton;
