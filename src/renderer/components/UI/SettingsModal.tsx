import React, { useEffect, useLayoutEffect, useState, useRef, useCallback, useMemo } from 'react';
import { useUIStore } from '../../store/useUIStore';
import { usePromptsStore, AIPrompt, AIModel, ThinkingLevel, PROMPT_SUMMARY_PROMPT_ID } from '../../store/usePromptsStore';
import { GEMINI_MODEL_OPTIONS } from '../../constants/geminiModels';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useMirrorStatusStore } from '../../store/useMirrorStatusStore';
import { useTimelineSummaryStore } from '../../store/useTimelineSummaryStore';
import Tooltip from './Tooltip';
import ControlHint from './ControlHint';
import ProjectIconsSettings from './ProjectIconsSettings';
import { TabProcessBar } from '../Workspace/TabSignals';
import { HexColorPicker } from 'react-colorful';
import { ChevronDown, ChevronRight, CircleX, Loader2, Pencil, Trash2, Plus } from 'lucide-react';
import {
  CLAUDE_EFFORT_LEVELS,
  claudeEffortsForModel,
  claudeSupportedEffortsForModel,
  DEFAULT_CLAUDE_CODE_SETTINGS,
  DEFAULT_CLAUDE_EFFORT_OPTIONS,
  resolveClaudeEffortForModel,
  type ClaudeEffortOption,
  type ClaudeCodeModelOption,
} from '../../constants/claudeLevels';
import {
  codexSupportedEffortsForModel,
  DEFAULT_CODEX_SETTINGS,
  DEFAULT_CODEX_EFFORT_OPTIONS,
  DEFAULT_CODEX_MODEL_OPTIONS,
  mergeCodexModelOptions,
  resolveCodexPersistentEffortForModel,
  type CodexEffortOption,
  type CodexModelOption,
} from '../../constants/codexSettings';
import {
  buildVisualHierarchyDepthMap,
  orderVisualHierarchyItems,
} from '@noted/structured-dnd';
import { useOutlineDnd } from '@noted/structured-dnd/react';
import {
  applyPromptOutline,
  buildPromptOutline,
  promptOutlineHorizontalPolicy,
  promptOutlineVerticalSlotPolicy,
} from './promptOutlineModel.mjs';
import { normalizeInterruptedRestoreParallelism } from '../../utils/interruptedAutoRestore.mjs';
import { useInlineRenameInputRef } from '../../hooks/useInlineRenameInput';
import {
  applySavedPromptLibraryUpdate,
  mergeSavedPromptDraft,
  reconcileSavedPromptEditor,
  subscribeSavedPromptLibraryChanges,
  subscribeSavedPromptUpdates,
} from '../../utils/savedPromptUpdateEvents.mjs';

const { ipcRenderer, clipboard } = window.require('electron');

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  // Опциональный override начального таба — используется при программном открытии
  // (например, ПКМ на SemanticIndexButton → 'colors'/«Системные»). Если null,
  // модалка показывает lastActiveTab из локальной переменной (стандартное поведение).
  initialTab?: string | null;
}

interface PromptGroup {
  id: number;
  name: string;
  description: string;
  position: number;
  is_collapsed: boolean;
}

interface Prompt {
  id: string;
  title: string;
  content: string;
  group_id?: number | null;
  visual_parent_id?: string | null;
  position?: number;
  file_paths?: string[];
}

type PromptDragState = { prompts: Prompt[]; promptGroups: PromptGroup[] };
type PromptTreeNodeKind = 'prompt' | 'group';
type PromptTreeRename = { kind: PromptTreeNodeKind; id: string | number };
type PromptTreeContextMenu = PromptTreeRename & { x: number; y: number };
type FlatPromptItem = { type: 'prompt'; origIdx: number; prompt: Prompt };
type FlatGroupItem = { type: 'group'; group: PromptGroup };
type FlatItem = FlatPromptItem | FlatGroupItem;

type SettingsTab = 'shortcuts' | 'fonts' | 'colors' | 'ai' | 'projects';
type AISubTab = 'text' | 'system' | 'usage';
type AIUsageRange = 'week' | 'month' | 'all';

const VR_ACCENT = '#3b82f6';
const VR_CARD = '#1e1e22';
const VR_FIELD = '#141417';
const VR_BORDER = '#2c2c30';
const VR_TEXT = '#e8e8ea';
const VR_DIM = '#8a8a8d';
const VR_VIOLET = '#7c3aed';
let promptIdSequence = 0;
const newTextPromptId = () => `prompt-${Date.now().toString(36)}-${(promptIdSequence++).toString(36)}`;
const VR_GREEN = '#22c55e';
const VR_RED = '#ef4444';


// Track if settings was opened at least once (for default tab)
let hasOpenedBefore = false;
let lastActiveTab: SettingsTab = 'ai';
// Same lifetime as settingsScrollPositions: closing/reopening Settings keeps
// the user's working view, while a real app restart returns the deliberately
// dense model editor to its compact default.
let modelSettingsExpandedForSession = false;
// Session-only by design: survives tab switches and closing/reopening the
// modal, but a real app quit reloads this module and clears every position.
const settingsScrollPositions = new Map<string, number>();
const restoreSettingsScrollPosition = (key: string, node: HTMLElement | null) => {
  if (!node) return;
  node.scrollTop = settingsScrollPositions.get(key) || 0;
};
const rememberSettingsScrollPosition = (key: string, scrollTop: number) => {
  settingsScrollPositions.set(key, Math.max(0, scrollTop));
};

// Shortcuts data
const SHORTCUTS = [
  { keys: '⌘ + T', description: 'Новый таб' },
  { keys: '⌘ + B', description: 'Показать/скрыть боковую панель' },
  { keys: '⌘ + ,', description: 'Открыть настройки' },
  { keys: '⌥ + V', description: 'Prompt picker (вставка промпта)' },
  { keys: '⌘ + ⇧ + R', description: 'Перезагрузить приложение' },
];

// Compact font-size stepper. The previous slider variant ate vertical space (each
// row took 90px) and the slider track was meaningless for ±1px font tweaks — users
// always end up clicking +/- to nudge a single px anyway. New row: label + small
// stepper on the right, ~36px tall, fits two columns at 900px width.
function FontSizeSlider({
  label,
  description,
  value,
  onChange,
  min,
  max,
  suffix = 'px',
  disabled = false,
}: {
  label: string;
  description?: string;          // опционально — без описания строка тоньше
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  suffix?: string;
  // disabled — показываем значение read-only, без +/− и без редактирования.
  // Используется когда величина задаётся в другом месте (напр. resize-ручкой),
  // а здесь только отражается по факту.
  disabled?: boolean;
}) {
  // Editable число вместо read-only display. На focus убираем suffix (`12px` → `12`)
  // чтобы можно было сразу ввести значение клавиатурой без `Backspace × 2`.
  // На blur коммитим clamped-число; невалидный ввод откатывается к текущему value.
  const [focused, setFocused] = React.useState(false);
  const [draft, setDraft] = React.useState<string>('');
  const display = focused ? draft : `${value}${suffix}`;
  const commit = () => {
    const n = parseFloat(draft);
    if (Number.isFinite(n)) {
      onChange(Math.max(min, Math.min(max, n)));
    }
    setFocused(false);
  };
  // Объединённый stepper: [−] [123 px] [+] в одной капсуле. Раньше были два отдельных
  // 24×24 кнопки + 52px input — занимали 80px ширины + 4px gap'ы. Капсула забирает
  // 92px цельной кнопкой, читается как один контрол, выглядит компактнее.
  const stepperBtnStyle: React.CSSProperties = {
    width: '20px',
    height: '22px',
    border: 'none',
    background: 'transparent',
    color: '#aaa',
    cursor: 'pointer',
    fontSize: '13px',
    lineHeight: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    userSelect: 'none',
  };
  return (
    <div style={{
      padding: '5px 10px',
      backgroundColor: '#1f1f1f',
      border: '1px solid #2a2a2a',
      borderRadius: '7px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '10px',
      minHeight: 0,
      opacity: disabled ? 0.6 : 1,
    }}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: '12px', color: '#eaeaea', fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</div>
        {description && (
          <div style={{ fontSize: '10px', color: '#666', marginTop: '1px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{description}</div>
        )}
      </div>
      {disabled ? (
        // Read-only display: значение по факту, без +/− и без редактирования
        // (величина управляется в другом месте — напр. resize-ручкой превью).
        <div style={{
          flexShrink: 0,
          padding: '0 10px',
          height: '24px',
          display: 'flex',
          alignItems: 'center',
          backgroundColor: '#262626',
          border: '1px solid #2a2a2a',
          borderRadius: '6px',
          fontSize: '11px',
          color: '#888',
          fontVariantNumeric: 'tabular-nums',
          fontFamily: 'monospace',
        }}>{value}{suffix}</div>
      ) : (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        flexShrink: 0,
        backgroundColor: '#262626',
        border: '1px solid #2a2a2a',
        borderRadius: '6px',
        overflow: 'hidden',
      }}>
        <button
          aria-label="-"
          style={stepperBtnStyle}
          disabled={value <= min}
          onClick={() => onChange(Math.max(min, value - 1))}
        >−</button>
        <input
          type="text"
          inputMode="numeric"
          value={display}
          onFocus={(e) => {
            setDraft(String(value));
            setFocused(true);
            requestAnimationFrame(() => e.target.select());
          }}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { (e.target as HTMLInputElement).blur(); }
            else if (e.key === 'Escape') { setDraft(String(value)); (e.target as HTMLInputElement).blur(); }
          }}
          style={{
            width: '40px',
            textAlign: 'center',
            fontSize: '11px',
            color: '#fff',
            fontVariantNumeric: 'tabular-nums',
            padding: '0',
            backgroundColor: 'transparent',
            border: 'none',
            borderLeft: '1px solid #2a2a2a',
            borderRight: '1px solid #2a2a2a',
            fontFamily: 'monospace',
            outline: 'none',
            height: '22px',
          }}
        />
        <button
          aria-label="+"
          style={stepperBtnStyle}
          disabled={value >= max}
          onClick={() => onChange(Math.min(max, value + 1))}
        >+</button>
      </div>
      )}
    </div>
  );
}

// Settings layout primitives — главный заголовок секции, под-заголовок (tree-style)
// и 4-col grid. Все блоки в табе «Размеры» строятся через них для одной стилистики.
// Раньше каждый редактор имел свой card-wrapper (padding+bg+border) — выглядело
// как самостоятельные виджеты вместо единого списка настроек.
function SettingsSectionHeader({ title, first }: { title: string; first?: boolean }) {
  return (
    <div style={{
      fontSize: '11px',
      fontWeight: 600,
      color: '#666',
      textTransform: 'uppercase',
      letterSpacing: '0.04em',
      marginTop: first ? '0' : '20px',
      marginBottom: '10px',
      paddingTop: first ? '0' : '14px',
      borderTop: first ? 'none' : '1px solid #2a2a2a',
    }}>
      {title}
    </div>
  );
}

function SettingsSubSectionHeader({ title }: { title: string }) {
  return (
    <div style={{
      fontSize: '10px',
      fontWeight: 600,
      color: '#888',
      textTransform: 'uppercase',
      letterSpacing: '0.04em',
      marginTop: '12px',
      marginBottom: '6px',
      paddingLeft: '12px',
    }}>
      ╰ {title}
    </div>
  );
}

function ModelSettingsColumnHeader({
  title,
  accent,
  onAdd,
  addTitle,
}: {
  title: string;
  accent: string;
  onAdd: () => void;
  addTitle?: string;
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
      marginTop: '12px', marginBottom: '6px', paddingLeft: '12px',
    }}>
      <div style={{
        fontSize: '10px', fontWeight: 600, color: '#888', textTransform: 'uppercase',
        letterSpacing: '0.04em',
      }}>
        ╰ {title}
      </div>
      <button
        type="button"
        onClick={onAdd}
        title={addTitle || `Добавить модель ${title}`}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          height: 23, padding: '0 7px', borderRadius: 6,
          border: `1px solid ${accent}66`, background: `${accent}14`, color: accent,
          fontSize: 10.5, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
        }}
      >
        <Plus size={12} strokeWidth={2.25} />
        Добавить новую
      </button>
    </div>
  );
}

function compactEffortLabel(label: string): string {
  if (label === 'medium') return 'med';
  if (label === 'xhigh') return 'xhi';
  if (label === 'ultracode') return 'ultra';
  return label;
}

type ModelSettingsTreeRowProps = {
  accent: string;
  model: Pick<ClaudeCodeModelOption, 'id' | 'label' | 'efforts' | 'supportedEfforts' | 'visible'>;
  effortOptions: readonly { key: string; id: string; label: string }[];
  onVisibleChange: (visible: boolean) => void;
  onLabelCommit: (label: string) => void;
  onCommandCommit: (command: string) => void;
  onEffortChange: (effort: string, selected: boolean) => void;
  onDelete: () => void;
};

// One compact model tree is shared by Claude and Codex. The first line names
// the model and its command; the indented second line owns that model's
// available effort levels, rather than creating a detached wall of controls.
function ModelSettingsTreeRow({
  accent,
  model,
  effortOptions,
  onVisibleChange,
  onLabelCommit,
  onCommandCommit,
  onEffortChange,
  onDelete,
}: ModelSettingsTreeRowProps) {
  const selectedEfforts = (model.efforts || []).filter(Boolean);
  const [deleteHovered, setDeleteHovered] = useState(false);
  const [label, setLabel] = useState(model.label);
  const [command, setCommand] = useState(model.id);

  useEffect(() => setLabel(model.label), [model.label]);
  useEffect(() => setCommand(model.id), [model.id]);

  return (
    <div style={{ padding: '5px 0 6px', borderBottom: '1px solid rgba(255,255,255,0.055)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '20px minmax(74px, 0.62fr) minmax(130px, 1fr) 24px', gap: 6, alignItems: 'center' }}>
        <input
          type="checkbox"
          checked={model.visible !== false}
          onChange={(event) => onVisibleChange(event.currentTarget.checked)}
          aria-label={`Показывать ${model.label} в выборе модели`}
          title="Показывать модель в обычном выборе"
          style={{ width: 14, height: 14, margin: '0 auto', accentColor: accent, cursor: 'pointer' }}
        />
        <input
          value={label}
          onChange={(event) => setLabel(event.currentTarget.value)}
          onBlur={() => onLabelCommit(label)}
          onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
          aria-label={`Название модели ${model.label}`}
          style={{ ...vrFieldStyle, height: 28, fontSize: 11.5, padding: '5px 7px' }}
          title="Название в интерфейсе"
        />
        <input
          value={command}
          onChange={(event) => setCommand(event.currentTarget.value)}
          onBlur={() => onCommandCommit(command)}
          onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
          aria-label={`Команда модели ${model.label}`}
          style={{ ...vrFieldStyle, height: 28, fontSize: 11.5, padding: '5px 7px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
          title="Команда, которую приложение отправляет Claude или Codex"
        />
        <button
          type="button"
          onClick={onDelete}
          onMouseEnter={() => setDeleteHovered(true)}
          onMouseLeave={() => setDeleteHovered(false)}
          aria-label={`Удалить модель ${model.label}`}
          title={`Удалить ${model.label}`}
          style={{
            width: 24,
            height: 24,
            padding: 0,
            border: 'none',
            borderRadius: 6,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: deleteHovered ? 'rgba(239,68,68,0.18)' : 'transparent',
            color: deleteHovered ? '#ff6262' : '#6d3438',
            cursor: 'pointer',
            transition: 'background 120ms ease, color 120ms ease',
          }}
        >
          <Trash2 size={13} strokeWidth={1.8} />
        </button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '20px minmax(0, 1fr) 24px', gap: 6, marginTop: 4 }}>
        <div aria-hidden style={{ position: 'relative', minHeight: 23 }}>
          <span style={{ position: 'absolute', left: '50%', top: -4, bottom: 11, width: 1, background: 'rgba(255,255,255,0.16)' }} />
          <span style={{ position: 'absolute', left: '50%', top: 11, width: 8, height: 1, background: 'rgba(255,255,255,0.16)' }} />
        </div>
        <div style={{ minWidth: 0, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '3px 5px', minHeight: 23 }}>
          <span style={{ color: '#6d6d72', fontSize: 10, marginRight: 1, whiteSpace: 'nowrap' }}>effort</span>
          {effortOptions.map((effort) => {
            const selected = selectedEfforts.includes(effort.id);
            const isLastSelected = selected && selectedEfforts.length <= 1;
            return (
              <label
                key={effort.key}
                title={isLastSelected ? 'Хотя бы один уровень должен оставаться доступным' : `Разрешить ${effort.label} для ${model.label}`}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 3,
                  height: 20, padding: 0,
                  border: 'none',
                  background: 'transparent',
                  color: selected ? '#ddd' : '#666',
                  fontSize: 10, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  cursor: isLastSelected ? 'default' : 'pointer',
                  userSelect: 'none',
                  opacity: isLastSelected ? 0.72 : 1,
                }}
              >
                <input
                  type="checkbox"
                  checked={selected}
                  disabled={isLastSelected}
                  onChange={(event) => onEffortChange(effort.id, event.currentTarget.checked)}
                  aria-label={`Разрешить ${effort.label} для ${model.label}`}
                  style={{ width: 11, height: 11, margin: 0, accentColor: accent, cursor: isLastSelected ? 'not-allowed' : 'pointer' }}
                />
                {compactEffortLabel(effort.label)}
              </label>
            );
          })}
        </div>
        <span aria-hidden />
      </div>
    </div>
  );
}

type EffortSettingsTreeRowProps = {
  option: { key: string; id: string; label: string };
  provider: string;
  onLabelCommit: (label: string) => void;
  onCommandCommit: (command: string) => void;
  onDelete: () => void;
  commandReadOnly?: boolean;
};

/** Catalog rows own the reusable effort values; model-row checkboxes only opt in. */
function EffortSettingsTreeRow({
  option,
  provider,
  onLabelCommit,
  onCommandCommit,
  onDelete,
  commandReadOnly = false,
}: EffortSettingsTreeRowProps) {
  const [label, setLabel] = useState(option.label);
  const [command, setCommand] = useState(option.id);
  const [deleteHovered, setDeleteHovered] = useState(false);

  useEffect(() => setLabel(option.label), [option.label]);
  useEffect(() => setCommand(option.id), [option.id]);

  return (
    <div style={{ padding: '4px 0', borderBottom: '1px solid rgba(255,255,255,0.055)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '20px minmax(74px, 0.62fr) minmax(130px, 1fr) 24px', gap: 6, alignItems: 'center' }}>
        <div aria-hidden />
        <input
          value={label}
          onChange={(event) => setLabel(event.currentTarget.value)}
          onBlur={() => onLabelCommit(label)}
          onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
          aria-label={`Название effort ${option.label} для ${provider}`}
          title="Название в интерфейсе"
          style={{ ...vrFieldStyle, height: 28, fontSize: 11.5, padding: '5px 7px' }}
        />
        <input
          value={command}
          readOnly={commandReadOnly}
          onChange={(event) => setCommand(event.currentTarget.value)}
          onBlur={() => onCommandCommit(command)}
          onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
          aria-label={`Команда effort ${option.label} для ${provider}`}
          title={commandReadOnly
            ? 'Значение подтверждается live-каталогом Codex; новое значение добавьте отдельной строкой'
            : 'Значение, которое приложение отправляет агенту'}
          style={{
            ...vrFieldStyle,
            height: 28,
            fontSize: 11.5,
            padding: '5px 7px',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            opacity: commandReadOnly ? 0.58 : 1,
            cursor: commandReadOnly ? 'not-allowed' : 'text',
          }}
        />
        <button
          type="button"
          onClick={onDelete}
          onMouseEnter={() => setDeleteHovered(true)}
          onMouseLeave={() => setDeleteHovered(false)}
          aria-label={`Удалить effort ${option.label} для ${provider}`}
          title={`Удалить ${option.label}`}
          style={{
            width: 24, height: 24, padding: 0, border: 'none', borderRadius: 6,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            background: deleteHovered ? 'rgba(239,68,68,0.18)' : 'transparent',
            color: deleteHovered ? '#ff6262' : '#6d3438', cursor: 'pointer',
            transition: 'background 120ms ease, color 120ms ease',
          }}
        >
          <Trash2 size={13} strokeWidth={1.8} />
        </button>
      </div>
    </div>
  );
}

function SettingsGrid4({ children }: { children: React.ReactNode }) {
  // 3-col grid (имя SettingsGrid4 оставлено для обратной совместимости — переименовать
  // позже). minmax(260px) даёт ровно 3 колонки на 1200px-модалке и 2 на ~800px.
  // Раньше было 5 — слишком узкие карточки, лейблы налезали.
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
      gap: '6px',
    }}>
      {children}
    </div>
  );
}

// PaddingRow — один контрол для пары X/Y. Раньше были два отдельных FontSizeSlider
// «Отступ X» и «Отступ Y» — занимали две клетки grid'а, при том что это семантически
// одна настройка. Юзер: «padding x и padding y должны быть в одной карточке».
// Реализация: один лейбл «Отступы», справа два мини-stepper'а с маленьким префиксом X / Y.
function PaddingRow({
  valueX,
  valueY,
  onChangeX,
  onChangeY,
  minX = 0, maxX = 48,
  minY = 0, maxY = 48,
}: {
  valueX: number;
  valueY: number;
  onChangeX: (v: number) => void;
  onChangeY: (v: number) => void;
  minX?: number; maxX?: number;
  minY?: number; maxY?: number;
}) {
  const stepperBtnStyle: React.CSSProperties = {
    width: '18px', height: '20px',
    border: 'none', background: 'transparent', color: '#aaa',
    cursor: 'pointer', fontSize: '12px', lineHeight: 1,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    userSelect: 'none',
  };
  const inputStyle: React.CSSProperties = {
    width: '32px', textAlign: 'center', fontSize: '11px',
    color: '#fff', fontVariantNumeric: 'tabular-nums',
    padding: '0', backgroundColor: 'transparent',
    border: 'none',
    borderLeft: '1px solid #2a2a2a', borderRight: '1px solid #2a2a2a',
    fontFamily: 'monospace', outline: 'none', height: '20px',
  };

  const Stepper = ({ value, onChange, min, max, axis }: { value: number; onChange: (v: number) => void; min: number; max: number; axis: 'X' | 'Y' }) => (
    <div style={{
      display: 'flex', alignItems: 'center', flexShrink: 0,
      backgroundColor: '#262626', border: '1px solid #2a2a2a', borderRadius: '6px',
      overflow: 'hidden',
    }}>
      <span style={{ fontSize: '9px', color: '#666', padding: '0 4px', fontWeight: 600 }}>{axis}</span>
      <button style={stepperBtnStyle} disabled={value <= min} onClick={() => onChange(Math.max(min, value - 1))}>−</button>
      <input
        type="text"
        inputMode="numeric"
        value={`${value}px`}
        onChange={(e) => {
          const n = parseFloat(e.target.value);
          if (Number.isFinite(n)) onChange(Math.max(min, Math.min(max, n)));
        }}
        style={inputStyle}
      />
      <button style={stepperBtnStyle} disabled={value >= max} onClick={() => onChange(Math.min(max, value + 1))}>+</button>
    </div>
  );

  return (
    <div style={{
      padding: '5px 10px',
      backgroundColor: '#1f1f1f',
      border: '1px solid #2a2a2a',
      borderRadius: '7px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '8px',
      minHeight: 0,
    }}>
      <span style={{ fontSize: '12px', color: '#eaeaea', fontWeight: 500 }}>Отступы</span>
      <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
        <Stepper value={valueX} onChange={onChangeX} min={minX} max={maxX} axis="X" />
        <Stepper value={valueY} onChange={onChangeY} min={minY} max={maxY} axis="Y" />
      </div>
    </div>
  );
}

// Sidebar behavior toggles (Cmd+/ persistence + click-outside-close).
// Extracted to its own component so the hooks live at top level (not inside an IIFE
// inside the main render — that would conditionally call hooks per render branch).
// Заголовок секции рендерится снаружи (SettingsSubSectionHeader), здесь — только toggles.
function SidebarBehaviorToggles() {
  const sidebarPersistFile = useUIStore((s) => s.sidebarPersistFile);
  const setSidebarPersistFile = useUIStore((s) => s.setSidebarPersistFile);
  const sidebarOverlayCloseOnClickOutside = useUIStore((s) => s.sidebarOverlayCloseOnClickOutside);
  const setSidebarOverlayCloseOnClickOutside = useUIStore((s) => s.setSidebarOverlayCloseOnClickOutside);

  return (
    <div>
      <Tooltip content="Если ВКЛ — при повторном открытии сайдбара восстанавливается ранее открытый файл. Если ВЫКЛ — открывается только дерево.">
        <label className="flex items-start gap-3 cursor-pointer select-none mb-3">
          <div
            className="relative w-8 h-4 rounded-full transition-colors mt-0.5 shrink-0"
            style={{ backgroundColor: sidebarPersistFile ? 'rgba(74, 222, 128, 0.4)' : 'rgba(255,255,255,0.1)' }}
            onClick={() => setSidebarPersistFile(!sidebarPersistFile)}
          >
            <div
              className="absolute top-0.5 w-3 h-3 rounded-full transition-all"
              style={{
                left: sidebarPersistFile ? '18px' : '2px',
                backgroundColor: sidebarPersistFile ? '#4ade80' : '#666',
              }}
            />
          </div>
          <div>
            <div style={{ fontSize: '13px', color: '#ccc' }}>Восстанавливать файл при открытии</div>
            <div style={{ fontSize: '11px', color: '#666' }}>Если выкл — Cmd+/ всегда показывает только дерево</div>
          </div>
        </label>
      </Tooltip>

      <Tooltip content="Закрывать файловый сайдбар при клике вне его рабочей области.">
        <label className="flex items-start gap-3 cursor-pointer select-none">
          <div
            className="relative w-8 h-4 rounded-full transition-colors mt-0.5 shrink-0"
            style={{ backgroundColor: sidebarOverlayCloseOnClickOutside ? 'rgba(74, 222, 128, 0.4)' : 'rgba(255,255,255,0.1)' }}
            onClick={() => setSidebarOverlayCloseOnClickOutside(!sidebarOverlayCloseOnClickOutside)}
          >
            <div
              className="absolute top-0.5 w-3 h-3 rounded-full transition-all"
              style={{
                left: sidebarOverlayCloseOnClickOutside ? '18px' : '2px',
                backgroundColor: sidebarOverlayCloseOnClickOutside ? '#4ade80' : '#666',
              }}
            />
          </div>
          <div>
            <div style={{ fontSize: '13px', color: '#ccc' }}>Закрывать кликом вне</div>
            <div style={{ fontSize: '11px', color: '#666' }}>Файловый сайдбар открывается поверх рабочей области</div>
          </div>
        </label>
      </Tooltip>
    </div>
  );
}

// Унифицированный toggle-ряд для самостоятельных булевых настроек.
function LineNumbersToggle({
  checked,
  onChange,
  label,
  description,
  tooltip,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  description: string;
  tooltip: string;
}) {
  return (
    <Tooltip content={tooltip}>
      <label className="flex items-start gap-3 cursor-pointer select-none">
        <div
          className="relative w-8 h-4 rounded-full transition-colors mt-0.5 shrink-0"
          style={{ backgroundColor: checked ? 'rgba(74, 222, 128, 0.4)' : 'rgba(255,255,255,0.1)' }}
          onClick={() => onChange(!checked)}
        >
          <div
            className="absolute top-0.5 w-3 h-3 rounded-full transition-all"
            style={{
              left: checked ? '18px' : '2px',
              backgroundColor: checked ? '#4ade80' : '#666',
            }}
          />
        </div>
        <div>
          <div style={{ fontSize: '13px', color: '#ccc' }}>{label}</div>
          <div style={{ fontSize: '11px', color: '#666' }}>{description}</div>
        </div>
      </label>
    </Tooltip>
  );
}

// Общий hex-normalizer для всех color input'ов. Принимает 'fff' / '#fff' / 'ffffff' /
// '#ffffff' / 'FFF...'; всё что не парсится — null, caller оставляет старый цвет.
function normalizeHexValue(raw: string): string | null {
  let v = raw.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(v)) v = v.split('').map((c) => c + c).join('');
  if (/^[0-9a-fA-F]{6}$/.test(v)) return `#${v.toUpperCase()}`;
  return null;
}

function hexToRgbTriplet(hex: string, fallback = '255, 255, 255') {
  const v = (hex || '').trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(v)) return fallback;
  const n = parseInt(v, 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

function opacityPctToAlpha(pct: number, fallback = 55) {
  const safe = Number.isFinite(pct) ? pct : fallback;
  return Math.max(5, Math.min(100, Math.round(safe))) / 100;
}

// ClaudeMdMirrorBlock — секция «Зеркала CLAUDE.md» в табе «Системные».
// Полностью read-only кроме toggle и кнопок «Создать сейчас» / «Перезаписать».
// Статус живёт в useMirrorStatusStore, флаг — в useUIStore.
function ClaudeMdMirrorBlock({
  enabled,
  onToggle,
  status,
  activeProjectId,
}: {
  enabled: boolean;
  onToggle: (on: boolean) => void;
  status: any;
  activeProjectId: string | null;
}) {
  const [skillsSyncBusy, setSkillsSyncBusy] = useState(false);
  const [skillsSyncResult, setSkillsSyncResult] = useState<any>(null);
  const [skillsStatus, setSkillsStatus] = useState<any>(null);
  const [skillsStatusBusy, setSkillsStatusBusy] = useState(false);
  const [skillsJustSynced, setSkillsJustSynced] = useState(false);
  const skillsSyncedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const formatTime = (ms: number | null) => {
    if (!ms) return null;
    const d = new Date(ms);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const sameDay = new Date().toDateString() === d.toDateString();
    return sameDay ? `${hh}:${mm}` : d.toLocaleDateString() + ' ' + `${hh}:${mm}`;
  };
  const formatBytes = (n: number) => {
    if (n < 1024) return `${n} Б`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} КБ`;
    return `${(n / (1024 * 1024)).toFixed(2)} МБ`;
  };

  const loadSkillsStatus = async () => {
    setSkillsStatusBusy(true);
    try {
      const result = await ipcRenderer.invoke('skills:get-sync-status');
      setSkillsStatus(result);
      return result;
    } catch (e: any) {
      const result = { success: false, error: e?.message || String(e) };
      setSkillsStatus(result);
      return result;
    } finally {
      setSkillsStatusBusy(false);
    }
  };

  useEffect(() => {
    void loadSkillsStatus();
  }, []);

  useEffect(() => {
    const handler = (_event: any, payload: any) => {
      if (payload?.status) setSkillsStatus(payload.status);
      if (payload?.reason && payload.reason !== 'manual') setSkillsSyncResult(null);
    };
    ipcRenderer.on('skills:sync-status', handler);
    return () => {
      ipcRenderer.removeListener('skills:sync-status', handler);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (skillsSyncedTimer.current) clearTimeout(skillsSyncedTimer.current);
    };
  }, []);

  const clearSkillsSyncedTimer = () => {
    if (skillsSyncedTimer.current) {
      clearTimeout(skillsSyncedTimer.current);
      skillsSyncedTimer.current = null;
    }
  };

  const flashSkillsSynced = () => {
    clearSkillsSyncedTimer();
    setSkillsJustSynced(true);
    skillsSyncedTimer.current = setTimeout(() => {
      setSkillsJustSynced(false);
      skillsSyncedTimer.current = null;
    }, 1000);
  };

  const syncSkillsNow = async () => {
    clearSkillsSyncedTimer();
    setSkillsJustSynced(false);
    setSkillsSyncBusy(true);
    try {
      const result = await ipcRenderer.invoke('skills:sync-claude-to-codex');
      setSkillsSyncResult(result);
      if (result?.status) setSkillsStatus(result.status);
      else await loadSkillsStatus();
      if (result?.success) flashSkillsSynced();
      return result;
    } catch (e: any) {
      const result = { success: false, error: e?.message || String(e) };
      setSkillsSyncResult(result);
      return result;
    } finally {
      setSkillsSyncBusy(false);
    }
  };

  const requestCreateNow = async () => {
    if (!activeProjectId) return;
    try {
      await window.require('electron').ipcRenderer.invoke('mirror:create-now', { projectId: activeProjectId });
      await syncSkillsNow();
    } catch {}
  };

  const currentSkillsStatus = skillsSyncResult?.status || skillsStatus;
  const codexOnlySkills: string[] = Array.isArray(currentSkillsStatus?.codexOnly) ? currentSkillsStatus.codexOnly : [];
  const missingInCodexSkills: string[] = Array.isArray(currentSkillsStatus?.missingInCodex) ? currentSkillsStatus.missingInCodex : [];
  const skillsHasWarning = codexOnlySkills.length > 0;
  const skillsWatcher = currentSkillsStatus?.watcher;
  const skillsAutoError = skillsWatcher?.lastAutoSyncError;
  const skillsAutoLabel = skillsWatcher?.active
    ? `авто ${skillsWatcher.lastAutoSyncAt ? formatTime(skillsWatcher.lastAutoSyncAt) : 'вкл'}`
    : 'авто выкл';
  const skillsButtonSynced = !skillsSyncBusy && skillsJustSynced;
  const skillsIconColor = skillsSyncResult?.success === false || currentSkillsStatus?.success === false || skillsAutoError
    ? '#ef4444'
    : skillsHasWarning ? '#d97706'
    : skillsSyncResult?.success ? '#22c55e'
    : '#999';
  const skillsIcon = skillsSyncResult?.success === false || currentSkillsStatus?.success === false || skillsAutoError
    ? '✕'
    : skillsHasWarning ? '⚠'
    : skillsSyncResult?.success ? '✓'
    : '↔';
  const skillsStatusText = (() => {
    if (skillsSyncResult?.success === false) {
      return `Ошибка: ${skillsSyncResult.error || (skillsSyncResult.errors?.[0]?.error) || 'не удалось синхронизировать'}`;
    }
    if (currentSkillsStatus?.success === false) {
      return `Ошибка статуса: ${currentSkillsStatus.error || 'не удалось прочитать skills'}`;
    }
    if (skillsAutoError) {
      return `Ошибка авто-синхронизации: ${skillsAutoError}`;
    }
    if (skillsStatusBusy && !currentSkillsStatus) return 'Проверка статуса…';
    if (skillsSyncResult?.success) {
      const copied = `Скопировано: ${skillsSyncResult.copiedCount || 0}`;
      return skillsHasWarning
        ? `${copied}. В Codex есть отдельные skills: ${codexOnlySkills.join(', ')}`
        : copied;
    }
    if (skillsHasWarning) {
      return `Предупреждение: только в Codex: ${codexOnlySkills.join(', ')}. Синхронизация их не удаляет.`;
    }
    if (currentSkillsStatus) {
      const base = `Claude: ${currentSkillsStatus.claudeSkills?.length || 0} · Codex: ${currentSkillsStatus.codexSkills?.length || 0} · ${skillsAutoLabel} · Codex-only нет`;
      return missingInCodexSkills.length
        ? `${base}. Будут добавлены: ${missingInCodexSkills.join(', ')}`
        : base;
    }
    return 'Копирует пользовательские Claude skills в Codex, не трогая ~/.codex/skills/.system.';
  })();

  return (
    <div style={{ padding: '14px', backgroundColor: '#222', border: '1px solid #333', borderRadius: '10px', marginBottom: '12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
        <div style={{ fontSize: '11px', fontWeight: '600', color: '#666', textTransform: 'uppercase' }}>
          Зеркала CLAUDE.md
        </div>
        <div
          onClick={() => onToggle(!enabled)}
          style={{ width: '32px', height: '18px', borderRadius: '9px', backgroundColor: enabled ? '#22c55e' : '#444', position: 'relative', cursor: 'pointer', transition: 'background-color 0.2s', flexShrink: 0 }}
        >
          <div style={{ width: '14px', height: '14px', borderRadius: '50%', backgroundColor: '#fff', position: 'absolute', top: '2px', left: enabled ? '16px' : '2px', transition: 'left 0.2s' }} />
        </div>
      </div>

      {!activeProjectId && (
        <div style={{ fontSize: '11px', color: '#666', lineHeight: 1.5 }}>
          Открой проект, чтобы увидеть статус его файлов.
        </div>
      )}

      {activeProjectId && !status && (
        <div style={{ fontSize: '11px', color: '#666', lineHeight: 1.5 }}>
          Загрузка статуса…
        </div>
      )}

      {activeProjectId && status && (
        <>
          {/* Источник */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 8px', backgroundColor: '#1a1a1a', borderRadius: '6px', marginBottom: '6px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
              <span style={{ fontSize: '11px', color: status.source.exists ? '#22c55e' : '#ef4444', flexShrink: 0 }}>
                {status.source.exists ? '✓' : '✕'}
              </span>
              <span style={{ fontSize: '12px', color: '#eaeaea', fontFamily: 'monospace' }}>./CLAUDE.md</span>
              <span style={{ fontSize: '10px', color: '#777', marginLeft: '4px' }}>источник</span>
            </div>
            <div style={{ fontSize: '10px', color: '#666', fontFamily: 'monospace' }}>
              {status.source.exists ? formatBytes(status.source.sizeBytes) : 'не найден'}
            </div>
          </div>

          {/* Mirror'ы */}
          {status.mirrors.map((m: any) => {
            const lastWrite = formatTime(m.lastWriteAt);
            const mtimeLabel = formatTime(m.mtime);
            return (
              <div key={m.path} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 8px', backgroundColor: '#1a1a1a', borderRadius: '6px', marginBottom: '6px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
                  {m.exists ? (
                    <span style={{ fontSize: '11px', color: m.inSync ? '#22c55e' : '#d97706', flexShrink: 0 }}>
                      {m.inSync ? '✓' : '⚠'}
                    </span>
                  ) : (
                    <span style={{ fontSize: '11px', color: '#666', flexShrink: 0 }}>○</span>
                  )}
                  <span style={{ fontSize: '12px', color: m.exists ? '#eaeaea' : '#666', fontFamily: 'monospace' }}>./{m.name}</span>
                  {m.exists ? (
                    <span style={{ fontSize: '10px', color: m.inSync ? '#22c55e88' : '#d9770688', marginLeft: '4px' }}>
                      {m.inSync ? 'в синхроне' : 'расходится'}
                    </span>
                  ) : (
                    <span style={{ fontSize: '10px', color: '#666', marginLeft: '4px' }}>отсутствует</span>
                  )}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                  {m.exists && (lastWrite || mtimeLabel) && (
                    <span style={{ fontSize: '10px', color: '#666', fontFamily: 'monospace' }}>
                      {lastWrite ? `обновлено ${lastWrite}` : `mtime ${mtimeLabel}`}
                    </span>
                  )}
                  {enabled && status.source.exists && (!m.exists || !m.inSync) && (
                    <button
                      onClick={requestCreateNow}
                      style={{ background: '#2a2a2a', border: '1px solid #393939', borderRadius: '4px', color: '#aaa', fontSize: '10px', cursor: 'pointer', padding: '2px 7px' }}
                    >
                      {m.exists ? 'Перезаписать' : 'Создать сейчас'}
                    </button>
                  )}
                </div>
              </div>
            );
          })}

          <div style={{ fontSize: '11px', color: '#666', marginTop: '8px', lineHeight: 1.5 }}>
            {enabled
              ? 'CLAUDE.md — единственный редактируемый файл. Правка зеркал перезатирается копией источника.'
              : 'Тогл выключен. Файлы независимы и ничего не переписывается.'}
          </div>
        </>
      )}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 8px', backgroundColor: '#1a1a1a', borderRadius: '6px', marginTop: activeProjectId && status ? '10px' : '0' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
            <span style={{ fontSize: '11px', color: skillsIconColor, flexShrink: 0 }}>
              {skillsIcon}
            </span>
            <span style={{ fontSize: '12px', color: '#eaeaea', fontFamily: 'monospace' }}>~/.claude/skills → ~/.codex/skills</span>
            {skillsHasWarning && (
              <span style={{ fontSize: '10px', color: '#d97706', marginLeft: '4px' }}>Codex-only</span>
            )}
          </div>
          <div style={{ fontSize: '10px', color: skillsSyncResult?.success === false || currentSkillsStatus?.success === false ? '#ef4444aa' : skillsHasWarning ? '#d97706aa' : '#666', marginTop: '3px', lineHeight: 1.35, wordBreak: 'break-word' }}>
            {skillsStatusText}
          </div>
        </div>
        <button
          type="button"
          disabled={skillsSyncBusy || skillsButtonSynced}
          onClick={syncSkillsNow}
          style={{
            background: skillsSyncBusy || skillsButtonSynced ? 'rgba(218,119,86,0.12)' : '#2a2a2a',
            border: `1px solid ${skillsSyncBusy || skillsButtonSynced ? 'rgba(218,119,86,0.45)' : '#393939'}`,
            borderRadius: '4px',
            color: skillsSyncBusy || skillsButtonSynced ? '#FF9466' : '#aaa',
            fontSize: '10px',
            cursor: skillsSyncBusy || skillsButtonSynced ? 'default' : 'pointer',
            padding: '2px 7px',
            flexShrink: 0,
          }}
        >
          {skillsSyncBusy ? 'Синхронизация…' : skillsButtonSynced ? '✓ синхронизирована' : 'Синхронизировать'}
        </button>
      </div>
    </div>
  );
}

type StatusColumnProps = {
  title: string;
  markerLabel: string;
  statuses: Array<{ id: string; label: string; color: string; description?: string }>;
  marker: { shape: 'dot' | 'square'; sizePx: number };
  addStatus: () => string;
  updateStatus: (id: string, patch: { label?: string; color?: string; description?: string }) => void;
  removeStatus: (id: string) => void;
  setMarker: (patch: { shape?: 'dot' | 'square'; sizePx?: number }) => void;
};

function StatusColumnEditor({ title, markerLabel, statuses, marker, addStatus, updateStatus, removeStatus, setMarker }: StatusColumnProps) {
  const [pickerOpenId, setPickerOpenId] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});
  const [hexDrafts, setHexDrafts] = useState<Record<string, string>>({});
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pickerOpenId) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (containerRef.current && target && !containerRef.current.contains(target)) setPickerOpenId(null);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [pickerOpenId]);

  return (
    <div ref={containerRef} style={{ minWidth: 0 }}>
      <div style={{ marginBottom: 7, color: '#8a8a8a', fontSize: 11, fontWeight: 650, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        {title}
      </div>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', marginBottom: 8,
        backgroundColor: '#1e1e1e', border: '1px solid #333', borderRadius: 8,
      }}>
        <button
          onClick={addStatus}
          title="Добавить статус"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 8px', fontSize: 11, color: '#ccc', backgroundColor: '#2a2a2a', border: '1px solid #444', borderRadius: 6, cursor: 'pointer', flexShrink: 0 }}
        >
          <Plus size={11} /> новый
        </button>
        <span style={{ fontSize: 11, color: '#777' }}>{markerLabel}</span>
        <div style={{ display: 'inline-flex', backgroundColor: '#1a1a1a', borderRadius: 6, border: '1px solid #333' }}>
          {(['dot', 'square'] as const).map((shape) => (
            <button
              key={shape}
              onClick={() => setMarker({ shape })}
              title={shape === 'dot' ? 'Круглый' : 'Квадратный'}
              style={{ padding: '4px 8px', color: marker.shape === shape ? '#fff' : '#777', background: marker.shape === shape ? '#333' : 'transparent', border: 0, cursor: 'pointer', borderRadius: 5 }}
            >
              <span style={{ display: 'block', width: 8, height: 8, backgroundColor: '#ccc', borderRadius: shape === 'dot' ? '50%' : 2 }} />
            </button>
          ))}
        </div>
        <input
          type="number"
          min={4}
          max={16}
          value={marker.sizePx}
          onChange={(event) => setMarker({ sizePx: Number(event.target.value) })}
          title="Размер маркера"
          style={{ width: 44, marginLeft: 'auto', padding: '4px 5px', backgroundColor: '#1a1a1a', border: '1px solid #333', borderRadius: 6, color: '#ccc', fontSize: 11, fontFamily: 'monospace', outline: 'none' }}
        />
      </div>

      {statuses.length === 0 && (
        <div style={{ fontSize: 12, color: '#666', fontStyle: 'italic', padding: '8px 2px' }}>Пусто. Добавьте первый статус.</div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {statuses.map((status) => {
          const pickerOpen = pickerOpenId === status.id;
          const expanded = !!expandedIds[status.id];
          const hexDraft = hexDrafts[status.id] ?? status.color;
          return (
            <div key={status.id} style={{ position: 'relative', padding: '6px 8px', backgroundColor: '#1e1e1e', border: '1px solid #333', borderRadius: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <button
                  onClick={() => setPickerOpenId(pickerOpen ? null : status.id)}
                  title="Открыть палитру"
                  style={{ width: 20, height: 20, borderRadius: marker.shape === 'square' ? 4 : '50%', backgroundColor: status.color, border: '2px solid rgba(255,255,255,0.15)', cursor: 'pointer', flexShrink: 0, padding: 0 }}
                />
                <input
                  value={status.label}
                  onChange={(event) => updateStatus(status.id, { label: event.target.value })}
                  placeholder="Название"
                  style={{ flex: 1, minWidth: 0, padding: '4px 6px', backgroundColor: '#1a1a1a', border: '1px solid #333', borderRadius: 6, color: '#ccc', fontSize: 12, outline: 'none' }}
                />
                <input
                  value={hexDraft.replace(/^#/, '')}
                  onChange={(event) => {
                    const next = `#${event.target.value}`;
                    setHexDrafts((current) => ({ ...current, [status.id]: next }));
                    const normalized = normalizeHexValue(next);
                    if (normalized) updateStatus(status.id, { color: normalized });
                  }}
                  onBlur={() => setHexDrafts((current) => { const next = { ...current }; delete next[status.id]; return next; })}
                  maxLength={7}
                  style={{ width: 62, padding: '4px 6px', backgroundColor: '#1a1a1a', border: '1px solid #333', borderRadius: 6, color: '#ccc', fontSize: 11, fontFamily: 'monospace', outline: 'none', textTransform: 'uppercase' }}
                />
                <button
                  onClick={() => setExpandedIds((current) => ({ ...current, [status.id]: !expanded }))}
                  title={expanded ? 'Скрыть описание' : 'Показать описание'}
                  style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, borderRadius: 6, background: expanded ? 'rgba(255,255,255,0.07)' : 'transparent', border: 0, color: '#777', cursor: 'pointer' }}
                >
                  {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                </button>
                <button
                  onClick={() => removeStatus(status.id)}
                  title="Удалить статус"
                  style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, borderRadius: 6, background: 'transparent', border: 0, color: '#666', cursor: 'pointer' }}
                  onMouseEnter={(event) => { event.currentTarget.style.color = '#f87171'; event.currentTarget.style.backgroundColor = 'rgba(248,113,113,0.1)'; }}
                  onMouseLeave={(event) => { event.currentTarget.style.color = '#666'; event.currentTarget.style.backgroundColor = 'transparent'; }}
                >
                  <Trash2 size={12} />
                </button>
              </div>

              {expanded && (
                <textarea
                  value={status.description || ''}
                  onChange={(event) => updateStatus(status.id, { description: event.target.value })}
                  placeholder="Когда использовать этот статус и что он означает"
                  rows={3}
                  style={{ width: '100%', marginTop: 7, padding: '7px 8px', resize: 'vertical', backgroundColor: '#171717', border: '1px solid #333', borderRadius: 6, color: '#bbb', fontSize: 11, lineHeight: 1.45, outline: 'none' }}
                />
              )}

              {pickerOpen && (
                <div
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={(event) => event.stopPropagation()}
                  style={{ position: 'absolute', top: '100%', left: 0, marginTop: 6, zIndex: 50, padding: 12, backgroundColor: '#1a1a1a', border: '1px solid #444', borderRadius: 10, boxShadow: '0 10px 30px rgba(0,0,0,0.5)' }}
                >
                  <HexColorPicker color={status.color} onChange={(color) => updateStatus(status.id, { color: color.toUpperCase() })} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SessionStatusesEditor() {
  const sessionStatuses = useUIStore((state) => state.sessionStatuses);
  const taskStatuses = useUIStore((state) => state.taskStatuses);
  const statusMarker = useUIStore((state) => state.statusMarker);
  const taskStatusMarker = useUIStore((state) => state.taskStatusMarker);
  const updateSessionStatus = useUIStore((state) => state.updateSessionStatus);
  const updateTaskStatus = useUIStore((state) => state.updateTaskStatus);
  const addSessionStatus = useUIStore((state) => state.addSessionStatus);
  const addTaskStatus = useUIStore((state) => state.addTaskStatus);
  const removeSessionStatus = useUIStore((state) => state.removeSessionStatus);
  const removeTaskStatus = useUIStore((state) => state.removeTaskStatus);
  const setStatusMarker = useUIStore((state) => state.setStatusMarker);
  const setTaskStatusMarker = useUIStore((state) => state.setTaskStatusMarker);

  return (
    <div style={{ paddingLeft: 12, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 12, alignItems: 'start' }}>
      <StatusColumnEditor title="Вкладки" markerLabel="Маркер вкладки" statuses={sessionStatuses} marker={statusMarker} addStatus={addSessionStatus} updateStatus={updateSessionStatus} removeStatus={removeSessionStatus} setMarker={setStatusMarker} />
      <StatusColumnEditor title="Задачи" markerLabel="Маркер задачи" statuses={taskStatuses} marker={taskStatusMarker} addStatus={addTaskStatus} updateStatus={updateTaskStatus} removeStatus={removeTaskStatus} setMarker={setTaskStatusMarker} />
    </div>
  );
}

// ProcessBarEditor — настройка полоски процесса (3px слева/справа в табе).
// Базовая полоса всегда статична; AI-busy поверх неё рисует бегущий shimmer.
// Юзер контролирует базовый цвет, цвет/плотность блика, расстояние между бликами и сторону.
function ProcessBarEditor() {
  const processBar = useUIStore((s) => s.processBar);
  const setProcessBar = useUIStore((s) => s.setProcessBar);

  const [pickerOpen, setPickerOpen] = useState<'a' | 'b' | 'c' | null>(null);
  const [hexDraftA, setHexDraftA] = useState<string | null>(null);
  const [hexDraftB, setHexDraftB] = useState<string | null>(null);
  const [hexDraftC, setHexDraftC] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!pickerOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (containerRef.current && t && !containerRef.current.contains(t)) setPickerOpen(null);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [pickerOpen]);

  // Preview имитирует одну реальную строку TabSidebar, а не всю ширину Settings.
  // Default TabSidebar width = 200px; полноширинный макет ложно выглядел как
  // глобальный progress bar приложения.
  const previewPeakAlpha = opacityPctToAlpha(processBar.shimmerOpacityPct);
  const previewBar = (
    <div style={{
      position: 'relative', width: '200px', maxWidth: '100%', height: '32px',
      backgroundColor: '#252526', border: '1px solid #333',
      borderRadius: '6px', overflow: 'hidden',
    }}>
      {/* Тот же компонент полоски, что и на всех поверхностях вкладки
          (TabSignals) — иначе превью показывало бы не то, что получит юзер.
          Единственное отличие: цвета и грань берутся из ЕЩЁ НЕ сохранённых
          значений, которые юзер прямо сейчас крутит, поэтому здесь (и только
          здесь) они передаются напрямую. Блик крутится постоянно; в рантайме
          он появляется только когда AI стримит/думает. */}
      <TabProcessBar
        hasProcess
        busy
        positionOverride={processBar.position === 'right' ? 'right' : 'left'}
        cssVars={{
          ['--process-bar-color-a' as any]: processBar.colorA,
          ['--process-bar-shimmer-rgb' as any]: hexToRgbTriplet(processBar.shimmerColor),
          ['--process-bar-shimmer-spacing' as any]: `${processBar.shimmerSpacingPct}%`,
          ['--process-bar-shimmer-alpha' as any]: previewPeakAlpha,
          ['--process-bar-shimmer-edge-alpha' as any]: Math.max(0.01, previewPeakAlpha * 0.22),
        }}
      />
      <div style={{
        position: 'absolute', left: 12, right: 12, top: '50%', transform: 'translateY(-50%)',
        fontSize: '11px', color: '#888', textAlign: 'center',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>
        Пример вкладки
      </div>
    </div>
  );

  const colorChip = (which: 'a' | 'b' | 'c') => {
    const current = which === 'a'
      ? processBar.colorA
      : which === 'b'
        ? processBar.shimmerColor
        : processBar.inheritedColor;
    const draft = which === 'a' ? hexDraftA : which === 'b' ? hexDraftB : hexDraftC;
    const setDraft = which === 'a' ? setHexDraftA : which === 'b' ? setHexDraftB : setHexDraftC;
    const label = which === 'a' ? 'Полоса' : which === 'b' ? 'Блик' : 'Дочерний';
    const updateColor = (color: string) => setProcessBar(
      which === 'a' ? { colorA: color } : which === 'b' ? { shimmerColor: color } : { inheritedColor: color },
    );

    return (
      <div style={{
        position: 'relative',
        display: 'inline-flex', alignItems: 'center', gap: '6px',
        padding: '4px 8px',
        backgroundColor: '#1e1e1e', border: '1px solid #333', borderRadius: '8px',
        flexShrink: 0,
      }}>
        <button
          onClick={() => { setPickerOpen(pickerOpen === which ? null : which); }}
          style={{
            width: 16, height: 16, borderRadius: '50%',
            backgroundColor: current,
            border: '2px solid rgba(255,255,255,0.15)',
            cursor: 'pointer',
            flexShrink: 0, padding: 0,
          }}
          title="Палитра"
        />
        <span style={{ fontSize: '11px', color: '#888' }}>
          {label}
        </span>
        <input
          type="text"
          value={(draft ?? current).replace(/^#/, '')}
          onChange={(e) => {
            const next = `#${e.target.value}`;
            setDraft(next);
            const norm = normalizeHexValue(next);
            if (norm) updateColor(norm);
          }}
          onBlur={() => setDraft(null)}
          maxLength={7}
          style={{
            width: '60px', padding: '3px 6px',
            backgroundColor: '#1a1a1a', border: '1px solid #333', borderRadius: '6px',
            color: '#ccc', fontSize: '11px', fontFamily: 'monospace',
            outline: 'none', textTransform: 'uppercase',
          }}
        />
        {pickerOpen === which && (
          <div
            style={{
              position: 'absolute', top: '100%', left: 0,
              marginTop: '6px', zIndex: 50,
              padding: '12px',
              backgroundColor: '#1a1a1a', border: '1px solid #444', borderRadius: '10px',
              boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
            }}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <HexColorPicker
              color={current}
              onChange={(c) => updateColor(c.toUpperCase())}
            />
          </div>
        )}
      </div>
    );
  };

  return (
    <div ref={containerRef} style={{ paddingLeft: '12px' }}>
      {/* Uppercase-заголовок задаётся снаружи (SettingsSubSectionHeader), здесь только контент. */}
      {previewBar}

      {/* Все controls в одну flex-wrap строку — компактные inline-chip'ы как кнопки во вкладках.
          Запрещено растягивать на 100% ширины: каждый элемент по своему контенту. */}
      <div style={{
        display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px',
        marginTop: '10px',
      }}>
        {/* Position toggle */}
        <div style={{ display: 'inline-flex', backgroundColor: '#1a1a1a', borderRadius: '6px', border: '1px solid #333', flexShrink: 0 }}>
          {(['left', 'right'] as const).map((p) => (
            <button
              key={p}
              onClick={() => setProcessBar({ position: p })}
              style={{
                padding: '4px 10px', fontSize: '11px',
                color: processBar.position === p ? '#fff' : '#888',
                background: processBar.position === p ? '#333' : 'transparent',
                border: 'none', cursor: 'pointer',
                borderTopLeftRadius: p === 'left' ? 6 : 0,
                borderBottomLeftRadius: p === 'left' ? 6 : 0,
                borderTopRightRadius: p === 'right' ? 6 : 0,
                borderBottomRightRadius: p === 'right' ? 6 : 0,
              }}
              title={p === 'left' ? 'Слева' : 'Справа'}
            >
              {p === 'left' ? '⊏' : '⊐'}
            </button>
          ))}
        </div>

        {colorChip('a')}
        {colorChip('b')}
        {colorChip('c')}

        {/* Shimmer spacing — компактный inline-chip */}
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: '6px',
          padding: '4px 8px',
          backgroundColor: '#1e1e1e', border: '1px solid #333', borderRadius: '8px',
          flexShrink: 0,
        }}>
          <span style={{ fontSize: '11px', color: '#888' }}>Расстояние</span>
          <input
            type="number"
            min={20}
            max={200}
            step={5}
            value={processBar.shimmerSpacingPct}
            onChange={(e) => setProcessBar({ shimmerSpacingPct: Number(e.target.value) })}
            style={{
              width: '48px', padding: '3px 6px',
              backgroundColor: '#1a1a1a', border: '1px solid #333', borderRadius: '6px',
              color: '#ccc', fontSize: '11px', fontFamily: 'monospace', outline: 'none',
              textAlign: 'right',
            }}
          />
          <span style={{ fontSize: '10px', color: '#555' }}>%</span>
        </div>

        {/* Shimmer opacity — peak alpha, edges are derived softer in CSS vars */}
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: '6px',
          padding: '4px 8px',
          backgroundColor: '#1e1e1e', border: '1px solid #333', borderRadius: '8px',
          flexShrink: 0,
        }}>
          <span style={{ fontSize: '11px', color: '#888' }}>Плотность</span>
          <input
            type="number"
            min={5}
            max={100}
            step={5}
            value={processBar.shimmerOpacityPct}
            onChange={(e) => setProcessBar({ shimmerOpacityPct: Number(e.target.value) })}
            style={{
              width: '44px', padding: '3px 6px',
              backgroundColor: '#1a1a1a', border: '1px solid #333', borderRadius: '6px',
              color: '#ccc', fontSize: '11px', fontFamily: 'monospace', outline: 'none',
              textAlign: 'right',
            }}
          />
          <span style={{ fontSize: '10px', color: '#555' }}>%</span>
        </div>
      </div>
    </div>
  );
}

// AIPulseEditor (whole-tab AI-busy background pulse) was removed — the loader is
// the process-bar shimmer strip. See fact-process-bar.md::AIPulse removed.

export default function SettingsModal({ isOpen, onClose, initialTab }: SettingsModalProps) {
  // Use last active tab if opened before, otherwise default to shortcuts
  const [activeTab, setActiveTab] = useState<SettingsTab>(() => {
    return hasOpenedBefore ? lastActiveTab : 'ai';
  });
  const [aiSubTab, setAiSubTab] = useState<AISubTab>('text');
  const [modelSettingsExpanded, setModelSettingsExpanded] = useState(
    () => modelSettingsExpandedForSession,
  );
  const contentScrollRef = useRef<HTMLDivElement>(null);

  // The top content node is reused while its tab changes, so the browser would
  // otherwise carry one tab's offset into another. Restore each tab's own
  // position before paint; reopening the modal follows the same path.
  useLayoutEffect(() => {
    if (!isOpen) return;
    restoreSettingsScrollPosition(`tab:${activeTab}`, contentScrollRef.current);
  }, [activeTab, isOpen]);

  // Programmatic open with requested tab (e.g. ПКМ на SemanticIndexButton).
  // Срабатывает на переходе isOpen=false→true когда initialTab задан.
  // Не блокирует ручное переключение табов после открытия — пользователь
  // нажал ПКМ → попал на «Системные», дальше может кликать другие табы.
  const prevIsOpenRef = useRef(isOpen);
  useLayoutEffect(() => {
    if (isOpen && !prevIsOpenRef.current && initialTab) {
      const valid: SettingsTab[] = ['shortcuts', 'fonts', 'colors', 'ai', 'projects'];
      if (valid.includes(initialTab as SettingsTab)) {
        setActiveTab(initialTab as SettingsTab);
      }
    }
    prevIsOpenRef.current = isOpen;
  }, [isOpen, initialTab]);

  const terminalFontSize = useUIStore((s) => s.terminalFontSize);
  const tabsFontSize = useUIStore((s) => s.tabsFontSize);
  const projectTabsFontSize = useUIStore((s) => s.projectTabsFontSize);
  const sidebarFontSize = useUIStore((s) => s.sidebarFontSize);
  const filePreviewFontSize = useUIStore((s) => s.filePreviewFontSize);
  const promptPickerFontSize = useUIStore((s) => s.promptPickerFontSize);
  const setPromptPickerFontSize = useUIStore((s) => s.setPromptPickerFontSize);
  const promptPickerBottomOffsetPx = useUIStore((s) => s.promptPickerBottomOffsetPx);
  const setPromptPickerBottomOffsetPx = useUIStore((s) => s.setPromptPickerBottomOffsetPx);
  const promptPickerLeftOffsetPx = useUIStore((s) => s.promptPickerLeftOffsetPx);
  const setPromptPickerLeftOffsetPx = useUIStore((s) => s.setPromptPickerLeftOffsetPx);
  const promptPickerRightOffsetPx = useUIStore((s) => s.promptPickerRightOffsetPx);
  const setPromptPickerRightOffsetPx = useUIStore((s) => s.setPromptPickerRightOffsetPx);
  const timelineFontSize = useUIStore((s) => s.timelineFontSize);
  const timelineSummaryFontSize = useUIStore((s) => s.timelineSummaryFontSize);
  const timelineLineClamp = useUIStore((s) => s.timelineLineClamp);
  const setTimelineLineClamp = useUIStore((s) => s.setTimelineLineClamp);
  const historyFontSize = useUIStore((s) => s.historyFontSize);
  const setHistoryFontSize = useUIStore((s) => s.setHistoryFontSize);
  const historyComposerFontSize = useUIStore((s) => s.historyComposerFontSize);
  const setHistoryComposerFontSize = useUIStore((s) => s.setHistoryComposerFontSize);
  const aiSecondaryFontSize = useUIStore((s) => s.aiSecondaryFontSize);
  const setAiSecondaryFontSize = useUIStore((s) => s.setAiSecondaryFontSize);
  const historyMarkdownCodeMaxLines = useUIStore((s) => s.historyMarkdownCodeMaxLines);
  const setHistoryMarkdownCodeMaxLines = useUIStore((s) => s.setHistoryMarkdownCodeMaxLines);
  const historyComposerMinRows = useUIStore((s) => s.historyComposerMinRows);
  const setHistoryComposerMinRows = useUIStore((s) => s.setHistoryComposerMinRows);
  const historyComposerMaxRows = useUIStore((s) => s.historyComposerMaxRows);
  const stackedComposerMaxRows = useUIStore((s) => s.stackedComposerMaxRows);
  const setStackedComposerMaxRows = useUIStore((s) => s.setStackedComposerMaxRows);
  const setHistoryComposerMaxRows = useUIStore((s) => s.setHistoryComposerMaxRows);
  const aiComposerChipThreshold = useUIStore((s) => s.aiComposerChipThreshold);
  const setAiComposerChipThreshold = useUIStore((s) => s.setAiComposerChipThreshold);
  const promptQueueChipFontSize = useUIStore((s) => s.promptQueueChipFontSize);
  const setPromptQueueChipFontSize = useUIStore((s) => s.setPromptQueueChipFontSize);
  const promptQueueEditorFontSize = useUIStore((s) => s.promptQueueEditorFontSize);
  const setPromptQueueEditorFontSize = useUIStore((s) => s.setPromptQueueEditorFontSize);
  const promptQueueChipLineClamp = useUIStore((s) => s.promptQueueChipLineClamp);
  const setPromptQueueChipLineClamp = useUIStore((s) => s.setPromptQueueChipLineClamp);
  const setTerminalFontSize = useUIStore((s) => s.setTerminalFontSize);
  const setTabsFontSize = useUIStore((s) => s.setTabsFontSize);
  const setProjectTabsFontSize = useUIStore((s) => s.setProjectTabsFontSize);
  const setSidebarFontSize = useUIStore((s) => s.setSidebarFontSize);
  const setFilePreviewFontSize = useUIStore((s) => s.setFilePreviewFontSize);
  const setTimelineFontSize = useUIStore((s) => s.setTimelineFontSize);
  const setTimelineSummaryFontSize = useUIStore((s) => s.setTimelineSummaryFontSize);
  const semanticIndexParallelism = useUIStore((s) => s.semanticIndexParallelism);
  const semanticAutoIndexTitles = useUIStore((s) => s.semanticAutoIndexTitles);
  const setSemanticAutoIndexTitles = useUIStore((s) => s.setSemanticAutoIndexTitles);
  const semanticAutoIndexIterations = useUIStore((s) => s.semanticAutoIndexIterations);
  const setSemanticAutoIndexIterations = useUIStore((s) => s.setSemanticAutoIndexIterations);
  const newTabPrimarySurface = useUIStore((s) => s.newTabPrimarySurface);
  const setNewTabPrimarySurface = useUIStore((s) => s.setNewTabPrimarySurface);
  const claudeCodeSettings = useUIStore((s) => s.claudeCodeSettings);
  const setClaudeCodeSettings = useUIStore((s) => s.setClaudeCodeSettings);
  const defaultClaudeEffort = useUIStore((s) => s.defaultClaudeEffort);
  const setDefaultClaudeEffort = useUIStore((s) => s.setDefaultClaudeEffort);
  const codexSettings = useUIStore((s) => s.codexSettings);
  const setCodexSettings = useUIStore((s) => s.setCodexSettings);
  const defaultCodexModel = useUIStore((s) => s.defaultCodexModel);
  const setDefaultCodexModel = useUIStore((s) => s.setDefaultCodexModel);
  const defaultCodexEffort = useUIStore((s) => s.defaultCodexEffort);
  const setDefaultCodexEffort = useUIStore((s) => s.setDefaultCodexEffort);
  const codexResumePausedGoal = useUIStore((s) => s.codexResumePausedGoal);
  const setCodexResumePausedGoal = useUIStore((s) => s.setCodexResumePausedGoal);
  const [liveCodexModels, setLiveCodexModels] = useState<CodexModelOption[]>([]);
  const codexModelsForSettings = useMemo(
    () => mergeCodexModelOptions(liveCodexModels, codexSettings.models, codexSettings.removedModelIds),
    [liveCodexModels, codexSettings.models, codexSettings.removedModelIds],
  );
  const claudeEffortOptions = useMemo<ClaudeEffortOption[]>(
    () => claudeCodeSettings.effortOptions?.length
      ? claudeCodeSettings.effortOptions
      : DEFAULT_CLAUDE_EFFORT_OPTIONS,
    [claudeCodeSettings.effortOptions],
  );
  const codexEffortOptions = useMemo<CodexEffortOption[]>(
    () => codexSettings.effortOptions?.length
      ? codexSettings.effortOptions
      : DEFAULT_CODEX_EFFORT_OPTIONS,
    [codexSettings.effortOptions],
  );
  const knownCodexModelIds = useMemo(
    () => new Set([
      ...DEFAULT_CODEX_MODEL_OPTIONS.map((model) => model.id),
      ...liveCodexModels.map((model) => model.id),
    ]),
    [liveCodexModels],
  );
  const claudeEffortOptionsForModel = (model: ClaudeCodeModelOption) => {
    const supported = new Set(claudeSupportedEffortsForModel(model));
    return claudeEffortOptions.filter((option) => (
      supported.has(option.id)
      || !CLAUDE_EFFORT_LEVELS.some((level) => level === option.id)
    ));
  };
  const codexEffortOptionsForModel = (model: CodexModelOption) => {
    const supported = new Set(codexSupportedEffortsForModel(model));
    return codexEffortOptions.filter((option) => (
      !knownCodexModelIds.has(model.id) || supported.has(option.id)
    ));
  };
  const codexEffortCommandIsLiveBound = (option: CodexEffortOption) => (
    codexModelsForSettings.some((model) => (
      knownCodexModelIds.has(model.id)
      && codexSupportedEffortsForModel(model).includes(option.id)
    ))
  );
  const effortLabel = (options: readonly { id: string; label: string }[], effort: string) => (
    options.find((option) => option.id === effort)?.label || effort
  );
  const quickClaudeModel = claudeCodeSettings.models.find((model) => model.id === claudeCodeSettings.quickModel);
  const quickClaudeEfforts = quickClaudeModel ? claudeEffortsForModel(quickClaudeModel) : [];
  const quickCodexModel = codexModelsForSettings.find((model) => model.id === codexSettings.quickModel);
  const quickCodexEfforts = (quickCodexModel?.efforts || []).filter((effort) => effort !== 'ultra');
  const selectedDefaultCodexModel = codexModelsForSettings.find((model) => model.id === defaultCodexModel);
  const defaultCodexEfforts = (selectedDefaultCodexModel?.efforts || []).filter((effort) => effort !== 'ultra');
  const claudeMdMirrorEnabled = useUIStore((s) => s.claudeMdMirrorEnabled);
  const setClaudeMdMirrorEnabled = useUIStore((s) => s.setClaudeMdMirrorEnabled);
  const tabCompletionNotificationSound = useUIStore((s) => s.tabCompletionNotificationSound);
  const setTabCompletionNotificationSound = useUIStore((s) => s.setTabCompletionNotificationSound);
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);
  const mirrorStatus = useMirrorStatusStore((s) => (activeProjectId ? s.byProject[activeProjectId] : undefined));
  const setSemanticIndexParallelism = useUIStore((s) => s.setSemanticIndexParallelism);
  // Геометрия вкладок — Settings → Размеры → Вкладки → Рабочие вкладки/Проекты.
  const tabGeometry = useUIStore((s) => s.tabGeometry);
  const setTabGeometry = useUIStore((s) => s.setTabGeometry);
  const projectTabGeometry = useUIStore((s) => s.projectTabGeometry);
  const setProjectTabGeometry = useUIStore((s) => s.setProjectTabGeometry);
  const { showToast, claudeDefaultPromptEnabled, setClaudeDefaultPromptEnabled } = useUIStore();
  const { prompts: aiPrompts, loadPrompts: loadAIPrompts, savePrompt: saveAIPrompt, deletePrompt: deleteAIPrompt, rewindPromptId, setRewindPromptId } = usePromptsStore();

  // Claude Default Prompt
  const [claudeDefaultPrompt, setClaudeDefaultPrompt] = useState('');
  // Main-process memory budget for parsed session histories. Local state +
  // immediate persist; main reads it once at startup (hence the restart hint
  // next to the control).
  const [historyProjectorBudgetMbState, setHistoryProjectorBudgetMbState] = useState(400);
  const historyProjectorBudgetMb = historyProjectorBudgetMbState;
  const setHistoryProjectorBudgetMb = useCallback((value: number) => {
    const clamped = Math.max(64, Math.min(2048, Math.round(value)));
    setHistoryProjectorBudgetMbState(clamped);
    ipcRenderer.invoke('app:setState', { key: 'historyProjectorBudgetMb', value: String(clamped) });
  }, []);
  const [interruptedAutoRestoreParallelismState, setInterruptedAutoRestoreParallelismState] = useState(2);
  const interruptedAutoRestoreParallelism = interruptedAutoRestoreParallelismState;
  const setInterruptedAutoRestoreParallelism = useCallback((value: number) => {
    const clamped = Math.max(1, Math.min(3, Math.round(value)));
    setInterruptedAutoRestoreParallelismState(clamped);
    ipcRenderer.invoke('app:setState', {
      key: 'interruptedAutoRestoreParallelism',
      value: String(clamped),
    });
  }, []);

  const toggleModelSettings = useCallback(() => {
    setModelSettingsExpanded((current) => {
      const next = !current;
      modelSettingsExpandedForSession = next;
      return next;
    });
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    ipcRenderer.invoke('codex:list-models').then((result: any) => {
      if (!cancelled && Array.isArray(result?.models)) setLiveCodexModels(result.models);
    }).catch(() => {
      if (!cancelled) setLiveCodexModels([]);
    });
    return () => { cancelled = true; };
  }, [isOpen]);

  // User prompts (text insertion snippets, not AI prompts)
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [promptGroups, setPromptGroups] = useState<PromptGroup[]>([]);
  const [promptTreeRename, setPromptTreeRename] = useState<PromptTreeRename | null>(null);
  const [promptTreeRenameDraft, setPromptTreeRenameDraft] = useState('');
  const [promptTreeContextMenu, setPromptTreeContextMenu] = useState<PromptTreeContextMenu | null>(null);
  const promptTreeRenameInput = useInlineRenameInputRef(promptTreeRename !== null);
  const textListRef = useRef<HTMLDivElement>(null);

  // Editing states
  const [editingClaude, setEditingClaude] = useState(false);
  const [editingPromptId, setEditingPromptId] = useState<string | null>(null); // AI prompt being edited
  const [editingInsertionPromptId, setEditingInsertionPromptId] = useState<string | null>(null);
  const [localInsertionTitle, setLocalInsertionTitle] = useState('');
  const [localInsertionContent, setLocalInsertionContent] = useState('');
  const [localInsertionFilePaths, setLocalInsertionFilePaths] = useState<string[]>([]);
  const [insertionFileInputs, setInsertionFileInputs] = useState<{ value: string; valid: boolean | null }[]>([]);
  const [savedInsertionFlash, setSavedInsertionFlash] = useState<'content' | null>(null);
  const savedInsertionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [textInsertCopied, setTextInsertCopied] = useState(false);
  const [textInsertCopying, setTextInsertCopying] = useState(false);
  const textInsertCopiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Escape/backdrop-close does not always move focus through a button first.
  // Commit the currently edited model/effort field before its row unmounts.
  const closeSettings = useCallback(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
    onClose();
  }, [onClose]);

  // Local copies of AI prompt fields for editing
  const [localPromptContent, setLocalPromptContent] = useState('');
  const [localPromptName, setLocalPromptName] = useState('');
  const [localPromptColor, setLocalPromptColor] = useState('');
  const [localPromptShowInMenu, setLocalPromptShowInMenu] = useState(true);
  const [localPromptModel, setLocalPromptModel] = useState<AIModel>('gemini-3-flash-preview');
  const [localPromptThinkingLevel, setLocalPromptThinkingLevel] = useState<ThinkingLevel>('HIGH');
  const [localPromptFilePaths, setLocalPromptFilePaths] = useState<string[]>([]);
  const [filePathInputs, setFilePathInputs] = useState<{ value: string; valid: boolean | null }[]>([]);
  const [savedFlashField, setSavedFlashField] = useState<'name' | 'content' | null>(null);
  const savedFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [aiUsageRange, setAIUsageRange] = useState<AIUsageRange>('week');
  const [aiUsageStats, setAIUsageStats] = useState<any | null>(null);
  const [aiUsageLoading, setAIUsageLoading] = useState(false);
  const [expandedAIUsageLogIds, setExpandedAIUsageLogIds] = useState<Set<number>>(new Set());
  const promptSummaryPreviousUserCount = useTimelineSummaryStore((s) => s.previousUserContextCount);
  const setPromptSummaryPreviousUserCount = useTimelineSummaryStore((s) => s.setPreviousUserContextCount);

  // Refs for editing containers (to check if blur target is inside)
  const claudeEditRef = useRef<HTMLDivElement>(null);


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

      // History projector memory budget (main process reads this at startup).
      ipcRenderer.invoke('app:getState', 'historyProjectorBudgetMb').then((value: any) => {
        const parsed = Math.floor(Number(value));
        // Load must NOT write back — setHistoryProjectorBudgetMb persists, and
        // persisting on every modal open would rewrite the row for nothing.
        if (Number.isFinite(parsed) && parsed > 0) {
          setHistoryProjectorBudgetMbState(Math.max(64, Math.min(2048, parsed)));
        }
      });

      ipcRenderer.invoke('app:getState', 'interruptedAutoRestoreParallelism').then((value: any) => {
        setInterruptedAutoRestoreParallelismState(normalizeInterruptedRestoreParallelism(value));
      });

      // Load AI prompts from DB
      loadAIPrompts();

      // Load user prompts (text insertion snippets) and groups
      ipcRenderer.invoke('prompts:get').then((result: { success: boolean; data?: Prompt[] }) => {
        if (result.success && result.data) {
          setPrompts(result.data.map((prompt, index) => ({ ...prompt, id: prompt.id || `legacy-prompt-${index}` })));
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
      // Reset editing states when modal closes
      setEditingClaude(false);
      setEditingPromptId(null);
      setEditingInsertionPromptId(null);
      setPromptTreeRename(null);
      setPromptTreeContextMenu(null);
    }
  }, [isOpen]);

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
          thinkingLevel: localPromptThinkingLevel,
          filePaths: localPromptFilePaths
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

  const loadAIUsageStats = useCallback(async () => {
    setAIUsageLoading(true);
    try {
      const result = await ipcRenderer.invoke('ai-prompts:usage-stats', aiUsageRange);
      if (result?.success) setAIUsageStats(result.data);
    } catch (err) {
      console.warn('[Settings] Failed to load AI usage stats:', err);
    } finally {
      setAIUsageLoading(false);
    }
  }, [aiUsageRange]);

  useEffect(() => {
    if (isOpen && activeTab === 'ai' && aiSubTab === 'usage') {
      void loadAIUsageStats();
    }
  }, [isOpen, activeTab, aiSubTab, loadAIUsageStats]);

  useEffect(() => {
    if (!isOpen) return;
    return subscribeSavedPromptUpdates(ipcRenderer, (updatedPrompt: Prompt) => {
      setPrompts((current) => {
        const index = current.findIndex((prompt) => prompt.id === updatedPrompt.id);
        if (index < 0) return current;
        if (editingInsertionPromptId === updatedPrompt.id) {
          const mergedDraft = mergeSavedPromptDraft(current[index], {
            title: localInsertionTitle,
            content: localInsertionContent,
            file_paths: localInsertionFilePaths,
          }, updatedPrompt);
          setLocalInsertionTitle(mergedDraft.title);
          setLocalInsertionContent(mergedDraft.content);
          setLocalInsertionFilePaths(mergedDraft.file_paths || []);
        }
        const next = applySavedPromptLibraryUpdate(current, updatedPrompt);
        return next;
      });
    });
  }, [isOpen, editingInsertionPromptId, localInsertionTitle, localInsertionContent, localInsertionFilePaths]);

  useEffect(() => {
    if (!isOpen) return;
    return subscribeSavedPromptLibraryChanges(ipcRenderer, (change) => {
      setPrompts((current) => {
        const reconciled = reconcileSavedPromptEditor({
          prompts: current,
          nextPrompts: change.library.prompts,
          editingPromptId: editingInsertionPromptId,
          draft: { title: localInsertionTitle, content: localInsertionContent, file_paths: localInsertionFilePaths },
        });
        setPromptGroups(change.library.groups || []);
        setEditingInsertionPromptId(reconciled.editingPromptId);
        if (reconciled.editingPromptId) {
          setLocalInsertionTitle(reconciled.draft.title);
          setLocalInsertionContent(reconciled.draft.content);
          setLocalInsertionFilePaths(reconciled.draft.file_paths || []);
        }
        return reconciled.prompts;
      });
    });
  }, [isOpen, editingInsertionPromptId, localInsertionTitle, localInsertionContent, localInsertionFilePaths]);

  // Save current text insertion from local state
  const saveCurrentInsertion = (overrideFilePaths?: string[]) => {
    const index = editingInsertionPromptId === null ? -1 : prompts.findIndex((prompt) => prompt.id === editingInsertionPromptId);
    if (index >= 0) {
      const newPrompts = [...prompts];
      newPrompts[index] = { ...newPrompts[index], title: localInsertionTitle, content: localInsertionContent, file_paths: overrideFilePaths ?? localInsertionFilePaths };
      setPrompts(newPrompts);
      savePromptsImmediate(newPrompts);
    }
  };

  const startEditingInsertion = (index: number) => {
    if (prompts[index]?.id === editingInsertionPromptId) return;
    saveCurrentInsertion();
    saveCurrentAIPrompt();
    setEditingPromptId(null);
    setEditingInsertionPromptId(prompts[index].id);
    setLocalInsertionTitle(prompts[index].title);
    setLocalInsertionContent(prompts[index].content);
    setLocalInsertionFilePaths(prompts[index].file_paths || []);
    setInsertionFileInputs([]);
  };

  const beginPromptTreeRename = (
    kind: PromptTreeNodeKind,
    id: string | number,
    initialName?: string,
  ) => {
    const currentName = initialName ?? (kind === 'group'
      ? promptGroups.find(group => group.id === id)?.name
      : prompts.find(prompt => prompt.id === id)?.title);
    if (currentName == null) return;
    setPromptTreeContextMenu(null);
    setPromptTreeRename({ kind, id });
    setPromptTreeRenameDraft(currentName);
  };

  const commitPromptTreeRename = () => {
    if (!promptTreeRename) return;
    const nextName = promptTreeRenameDraft.trim();
    if (promptTreeRename.kind === 'prompt') {
      const current = prompts.find(prompt => prompt.id === promptTreeRename.id);
      if (current && nextName && current.title !== nextName) {
        const nextPrompts = prompts.map(prompt => prompt.id === promptTreeRename.id
          ? { ...prompt, title: nextName }
          : prompt);
        setPrompts(nextPrompts);
        savePromptsImmediate(nextPrompts);
        if (editingInsertionPromptId === promptTreeRename.id) {
          setLocalInsertionTitle(nextName);
        }
      }
    } else {
      const current = promptGroups.find(group => group.id === promptTreeRename.id);
      if (current && nextName && current.name !== nextName) {
        const nextGroups = promptGroups.map(group => group.id === promptTreeRename.id
          ? { ...group, name: nextName }
          : group);
        setPromptGroups(nextGroups);
        void ipcRenderer.invoke('prompt-groups:save', nextGroups);
      }
    }
    setPromptTreeRename(null);
  };

  useEffect(() => {
    if (!promptTreeContextMenu) return undefined;
    const closeMenu = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('[data-prompt-tree-context-menu]')) return;
      setPromptTreeContextMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPromptTreeContextMenu(null);
    };
    document.addEventListener('pointerdown', closeMenu, true);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeMenu, true);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [promptTreeContextMenu]);

  const promptStateWithLocalDrafts = useCallback((): PromptDragState => {
    const nextPrompts = prompts.map(p => ({ ...p }));
    const nextGroups = promptGroups.map(g => ({ ...g }));
    const index = editingInsertionPromptId === null ? -1 : nextPrompts.findIndex((prompt) => prompt.id === editingInsertionPromptId);
    if (index >= 0) {
      nextPrompts[index] = {
        ...nextPrompts[index],
        title: localInsertionTitle,
        content: localInsertionContent,
        file_paths: localInsertionFilePaths,
      };
    }
    return { prompts: nextPrompts, promptGroups: nextGroups };
  }, [editingInsertionPromptId, localInsertionContent, localInsertionFilePaths, localInsertionTitle, promptGroups, prompts]);

  const promptPos = (p: Prompt, fallback: number) => Number.isFinite(Number(p.position)) ? Number(p.position) : fallback;

  const markdownFence = (value: string, lang = 'text') => {
    const text = String(value || '').replace(/\r\n/g, '\n').trimEnd();
    const maxFence = (text.match(/`{3,}/g) || []).reduce((max, item) => Math.max(max, item.length), 2);
    const fence = '`'.repeat(Math.max(3, maxFence + 1));
    return `${fence}${lang}\n${text || '(empty)'}\n${fence}`;
  };

  // Build flat items: groups and ungrouped prompts interleaved by position
  const flatItemsFor = (state: PromptDragState): FlatItem[] => {
    const ungrouped = orderVisualHierarchyItems(
      state.prompts
        .map((prompt, origIdx) => ({ ...prompt, origIdx }))
        .filter(prompt => !prompt.group_id)
        .sort((a, b) => promptPos(a, a.origIdx) - promptPos(b, b.origIdx)),
      { parentKey: 'visual_parent_id' },
    );
    const depth = buildVisualHierarchyDepthMap(ungrouped, { parentKey: 'visual_parent_id' });
    const roots: FlatItem[] = [
      ...state.promptGroups.map(group => ({ type: 'group' as const, group })),
      ...ungrouped.filter(prompt => (depth.get(prompt.id) || 0) === 0)
        .map(prompt => ({ type: 'prompt' as const, origIdx: prompt.origIdx, prompt })),
    ].sort((a, b) => {
      const posA = a.type === 'group' ? a.group.position : promptPos(a.prompt, a.origIdx);
      const posB = b.type === 'group' ? b.group.position : promptPos(b.prompt, b.origIdx);
      return posA - posB;
    });
    const result: FlatItem[] = [];
    for (const root of roots) {
      result.push(root);
      if (root.type !== 'prompt') continue;
      const rootIndex = ungrouped.findIndex(prompt => prompt.id === root.prompt.id);
      for (let index = rootIndex + 1; index < ungrouped.length; index += 1) {
        if ((depth.get(ungrouped[index].id) || 0) === 0) break;
        const prompt = ungrouped[index];
        result.push({ type: 'prompt', origIdx: prompt.origIdx, prompt });
      }
    }
    return result;
  };

  const promptOutlineSignature = JSON.stringify({
    prompts: prompts.map((prompt) => [
      prompt.id,
      prompt.group_id ?? null,
      prompt.visual_parent_id ?? null,
      Number(prompt.position || 0),
    ]),
    groups: promptGroups.map((group) => [
      group.id,
      Number(group.position || 0),
      !!group.is_collapsed,
    ]),
  });
  const promptOutline = useMemo(
    () => buildPromptOutline(prompts, promptGroups),
    [promptOutlineSignature],
  );

  const commitPromptOutline = useCallback(async ({ previewOutline }: { previewOutline: any[] }) => {
    const next = applyPromptOutline(promptStateWithLocalDrafts(), previewOutline);
    if (!next.ok) return next;
    await Promise.all([
      savePromptsImmediate(next.prompts),
      ipcRenderer.invoke('prompt-groups:save', next.promptGroups),
    ]);
    setPrompts(next.prompts);
    setPromptGroups(next.promptGroups);
    return { ok: true };
  }, [promptStateWithLocalDrafts, savePromptsImmediate]);

  const handlePromptExpansion = useCallback(async ({ nodeId, expanded }: { nodeId: string; expanded: boolean }) => {
    const value = String(nodeId || '');
    if (!value.startsWith('prompt-group:')) return { ok: false, reason: 'group-must-stay-root' };
    const groupId = Number(value.slice('prompt-group:'.length));
    const nextGroups = promptGroups.map(group => group.id === groupId
      ? { ...group, is_collapsed: !expanded }
      : group);
    if (nextGroups.every((group, index) => group === promptGroups[index])) return { ok: true };
    setPromptGroups(nextGroups);
    await ipcRenderer.invoke('prompt-groups:save', nextGroups);
    return { ok: true };
  }, [promptGroups]);

  const promptDnd = useOutlineDnd({
    outline: promptOutline,
    disabled: promptTreeRename !== null,
    onCommit: commitPromptOutline,
    onExpansionRequest: handlePromptExpansion,
    canHorizontalMove: promptOutlineHorizontalPolicy,
    canUseVerticalSlot: promptOutlineVerticalSlotPolicy,
    outsidePointerPolicy: 'horizontal-corridor',
    layoutAnimation: {
      duration: 120,
      easing: 'cubic-bezier(0.2, 0, 0, 1)',
      respectReducedMotion: false,
      maxAnimatedRows: 14,
      minRetargetInterval: 72,
      animateDuringScroll: false,
    },
  });

  const promptOutlineNodeById = useMemo(() => {
    const nodes = new Map<string, any>();
    const visit = (items: any[]) => items.forEach((node) => {
      nodes.set(String(node.id), node);
      visit(Array.isArray(node.children) ? node.children : []);
    });
    visit(promptDnd.previewOutline);
    return nodes;
  }, [promptDnd.previewOutline]);

  const buildPromptExportText = async (state: PromptDragState) => {
    const filePaths = Array.from(new Set(
      state.prompts.flatMap(p => (Array.isArray(p.file_paths) ? p.file_paths : []))
        .map(fp => String(fp || '').trim())
        .filter(Boolean)
    ));
    const fileContentByPath = new Map<string, string>();
    if (filePaths.length > 0) {
      const filesResult = await ipcRenderer.invoke('ai-prompts:read-files', filePaths).catch((err: any) => {
        console.warn('[SettingsPrompts] read prompt files failed:', err?.message || err);
        return null;
      });
      if (filesResult?.success && Array.isArray(filesResult.data)) {
        filesResult.data.forEach((file: { path: string; content: string }) => {
          if (file?.path) fileContentByPath.set(file.path, file.content || '');
        });
      }
    }

    const renderPrompt = (prompt: Prompt) => {
      const lines: string[] = [];
      const title = (prompt.title || '').trim() || 'Untitled';
      lines.push(`### Prompt: ${title}`);
      lines.push('');
      lines.push('Definition:');
      lines.push(markdownFence(prompt.content || ''));
      const promptFiles = (Array.isArray(prompt.file_paths) ? prompt.file_paths : [])
        .map(fp => String(fp || '').trim())
        .filter(Boolean);
      if (promptFiles.length > 0) {
        lines.push('');
        lines.push('Files:');
        promptFiles.forEach((fp) => {
          lines.push('');
          lines.push(`#### File: ${fp}`);
          lines.push(markdownFence(fileContentByPath.has(fp) ? fileContentByPath.get(fp)! : '(file could not be read)'));
        });
      }
      return lines.join('\n');
    };

    const parts: string[] = [
      '# Text Insertions',
      '',
      `Total prompts: ${state.prompts.length}`,
    ];

    let ungroupedOpen = false;
    flatItemsFor(state).forEach((item) => {
      if (item.type === 'group') {
        ungroupedOpen = false;
        const groupPrompts = state.prompts
          .map((p, i) => ({ ...p, _idx: i }))
          .filter(p => p.group_id === item.group.id)
          .sort((a, b) => promptPos(a, a._idx) - promptPos(b, b._idx));
        parts.push('');
        parts.push(`## Group: ${(item.group.name || '').trim() || 'Untitled group'}`);
        if (groupPrompts.length === 0) {
          parts.push('');
          parts.push('_No prompts_');
        } else {
          groupPrompts.forEach((prompt) => {
            parts.push('');
            parts.push(renderPrompt(prompt));
          });
        }
      } else {
        if (!ungroupedOpen) {
          parts.push('');
          parts.push('## Ungrouped');
          ungroupedOpen = true;
        }
        parts.push('');
        parts.push(renderPrompt(item.prompt));
      }
    });

    return parts.join('\n').replace(/\n{4,}/g, '\n\n\n').trimEnd() + '\n';
  };

  const copyTextInsertions = async () => {
    if (textInsertCopying || prompts.length === 0) return;
    setTextInsertCopying(true);
    try {
      const text = await buildPromptExportText(promptStateWithLocalDrafts());
      clipboard.writeText(text);
      setTextInsertCopied(true);
      if (textInsertCopiedTimer.current) clearTimeout(textInsertCopiedTimer.current);
      textInsertCopiedTimer.current = setTimeout(() => setTextInsertCopied(false), 1400);
    } catch (err: any) {
      showToast('Copy failed: ' + (err?.message || err), 'error');
    } finally {
      setTextInsertCopying(false);
    }
  };


  // Start editing an AI prompt (auto-saves current before switching)
  const startEditingAIPrompt = (prompt: AIPrompt) => {
    if (prompt.id === editingPromptId) return;
    saveCurrentAIPrompt();
    saveCurrentInsertion();
    setEditingInsertionPromptId(null);
    setEditingPromptId(prompt.id);
    setLocalPromptContent(prompt.content);
    setLocalPromptName(prompt.name);
    setLocalPromptColor(prompt.color);
    setLocalPromptShowInMenu(prompt.showInContextMenu);
    setLocalPromptModel(prompt.model);
    setLocalPromptThinkingLevel(prompt.thinkingLevel);
    setLocalPromptFilePaths(prompt.filePaths || []);
    setFilePathInputs([]);
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
      position: maxPos + 1,
      filePaths: []
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
    const pos = groupId
      ? Math.max(-1, ...prompts.filter(p => p.group_id === groupId).map((p, i) => promptPos(p, i))) + 1
      : getNextFlatPosition();
    const newPrompts = [...prompts, { id: newTextPromptId(), title: `Prompt ${prompts.length + 1}`, content: '', group_id: groupId ?? null, visual_parent_id: null, position: pos }];
    setPrompts(newPrompts);
    savePromptsImmediate(newPrompts);
    const idx = newPrompts.length - 1;
    setEditingInsertionPromptId(newPrompts[idx].id);
    setLocalInsertionTitle(newPrompts[idx].title);
    setLocalInsertionContent('');
    setLocalInsertionFilePaths([]);
    setInsertionFileInputs([]);
    beginPromptTreeRename('prompt', newPrompts[idx].id, newPrompts[idx].title);
  };

  const addPromptGroup = async () => {
    const maxId = promptGroups.reduce((max, g) => Math.max(max, g.id), 0);
    const newGroup: PromptGroup = { id: maxId + 1, name: `Group ${promptGroups.length + 1}`, description: '', position: getNextFlatPosition(), is_collapsed: false };
    const newGroups = [...promptGroups, newGroup];
    setPromptGroups(newGroups);
    await ipcRenderer.invoke('prompt-groups:save', newGroups);
    beginPromptTreeRename('group', newGroup.id, newGroup.name);
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
    if (promptTreeRename?.kind === 'group' && promptTreeRename.id === groupId) {
      setPromptTreeRename(null);
    }
    showToast('Group deleted', 'success');
  };

  const deletePrompt = async (index: number) => {
    const deletedId = prompts[index]?.id;
    const newPrompts = prompts
      .filter((_, i) => i !== index)
      .map(prompt => prompt.visual_parent_id === deletedId ? { ...prompt, visual_parent_id: null } : prompt);
    setPrompts(newPrompts);
    await savePromptsImmediate(newPrompts);
    showToast('Deleted', 'success');
    setEditingInsertionPromptId(null);
  };

  const switchAISubTab = (next: AISubTab) => {
    if (next === aiSubTab) return;
    if (aiSubTab === 'system') {
      saveCurrentAIPrompt();
      setEditingPromptId(null);
    }
    if (aiSubTab === 'text') {
      saveCurrentInsertion();
      setEditingInsertionPromptId(null);
      setPromptTreeRename(null);
      setPromptTreeContextMenu(null);
    }
    setAiSubTab(next);
  };

  const renderPromptOutlineRow = (row: any) => {
    const node = promptOutlineNodeById.get(String(row.id));
    if (!node) return null;
    const isGroup = node.entityType === 'group';
    const prompt = !isGroup
      ? prompts.find((candidate) => candidate.id === node.promptId) || node.rawPrompt as Prompt
      : null;
    const liveGroup = isGroup
      ? promptGroups.find((candidate) => candidate.id === node.groupId) || node.rawGroup
      : null;
    const promptIndex = prompt ? prompts.findIndex(candidate => candidate.id === prompt.id) : -1;
    const rowProps = promptDnd.getRowProps(row);
    const dragState = promptDnd.dragState;
    const isSource = dragState?.sourceIds?.includes(row.id) || dragState?.sourceId === row.id;
    const dwell = dragState?.navigationDwell;
    const isNavigationTarget = dwell?.targetId === row.id;
    const navigationBlocked = isNavigationTarget && dwell?.blocked;
    const inGroup = !isGroup && (row.path || []).some((id: string) => promptOutlineNodeById.get(String(id))?.entityType === 'group');
    const visualDepth = isGroup ? 0 : Math.max(0, row.depth - (inGroup ? 1 : 0));
    const promptAncestors = !isGroup
      ? (row.path || []).slice(0, -1).filter((id: string) => promptOutlineNodeById.get(String(id))?.entityType === 'prompt')
      : [];
    const containingGroup = !isGroup
      ? (row.path || []).map((id: string) => promptOutlineNodeById.get(String(id))).find((candidate: any) => candidate?.entityType === 'group')
      : null;
    const continuationPromptDepths = !isGroup
      ? (row.ancestorContinuationDepths || []).flatMap((pathIndex: number) => {
          const continuationNode = promptOutlineNodeById.get(String(row.path?.[pathIndex]));
          if (continuationNode?.entityType !== 'prompt') return [];
          const lineDepth = (row.path || [])
            .slice(0, pathIndex + 1)
            .filter((id: string) => promptOutlineNodeById.get(String(id))?.entityType === 'prompt')
            .length;
          return lineDepth > 0 ? [lineDepth] : [];
        })
      : [];
    const intent = isSource ? dragState?.feedback : null;
    const connectorColor = 'rgba(139,92,246,0.58)';
    const hierarchyStep = 12;
    const marginLeft = isGroup ? 0 : (inGroup ? 18 : 0) + visualDepth * hierarchyStep;
    const selected = !isGroup && prompt?.id === editingInsertionPromptId;
    const isRenaming = promptTreeRename?.kind === (isGroup ? 'group' : 'prompt')
      && promptTreeRename.id === (isGroup ? node.groupId : prompt?.id);
    const isContextTarget = promptTreeContextMenu?.kind === (isGroup ? 'group' : 'prompt')
      && promptTreeContextMenu.id === (isGroup ? node.groupId : prompt?.id);
    const dndId = isGroup ? String(node.groupId) : prompt?.id;
    return (
      <div
        key={String(row.id)}
        {...rowProps}
        data-prompt-outline-row="true"
        data-prompt-outline-kind={isGroup ? 'group' : 'prompt'}
        data-dnd-kind={isGroup ? 'group' : inGroup ? 'group-prompt' : 'flat'}
        data-dnd-flat-container={isGroup || !inGroup ? 'true' : undefined}
        data-dnd-type={isGroup ? 'group' : 'prompt'}
        data-dnd-id={dndId}
        data-group-id={isGroup ? String(node.groupId) : containingGroup ? String(containingGroup.groupId) : undefined}
        data-prompt-id={prompt?.id}
        data-prompt-index={promptIndex >= 0 ? String(promptIndex) : undefined}
        data-visual-parent-id={promptAncestors.length > 0 ? String(promptAncestors[promptAncestors.length - 1]).replace(/^prompt:/, '') : undefined}
        data-visual-depth={isGroup ? undefined : String(visualDepth)}
        data-dnd-navigation-protected={navigationBlocked ? 'true' : undefined}
        data-prompt-context-target={isContextTarget ? 'true' : undefined}
        onClick={(event) => {
          if (event.defaultPrevented || isRenaming) return;
          if (!isGroup && promptIndex >= 0) {
            startEditingInsertion(promptIndex);
          }
        }}
        onDoubleClick={isGroup ? undefined : (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (
            !promptDnd.dragState
            && !event.metaKey
            && !event.ctrlKey
            && !event.shiftKey
            && prompt
          ) {
            beginPromptTreeRename('prompt', prompt.id, prompt.title);
          }
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          const menuWidth = 176;
          const menuHeight = 82;
          setPromptTreeContextMenu({
            kind: isGroup ? 'group' : 'prompt',
            id: isGroup ? node.groupId : prompt!.id,
            x: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8)),
            y: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8)),
          });
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 6,
          marginLeft,
          width: marginLeft ? `calc(100% - ${marginLeft}px)` : '100%',
          padding: '8px 9px',
          borderRadius: 8,
          background: navigationBlocked
            ? 'rgba(113,113,122,0.12)'
            : isSource
              ? 'rgba(124,58,237,0.18)'
              : (selected ? '#24242a' : VR_CARD),
          border: `1px ${intent?.blocked || navigationBlocked ? 'dashed' : 'solid'} ${navigationBlocked ? '#73737a' : intent?.blocked ? '#73737a' : isSource ? VR_VIOLET : isContextTarget ? '#a78bfa' : selected ? VR_ACCENT : VR_BORDER}`,
          boxShadow: isSource
            ? '0 0 0 1px rgba(124,58,237,0.22) inset'
            : isContextTarget
              ? '0 0 0 1px rgba(167,139,250,0.32) inset'
              : 'none',
          cursor: isSource ? 'grabbing' : 'pointer',
          minWidth: 0,
          opacity: dragState?.navigationMode && isSource ? 0.62 : 1,
          userSelect: 'none',
          touchAction: 'none',
          position: 'relative',
          boxSizing: 'border-box',
        }}
      >
        {!isGroup && promptAncestors.length > 0 && (
          <>
            {continuationPromptDepths.map((lineDepth: number) => (
              <span key={lineDepth} aria-hidden data-prompt-connector="continuation" style={{ position: 'absolute', left: -7 - ((visualDepth - lineDepth) * hierarchyStep), top: -6, bottom: -6, width: 1, background: connectorColor, pointerEvents: 'none' }} />
            ))}
            <span aria-hidden data-prompt-connector="top" style={{ position: 'absolute', left: -7, top: -6, bottom: '50%', width: 1, background: connectorColor, pointerEvents: 'none' }} />
            {row.hasNextSibling && (
              <span aria-hidden data-prompt-connector="bottom" style={{ position: 'absolute', left: -7, top: '50%', bottom: -6, width: 1, background: connectorColor, pointerEvents: 'none' }} />
            )}
            <span aria-hidden data-prompt-connector="elbow" style={{ position: 'absolute', left: -7, top: '50%', width: 8, height: 1, background: connectorColor, pointerEvents: 'none' }} />
          </>
        )}
        {isGroup ? (
          <>
            <button
              data-outline-dnd-ignore
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                void promptDnd.requestExpansion(row.id, row.expanded === false, 'pointer-toggle');
              }}
              style={{ border: 'none', background: 'transparent', color: VR_DIM, cursor: 'pointer', padding: 0, width: 18, display: 'flex' }}
            >
              {navigationBlocked ? (
                <CircleX data-outline-dnd-navigation-blocked="true" size={14} style={{ color: '#a1a1aa' }} />
              ) : isNavigationTarget ? (
                <Loader2
                  data-dnd-navigation-loader
                  data-dnd-navigation-phase={dwell?.pending ? 'loading' : 'waiting'}
                  size={14}
                  className="animate-spin"
                  style={{ color: '#c4b5fd' }}
                />
              ) : (
                <VRChevronIcon open={row.expanded} />
              )}
            </button>
            <VRFolderIcon />
            {isRenaming ? (
              <input
                ref={promptTreeRenameInput.ref}
                data-outline-dnd-ignore
                data-prompt-outline-rename="group"
                value={promptTreeRenameDraft}
                onChange={(event) => setPromptTreeRenameDraft(event.target.value)}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => event.stopPropagation()}
                onDoubleClick={(event) => event.stopPropagation()}
                onContextMenu={(event) => event.stopPropagation()}
                onBlur={commitPromptTreeRename}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    commitPromptTreeRename();
                  } else if (event.key === 'Escape') {
                    event.preventDefault();
                    setPromptTreeRename(null);
                  }
                }}
                style={{ ...vrFieldStyle, flex: 1, height: 26, padding: '3px 7px', fontSize: 13 }}
              />
            ) : (
              <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: VR_TEXT, fontWeight: 650, fontSize: 13 }}>{liveGroup?.name || 'Группа'}</div>
            )}
            <VRTag>{node.children?.length || 0}</VRTag>
          </>
        ) : (
          <>
            <VRDocIcon />
            {isRenaming ? (
              <input
                ref={promptTreeRenameInput.ref}
                data-outline-dnd-ignore
                data-prompt-outline-rename="prompt"
                value={promptTreeRenameDraft}
                onChange={(event) => setPromptTreeRenameDraft(event.target.value)}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => event.stopPropagation()}
                onDoubleClick={(event) => event.stopPropagation()}
                onContextMenu={(event) => event.stopPropagation()}
                onBlur={commitPromptTreeRename}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    commitPromptTreeRename();
                  } else if (event.key === 'Escape') {
                    event.preventDefault();
                    setPromptTreeRename(null);
                  }
                }}
                style={{ ...vrFieldStyle, flex: 1, height: 26, padding: '3px 7px', fontSize: 13 }}
              />
            ) : (
              <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: selected ? '#bfdbfe' : VR_TEXT, fontWeight: 620, fontSize: 13 }}>{prompt?.title || 'Untitled'}</div>
            )}
            {(prompt?.file_paths?.length || 0) > 0 && <VRTag accent>{prompt?.file_paths?.length} файл.</VRTag>}
            {intent && <span aria-hidden data-horizontal-intent={intent.direction} data-horizontal-intent-disabled={intent.blocked ? 'true' : undefined} style={{ color: intent.blocked ? '#73737a' : '#a78bfa', fontSize: 15, fontWeight: 800, lineHeight: 1 }}>{intent.direction === 'left' ? '←' : '→'}{intent.blocked ? '×' : ''}</span>}
          </>
        )}
      </div>
    );
  };

  const renderInsertionFiles = () => {
    const pickFile = async () => {
      const result = await ipcRenderer.invoke('ai-prompts:select-file');
      if (result.success && result.data) {
        const updated = [...localInsertionFilePaths, result.data];
        setLocalInsertionFilePaths(updated);
        saveCurrentInsertion(updated);
      }
    };

    const commitManualPath = async (idx: number) => {
      const val = insertionFileInputs[idx]?.value?.trim();
      if (!val) {
        setInsertionFileInputs(prev => prev.filter((_, i) => i !== idx));
        return;
      }
      const result = await ipcRenderer.invoke('ai-prompts:check-file', val);
      if (result.exists) {
        const updated = [...localInsertionFilePaths, val];
        setLocalInsertionFilePaths(updated);
        setInsertionFileInputs(prev => prev.filter((_, i) => i !== idx));
        saveCurrentInsertion(updated);
      } else {
        const updated = [...insertionFileInputs];
        updated[idx] = { ...updated[idx], valid: false };
        setInsertionFileInputs(updated);
      }
    };

    return (
      <VRSection title="Файлы в конце промпта" onAdd={pickFile} addLabel="Finder">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {localInsertionFilePaths.map((fp, idx) => (
            <div key={`${fp}-${idx}`} style={{ display: 'flex', alignItems: 'center', gap: 7, border: `1px solid ${VR_BORDER}`, background: VR_FIELD, borderRadius: 7, padding: '6px 8px' }}>
              <VRFileIcon />
              <span title={fp} style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', direction: 'rtl', textAlign: 'left', color: '#bdbdc2', fontSize: 11.5 }}>{fp}</span>
              <VRIconBtn
                title="Убрать файл"
                danger
                small
                onClick={() => {
                  const updated = localInsertionFilePaths.filter((_, i) => i !== idx);
                  setLocalInsertionFilePaths(updated);
                  saveCurrentInsertion(updated);
                }}
              >
                <VRXIcon />
              </VRIconBtn>
            </div>
          ))}
          {insertionFileInputs.map((input, idx) => (
            <div key={`input-${idx}`} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <input
                type="text"
                autoFocus
                value={input.value}
                onChange={(e) => {
                  const updated = [...insertionFileInputs];
                  updated[idx] = { value: e.target.value, valid: null };
                  setInsertionFileInputs(updated);
                }}
                onBlur={() => commitManualPath(idx)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitManualPath(idx);
                  if (e.key === 'Escape') setInsertionFileInputs(prev => prev.filter((_, i) => i !== idx));
                }}
                placeholder="/Users/..."
                style={{ ...vrFieldStyle, flex: 1, borderColor: input.valid === false ? VR_RED : VR_BORDER, fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11.5 }}
              />
              <VRIconBtn title="Убрать строку" danger small onClick={() => setInsertionFileInputs(prev => prev.filter((_, i) => i !== idx))}>
                <VRXIcon />
              </VRIconBtn>
            </div>
          ))}
          <div>
            <button onClick={() => setInsertionFileInputs(prev => [...prev, { value: '', valid: null }])} style={vrSmallBtnStyle('neutral')}>
              <VRPlusIcon small /> путь
            </button>
          </div>
        </div>
      </VRSection>
    );
  };

  const renderTextInsertEditor = () => {
    const selectedPrompt = editingInsertionPromptId === null
      ? null
      : prompts.find((prompt) => prompt.id === editingInsertionPromptId) || null;
    return (
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 34%) minmax(360px, 1fr)', gap: 12, height: '100%', minHeight: 0 }}>
        <div style={{ minHeight: 0, display: 'flex', flexDirection: 'column', background: '#17171a', border: `1px solid ${VR_BORDER}`, borderRadius: 10, overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 10px', borderBottom: `1px solid ${VR_BORDER}` }}>
            <VRTag>{prompts.length}</VRTag>
            <div style={{ flex: 1 }} />
            <button
              onClick={copyTextInsertions}
              disabled={prompts.length === 0 || textInsertCopying}
              title="Copy text insertions"
              style={{
                ...vrSmallBtnStyle('neutral'),
                width: 92,
                justifyContent: 'center',
                borderColor: textInsertCopied ? 'rgba(34,197,94,0.45)' : VR_BORDER,
                background: textInsertCopied ? 'rgba(34,197,94,0.14)' : VR_FIELD,
                color: textInsertCopied ? '#86efac' : '#c9c9cd',
                opacity: prompts.length === 0 ? 0.5 : 1,
                cursor: prompts.length === 0 || textInsertCopying ? 'default' : 'pointer',
              }}
            >
              {textInsertCopied ? <VRCheckIcon /> : <VRCopyIcon />}
              <span style={{ width: 42, textAlign: 'left' }}>{textInsertCopied ? 'Copied' : textInsertCopying ? 'Copying' : 'Copy'}</span>
            </button>
            <button onClick={addPromptGroup} style={vrSmallBtnStyle('neutral')}><VRFolderIcon /> Группа</button>
            <button onClick={() => addPrompt()} style={vrSmallBtnStyle('accent')}><VRPlusIcon small /> Промпт</button>
          </div>

          <div
            ref={(element) => {
              textListRef.current = element;
              promptDnd.scrollerRef.current = element;
              restoreSettingsScrollPosition('ai:text:list', element);
            }}
            onScroll={(event) => rememberSettingsScrollPosition('ai:text:list', event.currentTarget.scrollTop)}
            onDragStart={(e) => e.preventDefault()}
            data-settings-scroll-key="ai:text:list"
            data-prompt-outline="true"
            data-prompt-outline-phase={promptDnd.dragState?.phase || 'idle'}
            data-prompt-outline-navigation={promptDnd.dragState?.navigationMode ? 'true' : undefined}
            style={{ padding: 8, overflowY: 'auto', minHeight: 0, flex: 1 }}
          >
            {promptDnd.rows.length === 0 ? (
              <VREmpty text="Нет промптов. Добавь первый." />
            ) : (
              <>
                {promptDnd.rows.map(renderPromptOutlineRow)}
                <div {...promptDnd.scrollSpacerProps} />
              </>
            )}
          </div>
          {promptTreeContextMenu && (
            <div
              data-prompt-tree-context-menu
              style={{
                position: 'fixed',
                left: promptTreeContextMenu.x,
                top: promptTreeContextMenu.y,
                zIndex: 10050,
                width: 176,
                padding: 4,
                borderRadius: 8,
                border: `1px solid ${VR_BORDER}`,
                background: '#1d1d21',
                boxShadow: '0 12px 30px rgba(0,0,0,0.45)',
              }}
            >
              <button
                data-prompt-tree-context-action="rename"
                onClick={() => beginPromptTreeRename(
                  promptTreeContextMenu.kind,
                  promptTreeContextMenu.id,
                )}
                style={promptTreeContextActionStyle()}
              >
                <Pencil size={14} />
                <span>Rename</span>
              </button>
              <button
                data-prompt-tree-context-action="delete"
                onClick={() => {
                  const target = promptTreeContextMenu;
                  setPromptTreeContextMenu(null);
                  if (target.kind === 'group') {
                    void deletePromptGroup(Number(target.id));
                  } else {
                    const index = prompts.findIndex(prompt => prompt.id === target.id);
                    if (index >= 0) void deletePrompt(index);
                  }
                }}
                style={promptTreeContextActionStyle(true)}
              >
                <Trash2 size={14} />
                <span>Delete</span>
              </button>
            </div>
          )}
        </div>

        <div style={{ minHeight: 0, background: '#17171a', border: `1px solid ${VR_BORDER}`, borderRadius: 10, overflow: 'hidden' }}>
          {selectedPrompt ? (
            <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
              <div
                ref={(node) => restoreSettingsScrollPosition('ai:text:editor', node)}
                onScroll={(event) => rememberSettingsScrollPosition('ai:text:editor', event.currentTarget.scrollTop)}
                data-settings-scroll-key="ai:text:editor"
                style={{ padding: 14, overflowY: 'auto', minHeight: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 14 }}
              >
                <VRField label="Текст">
                  <textarea
                    value={localInsertionContent}
                    placeholder="Содержимое вставки..."
                    onChange={(e) => setLocalInsertionContent(e.target.value)}
                    onBlur={() => {
                      saveCurrentInsertion();
                      setSavedInsertionFlash('content');
                      if (savedInsertionTimer.current) clearTimeout(savedInsertionTimer.current);
                      savedInsertionTimer.current = setTimeout(() => setSavedInsertionFlash(null), 400);
                    }}
                    rows={16}
                    style={{ ...vrFieldStyle, minHeight: 320, height: 'auto', resize: 'vertical', fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12.5, lineHeight: 1.5, borderColor: savedInsertionFlash === 'content' ? VR_GREEN : VR_BORDER }}
                  />
                </VRField>
                {renderInsertionFiles()}
              </div>
            </div>
          ) : (
            <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: VR_DIM, fontSize: 13 }}>
              Выбери промпт слева
            </div>
          )}
        </div>
      </div>
    );
  };

  const fmtTokens = (n: number) => {
    const value = Number(n || 0);
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
    if (value >= 1000) return `${Math.round(value / 100) / 10}k`;
    return String(value);
  };

  const fmtChars = (n: number) => {
    const value = Number(n || 0);
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
    if (value >= 1000) return `${Math.round(value / 100) / 10}k`;
    return String(value);
  };

  const toggleAIUsageLog = (id: number) => {
    setExpandedAIUsageLogIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const copyAIUsageTabId = (tabId?: string | null) => {
    if (!tabId) return;
    clipboard.writeText(tabId);
    showToast('ID вкладки скопирован', 'success');
  };

  const renderTokenMetric = (label: string, value: number, color: string) => (
    <div style={{ background: VR_CARD, border: `1px solid ${VR_BORDER}`, borderRadius: 8, padding: 10, minWidth: 0 }}>
      <div style={{ color: VR_DIM, fontSize: 10, textTransform: 'uppercase', marginBottom: 6, fontWeight: 750 }}>{label}</div>
      <div style={{ color, fontSize: 19, fontWeight: 800, fontFamily: 'ui-monospace, Menlo, monospace', fontVariantNumeric: 'tabular-nums' }}>
        {fmtTokens(value)}
      </div>
    </div>
  );

  const renderUsageBreakdownRow = (row: any, label: string, accent?: boolean) => (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(140px, 1fr) auto', alignItems: 'center', gap: 10, minWidth: 0 }}>
      <div style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: accent ? '#bae6fd' : VR_TEXT, fontSize: 11.5, fontWeight: 650 }}>
        {label}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: VR_DIM, fontSize: 10.5, fontFamily: 'ui-monospace, Menlo, monospace', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
        <span style={{ color: '#bae6fd' }}>in {fmtTokens(row?.promptTokens || 0)}</span>
        <span style={{ color: '#bbf7d0' }}>out {fmtTokens(row?.candidateTokens || 0)}</span>
        <span style={{ color: '#ddd6fe' }}>think {fmtTokens(row?.thoughtTokens || 0)}</span>
        <span style={{ color: accent ? '#7dd3fc' : '#d4d4d8' }}>Σ {fmtTokens(row?.totalTokens || 0)}</span>
      </div>
    </div>
  );

  const renderAIUsageStatsPanel = () => {
    const totals = aiUsageStats?.totals || {};
    const history = Array.isArray(aiUsageStats?.history) ? aiUsageStats.history : [];
    const byModel = Array.isArray(aiUsageStats?.byModel) ? aiUsageStats.byModel.slice(0, 8) : [];
    const byPrompt = Array.isArray(aiUsageStats?.byPrompt) ? aiUsageStats.byPrompt.slice(0, 8) : [];
    const grouped = history.reduce((acc: Record<string, any[]>, row: any) => {
      const key = row.createdAt
        ? new Date(row.createdAt * 1000).toLocaleDateString('ru-RU', { day: '2-digit', month: 'short' })
        : 'без даты';
      if (!acc[key]) acc[key] = [];
      acc[key].push(row);
      return acc;
    }, {});
    const rangeItems: Array<{ id: AIUsageRange; label: string }> = [
      { id: 'week', label: '7d' },
      { id: 'month', label: '30d' },
      { id: 'all', label: 'all' },
    ];

    return (
      <div style={{ height: '100%', minHeight: 0, display: 'grid', gridTemplateColumns: 'minmax(360px, 1fr) minmax(360px, 1fr)', gap: 12 }}>
        <div style={{ minHeight: 0, display: 'flex', flexDirection: 'column', background: '#17171a', border: `1px solid ${VR_BORDER}`, borderRadius: 10, overflow: 'hidden' }}>
          <div style={{ padding: '10px 12px', borderBottom: `1px solid ${VR_BORDER}`, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 11, fontWeight: 750, letterSpacing: 0.4, color: VR_DIM, textTransform: 'uppercase' }}>Статистика AI</span>
            <VRTag>{totals.calls || 0}</VRTag>
            <div style={{ flex: 1 }} />
            <div style={{ display: 'inline-flex', background: VR_FIELD, border: `1px solid ${VR_BORDER}`, borderRadius: 7, padding: 2, gap: 2 }}>
              {rangeItems.map((item) => (
                <button
                  key={item.id}
                  onClick={() => setAIUsageRange(item.id)}
                  style={{
                    height: 22,
                    padding: '0 7px',
                    borderRadius: 5,
                    border: 'none',
                    background: aiUsageRange === item.id ? '#24242a' : 'transparent',
                    color: aiUsageRange === item.id ? '#bae6fd' : VR_DIM,
                    fontSize: 10,
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          <div style={{ padding: 12, display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8, borderBottom: `1px solid ${VR_BORDER}` }}>
            {renderTokenMetric('input', totals.promptTokens || 0, '#bae6fd')}
            {renderTokenMetric('output', totals.candidateTokens || 0, '#bbf7d0')}
            {renderTokenMetric('thinking', totals.thoughtTokens || 0, '#ddd6fe')}
            {renderTokenMetric('total', totals.totalTokens || 0, '#e0f2fe')}
          </div>

          <div
            ref={(node) => restoreSettingsScrollPosition('ai:usage:breakdown', node)}
            onScroll={(event) => rememberSettingsScrollPosition('ai:usage:breakdown', event.currentTarget.scrollTop)}
            data-settings-scroll-key="ai:usage:breakdown"
            style={{ padding: 12, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}
          >
            <div style={{ background: VR_CARD, border: `1px solid ${VR_BORDER}`, borderRadius: 8, padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ color: VR_DIM, fontSize: 10, textTransform: 'uppercase', fontWeight: 750 }}>по prompt</div>
              {byPrompt.length > 0
                ? byPrompt.map((p: any) => renderUsageBreakdownRow(p, p.name || p.id, p.id === editingPromptId))
                : <div style={{ color: '#666', fontSize: 11 }}>Пока нет вызовов</div>}
            </div>
            <div style={{ background: VR_CARD, border: `1px solid ${VR_BORDER}`, borderRadius: 8, padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ color: VR_DIM, fontSize: 10, textTransform: 'uppercase', fontWeight: 750 }}>по model</div>
              {byModel.length > 0
                ? byModel.map((m: any) => renderUsageBreakdownRow(m, m.id, false))
                : <div style={{ color: '#666', fontSize: 11 }}>Пока нет моделей</div>}
            </div>
          </div>
        </div>

        <div style={{ minHeight: 0, display: 'flex', flexDirection: 'column', background: '#17171a', border: `1px solid ${VR_BORDER}`, borderRadius: 10, overflow: 'hidden' }}>
          <div style={{ padding: '10px 12px', borderBottom: `1px solid ${VR_BORDER}`, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 11, fontWeight: 750, letterSpacing: 0.4, color: VR_DIM, textTransform: 'uppercase' }}>История вызовов</span>
            {aiUsageLoading && <VRTag>loading</VRTag>}
          </div>
          <div
            ref={(node) => restoreSettingsScrollPosition('ai:usage:history', node)}
            onScroll={(event) => rememberSettingsScrollPosition('ai:usage:history', event.currentTarget.scrollTop)}
            data-settings-scroll-key="ai:usage:history"
            style={{ padding: 12, minHeight: 0, flex: 1, overflowY: 'auto' }}
          >
            {Object.keys(grouped).length === 0 && !aiUsageLoading ? (
              <VREmpty text="История AI-вызовов пустая" />
            ) : Object.entries(grouped).map(([date, rows]) => (
              <div key={date} style={{ marginBottom: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <span style={{ color: '#9ca3af', fontSize: 10.5, fontWeight: 750, textTransform: 'uppercase' }}>{date}</span>
                  <div style={{ height: 1, background: VR_BORDER, flex: 1 }} />
                  <span style={{ color: '#666', fontSize: 10 }}>{(rows as any[]).length}</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {(rows as any[]).map((row) => {
                    const expanded = expandedAIUsageLogIds.has(row.id);
                    const projectLabel = row.projectName || (row.projectPath ? String(row.projectPath).split('/').filter(Boolean).pop() : '') || 'project?';
                    const tabLabel = row.tabName || (row.tabId ? row.tabId.slice(-8) : 'tab?');
                    return (
                      <div
                        key={row.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => toggleAIUsageLog(row.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            toggleAIUsageLog(row.id);
                          }
                        }}
                        style={{
                          background: row.status === 'error' ? 'rgba(239,68,68,0.08)' : VR_CARD,
                          border: `1px solid ${row.status === 'error' ? 'rgba(239,68,68,0.28)' : VR_BORDER}`,
                          borderRadius: 8,
                          padding: '7px 8px',
                          cursor: 'pointer',
                          outline: 'none',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, marginBottom: 4 }}>
                          <span style={{ color: row.status === 'error' ? '#fca5a5' : VR_TEXT, fontSize: 11.5, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {row.promptName || row.taskType || row.promptId || 'AI prompt'}
                          </span>
                          {row.thinkingLevel && row.thinkingLevel !== 'NONE' && <VRTag>{row.thinkingLevel}</VRTag>}
                          <div style={{ flex: 1 }} />
                          <span style={{ color: '#73737a', display: 'inline-flex' }}>
                            <VRChevronIcon open={expanded} />
                          </span>
                        </div>
                        <div style={{ color: VR_DIM, fontSize: 10.5, display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.model || 'model?'}</span>
                          <span style={{ fontFamily: 'ui-monospace, Menlo, monospace', whiteSpace: 'nowrap' }}>
                            in {fmtTokens(row.promptTokens)} · out {fmtTokens(row.candidateTokens)} · think {fmtTokens(row.thoughtTokens)} · Σ {fmtTokens(row.totalTokens)}
                          </span>
                        </div>
                        {expanded && (
                          <div style={{ marginTop: 8, paddingTop: 8, borderTop: `1px solid ${VR_BORDER}`, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: '6px 10px', color: VR_DIM, fontSize: 10.5 }}>
                            <div style={{ minWidth: 0 }}>
                              <span style={{ color: '#666' }}>project </span>
                              <span title={row.projectPath || projectLabel} style={{ color: VR_TEXT, overflowWrap: 'anywhere' }}>{projectLabel}</span>
                            </div>
                            <div style={{ minWidth: 0 }}>
                              <span style={{ color: '#666' }}>iteration </span>
                              <span style={{ color: VR_TEXT, fontFamily: 'ui-monospace, Menlo, monospace' }}>{row.iterationIndex ? `#${row.iterationIndex}` : '—'}</span>
                            </div>
                            <div style={{ minWidth: 0 }}>
                              <span style={{ color: '#666' }}>tab </span>
                              <span
                                title={row.tabId ? `Copy tab id: ${row.tabId}` : tabLabel}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  copyAIUsageTabId(row.tabId);
                                }}
                                style={{
                                  color: row.tabId ? '#7dd3fc' : VR_TEXT,
                                  cursor: row.tabId ? 'pointer' : 'default',
                                  textDecoration: row.tabId ? 'underline' : 'none',
                                  textUnderlineOffset: 2,
                                  overflowWrap: 'anywhere',
                                }}
                              >
                                {tabLabel}
                              </span>
                            </div>
                            <div style={{ minWidth: 0 }}>
                              <span style={{ color: '#666' }}>source chars </span>
                              <span style={{ color: VR_TEXT, fontFamily: 'ui-monospace, Menlo, monospace' }}>{fmtChars(row.sourceChars || 0)}</span>
                            </div>
                            {row.error && (
                              <div style={{ gridColumn: '1 / -1', color: '#fca5a5', overflowWrap: 'anywhere' }}>
                                {row.error}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  };

  const renderSystemPrompts = () => {
    const editingAIPrompt = editingPromptId !== null ? aiPrompts.find(p => p.id === editingPromptId) : null;

    const renderAIPromptEditor = () => {
      if (!editingAIPrompt) {
        return (
          <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: VR_DIM, fontSize: 13 }}>
            Выбери системный промпт слева
          </div>
        );
      }

      const saveField = (overrides: Partial<AIPrompt>) => {
        saveAIPrompt({
          ...editingAIPrompt,
          name: localPromptName,
          content: localPromptContent,
          color: localPromptColor,
          showInContextMenu: localPromptShowInMenu,
          model: localPromptModel,
          thinkingLevel: localPromptThinkingLevel,
          filePaths: localPromptFilePaths,
          ...overrides
        });
      };

      const pickFile = async () => {
        const result = await ipcRenderer.invoke('ai-prompts:select-file');
        if (result.success && result.data) {
          const updated = [...localPromptFilePaths, result.data];
          setLocalPromptFilePaths(updated);
          saveField({ filePaths: updated });
        }
      };

      const commitManualPath = async (idx: number) => {
        const val = filePathInputs[idx]?.value?.trim();
        if (!val) {
          setFilePathInputs(prev => prev.filter((_, i) => i !== idx));
          return;
        }
        const result = await ipcRenderer.invoke('ai-prompts:check-file', val);
        if (result.exists) {
          const updated = [...localPromptFilePaths, val];
          setLocalPromptFilePaths(updated);
          setFilePathInputs(prev => prev.filter((_, i) => i !== idx));
          saveField({ filePaths: updated });
        } else {
          const updated = [...filePathInputs];
          updated[idx] = { ...updated[idx], valid: false };
          setFilePathInputs(updated);
        }
      };

      return (
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '12px 14px', borderBottom: `1px solid ${VR_BORDER}`, display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 10, height: 10, borderRadius: '50%', background: localPromptColor, flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ color: VR_TEXT, fontSize: 14, fontWeight: 750, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{localPromptName || 'Prompt'}</div>
            </div>
            <VRIconBtn title="Закрыть" onClick={closeAIPromptEditor}><VRXIcon /></VRIconBtn>
          </div>

          <div
            ref={(node) => restoreSettingsScrollPosition('ai:system:editor', node)}
            onScroll={(event) => rememberSettingsScrollPosition('ai:system:editor', event.currentTarget.scrollTop)}
            data-settings-scroll-key="ai:system:editor"
            style={{ padding: 14, overflowY: 'auto', minHeight: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 14 }}
          >
            <VRField label="Название">
              <input
                type="text"
                value={localPromptName}
                onChange={(e) => setLocalPromptName(e.target.value)}
                onBlur={() => saveCurrentAIPrompt('name')}
                placeholder="Название..."
                style={{ ...vrFieldStyle, borderColor: savedFlashField === 'name' ? VR_GREEN : VR_BORDER }}
              />
            </VRField>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 10.5, color: VR_DIM, flexShrink: 0 }}>Модель:</span>
                {GEMINI_MODEL_OPTIONS.map((model) => (
                  <button
                    key={model.value}
                    onClick={(e) => { e.stopPropagation(); setLocalPromptModel(model.value); saveField({ model: model.value }); }}
                    style={{ padding: '4px 10px', backgroundColor: localPromptModel === model.value ? localPromptColor : VR_FIELD, color: localPromptModel === model.value ? '#fff' : VR_DIM, border: `1px solid ${localPromptModel === model.value ? localPromptColor : VR_BORDER}`, borderRadius: 7, fontSize: 11.5, cursor: 'pointer' }}
                  >
                    {model.label}
                  </button>
                ))}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 10.5, color: VR_DIM, flexShrink: 0 }}>Думание:</span>
                {(['NONE', 'LOW', 'MEDIUM', 'HIGH'] as ThinkingLevel[]).map((level) => (
                  <button
                    key={level}
                    onClick={(e) => { e.stopPropagation(); setLocalPromptThinkingLevel(level); saveField({ thinkingLevel: level }); }}
                    style={{ padding: '4px 8px', backgroundColor: localPromptThinkingLevel === level ? localPromptColor : VR_FIELD, color: localPromptThinkingLevel === level ? '#fff' : VR_DIM, border: `1px solid ${localPromptThinkingLevel === level ? localPromptColor : VR_BORDER}`, borderRadius: 7, fontSize: 11.5, cursor: 'pointer' }}
                  >
                    {level}
                  </button>
                ))}
              </div>

              {editingAIPrompt.id === PROMPT_SUMMARY_PROMPT_ID && (
                <FontSizeSlider
                  label="Предыдущие user-сообщения"
                  description="Контекст для Prompt Summary"
                  value={promptSummaryPreviousUserCount}
                  onChange={setPromptSummaryPreviousUserCount}
                  min={0}
                  max={10}
                  suffix=""
                />
              )}

              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 10.5, color: VR_DIM, flexShrink: 0 }}>Цвет:</span>
                {['#0ea5e9', '#a855f7', '#f59e0b', '#22c55e', '#ef4444', '#6366f1', '#ec4899'].map((color) => (
                  <button
                    key={color}
                    onClick={(e) => { e.stopPropagation(); setLocalPromptColor(color); saveField({ color }); }}
                    style={{ width: 18, height: 18, borderRadius: '50%', backgroundColor: color, cursor: 'pointer', border: localPromptColor === color ? '2px solid #fff' : '2px solid transparent', padding: 0 }}
                  />
                ))}
              </div>

              <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: VR_DIM, fontSize: 11.5 }}>
                <span>В контекстном меню:</span>
                <button
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const next = !localPromptShowInMenu;
                    setLocalPromptShowInMenu(next);
                    saveField({ showInContextMenu: next });
                  }}
                  style={{ width: 30, height: 17, borderRadius: 9, border: 'none', backgroundColor: localPromptShowInMenu ? localPromptColor : '#444', position: 'relative', cursor: 'pointer', padding: 0 }}
                >
                  <span style={{ width: 13, height: 13, borderRadius: '50%', backgroundColor: '#fff', position: 'absolute', top: 2, left: localPromptShowInMenu ? 15 : 2, transition: 'left 0.2s' }} />
                </button>
              </label>
            </div>

            <VRField label="Промпт">
              <textarea
                value={localPromptContent}
                onChange={(e) => setLocalPromptContent(e.target.value)}
                onBlur={() => saveCurrentAIPrompt('content')}
                placeholder="Содержимое промпта..."
                rows={16}
                style={{ ...vrFieldStyle, minHeight: 320, height: 'auto', resize: 'vertical', fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12.5, lineHeight: 1.5, borderColor: savedFlashField === 'content' ? VR_GREEN : VR_BORDER }}
              />
            </VRField>

            <VRSection title="Файлы в конце промпта" onAdd={pickFile} addLabel="Finder">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {localPromptFilePaths.map((fp, idx) => (
                  <div key={`${fp}-${idx}`} style={{ display: 'flex', alignItems: 'center', gap: 7, border: `1px solid ${VR_BORDER}`, background: VR_FIELD, borderRadius: 7, padding: '6px 8px' }}>
                    <VRFileIcon />
                    <span title={fp} style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', direction: 'rtl', textAlign: 'left', color: '#bdbdc2', fontSize: 11.5 }}>{fp}</span>
                    <VRIconBtn
                      title="Убрать файл"
                      danger
                      small
                      onClick={() => {
                        const updated = localPromptFilePaths.filter((_, i) => i !== idx);
                        setLocalPromptFilePaths(updated);
                        saveField({ filePaths: updated });
                      }}
                    >
                      <VRXIcon />
                    </VRIconBtn>
                  </div>
                ))}
                {filePathInputs.map((input, idx) => (
                  <div key={`ai-input-${idx}`} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                    <input
                      type="text"
                      autoFocus
                      value={input.value}
                      onChange={(e) => {
                        const updated = [...filePathInputs];
                        updated[idx] = { value: e.target.value, valid: null };
                        setFilePathInputs(updated);
                      }}
                      onBlur={() => commitManualPath(idx)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitManualPath(idx);
                        if (e.key === 'Escape') setFilePathInputs(prev => prev.filter((_, i) => i !== idx));
                      }}
                      placeholder="/Users/..."
                      style={{ ...vrFieldStyle, flex: 1, borderColor: input.valid === false ? VR_RED : VR_BORDER, fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11.5 }}
                    />
                    <VRIconBtn title="Убрать строку" danger small onClick={() => setFilePathInputs(prev => prev.filter((_, i) => i !== idx))}>
                      <VRXIcon />
                    </VRIconBtn>
                  </div>
                ))}
                <div>
                  <button onClick={() => setFilePathInputs(prev => [...prev, { value: '', valid: null }])} style={vrSmallBtnStyle('neutral')}>
                    <VRPlusIcon small /> путь
                  </button>
                </div>
              </div>
            </VRSection>

            {!editingAIPrompt.isBuiltIn && (
              <button onClick={() => { deleteAIPrompt(editingAIPrompt.id); setEditingPromptId(null); showToast('Deleted', 'success'); }} style={{ alignSelf: 'flex-start', padding: 0, background: 'transparent', border: 'none', color: '#ff6b6b', fontSize: 12, fontWeight: 650, cursor: 'pointer' }}>
                Удалить промпт
              </button>
            )}
          </div>
        </div>
      );
    };

    return (
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(260px, 34%) minmax(420px, 1fr)', gap: 12, height: '100%', minHeight: 0 }}>
        <div style={{ minHeight: 0, display: 'flex', flexDirection: 'column', background: '#17171a', border: `1px solid ${VR_BORDER}`, borderRadius: 10, overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 10px', borderBottom: `1px solid ${VR_BORDER}` }}>
            <span style={{ fontSize: 11, fontWeight: 750, letterSpacing: 0.4, color: VR_DIM, textTransform: 'uppercase' }}>Системные промпты</span>
            <VRTag>{aiPrompts.length}</VRTag>
            <div style={{ flex: 1 }} />
            <button onClick={addAIPrompt} style={vrSmallBtnStyle('accent')}><VRPlusIcon small /> Промпт</button>
          </div>

          <div
            ref={(node) => restoreSettingsScrollPosition('ai:system:list', node)}
            onScroll={(event) => rememberSettingsScrollPosition('ai:system:list', event.currentTarget.scrollTop)}
            data-settings-scroll-key="ai:system:list"
            style={{ padding: 8, overflowY: 'auto', minHeight: 0, flex: 1 }}
          >
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
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    marginBottom: 6,
                    padding: '8px 9px',
                    borderRadius: 8,
                    background: isSelected ? '#24242a' : VR_CARD,
                    border: `1px solid ${isSelected ? displayColor : VR_BORDER}`,
                    cursor: 'pointer',
                    minWidth: 0,
                    transition: 'background 110ms ease, border-color 110ms ease',
                  }}
                >
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: displayColor, flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0, color: isSelected ? '#bfdbfe' : VR_TEXT, fontWeight: 620, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayName}</div>
                  <VRTag accent={displayModel.includes('pro')}>{displayModel.includes('pro') ? 'PRO' : 'FLASH'}</VRTag>
                  {displayThinking !== 'HIGH' && <VRTag>{displayThinking}</VRTag>}
                  {displayMenu && <VRTag>ПКМ</VRTag>}
                </div>
              );
            })}

            <div style={{ padding: '10px', background: VR_CARD, border: `1px solid ${VR_BORDER}`, borderRadius: 8, margin: '10px 0' }}>
              <div style={{ fontSize: 11, color: VR_DIM, marginBottom: 6 }}>Промпт для "Откатиться":</div>
              <select
                value={rewindPromptId}
                onChange={(e) => setRewindPromptId(e.target.value)}
                style={{ ...vrFieldStyle, height: 32, cursor: 'pointer' }}
              >
                {aiPrompts.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>

            <div style={{ borderTop: `1px solid ${VR_BORDER}`, margin: '14px 0 10px', position: 'relative' }}>
              <span style={{ position: 'absolute', top: '-8px', left: 10, backgroundColor: '#17171a', padding: '0 8px', fontSize: 10, color: '#666', textTransform: 'uppercase' }}>Встроенные</span>
            </div>

            <div
              ref={claudeEditRef}
              onClick={() => !editingClaude && setEditingClaude(true)}
              style={{ padding: 10, background: editingClaude ? '#24242a' : VR_CARD, border: `1px solid ${editingClaude ? '#DA7756' : VR_BORDER}`, borderRadius: 8, cursor: editingClaude ? 'default' : 'pointer', marginBottom: 7, opacity: editingClaude || claudeDefaultPromptEnabled ? 1 : 0.6 }}
            >
              {editingClaude ? (
                <textarea value={claudeDefaultPrompt} onChange={(e) => setClaudeDefaultPrompt(e.target.value)} onBlur={handleClaudeBlur} placeholder="Стартовый промпт Claude..." rows={4} autoFocus style={{ ...vrFieldStyle, height: 'auto', minHeight: 110, resize: 'vertical', fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12 }} />
              ) : (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                    <div style={{ fontSize: 13, color: '#DA7756', fontWeight: 650 }}>Claude Default</div>
                    <button onClick={(e) => { e.stopPropagation(); setClaudeDefaultPromptEnabled(!claudeDefaultPromptEnabled); }} style={{ width: 32, height: 18, borderRadius: 9, border: 'none', backgroundColor: claudeDefaultPromptEnabled ? '#DA7756' : '#444', position: 'relative', cursor: 'pointer', padding: 0, flexShrink: 0 }}>
                      <span style={{ width: 14, height: 14, borderRadius: '50%', backgroundColor: '#fff', position: 'absolute', top: 2, left: claudeDefaultPromptEnabled ? 16 : 2, transition: 'left 0.2s' }} />
                    </button>
                  </div>
                  <div style={{ fontSize: 11, color: claudeDefaultPromptEnabled ? VR_DIM : '#555', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', opacity: claudeDefaultPromptEnabled ? 1 : 0.5 }}>
                    {claudeDefaultPrompt || 'Не задан'}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        <div style={{ minHeight: 0, background: '#17171a', border: `1px solid ${VR_BORDER}`, borderRadius: 10, overflow: 'hidden' }}>
          {renderAIPromptEditor()}
        </div>

      </div>
    );
  };

  // Close on Escape or Cmd+,
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return;
      if (e.key === 'Escape' || (e.metaKey && e.code === 'Comma')) {
        e.preventDefault();
        closeSettings();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [closeSettings, isOpen]);

  const replaceEffortId = (efforts: readonly string[] | undefined, from: string, to: string) => (
    Array.from(new Set((efforts || []).map((effort) => (effort === from ? to : effort))))
  );

  const commitClaudeCodeModel = (index: number, patch: Partial<ClaudeCodeModelOption>) => {
    const current = claudeCodeSettings.models[index];
    if (!current) return;
    if (patch.id !== undefined) {
      const id = patch.id.trim();
      if (!id || claudeCodeSettings.models.some((model, candidateIndex) => candidateIndex !== index && model.id === id)) return;
      patch = { ...patch, id };
    }
    const models = claudeCodeSettings.models.map((m, i) => (i === index ? { ...m, ...patch } : m));
    setClaudeCodeSettings({ ...claudeCodeSettings, models });
  };

  const setClaudeCodeModelEffort = (index: number, effort: string, selected: boolean) => {
    const model = claudeCodeSettings.models[index];
    if (!model) return;
    const selectedEfforts = new Set(model.efforts || []);
    const supportedEfforts = new Set(claudeSupportedEffortsForModel(model));
    if (selected) {
      selectedEfforts.add(effort);
      // Built-in incompatibilities (such as Haiku max) are never rendered as
      // checkbox choices. A user-added catalog value is intentionally opt-in.
      supportedEfforts.add(effort);
    } else {
      selectedEfforts.delete(effort);
    }
    const catalogIds = claudeEffortOptions.map((option) => option.id);
    const efforts = catalogIds.filter((id) => supportedEfforts.has(id) && selectedEfforts.has(id));
    if (efforts.length === 0) return;
    commitClaudeCodeModel(index, {
      efforts,
      supportedEfforts: catalogIds.filter((id) => supportedEfforts.has(id)),
    });
  };

  const commitClaudeEffort = (key: string, patch: Partial<ClaudeEffortOption>) => {
    const current = claudeEffortOptions.find((option) => option.key === key);
    if (!current) return;
    const nextId = patch.id === undefined ? current.id : patch.id.trim();
    if (!nextId) {
      showToast('У effort должно быть значение команды', 'warning');
      return;
    }
    if (nextId !== current.id && claudeEffortOptions.some((option) => option.key !== key && option.id === nextId)) {
      showToast('Такое значение effort уже есть у Claude Code', 'warning');
      return;
    }
    const effortOptions = claudeEffortOptions.map((option) => (
      option.key === key
        ? { ...option, ...patch, id: nextId, label: patch.label === undefined ? option.label : patch.label.trim() || nextId }
        : option
    ));
    const renamed = nextId !== current.id;
    const models = renamed
      ? claudeCodeSettings.models.map((model) => ({
        ...model,
        efforts: replaceEffortId(model.efforts, current.id, nextId),
        supportedEfforts: replaceEffortId(model.supportedEfforts, current.id, nextId),
      }))
      : claudeCodeSettings.models;
    const quickEffort = renamed && claudeCodeSettings.quickEffort === current.id
      ? nextId
      : claudeCodeSettings.quickEffort;
    setClaudeCodeSettings({ ...claudeCodeSettings, effortOptions, models, quickEffort });
    if (renamed && defaultClaudeEffort === current.id) setDefaultClaudeEffort(nextId);
  };

  const addClaudeEffort = () => {
    const serial = claudeEffortOptions.length + 1;
    let id = `custom-claude-effort-${serial}`;
    while (claudeEffortOptions.some((option) => option.id === id)) {
      id = `custom-claude-effort-${Date.now().toString(36)}-${serial}`;
    }
    setClaudeCodeSettings({
      ...claudeCodeSettings,
      effortOptions: [...claudeEffortOptions, {
        key: `custom:${Date.now().toString(36)}:${serial}`,
        id,
        label: 'Новый effort',
      }],
    });
  };

  const deleteClaudeEffort = (key: string) => {
    const target = claudeEffortOptions.find((option) => option.key === key);
    if (!target) return;
    const lastSelectedFor = claudeCodeSettings.models.find((model) => (
      (model.efforts || []).includes(target.id)
      && (model.efforts || []).filter((effort) => effort !== target.id).length === 0
    ));
    if (lastSelectedFor) {
      showToast(`Нельзя удалить ${target.label}: у ${lastSelectedFor.label} должен остаться хотя бы один effort`, 'warning');
      return;
    }
    const effortOptions = claudeEffortOptions.filter((option) => option.key !== key);
    const models = claudeCodeSettings.models.map((model) => ({
      ...model,
      efforts: (model.efforts || []).filter((effort) => effort !== target.id),
      supportedEfforts: (model.supportedEfforts || []).filter((effort) => effort !== target.id),
    }));
    setClaudeCodeSettings({
      ...claudeCodeSettings,
      effortOptions,
      models,
      quickEffort: claudeCodeSettings.quickEffort === target.id ? null : claudeCodeSettings.quickEffort,
    });
  };

  const addClaudeCodeModel = () => {
    const serial = claudeCodeSettings.models.length + 1;
    let id = `custom-claude-${serial}`;
    while (claudeCodeSettings.models.some((model) => model.id === id)) {
      id = `custom-claude-${Date.now().toString(36)}-${serial}`;
    }
    const supportedEfforts = claudeEffortOptions.map((option) => option.id);
    setClaudeCodeSettings({
      ...claudeCodeSettings,
      models: [...claudeCodeSettings.models, {
        key: `custom:${Date.now().toString(36)}:${serial}`,
        id,
        label: 'Новая модель',
        efforts: supportedEfforts,
        supportedEfforts,
        visible: true,
        cmd: true,
      }],
      deletedModelKeys: claudeCodeSettings.deletedModelKeys?.filter((key) => key !== id) || [],
    });
  };

  const deleteClaudeCodeModel = (index: number) => {
    const target = claudeCodeSettings.models[index];
    if (!target) return;
    const key = target.key || `custom:${target.id}`;
    const deletedModelKeys = Array.from(new Set([
      ...(claudeCodeSettings.deletedModelKeys || []),
      key,
    ]));
    setClaudeCodeSettings({
      ...claudeCodeSettings,
      models: claudeCodeSettings.models.filter((_, candidateIndex) => candidateIndex !== index),
      deletedModelKeys,
    });
  };

  const setClaudeQuickModel = (modelId: string) => {
    const quickModel = modelId || null;
    const quickEffort = quickModel
      ? resolveClaudeEffortForModel(claudeCodeSettings.models.find((model) => model.id === quickModel), claudeCodeSettings.quickEffort)
      : null;
    setClaudeCodeSettings({ ...claudeCodeSettings, quickModel, quickEffort });
  };

  const setClaudeQuickEffort = (effort: string) => {
    if (!quickClaudeModel) return;
    const quickEffort = resolveClaudeEffortForModel(quickClaudeModel, effort);
    setClaudeCodeSettings({ ...claudeCodeSettings, quickEffort });
  };

  const commitCodexModel = (modelId: string, patch: {
    id?: string;
    label?: string;
    efforts?: string[];
    supportedEfforts?: string[];
    visible?: boolean;
  }) => {
    const current = codexModelsForSettings.find((model) => model.id === modelId);
    if (!current) return;
    const nextId = patch.id === undefined ? modelId : patch.id.trim();
    if (!nextId || (nextId !== modelId && codexModelsForSettings.some((model) => model.id === nextId))) return;
    const models = codexModelsForSettings.map((model) => {
      if (model.id !== modelId) return model;
      if (patch.efforts === undefined && patch.supportedEfforts === undefined) return { ...model, ...patch, id: nextId };
      const supportedEfforts = (patch.supportedEfforts || codexSupportedEffortsForModel(model))
        .filter((effort, index, efforts) => (
          codexEffortOptions.some((option) => option.id === effort)
          && efforts.indexOf(effort) === index
        ));
      const requestedEfforts = patch.efforts || model.efforts || [];
      const efforts = supportedEfforts.filter((effort) => requestedEfforts.includes(effort));
      const defaultEffort = efforts.includes(model.defaultEffort || '')
        ? model.defaultEffort
        : (efforts[0] || model.defaultEffort);
      return { ...model, ...patch, id: nextId, efforts, defaultEffort };
    });
    const removedModelIds = new Set(codexSettings.removedModelIds || []);
    if (nextId !== modelId) {
      removedModelIds.add(modelId);
      removedModelIds.delete(nextId);
    }
    const requestedQuickModel = codexSettings.quickModel === modelId ? nextId : codexSettings.quickModel;
    const quickModel = models.some((model) => model.id === requestedQuickModel)
      ? requestedQuickModel
      : null;
    const quickEffort = quickModel
      ? resolveCodexPersistentEffortForModel(models.find((model) => model.id === quickModel), codexSettings.quickEffort)
      : null;
    if (nextId !== modelId && defaultCodexModel === modelId) setDefaultCodexModel(nextId);
    setCodexSettings({ ...codexSettings, models, quickModel, quickEffort, removedModelIds: Array.from(removedModelIds) });
  };

  const setCodexModelEffort = (modelId: string, effort: string, selected: boolean) => {
    const model = codexModelsForSettings.find((candidate) => candidate.id === modelId);
    if (!model) return;
    const selectedEfforts = new Set(model.efforts || []);
    const supportedEfforts = new Set(codexSupportedEffortsForModel(model));
    if (selected) {
      selectedEfforts.add(effort);
      if (!knownCodexModelIds.has(model.id)) supportedEfforts.add(effort);
    } else {
      selectedEfforts.delete(effort);
    }
    const catalogIds = codexEffortOptions.map((option) => option.id);
    const efforts = catalogIds.filter((id) => supportedEfforts.has(id) && selectedEfforts.has(id));
    if (efforts.length === 0) return;
    commitCodexModel(modelId, {
      efforts,
      supportedEfforts: catalogIds.filter((id) => supportedEfforts.has(id)),
    });
  };

  const commitCodexEffort = (key: string, patch: Partial<CodexEffortOption>) => {
    const current = codexEffortOptions.find((option) => option.key === key);
    if (!current) return;
    const nextId = patch.id === undefined ? current.id : patch.id.trim();
    if (!nextId) {
      showToast('У effort должно быть значение команды', 'warning');
      return;
    }
    if (nextId !== current.id && codexEffortOptions.some((option) => option.key !== key && option.id === nextId)) {
      showToast('Такое значение effort уже есть у Codex', 'warning');
      return;
    }
    const effortOptions = codexEffortOptions.map((option) => (
      option.key === key
        ? { ...option, ...patch, id: nextId, label: patch.label === undefined ? option.label : patch.label.trim() || nextId }
        : option
    ));
    const renamed = nextId !== current.id;
    const models = renamed
      ? codexModelsForSettings.map((model) => ({
        ...model,
        efforts: replaceEffortId(model.efforts, current.id, nextId),
        supportedEfforts: replaceEffortId(model.supportedEfforts, current.id, nextId),
      }))
      : codexModelsForSettings;
    const quickEffort = renamed && codexSettings.quickEffort === current.id
      ? nextId
      : codexSettings.quickEffort;
    setCodexSettings({ ...codexSettings, effortOptions, models, quickEffort });
    if (renamed && defaultCodexEffort === current.id) setDefaultCodexEffort(nextId);
  };

  const addCodexEffort = () => {
    const serial = codexEffortOptions.length + 1;
    let id = `custom-codex-effort-${serial}`;
    while (codexEffortOptions.some((option) => option.id === id)) {
      id = `custom-codex-effort-${Date.now().toString(36)}-${serial}`;
    }
    setCodexSettings({
      ...codexSettings,
      effortOptions: [...codexEffortOptions, {
        key: `custom:${Date.now().toString(36)}:${serial}`,
        id,
        label: 'Новый effort',
      }],
    });
  };

  const deleteCodexEffort = (key: string) => {
    const target = codexEffortOptions.find((option) => option.key === key);
    if (!target) return;
    const lastSelectedFor = codexModelsForSettings.find((model) => (
      (model.efforts || []).includes(target.id)
      && (model.efforts || []).filter((effort) => effort !== target.id).length === 0
    ));
    if (lastSelectedFor) {
      showToast(`Нельзя удалить ${target.label}: у ${lastSelectedFor.label} должен остаться хотя бы один effort`, 'warning');
      return;
    }
    const effortOptions = codexEffortOptions.filter((option) => option.key !== key);
    const models = codexModelsForSettings.map((model) => ({
      ...model,
      efforts: (model.efforts || []).filter((effort) => effort !== target.id),
      supportedEfforts: (model.supportedEfforts || []).filter((effort) => effort !== target.id),
    }));
    setCodexSettings({
      ...codexSettings,
      effortOptions,
      models,
      quickEffort: codexSettings.quickEffort === target.id ? null : codexSettings.quickEffort,
    });
  };

  const addCodexModel = () => {
    const serial = codexModelsForSettings.length + 1;
    let id = `custom-codex-${serial}`;
    while (codexModelsForSettings.some((model) => model.id === id)) {
      id = `custom-codex-${Date.now().toString(36)}-${serial}`;
    }
    const supportedEfforts = codexEffortOptions.map((option) => option.id);
    setCodexSettings({
      ...codexSettings,
      models: [...codexModelsForSettings, {
        id,
        label: 'Новая модель',
        defaultEffort: supportedEfforts.includes('medium') ? 'medium' : supportedEfforts[0],
        efforts: supportedEfforts,
        supportedEfforts,
        visible: true,
      }],
      removedModelIds: codexSettings.removedModelIds?.filter((modelId) => modelId !== id) || [],
    });
  };

  const deleteCodexModel = (modelId: string) => {
    const removedModelIds = Array.from(new Set([
      ...(codexSettings.removedModelIds || []),
      modelId,
    ]));
    const quickModel = codexSettings.quickModel === modelId ? null : codexSettings.quickModel;
    setCodexSettings({
      ...codexSettings,
      models: codexSettings.models.filter((model) => model.id !== modelId),
      removedModelIds,
      quickModel,
      quickEffort: quickModel ? codexSettings.quickEffort : null,
    });
  };

  const setCodexQuickModel = (modelId: string) => {
    const quickModel = modelId || null;
    const quickEffort = quickModel
      ? resolveCodexPersistentEffortForModel(codexModelsForSettings.find((model) => model.id === quickModel), codexSettings.quickEffort)
      : null;
    setCodexSettings({ ...codexSettings, models: codexModelsForSettings, quickModel, quickEffort });
  };

  const setSettingsDefaultCodexModel = (modelId: string) => {
    const nextModelId = modelId || 'none';
    setDefaultCodexModel(nextModelId);
    if (nextModelId === 'none') return;
    const nextModel = codexModelsForSettings.find((model) => model.id === nextModelId);
    const nextEffort = resolveCodexPersistentEffortForModel(nextModel, defaultCodexEffort);
    if (nextEffort && nextEffort !== defaultCodexEffort) setDefaultCodexEffort(nextEffort);
  };

  const setCodexQuickEffort = (effort: string) => {
    if (!quickCodexModel) return;
    const quickEffort = resolveCodexPersistentEffortForModel(quickCodexModel, effort);
    setCodexSettings({ ...codexSettings, models: codexModelsForSettings, quickEffort });
  };

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
        zIndex: 20000
      }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) (e.currentTarget as HTMLElement).dataset.mouseDownOnOverlay = 'true'; }}
      onClick={(e) => { if (e.target === e.currentTarget && (e.currentTarget as HTMLElement).dataset.mouseDownOnOverlay === 'true') closeSettings(); (e.currentTarget as HTMLElement).dataset.mouseDownOnOverlay = ''; }}
    >
      <div
        style={{
          backgroundColor: '#1a1a1a',
          borderRadius: '16px',
          border: '1px solid #333',
          // Settings → Размеры сгруппированы по видимым областям приложения.
          // 900px тесно. Цель — занять до 1200px, но не вылезать из viewport на маленьких окнах
          // приложения. `min(1200px, 95vw)` даёт +33% на широких экранах, корректно сжимается.
          width: 'min(1200px, 95vw)',
          height: '85vh',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column'
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
          <ControlHint label="Закрыть настройки" side="left">
            <button
              onClick={closeSettings}
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
          </ControlHint>
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
            { id: 'fonts', label: 'Размеры' },
            { id: 'colors', label: 'Системные' },
            { id: 'shortcuts', label: 'Горячие клавиши' },
            { id: 'projects', label: 'Проекты' }
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
        <div
          ref={contentScrollRef}
          data-settings-scroll-key={`tab:${activeTab}`}
          onScroll={(event) => rememberSettingsScrollPosition(
            `tab:${activeTab}`,
            event.currentTarget.scrollTop,
          )}
          style={{ padding: '20px 24px', overflowY: 'auto', flex: 1 }}
        >
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

          {activeTab === 'projects' && (
            <ProjectIconsSettings />
          )}

          {activeTab === 'fonts' && (
            <>
              {/* SettingsTree pattern:
                  - Главные uppercase-заголовки идут плоско.
                  - Sub-секции через padding-left 16px + border-left + ╰ префикс.
                  - Все строки настроек — единый FontSizeSlider компонент в 4-col grid.
                  Цель — одна стилистика на весь tab, юзер не различает «у этого блока
                  свой фон, у другого свой». Card-wrapper'ы (свой background+border вокруг
                  блока) убраны для всех секций. */}

              {/* SettingsTree pattern: главные секции (Вкладки / AI-интерфейс /
                  Терминал / Файловый сайдбар / Меню промптов) — каждая отдельная
                  видимая область интерфейса.
                  Внутри каждой секции собраны ВСЕ её настройки: padding/радиус/шрифт/
                  поведение. Глобальный пункт «Шрифты интерфейса» убран — он сводил
                  все шрифты в одну кучу без привязки к области, юзер не мог понять
                  к какой поверхности относится настройка. */}

              {/* 1. ВКЛАДКИ */}
              <SettingsSectionHeader title="Вкладки" first />
              <SettingsSubSectionHeader title="Рабочие вкладки" />
              <SettingsGrid4>
                <PaddingRow
                  valueX={tabGeometry.paddingX} onChangeX={(v) => setTabGeometry({ paddingX: v })}
                  valueY={tabGeometry.paddingY} onChangeY={(v) => setTabGeometry({ paddingY: v })}
                  maxX={32} maxY={24}
                />
                <FontSizeSlider label="Левый отступ" value={tabGeometry.paddingLeft} onChange={(v) => setTabGeometry({ paddingLeft: v })} min={4} max={48} />
                <FontSizeSlider label="Радиус" value={tabGeometry.borderRadius} onChange={(v) => setTabGeometry({ borderRadius: v })} min={0} max={20} />
                <FontSizeSlider label="Зазор" value={tabGeometry.gap} onChange={(v) => setTabGeometry({ gap: v })} min={0} max={16} />
                <FontSizeSlider label="Шрифт" value={tabsFontSize} onChange={setTabsFontSize} min={10} max={20} />
              </SettingsGrid4>

              <SettingsSubSectionHeader title="Проекты" />
              <SettingsGrid4>
                <PaddingRow
                  valueX={projectTabGeometry.paddingX} onChangeX={(v) => setProjectTabGeometry({ paddingX: v })}
                  valueY={projectTabGeometry.paddingY} onChangeY={(v) => setProjectTabGeometry({ paddingY: v })}
                  maxX={32} maxY={16}
                />
                <FontSizeSlider label="Шрифт" value={projectTabsFontSize} onChange={setProjectTabsFontSize} min={10} max={16} />
              </SettingsGrid4>

              <SettingsSubSectionHeader title="Статусы" />
              <SessionStatusesEditor />

              <SettingsSubSectionHeader title="Полоска процесса" />
              <ProcessBarEditor />

              <SettingsSubSectionHeader title="Уведомления вкладки" />
              <div style={{ paddingLeft: '12px' }}>
                <LineNumbersToggle
                  checked={tabCompletionNotificationSound}
                  onChange={setTabCompletionNotificationSound}
                  label="Системный звук"
                  description="Проигрывать звук при завершении вкладки с активированным уведомлением"
                  tooltip="Включает одноразовый системный звук при срабатывании уведомления вкладки."
                />
              </div>

              {/* 2. AI-ИНТЕРФЕЙС — новая primary History surface. */}
              <SettingsSectionHeader title="AI-интерфейс" />
              <SettingsSubSectionHeader title="История" />
              <SettingsGrid4>
                <FontSizeSlider label="Шрифт сообщений" description="Основной текст и вызовы инструментов в History" value={historyFontSize} onChange={setHistoryFontSize} min={8} max={24} />
                <FontSizeSlider label="Шрифт вторичных элементов" description="Подписи, статусы и чипы AI-интерфейса" value={aiSecondaryFontSize} onChange={setAiSecondaryFontSize} min={8} max={18} />
                <FontSizeSlider label="Строк в код-блоке" description="После этого предела появляется вертикальная прокрутка; длинные строки переносятся" value={historyMarkdownCodeMaxLines} onChange={setHistoryMarkdownCodeMaxLines} min={5} max={100} suffix="" />
              </SettingsGrid4>

              <SettingsSubSectionHeader title="Поле ввода" />
              <SettingsGrid4>
                <FontSizeSlider label="Шрифт" description="Размер набираемого текста" value={historyComposerFontSize} onChange={setHistoryComposerFontSize} min={8} max={24} />
                <FontSizeSlider label="Строк при пустом поле" description="Начальная высота input без текста" value={historyComposerMinRows} onChange={setHistoryComposerMinRows} min={1} max={historyComposerMaxRows} suffix="" />
                <FontSizeSlider label="Максимум строк" description="После этого предела текст прокручивается внутри input" value={historyComposerMaxRows} onChange={setHistoryComposerMaxRows} min={historyComposerMinRows} max={40} suffix="" />
                <FontSizeSlider label="Максимум строк в разделённой панели" description="Панель, разделённая по горизонтали, вдвое ниже: там input начинается с одной строки и растёт до этого предела" value={stackedComposerMaxRows} onChange={setStackedComposerMaxRows} min={1} max={20} suffix="" />
                <FontSizeSlider
                  label="Чип после N символов"
                  description="Длинная ручная вставка; сохранённый prompt всегда становится чипом"
                  value={aiComposerChipThreshold}
                  onChange={setAiComposerChipThreshold}
                  min={100}
                  max={100000}
                  suffix=""
                />
              </SettingsGrid4>

              <SettingsSubSectionHeader title="Таймлайн" />
              <SettingsGrid4>
                <FontSizeSlider label="Шрифт" value={timelineFontSize} onChange={setTimelineFontSize} min={10} max={18} />
                <FontSizeSlider label="Шрифт пересказа" value={timelineSummaryFontSize} onChange={setTimelineSummaryFontSize} min={10} max={22} />
                <FontSizeSlider label="Строки" value={timelineLineClamp} onChange={setTimelineLineClamp} min={1} max={10} suffix="" />
              </SettingsGrid4>

              <SettingsSubSectionHeader title="Run after" />
              <SettingsGrid4>
                <FontSizeSlider label="Шрифт чипа" description="Размер текста в чипах очереди Run after" value={promptQueueChipFontSize} onChange={setPromptQueueChipFontSize} min={9} max={18} />
                <FontSizeSlider label="Шрифт раскрытый" description="Размер текста в моталке редактирования при клике по чипу" value={promptQueueEditorFontSize} onChange={setPromptQueueEditorFontSize} min={10} max={24} />
                <FontSizeSlider label="Строки в чипе" description="Сколько строк текста промпта показывать в каждом чипе очереди (1 = ellipsis в одну строку)" value={promptQueueChipLineClamp} onChange={setPromptQueueChipLineClamp} min={1} max={10} suffix="" />
              </SettingsGrid4>

              {/* 3. ТЕРМИНАЛ — только raw xterm; legacy SDK font остаётся
                  внутренней совместимостью и больше не показывается в Settings. */}
              <SettingsSectionHeader title="Терминал" />
              <SettingsGrid4>
                <FontSizeSlider label="Шрифт терминала" value={terminalFontSize} onChange={setTerminalFontSize} min={8} max={24} />
              </SettingsGrid4>

              {/* 4. ФАЙЛОВЫЙ САЙДБАР (Cmd+/): шрифт + превью + поведение */}
              <SettingsSectionHeader title="Файловый сайдбар" />
              <SettingsGrid4>
                <FontSizeSlider label="Шрифт" value={sidebarFontSize} onChange={setSidebarFontSize} min={10} max={20} />
              </SettingsGrid4>

              <SettingsSubSectionHeader title="Превью файла" />
              <SettingsGrid4>
                <FontSizeSlider label="Шрифт" value={filePreviewFontSize} onChange={setFilePreviewFontSize} min={10} max={24} />
              </SettingsGrid4>

              <SettingsSubSectionHeader title="Поведение" />
              <SidebarBehaviorToggles />

              {/* 5. МЕНЮ ПРОМПТОВ — Opt+V overlay с быстрыми промптами. */}
              <SettingsSectionHeader title="Меню промптов" />
              <SettingsGrid4>
                <FontSizeSlider label="Шрифт" value={promptPickerFontSize} onChange={setPromptPickerFontSize} min={9} max={20} />
                <FontSizeSlider label="Отступ снизу" description="От низа viewport'а до picker'а" value={promptPickerBottomOffsetPx} onChange={setPromptPickerBottomOffsetPx} min={0} max={400} suffix="px" />
                <FontSizeSlider label="Отступ слева" description="0 — центр или прижатие к правому. >0 — прижатие к левому краю" value={promptPickerLeftOffsetPx} onChange={setPromptPickerLeftOffsetPx} min={0} max={2000} suffix="px" />
                <FontSizeSlider label="Отступ справа" description="0 — центр или прижатие к левому. >0 — приоритет: прижатие к правому краю" value={promptPickerRightOffsetPx} onChange={setPromptPickerRightOffsetPx} min={0} max={2000} suffix="px" />
              </SettingsGrid4>

            </>
          )}

          {activeTab === 'colors' && (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {/* Зеркала CLAUDE.md — auto-mirror одного исходного файла в AGENTS.md/GEMINI.md
                  в корне активного проекта. Watcher в main всегда жив (статус-инфо
                  должна быть свежей при открытии Settings), а сами writes делает только
                  когда тогл ON. Источник истины — CLAUDE.md; mirror'ы перезатираются
                  при любой ручной правке. */}
              <ClaudeMdMirrorBlock
                enabled={claudeMdMirrorEnabled}
                onToggle={setClaudeMdMirrorEnabled}
                status={mirrorStatus}
                activeProjectId={activeProjectId}
              />

              {/* Память под разобранные истории (главный процесс). Вынесено в
                  настройки, потому что правильное значение зависит от машины:
                  на 16GB запас в 400MB щедрый, на 64GB — можно втрое больше и
                  держать тёплыми десятки вкладок. Применяется при старте —
                  подпись об этом обязательна, иначе юзер решит, что настройка
                  не работает. */}
              <div data-settings-section="history-memory" style={{ padding: '14px', backgroundColor: '#222', border: '1px solid #333', borderRadius: '10px', marginBottom: '12px' }}>
                <div style={{ fontSize: '11px', fontWeight: '600', color: '#666', textTransform: 'uppercase', marginBottom: '10px' }}>
                  Память истории
                </div>
                <SettingsGrid4>
                  <FontSizeSlider
                    label="Кэш разобранных сессий"
                    description="Больше — реже полная перезагрузка при возврате на вкладку"
                    value={historyProjectorBudgetMb}
                    onChange={setHistoryProjectorBudgetMb}
                    min={64}
                    max={2048}
                    suffix=" МБ"
                  />
                  <FontSizeSlider
                    label="Параллельное восстановление"
                    description="Сколько Claude/Codex одновременно прогреваются после запуска приложения"
                    value={interruptedAutoRestoreParallelism}
                    onChange={setInterruptedAutoRestoreParallelism}
                    min={1}
                    max={3}
                    suffix=""
                  />
                </SettingsGrid4>
                <div style={{ fontSize: '10px', color: '#8a6d3b', marginTop: '8px', lineHeight: 1.5 }}>
                  Настройки применятся после перезапуска приложения.
                  {' '}Сессия занимает примерно 10–30 МБ; при нехватке бюджета самая
                  давняя выгружается и её история читается заново.
                </div>
              </div>

              <div
                data-settings-section="model-settings"
                style={{ order: -1, padding: '14px', backgroundColor: '#222', border: '1px solid #333', borderRadius: '10px', marginBottom: '12px' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: modelSettingsExpanded ? '10px' : 0 }}>
                  <button
                    type="button"
                    data-settings-models-toggle
                    aria-expanded={modelSettingsExpanded}
                    onClick={toggleModelSettings}
                    style={{
                      minWidth: 0,
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 7,
                      padding: 0,
                      border: 0,
                      background: 'transparent',
                      color: '#777',
                      cursor: 'pointer',
                    }}
                  >
                    {modelSettingsExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    <span style={{ fontSize: '11px', fontWeight: '600', color: '#777', textTransform: 'uppercase' }}>
                      Настройки моделей
                    </span>
                    {!modelSettingsExpanded && (
                      <span style={{ fontSize: 10, color: '#555', textTransform: 'none' }}>
                        Claude Code · Codex
                      </span>
                    )}
                  </button>
                  {modelSettingsExpanded && <div style={{ display: 'flex', gap: 6 }}>
                    <button
                      type="button"
                      onClick={() => setClaudeCodeSettings(DEFAULT_CLAUDE_CODE_SETTINGS)}
                      style={{ ...vrSmallBtnStyle('neutral'), height: 24, padding: '0 8px' }}
                    >
                      reset Claude
                    </button>
                    <button
                      type="button"
                      onClick={() => setCodexSettings(DEFAULT_CODEX_SETTINGS)}
                      style={{ ...vrSmallBtnStyle('neutral'), height: 24, padding: '0 8px' }}
                    >
                      reset Codex
                    </button>
                  </div>}
                </div>

                {modelSettingsExpanded && (
                <div data-settings-models-content style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 14, alignItems: 'start' }}>
                  <div style={{ minWidth: 0 }}>
                    <ModelSettingsColumnHeader title="Claude Code" accent="#DA7756" onAdd={addClaudeCodeModel} />
                    <div style={{ display: 'grid', gap: 1 }}>
                      {claudeCodeSettings.models.map((model, index) => (
                        <ModelSettingsTreeRow
                          key={model.key || `${index}-${model.id}`}
                          accent="#DA7756"
                          model={model}
                          effortOptions={claudeEffortOptionsForModel(model)}
                          onVisibleChange={(visible) => commitClaudeCodeModel(index, { visible })}
                          onLabelCommit={(label) => commitClaudeCodeModel(index, { label })}
                          onCommandCommit={(id) => commitClaudeCodeModel(index, { id })}
                          onEffortChange={(effort, selected) => setClaudeCodeModelEffort(index, effort, selected)}
                          onDelete={() => deleteClaudeCodeModel(index)}
                        />
                      ))}
                    </div>
                    <div style={{ marginTop: 7 }}>
                      <ModelSettingsColumnHeader
                        title="Effort"
                        accent="#DA7756"
                        onAdd={addClaudeEffort}
                        addTitle="Добавить effort для Claude Code"
                      />
                      <div style={{ display: 'grid', gap: 1 }}>
                        {claudeEffortOptions.map((option) => (
                          <EffortSettingsTreeRow
                            key={option.key}
                            option={option}
                            provider="Claude Code"
                            onLabelCommit={(label) => commitClaudeEffort(option.key, { label })}
                            onCommandCommit={(id) => commitClaudeEffort(option.key, { id })}
                            onDelete={() => deleteClaudeEffort(option.key)}
                          />
                        ))}
                      </div>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'auto minmax(130px, 1fr) minmax(82px, 0.55fr)', alignItems: 'center', gap: 6, marginTop: 10 }}>
                      <span
                        style={{ color: '#777', fontSize: 10, whiteSpace: 'nowrap' }}
                        title="Маленькая кнопка слева от Model в живом Claude переключает на эту пару и повторным кликом возвращает прежнюю."
                      >
                        Быстрый переход
                      </span>
                      <select
                        value={claudeCodeSettings.quickModel || ''}
                        onChange={(e) => setClaudeQuickModel(e.currentTarget.value)}
                        style={{ ...vrFieldStyle, height: 28, fontSize: 11, padding: '4px 7px', cursor: 'pointer' }}
                        title="Модель для маленькой кнопки быстрого переключения"
                      >
                        <option value="">не настроен</option>
                        {claudeCodeSettings.models.map((model) => (
                          <option key={model.key || model.id} value={model.id}>{model.label}</option>
                        ))}
                      </select>
                      <select
                        value={claudeCodeSettings.quickEffort || ''}
                        disabled={!quickClaudeModel}
                        onChange={(e) => setClaudeQuickEffort(e.currentTarget.value)}
                        style={{ ...vrFieldStyle, height: 28, fontSize: 11, padding: '4px 7px', cursor: quickClaudeModel ? 'pointer' : 'not-allowed', opacity: quickClaudeModel ? 1 : 0.45 }}
                        title="Уровень усилий для быстрого переключения"
                      >
                        {quickClaudeEfforts.map((effort) => (
                          <option key={effort} value={effort}>{compactEffortLabel(effortLabel(claudeEffortOptions, effort))}</option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div style={{ minWidth: 0 }}>
                    <ModelSettingsColumnHeader title="Codex" accent="#34D399" onAdd={addCodexModel} />
                    <div style={{ display: 'grid', gap: 1 }}>
                      {codexModelsForSettings.map((model) => (
                        <ModelSettingsTreeRow
                          key={model.id}
                          accent="#34D399"
                          model={model}
                          effortOptions={codexEffortOptionsForModel(model)}
                          onVisibleChange={(visible) => commitCodexModel(model.id, { visible })}
                          onLabelCommit={(label) => commitCodexModel(model.id, { label })}
                          onCommandCommit={(id) => commitCodexModel(model.id, { id })}
                          onEffortChange={(effort, selected) => setCodexModelEffort(model.id, effort, selected)}
                          onDelete={() => deleteCodexModel(model.id)}
                        />
                      ))}
                    </div>
                    <div style={{ marginTop: 7 }}>
                      <ModelSettingsColumnHeader
                        title="Effort"
                        accent="#34D399"
                        onAdd={addCodexEffort}
                        addTitle="Добавить effort для Codex"
                      />
                      <div style={{ display: 'grid', gap: 1 }}>
                        {codexEffortOptions.map((option) => (
                          <EffortSettingsTreeRow
                            key={option.key}
                            option={option}
                            provider="Codex"
                            commandReadOnly={codexEffortCommandIsLiveBound(option)}
                            onLabelCommit={(label) => commitCodexEffort(option.key, { label })}
                            onCommandCommit={(id) => commitCodexEffort(option.key, { id })}
                            onDelete={() => deleteCodexEffort(option.key)}
                          />
                        ))}
                      </div>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'auto minmax(130px, 1fr) minmax(82px, 0.55fr)', alignItems: 'center', gap: 6, marginTop: 10 }}>
                      <span
                        style={{ color: '#777', fontSize: 10, whiteSpace: 'nowrap' }}
                        title="Эта пара применяется к каждому новому запуску Codex, если конкретная вкладка или внешний клиент не выбрали свою."
                      >
                        По умолчанию
                      </span>
                      <select
                        value={defaultCodexModel === 'none' ? '' : defaultCodexModel}
                        onChange={(e) => setSettingsDefaultCodexModel(e.currentTarget.value)}
                        style={{ ...vrFieldStyle, height: 28, fontSize: 11, padding: '4px 7px', cursor: 'pointer' }}
                        title="Модель для новых запусков Codex"
                      >
                        <option value="">не задана</option>
                        {codexModelsForSettings.map((model) => (
                          <option key={model.id} value={model.id}>{model.label}</option>
                        ))}
                      </select>
                      <select
                        value={defaultCodexEfforts.includes(defaultCodexEffort) ? defaultCodexEffort : ''}
                        disabled={!selectedDefaultCodexModel}
                        onChange={(e) => setDefaultCodexEffort(e.currentTarget.value || 'none')}
                        style={{ ...vrFieldStyle, height: 28, fontSize: 11, padding: '4px 7px', cursor: selectedDefaultCodexModel ? 'pointer' : 'not-allowed', opacity: selectedDefaultCodexModel ? 1 : 0.45 }}
                        title="Уровень усилий для новых запусков Codex"
                      >
                        <option value="">не задан</option>
                        {defaultCodexEfforts.map((effort) => (
                          <option key={effort} value={effort}>{compactEffortLabel(effortLabel(codexEffortOptions, effort))}</option>
                        ))}
                      </select>
                    </div>
                    <label style={{ display: 'grid', gridTemplateColumns: '1fr auto', alignItems: 'center', gap: 8, marginTop: 10 }}>
                      <span style={{ color: '#888', fontSize: 11 }}>При восстановлении сессии</span>
                      <select
                        data-testid="codex-resume-goal-policy"
                        value={codexResumePausedGoal ? 'resume' : 'paused'}
                        onChange={(e) => setCodexResumePausedGoal(e.currentTarget.value === 'resume')}
                        title="Что автоматически выбрать, если Codex покажет «Resume paused goal?»"
                        style={{ ...vrFieldStyle, height: 28, fontSize: 11, padding: '4px 7px', cursor: 'pointer' }}
                      >
                        <option value="resume">Возобновлять Goal</option>
                        <option value="paused">Оставлять Goal на паузе</option>
                      </select>
                    </label>
                    <div style={{ display: 'grid', gridTemplateColumns: 'auto minmax(130px, 1fr) minmax(82px, 0.55fr)', alignItems: 'center', gap: 6, marginTop: 10 }}>
                      <span
                        style={{ color: '#777', fontSize: 10, whiteSpace: 'nowrap' }}
                        title="Маленькая кнопка слева от Model в живом Codex переключает на эту пару и повторным кликом возвращает прежнюю."
                      >
                        Быстрый переход
                      </span>
                      <select
                        value={codexSettings.quickModel || ''}
                        onChange={(e) => setCodexQuickModel(e.currentTarget.value)}
                        style={{ ...vrFieldStyle, height: 28, fontSize: 11, padding: '4px 7px', cursor: 'pointer' }}
                        title="Модель для маленькой кнопки быстрого переключения"
                      >
                        <option value="">не настроен</option>
                        {codexModelsForSettings.map((model) => (
                          <option key={model.id} value={model.id}>{model.label}</option>
                        ))}
                      </select>
                      <select
                        value={codexSettings.quickEffort || ''}
                        disabled={!quickCodexModel}
                        onChange={(e) => setCodexQuickEffort(e.currentTarget.value)}
                        style={{ ...vrFieldStyle, height: 28, fontSize: 11, padding: '4px 7px', cursor: quickCodexModel ? 'pointer' : 'not-allowed', opacity: quickCodexModel ? 1 : 0.45 }}
                        title="Уровень усилий для быстрого переключения"
                      >
                        {quickCodexEfforts.map((effort) => (
                          <option key={effort} value={effort}>{compactEffortLabel(effortLabel(codexEffortOptions, effort))}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>
                )}
              </div>

              {/* Семантическая индексация — единственная честно «системная» настройка
                  с runtime-эффектом. Управляет parallel параметром MCP docs_reindex.
                  Выше 20 воркеров UI не даёт выставить, чтобы не плодить слишком
                  много одновременных Codex exec процессов; ниже 4 — индексация N=70
                  файлов начинает занимать минуты. Default 10 сохраняет прежний UX.
                  Все визуальные настройки (статусы вкладок, полоска процесса) переехали
                  в «Размеры» — они влияют на UI, а не на админ-инфраструктуру. */}
              <div style={{ padding: '14px', backgroundColor: '#222', border: '1px solid #333', borderRadius: '10px', marginBottom: '12px' }}>
                <div style={{ fontSize: '11px', fontWeight: '600', color: '#666', marginBottom: '10px', textTransform: 'uppercase' }}>
                  Семантическая индексация
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 8, marginBottom: 12 }}>
                  <LineNumbersToggle
                    checked={semanticAutoIndexTitles}
                    onChange={setSemanticAutoIndexTitles}
                    label="Auto Title"
                    description="Автоматически индексировать названия новых закрытых вкладок"
                    tooltip="Работает только для history-записей, созданных после включения."
                  />
                  <LineNumbersToggle
                    checked={semanticAutoIndexIterations}
                    onChange={setSemanticAutoIndexIterations}
                    label="Auto Iterations"
                    description="Автоматически индексировать новые user-итерации после включения"
                    tooltip="Индексирует новые history-записи после закрытия Claude/Codex вкладки; старый архив не догоняет."
                  />
                </div>
                <FontSizeSlider
                  label="Параллельные воркеры"
                  description="Сколько Codex worker'ов одновременно при запуске docs_reindex"
                  value={semanticIndexParallelism}
                  onChange={setSemanticIndexParallelism}
                  min={1}
                  max={20}
                  suffix=""
                />
                <div style={{ fontSize: '11px', color: '#666', marginTop: '8px', lineHeight: 1.5 }}>
                  Применяется к следующему запуску из ProjectToolbar (иконка с числом).
                  Текущий выполняющийся ребилд не прерывается.
                </div>
              </div>

              <div style={{ padding: '14px', backgroundColor: '#222', border: '1px solid #333', borderRadius: '10px', marginBottom: '12px' }}>
                <div style={{ fontSize: '11px', fontWeight: '600', color: '#666', marginBottom: '8px', textTransform: 'uppercase' }}>
                  Режим новых вкладок
                </div>
                <div style={{ fontSize: '12px', color: '#999', lineHeight: 1.5, marginBottom: 12 }}>
                  В каком виде открывается центр новой AI-вкладки: транскрипт (History) или терминал. Уже открытые вкладки не меняются — у каждой свой режим, кнопка Reverse переключает его для конкретной вкладки.
                </div>
                <div style={{ display: 'inline-flex', gap: 3, padding: 3, borderRadius: 8, border: '1px solid #333', background: '#181818' }}>
                  {(['history', 'terminal'] as const).map((surface) => {
                    const active = newTabPrimarySurface === surface;
                    return (
                      <button
                        key={surface}
                        type="button"
                        aria-pressed={active}
                        onClick={() => setNewTabPrimarySurface(surface)}
                        style={{
                          ...vrSmallBtnStyle(active ? 'accent' : 'neutral'),
                          height: 26,
                          minWidth: 78,
                          borderColor: active ? '#3b82f6' : 'transparent',
                          background: active ? 'rgba(59,130,246,0.22)' : 'transparent',
                          color: active ? '#dbeafe' : '#8a8a8f',
                        }}
                      >
                        {surface === 'history' ? 'History' : 'Terminal'}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {activeTab === 'ai' && (
            <div style={{ height: 'calc(85vh - 130px)', minHeight: 0, display: 'flex', flexDirection: 'column', gap: 12, overflow: 'hidden' }}>
              <div style={{ display: 'inline-flex', alignSelf: 'flex-start', background: VR_FIELD, border: `1px solid ${VR_BORDER}`, borderRadius: 9, padding: 3, gap: 3, flexShrink: 0 }}>
                {([
                  { id: 'text' as AISubTab, label: 'Текстовые вставки' },
                  { id: 'system' as AISubTab, label: 'Системные промпты' },
                  { id: 'usage' as AISubTab, label: 'Статистика' },
                ]).map((tab) => (
                  <button
                    key={tab.id}
                    onClick={() => switchAISubTab(tab.id)}
                    style={{
                      height: 28,
                      padding: '0 12px',
                      borderRadius: 7,
                      border: 'none',
                      background: aiSubTab === tab.id ? '#24242a' : 'transparent',
                      color: aiSubTab === tab.id ? VR_TEXT : VR_DIM,
                      fontSize: 12,
                      fontWeight: 650,
                      cursor: 'pointer',
                    }}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
              <div style={{ flex: 1, minHeight: 0 }}>
                {aiSubTab === 'text'
                  ? renderTextInsertEditor()
                  : aiSubTab === 'system'
                    ? renderSystemPrompts()
                    : renderAIUsageStatsPanel()}
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}

const vrFieldStyle: React.CSSProperties = {
  width: '100%',
  minWidth: 0,
  height: 34,
  boxSizing: 'border-box',
  border: `1px solid ${VR_BORDER}`,
  borderRadius: 8,
  background: VR_FIELD,
  color: VR_TEXT,
  outline: 'none',
  padding: '7px 9px',
  fontSize: 12.5,
  fontFamily: 'inherit',
};

function vrSmallBtnStyle(kind: 'accent' | 'neutral'): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    height: 28,
    padding: '0 10px',
    borderRadius: 7,
    border: kind === 'accent' ? 'none' : `1px solid ${VR_BORDER}`,
    background: kind === 'accent' ? VR_ACCENT : VR_FIELD,
    color: kind === 'accent' ? '#fff' : '#c9c9cd',
    fontSize: 11.5,
    fontWeight: 650,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  };
}

function promptTreeContextActionStyle(danger = false): React.CSSProperties {
  return {
    width: '100%',
    height: 34,
    display: 'flex',
    alignItems: 'center',
    gap: 9,
    padding: '0 9px',
    border: 'none',
    borderRadius: 6,
    background: 'transparent',
    color: danger ? '#ff7b7b' : '#dedee2',
    fontSize: 12.5,
    fontWeight: 620,
    cursor: 'pointer',
    textAlign: 'left',
  };
}

function VRTag({ children, accent }: { children: React.ReactNode; accent?: boolean }) {
  return (
    <span style={{
      fontSize: 10,
      fontWeight: 650,
      padding: '2px 6px',
      borderRadius: 6,
      background: accent ? 'rgba(124,58,237,0.16)' : 'rgba(255,255,255,0.06)',
      color: accent ? '#c4b5fd' : VR_DIM,
      whiteSpace: 'nowrap',
    }}>
      {children}
    </span>
  );
}

function VRIconBtn({ children, onClick, title, danger, small }: { children: React.ReactNode; onClick: () => void; title: string; danger?: boolean; small?: boolean }) {
  const [hovered, setHovered] = useState(false);
  const size = small ? 24 : 28;
  return (
    <ControlHint label={title}>
      <button
        title={title}
        onClick={(e) => { e.stopPropagation(); onClick(); }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          width: size,
          height: size,
          borderRadius: 7,
          border: 'none',
          cursor: 'pointer',
          flexShrink: 0,
          background: hovered ? (danger ? 'rgba(255,107,107,0.14)' : 'rgba(255,255,255,0.08)') : 'transparent',
          color: danger ? '#ff6b6b' : VR_DIM,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 0,
        }}
      >
        {children}
      </button>
    </ControlHint>
  );
}

function VREmpty({ text }: { text: string }) {
  return (
    <div style={{ padding: 22, textAlign: 'center', color: VR_DIM, fontSize: 12, border: `1px dashed ${VR_BORDER}`, borderRadius: 10 }}>
      {text}
    </div>
  );
}

function VRSection({ title, onAdd, addLabel, children }: { title: string; onAdd: () => void; addLabel: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 750, letterSpacing: 0.4, color: '#9b9b9d', textTransform: 'uppercase' }}>{title}</span>
        <button
          onClick={onAdd}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'transparent', border: 'none', color: VR_ACCENT, fontSize: 12, fontWeight: 650, cursor: 'pointer', padding: 0 }}
        >
          <VRPlusIcon small /> {addLabel}
        </button>
      </div>
      {children}
    </div>
  );
}

function VRField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ color: VR_DIM, fontSize: 11, fontWeight: 700, textTransform: 'uppercase' }}>{label}</span>
      {children}
    </label>
  );
}

const VRPlusIcon = ({ small }: { small?: boolean }) => (
  <svg width={small ? 12 : 14} height={small ? 12 : 14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
    <path d="M12 5v14M5 12h14" />
  </svg>
);
const VRXIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
    <path d="M18 6 6 18M6 6l12 12" />
  </svg>
);
const VRCopyIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);
const VRCheckIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 6 9 17l-5-5" />
  </svg>
);
const VRFolderIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#c4b5fd" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 7h6l2 2h10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    <path d="M3 7V5a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v2" />
  </svg>
);
const VRDocIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#93c5fd" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6" />
    <path d="M8 13h8M8 17h5" />
  </svg>
);
const VRFileIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#a5b4fc" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7z" />
    <path d="M14 2v5h5" />
  </svg>
);
const VRChevronIcon = ({ open }: { open: boolean }) => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" style={{ transform: open ? 'rotate(90deg)' : 'rotate(0)', transition: 'transform 120ms ease' }}>
    <polyline points="9 6 15 12 9 18" />
  </svg>
);
