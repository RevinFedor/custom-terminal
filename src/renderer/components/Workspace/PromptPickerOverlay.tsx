import React, { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useUIStore } from '../../store/useUIStore';
import {
  appendHistoryDraftInsertion,
  buildProjectScriptRows,
  isCurrentPickerGeneration,
  joinPromptInsertionText,
  resolveHistoryScriptCwd,
} from '../../utils/promptInsertMenuModel.mjs';

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

interface ScriptRow {
  id: string;
  label: string;
  text: string;
}

type InsertTarget =
  | { surface: 'history'; tabId: string }
  | { surface: 'sdk'; tabId: string }
  | { surface: 'terminal'; tabId: string };

interface HistoryInsertMenuRequest {
  tabId: string;
  cwd: string;
  x: number;
  y: number;
  requestId: number;
}

function isVisibleElement(element: Element | null): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  const style = window.getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden';
}

function findVisibleHistoryComposer(tabId: string): HTMLElement | null {
  const candidates = Array.from(document.querySelectorAll('[data-history-composer-tab-id]'));
  return candidates.find((candidate) => (
    candidate.getAttribute('data-history-composer-tab-id') === tabId
    && isVisibleElement(candidate)
  )) as HTMLElement | undefined || null;
}

async function readPromptFileContents(filePaths: string[] | undefined): Promise<string[]> {
  if (!filePaths || filePaths.length === 0) return [];
  try {
    const filesResult = await ipcRenderer.invoke('ai-prompts:read-files', filePaths);
    if (filesResult?.success && Array.isArray(filesResult.data)) {
      return filesResult.data.map((file: any) => String(file?.content || ''));
    }
  } catch (err) {
    console.warn('[PromptPicker] ai-prompts:read-files failed:', err);
  }
  return [];
}

function dispatchHistoryComposerInsert(tabId: string, text: string, source: string) {
  if (!text) return;
  const event = new CustomEvent('history-panel:composer-insert', {
    detail: { tabId, text, source },
    cancelable: true,
  });
  const handledByMountedComposer = !window.dispatchEvent(event);
  if (handledByMountedComposer) return;

  const store = useUIStore.getState();
  const current = store.historyPromptDrafts[tabId] || '';
  store.setHistoryPromptDraft(
    tabId,
    appendHistoryDraftInsertion(current, text),
    { preserveImages: true },
  );
}

// One delivery contract for the shortcut picker and History's context picker.
// Context-menu requests pass a captured target; normal Opt+V captures its
// effective target when the picker opens. Selection never re-reads active tab.
async function deliverPrompt(prompt: PromptRow, target: InsertTarget) {
  const text = prompt.content || '';
  if (!text && (!prompt.file_paths || prompt.file_paths.length === 0)) return;

  if (target.surface === 'history') {
    const fileContents = await readPromptFileContents(prompt.file_paths);
    dispatchHistoryComposerInsert(
      target.tabId,
      joinPromptInsertionText(text, fileContents),
      'prompt-picker',
    );
    return;
  }

  if (target.surface === 'sdk') {
    if (text) {
      window.dispatchEvent(new CustomEvent('claude-sdk:composer-insert', {
        detail: { tabId: target.tabId, text },
      }));
    }
    return;
  }

  if (text) ipcRenderer.send('terminal:input', target.tabId, text);
  if (prompt.file_paths && prompt.file_paths.length > 0) {
    const fileContents = await readPromptFileContents(prompt.file_paths);
    for (const content of fileContents) {
      await ipcRenderer.invoke('terminal:paste', {
        tabId: target.tabId,
        content,
        submit: false,
      });
    }
  }
}

// SDK composer textarea. All SDK tabs stay mounted in the DOM under
// `<div class="absolute inset-0 flex flex-col" style="display:none|flex">`
// (visibility toggle, not unmount). A blind `document.querySelector('textarea')`
// finds the textarea of a HIDDEN tab — its getBoundingClientRect is (0,0,0,0),
// which is why the picker was landing in the top-left corner.
// We replicate the same visible-tab scan ClaudeSDKTab uses internally:
// among all SDK roots, pick the one with computed display !== 'none'.
function findSDKTextarea(): HTMLTextAreaElement | null {
  const roots = Array.from(
    document.querySelectorAll('.absolute.inset-0.flex.flex-col')
  ) as HTMLElement[];
  for (const root of roots) {
    const display = root.style?.display || window.getComputedStyle(root).display;
    if (display === 'none') continue;
    const ta = root.querySelector('textarea') as HTMLTextAreaElement | null;
    if (!ta) continue;
    // Defense in depth: skip textareas whose bounding rect is zero (parent
    // hidden via class instead of inline style, etc.). Caret measurement
    // against a zero-rect element is exactly the bug we are avoiding.
    const r = ta.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    return ta;
  }
  return null;
}

// Mirror-div technique to get pixel coordinates of the caret inside a
// textarea. Builds an invisible div with identical text-affecting styles,
// inserts the value up to `position`, then measures a marker span. Standard
// approach (same as textarea-caret-coordinates package), inlined to avoid
// a dependency. Returns viewport-relative coords (already accounts for the
// textarea's bounding rect and scroll position).
function getSDKCaretViewportRect(ta: HTMLTextAreaElement): { left: number; top: number; height: number } | null {
  try {
    const position = ta.selectionEnd ?? ta.value.length;
    const computed = window.getComputedStyle(ta);
    const div = document.createElement('div');
    document.body.appendChild(div);
    const style = div.style;
    style.position = 'absolute';
    style.visibility = 'hidden';
    style.whiteSpace = 'pre-wrap';
    style.wordWrap = 'break-word';
    style.top = '0';
    style.left = '0';

    const properties: (keyof CSSStyleDeclaration)[] = [
      'direction', 'boxSizing', 'width', 'height', 'overflowX', 'overflowY',
      'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
      'borderStyle',
      'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
      'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch', 'fontSize',
      'fontSizeAdjust', 'lineHeight', 'fontFamily',
      'textAlign', 'textTransform', 'textIndent', 'textDecoration',
      'letterSpacing', 'wordSpacing',
      'tabSize',
    ];
    properties.forEach((prop) => {
      (style as any)[prop] = (computed as any)[prop];
    });

    div.textContent = ta.value.substring(0, position);
    const span = document.createElement('span');
    span.textContent = ta.value.substring(position) || '.';
    div.appendChild(span);

    const lineH = parseFloat(computed.lineHeight) || parseFloat(computed.fontSize) * 1.2 || 20;
    const localTop = span.offsetTop - ta.scrollTop;
    const localLeft = span.offsetLeft - ta.scrollLeft;
    document.body.removeChild(div);

    const rect = ta.getBoundingClientRect();
    return {
      left: rect.left + localLeft,
      top: rect.top + localTop,
      height: lineH,
    };
  } catch {
    return null;
  }
}

const PromptPickerOverlay: React.FC = () => {
  const shortcutOpen = useUIStore((s) => s.promptPickerOpen);
  const setOpen = useUIStore((s) => s.setPromptPickerOpen);
  const showToast = useUIStore((s) => s.showToast);
  const fontSize = useUIStore((s) => s.promptPickerFontSize);
  const bottomOffsetPx = useUIStore((s) => s.promptPickerBottomOffsetPx);
  const leftOffsetPx = useUIStore((s) => s.promptPickerLeftOffsetPx);
  const rightOffsetPx = useUIStore((s) => s.promptPickerRightOffsetPx);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const rootPanelRef = useRef<HTMLDivElement | null>(null);
  const leftPanelRef = useRef<HTMLDivElement | null>(null);
  const rightPanelRef = useRef<HTMLDivElement | null>(null);
  const requestSeqRef = useRef(0);
  const activePickerGenerationRef = useRef(0);

  const [groups, setGroups] = useState<PromptGroupRow[]>([]);
  const [prompts, setPrompts] = useState<PromptRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [contextRequest, setContextRequest] = useState<HistoryInsertMenuRequest | null>(null);
  const [shortcutTarget, setShortcutTarget] = useState<InsertTarget | null>(null);
  const [scripts, setScripts] = useState<ScriptRow[]>([]);
  const [scriptsLoaded, setScriptsLoaded] = useState(false);
  const open = shortcutOpen || contextRequest !== null;
  const contextMode = contextRequest !== null;

  // selectedKey: 'group:<id>' or 'ungrouped:<idx>'.
  // Context mode adds one root level in front of the existing prompt library.
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [pickerLevel, setPickerLevel] = useState<'root' | 'group' | 'prompt' | 'scripts'>('group');
  const [selectedPromptIdx, setSelectedPromptIdx] = useState(0);
  const [selectedRoot, setSelectedRoot] = useState<'prompts' | 'scripts'>('prompts');
  const [selectedScriptIdx, setSelectedScriptIdx] = useState(0);

  // History owns the right-click coordinates and target. Capturing both here
  // prevents a native/user delay from redirecting insertion after a tab switch.
  useEffect(() => {
    const onOpenHistoryMenu = (event: Event) => {
      const detail = (event as CustomEvent<{
        tabId?: string;
        cwd?: string;
        x?: number;
        y?: number;
      }>).detail || {};
      if (
        typeof detail.tabId !== 'string'
        || !detail.tabId
        || typeof detail.x !== 'number'
        || typeof detail.y !== 'number'
      ) return;

      const requestId = ++requestSeqRef.current;
      activePickerGenerationRef.current = requestId;
      setOpen(false);
      setContextRequest({
        tabId: detail.tabId,
        cwd: typeof detail.cwd === 'string' ? detail.cwd : '',
        x: detail.x,
        y: detail.y,
        requestId,
      });
      setSelectedKey(null);
      setSelectedRoot('prompts');
      setPickerLevel('root');
      setSelectedPromptIdx(0);
      setSelectedScriptIdx(0);
    };
    window.addEventListener('history-panel:open-insert-menu', onOpenHistoryMenu);
    return () => window.removeEventListener('history-panel:open-insert-menu', onOpenHistoryMenu);
  }, [setOpen]);

  // Opt+V replaces an open context picker rather than letting two input
  // surfaces remain armed at once.
  useEffect(() => {
    if (shortcutOpen && contextRequest) {
      activePickerGenerationRef.current = ++requestSeqRef.current;
      setContextRequest(null);
    }
  }, [contextRequest, shortcutOpen]);

  // Anchor strategies:
  //   sdk-caret  — SDK composer is the active tab; pin to caret pixel position
  //                inside the textarea (mirror-div measurement). User asked for
  //                placement right of the blinking text caret.
  //   bottom-center — anything else (PTY terminal, no active tab, missing
  //                composer DOM); fixed center-bottom of viewport with a
  //                user-controlled offset (Settings → "Picker — отступ снизу").
  type Anchor =
    | { mode: 'sdk-caret'; x: number; y: number; lineH: number }
    | { mode: 'bottom-center' }
    | { mode: 'point'; x: number; y: number };
  const [anchor, setAnchor] = useState<Anchor>({ mode: 'bottom-center' });

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoaded(false);
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
  }, [open, contextRequest?.requestId]);

  useEffect(() => {
    if (!contextRequest) {
      setScripts([]);
      setScriptsLoaded(false);
      return;
    }
    let cancelled = false;
    setScripts([]);
    setScriptsLoaded(false);
    (async () => {
      const liveCwd = await ipcRenderer
        .invoke('terminal:getCwd', contextRequest.tabId)
        .catch(() => null);
      if (cancelled) return;
      const cwd = resolveHistoryScriptCwd(liveCwd, contextRequest.cwd);
      if (!cwd) {
        if (!cancelled) setScriptsLoaded(true);
        return;
      }
      const [packageResult, shellResult] = await Promise.all([
        ipcRenderer.invoke('file:read', `${cwd.replace(/\/+$/, '')}/package.json`).catch(() => null),
        ipcRenderer.invoke('file:list-sh-scripts', cwd).catch(() => null),
      ]);
      if (cancelled) return;
      const packageContent = packageResult?.success ? String(packageResult.content || '') : '';
      const shellFiles = shellResult?.success && Array.isArray(shellResult.files)
        ? shellResult.files
        : [];
      setScripts(buildProjectScriptRows(packageContent, shellFiles));
      setScriptsLoaded(true);
    })();
    return () => { cancelled = true; };
  }, [contextRequest]);

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
    setSelectedKey((current) => {
      if (current?.startsWith('group:')) {
        const groupId = current.slice('group:'.length);
        if (flatLeft.some((item) => item.kind === 'group' && String(item.group.id) === groupId)) {
          return current;
        }
      } else if (current?.startsWith('ungrouped:')) {
        const index = Number.parseInt(current.slice('ungrouped:'.length), 10);
        const ungrouped = flatLeft.filter((item) => item.kind === 'prompt');
        if (Number.isInteger(index) && index >= 0 && index < ungrouped.length) return current;
      }
      const first = flatLeft[0];
      if (!first) return null;
      return first.kind === 'group' ? `group:${first.group.id}` : 'ungrouped:0';
    });
  }, [open, loaded, flatLeft]);

  const resolveTarget = useCallback((): InsertTarget | null => {
    const state = useWorkspaceStore.getState();
    const effectiveId = state.getEffectiveTabId();
    if (!effectiveId) return null;
    if (findVisibleHistoryComposer(effectiveId)) {
      return { tabId: effectiveId, surface: 'history' };
    }
    for (const [, ws] of state.openProjects) {
      const tab = ws.tabs.get(effectiveId);
      if (tab) {
        return {
          tabId: effectiveId,
          surface: tab.tabType === 'claude-sdk' ? 'sdk' : 'terminal',
        };
      }
    }
    return { tabId: effectiveId, surface: 'terminal' };
  }, []);

  // Capture Opt+V target once per opening. Context mode already captured its
  // target in the event payload and never calls this resolver.
  useLayoutEffect(() => {
    if (!shortcutOpen || contextMode) return;
    const generation = ++requestSeqRef.current;
    activePickerGenerationRef.current = generation;
    setShortcutTarget(resolveTarget());
    setSelectedKey(null);
    setSelectedRoot('prompts');
    setPickerLevel('group');
    setSelectedPromptIdx(0);
    setSelectedScriptIdx(0);
    return () => {
      if (activePickerGenerationRef.current === generation) {
        activePickerGenerationRef.current = 0;
      }
    };
  }, [contextMode, resolveTarget, shortcutOpen]);

  // Decide anchor each time picker opens:
  //   1) History context request → exact pointer coordinates.
  //   2) SDK tab + textarea DOM reachable + caret measurable → caret-anchor.
  //   3) Anything else → fixed bottom-center with user-configured offset.
  // Decision is made ONCE on open so arrow-nav doesn't drift the picker.
  useEffect(() => {
    if (!open) return;
    if (contextRequest) {
      setAnchor({ mode: 'point', x: contextRequest.x, y: contextRequest.y });
      return;
    }
    const target = shortcutTarget || resolveTarget();
    if (target?.surface === 'sdk') {
      const ta = findSDKTextarea();
      if (ta) {
        const c = getSDKCaretViewportRect(ta);
        if (c) {
          setAnchor({ mode: 'sdk-caret', x: c.left, y: c.top, lineH: c.height });
          return;
        }
      }
    }
    setAnchor({ mode: 'bottom-center' });
  }, [contextRequest, open, resolveTarget, shortcutTarget]);

  const closePicker = useCallback((expectedGeneration?: number) => {
    if (
      expectedGeneration !== undefined
      && !isCurrentPickerGeneration(expectedGeneration, activePickerGenerationRef.current)
    ) return false;

    const closeSequence = ++requestSeqRef.current;
    activePickerGenerationRef.current = 0;
    const target: InsertTarget | null = contextRequest
      ? { surface: 'history', tabId: contextRequest.tabId }
      : shortcutTarget;
    if (contextRequest) setContextRequest(null);
    else setOpen(false);
    setSelectedKey(null);
    setPickerLevel('group');
    setSelectedPromptIdx(0);
    setSelectedScriptIdx(0);
    setShortcutTarget(null);
    // History and a floating xterm can both exist for one tab. The generic
    // refocus bus would let the xterm steal focus immediately after History
    // insertion, so History gets its explicit composer event.
    requestAnimationFrame(() => {
      if (requestSeqRef.current !== closeSequence) return;
      try {
        if (target?.surface === 'history') {
          window.dispatchEvent(new CustomEvent('history-panel:focus-composer', {
            detail: { tabId: target.tabId },
          }));
        } else {
          window.dispatchEvent(new CustomEvent('nt:window-refocus-active'));
        }
      } catch {}
    });
    return true;
  }, [contextRequest, setOpen, shortcutTarget]);

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

  // When a non-group left row is selected, snap the prompt child level back.
  // (prompt-level only makes sense over the right panel).
  useEffect(() => {
    if (selectedLeftItem && selectedLeftItem.kind !== 'group' && pickerLevel === 'prompt') {
      setPickerLevel('group');
    }
  }, [selectedLeftItem, pickerLevel]);

  const handleSelectPrompt = useCallback(async (prompt: PromptRow) => {
    const generation = contextRequest?.requestId || activePickerGenerationRef.current;
    const target: InsertTarget | null = contextRequest
      ? { surface: 'history', tabId: contextRequest.tabId }
      : shortcutTarget;
    if (!target) {
      showToast('No active tab', 'error');
      closePicker();
      return;
    }
    await deliverPrompt(prompt, target);
    closePicker(generation);
  }, [closePicker, contextRequest, shortcutTarget, showToast]);

  const handleSelectScript = useCallback((script: ScriptRow) => {
    if (!contextRequest) return;
    const generation = contextRequest.requestId;
    dispatchHistoryComposerInsert(contextRequest.tabId, script.text, 'history-insert-menu-script');
    closePicker(generation);
  }, [closePicker, contextRequest]);

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

      e.preventDefault();
      e.stopPropagation();
      if (typeof (e as any).stopImmediatePropagation === 'function') {
        (e as any).stopImmediatePropagation();
      }

      if (k === 'Escape') { closePicker(); return; }

      if (contextMode && pickerLevel === 'root') {
        const moveRoot = (next: 'prompts' | 'scripts') => {
          setSelectedRoot(next);
          setSelectedPromptIdx(0);
          setSelectedScriptIdx(0);
        };
        if (k === 'ArrowDown' || k === 'ArrowUp') {
          moveRoot(selectedRoot === 'prompts' ? 'scripts' : 'prompts');
          return;
        }
        if (k === 'ArrowLeft') { closePicker(); return; }
        if (k === 'ArrowRight' || k === 'Enter') {
          setPickerLevel(selectedRoot === 'prompts' ? 'group' : 'scripts');
          return;
        }
      }

      if (pickerLevel === 'scripts') {
        if (k === 'ArrowDown') {
          if (scripts.length > 0) setSelectedScriptIdx((idx) => (idx + 1) % scripts.length);
          return;
        }
        if (k === 'ArrowUp') {
          if (scripts.length > 0) setSelectedScriptIdx((idx) => (idx - 1 + scripts.length) % scripts.length);
          return;
        }
        if (k === 'ArrowLeft') {
          setPickerLevel('root');
          return;
        }
        if (k === 'ArrowRight' || k === 'Enter') {
          const script = scripts[selectedScriptIdx];
          if (script) handleSelectScript(script);
          return;
        }
      }

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
        if (k === 'ArrowLeft') {
          if (contextMode) setPickerLevel('root');
          else closePicker();
          return;
        }
        if (k === 'Enter') {
          if (selectedLeftItem?.kind === 'prompt') {
            void handleSelectPrompt(selectedLeftItem.prompt);
          } else if (selectedLeftItem?.kind === 'group' && rightPrompts.length > 0) {
            setPickerLevel('prompt');
            setSelectedPromptIdx(0);
          }
          return;
        }
      } else if (pickerLevel === 'prompt') {
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
  }, [
    closePicker,
    contextMode,
    flatLeft,
    handleSelectPrompt,
    handleSelectScript,
    open,
    pickerLevel,
    rightPrompts,
    scripts,
    selectedKey,
    selectedLeftItem,
    selectedPromptIdx,
    selectedRoot,
    selectedScriptIdx,
  ]);

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
  const ROW_PAD_Y = Math.max(3, Math.round(fontSize * 0.33));
  const ROW_PAD_X = Math.max(6, Math.round(fontSize * 0.66));
  const PANEL_PAD = 3;
  const GAP = 6;
  const ROOT_W = Math.max(120, Math.round(fontSize * 12));
  const LEFT_W = Math.max(140, Math.round(fontSize * 15));
  const RIGHT_W = Math.max(160, Math.round(fontSize * 17));
  const MAX_H = 460;

  // Position & flip state. Computed from real measured sizes after mount —
  // until first measurement lands we render off-screen but mounted so
  // getBoundingClientRect returns meaningful numbers.
  //
  // The MAIN picker (left column) always opens downward from its anchor.
  // No vertical mirroring — the user explicitly asked for "down only"; if the
  // caret is close to the bottom the picker is clamped to viewport bottom and
  // overlaps a few pixels of the input, which is acceptable.
  //
  //   rightFlipUp = right (group-content) panel grows upward from the bottom
  //                 of the left panel instead of downward. Triggered when the
  //                 right panel would clip the viewport bottom — left column
  //                 stays put, only the secondary panel reorients.
  const [pos, setPos] = useState<{ left: number; top: number; rightFlipUp: boolean } | null>(null);
  const estW = contextMode
    ? ROOT_W + (
      pickerLevel === 'root'
        ? 0
        : GAP + LEFT_W + (selectedRoot === 'prompts' ? GAP + RIGHT_W : 0)
    ) + PANEL_PAD * 3
    : LEFT_W + GAP + RIGHT_W + PANEL_PAD * 2;
  const estH = MAX_H;

  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    if (typeof window === 'undefined') return;

    const margin = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Picker root size — for the sdk-caret anchor we want the picker's full
    // bounding box. For bottom-center the same measurement decides whether
    // we can fit the offset (we'll clamp into viewport regardless).
    const measuredW = rootRef.current?.offsetWidth ?? estW;
    const measuredH = rootRef.current?.offsetHeight ?? estH;

    // Right panel height is needed for the secondary flip independent of the
    // overall picker height — left panel determines the picker root height
    // when right is absolute-positioned, so we read right's own height here.
    const rightH = rightPanelRef.current?.offsetHeight ?? 0;
    const leftH = leftPanelRef.current?.offsetHeight ?? measuredH;

    let left: number;
    let top: number;

    if (anchor.mode === 'sdk-caret') {
      // Always anchor BELOW + right of the caret. If there's not enough space
      // below — let the bottom viewport clamp (further down) push the whole
      // picker up. We deliberately do NOT mirror to above the caret line:
      // user explicitly asked for downward-only opening; covering a couple of
      // pixels of the input is fine. The "flip up" behavior stays reserved
      // for the right (group-contents) panel — that's the only case where
      // reversing direction is needed.
      left = anchor.x + 6;
      top = anchor.y + anchor.lineH + 4;
    } else if (anchor.mode === 'point') {
      left = anchor.x + 2;
      top = anchor.y + 2;
    } else {
      // bottom-center fallback. Horizontal placement priority:
      //   rightOffsetPx > 0 → pin to RIGHT edge with that gap
      //   leftOffsetPx  > 0 → pin to LEFT edge with that gap
      //   both zero        → centered
      // Right wins over left so the user can use just one slider and know it
      // takes effect; the other can stay at 0 as "don't care".
      if (rightOffsetPx > 0) {
        left = vw - measuredW - rightOffsetPx;
      } else if (leftOffsetPx > 0) {
        left = leftOffsetPx;
      } else {
        left = Math.round(vw / 2 - measuredW / 2);
      }
      top = vh - measuredH - bottomOffsetPx;
      if (top < margin) top = margin;
    }

    // Horizontal viewport clamp (vertical clamp already handled per-mode).
    if (left + measuredW + margin > vw) left = vw - measuredW - margin;
    if (left < margin) left = margin;
    if (top + measuredH + margin > vh) top = vh - measuredH - margin;
    if (top < margin) top = margin;

    // Right panel secondary flip. Anchor for the right panel is the picker
    // root's top. If renders downward (top:0 of wrapper) it would overflow
    // viewport bottom — switch to upward growth (bottom:0 of wrapper, aligned
    // with the BOTTOM of the left panel, expanding above it).
    let rightFlipUp = false;
    if (
      rightH > 0
      && selectedRoot === 'prompts'
      && selectedLeftItem?.kind === 'group'
    ) {
      const rightBottomIfDown = top + rightH;
      if (rightBottomIfDown + margin > vh) rightFlipUp = true;
      // Also flip if the right panel is taller than the left panel by enough
      // that even sharing the top edge clips the viewport — the user's case
      // of "second window is too tall, has to open upward".
      if (rightH > leftH && top + rightH + margin > vh) rightFlipUp = true;
    }

    setPos({ left, top, rightFlipUp });
  }, [
    anchor,
    bottomOffsetPx,
    estH,
    estW,
    flatLeft.length,
    leftOffsetPx,
    open,
    pickerLevel,
    rightOffsetPx,
    rightPrompts.length,
    scripts.length,
    selectedKey,
    selectedLeftItem,
    selectedRoot,
  ]);

  if (!open) return null;

  const overlayStyle: React.CSSProperties = {
    position: 'fixed',
    left: pos ? pos.left : -9999,
    top: pos ? pos.top : -9999,
    zIndex: 99000,
    display: 'flex',
    gap: GAP,
    alignItems: 'flex-start', // left panel grows from top; right is absolute
    pointerEvents: 'auto',
    fontSize,
    opacity: pos ? 1 : 0,
    transform: pos ? 'translateY(0) scale(1)' : 'translateY(3px) scale(0.985)',
    transformOrigin: 'top left',
    transition: 'opacity 90ms ease-out, transform 90ms ease-out',
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

  // Right panel positioning style. Wrapper is `relative` (height matches left
  // panel via flex-stretch), inner panel is absolute so it can overflow above
  // or below without forcing the picker root taller.
  const rightWrapperStyle: React.CSSProperties = {
    width: RIGHT_W,
    flexShrink: 0,
    position: 'relative',
    alignSelf: 'stretch',
  };
  const rightPanelPositionStyle: React.CSSProperties = pos?.rightFlipUp
    ? { position: 'absolute', left: 0, right: 0, bottom: 0 }
    : { position: 'absolute', left: 0, right: 0, top: 0 };

  const promptLibraryVisible = !contextMode
    || (selectedRoot === 'prompts' && pickerLevel !== 'root');
  const scriptsVisible = contextMode
    && selectedRoot === 'scripts'
    && pickerLevel !== 'root';

  return createPortal(
    <div
      ref={rootRef}
      style={overlayStyle}
      data-prompt-picker
      data-prompt-picker-mode={contextMode ? 'history-context' : 'shortcut'}
      data-prompt-picker-target-tab-id={contextRequest?.tabId || shortcutTarget?.tabId || ''}
    >
      {contextMode && (
        <div ref={rootPanelRef} style={{ ...panelStyle, width: ROOT_W }}>
          <div
            onMouseEnter={() => {
              setSelectedRoot('prompts');
              setPickerLevel('group');
              setSelectedPromptIdx(0);
            }}
            onClick={() => {
              setSelectedRoot('prompts');
              setPickerLevel('group');
              setSelectedPromptIdx(0);
            }}
            style={rowStyle(
              selectedRoot === 'prompts' && pickerLevel === 'root',
              selectedRoot === 'prompts' && pickerLevel !== 'root',
            )}
            data-history-insert-menu-root="prompts"
          >
            <span>Insert Prompt</span>
            <span style={{ opacity: 0.55, marginLeft: 8 }}>›</span>
          </div>
          <div
            onMouseEnter={() => {
              setSelectedRoot('scripts');
              setPickerLevel('scripts');
              setSelectedScriptIdx(0);
            }}
            onClick={() => {
              setSelectedRoot('scripts');
              setPickerLevel('scripts');
              setSelectedScriptIdx(0);
            }}
            style={rowStyle(
              selectedRoot === 'scripts' && pickerLevel === 'root',
              selectedRoot === 'scripts' && pickerLevel !== 'root',
            )}
            data-history-insert-menu-root="scripts"
          >
            <span>Scripts</span>
            <span style={{ opacity: 0.55, marginLeft: 8 }}>›</span>
          </div>
        </div>
      )}

      {promptLibraryVisible && (
        <div ref={leftPanelRef} style={{ ...panelStyle, width: LEFT_W }}>
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
      )}

      {scriptsVisible && (
        <div style={{ ...panelStyle, width: LEFT_W }} data-history-insert-menu-scripts>
          {!scriptsLoaded && (
            <div style={placeholderStyle}>Loading…</div>
          )}
          {scriptsLoaded && scripts.length === 0 && (
            <div style={placeholderStyle}>No scripts</div>
          )}
          {scriptsLoaded && scripts.map((script, index) => (
            <div
              key={script.id}
              onMouseEnter={() => {
                setPickerLevel('scripts');
                setSelectedScriptIdx(index);
              }}
              onClick={() => handleSelectScript(script)}
              style={rowStyle(pickerLevel === 'scripts' && selectedScriptIdx === index)}
              data-history-insert-menu-script={script.id}
            >
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {script.label}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Prompt children may grow upward independently when the viewport edge
          would otherwise clip the second column. */}
      {promptLibraryVisible && (
        <div style={rightWrapperStyle}>
          {selectedLeftItem?.kind === 'group' && (
            <div ref={rightPanelRef} style={{ ...panelStyle, ...rightPanelPositionStyle }}>
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
      )}
    </div>,
    document.body
  );
};

export default PromptPickerOverlay;
