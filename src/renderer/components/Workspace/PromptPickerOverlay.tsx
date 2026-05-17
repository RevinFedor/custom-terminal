import React, { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useUIStore } from '../../store/useUIStore';

const { ipcRenderer } = window.require('electron');

interface PromptRow {
  id?: number | string;
  title: string;
  content: string;
  position: number;
  group_id?: number | string | null;
  file_paths?: string[];
}

interface PromptGroupRow {
  id: number | string;
  name: string;
  position: number;
}

type FlatLeftItem =
  | { kind: 'group'; group: PromptGroupRow; position: number }
  | { kind: 'prompt'; prompt: PromptRow; position: number };

// Same insert routing as the legacy Cmd+E menu (which is removed). Routing
// target depends on tab type:
//   - claude-sdk → window CustomEvent the SDK composer listens to
//   - terminal/claude/gemini PTY → terminal:input + terminal:paste for attached files
async function deliverPrompt(prompt: PromptRow, tabId: string, isSDKTab: boolean) {
  const text = prompt.content || '';
  if (!text && (!prompt.file_paths || prompt.file_paths.length === 0)) return;

  if (isSDKTab) {
    if (text) {
      window.dispatchEvent(new CustomEvent('claude-sdk:composer-insert', {
        detail: { tabId, text },
      }));
    }
    return;
  }

  if (text) ipcRenderer.send('terminal:input', tabId, text);
  if (prompt.file_paths && prompt.file_paths.length > 0) {
    try {
      const filesResult = await ipcRenderer.invoke('ai-prompts:read-files', prompt.file_paths);
      if (filesResult?.success && Array.isArray(filesResult.data)) {
        for (const f of filesResult.data) {
          await ipcRenderer.invoke('terminal:paste', { tabId, content: f.content, submit: false });
        }
      }
    } catch (err) {
      console.warn('[PromptPicker] ai-prompts:read-files failed:', err);
    }
  }
}

const PromptPickerOverlay: React.FC = () => {
  const open = useUIStore((s) => s.promptPickerOpen);
  const setOpen = useUIStore((s) => s.setPromptPickerOpen);
  const showToast = useUIStore((s) => s.showToast);
  const fontSize = useUIStore((s) => s.promptPickerFontSize);

  const rootRef = useRef<HTMLDivElement | null>(null);

  const [groups, setGroups] = useState<PromptGroupRow[]>([]);
  const [prompts, setPrompts] = useState<PromptRow[]>([]);
  const [loaded, setLoaded] = useState(false);

  // selectedKey: 'group:<id>' or 'ungrouped:<idx>'.
  // pickerLevel='group' — focus on left list; 'prompt' — focus on right list.
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [pickerLevel, setPickerLevel] = useState<'group' | 'prompt'>('group');
  const [selectedPromptIdx, setSelectedPromptIdx] = useState(0);

  // Anchor: at the cursor (if mouse moved recently inside the window),
  // otherwise fall back to a fixed upper-third position. Decided once on
  // open transition; doesn't follow the cursor while picker is up.
  type Anchor = { mode: 'fixed-top' } | { mode: 'cursor'; x: number; y: number };
  const [anchor, setAnchor] = useState<Anchor>({ mode: 'fixed-top' });

  // Continuously tracked while component is mounted (App-level singleton).
  // mousemove only fires when cursor is inside the Electron window, so a
  // stale timestamp ⇒ cursor probably outside → trigger fallback.
  const lastMouseRef = useRef<{ x: number; y: number; t: number }>({ x: 0, y: 0, t: 0 });
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      lastMouseRef.current = { x: e.clientX, y: e.clientY, t: Date.now() };
    };
    window.addEventListener('mousemove', onMove, true);
    return () => window.removeEventListener('mousemove', onMove, true);
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const [pr, gr] = await Promise.all([
          ipcRenderer.invoke('prompts:get'),
          ipcRenderer.invoke('prompt-groups:get'),
        ]);
        if (cancelled) return;
        const promptsArr: PromptRow[] = pr?.success ? (pr.data || []) : [];
        const groupsArr: PromptGroupRow[] = gr?.success ? (gr.data || []) : [];
        setPrompts(promptsArr);
        setGroups(groupsArr);
        setLoaded(true);
      } catch (err) {
        console.warn('[PromptPicker] load failed:', err);
        setPrompts([]);
        setGroups([]);
        setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [open]);

  const flatLeft = useMemo<FlatLeftItem[]>(() => {
    const items: FlatLeftItem[] = [];
    groups.forEach(g => items.push({ kind: 'group', group: g, position: g.position }));
    prompts
      .filter(p => p.group_id == null || p.group_id === '' || p.group_id === undefined)
      .forEach(p => items.push({ kind: 'prompt', prompt: p, position: p.position }));
    items.sort((a, b) => a.position - b.position);
    return items;
  }, [groups, prompts]);

  useEffect(() => {
    if (!open || !loaded) return;
    if (flatLeft.length === 0) return;
    const first = flatLeft[0];
    const key = first.kind === 'group' ? `group:${first.group.id}` : `ungrouped:0`;
    setSelectedKey(key);
    setPickerLevel('group');
    setSelectedPromptIdx(0);
  }, [open, loaded, flatLeft]);

  // Decide anchor each time picker opens. If mouse moved inside the window
  // recently (≤ 1500ms) we trust the last cursor position; otherwise the
  // cursor is probably outside the Electron window — use fixed fallback.
  useEffect(() => {
    if (!open) return;
    const last = lastMouseRef.current;
    const fresh = last.t > 0 && (Date.now() - last.t) <= 1500;
    if (fresh) setAnchor({ mode: 'cursor', x: last.x, y: last.y });
    else setAnchor({ mode: 'fixed-top' });
  }, [open]);

  const closePicker = useCallback(() => {
    setOpen(false);
    setSelectedKey(null);
    setPickerLevel('group');
    setSelectedPromptIdx(0);
  }, [setOpen]);

  const selectedLeftItem = useMemo<FlatLeftItem | null>(() => {
    if (!selectedKey) return null;
    if (selectedKey.startsWith('group:')) {
      const gid = selectedKey.slice('group:'.length);
      return flatLeft.find(it => it.kind === 'group' && String(it.group.id) === gid) ?? null;
    }
    if (selectedKey.startsWith('ungrouped:')) {
      const idx = parseInt(selectedKey.slice('ungrouped:'.length), 10);
      const ungrouped = flatLeft.filter(it => it.kind === 'prompt');
      return ungrouped[idx] ?? null;
    }
    return null;
  }, [selectedKey, flatLeft]);

  const rightPrompts = useMemo<PromptRow[]>(() => {
    if (!selectedLeftItem || selectedLeftItem.kind !== 'group') return [];
    const gid = selectedLeftItem.group.id;
    return prompts.filter(p => String(p.group_id) === String(gid));
  }, [selectedLeftItem, prompts]);

  // When a non-group left row is selected, snap the picker level back to 'group'
  // (prompt-level only makes sense over the right panel).
  useEffect(() => {
    if (selectedLeftItem && selectedLeftItem.kind !== 'group' && pickerLevel === 'prompt') {
      setPickerLevel('group');
    }
  }, [selectedLeftItem, pickerLevel]);

  const resolveTarget = useCallback((): { tabId: string; isSDK: boolean } | null => {
    const state = useWorkspaceStore.getState();
    const effectiveId = state.getEffectiveTabId();
    if (!effectiveId) return null;
    for (const [, ws] of state.openProjects) {
      const tab = ws.tabs.get(effectiveId);
      if (tab) {
        return { tabId: effectiveId, isSDK: tab.tabType === 'claude-sdk' };
      }
    }
    return { tabId: effectiveId, isSDK: false };
  }, []);

  const handleSelectPrompt = useCallback(async (prompt: PromptRow) => {
    const target = resolveTarget();
    if (!target) {
      showToast('No active tab', 'error');
      closePicker();
      return;
    }
    await deliverPrompt(prompt, target.tabId, target.isSDK);
    closePicker();
  }, [resolveTarget, showToast, closePicker]);

  // Keyboard nav — capture phase + stopPropagation so xterm/Claude TUI never
  // sees these keys when the picker is open. Layout-agnostic where possible
  // (Arrow/Enter/Escape are non-printable keys, identical across layouts).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const k = e.key;
      const navKey = k === 'ArrowUp' || k === 'ArrowDown' || k === 'ArrowLeft'
        || k === 'ArrowRight' || k === 'Enter' || k === 'Escape';
      if (!navKey) return;

      // Eat the event before anything else (xterm customKeyEventHandler,
      // assistant-ui textarea, etc.) can act on it.
      e.preventDefault();
      e.stopPropagation();
      if (typeof (e as any).stopImmediatePropagation === 'function') {
        (e as any).stopImmediatePropagation();
      }

      if (k === 'Escape') { closePicker(); return; }

      if (pickerLevel === 'group') {
        const currentIdx = selectedKey
          ? flatLeft.findIndex(it => {
              if (it.kind === 'group' && selectedKey.startsWith('group:')) {
                return String(it.group.id) === selectedKey.slice('group:'.length);
              }
              if (it.kind === 'prompt' && selectedKey.startsWith('ungrouped:')) {
                const idx = parseInt(selectedKey.slice('ungrouped:'.length), 10);
                const ungroupedList = flatLeft.filter(x => x.kind === 'prompt');
                return ungroupedList[idx] === it;
              }
              return false;
            })
          : -1;

        const moveSelection = (delta: number) => {
          if (flatLeft.length === 0) return;
          const next = (currentIdx + delta + flatLeft.length) % flatLeft.length;
          const item = flatLeft[next];
          if (item.kind === 'group') {
            setSelectedKey(`group:${item.group.id}`);
          } else {
            const ungroupedList = flatLeft.filter(x => x.kind === 'prompt');
            const idx = ungroupedList.indexOf(item);
            setSelectedKey(`ungrouped:${idx}`);
          }
          setSelectedPromptIdx(0);
        };

        if (k === 'ArrowDown') return moveSelection(1);
        if (k === 'ArrowUp') return moveSelection(-1);
        if (k === 'ArrowRight') {
          if (selectedLeftItem?.kind === 'group' && rightPrompts.length > 0) {
            setPickerLevel('prompt');
            setSelectedPromptIdx(0);
          }
          return;
        }
        if (k === 'ArrowLeft') { closePicker(); return; }
        if (k === 'Enter') {
          if (selectedLeftItem?.kind === 'prompt') {
            void handleSelectPrompt(selectedLeftItem.prompt);
          } else if (selectedLeftItem?.kind === 'group' && rightPrompts.length > 0) {
            setPickerLevel('prompt');
            setSelectedPromptIdx(0);
          }
          return;
        }
      } else {
        // pickerLevel === 'prompt'
        if (k === 'ArrowDown') {
          if (rightPrompts.length === 0) return;
          setSelectedPromptIdx(idx => (idx + 1) % rightPrompts.length);
          return;
        }
        if (k === 'ArrowUp') {
          if (rightPrompts.length === 0) return;
          setSelectedPromptIdx(idx => (idx - 1 + rightPrompts.length) % rightPrompts.length);
          return;
        }
        if (k === 'ArrowLeft') { setPickerLevel('group'); return; }
        if (k === 'Enter' || k === 'ArrowRight') {
          const p = rightPrompts[selectedPromptIdx];
          if (p) void handleSelectPrompt(p);
          return;
        }
      }
    };

    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, pickerLevel, selectedKey, flatLeft, selectedLeftItem, rightPrompts, selectedPromptIdx, closePicker, handleSelectPrompt]);

  // Click-outside to close. No visual backdrop — just a listener.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (rootRef.current && rootRef.current.contains(t)) return;
      closePicker();
    };
    window.addEventListener('mousedown', onDown, true);
    return () => window.removeEventListener('mousedown', onDown, true);
  }, [open, closePicker]);

  // Sizes scaled from store fontSize so paddings stay proportional to text.
  // Defaults at fontSize=12 → row 4px/8px padding, panels 180/200 wide.
  const ROW_PAD_Y = Math.max(3, Math.round(fontSize * 0.33));
  const ROW_PAD_X = Math.max(6, Math.round(fontSize * 0.66));
  const PANEL_PAD = 3;
  const GAP = 6;
  const LEFT_W = Math.max(140, Math.round(fontSize * 15));
  const RIGHT_W = Math.max(160, Math.round(fontSize * 17));
  const MAX_H = 460;

  // Geometry is decided in a layout effect after the picker is mounted —
  // we need the real measured size to clamp into the viewport. Until the
  // first measurement lands we render the picker off-screen but mounted
  // so getBoundingClientRect returns meaningful numbers.
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const estW = LEFT_W + GAP + RIGHT_W + PANEL_PAD * 2;
  const estH = MAX_H;

  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    if (typeof window === 'undefined') return;
    const measuredW = rootRef.current?.offsetWidth ?? estW;
    const measuredH = rootRef.current?.offsetHeight ?? estH;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 8;
    let left: number;
    let top: number;
    if (anchor.mode === 'cursor') {
      left = anchor.x + 4;
      top = anchor.y + 4;
    } else {
      left = Math.round(vw / 2 - measuredW / 2);
      top = Math.round(vh * 0.22 - measuredH / 2);
    }
    if (left + measuredW + margin > vw) left = vw - measuredW - margin;
    if (top + measuredH + margin > vh) top = vh - measuredH - margin;
    if (left < margin) left = margin;
    if (top < margin) top = margin;
    setPos({ left, top });
  }, [open, anchor, estW, estH, flatLeft.length, rightPrompts.length, selectedKey, pickerLevel]);

  if (!open) return null;

  const overlayStyle: React.CSSProperties = {
    position: 'fixed',
    left: pos ? pos.left : -9999,
    top: pos ? pos.top : -9999,
    zIndex: 99000,
    display: 'flex',
    gap: GAP,
    pointerEvents: 'auto',
    fontSize,
  };

  const panelStyle: React.CSSProperties = {
    maxHeight: MAX_H,
    overflowY: 'auto',
    background: '#1f1f1f',
    border: '1px solid #333',
    borderRadius: 8,
    boxShadow: '0 10px 26px rgba(0,0,0,0.45)',
    padding: PANEL_PAD,
  };

  const rowStyle = (selected: boolean, dimSelected = false): React.CSSProperties => ({
    padding: `${ROW_PAD_Y}px ${ROW_PAD_X}px`,
    borderRadius: 4,
    cursor: 'pointer',
    color: selected || dimSelected ? '#fff' : '#ddd',
    background: selected ? '#9333ea' : dimSelected ? '#3a1f4a' : 'transparent',
    fontSize,
    lineHeight: 1.3,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    userSelect: 'none',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  });

  const placeholderStyle: React.CSSProperties = {
    padding: `${ROW_PAD_Y}px ${ROW_PAD_X}px`,
    color: '#666',
    fontSize,
    lineHeight: 1.3,
    fontStyle: 'italic',
    userSelect: 'none',
  };

  return createPortal(
    <div ref={rootRef} style={overlayStyle} data-prompt-picker>
      {/* LEFT panel */}
      <div style={{ ...panelStyle, width: LEFT_W }}>
        {!loaded && (
          <div style={placeholderStyle}>Loading…</div>
        )}
        {loaded && flatLeft.length === 0 && (
          <div style={placeholderStyle}>No prompts</div>
        )}
        {loaded && flatLeft.map((item) => {
          if (item.kind === 'group') {
            const key = `group:${item.group.id}`;
            const isSelectedActive = selectedKey === key && pickerLevel === 'group';
            const isSelectedDim = selectedKey === key && pickerLevel === 'prompt';
            return (
              <div
                key={key}
                onMouseEnter={() => {
                  setSelectedKey(key);
                  setPickerLevel('group');
                  setSelectedPromptIdx(0);
                }}
                onClick={() => {
                  setSelectedKey(key);
                  const groupPrompts = prompts.filter(p => String(p.group_id) === String(item.group.id));
                  if (groupPrompts.length > 0) {
                    setPickerLevel('prompt');
                    setSelectedPromptIdx(0);
                  }
                }}
                style={rowStyle(isSelectedActive, isSelectedDim)}
              >
                <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {item.group.name}
                </span>
                <span style={{ opacity: 0.55, marginLeft: 8 }}>›</span>
              </div>
            );
          }
          const ungroupedList = flatLeft.filter(x => x.kind === 'prompt');
          const idx = ungroupedList.indexOf(item);
          const key = `ungrouped:${idx}`;
          const isSelected = selectedKey === key;
          return (
            <div
              key={`p-${item.prompt.id ?? idx}`}
              onMouseEnter={() => {
                setSelectedKey(key);
                setPickerLevel('group');
                setSelectedPromptIdx(0);
              }}
              onClick={() => { void handleSelectPrompt(item.prompt); }}
              style={rowStyle(isSelected)}
            >
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {item.prompt.title}
              </span>
            </div>
          );
        })}
      </div>

      {/* RIGHT panel — slot is ALWAYS in the layout (so the left panel never
          recenters), but visually hidden when the focused left row is not a
          group. The wrapper holds the width reservation; the inner panel is
          only visible for groups. Empty groups show a "пусто" placeholder. */}
      <div style={{ width: RIGHT_W, flexShrink: 0 }}>
        {selectedLeftItem?.kind === 'group' && (
          <div style={panelStyle}>
            {rightPrompts.length > 0 && rightPrompts.map((p, i) => {
              const isSelected = pickerLevel === 'prompt' && i === selectedPromptIdx;
              return (
                <div
                  key={`rp-${p.id ?? i}`}
                  onMouseEnter={() => {
                    setPickerLevel('prompt');
                    setSelectedPromptIdx(i);
                  }}
                  onClick={() => { void handleSelectPrompt(p); }}
                  style={rowStyle(isSelected)}
                >
                  <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {p.title}
                  </span>
                </div>
              );
            })}
            {rightPrompts.length === 0 && (
              <div style={placeholderStyle}>пусто</div>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
};

export default PromptPickerOverlay;
