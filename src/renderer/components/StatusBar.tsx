import React, { useRef, useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Settings } from 'lucide-react';
import { useUIStore } from '../store/useUIStore';
import type { ClaudeCodeModelOption } from '../store/useUIStore';
import type { CodexModelOption } from '../constants/codexSettings';
import {
  CODEX_EFFORT_LEVELS,
  DEFAULT_CODEX_EFFORT,
  DEFAULT_CODEX_MODEL_OPTIONS,
  normalizeCodexModelOptions,
} from '../constants/codexSettings';
import { usePromptsStore } from '../store/usePromptsStore';
import { useCmdKey } from '../hooks/useCmdHoverPopover';

const { ipcRenderer } = window.require('electron');

// VSCode-style status bar pinned to the bottom of the app.
// Currently hosts development toggles, a default-effort selector,
// an invalid-paths counter for AI prompt attachments, and a settings cog.
// Will grow to include git/branch/lints/etc.
// Right side is reserved for less-frequent toggles (debug, defaults).
interface StatusBarProps {
  onOpenSettings?: () => void;
}

export default function StatusBar({ onOpenSettings }: StatusBarProps) {
  const debugHoverBridges = useUIStore((s) => s.debugHoverBridges);
  const setDebugHoverBridges = useUIStore((s) => s.setDebugHoverBridges);
  const freezeCmdPopups = useUIStore((s) => s.freezeCmdPopups);
  const setFreezeCmdPopups = useUIStore((s) => s.setFreezeCmdPopups);
  const freePortsBeforeStart = useUIStore((s) => s.freePortsBeforeStart);
  const setFreePortsBeforeStart = useUIStore((s) => s.setFreePortsBeforeStart);
  const defaultClaudeEffort = useUIStore((s) => s.defaultClaudeEffort);
  const setDefaultClaudeEffort = useUIStore((s) => s.setDefaultClaudeEffort);
  const defaultClaudeModel = useUIStore((s) => s.defaultClaudeModel);
  const setDefaultClaudeModel = useUIStore((s) => s.setDefaultClaudeModel);
  const claudeCodeSettings = useUIStore((s) => s.claudeCodeSettings);
  const defaultCodexModel = useUIStore((s) => s.defaultCodexModel);
  const setDefaultCodexModel = useUIStore((s) => s.setDefaultCodexModel);
  const defaultCodexEffort = useUIStore((s) => s.defaultCodexEffort);
  const setDefaultCodexEffort = useUIStore((s) => s.setDefaultCodexEffort);
  const [codexModels, setCodexModels] = useState<CodexModelOption[]>(DEFAULT_CODEX_MODEL_OPTIONS);

  useEffect(() => {
    let cancelled = false;
    ipcRenderer.invoke('codex:list-models').then((res: any) => {
      if (cancelled) return;
      setCodexModels(normalizeCodexModelOptions(res?.models));
    }).catch(() => {
      if (!cancelled) setCodexModels(DEFAULT_CODEX_MODEL_OPTIONS);
    });
    return () => { cancelled = true; };
  }, []);

  const activeCodexModel = codexModels.find((m) => m.id === defaultCodexModel) || codexModels[0];
  const codexEfforts = activeCodexModel?.efforts?.length ? activeCodexModel.efforts : [...CODEX_EFFORT_LEVELS];
  const setDefaultCodexModelWithEffort = (model: string) => {
    setDefaultCodexModel(model);
    if (model === 'none' || defaultCodexEffort === 'none') return;
    const nextModel = codexModels.find((m) => m.id === model);
    const efforts = nextModel?.efforts?.length ? nextModel.efforts : [...CODEX_EFFORT_LEVELS];
    if (efforts.includes(defaultCodexEffort)) return;
    const fallback = (nextModel?.defaultEffort && efforts.includes(nextModel.defaultEffort))
      ? nextModel.defaultEffort
      : (efforts.includes(DEFAULT_CODEX_EFFORT) ? DEFAULT_CODEX_EFFORT : efforts[0]);
    if (fallback) setDefaultCodexEffort(fallback);
  };

  return (
    <div
      className="flex items-center justify-between select-none border-t border-[#222] bg-[#1a1a1a]"
      style={{
        height: 24,
        flexShrink: 0,
        color: '#888',
        paddingLeft: 6,
        paddingRight: 6,
        fontSize: 12,
      }}
    >
      <div className="flex items-center gap-3">
        <WebServerChip />
      </div>
      <div className="flex items-center gap-2">
        <ModelSelector label="Claude" value={defaultClaudeModel} options={claudeCodeSettings.models} onChange={setDefaultClaudeModel} />
        <EffortSelector label="Effort" value={defaultClaudeEffort} options={claudeCodeSettings.efforts} onChange={setDefaultClaudeEffort} />
        <ModelSelector label="Codex" value={defaultCodexModel} options={codexModels} onChange={setDefaultCodexModelWithEffort} />
        <EffortSelector label="Effort" value={defaultCodexEffort} options={codexEfforts} onChange={setDefaultCodexEffort} />
        <StatusToggle
          label="kill dev-ports"
          title="Если ВКЛ — перед каждым запуском npm-скрипта / restart / stop сначала убиваются занятые порты проекта (vite/backend), считанные из vite.config / .env / NestJS main.ts. Защита от 'address in use' после крашей."
          active={freePortsBeforeStart}
          onClick={() => setFreePortsBeforeStart(!freePortsBeforeStart)}
          activeColor="#4ade80"
        />
        <StatusToggle
          label="bridges"
          title="Подсвечивать невидимые «hover-мосты» между триггером и popup'ом красным цветом."
          active={debugHoverBridges}
          onClick={() => setDebugHoverBridges(!debugHoverBridges)}
          activeColor="#ef4444"
        />
        <InvalidPathsChip onOpenSettings={onOpenSettings} />
        <StatusToggle
          label="freeze tooltips"
          title="ВКЛ: Cmd-tooltip / note / fork popup'ы НЕ закрываются при уходе курсора и отпускании Cmd — для инспекции их DOM в devtools."
          active={freezeCmdPopups}
          onClick={() => setFreezeCmdPopups(!freezeCmdPopups)}
          activeColor="#fbbf24"
        />
        <SettingsButton onClick={onOpenSettings} />
      </div>
    </div>
  );
}

// Counter of broken file paths attached to AI prompts (+ doc-prompt file, if it's used).
// Subscribes to usePromptsStore so it recomputes on save/delete; rechecks disk via
// `ai-prompts:check-paths` IPC with a 300ms debounce. Click → opens Settings (caller
// can route to the AI tab; we just open the modal for now).
function InvalidPathsChip({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const prompts = usePromptsStore((s) => s.prompts);
  const isLoaded = usePromptsStore((s) => s.isLoaded);
  const docPrompt = useUIStore((s) => s.docPrompt);
  const [missing, setMissing] = useState<string[]>([]);

  // Flat list of every absolute path we care about (prompts × filePaths + docPrompt.filePath
  // if useFile is on). useMemo with JSON serialization gives a stable string dependency for
  // useEffect — Zustand returns new array references on every set, but the actual content
  // changes rarely. This avoids re-running the check on unrelated store mutations.
  const allPathsKey = useMemo(() => {
    const paths: string[] = [];
    for (const p of prompts) {
      if (Array.isArray(p.filePaths)) {
        for (const fp of p.filePaths) if (typeof fp === 'string' && fp.trim()) paths.push(fp);
      }
    }
    if (docPrompt?.useFile && docPrompt.filePath?.trim()) paths.push(docPrompt.filePath);
    return JSON.stringify(paths);
  }, [prompts, docPrompt]);

  useEffect(() => {
    if (!isLoaded) return;
    let cancelled = false;
    const paths: string[] = JSON.parse(allPathsKey);
    if (paths.length === 0) { setMissing([]); return; }
    const t = setTimeout(async () => {
      try {
        const res = await ipcRenderer.invoke('ai-prompts:check-paths', paths);
        if (!cancelled && res?.success) setMissing(res.missing || []);
      } catch (e) {
        if (!cancelled) setMissing([]);
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [allPathsKey, isLoaded]);

  if (missing.length === 0) return null;

  return (
    <button
      onClick={onOpenSettings}
      className="inline-flex items-center cursor-pointer rounded"
      style={{
        gap: 4,
        padding: '0 8px',
        height: 20,
        backgroundColor: 'rgba(218, 119, 86, 0.12)',
        color: '#DA7756',
        fontVariantNumeric: 'tabular-nums',
        fontWeight: 600,
        border: 'none',
        outline: 'none',
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'rgba(218, 119, 86, 0.22)'; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'rgba(218, 119, 86, 0.12)'; }}
    >
      <span style={{ fontSize: 13, lineHeight: 1 }}>!</span>
      <span style={{ fontSize: 12 }}>{missing.length}</span>
    </button>
  );
}

function SettingsButton({ onClick }: { onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-label="Settings"
      className="inline-flex items-center justify-center cursor-pointer rounded"
      style={{
        width: 22,
        height: 20,
        padding: 0,
        background: 'transparent',
        color: '#bbb',
        border: 'none',
        outline: 'none',
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#fff'; (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.08)'; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#bbb'; (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
    >
      <Settings size={14} strokeWidth={1.75} />
    </button>
  );
}

const effortLabel = (level: string): string => {
  if (level === 'minimal') return 'min';
  if (level === 'medium') return 'med';
  if (level === 'xhigh') return 'xhi';
  if (level === 'ultracode') return 'ultra';
  return level;
};

const modelLabel = (model: string, options: Array<{ id: string; label?: string }>): string => {
  if (model === 'none') return 'none';
  const found = options.find((m) => m.id === model);
  return found?.label || model;
};

function ModelSelector({ label = 'Model', value, options, onChange }: {
  label?: string;
  value: string;
  options: Array<{ id: string; label?: string }>;
  onChange: (v: string) => void;
}) {
  const [clicked, setClicked] = useState(false);
  const [chipHover, setChipHover] = useState(false);
  const [popupHover, setPopupHover] = useState(false);
  const chipRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const isCmdPressed = useCmdKey();
  const open = clicked || (isCmdPressed && chipHover) || popupHover;

  useEffect(() => {
    if (!clicked) return;
    const onDown = (e: MouseEvent) => {
      if (chipRef.current?.contains(e.target as Node)) return;
      if (popupRef.current?.contains(e.target as Node)) return;
      setClicked(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [clicked]);

  useEffect(() => {
    if (!open) return;
    const onMove = (e: MouseEvent) => {
      const c = chipRef.current?.getBoundingClientRect();
      const p = popupRef.current?.getBoundingClientRect();
      if (!c || !p) return;
      const { clientX: x, clientY: y } = e;
      const inC = x >= c.left && x <= c.right && y >= c.top && y <= c.bottom;
      const inP = x >= p.left && x <= p.right && y >= p.top && y <= p.bottom;
      const inBridge =
        x >= Math.min(p.left, c.left) - 8 &&
        x <= Math.max(p.right, c.right) + 8 &&
        y >= p.bottom &&
        y <= c.top;
      setChipHover(inC);
      setPopupHover(inP || inBridge);
    };
    document.addEventListener('mousemove', onMove);
    return () => document.removeEventListener('mousemove', onMove);
  }, [open]);

  return (
    <>
      <button
        ref={chipRef}
        onClick={() => setClicked(!clicked)}
        onMouseEnter={() => setChipHover(true)}
        onMouseLeave={() => setChipHover(false)}
        className="inline-flex items-center gap-1 cursor-pointer hover:bg-white/5 rounded"
        style={{ padding: '1px 6px', height: 18 }}
      >
        <span style={{ color: '#666' }}>{label}:</span>
        <span style={{ color: value === 'none' ? '#666' : '#DA7756', fontWeight: 500 }}>
          {modelLabel(value, options)}
        </span>
      </button>
      {open && chipRef.current && createPortal(
        <ModelPopup
          chipRect={chipRef.current.getBoundingClientRect()}
          popupRef={popupRef}
          value={value}
          options={options}
          onSelect={(v) => { onChange(v); setClicked(false); setPopupHover(false); }}
          onPopupEnter={() => setPopupHover(true)}
          onPopupLeave={() => setPopupHover(false)}
        />,
        document.body
      )}
    </>
  );
}

function ModelPopup({ chipRect, popupRef, value, options, onSelect, onPopupEnter, onPopupLeave }: {
  chipRect: DOMRect;
  popupRef: React.RefObject<HTMLDivElement | null>;
  value: string;
  options: Array<{ id: string; label?: string; cmd?: boolean }>;
  onSelect: (v: string) => void;
  onPopupEnter?: () => void;
  onPopupLeave?: () => void;
}) {
  const models = useMemo(() => {
    const base: ClaudeCodeModelOption[] = [{ id: 'none', label: 'none', cmd: true }, ...options.filter((m) => m?.id)];
    return base.some((m) => m.id === value) ? base : [...base, { id: value, label: value, cmd: true }];
  }, [options, value]);

  return (
    <div
      ref={popupRef}
      onMouseEnter={onPopupEnter}
      onMouseLeave={onPopupLeave}
      style={{
        position: 'fixed',
        right: window.innerWidth - chipRect.right,
        bottom: window.innerHeight - chipRect.top + 4,
        paddingBottom: 4,
        zIndex: 10010,
      }}
    >
      <div
        className="flex gap-1 bg-[#1a1a1a] border border-[#444] rounded shadow-2xl"
        style={{ padding: 4, boxShadow: '0 -8px 24px rgba(0,0,0,0.5)' }}
      >
        {models.map((model) => {
          const isActive = value === model.id;
          return (
            <button
              key={model.id}
              onClick={() => onSelect(isActive ? 'none' : model.id)}
              className={`text-[10px] px-1.5 py-1 rounded cursor-pointer ${
                isActive
                  ? 'bg-[#DA7756]/20 text-white font-medium'
                  : 'bg-[#2d2d2d] text-[#888] hover:text-white hover:bg-[#3d3d3d]'
              }`}
              style={{ minWidth: 44 }}
              title={model.id}
            >
              {model.label || model.id}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Same visual language as InfoPanel Effort buttons: small pills, accent for active.
// Status-bar version is a single chip showing the current effort, click → popup with all
// six levels appearing ABOVE (status bar is at the bottom). One click selects + persists.
function EffortSelector({ label = 'Effort', value, options, onChange }: {
  label?: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  const [clicked, setClicked] = useState(false);     // pinned via click
  const [chipHover, setChipHover] = useState(false); // mouse over chip
  const [popupHover, setPopupHover] = useState(false); // mouse over popup
  const chipRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const isCmdPressed = useCmdKey();

  // Popup is visible when:
  //   • user clicked the chip (pinned)            → stays until click outside
  //   • CMD held + cursor over chip               → standard CMD-hover affordance
  //   • cursor over the popup itself              → keeps open after releasing CMD
  const open = clicked || (isCmdPressed && chipHover) || popupHover;

  // Close pinned-open on outside click (only when actually clicked open)
  useEffect(() => {
    if (!clicked) return;
    const onDown = (e: MouseEvent) => {
      if (chipRef.current?.contains(e.target as Node)) return;
      if (popupRef.current?.contains(e.target as Node)) return;
      setClicked(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [clicked]);

  // Geometric hit-test bridge: when the popup is open via CMD-hover, the cursor
  // crossing the 4-px gap between chip and popup must not close it. Padding alone
  // is unreliable across two Portal-rendered elements, so use mousemove + rect.
  useEffect(() => {
    if (!open) return;
    const onMove = (e: MouseEvent) => {
      const c = chipRef.current?.getBoundingClientRect();
      const p = popupRef.current?.getBoundingClientRect();
      if (!c || !p) return;
      const { clientX: x, clientY: y } = e;
      const inC = x >= c.left && x <= c.right && y >= c.top && y <= c.bottom;
      const inP = x >= p.left && x <= p.right && y >= p.top && y <= p.bottom;
      // Bridge: vertical corridor between popup.bottom and chip.top (popup is ABOVE).
      const inBridge =
        x >= Math.min(p.left, c.left) - 8 &&
        x <= Math.max(p.right, c.right) + 8 &&
        y >= p.bottom &&
        y <= c.top;
      // Update hover flags from the actual cursor position. This lets the popup
      // survive: cursor on chip OR popup OR bridge → at least one of {chipHover,
      // popupHover, isCmdPressed} keeps `open` true on the next render.
      setChipHover(inC);
      setPopupHover(inP || inBridge);
    };
    document.addEventListener('mousemove', onMove);
    return () => document.removeEventListener('mousemove', onMove);
  }, [open]);

  return (
    <>
      <button
        ref={chipRef}
        onClick={() => setClicked(!clicked)}
        onMouseEnter={() => setChipHover(true)}
        onMouseLeave={() => setChipHover(false)}
        className="inline-flex items-center gap-1 cursor-pointer hover:bg-white/5 rounded"
        style={{ padding: '1px 6px', height: 18 }}
      >
        <span style={{ color: '#666' }}>{label}:</span>
        <span style={{ color: value === 'none' ? '#666' : '#DA7756', fontWeight: 500 }}>
          {effortLabel(value)}
        </span>
      </button>
      {open && chipRef.current && createPortal(
        <EffortPopup
          chipRect={chipRef.current.getBoundingClientRect()}
          popupRef={popupRef}
          value={value}
          options={options}
          onSelect={(v) => { onChange(v); setClicked(false); setPopupHover(false); }}
          onPopupEnter={() => setPopupHover(true)}
          onPopupLeave={() => setPopupHover(false)}
        />,
        document.body
      )}
    </>
  );
}

function EffortPopup({ chipRect, popupRef, value, options, onSelect, onPopupEnter, onPopupLeave }: {
  chipRect: DOMRect;
  popupRef: React.RefObject<HTMLDivElement | null>;
  value: string;
  options: string[];
  onSelect: (v: string) => void;
  onPopupEnter?: () => void;
  onPopupLeave?: () => void;
}) {
  const levels = useMemo(() => {
    const base = ['none', ...options.filter(Boolean)];
    return base.includes(value) ? base : [...base, value];
  }, [options, value]);

  return (
    <div
      ref={popupRef}
      onMouseEnter={onPopupEnter}
      onMouseLeave={onPopupLeave}
      style={{
        position: 'fixed',
        // Anchor RIGHT edge of popup to RIGHT edge of chip. The chip lives in the right-
        // hand cluster of the status bar; left-anchoring pushes the popup into the
        // Timeline strip / sidebar on the right and gets clipped.
        right: window.innerWidth - chipRect.right,
        bottom: window.innerHeight - chipRect.top + 4,
        // paddingBottom acts as CSS-bridge: extends hit area downward to touch the chip,
        // so the cursor can travel up from chip into the popup without losing hover.
        paddingBottom: 4,
        zIndex: 10010,
      }}
    >
      <div
        className="flex gap-1 bg-[#1a1a1a] border border-[#444] rounded shadow-2xl"
        style={{ padding: 4, boxShadow: '0 -8px 24px rgba(0,0,0,0.5)' }}
      >
        {levels.map((level) => {
          const isActive = value === level;
          return (
            <button
              key={level}
              onClick={() => onSelect(isActive ? 'none' : level)}
              className={`text-[10px] px-1.5 py-1 rounded cursor-pointer ${
                isActive
                  ? 'bg-[#DA7756]/20 text-white font-medium'
                  : 'bg-[#2d2d2d] text-[#888] hover:text-white hover:bg-[#3d3d3d]'
              }`}
              style={{ minWidth: 32 }}
            >
              {effortLabel(level)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Mobile-web access chip. Pulls live info from main (web-server.js) on mount,
// shows the LAN URL as a clickable pill: click → opens in default OS browser
// (so you can scan the address visually then scribe it onto your phone).
// Right-click → copy full URL with token to clipboard.
function WebServerChip() {
  const [info, setInfo] = useState<{ running: boolean; lanIp?: string; port?: number; token?: string } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const { ipcRenderer } = window.require('electron');
        const data = await ipcRenderer.invoke('web:get-info');
        if (!cancelled) setInfo(data);
      } catch {
        if (!cancelled) setInfo({ running: false });
      }
    };
    load();
    // Re-poll occasionally so a late server start gets picked up without reload
    const t = setInterval(load, 5000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  if (!info) return null;
  if (!info.running) {
    return <span style={{ color: '#666', fontSize: 11 }}>web: off</span>;
  }

  // Prod (7878) → публичный домен через VPS-туннель; dev (7979 и любой другой) → локальный IP:port
  const isProd = info.port === 7878;
  const PUBLIC_HOST = 'remote-control.f9922.tech';
  const fullUrl = isProd
    ? `https://${PUBLIC_HOST}/?token=${info.token}`
    : `http://${info.lanIp}:${info.port}/?token=${info.token}`;
  const shortUrl = isProd ? PUBLIC_HOST : `local:${info.port}`;

  const handleClick = () => {
    try {
      const { ipcRenderer } = window.require('electron');
      ipcRenderer.invoke('web:open-in-browser');
    } catch {}
  };
  const handleRightClick = async (e: React.MouseEvent) => {
    e.preventDefault();
    try {
      const { clipboard } = window.require('electron');
      clipboard.writeText(fullUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  return (
    <button
      onClick={handleClick}
      onContextMenu={handleRightClick}
      className="inline-flex items-center gap-1 cursor-pointer hover:bg-white/5 rounded"
      style={{ padding: '1px 6px', height: 18 }}
    >
      <span
        style={{
          width: 8, height: 8, borderRadius: 4,
          backgroundColor: '#FFB382',
          boxShadow: '0 0 6px rgba(255, 178, 130, 0.5)',
        }}
      />
      <span style={{ color: copied ? '#a6e3a1' : '#ddd' }}>
        {copied ? 'copied!' : shortUrl}
      </span>
    </button>
  );
}

function StatusToggle({ label, title, active, onClick, activeColor = '#22c55e' }: {
  label: string;
  title?: string;
  active: boolean;
  onClick: () => void;
  activeColor?: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="inline-flex items-center gap-1 cursor-pointer hover:bg-white/5 rounded"
      style={{ padding: '1px 6px', height: 18 }}
    >
      <span
        style={{
          width: 8, height: 8, borderRadius: 4,
          backgroundColor: active ? activeColor : '#444',
          boxShadow: active ? `0 0 6px ${activeColor}` : 'none',
          transition: 'background-color 0.15s, box-shadow 0.15s',
        }}
      />
      <span style={{ color: active ? '#ddd' : '#666' }}>{label}</span>
    </button>
  );
}
