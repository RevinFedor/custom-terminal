import React, { useState, useRef, useCallback, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { useUIStore } from '../../store/useUIStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useCmdKey } from '../../hooks/useCmdHoverPopover';
import HoverBridgeDebug from '../HoverBridgeDebug';
import { copySessionsToClipboard, tabHasCopyableSession } from '../../utils/copySessionExport';
import { copySessionFiltersFromState } from '../../utils/copySessionFilters';
import ControlHint from '../UI/ControlHint';
import CopySessionFilterPanel from './CopySessionFilterPanel';

const SettingsPortal: React.FC<{ children: React.ReactNode }> = ({ children }) =>
  createPortal(children, document.body);

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

interface CopySessionButtonProps {
  activeTabId: string | null;
  sessionType: 'claude' | 'gemini' | 'codex' | null;
}

// Compact Copy Session button placed under the Claude/Gemini session block in
// InfoPanel. Replaces the bulky sticker that used to live in the actions panel.
// Behaviour:
//   • Hover the 📋 icon → settings popover slides in from the LEFT (same as before)
//   • CMD + hover the button body → "Custom session ID" input popover appears ABOVE
//     with a CSS-bridge gap of 4px (so the cursor can travel up without dismissing).
//     Releasing CMD while still on the popup keeps it open (popupHovered).
export default function CopySessionButton({ activeTabId, sessionType }: CopySessionButtonProps) {
  const showToast = useUIStore((s) => s.showToast);

  const { activeProjectId, getActiveProject, getSelectedTabs } = useWorkspaceStore();

  const isCmdPressed = useCmdKey();
  const buttonRef = useRef<HTMLDivElement>(null);
  const iconRef = useRef<HTMLSpanElement>(null);

  const [showSettings, setShowSettings] = useState(false);
  const [buttonHovered, setButtonHovered] = useState(false);
  const [iconHovered, setIconHovered] = useState(false);   // hovering the 📋 icon (opens settings popup)
  const [inputPopupHovered, setInputPopupHovered] = useState(false);
  const [customId, setCustomId] = useState('');
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
  const isCodex = sessionType === 'codex';
  const accent = isGemini ? '#4E86F8' : isCodex ? '#10A37F' : '#DA7756';
  const accentRgba = isGemini ? 'rgba(78,134,248,' : isCodex ? 'rgba(16,163,127,' : 'rgba(218,119,86,';

  const selectedTabs = activeProjectId ? getSelectedTabs(activeProjectId) : [];
  const isMultiSelect = selectedTabs.length > 1;

  const handleCopy = useCallback(async (overrideInput?: string) => {
    const activeProject = getActiveProject();
    if (!activeProject) { showToast('No active project', 'error'); return; }

    const tabs = isMultiSelect
      ? selectedTabs
      : (activeTabId ? [activeProject.tabs.get(activeTabId)] : []);
    if (!overrideInput && !tabs.some(tabHasCopyableSession)) {
      showToast('Нет сессий для копирования', 'warning');
      return;
    }

    try {
      // Сама операция живёт в copySessionExport.ts — её же зовёт пункт
      // контекстного меню вкладки. Здесь остались только сообщения: они
      // принадлежат этой кнопке и в меню звучат иначе.
      const res = await copySessionsToClipboard({
        tabs,
        fallbackCwd: activeProject.projectPath,
        overrideInput,
        filters: copySessionFiltersFromState(useUIStore.getState()),
      });
      if (res.copied > 0) {
        const sizeKB = Math.round(res.content.length / 1024);
        showToast(`Скопировано ${res.copied}/${res.requested} сессий (${sizeKB}KB)`, 'success');
      } else {
        showToast('Не удалось скопировать ни одну сессию', 'error');
      }
    } catch (err: any) {
      console.error('[CopySession] Error', err);
      showToast('Copy failed: ' + (err.message || String(err)), 'error');
    }
  }, [activeTabId, isMultiSelect, selectedTabs, getActiveProject, showToast]);

  return (
    <>
      <div
        ref={buttonRef}
        onMouseEnter={() => setButtonHovered(true)}
        onMouseLeave={() => { setButtonHovered(false); setIconHovered(false); }}
        className="inline-flex items-center rounded select-none overflow-hidden"
        style={{
          color: accent,
          border: `1px solid ${accentRgba} 0.25)`,
          fontSize: '11px',
          height: 20,
          backgroundColor: `${accentRgba} 0.08)`,
        }}
      >
        {/* Один чип — одни НАСТРОЙКИ. Действие «скопировать» уехало в
            контекстное меню вкладки: здесь оно работало по АКТИВНОЙ вкладке, а
            окон теперь несколько, и «активная» перестала совпадать с «той, о
            которой я говорю». Настройки же общие для всех копирований — они и
            остались, рядом с прочими умолчаниями приложения. */}
        <ControlHint
          label="Настройки копирования сессии"
          modifiedAction="⌘ наведение — скопировать сессию по чужому ID"
          disabled={showSettings || showInputPopup}
          side="top"
        >
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
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 11,
            lineHeight: 1,
            padding: '0 7px',
            height: '100%',
            cursor: 'pointer',
            backgroundColor: (showSettings || iconHovered) ? `${accentRgba} 0.28)` : 'transparent',
            transition: 'background-color 0.12s',
            whiteSpace: 'nowrap',
          }}
        >
          <span style={{ fontSize: 12, lineHeight: 1 }}>📋</span>
          <span style={{ fontWeight: 500 }}>Settings Copy</span>
        </span>
        </ControlHint>
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
                // ВВЕРХ от триггера: чип переехал в нижнюю полосу приложения, и
                // панель, открытая вниз, ушла бы за нижний край экрана. Правый
                // край панели совпадает с правым краем чипа — так же, как было
                // в верхней полосе, только по другой оси.
                position: 'fixed',
                bottom: window.innerHeight - bRect.top + 6,
                right: window.innerWidth - bRect.right,
                zIndex: 10000,
                display: 'flex',
                flexDirection: 'row',
              }}
            >
              <div
                className="bg-[#1a1a1a] border border-[#444] rounded-lg shadow-2xl flex flex-col"
                style={{ backdropFilter: 'blur(12px)', boxShadow: '0 15px 35px rgba(0,0,0,0.6)', padding: '8px 10px', width: 'min(340px, calc(100vw - 24px))', maxHeight: 'calc(100vh - 24px)', overflowY: 'auto', gap: '1px' }}
              >
                <div style={{ fontSize: '9px', textTransform: 'uppercase', fontWeight: 700, color: '#777', borderBottom: '1px solid #2a2a2a', paddingBottom: 6, marginBottom: 4, letterSpacing: '0.05em' }}>
                  Настройки копирования
                </div>
                <CopySessionFilterPanel accent={accent} showFromFork={!isCodex} />
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
  const [box, setBox] = useState<{ left: number; bottom: number; width: number } | null>(null);

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
      // Раскрывается ВВЕРХ: чип живёт в нижней полосе приложения, и поле,
      // открытое вниз, ушло бы за нижний край. Мост наведения тоже переехал —
      // теперь это paddingBottom, чтобы курсор мог пройти от чипа к полю, не
      // теряя наведения (иначе поле исчезает ровно в момент, когда к нему
      // тянутся).
      setBox({ left: r.left, bottom: window.innerHeight - r.top, width });
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
          bottom: box.bottom,
          width: box.width,
          paddingBottom: 4, // невидимый мост: тянет зону наведения вниз, к чипу
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
