import React, { useState, useRef, useCallback, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { useUIStore } from '../../store/useUIStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useCmdKey } from '../../hooks/useCmdHoverPopover';
import HoverBridgeDebug from '../HoverBridgeDebug';

const { ipcRenderer } = window.require('electron');

const SettingsPortal: React.FC<{ children: React.ReactNode }> = ({ children }) =>
  createPortal(children, document.body);

// Reusable toggle row for the hierarchical copy-settings panel.
// Mirrors the original ActionsPanel implementation; kept local so the InfoPanel
// version doesn't import the (about-to-shrink) ActionsPanel.
function ToggleRow({ label, active, color, onToggle, disabled = false, indent = false, isLastChild = false }: {
  label: React.ReactNode;
  active: boolean;
  color: string;
  onToggle: () => void;
  disabled?: boolean;
  indent?: boolean;
  isLastChild?: boolean;
}) {
  return (
    <label
      className={`flex items-center justify-between gap-3 group/label ${disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}
      style={{ position: 'relative', paddingLeft: indent ? '20px' : '2px', paddingRight: '2px', paddingTop: 3, paddingBottom: 3 }}
    >
      {indent && (
        <>
          <span aria-hidden style={{ position: 'absolute', left: 8, top: 0, bottom: isLastChild ? '50%' : 0, width: 1, backgroundColor: '#333' }} />
          <span aria-hidden style={{ position: 'absolute', left: 8, top: '50%', width: 8, height: 1, backgroundColor: '#333' }} />
        </>
      )}
      <span className="group-hover/label:text-white min-w-0 flex-1" style={{ fontSize: indent ? '11px' : '12px', color: '#bbb', fontWeight: indent ? 400 : 500, lineHeight: 1.3 }}>
        {label}
      </span>
      <div
        className={`relative ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'} ${active && !disabled ? color : 'bg-[#3a3a3a]'} shrink-0`}
        style={{ width: 28, height: 16, borderRadius: 8, transition: 'background-color 0.15s' }}
        onClick={(e) => { e.stopPropagation(); if (!disabled) onToggle(); }}
      >
        <div
          className="absolute bg-white rounded-full"
          style={{ top: 2, left: active ? 14 : 2, width: 12, height: 12, transition: 'left 0.15s', boxShadow: '0 1px 2px rgba(0,0,0,0.3)' }}
        />
      </div>
    </label>
  );
}

// Official Claude brand mark — 4-rayed asymmetric asterisk from Wikimedia Commons
// (Claude_AI_symbol.svg, ineligible for copyright due to simple geometric design).
// Inline so we can tint via fill and size via the wrapper.
export function ClaudeSparkle({ size = 12, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true" style={{ display: 'inline-block', flexShrink: 0 }}>
      <path
        fill={color}
        d="m19.6 66.5 19.7-11 .3-1-.3-.5h-1l-3.3-.2-11.2-.3L14 53l-9.5-.5-2.4-.5L0 49l.2-1.5 2-1.3 2.9.2 6.3.5 9.5.6 6.9.4L38 49.1h1.6l.2-.7-.5-.4-.4-.4L29 41l-10.6-7-5.6-4.1-3-2-1.5-2-.6-4.2 2.7-3 3.7.3.9.2 3.7 2.9 8 6.1L37 36l1.5 1.2.6-.4.1-.3-.7-1.1L33 25l-6-10.4-2.7-4.3-.7-2.6c-.3-1-.4-2-.4-3l3-4.2L28 0l4.2.6L33.8 2l2.6 6 4.1 9.3L47 29.9l2 3.8 1 3.4.3 1h.7v-.5l.5-7.2 1-8.7 1-11.2.3-3.2 1.6-3.8 3-2L61 2.6l2 2.9-.3 1.8-1.1 7.7L59 27.1l-1.5 8.2h.9l1-1.1 4.1-5.4 6.9-8.6 3-3.5L77 13l2.3-1.8h4.3l3.1 4.7-1.4 4.9-4.4 5.6-3.7 4.7-5.3 7.1-3.2 5.7.3.4h.7l12-2.6 6.4-1.1 7.6-1.3 3.5 1.6.4 1.6-1.4 3.4-8.2 2-9.6 2-14.3 3.3-.2.1.2.3 6.4.6 2.8.2h6.8l12.6 1 3.3 2 1.9 2.7-.3 2-5.1 2.6-6.8-1.6-16-3.8-5.4-1.3h-.8v.4l4.6 4.5 8.3 7.5L89 80.1l.5 2.4-1.3 2-1.4-.2-9.2-7-3.6-3-8-6.8h-.5v.7l1.8 2.7 9.8 14.7.5 4.5-.7 1.4-2.6 1-2.7-.6-5.8-8-6-9-4.7-8.2-.5.4-2.9 30.2-1.3 1.5-3 1.2-2.5-2-1.4-3 1.4-6.2 1.6-8 1.3-6.4 1.2-7.9.7-2.6v-.2H49L43 72l-9 12.3-7.2 7.6-1.7.7-3-1.5.3-2.8L24 86l10-12.8 6-7.9 4-4.6-.1-.5h-.3L17.2 77.4l-4.7.6-2-2 .2-3 1-1 8-5.5Z"
      />
    </svg>
  );
}

function ToolGroupLabel({ tools, hint }: { tools: string[]; hint?: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', flexWrap: 'wrap', gap: '4px' }}>
      {tools.map((t, i) => (
        <React.Fragment key={t}>
          {i > 0 && <span style={{ color: '#555' }}>·</span>}
          <code style={{ fontFamily: 'ui-monospace, monospace', fontSize: '10.5px', color: '#d4d4d4', background: 'rgba(255,255,255,0.04)', padding: '1px 4px', borderRadius: 3 }}>{t}</code>
        </React.Fragment>
      ))}
      {hint && <span style={{ color: '#666', fontSize: '10px', marginLeft: 2 }}>{hint}</span>}
    </span>
  );
}

interface CopySessionButtonProps {
  activeTabId: string | null;
  sessionType: 'claude' | 'gemini' | null;
}

// Compact Copy Session button placed under the Claude/Gemini session block in
// InfoPanel. Replaces the bulky sticker that used to live in ActionsPanel.
// Behaviour:
//   • Hover the 📋 icon → settings popover slides in from the LEFT (same as before)
//   • CMD + hover the button body → "Custom session ID" input popover appears ABOVE
//     with a CSS-bridge gap of 4px (so the cursor can travel up without dismissing).
//     Releasing CMD while still on the popup keeps it open (popupHovered).
export default function CopySessionButton({ activeTabId, sessionType }: CopySessionButtonProps) {
  const showToast = useUIStore((s) => s.showToast);
  const {
    copyIncludeEditing: includeEditing, setCopyIncludeEditing: setIncludeEditing,
    copyIncludeReading: includeReading, setCopyIncludeReading: setIncludeReading,
    copyFromStart: fromStart, setCopyFromStart: setFromStart,
    copyIncludeSubagentResult: includeSubagentResult, setCopyIncludeSubagentResult: setIncludeSubagentResult,
    copyIncludeSubagentHistory: includeSubagentHistory, setCopyIncludeSubagentHistory: setIncludeSubagentHistory,
    copyIncludeUser: includeUser, setCopyIncludeUser: setIncludeUser,
    copyIncludeClaude: includeClaude, setCopyIncludeClaude: setIncludeClaude,
    copyIncludeText: includeText, setCopyIncludeText: setIncludeText,
    copyIncludeThinking: includeThinking, setCopyIncludeThinking: setIncludeThinking,
    copyIncludeBash: includeBash, setCopyIncludeBash: setIncludeBash,
    copyIncludeTools: includeTools, setCopyIncludeTools: setIncludeTools,
  } = useUIStore();

  const { activeProjectId, getActiveProject, getSelectedTabs } = useWorkspaceStore();

  const isCmdPressed = useCmdKey();
  const buttonRef = useRef<HTMLDivElement>(null);
  const iconRef = useRef<HTMLSpanElement>(null);

  const [showSettings, setShowSettings] = useState(false);
  const [buttonHovered, setButtonHovered] = useState(false);
  const [copyHovered, setCopyHovered] = useState(false);   // hovering the "Copy session" text area
  const [iconHovered, setIconHovered] = useState(false);   // hovering the 📋 icon (opens settings popup)
  const [inputPopupHovered, setInputPopupHovered] = useState(false);
  const [customId, setCustomId] = useState('');
  const [isCopying, setIsCopying] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const settingsPopupRef = useRef<HTMLDivElement>(null);

  // Settings popup теперь открывается КЛИКОМ по 📋, не hover'ом. Закрывается: повторный
  // клик по 📋 (toggle), Esc, либо клик по backdrop-overlay (см. рендер popup'а ниже).
  // Hover-логика и hover-bridge удалены — пользователь явно открывает/закрывает.
  useEffect(() => {
    if (!showSettings) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowSettings(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showSettings]);

  const showInputPopup = (isCmdPressed && buttonHovered) || inputPopupHovered;

  // Focus input when popup opens
  useEffect(() => {
    if (showInputPopup) setTimeout(() => inputRef.current?.focus(), 30);
  }, [showInputPopup]);

  const isGemini = sessionType === 'gemini';
  const accent = isGemini ? '#4E86F8' : '#DA7756';
  const accentRgba = isGemini ? 'rgba(78,134,248,' : 'rgba(218,119,86,';

  const selectedTabs = activeProjectId ? getSelectedTabs(activeProjectId) : [];
  const isMultiSelect = selectedTabs.length > 1;

  const handleCopy = useCallback(async (overrideInput?: string) => {
    const activeProject = getActiveProject();
    if (!activeProject) { showToast('No active project', 'error'); return; }

    const tabsToCopy = isMultiSelect ? selectedTabs : (activeTabId ? [activeProject.tabs.get(activeTabId)] : []);
    const validTabs = tabsToCopy.filter(t => t && (t.claudeSessionId || t.geminiSessionId || overrideInput));
    if (validTabs.length === 0) { showToast('Нет сессий для копирования', 'warning'); return; }

    setIsCopying(true);
    try {
      const allResults: string[] = [];
      for (const tab of validTabs) {
        if (!tab) continue;
        let targetId = '';
        let parsedCwd = '';
        let kind: 'claude' | 'gemini' = 'claude';

        if (overrideInput) {
          const uuidMatch = overrideInput.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
          const cwdMatch = overrideInput.match(/cwd:\s*(\/[^\s\n]+)/i);
          if (uuidMatch) targetId = uuidMatch[0];
          if (cwdMatch) parsedCwd = cwdMatch[1];
          kind = tab.geminiSessionId ? 'gemini' : 'claude';
        }
        if (!targetId) {
          if (tab.claudeSessionId) { targetId = tab.claudeSessionId; kind = 'claude'; }
          else if (tab.geminiSessionId) { targetId = tab.geminiSessionId; kind = 'gemini'; }
        }
        if (!targetId) continue;

        const tabCwd = await ipcRenderer.invoke('terminal:getCwd', tab.id).catch(() => null);
        const cwd = parsedCwd || tabCwd || tab.cwd || activeProject.projectPath;

        let result;
        if (kind === 'gemini') {
          result = await ipcRenderer.invoke('gemini:copy-range', { sessionId: targetId, cwd, startUuid: null, endUuid: null });
        } else {
          result = await ipcRenderer.invoke('claude:export-clean-session', {
            sessionId: targetId, cwd, includeEditing, includeReading, fromStart,
            includeSubagentResult, includeSubagentHistory,
            includeUser, includeClaude, includeText, includeThinking, includeBash, includeTools,
          });
        }
        if (result?.success) allResults.push(result.content);
      }
      if (allResults.length > 0) {
        const finalContent = allResults.join('\n\n' + '='.repeat(40) + '\n\n');
        await navigator.clipboard.writeText(finalContent);
        const sizeKB = Math.round(finalContent.length / 1024);
        showToast(`Скопировано ${validTabs.length}/${tabsToCopy.length} сессий (${sizeKB}KB)`, 'success');
      } else {
        showToast('Не удалось скопировать ни одну сессию', 'error');
      }
    } catch (err: any) {
      console.error('[CopySession] Error', err);
      showToast('Copy failed: ' + (err.message || String(err)), 'error');
    } finally {
      setIsCopying(false);
    }
  }, [activeTabId, isMultiSelect, selectedTabs, getActiveProject, showToast,
      includeEditing, includeReading, fromStart, includeSubagentResult, includeSubagentHistory,
      includeUser, includeClaude, includeText, includeThinking, includeBash, includeTools]);

  return (
    <>
      <div
        ref={buttonRef}
        onMouseEnter={() => setButtonHovered(true)}
        onMouseLeave={() => { setButtonHovered(false); setCopyHovered(false); setIconHovered(false); }}
        className="inline-flex items-center rounded select-none overflow-hidden"
        style={{
          color: accent,
          border: `1px solid ${accentRgba} 0.25)`,
          fontSize: '11px',
          height: 26,
          opacity: isCopying ? 0.5 : 1,
          backgroundColor: `${accentRgba} 0.08)`,
        }}
      >
        {/* 📋 settings half — открывает popup настроек по КЛИКУ (toggle). Hover больше не
            триггерит появление: hover-popup мешал пользователю работать рядом, поэтому
            переведено на explicit click. Visual hover-state на самой иконке остаётся для
            affordance — она выглядит кликабельной. */}
        <span
          ref={iconRef}
          data-settings-icon
          onMouseEnter={() => setIconHovered(true)}
          onMouseLeave={() => setIconHovered(false)}
          onClick={(e) => {
            e.stopPropagation();
            setShowSettings(prev => !prev);
          }}
          style={{
            position: 'relative',
            fontSize: 13,
            lineHeight: 1,
            padding: '0 6px',
            height: '100%',
            cursor: 'pointer',
            backgroundColor: (showSettings || iconHovered) ? `${accentRgba} 0.28)` : 'transparent',
            transition: 'background-color 0.12s',
          }}
          className="inline-flex items-center justify-center"
        >
          📋
        </span>
        {/* Divider — accent-tinted vertical line between the 📋 (settings) half and the
            "Copy session" half. Fork-toggle indication has moved to a dedicated chip in
            the markers row, so the divider keeps the calm orange tone regardless. */}
        <span style={{ width: 1, height: '70%', backgroundColor: `${accentRgba} 0.25)` }} />
        {/* Copy label half — hovers like a real button so user knows "click here = copy" */}
        <span
          onMouseEnter={() => setCopyHovered(true)}
          onMouseLeave={() => setCopyHovered(false)}
          onClick={() => { if (!isCopying) handleCopy(); }}
          style={{
            lineHeight: 1,
            padding: '0 10px',
            height: '100%',
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            backgroundColor: copyHovered ? `${accentRgba} 0.28)` : 'transparent',
            color: copyHovered ? '#fff' : accent,
            fontWeight: copyHovered ? 600 : 400,
            transition: 'background-color 0.12s, color 0.12s, font-weight 0.12s',
          }}
        >
          {isCopying ? 'Copying...' : isMultiSelect ? `Copy ${selectedTabs.length}× session` : customId.trim() ? 'Copy custom' : 'Copy session'}
        </span>
      </div>

      {/* Settings panel — slides in to the LEFT of the button.
          Открывается кликом по 📋. Закрывается: повторный клик по 📋, Esc, клик по backdrop. */}
      {showSettings && !isGemini && buttonRef.current && (() => {
        const bRect = buttonRef.current.getBoundingClientRect();
        return (
          <SettingsPortal>
            {/* Full-viewport backdrop — ловит клики вне popup'а и закрывает его. Прозрачный,
                чтобы не затемнять остальной UI; нужен только для capture-фазы события. */}
            <div
              onClick={() => setShowSettings(false)}
              style={{
                position: 'fixed',
                inset: 0,
                zIndex: 9999,
                background: 'transparent',
              }}
            />
            <div
              ref={settingsPopupRef}
              onClick={(e) => e.stopPropagation()}
              style={{
                position: 'fixed',
                left: bRect.left - 3,
                top: bRect.top + bRect.height / 2,
                transform: 'translate(-100%, -50%)',
                zIndex: 10000,
                display: 'flex',
                flexDirection: 'row',
              }}
            >
              <div
                className="bg-[#1a1a1a] border border-[#444] rounded-lg shadow-2xl flex flex-col"
                style={{ backdropFilter: 'blur(12px)', boxShadow: '0 15px 35px rgba(0,0,0,0.6)', padding: '8px 10px', minWidth: '260px', gap: '1px' }}
              >
                <div style={{ fontSize: '9px', textTransform: 'uppercase', fontWeight: 700, color: '#777', borderBottom: '1px solid #2a2a2a', paddingBottom: 6, marginBottom: 4, letterSpacing: '0.05em' }}>
                  Настройки копирования
                </div>
                <ToggleRow label="👤 User" active={includeUser} color="bg-[#DA7756]" onToggle={() => setIncludeUser(!includeUser)} />
                <ToggleRow label={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><ClaudeSparkle size={12} color="#DA7756" /> Claude</span>} active={includeClaude} color="bg-[#DA7756]" onToggle={() => setIncludeClaude(!includeClaude)} />
                <ToggleRow label={<span style={{ fontStyle: 'italic' }}>«text»</span>} active={includeText} color="bg-[#DA7756]" disabled={!includeClaude} indent onToggle={() => setIncludeText(!includeText)} />
                <ToggleRow label={<span style={{ fontStyle: 'italic' }}>«thinking»</span>} active={includeThinking} color="bg-[#DA7756]" disabled={!includeClaude} indent onToggle={() => setIncludeThinking(!includeThinking)} />
                <ToggleRow label={<ToolGroupLabel tools={['read_file']} />} active={includeReading} color="bg-[#DA7756]" disabled={!includeClaude} indent onToggle={() => setIncludeReading(!includeReading)} />
                <ToggleRow label={<ToolGroupLabel tools={['edit', 'write']} />} active={includeEditing} color="bg-[#DA7756]" disabled={!includeClaude} indent onToggle={() => setIncludeEditing(!includeEditing)} />
                <ToggleRow label={<ToolGroupLabel tools={['bash', 'monitor', 'grep', 'glob']} hint="shell" />} active={includeBash} color="bg-[#DA7756]" disabled={!includeClaude} indent onToggle={() => setIncludeBash(!includeBash)} />
                <ToggleRow label={<ToolGroupLabel tools={['mcp__*', 'web_search']} hint="MCP и прочее" />} active={includeTools} color="bg-[#DA7756]" disabled={!includeClaude} indent isLastChild onToggle={() => setIncludeTools(!includeTools)} />

                <div style={{ height: 1, backgroundColor: '#2a2a2a', margin: '6px 0' }} />

                <ToggleRow
                  label="🧵 Субагенты"
                  active={includeSubagentResult || includeSubagentHistory}
                  color="bg-[#DA7756]"
                  onToggle={() => {
                    if (includeSubagentResult || includeSubagentHistory) {
                      setIncludeSubagentHistory(false);
                      setIncludeSubagentResult(false);
                    } else {
                      setIncludeSubagentResult(true);
                    }
                  }}
                />
                <ToggleRow label={<span>Финальный результат <span style={{ color: '#666', fontSize: '10px' }}>— ответ Task</span></span>} active={includeSubagentResult} color="bg-[#DA7756]" disabled={!(includeSubagentResult || includeSubagentHistory)} indent onToggle={() => setIncludeSubagentResult(!includeSubagentResult)} />
                <ToggleRow label={<span>Вся история <span style={{ color: '#666', fontSize: '10px' }}>— все шаги</span></span>} active={includeSubagentHistory} color="bg-[#DA7756]" disabled={!(includeSubagentResult || includeSubagentHistory)} indent isLastChild onToggle={() => setIncludeSubagentHistory(!includeSubagentHistory)} />

                <div style={{ height: 1, backgroundColor: '#2a2a2a', margin: '6px 0' }} />

                <ToggleRow label="От fork" active={!fromStart} color="bg-[#DA7756]" onToggle={() => setFromStart(!fromStart)} />
              </div>
            </div>
          </SettingsPortal>
        );
      })()}

      {/* CMD+hover custom-ID input — single-line, appears BELOW the button.
          Width spans from the button's left edge to the sidebar's left edge minus 8px
          (the sidebar — usually a [data-timeline] strip on the right — would clip a
          fixed-width popup otherwise). Recomputed on resize. 4px gap above acts as the
          invisible CSS-bridge so the cursor can travel from button into the input. */}
      <InputPopup
        visible={showInputPopup && !!buttonRef.current}
        buttonRef={buttonRef}
        accent={accent}
        inputRef={inputRef}
        value={customId}
        onChange={setCustomId}
        onCopy={(v) => { handleCopy(v); setInputPopupHovered(false); }}
        onClose={() => { setInputPopupHovered(false); setCustomId(''); }}
        onPopupEnter={() => setInputPopupHovered(true)}
        onPopupLeave={() => setInputPopupHovered(false)}
      />
    </>
  );
}

// Single-line input popup that sits BELOW the trigger button and stretches to fill
// the available horizontal space up to the right-side sidebar (Timeline strip).
function InputPopup({
  visible, buttonRef, accent, inputRef, value, onChange, onCopy, onClose,
  onPopupEnter, onPopupLeave,
}: {
  visible: boolean;
  buttonRef: React.RefObject<HTMLDivElement | null>;
  accent: string;
  inputRef: React.RefObject<HTMLInputElement | null>;
  value: string;
  onChange: (v: string) => void;
  onCopy: (v: string) => void;
  onClose: () => void;
  onPopupEnter: () => void;
  onPopupLeave: () => void;
}) {
  const [box, setBox] = useState<{ left: number; top: number; width: number } | null>(null);

  useLayoutEffect(() => {
    if (!visible || !buttonRef.current) { setBox(null); return; }
    const measure = () => {
      if (!buttonRef.current) return;
      const r = buttonRef.current.getBoundingClientRect();
      // Right edge: prefer the right sidebar's left edge (Timeline strip).
      const sidebar = document.querySelector('[data-timeline]') as HTMLElement | null;
      const sidebarLeft = sidebar ? sidebar.getBoundingClientRect().left : window.innerWidth;
      const rightLimit = Math.min(sidebarLeft, window.innerWidth) - 8;
      const width = Math.max(120, rightLimit - r.left);
      // Wrapper top = r.bottom (NO gap). The visual 4px gap below the button is created
      // by paddingTop INSIDE the wrapper. This keeps the wrapper's hover-area flush with
      // the button so the cursor can travel through the gap without losing hover.
      setBox({ left: r.left, top: r.bottom, width });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [visible, buttonRef]);

  const popupRef = useRef<HTMLDivElement>(null);

  if (!visible || !box) return null;
  return (
    <SettingsPortal>
      <div
        ref={popupRef}
        onMouseEnter={onPopupEnter}
        onMouseLeave={onPopupLeave}
        style={{
          position: 'fixed',
          left: box.left,
          top: box.top,
          width: box.width,
          paddingTop: 4, // invisible CSS-bridge: extends hit area upward to the button
          zIndex: 10000,
        }}
      >
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Session ID (UUID) или текст с cwd: /path…"
          autoFocus
          className="w-full bg-[#1a1a1a] border rounded px-2 py-1 text-[11px] text-[#ddd] font-mono focus:outline-none placeholder:text-[#555]"
          style={{
            borderColor: accent + '66',
            boxShadow: '0 6px 18px rgba(0,0,0,0.5)',
            height: 26,
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && value.trim()) {
              e.preventDefault();
              onCopy(value.trim());
            } else if (e.key === 'Escape') {
              e.preventDefault();
              onClose();
            }
          }}
        />
      </div>
      <HoverBridgeDebug containerRef={buttonRef} menuRef={popupRef} direction="below" />
    </SettingsPortal>
  );
}
