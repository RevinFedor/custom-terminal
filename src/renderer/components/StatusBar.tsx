import React, { useRef, useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useUIStore, DefaultClaudeEffort } from '../store/useUIStore';
import { CLAUDE_EFFORT_LEVELS_WITH_NONE, CLAUDE_EFFORT_LABELS } from '../constants/claudeLevels';
import { useCmdKey } from '../hooks/useCmdHoverPopover';
import Tooltip from './UI/Tooltip';

// VSCode-style status bar pinned to the bottom of the app.
// Currently hosts development toggles and a default-effort selector;
// will grow to include git/branch/lints/etc.
// Right side is reserved for less-frequent toggles (debug, defaults).
export default function StatusBar() {
  const debugHoverBridges = useUIStore((s) => s.debugHoverBridges);
  const setDebugHoverBridges = useUIStore((s) => s.setDebugHoverBridges);
  const freePortsBeforeStart = useUIStore((s) => s.freePortsBeforeStart);
  const setFreePortsBeforeStart = useUIStore((s) => s.setFreePortsBeforeStart);
  const defaultClaudeEffort = useUIStore((s) => s.defaultClaudeEffort);
  const setDefaultClaudeEffort = useUIStore((s) => s.setDefaultClaudeEffort);

  return (
    <div
      className="flex items-center justify-between select-none border-t border-[#222] bg-[#1a1a1a]"
      style={{
        height: 22,
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
        <EffortSelector value={defaultClaudeEffort} onChange={setDefaultClaudeEffort} />
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
      </div>
    </div>
  );
}

// Display order for the popup. Sourced from canonical list + 'none' sentinel.
// Effort values themselves ship from Anthropic — keep the actual list in
// constants/claudeLevels.ts so a Claude rev only touches one file.
const EFFORT_LEVELS: readonly DefaultClaudeEffort[] = CLAUDE_EFFORT_LEVELS_WITH_NONE;
const EFFORT_LABEL: Record<DefaultClaudeEffort, string> = {
  none: 'none',
  ...CLAUDE_EFFORT_LABELS,
};

// Same visual language as InfoPanel Effort buttons: small pills, accent for active.
// Status-bar version is a single chip showing the current effort, click → popup with all
// six levels appearing ABOVE (status bar is at the bottom). One click selects + persists.
function EffortSelector({ value, onChange }: {
  value: DefaultClaudeEffort;
  onChange: (v: DefaultClaudeEffort) => void;
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
      <Tooltip content="Default Claude effort (клик закрепит, ⌘+наведение откроет временно). 'none' = не подставлять.">
        <button
          ref={chipRef}
          onClick={() => setClicked(!clicked)}
          onMouseEnter={() => setChipHover(true)}
          onMouseLeave={() => setChipHover(false)}
          className="inline-flex items-center gap-1 cursor-pointer hover:bg-white/5 rounded"
          style={{ padding: '1px 6px', height: 18 }}
        >
          <span style={{ color: '#666' }}>Effort:</span>
          <span style={{ color: value === 'none' ? '#666' : '#DA7756', fontWeight: 500 }}>
            {EFFORT_LABEL[value]}
          </span>
        </button>
      </Tooltip>
      {open && chipRef.current && createPortal(
        <EffortPopup
          chipRect={chipRef.current.getBoundingClientRect()}
          popupRef={popupRef}
          value={value}
          onSelect={(v) => { onChange(v); setClicked(false); setPopupHover(false); }}
          onPopupEnter={() => setPopupHover(true)}
          onPopupLeave={() => setPopupHover(false)}
        />,
        document.body
      )}
    </>
  );
}

function EffortPopup({ chipRect, popupRef, value, onSelect, onPopupEnter, onPopupLeave }: {
  chipRect: DOMRect;
  popupRef: React.RefObject<HTMLDivElement | null>;
  value: DefaultClaudeEffort;
  onSelect: (v: DefaultClaudeEffort) => void;
  onPopupEnter?: () => void;
  onPopupLeave?: () => void;
}) {
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
        {EFFORT_LEVELS.map((level) => {
          const isActive = value === level;
          return (
            <Tooltip key={level} content={'Set default effort to ' + level}>
              <button
                onClick={() => onSelect(isActive ? 'none' : level)}
                className={`text-[10px] px-1.5 py-1 rounded cursor-pointer ${
                  isActive
                    ? 'bg-[#DA7756]/20 text-white font-medium'
                    : 'bg-[#2d2d2d] text-[#888] hover:text-white hover:bg-[#3d3d3d]'
                }`}
                style={{ minWidth: 32 }}
              >
                {EFFORT_LABEL[level]}
              </button>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
}

// Mobile-web access chip. Pulls live info from main (web-server.js) on mount,
// shows the LAN URL as a clickable pill: click → opens in default OS browser
// (so you can scan the address visually then scribe it onto your phone). Long-
// press / right-click would be ideal for "copy to clipboard" but that's noise
// for the common case — single click to open is enough. Tooltip exposes the
// full URL with token so you can read it off-screen if needed.
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
    return (
      <Tooltip content="Mobile web server is not running — check main process logs.">
        <span style={{ color: '#666', fontSize: 11 }}>web: off</span>
      </Tooltip>
    );
  }

  const fullUrl = `http://${info.lanIp}:${info.port}/?token=${info.token}`;
  const shortUrl = `${info.lanIp}:${info.port}`;

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
    <Tooltip content={`Open mobile-web in browser. Right-click to copy URL with token.\n\n${fullUrl}`}>
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
    </Tooltip>
  );
}

function StatusToggle({ label, title, active, onClick, activeColor = '#22c55e' }: {
  label: string;
  title: string;
  active: boolean;
  onClick: () => void;
  activeColor?: string;
}) {
  return (
    <Tooltip content={title}>
      <button
        onClick={onClick}
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
    </Tooltip>
  );
}
