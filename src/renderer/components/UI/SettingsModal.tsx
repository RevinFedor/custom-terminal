import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useUIStore } from '../../store/useUIStore';
import { usePromptsStore, AIPrompt, AIModel, ThinkingLevel } from '../../store/usePromptsStore';

const { ipcRenderer } = window.require('electron');

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface PromptGroup {
  id: number;
  name: string;
  description: string;
  position: number;
  is_collapsed: boolean;
}

interface Prompt {
  title: string;
  content: string;
  group_id?: number | null;
  position?: number;
}

type SettingsTab = 'shortcuts' | 'fonts' | 'colors' | 'ai';

const DEFAULT_DOC_FILE_PATH = '/Users/fedor/Global-Templates/🧩 Code-Patterns/документация/docs-rules.prompt.md';

// Track if settings was opened at least once (for default tab)
let hasOpenedBefore = false;
let lastActiveTab: SettingsTab = 'ai';

// Shortcuts data
const SHORTCUTS = [
  { keys: '⌘ + T', description: 'Новый таб' },
  { keys: '⌘ + \\', description: 'Открыть VS Code в текущей директории' },
  { keys: '⌘ + B', description: 'Показать/скрыть боковую панель' },
  { keys: '⌘ + ,', description: 'Открыть настройки' },
  { keys: '⌘ + E', description: 'Редактор заметок проекта' },
  { keys: '⌘ + S', description: 'Сохранить заметки (в редакторе)' },
  { keys: '⌘ + ⇧ + R', description: 'Перезагрузить приложение' },
];

// Font size slider component
function FontSizeSlider({
  label,
  description,
  value,
  onChange,
  min,
  max
}: {
  label: string;
  description: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
}) {
  return (
    <div style={{
      padding: '14px',
      backgroundColor: '#222',
      border: '1px solid #333',
      borderRadius: '10px',
      marginBottom: '12px'
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
        <div>
          <div style={{ fontSize: '14px', color: '#fff', fontWeight: '500' }}>{label}</div>
          <div style={{ fontSize: '12px', color: '#666' }}>{description}</div>
        </div>
        <div style={{
          fontSize: '14px',
          color: '#fff',
          backgroundColor: '#333',
          padding: '4px 12px',
          borderRadius: '6px',
          minWidth: '50px',
          textAlign: 'center'
        }}>
          {value}px
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <button
          onClick={() => onChange(Math.max(min, value - 1))}
          style={{
            width: '28px',
            height: '28px',
            borderRadius: '6px',
            border: '1px solid #444',
            backgroundColor: '#333',
            color: '#fff',
            cursor: 'pointer',
            fontSize: '16px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
          -
        </button>
        <input
          type="range"
          min={min}
          max={max}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          style={{
            flex: 1,
            height: '4px',
            borderRadius: '2px',
            appearance: 'none',
            background: `linear-gradient(to right, #666 0%, #666 ${((value - min) / (max - min)) * 100}%, #333 ${((value - min) / (max - min)) * 100}%, #333 100%)`,
            cursor: 'pointer'
          }}
        />
        <button
          onClick={() => onChange(Math.min(max, value + 1))}
          style={{
            width: '28px',
            height: '28px',
            borderRadius: '6px',
            border: '1px solid #444',
            backgroundColor: '#333',
            color: '#fff',
            cursor: 'pointer',
            fontSize: '16px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
          +
        </button>
      </div>
    </div>
  );
}

export default function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  // Use last active tab if opened before, otherwise default to shortcuts
  const [activeTab, setActiveTab] = useState<SettingsTab>(() => {
    return hasOpenedBefore ? lastActiveTab : 'ai';
  });

  const terminalFontSize = useUIStore((s) => s.terminalFontSize);
  const tabsFontSize = useUIStore((s) => s.tabsFontSize);
  const projectTabsFontSize = useUIStore((s) => s.projectTabsFontSize);
  const setTerminalFontSize = useUIStore((s) => s.setTerminalFontSize);
  const setTabsFontSize = useUIStore((s) => s.setTabsFontSize);
  const setProjectTabsFontSize = useUIStore((s) => s.setProjectTabsFontSize);
  const tabNotesFontSize = useUIStore((s) => s.tabNotesFontSize);
  const setTabNotesFontSize = useUIStore((s) => s.setTabNotesFontSize);
  const tabNotesPaddingX = useUIStore((s) => s.tabNotesPaddingX);
  const setTabNotesPaddingX = useUIStore((s) => s.setTabNotesPaddingX);
  const tabNotesPaddingY = useUIStore((s) => s.tabNotesPaddingY);
  const setTabNotesPaddingY = useUIStore((s) => s.setTabNotesPaddingY);
  const { showToast, docPrompt, setDocPromptUseFile, setDocPromptFilePath, setDocPromptInlineContent, claudeDefaultPromptEnabled, setClaudeDefaultPromptEnabled } = useUIStore();
  const { prompts: aiPrompts, loadPrompts: loadAIPrompts, savePrompt: saveAIPrompt, deletePrompt: deleteAIPrompt, rewindPromptId, setRewindPromptId } = usePromptsStore();

  // Claude Default Prompt
  const [claudeDefaultPrompt, setClaudeDefaultPrompt] = useState('');

  // Doc prompt local state
  const [localDocFilePath, setLocalDocFilePath] = useState('');
  const [localDocInlineContent, setLocalDocInlineContent] = useState('');

  // User prompts (text insertion snippets, not AI prompts)
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [promptGroups, setPromptGroups] = useState<PromptGroup[]>([]);
  const [editingGroupId, setEditingGroupId] = useState<number | null>(null);
  const [localGroupName, setLocalGroupName] = useState('');
  const [localGroupDescription, setLocalGroupDescription] = useState('');
  const [savedGroupFlash, setSavedGroupFlash] = useState<'name' | 'description' | null>(null);
  const savedGroupTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [dragOverGroupId, setDragOverGroupId] = useState<number | 'ungrouped' | null>(null);
  const dragOverGroupRef = useRef<number | 'ungrouped' | null>(null);
  const [draggingFlatIdx, setDraggingFlatIdx] = useState<number | null>(null);
  const [flatDropTarget, setFlatDropTarget] = useState<number | null>(null);
  const [flatDragReady, setFlatDragReady] = useState(false);
  const floatingFlatCloneRef = useRef<HTMLDivElement | null>(null);
  const dragFlatItemHeight = useRef(0);

  // Editing states
  const [editingClaude, setEditingClaude] = useState(false);
  const [editingPromptId, setEditingPromptId] = useState<string | null>(null); // AI prompt being edited
  const [editingDocPrompt, setEditingDocPrompt] = useState(false);
  const [editingPostCheck, setEditingPostCheck] = useState(false);
  const [localPostCheckContent, setLocalPostCheckContent] = useState('');
  const [editingInsertionIndex, setEditingInsertionIndex] = useState<number | null>(null);
  const [localInsertionTitle, setLocalInsertionTitle] = useState('');
  const [localInsertionContent, setLocalInsertionContent] = useState('');
  const [savedInsertionFlash, setSavedInsertionFlash] = useState<'title' | 'content' | null>(null);
  const savedInsertionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [draggingTextIndex, setDraggingTextIndex] = useState<number | null>(null);
  const [textDropTarget, setTextDropTarget] = useState<number | null>(null);
  const [dragTransitionsReady, setDragTransitionsReady] = useState(false);
  const textListRef = useRef<HTMLDivElement>(null);
  const floatingCloneRef = useRef<HTMLDivElement | null>(null);
  const dragCardHeight = useRef(0);

  // Local copies of AI prompt fields for editing
  const [localPromptContent, setLocalPromptContent] = useState('');
  const [localPromptName, setLocalPromptName] = useState('');
  const [localPromptColor, setLocalPromptColor] = useState('');
  const [localPromptShowInMenu, setLocalPromptShowInMenu] = useState(true);
  const [localPromptModel, setLocalPromptModel] = useState<AIModel>('gemini-3-flash-preview');
  const [localPromptThinkingLevel, setLocalPromptThinkingLevel] = useState<ThinkingLevel>('HIGH');
  const [savedFlashField, setSavedFlashField] = useState<'name' | 'content' | null>(null);
  const savedFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Refs for editing containers (to check if blur target is inside)
  const claudeEditRef = useRef<HTMLDivElement>(null);
  const docEditRef = useRef<HTMLDivElement>(null);
  const postCheckEditRef = useRef<HTMLDivElement>(null);


  // Track tab changes
  useEffect(() => {
    if (isOpen) {
      hasOpenedBefore = true;
      lastActiveTab = activeTab;
    }
  }, [activeTab, isOpen]);

  // Enable drag transitions after first render (so initial gap replaces hidden card instantly)
  useEffect(() => {
    if (draggingTextIndex !== null) {
      const id = requestAnimationFrame(() => setDragTransitionsReady(true));
      return () => cancelAnimationFrame(id);
    } else {
      setDragTransitionsReady(false);
    }
  }, [draggingTextIndex]);

  // Load all data on open
  useEffect(() => {
    if (isOpen) {
      // Load Claude default prompt
      ipcRenderer.invoke('app:getState', 'claudeDefaultPrompt').then((value: string | null) => {
        setClaudeDefaultPrompt(value || '');
      });

      // Load AI prompts from DB
      loadAIPrompts();

      // Load doc prompt local state
      setLocalDocFilePath(docPrompt.filePath);
      setLocalDocInlineContent(docPrompt.inlineContent);
      setLocalPostCheckContent(useUIStore.getState().postCheckPrompt);

      // Load user prompts (text insertion snippets) and groups
      ipcRenderer.invoke('prompts:get').then((result: { success: boolean; data?: Prompt[] }) => {
        if (result.success && result.data) {
          setPrompts(result.data);
        }
      });
      ipcRenderer.invoke('prompt-groups:get').then((result: { success: boolean; data?: PromptGroup[] }) => {
        if (result.success && result.data) {
          setPromptGroups(result.data);
        }
      });
    } else {
      // Save current AI prompt before resetting (no flash — modal is closing)
      saveCurrentAIPrompt();
      saveCurrentGroup();
      // Reset editing states when modal closes
      setEditingClaude(false);
      setEditingPromptId(null);
      setEditingDocPrompt(false);
      setEditingPostCheck(false);
      setEditingInsertionIndex(null);
      setEditingGroupId(null);
    }
  }, [isOpen, docPrompt]);

  // Helper: check if blur target is inside container
  const isBlurInsideContainer = (e: React.FocusEvent, containerRef: React.RefObject<HTMLDivElement | null>) => {
    if (!containerRef.current) return false;
    const relatedTarget = e.relatedTarget as Node | null;
    return relatedTarget && containerRef.current.contains(relatedTarget);
  };

  // Save functions (immediate, no debounce)
  const saveClaudePromptImmediate = useCallback((value: string) => {
    ipcRenderer.invoke('app:setState', { key: 'claudeDefaultPrompt', value });
  }, []);

  const saveDocFilePathImmediate = useCallback((value: string) => {
    setDocPromptFilePath(value);
  }, [setDocPromptFilePath]);

  const saveDocInlineContentImmediate = useCallback((value: string) => {
    setDocPromptInlineContent(value);
  }, [setDocPromptInlineContent]);

  const savePromptsImmediate = useCallback(async (newPrompts: Prompt[]) => {
    await ipcRenderer.invoke('prompts:save', newPrompts);
  }, []);

  // Blur handlers
  const handleClaudeBlur = (e: React.FocusEvent) => {
    if (isBlurInsideContainer(e, claudeEditRef)) return;
    saveClaudePromptImmediate(claudeDefaultPrompt);
    setEditingClaude(false);
  };

  // Save current AI prompt from local state to DB (all fields from local state)
  const saveCurrentAIPrompt = (flashField?: 'name' | 'content') => {
    if (editingPromptId) {
      const prompt = aiPrompts.find(p => p.id === editingPromptId);
      if (prompt) {
        saveAIPrompt({
          ...prompt,
          content: localPromptContent,
          name: localPromptName,
          color: localPromptColor,
          showInContextMenu: localPromptShowInMenu,
          model: localPromptModel,
          thinkingLevel: localPromptThinkingLevel
        });
        if (flashField) {
          if (savedFlashTimer.current) clearTimeout(savedFlashTimer.current);
          setSavedFlashField(flashField);
          savedFlashTimer.current = setTimeout(() => setSavedFlashField(null), 400);
        }
      }
    }
  };

  const closeAIPromptEditor = () => {
    saveCurrentAIPrompt();
    setEditingPromptId(null);
  };

  // Save current text insertion from local state
  const saveCurrentInsertion = () => {
    if (editingInsertionIndex !== null && prompts[editingInsertionIndex]) {
      const newPrompts = [...prompts];
      newPrompts[editingInsertionIndex] = { ...newPrompts[editingInsertionIndex], title: localInsertionTitle, content: localInsertionContent };
      setPrompts(newPrompts);
      savePromptsImmediate(newPrompts);
    }
  };

  const startEditingInsertion = (index: number) => {
    if (index === editingInsertionIndex) return;
    saveCurrentInsertion();
    saveCurrentGroup();
    saveCurrentAIPrompt();
    setEditingPromptId(null);
    setEditingGroupId(null);
    setEditingInsertionIndex(index);
    setLocalInsertionTitle(prompts[index].title);
    setLocalInsertionContent(prompts[index].content);
  };

  // Group editing in left panel
  const saveCurrentGroup = () => {
    if (editingGroupId !== null) {
      const g = promptGroups.find(g => g.id === editingGroupId);
      if (g && (g.name !== localGroupName || g.description !== localGroupDescription)) {
        const newGroups = promptGroups.map(g => g.id === editingGroupId ? { ...g, name: localGroupName, description: localGroupDescription } : g);
        setPromptGroups(newGroups);
        ipcRenderer.invoke('prompt-groups:save', newGroups);
      }
    }
  };

  const startEditingGroup = (groupId: number, groupsOverride?: PromptGroup[]) => {
    if (groupId === editingGroupId) return;
    saveCurrentInsertion();
    saveCurrentGroup();
    saveCurrentAIPrompt();
    setEditingPromptId(null);
    setEditingInsertionIndex(null);
    const list = groupsOverride || promptGroups;
    const g = list.find(g => g.id === groupId);
    if (!g) return;
    setEditingGroupId(groupId);
    setLocalGroupName(g.name);
    setLocalGroupDescription(g.description);
  };

  const closeGroupEditor = () => {
    saveCurrentGroup();
    setEditingGroupId(null);
  };

  // Build flat items: groups and ungrouped prompts interleaved by position
  const buildFlatItems = () => {
    const items: Array<{ type: 'group'; group: PromptGroup } | { type: 'prompt'; origIdx: number; prompt: Prompt }> = [];
    promptGroups.forEach(g => items.push({ type: 'group', group: g }));
    prompts.forEach((p, i) => { if (!p.group_id) items.push({ type: 'prompt', origIdx: i, prompt: p }); });
    items.sort((a, b) => {
      const posA = a.type === 'group' ? a.group.position : (a.prompt.position ?? 0);
      const posB = b.type === 'group' ? b.group.position : (b.prompt.position ?? 0);
      return posA - posB;
    });
    return items;
  };

  // Save flat order: assign sequential positions to all flat items
  const saveFlatOrder = (newFlatItems: ReturnType<typeof buildFlatItems>) => {
    const newGroups = [...promptGroups];
    const newPrompts = [...prompts];
    newFlatItems.forEach((item, pos) => {
      if (item.type === 'group') {
        const gIdx = newGroups.findIndex(g => g.id === item.group.id);
        if (gIdx >= 0) newGroups[gIdx] = { ...newGroups[gIdx], position: pos };
      } else {
        newPrompts[item.origIdx] = { ...newPrompts[item.origIdx], position: pos };
      }
    });
    setPromptGroups(newGroups);
    setPrompts(newPrompts);
    ipcRenderer.invoke('prompt-groups:save', newGroups);
    savePromptsImmediate(newPrompts);
  };

  // Unified flat DnD for groups + ungrouped prompts
  const handleFlatItemDrag = (flatIdx: number) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();

    saveCurrentGroup();
    saveCurrentInsertion();
    saveCurrentAIPrompt();
    setEditingGroupId(null);
    setEditingInsertionIndex(null);
    setEditingPromptId(null);

    const card = (e.target as HTMLElement).closest('[data-flat-card]') as HTMLElement | null;
    if (!card) return;
    const fullEl = card.closest('[data-flat-container]') as HTMLElement | null;
    const fullRect = fullEl ? fullEl.getBoundingClientRect() : card.getBoundingClientRect();
    dragFlatItemHeight.current = fullRect.height;

    const cardRect = card.getBoundingClientRect();
    const offsetY = e.clientY - cardRect.top;
    const offsetX = e.clientX - cardRect.left;

    const clone = card.cloneNode(true) as HTMLDivElement;
    clone.style.position = 'fixed';
    clone.style.left = `${cardRect.left}px`;
    clone.style.top = `${cardRect.top}px`;
    clone.style.width = `${cardRect.width}px`;
    clone.style.zIndex = '9999';
    clone.style.pointerEvents = 'none';
    clone.style.boxShadow = '0 2px 4px rgba(0,0,0,0.2)';
    clone.style.border = '2px solid #8b5cf6';
    clone.style.opacity = '0.9';
    clone.style.transform = 'scale(1)';
    clone.style.transition = 'box-shadow 0.15s ease, transform 0.15s ease, opacity 0.15s ease';
    document.body.appendChild(clone);
    requestAnimationFrame(() => {
      clone.style.boxShadow = '0 8px 24px rgba(139,92,246,0.25)';
      clone.style.transform = 'scale(1.02)';
      clone.style.opacity = '1';
    });
    floatingFlatCloneRef.current = clone;

    setDraggingFlatIdx(flatIdx);
    setFlatDropTarget(flatIdx);

    let statics: { idx: number; midY: number }[] | null = null;
    let firstMove = true;
    const flatItems = buildFlatItems();
    console.warn('[FlatDnD] START flatIdx=', flatIdx, 'flatItems=', flatItems.map((it, i) => `${i}:${it.type}${it.type === 'group' ? '(g' + it.group.id + ')' : '(p' + it.origIdx + ')'}`));

    // Track if the dragged item is a prompt (can be dropped into a group)
    const draggedItem = flatItems[flatIdx];
    const isPromptDrag = draggedItem?.type === 'prompt';

    const onMove = (ev: PointerEvent) => {
      if (floatingFlatCloneRef.current) {
        if (firstMove) {
          floatingFlatCloneRef.current.style.transition = 'none';
          firstMove = false;
          requestAnimationFrame(() => setFlatDragReady(true));
        }
        floatingFlatCloneRef.current.style.left = `${ev.clientX - offsetX}px`;
        floatingFlatCloneRef.current.style.top = `${ev.clientY - offsetY}px`;
      }

      // Detect group drop zones (for moving prompts into groups)
      if (isPromptDrag) {
        const groupEls = document.querySelectorAll('[data-group-drop]');
        let foundGroup: number | 'ungrouped' | null = null;
        groupEls.forEach(el => {
          const r = el.getBoundingClientRect();
          if (ev.clientY >= r.top && ev.clientY <= r.bottom && ev.clientX >= r.left && ev.clientX <= r.right) {
            const val = el.getAttribute('data-group-drop');
            foundGroup = val === 'ungrouped' ? 'ungrouped' : Number(val);
          }
        });
        if (foundGroup !== dragOverGroupRef.current) console.warn('[FlatDnD] groupZone changed:', dragOverGroupRef.current, '->', foundGroup);
        dragOverGroupRef.current = foundGroup;
        setDragOverGroupId(foundGroup);
      }

      if (!statics) {
        const listEl = textListRef.current;
        if (!listEl) return;
        statics = [];
        const cards = Array.from(listEl.querySelectorAll('[data-flat-card]')) as HTMLElement[];
        for (const c of cards) {
          if (c.dataset.hidden === 'true') continue;
          const idx = Number(c.dataset.flatIdx);
          const r = c.getBoundingClientRect();
          statics.push({ idx, midY: r.top + r.height / 2 });
        }
      }
      let target = flatItems.length;
      for (const s of statics) {
        if (ev.clientY < s.midY) { target = s.idx; break; }
      }
      setFlatDropTarget(target);
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (floatingFlatCloneRef.current) { floatingFlatCloneRef.current.remove(); floatingFlatCloneRef.current = null; }

      const targetGroup = isPromptDrag ? dragOverGroupRef.current : null;
      console.warn('[FlatDnD] DROP isPromptDrag=', isPromptDrag, 'targetGroup=', targetGroup);
      dragOverGroupRef.current = null;
      setDragOverGroupId(null);

      setFlatDragReady(false);
      setDraggingFlatIdx((fromIdx) => {
        setFlatDropTarget((toPos) => {
          console.warn('[FlatDnD] RESOLVE fromIdx=', fromIdx, 'toPos=', toPos, 'targetGroup=', targetGroup);
          if (fromIdx !== null && toPos !== null) {
            // If an ungrouped prompt was dropped on a group zone → move into group
            if (isPromptDrag && targetGroup !== null && targetGroup !== 'ungrouped' && draggedItem.type === 'prompt') {
              console.warn('[FlatDnD] MOVE TO GROUP origIdx=', draggedItem.origIdx, '→ group', targetGroup);
              // Single atomic update: change group_id + reassign flat positions for remaining items
              const newPrompts = [...prompts];
              newPrompts[draggedItem.origIdx] = { ...newPrompts[draggedItem.origIdx], group_id: targetGroup, position: undefined };
              // Reassign flat positions for remaining ungrouped prompts + groups
              const remainingFlat = flatItems.filter((_, i) => i !== fromIdx);
              const newGroups = [...promptGroups];
              remainingFlat.forEach((item, pos) => {
                if (item.type === 'group') {
                  const gIdx = newGroups.findIndex(g => g.id === item.group.id);
                  if (gIdx >= 0) newGroups[gIdx] = { ...newGroups[gIdx], position: pos };
                } else {
                  newPrompts[item.origIdx] = { ...newPrompts[item.origIdx], position: pos };
                }
              });
              setPrompts(newPrompts);
              setPromptGroups(newGroups);
              savePromptsImmediate(newPrompts);
              ipcRenderer.invoke('prompt-groups:save', newGroups);
            } else {
              // Normal flat reorder
              const adjustedTo = toPos > fromIdx ? toPos - 1 : toPos;
              console.warn('[FlatDnD] REORDER from=', fromIdx, 'adjustedTo=', adjustedTo, fromIdx === adjustedTo ? '(no-op)' : '(apply)');
              if (fromIdx !== adjustedTo) {
                const items = [...flatItems];
                const [moved] = items.splice(fromIdx, 1);
                items.splice(adjustedTo, 0, moved);
                saveFlatOrder(items);
              }
            }
          }
          return null;
        });
        return null;
      });
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const closeInsertionEditor = () => {
    saveCurrentInsertion();
    setEditingInsertionIndex(null);
  };

  // Classic drag-and-drop: floating clone follows cursor, gap shows target
  const handleGripPointerDown = (origIndex: number) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();

    // Clear all editing states so no stale selection remains
    saveCurrentGroup();
    saveCurrentInsertion();
    saveCurrentAIPrompt();
    setEditingGroupId(null);
    setEditingInsertionIndex(null);
    setEditingPromptId(null);

    const card = (e.target as HTMLElement).closest('[data-text-card]') as HTMLElement | null;
    if (!card) return;
    const cardRect = card.getBoundingClientRect();
    const offsetY = e.clientY - cardRect.top;
    const offsetX = e.clientX - cardRect.left;
    dragCardHeight.current = cardRect.height;

    // Create floating clone with pickup animation
    const clone = card.cloneNode(true) as HTMLDivElement;
    clone.style.position = 'fixed';
    clone.style.left = `${cardRect.left}px`;
    clone.style.top = `${cardRect.top}px`;
    clone.style.width = `${cardRect.width}px`;
    clone.style.zIndex = '9999';
    clone.style.pointerEvents = 'none';
    clone.style.boxShadow = '0 2px 4px rgba(0,0,0,0.2)';
    clone.style.border = '2px solid #8b5cf6';
    clone.style.opacity = '0.9';
    clone.style.cursor = 'grabbing';
    clone.style.transform = 'scale(1)';
    clone.style.transition = 'box-shadow 0.15s ease, transform 0.15s ease, opacity 0.15s ease';
    document.body.appendChild(clone);
    // Trigger pickup effect next frame
    requestAnimationFrame(() => {
      clone.style.boxShadow = '0 8px 24px rgba(139,92,246,0.25)';
      clone.style.transform = 'scale(1.02)';
      clone.style.opacity = '1';
    });
    floatingCloneRef.current = clone;

    setDraggingTextIndex(origIndex);
    setTextDropTarget(origIndex);

    // Static midpoints captured once (after React hides dragged card) — prevents jitter
    let statics: { origIdx: number; midY: number }[] | null = null;
    // Flat midpoints for "exit group" preview
    let flatStatics: { idx: number; midY: number }[] | null = null;
    const currentFlatItems = buildFlatItems();
    let firstMove = true;

    const onMove = (ev: PointerEvent) => {
      if (floatingCloneRef.current) {
        if (firstMove) { floatingCloneRef.current.style.transition = 'none'; firstMove = false; }
        floatingCloneRef.current.style.left = `${ev.clientX - offsetX}px`;
        floatingCloneRef.current.style.top = `${ev.clientY - offsetY}px`;
      }

      // Detect group drop zones
      const groupEls = document.querySelectorAll('[data-group-drop]');
      let foundGroup: number | 'ungrouped' | null = null;
      groupEls.forEach(el => {
        const r = el.getBoundingClientRect();
        if (ev.clientY >= r.top && ev.clientY <= r.bottom && ev.clientX >= r.left && ev.clientX <= r.right) {
          const val = el.getAttribute('data-group-drop');
          foundGroup = val === 'ungrouped' ? 'ungrouped' : Number(val);
        }
      });
      dragOverGroupRef.current = foundGroup;
      setDragOverGroupId(foundGroup);

      // When over ungrouped zone: compute flat insertion position for preview
      if (foundGroup === 'ungrouped') {
        if (!flatStatics) {
          const listEl = textListRef.current;
          if (listEl) {
            flatStatics = [];
            const flatCards = Array.from(listEl.querySelectorAll('[data-flat-card]')) as HTMLElement[];
            for (const c of flatCards) {
              if (c.dataset.hidden === 'true') continue;
              const idx = Number(c.dataset.flatIdx);
              const r = c.getBoundingClientRect();
              flatStatics.push({ idx, midY: r.top + r.height / 2 });
            }
          }
        }
        if (flatStatics) {
          let flatTarget = currentFlatItems.length;
          for (const s of flatStatics) {
            if (ev.clientY < s.midY) { flatTarget = s.idx; break; }
          }
          dragFlatItemHeight.current = dragCardHeight.current;
          setDraggingFlatIdx(-1); // sentinel: "grouped prompt exiting to flat"
          setFlatDropTarget(flatTarget);
        }
      } else {
        setDraggingFlatIdx(null);
        setFlatDropTarget(null);
      }

      // Capture midpoints once (after dragged card is hidden)
      if (!statics) {
        const listEl = textListRef.current;
        if (!listEl) return;
        statics = [];
        const cards = Array.from(listEl.querySelectorAll('[data-text-card]')) as HTMLElement[];
        for (const c of cards) {
          if (c.dataset.hidden === 'true') continue;
          const idx = Number(c.dataset.origIndex);
          const r = c.getBoundingClientRect();
          statics.push({ origIdx: idx, midY: r.top + r.height / 2 });
        }
      }
      // Find insertion point using static positions (original array index)
      let target = prompts.length;
      for (const s of statics) {
        if (ev.clientY < s.midY) { target = s.origIdx; break; }
      }
      setTextDropTarget(target);
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (floatingCloneRef.current) {
        floatingCloneRef.current.remove();
        floatingCloneRef.current = null;
      }

      const targetGroup = dragOverGroupRef.current;
      const flatTargetAtDrop = flatDropTarget;
      dragOverGroupRef.current = null;
      setDragOverGroupId(null);
      setDraggingFlatIdx(null);
      setFlatDropTarget(null);

      setDragTransitionsReady(false);
      setDraggingTextIndex((fromIdx) => {
        setTextDropTarget((toPos) => {
          if (fromIdx !== null && toPos !== null) {
            const np = [...prompts];
            const editItem = editingInsertionIndex !== null ? np[editingInsertionIndex] : null;

            console.warn('[GroupedDnD] DROP fromIdx=', fromIdx, 'targetGroup=', targetGroup, 'flatTarget=', flatTargetAtDrop);
            if (targetGroup === 'ungrouped') {
              // Moving from group to ungrouped: insert at flat position based on cursor
              np[fromIdx] = { ...np[fromIdx], group_id: null, position: undefined };
              // Insert into flat list at the position where the user dropped
              const newFlatItems = [...currentFlatItems];
              const insertAt = flatTargetAtDrop ?? currentFlatItems.length;
              newFlatItems.splice(insertAt, 0, { type: 'prompt', origIdx: fromIdx, prompt: np[fromIdx] });
              // Reassign positions
              const newGroups = [...promptGroups];
              newFlatItems.forEach((item, pos) => {
                if (item.type === 'group') {
                  const gIdx = newGroups.findIndex(g => g.id === item.group.id);
                  if (gIdx >= 0) newGroups[gIdx] = { ...newGroups[gIdx], position: pos };
                } else {
                  np[item.origIdx] = { ...np[item.origIdx], position: pos };
                }
              });
              setPrompts(np);
              setPromptGroups(newGroups);
              savePromptsImmediate(np);
              ipcRenderer.invoke('prompt-groups:save', newGroups);
              if (editItem !== null) setEditingInsertionIndex(np.indexOf(editItem));
              return null;
            } else if (targetGroup !== null) {
              np[fromIdx] = { ...np[fromIdx], group_id: targetGroup, position: undefined };
            }

            // Within-group reorder or cross-group
            const adjustedTo = toPos > fromIdx ? toPos - 1 : toPos;
            if (fromIdx !== adjustedTo) {
              const [moved] = np.splice(fromIdx, 1);
              np.splice(adjustedTo, 0, moved);
            }

            setPrompts(np);
            savePromptsImmediate(np);
            if (editItem !== null) setEditingInsertionIndex(np.indexOf(editItem));
          }
          return null;
        });
        return null;
      });
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const handleDocBlur = (e: React.FocusEvent) => {
    if (isBlurInsideContainer(e, docEditRef)) return;
    if (docPrompt.useFile) {
      saveDocFilePathImmediate(localDocFilePath);
    } else {
      saveDocInlineContentImmediate(localDocInlineContent);
    }
    setEditingDocPrompt(false);
  };



  // Start editing an AI prompt (auto-saves current before switching)
  const startEditingAIPrompt = (prompt: AIPrompt) => {
    if (prompt.id === editingPromptId) return;
    saveCurrentAIPrompt();
    saveCurrentInsertion();
    setEditingInsertionIndex(null);
    setEditingPromptId(prompt.id);
    setLocalPromptContent(prompt.content);
    setLocalPromptName(prompt.name);
    setLocalPromptColor(prompt.color);
    setLocalPromptShowInMenu(prompt.showInContextMenu);
    setLocalPromptModel(prompt.model);
    setLocalPromptThinkingLevel(prompt.thinkingLevel);
  };

  // Add new custom AI prompt
  const addAIPrompt = () => {
    const newId = `prompt-${Date.now()}`;
    const maxPos = aiPrompts.reduce((max, p) => Math.max(max, p.position), 0);
    const newPrompt: AIPrompt = {
      id: newId,
      name: `Prompt ${aiPrompts.length + 1}`,
      content: '',
      model: 'gemini-3-flash-preview',
      thinkingLevel: 'HIGH',
      color: '#6366f1',
      isBuiltIn: false,
      showInContextMenu: true,
      position: maxPos + 1
    };
    saveAIPrompt(newPrompt);
    startEditingAIPrompt(newPrompt);
  };

  // Compute max flat position across groups and ungrouped prompts
  const getNextFlatPosition = () => {
    const maxGroupPos = promptGroups.reduce((max, g) => Math.max(max, g.position), -1);
    const maxPromptPos = prompts.filter(p => !p.group_id).reduce((max, p) => Math.max(max, p.position ?? 0), -1);
    return Math.max(maxGroupPos, maxPromptPos) + 1;
  };

  const addPrompt = (groupId?: number | null) => {
    saveCurrentInsertion();
    saveCurrentAIPrompt();
    setEditingPromptId(null);
    const pos = groupId ? undefined : getNextFlatPosition();
    const newPrompts = [...prompts, { title: `Prompt ${prompts.length + 1}`, content: '', group_id: groupId ?? null, position: pos }];
    setPrompts(newPrompts);
    savePromptsImmediate(newPrompts);
    const idx = newPrompts.length - 1;
    setEditingInsertionIndex(idx);
    setLocalInsertionTitle(newPrompts[idx].title);
    setLocalInsertionContent('');
  };

  const addPromptGroup = async () => {
    const maxId = promptGroups.reduce((max, g) => Math.max(max, g.id), 0);
    const newGroup: PromptGroup = { id: maxId + 1, name: `Group ${promptGroups.length + 1}`, description: '', position: getNextFlatPosition(), is_collapsed: false };
    const newGroups = [...promptGroups, newGroup];
    setPromptGroups(newGroups);
    await ipcRenderer.invoke('prompt-groups:save', newGroups);
    startEditingGroup(newGroup.id, newGroups);
  };

  const deletePromptGroup = async (groupId: number) => {
    const newPrompts = prompts.map(p => p.group_id === groupId ? { ...p, group_id: null } : p);
    const newGroups = promptGroups.filter(g => g.id !== groupId);
    setPrompts(newPrompts);
    setPromptGroups(newGroups);
    await Promise.all([
      ipcRenderer.invoke('prompts:save', newPrompts),
      ipcRenderer.invoke('prompt-groups:save', newGroups)
    ]);
    setEditingGroupId(null);
    showToast('Group deleted', 'success');
  };

  const toggleGroupCollapsed = (groupId: number) => {
    const newGroups = promptGroups.map(g => g.id === groupId ? { ...g, is_collapsed: !g.is_collapsed } : g);
    setPromptGroups(newGroups);
    ipcRenderer.invoke('prompt-groups:save', newGroups);
  };

  const deletePrompt = async (index: number) => {
    const newPrompts = prompts.filter((_, i) => i !== index);
    setPrompts(newPrompts);
    await savePromptsImmediate(newPrompts);
    showToast('Deleted', 'success');
    setEditingInsertionIndex(null);
  };

  const resetDoc = () => {
    setLocalDocFilePath(DEFAULT_DOC_FILE_PATH);
    setDocPromptFilePath(DEFAULT_DOC_FILE_PATH);
    setDocPromptUseFile(true);
  };

  // Close on Escape or Cmd+,
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return;
      if (e.key === 'Escape' || (e.metaKey && e.code === 'Comma')) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  // Split shortcuts into two columns
  const mid = Math.ceil(SHORTCUTS.length / 2);
  const leftShortcuts = SHORTCUTS.slice(0, mid);
  const rightShortcuts = SHORTCUTS.slice(mid);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0,0,0,0.7)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000
      }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) (e.currentTarget as HTMLElement).dataset.mouseDownOnOverlay = 'true'; }}
      onClick={(e) => { if (e.target === e.currentTarget && (e.currentTarget as HTMLElement).dataset.mouseDownOnOverlay === 'true') onClose(); (e.currentTarget as HTMLElement).dataset.mouseDownOnOverlay = ''; }}
    >
      <div
        style={{
          backgroundColor: '#1a1a1a',
          borderRadius: '16px',
          border: '1px solid #333',
          width: activeTab === 'ai' ? '900px' : '560px',
          maxHeight: '85vh',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          transition: 'width 0.2s ease'
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{
          padding: '16px 24px',
          borderBottom: '1px solid #333',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexShrink: 0
        }}>
          <h2 style={{ margin: 0, fontSize: '16px', fontWeight: '600', color: '#fff' }}>
            Настройки
          </h2>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              color: '#666',
              fontSize: '20px',
              cursor: 'pointer',
              lineHeight: 1
            }}
          >
            &times;
          </button>
        </div>

        {/* Tabs */}
        <div style={{
          display: 'flex',
          borderBottom: '1px solid #333',
          padding: '0 24px',
          flexShrink: 0
        }}>
          {([
            { id: 'ai', label: 'AI' },
            { id: 'shortcuts', label: 'Горячие клавиши' },
            { id: 'fonts', label: 'Шрифты' },
            { id: 'colors', label: 'Цвета' }
          ] as { id: SettingsTab; label: string }[]).map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              style={{
                padding: '10px 16px',
                fontSize: '13px',
                color: activeTab === tab.id ? '#fff' : '#666',
                backgroundColor: 'transparent',
                border: 'none',
                borderBottom: activeTab === tab.id ? '2px solid #fff' : '2px solid transparent',
                cursor: 'pointer',
                marginBottom: '-1px'
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div style={{ padding: '20px 24px', overflowY: 'auto', flex: 1 }}>
          {activeTab === 'shortcuts' && (
            <div style={{ display: 'flex', gap: '32px' }}>
              {/* Left column */}
              <div style={{ flex: 1 }}>
                {leftShortcuts.map((shortcut, i) => (
                  <div key={i} style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '10px 0',
                    borderBottom: '1px solid #2a2a2a'
                  }}>
                    <span style={{ fontSize: '13px', color: '#888' }}>{shortcut.description}</span>
                    <code style={{
                      fontSize: '12px',
                      color: '#fff',
                      backgroundColor: '#333',
                      padding: '4px 10px',
                      borderRadius: '6px',
                      fontFamily: 'monospace'
                    }}>
                      {shortcut.keys}
                    </code>
                  </div>
                ))}
              </div>
              {/* Right column */}
              <div style={{ flex: 1 }}>
                {rightShortcuts.map((shortcut, i) => (
                  <div key={i} style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '10px 0',
                    borderBottom: '1px solid #2a2a2a'
                  }}>
                    <span style={{ fontSize: '13px', color: '#888' }}>{shortcut.description}</span>
                    <code style={{
                      fontSize: '12px',
                      color: '#fff',
                      backgroundColor: '#333',
                      padding: '4px 10px',
                      borderRadius: '6px',
                      fontFamily: 'monospace'
                    }}>
                      {shortcut.keys}
                    </code>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeTab === 'fonts' && (
            <>
              <FontSizeSlider
                label="Терминал"
                description="Cmd+/- для быстрой настройки"
                value={terminalFontSize}
                onChange={setTerminalFontSize}
                min={8}
                max={24}
              />
              <FontSizeSlider
                label="Табы"
                description="Табы воркспейса"
                value={tabsFontSize}
                onChange={setTabsFontSize}
                min={10}
                max={20}
              />
              <FontSizeSlider
                label="Проекты"
                description="Чипы проектов"
                value={projectTabsFontSize}
                onChange={setProjectTabsFontSize}
                min={10}
                max={16}
              />

              {/* Tab Notes section */}
              <div style={{ marginTop: '16px', paddingTop: '16px', borderTop: '1px solid #333' }}>
                <div style={{ fontSize: '11px', fontWeight: '600', color: '#666', marginBottom: '12px', textTransform: 'uppercase' }}>
                  Описание вкладки
                </div>
                <FontSizeSlider
                  label="Заметки вкладки"
                  description="Превью и редактор описания"
                  value={tabNotesFontSize}
                  onChange={setTabNotesFontSize}
                  min={10}
                  max={20}
                />
                <FontSizeSlider
                  label="Padding X"
                  description="Горизонтальный отступ"
                  value={tabNotesPaddingX}
                  onChange={setTabNotesPaddingX}
                  min={0}
                  max={32}
                />
                <FontSizeSlider
                  label="Padding Y"
                  description="Вертикальный отступ"
                  value={tabNotesPaddingY}
                  onChange={setTabNotesPaddingY}
                  min={0}
                  max={32}
                />
              </div>
            </>
          )}

          {activeTab === 'colors' && (
            <>
              <div style={{ padding: '14px', backgroundColor: '#222', border: '1px solid #333', borderRadius: '10px', marginBottom: '12px' }}>
                <div style={{ fontSize: '11px', fontWeight: '600', color: '#666', marginBottom: '10px', textTransform: 'uppercase' }}>
                  Системные
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <div style={{ width: '20px', height: '20px', borderRadius: '50%', backgroundColor: 'rgba(34, 197, 94, 0.2)', border: '2px solid rgb(34, 197, 94)' }} />
                  <span style={{ fontSize: '13px', color: '#888' }}>Зелёный — AI агенты</span>
                </div>
              </div>

              <div style={{ padding: '14px', backgroundColor: '#222', border: '1px solid #333', borderRadius: '10px' }}>
                <div style={{ fontSize: '11px', fontWeight: '600', color: '#666', marginBottom: '10px', textTransform: 'uppercase' }}>
                  Пользовательские (ПКМ)
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px' }}>
                  {[
                    { color: '#666', label: 'По умолчанию' },
                    { color: 'rgb(239, 68, 68)', label: 'Красный' },
                    { color: 'rgb(234, 179, 8)', label: 'Жёлтый' },
                    { color: 'rgb(59, 130, 246)', label: 'Синий' },
                    { color: 'rgb(168, 85, 247)', label: 'Фиолетовый' }
                  ].map(({ color, label }) => (
                    <div key={label} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <div style={{ width: '16px', height: '16px', borderRadius: '50%', border: `2px solid ${color}` }} />
                      <span style={{ fontSize: '12px', color: '#666' }}>{label}</span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}

          {activeTab === 'ai' && (
            <div style={{ display: 'flex', gap: '24px', height: 'calc(85vh - 130px)' }}>
              {/* Left Column */}
              <div style={{ flex: 1, minWidth: 0, overflowY: 'auto', paddingRight: '4px' }}>
                {editingGroupId !== null ? (() => {
                  const grp = promptGroups.find(g => g.id === editingGroupId);
                  if (!grp) return null;
                  return (
                    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px', flexShrink: 0 }}>
                        <input type="text" value={localGroupName} onChange={(e) => setLocalGroupName(e.target.value)} onBlur={() => { saveCurrentGroup(); setSavedGroupFlash('name'); if (savedGroupTimer.current) clearTimeout(savedGroupTimer.current); savedGroupTimer.current = setTimeout(() => setSavedGroupFlash(null), 400); }} placeholder="Название группы..." autoFocus style={{ flex: 1, padding: '8px', backgroundColor: '#1a1a1a', border: savedGroupFlash === 'name' ? '1px solid #22c55e' : '1px solid #444', borderRadius: '6px', color: '#fff', fontSize: '13px', outline: 'none', boxSizing: 'border-box' as const, transition: 'border-color 0.15s ease' }} />
                        <div style={{ width: '1px', height: '20px', backgroundColor: '#333', flexShrink: 0 }} />
                        <button onClick={(e) => { e.stopPropagation(); closeGroupEditor(); }} style={{ background: '#2a2a2a', border: '1px solid #393939', borderRadius: '4px', color: '#888', fontSize: '14px', cursor: 'pointer', padding: '1px 7px', lineHeight: 1 }}>✕</button>
                      </div>
                      <textarea
                        value={localGroupDescription}
                        onChange={(e) => {
                          const lines = e.target.value.split('\n');
                          if (lines.length <= 6) setLocalGroupDescription(e.target.value);
                        }}
                        onBlur={() => { saveCurrentGroup(); setSavedGroupFlash('description'); if (savedGroupTimer.current) clearTimeout(savedGroupTimer.current); savedGroupTimer.current = setTimeout(() => setSavedGroupFlash(null), 400); }}
                        placeholder="Описание (необязательно)..."
                        rows={Math.max(1, Math.min(5, localGroupDescription.split('\n').length))}
                        style={{ padding: '8px', backgroundColor: '#1a1a1a', border: savedGroupFlash === 'description' ? '1px solid #22c55e' : '1px solid #444', borderRadius: '6px', color: '#aaa', fontSize: '12px', outline: 'none', boxSizing: 'border-box' as const, transition: 'border-color 0.15s ease', marginBottom: '12px', flexShrink: 0, resize: 'none', fontFamily: 'inherit', overflowY: localGroupDescription.split('\n').length > 5 ? 'auto' : 'hidden', maxHeight: '110px' }}
                      />
                      <div style={{ marginTop: 'auto', flexShrink: 0 }}>
                        <button onClick={(e) => { e.stopPropagation(); deletePromptGroup(editingGroupId); }} style={{ padding: '4px 8px', backgroundColor: 'transparent', color: '#ef4444', border: 'none', fontSize: '10px', cursor: 'pointer' }}>Удалить группу</button>
                      </div>
                    </div>
                  );
                })() : editingInsertionIndex !== null ? (() => {
                  const ins = prompts[editingInsertionIndex];
                  if (!ins) return null;
                  return (
                    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px', flexShrink: 0 }}>
                        <input type="text" value={localInsertionTitle} onChange={(e) => setLocalInsertionTitle(e.target.value)} onBlur={() => { saveCurrentInsertion(); setSavedInsertionFlash('title'); if (savedInsertionTimer.current) clearTimeout(savedInsertionTimer.current); savedInsertionTimer.current = setTimeout(() => setSavedInsertionFlash(null), 400); }} placeholder="Название..." autoFocus style={{ flex: 1, padding: '8px', backgroundColor: '#1a1a1a', border: savedInsertionFlash === 'title' ? '1px solid #22c55e' : '1px solid #444', borderRadius: '6px', color: '#fff', fontSize: '13px', outline: 'none', boxSizing: 'border-box' as const, transition: 'border-color 0.15s ease' }} />
                        <div style={{ width: '1px', height: '20px', backgroundColor: '#333', flexShrink: 0 }} />
                        <button onClick={(e) => { e.stopPropagation(); closeInsertionEditor(); }} style={{ background: '#2a2a2a', border: '1px solid #393939', borderRadius: '4px', color: '#888', fontSize: '14px', cursor: 'pointer', padding: '1px 7px', lineHeight: 1 }}>✕</button>
                      </div>
                      <textarea value={localInsertionContent} onChange={(e) => setLocalInsertionContent(e.target.value)} onBlur={() => { saveCurrentInsertion(); setSavedInsertionFlash('content'); if (savedInsertionTimer.current) clearTimeout(savedInsertionTimer.current); savedInsertionTimer.current = setTimeout(() => setSavedInsertionFlash(null), 400); }} placeholder="Содержимое..." style={{ flex: 1, padding: '10px', backgroundColor: '#1a1a1a', border: savedInsertionFlash === 'content' ? '1px solid #22c55e' : '1px solid #444', borderRadius: '6px', color: '#aaa', fontSize: '11px', fontFamily: 'monospace', outline: 'none', resize: 'none', boxSizing: 'border-box' as const, minHeight: 0, transition: 'border-color 0.15s ease' }} />
                      <div style={{ marginTop: '8px', flexShrink: 0 }}>
                        <button onClick={(e) => { e.stopPropagation(); deletePrompt(editingInsertionIndex); }} style={{ padding: '4px 8px', backgroundColor: 'transparent', color: '#ef4444', border: 'none', fontSize: '10px', cursor: 'pointer' }}>Удалить</button>
                      </div>
                    </div>
                  );
                })() : (<>
                <div style={{ fontSize: '11px', fontWeight: '600', color: '#666', marginBottom: '12px', textTransform: 'uppercase' }}>
                  AI промпты (Gemini)
                </div>

                {aiPrompts.map((aiPrompt) => {
                  const isSelected = editingPromptId === aiPrompt.id;
                  const displayName = isSelected ? localPromptName : aiPrompt.name;
                  const displayColor = isSelected ? localPromptColor : aiPrompt.color;
                  const displayModel = isSelected ? localPromptModel : aiPrompt.model;
                  const displayThinking = isSelected ? localPromptThinkingLevel : aiPrompt.thinkingLevel;
                  const displayMenu = isSelected ? localPromptShowInMenu : aiPrompt.showInContextMenu;

                  return (
                    <div
                      key={aiPrompt.id}
                      onClick={() => startEditingAIPrompt(aiPrompt)}
                      style={{
                        padding: '12px',
                        backgroundColor: isSelected ? '#252525' : '#222',
                        border: `2px solid ${isSelected ? displayColor : displayColor + '33'}`,
                        borderRadius: '10px',
                        cursor: 'pointer',
                        marginBottom: '10px'
                      }}
                    >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <span style={{ fontSize: '13px', color: displayColor, fontWeight: '500' }}>{displayName}</span>
                          <span style={{ fontSize: '9px', padding: '1px 4px', backgroundColor: `${displayColor}22`, color: displayColor, borderRadius: '3px' }}>
                            {displayModel.includes('pro') ? 'PRO' : 'FLASH'}
                          </span>
                          {displayThinking !== 'HIGH' && (
                            <span style={{ fontSize: '9px', padding: '1px 4px', backgroundColor: '#ffffff11', color: '#888', borderRadius: '3px' }}>
                              {displayThinking}
                            </span>
                          )}
                          {displayMenu && (
                            <span style={{ fontSize: '9px', padding: '1px 4px', backgroundColor: '#ffffff11', color: '#666', borderRadius: '3px' }}>ПКМ</span>
                          )}
                        </div>
                    </div>
                  );
                })}

                {/* Add new AI prompt button */}
                <button
                  onClick={addAIPrompt}
                  style={{ width: '100%', padding: '10px', backgroundColor: '#222', border: '2px dashed #444', borderRadius: '10px', color: '#666', fontSize: '12px', cursor: 'pointer', marginBottom: '10px' }}
                >
                  + Добавить промпт
                </button>

                {/* Rewind Assignment */}
                <div style={{ padding: '12px', backgroundColor: '#222', border: '1px solid #333', borderRadius: '10px', marginBottom: '10px' }}>
                  <div style={{ fontSize: '11px', color: '#888', marginBottom: '6px' }}>Промпт для "Откатиться":</div>
                  <select
                    value={rewindPromptId}
                    onChange={(e) => setRewindPromptId(e.target.value)}
                    style={{ width: '100%', padding: '6px 8px', backgroundColor: '#1a1a1a', border: '1px solid #444', borderRadius: '6px', color: '#ccc', fontSize: '11px', outline: 'none', cursor: 'pointer' }}
                  >
                    {aiPrompts.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </div>

                {/* Separator */}
                <div style={{ borderTop: '1px solid #333', margin: '16px 0 12px', position: 'relative' as const }}>
                  <span style={{ position: 'absolute' as const, top: '-8px', left: '12px', backgroundColor: '#1a1a1a', padding: '0 8px', fontSize: '10px', color: '#555', textTransform: 'uppercase' }}>
                    Системные промпты
                  </span>
                </div>

                {/* Claude Default Prompt */}
                <div
                  ref={claudeEditRef}
                  onClick={() => !editingClaude && setEditingClaude(true)}
                  style={{
                    padding: '12px',
                    backgroundColor: editingClaude ? '#252525' : '#222',
                    border: editingClaude ? '2px solid #DA7756' : `2px solid ${claudeDefaultPromptEnabled ? '#DA775633' : '#DA775615'}`,
                    borderRadius: '10px',
                    cursor: editingClaude ? 'default' : 'pointer',
                    marginBottom: '10px',
                    opacity: editingClaude || claudeDefaultPromptEnabled ? 1 : 0.6
                  }}
                >
                  {editingClaude ? (
                    <textarea
                      value={claudeDefaultPrompt}
                      onChange={(e) => setClaudeDefaultPrompt(e.target.value)}
                      onBlur={handleClaudeBlur}
                      placeholder="Стартовый промпт Claude..."
                      rows={3}
                      autoFocus
                      style={{ width: '100%', padding: '8px', backgroundColor: '#1a1a1a', border: '1px solid #444', borderRadius: '6px', color: '#aaa', fontSize: '11px', fontFamily: 'monospace', outline: 'none', resize: 'none', boxSizing: 'border-box' as const }}
                    />
                  ) : (
                    <>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' }}>
                        <div style={{ fontSize: '13px', color: '#DA7756', fontWeight: '500' }}>Claude Default</div>
                        <div
                          onClick={(e) => { e.stopPropagation(); setClaudeDefaultPromptEnabled(!claudeDefaultPromptEnabled); }}
                          style={{ width: '32px', height: '18px', borderRadius: '9px', backgroundColor: claudeDefaultPromptEnabled ? '#DA7756' : '#444', position: 'relative' as const, cursor: 'pointer', transition: 'background-color 0.2s', flexShrink: 0 }}
                        >
                          <div style={{ width: '14px', height: '14px', borderRadius: '50%', backgroundColor: '#fff', position: 'absolute' as const, top: '2px', left: claudeDefaultPromptEnabled ? '16px' : '2px', transition: 'left 0.2s' }} />
                        </div>
                      </div>
                      <div style={{ fontSize: '11px', color: claudeDefaultPromptEnabled ? '#666' : '#555', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as const, opacity: claudeDefaultPromptEnabled ? 1 : 0.5 }}>
                        {claudeDefaultPrompt || 'Не задан'}
                      </div>
                    </>
                  )}
                </div>

                {/* Documentation Prompt */}
                <div
                  ref={docEditRef}
                  onClick={() => !editingDocPrompt && setEditingDocPrompt(true)}
                  style={{
                    padding: '12px',
                    backgroundColor: editingDocPrompt ? '#252525' : '#222',
                    border: editingDocPrompt ? '2px solid #22c55e' : '2px solid #22c55e33',
                    borderRadius: '10px',
                    cursor: editingDocPrompt ? 'default' : 'pointer'
                  }}
                >
                  {editingDocPrompt ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{ fontSize: '11px', color: '#888' }}>Источник:</span>
                        <button onClick={(e) => { e.stopPropagation(); setDocPromptUseFile(true); }} style={{ padding: '3px 8px', backgroundColor: docPrompt.useFile ? '#22c55e' : '#333', color: docPrompt.useFile ? '#fff' : '#888', border: 'none', borderRadius: '4px', fontSize: '10px', cursor: 'pointer' }}>Файл</button>
                        <button onClick={(e) => { e.stopPropagation(); setDocPromptUseFile(false); }} style={{ padding: '3px 8px', backgroundColor: !docPrompt.useFile ? '#22c55e' : '#333', color: !docPrompt.useFile ? '#fff' : '#888', border: 'none', borderRadius: '4px', fontSize: '10px', cursor: 'pointer' }}>Inline</button>
                      </div>
                      {docPrompt.useFile ? (
                        <input type="text" value={localDocFilePath} onChange={(e) => setLocalDocFilePath(e.target.value)} onBlur={handleDocBlur} placeholder="Путь к файлу..." autoFocus style={{ width: '100%', padding: '8px', backgroundColor: '#1a1a1a', border: '1px solid #444', borderRadius: '6px', color: '#aaa', fontSize: '11px', fontFamily: 'monospace', outline: 'none', boxSizing: 'border-box' as const }} />
                      ) : (
                        <textarea value={localDocInlineContent} onChange={(e) => setLocalDocInlineContent(e.target.value)} onBlur={handleDocBlur} rows={3} autoFocus style={{ width: '100%', padding: '8px', backgroundColor: '#1a1a1a', border: '1px solid #444', borderRadius: '6px', color: '#aaa', fontSize: '11px', fontFamily: 'monospace', outline: 'none', resize: 'none', boxSizing: 'border-box' as const }} />
                      )}
                      <button onClick={(e) => { e.stopPropagation(); resetDoc(); }} style={{ alignSelf: 'flex-start', padding: '4px 8px', backgroundColor: 'transparent', color: '#666', border: 'none', fontSize: '10px', cursor: 'pointer' }}>Сбросить</button>
                    </div>
                  ) : (
                    <>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                        <span style={{ fontSize: '13px', color: '#22c55e', fontWeight: '500' }}>Documentation</span>
                        <span style={{ fontSize: '9px', padding: '1px 4px', backgroundColor: docPrompt.useFile ? '#22c55e22' : '#8b5cf622', color: docPrompt.useFile ? '#22c55e' : '#8b5cf6', borderRadius: '3px' }}>{docPrompt.useFile ? 'ФАЙЛ' : 'INLINE'}</span>
                      </div>
                      <div style={{ fontSize: '11px', color: '#666', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {docPrompt.useFile ? localDocFilePath : (localDocInlineContent || 'Не задан')}
                      </div>
                    </>
                  )}
                </div>

                {/* Post-check Prompt */}
                <div
                  ref={postCheckEditRef}
                  onClick={() => !editingPostCheck && setEditingPostCheck(true)}
                  style={{
                    padding: '12px',
                    backgroundColor: editingPostCheck ? '#252525' : '#222',
                    border: editingPostCheck ? '2px solid #a78bfa' : '2px solid #a78bfa33',
                    borderRadius: '10px',
                    cursor: editingPostCheck ? 'default' : 'pointer'
                  }}
                >
                  {editingPostCheck ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      <span style={{ fontSize: '11px', color: '#a78bfa', fontWeight: '500' }}>Post-check</span>
                      <textarea
                        value={localPostCheckContent}
                        onChange={(e) => setLocalPostCheckContent(e.target.value)}
                        onBlur={(e) => {
                          if (isBlurInsideContainer(e, postCheckEditRef)) return;
                          useUIStore.getState().setPostCheckPrompt(localPostCheckContent);
                          setEditingPostCheck(false);
                        }}
                        rows={4}
                        autoFocus
                        style={{ width: '100%', padding: '8px', backgroundColor: '#1a1a1a', border: '1px solid #444', borderRadius: '6px', color: '#aaa', fontSize: '11px', fontFamily: 'monospace', outline: 'none', resize: 'none', boxSizing: 'border-box' as const }}
                      />
                    </div>
                  ) : (
                    <>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                        <span style={{ fontSize: '13px', color: '#a78bfa', fontWeight: '500' }}>Post-check</span>
                      </div>
                      <div style={{ fontSize: '11px', color: '#666', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {localPostCheckContent || 'Не задан'}
                      </div>
                    </>
                  )}
                </div>
                </>)}
              </div>

              {/* Right Column */}
              <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                {editingPromptId !== null ? (
                  (() => {
                    const editingAIPrompt = aiPrompts.find(p => p.id === editingPromptId);
                    if (!editingAIPrompt) return null;

                    // Helper: save all local edits + overrides to DB (all fields from local state, no stale store reads)
                    const saveField = (overrides: Partial<AIPrompt>) => {
                      saveAIPrompt({
                        ...editingAIPrompt,
                        name: localPromptName,
                        content: localPromptContent,
                        color: localPromptColor,
                        showInContextMenu: localPromptShowInMenu,
                        model: localPromptModel,
                        thinkingLevel: localPromptThinkingLevel,
                        ...overrides
                      });
                    };

                    return (
                      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                        {/* Header: Name input + close button */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px', flexShrink: 0 }}>
                          <input
                            type="text"
                            value={localPromptName}
                            onChange={(e) => setLocalPromptName(e.target.value)}
                            onBlur={() => saveCurrentAIPrompt('name')}
                            placeholder="Название..."
                            style={{ flex: 1, padding: '8px', backgroundColor: '#1a1a1a', border: savedFlashField === 'name' ? '1px solid #22c55e' : '1px solid #444', borderRadius: '6px', color: '#fff', fontSize: '13px', outline: 'none', boxSizing: 'border-box' as const, transition: 'border-color 0.15s ease' }}
                          />
                          <div style={{ width: '1px', height: '20px', backgroundColor: '#333', flexShrink: 0 }} />
                          <button
                            onClick={(e) => { e.stopPropagation(); closeAIPromptEditor(); }}
                            style={{ background: '#2a2a2a', border: '1px solid #393939', borderRadius: '4px', color: '#888', fontSize: '14px', cursor: 'pointer', padding: '1px 7px', lineHeight: 1 }}
                          >
                            ✕
                          </button>
                        </div>

                        {/* Controls */}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '12px', flexShrink: 0 }}>
                          {/* Model selector — full names */}
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <span style={{ fontSize: '10px', color: '#888', flexShrink: 0 }}>Модель:</span>
                            {([
                              { value: 'gemini-3-flash-preview' as AIModel, label: 'Gemini 3 Flash' },
                              { value: 'gemini-3-pro-preview' as AIModel, label: 'Gemini 3 Pro' }
                            ]).map((m) => (
                              <button
                                key={m.value}
                                onClick={(e) => { e.stopPropagation(); setLocalPromptModel(m.value); saveField({ model: m.value }); }}
                                style={{
                                  padding: '3px 10px',
                                  backgroundColor: localPromptModel === m.value ? localPromptColor : '#333',
                                  color: localPromptModel === m.value ? '#fff' : '#888',
                                  border: 'none', borderRadius: '4px', fontSize: '10px', cursor: 'pointer'
                                }}
                              >
                                {m.label}
                              </button>
                            ))}
                          </div>

                          {/* Thinking level selector */}
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <span style={{ fontSize: '10px', color: '#888', flexShrink: 0 }}>Думание:</span>
                            {(['NONE', 'LOW', 'MEDIUM', 'HIGH'] as ThinkingLevel[]).map((level) => (
                              <button
                                key={level}
                                onClick={(e) => { e.stopPropagation(); setLocalPromptThinkingLevel(level); saveField({ thinkingLevel: level }); }}
                                style={{
                                  padding: '3px 8px',
                                  backgroundColor: localPromptThinkingLevel === level ? localPromptColor : '#333',
                                  color: localPromptThinkingLevel === level ? '#fff' : '#888',
                                  border: 'none', borderRadius: '4px', fontSize: '10px', cursor: 'pointer'
                                }}
                              >
                                {level}
                              </button>
                            ))}
                          </div>

                          {/* Color picker */}
                          <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                            <span style={{ fontSize: '10px', color: '#888', flexShrink: 0 }}>Цвет:</span>
                            {['#0ea5e9', '#a855f7', '#f59e0b', '#22c55e', '#ef4444', '#6366f1', '#ec4899'].map((c) => (
                              <div
                                key={c}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setLocalPromptColor(c);
                                  saveField({ color: c });
                                }}
                                style={{
                                  width: '14px', height: '14px', borderRadius: '50%', backgroundColor: c, cursor: 'pointer',
                                  border: localPromptColor === c ? '2px solid #fff' : '2px solid transparent'
                                }}
                              />
                            ))}
                          </div>

                          {/* Context menu toggle */}
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <span style={{ fontSize: '10px', color: '#888' }}>В контекстном меню:</span>
                            <div
                              onClick={(e) => {
                                e.stopPropagation();
                                const newVal = !localPromptShowInMenu;
                                setLocalPromptShowInMenu(newVal);
                                saveField({ showInContextMenu: newVal });
                              }}
                              style={{ width: '28px', height: '16px', borderRadius: '8px', backgroundColor: localPromptShowInMenu ? localPromptColor : '#444', position: 'relative' as const, cursor: 'pointer', transition: 'background-color 0.2s', flexShrink: 0 }}
                            >
                              <div style={{ width: '12px', height: '12px', borderRadius: '50%', backgroundColor: '#fff', position: 'absolute' as const, top: '2px', left: localPromptShowInMenu ? '14px' : '2px', transition: 'left 0.2s' }} />
                            </div>
                          </div>
                        </div>

                        {/* Textarea — fills remaining space */}
                        <textarea
                          value={localPromptContent}
                          onChange={(e) => setLocalPromptContent(e.target.value)}
                          onBlur={() => saveCurrentAIPrompt('content')}
                          placeholder="Содержимое промпта..."
                          style={{
                            flex: 1,
                            padding: '10px',
                            backgroundColor: '#1a1a1a',
                            border: savedFlashField === 'content' ? '1px solid #22c55e' : '1px solid #444',
                            transition: 'border-color 0.15s ease',
                            borderRadius: '6px',
                            color: '#aaa',
                            fontSize: '11px',
                            fontFamily: 'monospace',
                            outline: 'none',
                            resize: 'none',
                            boxSizing: 'border-box' as const,
                            minHeight: 0
                          }}
                        />

                        {/* Footer: Delete button (non-builtIn only) */}
                        {!editingAIPrompt.isBuiltIn && (
                          <div style={{ marginTop: '8px', flexShrink: 0 }}>
                            <button
                              onClick={(e) => { e.stopPropagation(); deleteAIPrompt(editingAIPrompt.id); setEditingPromptId(null); showToast('Deleted', 'success'); }}
                              style={{ padding: '4px 8px', backgroundColor: 'transparent', color: '#ef4444', border: 'none', fontSize: '10px', cursor: 'pointer' }}
                            >
                              Удалить промпт
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })()
                ) : (
                  <>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px', flexShrink: 0 }}>
                      <div style={{ fontSize: '11px', fontWeight: '600', color: '#666', textTransform: 'uppercase' }}>
                        Текстовые вставки
                      </div>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <button onClick={addPromptGroup} style={{ padding: '4px 10px', backgroundColor: '#333', color: '#aaa', border: '1px solid #555', borderRadius: '4px', fontSize: '10px', cursor: 'pointer' }}>+ Группа</button>
                        <button onClick={() => addPrompt()} style={{ padding: '4px 10px', backgroundColor: '#8b5cf6', color: '#fff', border: 'none', borderRadius: '4px', fontSize: '10px', cursor: 'pointer' }}>+ Добавить</button>
                      </div>
                    </div>

                    <div ref={textListRef} data-group-drop="ungrouped" style={{ display: 'flex', flexDirection: 'column', overflowY: 'auto', flex: 1, minHeight: 0 }}>
                      {prompts.length === 0 && promptGroups.length === 0 ? (
                        <div style={{ padding: '24px', textAlign: 'center', color: '#555', fontSize: '12px', border: '2px dashed #333', borderRadius: '10px' }}>Пока нет промптов</div>
                      ) : (() => {
                        const flatItems = buildFlatItems();
                        const flatGapH = dragFlatItemHeight.current;
                        const flatGapTransition = flatDragReady ? 'height 0.12s ease-out, margin-bottom 0.12s ease-out' : 'none';
                        return (<>
                          {flatItems.map((item, flatIdx) => {
                            // Suppress gap slot when hovering over a group zone (prompt will move INTO group, not reorder)
                            const isOverGroupZone = dragOverGroupId !== null && dragOverGroupId !== 'ungrouped';
                            const isFlatGapHere = draggingFlatIdx !== null && flatDropTarget === flatIdx && !isOverGroupZone;
                            if (item.type === 'group') {
                              const group = item.group;
                              const groupPrompts = prompts.map((p, i) => ({ ...p, _idx: i })).filter(p => p.group_id === group.id);
                              const isCollapsed = group.is_collapsed;
                              const isDropTarget = (draggingTextIndex !== null || draggingFlatIdx !== null) && dragOverGroupId === group.id;
                              const isGroupSelected = editingGroupId === group.id;
                              const isFlatDragged = draggingFlatIdx === flatIdx;
                              return (
                                <React.Fragment key={`g-${group.id}`}>
                                  <div style={{ height: isFlatGapHere ? `${flatGapH + 8}px` : '0px', marginBottom: isFlatGapHere ? '4px' : '0px', overflow: 'hidden', transition: flatGapTransition, boxSizing: 'border-box' as const }}>
                                    <div style={{ height: `${flatGapH + 8}px`, borderRadius: '10px', border: '2px dashed #8b5cf640', backgroundColor: '#8b5cf608', boxSizing: 'border-box' as const }} />
                                  </div>
                                  <div
                                    data-flat-container
                                    data-group-drop={group.id}
                                    style={{ marginBottom: '4px', borderRadius: '8px', border: isDropTarget ? '2px solid #8b5cf6' : '2px solid transparent', transition: 'border-color 0.15s ease', display: isFlatDragged ? 'none' : undefined }}
                                  >
                                    <div
                                      data-flat-card
                                      data-flat-idx={flatIdx}
                                      data-hidden={isFlatDragged || undefined}
                                      style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '11px 12px', marginBottom: '4px', backgroundColor: isGroupSelected ? '#252525' : '#222', border: isGroupSelected ? '2px solid #8b5cf6' : '2px solid #333', borderRadius: '10px', cursor: 'pointer', userSelect: 'none' }}
                                      onClick={() => { if (isGroupSelected) { toggleGroupCollapsed(group.id); } else { startEditingGroup(group.id); } }}
                                    >
                                      <div
                                        onClick={(e) => { e.stopPropagation(); toggleGroupCollapsed(group.id); }}
                                        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = '#3a3a3a'; }}
                                        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent'; }}
                                        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '20px', height: '20px', borderRadius: '4px', flexShrink: 0, transition: 'background-color 0.1s' }}
                                      >
                                        <span style={{ fontSize: '10px', color: '#888' }}>{isCollapsed ? '\u25B6' : '\u25BC'}</span>
                                      </div>
                                      <span style={{ flex: 1, fontSize: '14px', color: isGroupSelected ? '#8b5cf6' : '#fff', fontWeight: '500', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{group.name}</span>
                                      <div
                                        onPointerDown={handleFlatItemDrag(flatIdx)}
                                        onClick={(e) => e.stopPropagation()}
                                        style={{ display: 'grid', gridTemplateColumns: '3px 3px', gap: '2px', padding: '4px 2px', cursor: 'grab', flexShrink: 0, touchAction: 'none' }}
                                      >
                                        {[...Array(6)].map((_, i) => <div key={i} style={{ width: '3px', height: '3px', borderRadius: '50%', backgroundColor: '#555' }} />)}
                                      </div>
                                    </div>
                                    {!isCollapsed && (
                                      <div style={{ paddingLeft: '10px' }}>
                                        {groupPrompts.length === 0 ? (
                                          <div style={{ padding: '8px', textAlign: 'center', color: '#444', fontSize: '10px', border: '1px dashed #333', borderRadius: '8px', marginBottom: '4px' }}>
                                            Перетащите сюда
                                          </div>
                                        ) : groupPrompts.map(prompt => {
                                          const index = prompt._idx;
                                          const isSelected = editingInsertionIndex === index;
                                          const isDragged = draggingTextIndex === index;
                                          const isGapHere = draggingTextIndex !== null && textDropTarget === index;
                                          const gapH = dragCardHeight.current;
                                          const gapTransition = dragTransitionsReady ? 'height 0.12s ease-out, margin-bottom 0.12s ease-out' : 'none';
                                          return (
                                            <React.Fragment key={index}>
                                              <div style={{ height: isGapHere ? `${gapH}px` : '0px', marginBottom: isGapHere ? '4px' : '0px', overflow: 'hidden', transition: gapTransition, boxSizing: 'border-box' as const }}>
                                                <div style={{ height: `${gapH}px`, borderRadius: '8px', border: '2px dashed #8b5cf640', backgroundColor: '#8b5cf608', boxSizing: 'border-box' as const }} />
                                              </div>
                                              <div
                                                data-text-card
                                                data-hidden={isDragged || undefined}
                                                data-orig-index={index}
                                                onClick={() => !isDragged && startEditingInsertion(index)}
                                                style={{ padding: '9px 10px', marginBottom: '4px', backgroundColor: isSelected ? '#252525' : '#222', border: isSelected ? '2px solid #8b5cf6' : '2px solid #333', borderRadius: '8px', cursor: 'pointer', display: isDragged ? 'none' : 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}
                                              >
                                                <span style={{ fontSize: '13px', color: isSelected ? '#8b5cf6' : '#fff', fontWeight: '500', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{prompt.title}</span>
                                                <div onPointerDown={handleGripPointerDown(index)} onClick={(e) => e.stopPropagation()} style={{ display: 'grid', gridTemplateColumns: '3px 3px', gap: '2px', padding: '4px 2px', cursor: 'grab', flexShrink: 0, touchAction: 'none' }}>
                                                  {[...Array(6)].map((_, i) => <div key={i} style={{ width: '3px', height: '3px', borderRadius: '50%', backgroundColor: '#555' }} />)}
                                                </div>
                                              </div>
                                            </React.Fragment>
                                          );
                                        })}
                                      </div>
                                    )}
                                  </div>
                                </React.Fragment>
                              );
                            } else {
                              // Ungrouped prompt as flat item
                              const index = item.origIdx;
                              const prompt = item.prompt;
                              const isSelected = editingInsertionIndex === index;
                              const isDragged = draggingTextIndex === index;
                              const isFlatDragged = draggingFlatIdx === flatIdx;
                              const isHidden = isDragged || isFlatDragged;
                              return (
                                <React.Fragment key={`p-${index}`}>
                                  <div style={{ height: isFlatGapHere ? `${flatGapH + 8}px` : '0px', marginBottom: isFlatGapHere ? '4px' : '0px', overflow: 'hidden', transition: flatGapTransition, boxSizing: 'border-box' as const }}>
                                    <div style={{ height: `${flatGapH + 8}px`, borderRadius: '10px', border: '2px dashed #8b5cf640', backgroundColor: '#8b5cf608', boxSizing: 'border-box' as const }} />
                                  </div>
                                  <div
                                    data-flat-container
                                    data-flat-card
                                    data-flat-idx={flatIdx}
                                    data-hidden={isHidden || undefined}
                                    data-text-card
                                    data-orig-index={index}
                                    onClick={() => !isHidden && startEditingInsertion(index)}
                                    style={{ padding: '9px 12px', marginBottom: '8px', backgroundColor: isSelected ? '#252525' : '#222', border: isSelected ? '2px solid #8b5cf6' : '2px solid #333', borderRadius: '10px', cursor: 'pointer', display: isHidden ? 'none' : 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}
                                  >
                                    <span style={{ fontSize: '13px', color: isSelected ? '#8b5cf6' : '#fff', fontWeight: '500', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{prompt.title}</span>
                                    <div onPointerDown={handleFlatItemDrag(flatIdx)} onClick={(e) => e.stopPropagation()} style={{ display: 'grid', gridTemplateColumns: '3px 3px', gap: '2px', padding: '4px 2px', cursor: 'grab', flexShrink: 0, touchAction: 'none' }}>
                                      {[...Array(6)].map((_, i) => <div key={i} style={{ width: '3px', height: '3px', borderRadius: '50%', backgroundColor: '#555' }} />)}
                                    </div>
                                  </div>
                                </React.Fragment>
                              );
                            }
                          })}
                          {/* Gap slot after last flat item */}
                          <div style={{ height: (draggingFlatIdx !== null && flatDropTarget === flatItems.length && !(dragOverGroupId !== null && dragOverGroupId !== 'ungrouped')) ? `${flatGapH + 8}px` : '0px', overflow: 'hidden', transition: flatGapTransition, boxSizing: 'border-box' as const }}>
                            <div style={{ height: `${flatGapH + 8}px`, borderRadius: '10px', border: '2px dashed #8b5cf640', backgroundColor: '#8b5cf608', boxSizing: 'border-box' as const }} />
                          </div>
                        </>);
                      })()}
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
