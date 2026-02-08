import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useUIStore } from '../../store/useUIStore';

const { ipcRenderer } = window.require('electron');

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface Prompt {
  title: string;
  content: string;
}

type SettingsTab = 'shortcuts' | 'fonts' | 'colors' | 'ai';

const DEFAULT_RESEARCH_PROMPT = 'вот моя проблема нужно чтобы ты понял что за проблема и на reddit поискал обсуждения. Не ограничивайся категориями. Проблема: ';
const DEFAULT_COMPACT_PROMPT = 'Проанализируй всю нашу текущую сессию и составь структурированное резюме для переноса контекста в новый чат, включив в него: изначальную цель; список всех созданных файлов с пояснением, почему мы выбрали именно такую структуру и эти файлы; краткий отчет о том, что работает; детальный разбор того, что НЕ получилось, с указанием конкретных причин ошибок (почему выбранные решения не сработали); текущее состояние кода и пошаговый план дальнейших действий — оформи это всё одним компактным сообщением, которое я смогу скопировать и отправить тебе в новом чате для полного восстановления контекста.\n\nВот текст сессии:\n';
const DEFAULT_DESCRIPTION_PROMPT_SETTINGS = '1-2 предложения: что сделано. Без маркдауна, без вступлений.\n\n';
const DEFAULT_DOC_FILE_PATH = '/Users/fedor/Global-Templates/🧩 Code-Patterns/документация/docs-rules.prompt.md';

// Track if settings was opened at least once (for default tab)
let hasOpenedBefore = false;
let lastActiveTab: SettingsTab = 'shortcuts';

// Shortcuts data
const SHORTCUTS = [
  { keys: '⌘ + T', description: 'Новый таб' },
  { keys: '⌘ + \\', description: 'Показать/скрыть боковую панель' },
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
    return hasOpenedBefore ? lastActiveTab : 'shortcuts';
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
  const { showToast, chatSettings, setChatSettings, docPrompt, setDocPromptUseFile, setDocPromptFilePath, setDocPromptInlineContent, claudeDefaultPromptEnabled, setClaudeDefaultPromptEnabled } = useUIStore();

  // Claude Default Prompt
  const [claudeDefaultPrompt, setClaudeDefaultPrompt] = useState('');

  // System prompts
  const [localResearchPrompt, setLocalResearchPrompt] = useState('');
  const [localCompactPrompt, setLocalCompactPrompt] = useState('');
  const [localDescriptionPrompt, setLocalDescriptionPrompt] = useState('');
  const [localDocFilePath, setLocalDocFilePath] = useState('');
  const [localDocInlineContent, setLocalDocInlineContent] = useState('');

  // User prompts
  const [prompts, setPrompts] = useState<Prompt[]>([]);

  // Editing states
  const [editingClaude, setEditingClaude] = useState(false);
  const [editingResearch, setEditingResearch] = useState(false);
  const [editingCompact, setEditingCompact] = useState(false);
  const [editingDescription, setEditingDescription] = useState(false);
  const [editingDocPrompt, setEditingDocPrompt] = useState(false);
  const [editingPrompt, setEditingPrompt] = useState<number | null>(null);

  // Refs for editing containers (to check if blur target is inside)
  const claudeEditRef = useRef<HTMLDivElement>(null);
  const researchEditRef = useRef<HTMLDivElement>(null);
  const compactEditRef = useRef<HTMLDivElement>(null);
  const descriptionEditRef = useRef<HTMLDivElement>(null);
  const docEditRef = useRef<HTMLDivElement>(null);
  const promptEditRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  // Track tab changes
  useEffect(() => {
    if (isOpen) {
      hasOpenedBefore = true;
      lastActiveTab = activeTab;
    }
  }, [activeTab, isOpen]);

  // Load all data on open
  useEffect(() => {
    if (isOpen) {
      // Load Claude default prompt
      ipcRenderer.invoke('app:getState', 'claudeDefaultPrompt').then((value: string | null) => {
        setClaudeDefaultPrompt(value || '');
      });

      // Load system prompts from store
      setLocalResearchPrompt(chatSettings.research.prompt);
      setLocalCompactPrompt(chatSettings.compact.prompt);
      setLocalDescriptionPrompt(chatSettings.description.prompt);
      setLocalDocFilePath(docPrompt.filePath);
      setLocalDocInlineContent(docPrompt.inlineContent);

      // Load user prompts
      ipcRenderer.invoke('prompts:get').then((result: { success: boolean; data?: Prompt[] }) => {
        if (result.success && result.data) {
          setPrompts(result.data);
        }
      });
    } else {
      // Reset editing states when modal closes
      setEditingClaude(false);
      setEditingResearch(false);
      setEditingCompact(false);
      setEditingDescription(false);
      setEditingDocPrompt(false);
      setEditingPrompt(null);
    }
  }, [isOpen, chatSettings, docPrompt]);

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

  const saveResearchPromptImmediate = useCallback((value: string) => {
    setChatSettings('research', { prompt: value });
  }, [setChatSettings]);

  const saveCompactPromptImmediate = useCallback((value: string) => {
    setChatSettings('compact', { prompt: value });
  }, [setChatSettings]);

  const saveDescriptionPromptImmediate = useCallback((value: string) => {
    setChatSettings('description', { prompt: value });
  }, [setChatSettings]);

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

  const handleResearchBlur = (e: React.FocusEvent) => {
    if (isBlurInsideContainer(e, researchEditRef)) return;
    saveResearchPromptImmediate(localResearchPrompt);
    setEditingResearch(false);
  };

  const handleCompactBlur = (e: React.FocusEvent) => {
    if (isBlurInsideContainer(e, compactEditRef)) return;
    saveCompactPromptImmediate(localCompactPrompt);
    setEditingCompact(false);
  };

  const handleDescriptionBlur = (e: React.FocusEvent) => {
    if (isBlurInsideContainer(e, descriptionEditRef)) return;
    saveDescriptionPromptImmediate(localDescriptionPrompt);
    setEditingDescription(false);
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

  const handlePromptBlur = (e: React.FocusEvent, index: number) => {
    const ref = promptEditRefs.current.get(index);
    if (ref) {
      const relatedTarget = e.relatedTarget as Node | null;
      if (relatedTarget && ref.contains(relatedTarget)) return;
    }
    savePromptsImmediate(prompts);
    setEditingPrompt(null);
  };

  // User prompts management
  const addPrompt = () => {
    const newPrompts = [...prompts, { title: `Prompt ${prompts.length + 1}`, content: '' }];
    setPrompts(newPrompts);
    savePromptsImmediate(newPrompts);
    setEditingPrompt(newPrompts.length - 1);
  };

  const updatePrompt = (index: number, field: 'title' | 'content', value: string) => {
    const newPrompts = [...prompts];
    newPrompts[index][field] = value;
    setPrompts(newPrompts);
  };

  const deletePrompt = async (index: number) => {
    const newPrompts = prompts.filter((_, i) => i !== index);
    setPrompts(newPrompts);
    await savePromptsImmediate(newPrompts);
    showToast('Deleted', 'success');
    setEditingPrompt(null);
  };

  // Reset functions
  const resetResearch = () => {
    setLocalResearchPrompt(DEFAULT_RESEARCH_PROMPT);
    saveResearchPromptImmediate(DEFAULT_RESEARCH_PROMPT);
  };

  const resetCompact = () => {
    setLocalCompactPrompt(DEFAULT_COMPACT_PROMPT);
    saveCompactPromptImmediate(DEFAULT_COMPACT_PROMPT);
  };

  const resetDescription = () => {
    setLocalDescriptionPrompt(DEFAULT_DESCRIPTION_PROMPT_SETTINGS);
    saveDescriptionPromptImmediate(DEFAULT_DESCRIPTION_PROMPT_SETTINGS);
  };

  const resetDoc = () => {
    setLocalDocFilePath(DEFAULT_DOC_FILE_PATH);
    setDocPromptFilePath(DEFAULT_DOC_FILE_PATH);
    setDocPromptUseFile(true);
  };

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
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
      onClick={onClose}
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
            { id: 'shortcuts', label: 'Горячие клавиши' },
            { id: 'fonts', label: 'Шрифты' },
            { id: 'colors', label: 'Цвета' },
            { id: 'ai', label: 'AI' }
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
            <div style={{ display: 'flex', gap: '24px' }}>
              {/* Left Column - System Prompts */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '11px', fontWeight: '600', color: '#666', marginBottom: '12px', textTransform: 'uppercase' }}>
                  Системные промпты
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
                      style={{
                        width: '100%',
                        padding: '8px',
                        backgroundColor: '#1a1a1a',
                        border: '1px solid #444',
                        borderRadius: '6px',
                        color: '#aaa',
                        fontSize: '11px',
                        fontFamily: 'monospace',
                        outline: 'none',
                        resize: 'none',
                        boxSizing: 'border-box'
                      }}
                    />
                  ) : (
                    <>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' }}>
                        <div style={{ fontSize: '13px', color: '#DA7756', fontWeight: '500' }}>Claude Default</div>
                        <div
                          onClick={(e) => {
                            e.stopPropagation();
                            setClaudeDefaultPromptEnabled(!claudeDefaultPromptEnabled);
                          }}
                          style={{
                            width: '32px',
                            height: '18px',
                            borderRadius: '9px',
                            backgroundColor: claudeDefaultPromptEnabled ? '#DA7756' : '#444',
                            position: 'relative',
                            cursor: 'pointer',
                            transition: 'background-color 0.2s',
                            flexShrink: 0
                          }}
                        >
                          <div style={{
                            width: '14px',
                            height: '14px',
                            borderRadius: '50%',
                            backgroundColor: '#fff',
                            position: 'absolute',
                            top: '2px',
                            left: claudeDefaultPromptEnabled ? '16px' : '2px',
                            transition: 'left 0.2s'
                          }} />
                        </div>
                      </div>
                      <div style={{ fontSize: '11px', color: claudeDefaultPromptEnabled ? '#666' : '#555', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', opacity: claudeDefaultPromptEnabled ? 1 : 0.5 }}>
                        {claudeDefaultPrompt || 'Не задан'}
                      </div>
                    </>
                  )}
                </div>

                {/* Research Prompt */}
                <div
                  ref={researchEditRef}
                  onClick={() => !editingResearch && setEditingResearch(true)}
                  style={{
                    padding: '12px',
                    backgroundColor: editingResearch ? '#252525' : '#222',
                    border: editingResearch ? '2px solid #0ea5e9' : '2px solid #0ea5e933',
                    borderRadius: '10px',
                    cursor: editingResearch ? 'default' : 'pointer',
                    marginBottom: '10px'
                  }}
                >
                  {editingResearch ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      <textarea
                        value={localResearchPrompt}
                        onChange={(e) => setLocalResearchPrompt(e.target.value)}
                        onBlur={handleResearchBlur}
                        rows={3}
                        autoFocus
                        style={{
                          width: '100%',
                          padding: '8px',
                          backgroundColor: '#1a1a1a',
                          border: '1px solid #444',
                          borderRadius: '6px',
                          color: '#aaa',
                          fontSize: '11px',
                          fontFamily: 'monospace',
                          outline: 'none',
                          resize: 'none',
                          boxSizing: 'border-box'
                        }}
                      />
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span style={{ fontSize: '10px', color: '#888' }}>Модель:</span>
                        {([
                          { value: 'gemini-3-flash-preview', label: 'Flash' },
                          { value: 'gemini-3-pro-preview', label: 'Pro' }
                        ] as const).map((m) => (
                          <button
                            key={m.value}
                            onClick={(e) => { e.stopPropagation(); setChatSettings('research', { model: m.value }); }}
                            style={{
                              padding: '2px 8px',
                              backgroundColor: chatSettings.research.model === m.value ? '#0ea5e9' : '#333',
                              color: chatSettings.research.model === m.value ? '#fff' : '#888',
                              border: 'none',
                              borderRadius: '4px',
                              fontSize: '10px',
                              cursor: 'pointer'
                            }}
                          >
                            {m.label}
                          </button>
                        ))}
                      </div>
                      <button
                        onClick={(e) => { e.stopPropagation(); resetResearch(); }}
                        style={{ alignSelf: 'flex-start', padding: '4px 8px', backgroundColor: 'transparent', color: '#666', border: 'none', fontSize: '10px', cursor: 'pointer' }}
                      >
                        Сбросить
                      </button>
                    </div>
                  ) : (
                    <>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                        <span style={{ fontSize: '13px', color: '#0ea5e9', fontWeight: '500' }}>Research</span>
                        <span style={{ fontSize: '9px', padding: '1px 4px', backgroundColor: '#0ea5e922', color: '#0ea5e9', borderRadius: '3px' }}>
                          {chatSettings.research.model.includes('pro') ? 'PRO' : 'FLASH'}
                        </span>
                      </div>
                      <div style={{ fontSize: '11px', color: '#666', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                        {localResearchPrompt}
                      </div>
                    </>
                  )}
                </div>

                {/* Compact Prompt */}
                <div
                  ref={compactEditRef}
                  onClick={() => !editingCompact && setEditingCompact(true)}
                  style={{
                    padding: '12px',
                    backgroundColor: editingCompact ? '#252525' : '#222',
                    border: editingCompact ? '2px solid #a855f7' : '2px solid #a855f733',
                    borderRadius: '10px',
                    cursor: editingCompact ? 'default' : 'pointer',
                    marginBottom: '10px'
                  }}
                >
                  {editingCompact ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      <textarea
                        value={localCompactPrompt}
                        onChange={(e) => setLocalCompactPrompt(e.target.value)}
                        onBlur={handleCompactBlur}
                        rows={4}
                        autoFocus
                        style={{
                          width: '100%',
                          padding: '8px',
                          backgroundColor: '#1a1a1a',
                          border: '1px solid #444',
                          borderRadius: '6px',
                          color: '#aaa',
                          fontSize: '11px',
                          fontFamily: 'monospace',
                          outline: 'none',
                          resize: 'none',
                          boxSizing: 'border-box'
                        }}
                      />
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span style={{ fontSize: '10px', color: '#888' }}>Модель:</span>
                        {([
                          { value: 'gemini-3-flash-preview', label: 'Flash' },
                          { value: 'gemini-3-pro-preview', label: 'Pro' }
                        ] as const).map((m) => (
                          <button
                            key={m.value}
                            onClick={(e) => { e.stopPropagation(); setChatSettings('compact', { model: m.value }); }}
                            style={{
                              padding: '2px 8px',
                              backgroundColor: chatSettings.compact.model === m.value ? '#a855f7' : '#333',
                              color: chatSettings.compact.model === m.value ? '#fff' : '#888',
                              border: 'none',
                              borderRadius: '4px',
                              fontSize: '10px',
                              cursor: 'pointer'
                            }}
                          >
                            {m.label}
                          </button>
                        ))}
                      </div>
                      <button
                        onClick={(e) => { e.stopPropagation(); resetCompact(); }}
                        style={{ alignSelf: 'flex-start', padding: '4px 8px', backgroundColor: 'transparent', color: '#666', border: 'none', fontSize: '10px', cursor: 'pointer' }}
                      >
                        Сбросить
                      </button>
                    </div>
                  ) : (
                    <>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                        <span style={{ fontSize: '13px', color: '#a855f7', fontWeight: '500' }}>Compact (Резюме)</span>
                        <span style={{ fontSize: '9px', padding: '1px 4px', backgroundColor: '#a855f722', color: '#a855f7', borderRadius: '3px' }}>
                          {chatSettings.compact.model.includes('pro') ? 'PRO' : 'FLASH'}
                        </span>
                      </div>
                      <div style={{ fontSize: '11px', color: '#666', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                        {localCompactPrompt}
                      </div>
                    </>
                  )}
                </div>

                {/* Description Prompt */}
                <div
                  ref={descriptionEditRef}
                  onClick={() => !editingDescription && setEditingDescription(true)}
                  style={{
                    padding: '12px',
                    backgroundColor: editingDescription ? '#252525' : '#222',
                    border: editingDescription ? '2px solid #f59e0b' : '2px solid #f59e0b33',
                    borderRadius: '10px',
                    cursor: editingDescription ? 'default' : 'pointer',
                    marginBottom: '10px'
                  }}
                >
                  {editingDescription ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      <textarea
                        value={localDescriptionPrompt}
                        onChange={(e) => setLocalDescriptionPrompt(e.target.value)}
                        onBlur={handleDescriptionBlur}
                        rows={3}
                        autoFocus
                        style={{
                          width: '100%',
                          padding: '8px',
                          backgroundColor: '#1a1a1a',
                          border: '1px solid #444',
                          borderRadius: '6px',
                          color: '#aaa',
                          fontSize: '11px',
                          fontFamily: 'monospace',
                          outline: 'none',
                          resize: 'none',
                          boxSizing: 'border-box'
                        }}
                      />
                      {/* Model selector */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span style={{ fontSize: '10px', color: '#888' }}>Модель:</span>
                        {([
                          { value: 'gemini-3-flash-preview', label: 'Flash' },
                          { value: 'gemini-3-pro-preview', label: 'Pro' }
                        ] as const).map((m) => (
                          <button
                            key={m.value}
                            onClick={(e) => { e.stopPropagation(); setChatSettings('description', { model: m.value }); }}
                            style={{
                              padding: '2px 8px',
                              backgroundColor: chatSettings.description.model === m.value ? '#f59e0b' : '#333',
                              color: chatSettings.description.model === m.value ? '#fff' : '#888',
                              border: 'none',
                              borderRadius: '4px',
                              fontSize: '10px',
                              cursor: 'pointer'
                            }}
                          >
                            {m.label}
                          </button>
                        ))}
                      </div>
                      <button
                        onClick={(e) => { e.stopPropagation(); resetDescription(); }}
                        style={{ alignSelf: 'flex-start', padding: '4px 8px', backgroundColor: 'transparent', color: '#666', border: 'none', fontSize: '10px', cursor: 'pointer' }}
                      >
                        Сбросить
                      </button>
                    </div>
                  ) : (
                    <>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                        <span style={{ fontSize: '13px', color: '#f59e0b', fontWeight: '500' }}>Description</span>
                        <span style={{ fontSize: '9px', padding: '1px 4px', backgroundColor: '#f59e0b22', color: '#f59e0b', borderRadius: '3px' }}>
                          {chatSettings.description.model.includes('pro') ? 'PRO' : 'FLASH'}
                        </span>
                      </div>
                      <div style={{ fontSize: '11px', color: '#666', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                        {localDescriptionPrompt}
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
                        <button
                          onClick={(e) => { e.stopPropagation(); setDocPromptUseFile(true); }}
                          style={{
                            padding: '3px 8px',
                            backgroundColor: docPrompt.useFile ? '#22c55e' : '#333',
                            color: docPrompt.useFile ? '#fff' : '#888',
                            border: 'none',
                            borderRadius: '4px',
                            fontSize: '10px',
                            cursor: 'pointer'
                          }}
                        >
                          Файл
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); setDocPromptUseFile(false); }}
                          style={{
                            padding: '3px 8px',
                            backgroundColor: !docPrompt.useFile ? '#22c55e' : '#333',
                            color: !docPrompt.useFile ? '#fff' : '#888',
                            border: 'none',
                            borderRadius: '4px',
                            fontSize: '10px',
                            cursor: 'pointer'
                          }}
                        >
                          Inline
                        </button>
                      </div>

                      {docPrompt.useFile ? (
                        <input
                          type="text"
                          value={localDocFilePath}
                          onChange={(e) => setLocalDocFilePath(e.target.value)}
                          onBlur={handleDocBlur}
                          placeholder="Путь к файлу..."
                          autoFocus
                          style={{
                            width: '100%',
                            padding: '8px',
                            backgroundColor: '#1a1a1a',
                            border: '1px solid #444',
                            borderRadius: '6px',
                            color: '#aaa',
                            fontSize: '11px',
                            fontFamily: 'monospace',
                            outline: 'none',
                            boxSizing: 'border-box'
                          }}
                        />
                      ) : (
                        <textarea
                          value={localDocInlineContent}
                          onChange={(e) => setLocalDocInlineContent(e.target.value)}
                          onBlur={handleDocBlur}
                          rows={3}
                          autoFocus
                          style={{
                            width: '100%',
                            padding: '8px',
                            backgroundColor: '#1a1a1a',
                            border: '1px solid #444',
                            borderRadius: '6px',
                            color: '#aaa',
                            fontSize: '11px',
                            fontFamily: 'monospace',
                            outline: 'none',
                            resize: 'none',
                            boxSizing: 'border-box'
                          }}
                        />
                      )}

                      <button
                        onClick={(e) => { e.stopPropagation(); resetDoc(); }}
                        style={{ alignSelf: 'flex-start', padding: '4px 8px', backgroundColor: 'transparent', color: '#666', border: 'none', fontSize: '10px', cursor: 'pointer' }}
                      >
                        Сбросить
                      </button>
                    </div>
                  ) : (
                    <>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                        <span style={{ fontSize: '13px', color: '#22c55e', fontWeight: '500' }}>Documentation</span>
                        <span style={{ fontSize: '9px', padding: '1px 4px', backgroundColor: docPrompt.useFile ? '#22c55e22' : '#8b5cf622', color: docPrompt.useFile ? '#22c55e' : '#8b5cf6', borderRadius: '3px' }}>
                          {docPrompt.useFile ? 'ФАЙЛ' : 'INLINE'}
                        </span>
                      </div>
                      <div style={{ fontSize: '11px', color: '#666', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {docPrompt.useFile ? localDocFilePath : (localDocInlineContent || 'Не задан')}
                      </div>
                    </>
                  )}
                </div>
              </div>

              {/* Right Column - User Prompts */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
                  <div style={{ fontSize: '11px', fontWeight: '600', color: '#666', textTransform: 'uppercase' }}>
                    Контекстное меню
                  </div>
                  <button
                    onClick={addPrompt}
                    style={{
                      padding: '4px 10px',
                      backgroundColor: '#8b5cf6',
                      color: '#fff',
                      border: 'none',
                      borderRadius: '4px',
                      fontSize: '10px',
                      cursor: 'pointer'
                    }}
                  >
                    + Добавить
                  </button>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {prompts.length === 0 ? (
                    <div style={{
                      padding: '24px',
                      textAlign: 'center',
                      color: '#555',
                      fontSize: '12px',
                      border: '2px dashed #333',
                      borderRadius: '10px'
                    }}>
                      Пока нет промптов
                    </div>
                  ) : (
                    prompts.map((prompt, index) => (
                      <div
                        key={index}
                        ref={(el) => { if (el) promptEditRefs.current.set(index, el); }}
                        onClick={() => editingPrompt !== index && setEditingPrompt(index)}
                        style={{
                          padding: '12px',
                          backgroundColor: editingPrompt === index ? '#252525' : '#222',
                          border: editingPrompt === index ? '2px solid #8b5cf6' : '2px solid #333',
                          borderRadius: '10px',
                          cursor: editingPrompt === index ? 'default' : 'pointer'
                        }}
                      >
                        {editingPrompt === index ? (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                            <input
                              type="text"
                              value={prompt.title}
                              onChange={(e) => updatePrompt(index, 'title', e.target.value)}
                              onBlur={(e) => handlePromptBlur(e, index)}
                              placeholder="Название"
                              autoFocus
                              style={{
                                width: '100%',
                                padding: '8px',
                                backgroundColor: '#1a1a1a',
                                border: '1px solid #444',
                                borderRadius: '6px',
                                color: '#fff',
                                fontSize: '12px',
                                outline: 'none',
                                boxSizing: 'border-box'
                              }}
                            />
                            <textarea
                              value={prompt.content}
                              onChange={(e) => updatePrompt(index, 'content', e.target.value)}
                              onBlur={(e) => handlePromptBlur(e, index)}
                              placeholder="Содержимое..."
                              rows={2}
                              style={{
                                width: '100%',
                                padding: '8px',
                                backgroundColor: '#1a1a1a',
                                border: '1px solid #444',
                                borderRadius: '6px',
                                color: '#aaa',
                                fontSize: '11px',
                                fontFamily: 'monospace',
                                outline: 'none',
                                resize: 'none',
                                boxSizing: 'border-box'
                              }}
                            />
                            <button
                              onClick={(e) => { e.stopPropagation(); deletePrompt(index); }}
                              style={{ alignSelf: 'flex-start', padding: '4px 8px', backgroundColor: 'transparent', color: '#ef4444', border: 'none', fontSize: '10px', cursor: 'pointer' }}
                            >
                              Удалить
                            </button>
                          </div>
                        ) : (
                          <>
                            <div style={{ fontSize: '13px', color: '#fff', fontWeight: '500', marginBottom: '2px' }}>{prompt.title}</div>
                            {prompt.content && (
                              <div style={{ fontSize: '11px', color: '#666', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                                {prompt.content}
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
