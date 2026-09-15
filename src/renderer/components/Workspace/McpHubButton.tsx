import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Server, RotateCw } from 'lucide-react';
import Tooltip from '../UI/Tooltip';

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
const McpHubButton: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<HubStatus | null>(null);
  const [restarting, setRestarting] = useState<string | null>(null);
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
  const isReady = (server: HubServer) => server.up && server.initialized && !server.recovering;
  const readyCount = servers.filter(isReady).length;
  const allUp = !status?.down && servers.length > 0 && readyCount === servers.length;
  const dotColor = status?.down || servers.length === 0
    ? '#f87171'
    : allUp ? '#4ade80' : '#fbbf24';

  const restartServer = async (name: string) => {
    setRestarting(name);
    try {
      await ipcRenderer.invoke('mcp-hub:restart-server', name);
    } finally {
      setRestarting(null);
      refresh();
    }
  };

  const ensureHub = async () => {
    setRestarting('__hub__');
    try {
      await ipcRenderer.invoke('mcp-hub:ensure');
    } finally {
      setRestarting(null);
      refresh();
    }
  };

  return (
    <>
      <Tooltip content="Общий MCP-бэкенд: один процесс каждого сервера на все AI-вкладки">
        <button
          ref={buttonRef}
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
                Хаб не отвечает. AI-вкладки работают через запасные stdio-копии.
                <button
                  className="mt-1.5 flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] cursor-pointer"
                  style={{ border: '1px solid rgba(248,113,113,0.4)', color: '#fecaca' }}
                  disabled={restarting === '__hub__'}
                  onClick={ensureHub}
                >
                  <RotateCw size={11} className={restarting === '__hub__' ? 'animate-spin' : ''} />
                  Запустить хаб
                </button>
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
                <span className="flex-1 truncate text-[11px]" style={{ color: '#71717a' }}>
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
                    onClick={() => restartServer(s.name)}
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
          </div>
        </Portal>
      )}
    </>
  );
};

export default McpHubButton;
