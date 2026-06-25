import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useUIStore } from '../../store/useUIStore';
import { usePromptsStore, AIPrompt, AIModel, ThinkingLevel, PROMPT_SUMMARY_PROMPT_ID } from '../../store/usePromptsStore';
import { GEMINI_MODEL_OPTIONS } from '../../constants/geminiModels';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useMirrorStatusStore } from '../../store/useMirrorStatusStore';
import { useTimelineSummaryStore } from '../../store/useTimelineSummaryStore';
import Tooltip from './Tooltip';
import ProjectIconsSettings from './ProjectIconsSettings';
import { HexColorPicker } from 'react-colorful';
import { Trash2, Plus } from 'lucide-react';
import { DEFAULT_CLAUDE_CODE_SETTINGS } from '../../constants/claudeLevels';

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
  title: string;
  content: string;
  group_id?: number | null;
  position?: number;
  file_paths?: string[];
}

type FlatPromptItem = { type: 'prompt'; origIdx: number; prompt: Prompt };
type FlatGroupItem = { type: 'group'; group: PromptGroup };
type FlatItem = FlatPromptItem | FlatGroupItem;
type DragItem = { type: 'group'; id: number } | { type: 'prompt'; index: number };
type PromptDragState = { prompts: Prompt[]; promptGroups: PromptGroup[] };
type RectSnap = { left: number; right: number; top: number; bottom: number; height: number; midY: number };
type DragFlatZone = { idx: number; item: DragItem; rect: RectSnap; header: RectSnap };
type DragGroupZone = {
  groupId: number;
  header: RectSnap | null;
  body: RectSnap;
  rows: { promptIndex: number; rect: RectSnap }[];
  empty: RectSnap | null;
  rowLeft: number | null;
  rowRight: number | null;
};
type DragGeometry = { list: RectSnap; flat: DragFlatZone[]; groups: DragGroupZone[] };
type DragTarget = { key: string; label: string; reason: string; next: PromptDragState };
type PointerDragSession = {
  item: DragItem;
  startX: number;
  startY: number;
  active: boolean;
  base: PromptDragState;
  geometry: DragGeometry | null;
  lastKey: string | null;
  click: () => void;
  prevCursor: string;
  prevUserSelect: string;
};

const snapRect = (el: Element): RectSnap => {
  const r = el.getBoundingClientRect();
  return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height, midY: r.top + r.height / 2 };
};

const fmtY = (r: RectSnap) => `${Math.round(r.top)}-${Math.round(r.midY)}-${Math.round(r.bottom)}`;

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
const VR_GREEN = '#22c55e';
const VR_RED = '#ef4444';

const DEFAULT_DOC_FILE_PATH = '/Users/fedor/Global-Templates/🧩 Code-Patterns/документация/docs-rules.prompt.md';

// Track if settings was opened at least once (for default tab)
let hasOpenedBefore = false;
let lastActiveTab: SettingsTab = 'ai';

// Shortcuts data
const SHORTCUTS = [
  { keys: '⌘ + T', description: 'Новый таб' },
  { keys: '⌘ + B', description: 'Показать/скрыть боковую панель' },
  { keys: '⌘ + ,', description: 'Открыть настройки' },
  { keys: '⌘ + E', description: 'Заметки вкладки (slide-out)' },
  { keys: '⌥ + V', description: 'Prompt picker (вставка промпта)' },
  { keys: '⌘ + S', description: 'Сохранить заметки (в редакторе)' },
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
// «Padding X» и «Padding Y» — занимали две клетки grid'а, при том что это семантически
// одна настройка. Юзер: «padding x и padding y должны быть в одной карточке».
// Реализация: один лейбл «Padding», справа два мини-stepper'а с маленьким префиксом X / Y.
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
      <span style={{ fontSize: '12px', color: '#eaeaea', fontWeight: 500 }}>Padding</span>
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

      <Tooltip content="Закрывать сайдбар при клике вне его (по терминалу или другому месту).">
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
            <div style={{ fontSize: '11px', color: '#666' }}>Сайдбар работает как overlay поверх терминала</div>
          </div>
        </label>
      </Tooltip>
    </div>
  );
}

// Один toggle-ряд для «показывать номера строк». Визуал зеркалит
// SidebarBehaviorToggles (та же green-pill геометрия), но это standalone-строка —
// используется отдельно в секции «Заметки» (редактор) и в подсекции
// «Превью CMD+hover» (превью), у каждой поверхности свой независимый toggle.
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

// SessionStatusesEditor — компактный CRUD над sessionStatuses + shape/size маркера.
// Одна колонка из 2-колоночного layout «Системные».
function SessionStatusesEditor() {
  const sessionStatuses = useUIStore((s) => s.sessionStatuses);
  const updateSessionStatus = useUIStore((s) => s.updateSessionStatus);
  const addSessionStatus = useUIStore((s) => s.addSessionStatus);
  const removeSessionStatus = useUIStore((s) => s.removeSessionStatus);
  const statusMarker = useUIStore((s) => s.statusMarker);
  const setStatusMarker = useUIStore((s) => s.setStatusMarker);

  const [pickerOpenId, setPickerOpenId] = useState<string | null>(null);
  const [hexDrafts, setHexDrafts] = useState<Record<string, string>>({});

  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!pickerOpenId) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (containerRef.current && target && !containerRef.current.contains(target)) {
        setPickerOpenId(null);
      }
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [pickerOpenId]);

  return (
    <div
      ref={containerRef}
      style={{ paddingLeft: '12px' }}
    >
      {/* Compact row: «+ новый» слева + shape toggle + size input. */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '10px',
        padding: '6px 8px', marginBottom: '10px',
        backgroundColor: '#1e1e1e', border: '1px solid #333', borderRadius: '8px',
      }}>
        <button
          onClick={addSessionStatus}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: '4px',
            padding: '3px 8px', fontSize: '11px', color: '#ccc',
            backgroundColor: '#2a2a2a', border: '1px solid #444', borderRadius: '6px',
            cursor: 'pointer', flexShrink: 0,
          }}
          title="Добавить статус"
        >
          <Plus size={11} /> новый
        </button>
        <span style={{ fontSize: '11px', color: '#888', marginLeft: '6px' }}>Маркер:</span>
        <div style={{ display: 'inline-flex', backgroundColor: '#1a1a1a', borderRadius: '6px', border: '1px solid #333' }}>
          {(['dot', 'square'] as const).map((shp) => (
            <button
              key={shp}
              onClick={() => setStatusMarker({ shape: shp })}
              style={{
                padding: '4px 8px', fontSize: '11px',
                color: statusMarker.shape === shp ? '#fff' : '#888',
                background: statusMarker.shape === shp ? '#333' : 'transparent',
                border: 'none', cursor: 'pointer',
                borderTopLeftRadius: shp === 'dot' ? 6 : 0,
                borderBottomLeftRadius: shp === 'dot' ? 6 : 0,
                borderTopRightRadius: shp === 'square' ? 6 : 0,
                borderBottomRightRadius: shp === 'square' ? 6 : 0,
              }}
              title={shp === 'dot' ? 'Круглый' : 'Квадратный'}
            >
              <span style={{
                display: 'inline-block', width: 8, height: 8,
                backgroundColor: '#ccc',
                borderRadius: shp === 'dot' ? '50%' : '2px',
                verticalAlign: 'middle',
              }} />
            </button>
          ))}
        </div>
        <span style={{ fontSize: '11px', color: '#888', marginLeft: 'auto' }}>Размер:</span>
        <input
          type="number"
          min={4}
          max={16}
          value={statusMarker.sizePx}
          onChange={(e) => setStatusMarker({ sizePx: Number(e.target.value) })}
          style={{
            width: '52px', padding: '4px 6px',
            backgroundColor: '#1a1a1a', border: '1px solid #333', borderRadius: '6px',
            color: '#ccc', fontSize: '12px', fontFamily: 'monospace', outline: 'none',
          }}
        />
        <span style={{ fontSize: '10px', color: '#555' }}>px</span>
      </div>

      {sessionStatuses.length === 0 && (
        <div style={{ fontSize: '12px', color: '#666', fontStyle: 'italic', padding: '8px 0' }}>
          Пусто. Нажми «новый», чтобы создать первый статус.
        </div>
      )}

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))',
        gap: '6px',
      }}>
        {sessionStatuses.map((s) => {
          const isPickerOpen = pickerOpenId === s.id;
          const hexDraft = hexDrafts[s.id] ?? s.color;
          return (
            <div
              key={s.id}
              style={{
                position: 'relative',
                display: 'flex', alignItems: 'center', gap: '6px',
                padding: '6px 8px',
                backgroundColor: '#1e1e1e',
                border: '1px solid #333',
                borderRadius: '8px',
              }}
            >
              <button
                onClick={() => setPickerOpenId(isPickerOpen ? null : s.id)}
                style={{
                  width: 20, height: 20,
                  borderRadius: statusMarker.shape === 'square' ? '4px' : '50%',
                  backgroundColor: s.color,
                  border: '2px solid rgba(255,255,255,0.15)',
                  cursor: 'pointer', flexShrink: 0, padding: 0,
                }}
                title="Открыть палитру"
              />

              <input
                type="text"
                value={s.label}
                onChange={(e) => updateSessionStatus(s.id, { label: e.target.value })}
                placeholder="Название"
                style={{
                  flex: 1, minWidth: 0,
                  padding: '4px 6px',
                  backgroundColor: '#1a1a1a',
                  border: '1px solid #333', borderRadius: '6px',
                  color: '#ccc', fontSize: '12px', outline: 'none',
                }}
              />

              <input
                type="text"
                value={hexDraft.replace(/^#/, '')}
                onChange={(e) => {
                  const next = `#${e.target.value}`;
                  setHexDrafts((d) => ({ ...d, [s.id]: next }));
                  const norm = normalizeHexValue(next);
                  if (norm) updateSessionStatus(s.id, { color: norm });
                }}
                onBlur={() => {
                  setHexDrafts((d) => { const cp = { ...d }; delete cp[s.id]; return cp; });
                }}
                maxLength={7}
                style={{
                  width: '64px', padding: '4px 6px',
                  backgroundColor: '#1a1a1a', border: '1px solid #333', borderRadius: '6px',
                  color: '#ccc', fontSize: '11px', fontFamily: 'monospace',
                  outline: 'none', textTransform: 'uppercase',
                }}
              />

              <button
                onClick={() => removeSessionStatus(s.id)}
                style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  width: 24, height: 24, borderRadius: '6px',
                  background: 'transparent', border: 'none',
                  color: '#666', cursor: 'pointer', flexShrink: 0,
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = '#f87171'; e.currentTarget.style.backgroundColor = 'rgba(248,113,113,0.1)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = '#666'; e.currentTarget.style.backgroundColor = 'transparent'; }}
                title="Удалить статус"
              >
                <Trash2 size={12} />
              </button>

              {isPickerOpen && (
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
                    color={s.color}
                    onChange={(c) => updateSessionStatus(s.id, { color: c.toUpperCase() })}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ProcessBarEditor — настройка полоски процесса (3px слева/справа в табе).
// Базовая полоса всегда статична; AI-busy поверх неё рисует бегущий shimmer.
// Юзер контролирует базовый цвет, цвет/плотность блика, расстояние между бликами и сторону.
function ProcessBarEditor() {
  const processBar = useUIStore((s) => s.processBar);
  const setProcessBar = useUIStore((s) => s.setProcessBar);

  const [pickerOpen, setPickerOpen] = useState<'a' | 'b' | null>(null);
  const [hexDraftA, setHexDraftA] = useState<string | null>(null);
  const [hexDraftB, setHexDraftB] = useState<string | null>(null);

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

  // Compact превью полоски — занимает 40px высоты, минимально.
  const previewPeakAlpha = opacityPctToAlpha(processBar.shimmerOpacityPct);
  const previewBar = (
    <div style={{
      position: 'relative', width: '100%', height: '32px',
      backgroundColor: '#252526', border: '1px solid #333',
      borderRadius: '6px', overflow: 'hidden',
    }}>
      <div
        className="tab-process-bar-static"
        style={{
          position: 'absolute',
          [processBar.position === 'right' ? 'right' : 'left']: 0,
          top: 0, bottom: 0, width: '3px',
          overflow: 'hidden',
          ['--process-bar-color-a' as any]: processBar.colorA,
          ['--process-bar-shimmer-rgb' as any]: hexToRgbTriplet(processBar.shimmerColor),
          ['--process-bar-shimmer-spacing' as any]: `${processBar.shimmerSpacingPct}%`,
          ['--process-bar-shimmer-alpha' as any]: previewPeakAlpha,
          ['--process-bar-shimmer-edge-alpha' as any]: Math.max(0.01, previewPeakAlpha * 0.22),
        }}
      >
        {/* Блик AI-busy крутится в превью постоянно; в рантайме он появляется
            только когда AI стримит/думает (isBusy). */}
        <div className="tab-process-bar-ai-shimmer-overlay" />
      </div>
      <div style={{
        position: 'absolute', left: 12, right: 12, top: '50%', transform: 'translateY(-50%)',
        fontSize: '11px', color: '#888', textAlign: 'center',
      }}>
        полоса · {processBar.position === 'right' ? 'справа' : 'слева'} · блик {processBar.shimmerSpacingPct}% / {processBar.shimmerOpacityPct}%
      </div>
    </div>
  );

  const colorChip = (which: 'a' | 'b') => {
    const current = which === 'a' ? processBar.colorA : processBar.shimmerColor;
    const draft = which === 'a' ? hexDraftA : hexDraftB;
    const setDraft = which === 'a' ? setHexDraftA : setHexDraftB;
    const label = which === 'a' ? 'Полоса' : 'Блик';

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
            if (norm) setProcessBar(which === 'a' ? { colorA: norm } : { shimmerColor: norm });
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
              onChange={(c) => setProcessBar(which === 'a' ? { colorA: c.toUpperCase() } : { shimmerColor: c.toUpperCase() })}
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

  // Programmatic open with requested tab (e.g. ПКМ на SemanticIndexButton).
  // Срабатывает на переходе isOpen=false→true когда initialTab задан.
  // Не блокирует ручное переключение табов после открытия — пользователь
  // нажал ПКМ → попал на «Системные», дальше может кликать другие табы.
  const prevIsOpenRef = useRef(isOpen);
  useEffect(() => {
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
  const promptQueueChipFontSize = useUIStore((s) => s.promptQueueChipFontSize);
  const setPromptQueueChipFontSize = useUIStore((s) => s.setPromptQueueChipFontSize);
  const promptQueueEditorFontSize = useUIStore((s) => s.promptQueueEditorFontSize);
  const setPromptQueueEditorFontSize = useUIStore((s) => s.setPromptQueueEditorFontSize);
  const promptQueueChipLineClamp = useUIStore((s) => s.promptQueueChipLineClamp);
  const setPromptQueueChipLineClamp = useUIStore((s) => s.setPromptQueueChipLineClamp);
  const setTerminalFontSize = useUIStore((s) => s.setTerminalFontSize);
  const sdkFontSize = useUIStore((s) => s.sdkFontSize);
  const setSdkFontSize = useUIStore((s) => s.setSdkFontSize);
  const setTabsFontSize = useUIStore((s) => s.setTabsFontSize);
  const setProjectTabsFontSize = useUIStore((s) => s.setProjectTabsFontSize);
  const setSidebarFontSize = useUIStore((s) => s.setSidebarFontSize);
  const setFilePreviewFontSize = useUIStore((s) => s.setFilePreviewFontSize);
  const setTimelineFontSize = useUIStore((s) => s.setTimelineFontSize);
  const setTimelineSummaryFontSize = useUIStore((s) => s.setTimelineSummaryFontSize);
  // Заметки вкладки — три независимых шрифта (сайдбар / раскрытый / превью)
  // + общие padding'и + cap'ы превью (max width/height попавапа CMD+hover).
  const notesSidebarFontSize = useUIStore((s) => s.notesSidebarFontSize);
  const setNotesSidebarFontSize = useUIStore((s) => s.setNotesSidebarFontSize);
  const notesExpandedFontSize = useUIStore((s) => s.notesExpandedFontSize);
  const setNotesExpandedFontSize = useUIStore((s) => s.setNotesExpandedFontSize);
  const notesTooltipFontSize = useUIStore((s) => s.notesTooltipFontSize);
  const setNotesTooltipFontSize = useUIStore((s) => s.setNotesTooltipFontSize);
  const notesEditorPaddingX = useUIStore((s) => s.notesEditorPaddingX);
  const setNotesEditorPaddingX = useUIStore((s) => s.setNotesEditorPaddingX);
  const notesEditorPaddingY = useUIStore((s) => s.notesEditorPaddingY);
  const setNotesEditorPaddingY = useUIStore((s) => s.setNotesEditorPaddingY);
  const notesEditorShowLineNumbers = useUIStore((s) => s.notesEditorShowLineNumbers);
  const setNotesEditorShowLineNumbers = useUIStore((s) => s.setNotesEditorShowLineNumbers);
  const notesPreviewShowLineNumbers = useUIStore((s) => s.notesPreviewShowLineNumbers);
  const setNotesPreviewShowLineNumbers = useUIStore((s) => s.setNotesPreviewShowLineNumbers);
  const tabPreviewMaxWidth = useUIStore((s) => s.tabPreviewMaxWidth);
  const setTabPreviewMaxWidth = useUIStore((s) => s.setTabPreviewMaxWidth);
  const tabPreviewMaxHeight = useUIStore((s) => s.tabPreviewMaxHeight);
  const setTabPreviewMaxHeight = useUIStore((s) => s.setTabPreviewMaxHeight);
  const semanticIndexParallelism = useUIStore((s) => s.semanticIndexParallelism);
  const claudeCodeSettings = useUIStore((s) => s.claudeCodeSettings);
  const setClaudeCodeSettings = useUIStore((s) => s.setClaudeCodeSettings);
  const claudeMdMirrorEnabled = useUIStore((s) => s.claudeMdMirrorEnabled);
  const setClaudeMdMirrorEnabled = useUIStore((s) => s.setClaudeMdMirrorEnabled);
  const tabCompletionNotificationSound = useUIStore((s) => s.tabCompletionNotificationSound);
  const setTabCompletionNotificationSound = useUIStore((s) => s.setTabCompletionNotificationSound);
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);
  const mirrorStatus = useMirrorStatusStore((s) => (activeProjectId ? s.byProject[activeProjectId] : undefined));
  const setSemanticIndexParallelism = useUIStore((s) => s.setSemanticIndexParallelism);
  // Геометрия табов — Settings → Размеры → ТАБЫ → Терминал/Проекты.
  const tabGeometry = useUIStore((s) => s.tabGeometry);
  const setTabGeometry = useUIStore((s) => s.setTabGeometry);
  const projectTabGeometry = useUIStore((s) => s.projectTabGeometry);
  const setProjectTabGeometry = useUIStore((s) => s.setProjectTabGeometry);
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
  const [draggingItem, setDraggingItem] = useState<DragItem | null>(null);
  const textListRef = useRef<HTMLDivElement>(null);
  const pointerDragRef = useRef<PointerDragSession | null>(null);
  const dragVisualStateRef = useRef<PromptDragState>({ prompts: [], promptGroups: [] });
  const latestPromptStateRef = useRef<PromptDragState>({ prompts: [], promptGroups: [] });

  // Editing states
  const [editingClaude, setEditingClaude] = useState(false);
  const [editingPromptId, setEditingPromptId] = useState<string | null>(null); // AI prompt being edited
  const [editingDocPrompt, setEditingDocPrompt] = useState(false);
  const [editingPostCheck, setEditingPostCheck] = useState(false);
  const [localPostCheckContent, setLocalPostCheckContent] = useState('');
  const [editingInsertionIndex, setEditingInsertionIndex] = useState<number | null>(null);
  const [localInsertionTitle, setLocalInsertionTitle] = useState('');
  const [localInsertionContent, setLocalInsertionContent] = useState('');
  const [localInsertionFilePaths, setLocalInsertionFilePaths] = useState<string[]>([]);
  const [insertionFileInputs, setInsertionFileInputs] = useState<{ value: string; valid: boolean | null }[]>([]);
  const [savedInsertionFlash, setSavedInsertionFlash] = useState<'title' | 'content' | null>(null);
  const savedInsertionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  dragVisualStateRef.current = { prompts, promptGroups };
  if (!pointerDragRef.current?.active) {
    latestPromptStateRef.current = { prompts, promptGroups };
  }

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
  const docEditRef = useRef<HTMLDivElement>(null);
  const postCheckEditRef = useRef<HTMLDivElement>(null);


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

  // Save current text insertion from local state
  const saveCurrentInsertion = (overrideFilePaths?: string[]) => {
    if (editingInsertionIndex !== null && prompts[editingInsertionIndex]) {
      const newPrompts = [...prompts];
      newPrompts[editingInsertionIndex] = { ...newPrompts[editingInsertionIndex], title: localInsertionTitle, content: localInsertionContent, file_paths: overrideFilePaths ?? localInsertionFilePaths };
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
    setLocalInsertionFilePaths(prompts[index].file_paths || []);
    setInsertionFileInputs([]);
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

  const promptStateWithLocalDrafts = (): PromptDragState => {
    const nextPrompts = prompts.map(p => ({ ...p }));
    const nextGroups = promptGroups.map(g => ({ ...g }));
    if (editingInsertionIndex !== null && nextPrompts[editingInsertionIndex]) {
      nextPrompts[editingInsertionIndex] = {
        ...nextPrompts[editingInsertionIndex],
        title: localInsertionTitle,
        content: localInsertionContent,
        file_paths: localInsertionFilePaths,
      };
    }
    if (editingGroupId !== null) {
      const gi = nextGroups.findIndex(g => g.id === editingGroupId);
      if (gi >= 0) {
        nextGroups[gi] = { ...nextGroups[gi], name: localGroupName, description: localGroupDescription };
      }
    }
    return { prompts: nextPrompts, promptGroups: nextGroups };
  };

  const promptPos = (p: Prompt, fallback: number) => Number.isFinite(Number(p.position)) ? Number(p.position) : fallback;

  // Build flat items: groups and ungrouped prompts interleaved by position
  const flatItemsFor = (state: PromptDragState): FlatItem[] => {
    const items: FlatItem[] = [];
    state.promptGroups.forEach(g => items.push({ type: 'group', group: g }));
    state.prompts.forEach((p, i) => { if (!p.group_id) items.push({ type: 'prompt', origIdx: i, prompt: p }); });
    return items.sort((a, b) => {
      const posA = a.type === 'group' ? a.group.position : promptPos(a.prompt, a.origIdx);
      const posB = b.type === 'group' ? b.group.position : promptPos(b.prompt, b.origIdx);
      return posA - posB;
    });
  };

  const buildFlatItems = () => flatItemsFor({ prompts, promptGroups });

  const sameDragItem = (a: DragItem, b: DragItem) =>
    a.type === b.type && (a.type === 'group' ? a.id === (b as { type: 'group'; id: number }).id : a.index === (b as { type: 'prompt'; index: number }).index);

  const flatItemToDrag = (item: FlatItem): DragItem =>
    item.type === 'group' ? { type: 'group', id: item.group.id } : { type: 'prompt', index: item.origIdx };

  const reindexFlatState = (state: PromptDragState, flat: FlatItem[]): PromptDragState => {
    const nextGroups = state.promptGroups.map(g => ({ ...g }));
    const nextPrompts = state.prompts.map(p => ({ ...p }));
    flat.forEach((item, pos) => {
      if (item.type === 'group') {
        const gi = nextGroups.findIndex(g => g.id === item.group.id);
        if (gi >= 0) nextGroups[gi] = { ...nextGroups[gi], position: pos };
      } else {
        nextPrompts[item.origIdx] = { ...nextPrompts[item.origIdx], group_id: null, position: pos };
      }
    });
    return { prompts: nextPrompts, promptGroups: nextGroups };
  };

  const moveFlatItem = (state: PromptDragState, drag: DragItem, targetIdx: number): PromptDragState => {
    const flat = flatItemsFor(state);
    const existingIdx = flat.findIndex(item => sameDragItem(flatItemToDrag(item), drag));
    const moving: FlatItem | null = drag.type === 'group'
      ? (() => {
          const group = state.promptGroups.find(g => g.id === drag.id);
          return group ? { type: 'group' as const, group } : null;
        })()
      : (() => {
          const prompt = state.prompts[drag.index];
          return prompt ? { type: 'prompt' as const, origIdx: drag.index, prompt } : null;
        })();
    if (!moving) return state;
    const without = flat.filter(item => !sameDragItem(flatItemToDrag(item), drag));
    const insertAt = Math.max(0, Math.min(existingIdx >= 0 && existingIdx < targetIdx ? targetIdx - 1 : targetIdx, without.length));
    return reindexFlatState(state, [...without.slice(0, insertAt), moving, ...without.slice(insertAt)]);
  };

  const movePromptIntoGroupAt = (state: PromptDragState, drag: DragItem, groupId: number, targetIdxRaw: number): PromptDragState => {
    if (drag.type !== 'prompt' || !state.promptGroups.some(g => g.id === groupId)) return state;
    const moving = state.prompts[drag.index];
    if (!moving) return state;
    const groupPrompts = state.prompts
      .map((p, i) => ({ prompt: p, index: i }))
      .filter(item => item.prompt.group_id === groupId && item.index !== drag.index)
      .sort((a, b) => promptPos(a.prompt, a.index) - promptPos(b.prompt, b.index));
    const targetIdx = Math.max(0, Math.min(targetIdxRaw, groupPrompts.length));
    const ordered = [
      ...groupPrompts.slice(0, targetIdx),
      { prompt: moving, index: drag.index },
      ...groupPrompts.slice(targetIdx),
    ];
    const promptsNext = state.prompts.map((p, i) => {
      const pos = ordered.findIndex(item => item.index === i);
      return pos >= 0 ? { ...p, group_id: groupId, position: pos } : p;
    });
    const next = { prompts: promptsNext, promptGroups: state.promptGroups };
    return reindexFlatState(next, flatItemsFor(next));
  };

  const applyPromptDragState = (state: PromptDragState, save: boolean) => {
    dragVisualStateRef.current = state;
    if (save) latestPromptStateRef.current = state;
    setPrompts(state.prompts);
    setPromptGroups(state.promptGroups);
    if (save) {
      savePromptsImmediate(state.prompts);
      ipcRenderer.invoke('prompt-groups:save', state.promptGroups);
    }
  };

  const autoScrollDragList = (clientY: number) => {
    const el = textListRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const edge = 34;
    if (clientY < r.top + edge) el.scrollTop -= Math.ceil((r.top + edge - clientY) / 3) + 6;
    else if (clientY > r.bottom - edge) el.scrollTop += Math.ceil((clientY - (r.bottom - edge)) / 3) + 6;
  };

  const captureDragGeometry = (base: PromptDragState): DragGeometry | null => {
    const list = textListRef.current;
    if (!list) return null;
    const flat = flatItemsFor(base);
    const flatZones: DragFlatZone[] = [];
    for (const c of Array.from(list.querySelectorAll<HTMLElement>('[data-dnd-flat-container]'))) {
      const type = c.dataset.dndType as DragItem['type'] | undefined;
      const idRaw = c.dataset.dndId;
      if (!type || idRaw == null) continue;
      const item: DragItem = type === 'group' ? { type, id: Number(idRaw) } : { type, index: Number(idRaw) };
      const idx = flat.findIndex(row => sameDragItem(flatItemToDrag(row), item));
      if (idx < 0) continue;
      const headerEl = type === 'group' ? c.querySelector<HTMLElement>('[data-dnd-kind="flat"]') || c : c;
      flatZones.push({ idx, item, rect: snapRect(c), header: snapRect(headerEl) });
    }

    const groupZones: DragGroupZone[] = [];
    for (const body of Array.from(list.querySelectorAll<HTMLElement>('[data-dnd-kind="group-body"]'))) {
      const groupId = Number(body.dataset.groupId);
      if (!Number.isFinite(groupId)) continue;
      const container = body.closest<HTMLElement>('[data-dnd-flat-container]');
      const header = container?.querySelector<HTMLElement>('[data-dnd-kind="flat"]') || null;
      const rows = Array.from(body.querySelectorAll<HTMLElement>('[data-dnd-kind="group-prompt"]'))
        .map(row => ({ promptIndex: Number(row.dataset.promptIndex), rect: snapRect(row) }))
        .filter(row => Number.isFinite(row.promptIndex));
      const empty = body.querySelector<HTMLElement>('[data-dnd-kind="group-empty"]');
      groupZones.push({
        groupId,
        header: header ? snapRect(header) : null,
        body: snapRect(body),
        rows,
        empty: empty ? snapRect(empty) : null,
        rowLeft: rows.length ? Math.min(...rows.map(row => row.rect.left)) : null,
        rowRight: rows.length ? Math.max(...rows.map(row => row.rect.right)) : null,
      });
    }

    flatZones.sort((a, b) => a.idx - b.idx);
    return { list: snapRect(list), flat: flatZones, groups: groupZones };
  };

  const summarizeDragGeometry = (g: DragGeometry | null) => {
    if (!g) return 'geom=null';
    const flat = g.flat.map(z => `${z.idx}:${z.item.type[0]}:${z.item.type === 'group' ? z.item.id : z.item.index}@${fmtY(z.rect)} h@${fmtY(z.header)}`).join(' ');
    const groups = g.groups.map(z => `g:${z.groupId} rows=${z.rows.length} body@${fmtY(z.body)}`).join(' ');
    return `flat=[${flat}] groups=[${groups}]`;
  };

  const resolveDragTarget = (item: DragItem, clientX: number, clientY: number): DragTarget | null => {
    const session = pointerDragRef.current;
    const base = session?.base || dragVisualStateRef.current;
    let geometry = session?.geometry || null;
    if (!geometry) {
      geometry = captureDragGeometry(base);
      if (session) session.geometry = geometry;
    }
    if (!geometry) return null;
    const listRect = geometry.list;
    if (clientX < listRect.left - 28 || clientX > listRect.right + 28 || clientY < listRect.top - 80 || clientY > listRect.bottom + 80) {
      return null;
    }

    if (item.type === 'prompt') {
      for (const group of geometry.groups) {
        const flatGroup = geometry.flat.find(z => z.item.type === 'group' && z.item.id === group.groupId);
        if (flatGroup && group.header && clientX >= group.header.left && clientX <= group.header.right && clientY >= group.header.top && clientY <= group.header.bottom) {
          if (clientY >= group.header.midY) {
            return {
              key: `group:${group.groupId}:0`,
              label: `group:${group.groupId}:0`,
              reason: `group-header-lower y=${Math.round(clientY)} mid=${Math.round(group.header.midY)}`,
              next: movePromptIntoGroupAt(base, item, group.groupId, 0),
            };
          }
          return {
            key: `flat:${flatGroup.idx}`,
            label: `flat:${flatGroup.idx}`,
            reason: `group-header-upper y=${Math.round(clientY)} mid=${Math.round(group.header.midY)}`,
            next: moveFlatItem(base, item, flatGroup.idx),
          };
        }

        if (group.rows.length === 0) {
          const er = group.empty;
          if (er && clientY >= er.top && clientY <= er.bottom && clientX >= er.left - 18 && clientX <= er.right + 18) {
            return {
              key: `group:${group.groupId}:0`,
              label: `group:${group.groupId}:0`,
              reason: 'group-empty',
              next: movePromptIntoGroupAt(base, item, group.groupId, 0),
            };
          }
          continue;
        }

        const first = group.rows[0].rect;
        const last = group.rows[group.rows.length - 1].rect;
        const rowLeft = group.rowLeft ?? group.body.left;
        const rowRight = group.rowRight ?? group.body.right;
        if (clientY < Math.min(group.body.top, first.top - 8) || clientY > last.bottom) continue;
        if (clientX < rowLeft - 12 || clientX > rowRight + 18) continue;

        let targetIdx = 0;
        for (const row of group.rows) {
          if (row.promptIndex === item.index) continue;
          if (clientY < row.rect.midY) break;
          targetIdx += 1;
        }
        return {
          key: `group:${group.groupId}:${targetIdx}`,
          label: `group:${group.groupId}:${targetIdx}`,
          reason: `group-rows y=${Math.round(clientY)} rows=${group.rows.map(r => `${r.promptIndex}@${Math.round(r.rect.midY)}`).join(',')}`,
          next: movePromptIntoGroupAt(base, item, group.groupId, targetIdx),
        };
      }
    }

    let targetIdx = geometry.flat.length;
    for (const row of geometry.flat) {
      if (clientY < row.rect.midY) { targetIdx = row.idx; break; }
      targetIdx = row.idx + 1;
    }
    return {
      key: `flat:${targetIdx}`,
      label: `flat:${targetIdx}`,
      reason: `flat-block y=${Math.round(clientY)} mids=${geometry.flat.map(z => `${z.idx}:${z.item.type[0]}:${Math.round(z.rect.midY)}`).join(',')}`,
      next: moveFlatItem(base, item, targetIdx),
    };
  };

  const previewPointerDrag = (item: DragItem, clientX: number, clientY: number) => {
    const session = pointerDragRef.current;
    if (!session || !session.active) return;
    const target = resolveDragTarget(item, clientX, clientY);
    if (!target || target.key === session.lastKey) return;
    session.lastKey = target.key;
    applyPromptDragState(target.next, false);
    console.warn('[PromptDnD] preview', item, '->', target.label, 'via', target.reason, 'at', Math.round(clientX), Math.round(clientY));
  };

  const startPointerDrag = (item: DragItem, click: () => void) => (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest('[data-no-card-drag],button,input,textarea,select,a')) return;
    e.preventDefault();
    e.stopPropagation();

    const base = promptStateWithLocalDrafts();
    saveCurrentGroup();
    saveCurrentInsertion();
    saveCurrentAIPrompt();
    setEditingGroupId(null);
    setEditingInsertionIndex(null);
    setEditingPromptId(null);
    applyPromptDragState(base, false);

    const session: PointerDragSession = {
      item,
      startX: e.clientX,
      startY: e.clientY,
      active: false,
      base,
      geometry: null,
      lastKey: null,
      click,
      prevCursor: document.body.style.cursor,
      prevUserSelect: document.body.style.userSelect,
    };
    pointerDragRef.current = session;

    let onMove: (ev: PointerEvent) => void = () => {};
    let onUp: () => void = () => {};
    let onCancel: () => void = () => {};
    let onKeyDown: (ev: KeyboardEvent) => void = () => {};
    let onBlur: () => void = () => {};

    const finish = (commit: boolean) => {
      if (pointerDragRef.current !== session) return;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('blur', onBlur);
      document.body.style.cursor = session.prevCursor;
      document.body.style.userSelect = session.prevUserSelect;

      if (session.active) {
        if (commit) {
          applyPromptDragState(dragVisualStateRef.current, true);
          console.warn('[PromptDnD] drop', item, '->', session.lastKey || 'same');
        } else {
          applyPromptDragState(session.base, false);
          console.warn('[PromptDnD] cancel', item);
        }
      } else if (commit) {
        session.click();
      }
      pointerDragRef.current = null;
      setDraggingItem(null);
    };

    const beginIfNeeded = (ev: PointerEvent) => {
      if (session.active) return true;
      const dx = ev.clientX - session.startX;
      const dy = ev.clientY - session.startY;
      if (Math.hypot(dx, dy) < 4) return false;
      session.geometry = captureDragGeometry(session.base);
      session.active = true;
      setDraggingItem(item);
      document.body.style.cursor = 'grabbing';
      document.body.style.userSelect = 'none';
      console.warn('[PromptDnD] start', item, summarizeDragGeometry(session.geometry));
      return true;
    };

    onMove = (ev: PointerEvent) => {
      if (pointerDragRef.current !== session) return;
      ev.preventDefault();
      if (!beginIfNeeded(ev)) return;
      autoScrollDragList(ev.clientY);
      previewPointerDrag(item, ev.clientX, ev.clientY);
    };
    onUp = () => finish(true);
    onCancel = () => finish(false);
    onKeyDown = (ev: KeyboardEvent) => { if (ev.key === 'Escape') finish(false); };
    onBlur = () => finish(false);

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('blur', onBlur);
  };

  const closeInsertionEditor = () => {
    saveCurrentInsertion();
    setEditingInsertionIndex(null);
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
    const newPrompts = [...prompts, { title: `Prompt ${prompts.length + 1}`, content: '', group_id: groupId ?? null, position: pos }];
    setPrompts(newPrompts);
    savePromptsImmediate(newPrompts);
    const idx = newPrompts.length - 1;
    setEditingInsertionIndex(idx);
    setLocalInsertionTitle(newPrompts[idx].title);
    setLocalInsertionContent('');
    setLocalInsertionFilePaths([]);
    setInsertionFileInputs([]);
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

  const switchAISubTab = (next: AISubTab) => {
    if (next === aiSubTab) return;
    if (aiSubTab === 'system') {
      saveCurrentAIPrompt();
      setEditingPromptId(null);
    }
    if (aiSubTab === 'text') {
      saveCurrentInsertion();
      saveCurrentGroup();
      setEditingInsertionIndex(null);
      setEditingGroupId(null);
    }
    setAiSubTab(next);
  };

  const renderTextPromptCard = (prompt: Prompt, index: number, dndKind: 'flat' | 'group-prompt', groupId?: number) => {
    const isSelected = editingInsertionIndex === index;
    const isDragged = draggingItem?.type === 'prompt' && draggingItem.index === index;
    return (
      <div
        key={`${dndKind}-${index}`}
        data-dnd-kind={dndKind}
        data-dnd-flat-container={dndKind === 'flat' ? 'true' : undefined}
        data-dnd-type={dndKind === 'flat' ? 'prompt' : undefined}
        data-dnd-id={dndKind === 'flat' ? String(index) : undefined}
        data-group-id={groupId != null ? String(groupId) : undefined}
        data-prompt-index={String(index)}
        onPointerDown={startPointerDrag({ type: 'prompt', index }, () => startEditingInsertion(index))}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 6,
          padding: '8px 9px',
          borderRadius: 8,
          background: isDragged ? 'rgba(124,58,237,0.18)' : (isSelected ? '#24242a' : VR_CARD),
          border: `1px solid ${isDragged ? VR_VIOLET : (isSelected ? VR_ACCENT : VR_BORDER)}`,
          boxShadow: isDragged ? '0 0 0 1px rgba(124,58,237,0.28) inset, 0 0 18px rgba(124,58,237,0.16)' : 'none',
          cursor: isDragged ? 'grabbing' : 'pointer',
          minWidth: 0,
          userSelect: 'none',
          touchAction: 'none',
          transition: 'background 110ms ease, border-color 110ms ease, box-shadow 110ms ease',
        }}
      >
        <VRDocIcon />
        <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: isSelected ? '#bfdbfe' : VR_TEXT, fontWeight: 620, fontSize: 13 }}>
          {prompt.title || 'Untitled'}
        </div>
        {(prompt.file_paths?.length || 0) > 0 && <VRTag accent>{prompt.file_paths?.length} файл.</VRTag>}
        <VRGrip />
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
    const selectedGroup = editingGroupId !== null ? promptGroups.find(g => g.id === editingGroupId) : null;
    const selectedPrompt = editingInsertionIndex !== null ? prompts[editingInsertionIndex] : null;
    const flatItems = buildFlatItems();

    return (
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 34%) minmax(360px, 1fr)', gap: 12, height: '100%', minHeight: 0 }}>
        <div style={{ minHeight: 0, display: 'flex', flexDirection: 'column', background: '#17171a', border: `1px solid ${VR_BORDER}`, borderRadius: 10, overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 10px', borderBottom: `1px solid ${VR_BORDER}` }}>
            <span style={{ fontSize: 11, fontWeight: 750, letterSpacing: 0.4, color: VR_DIM, textTransform: 'uppercase' }}>Текстовые вставки</span>
            <VRTag>{prompts.length}</VRTag>
            <div style={{ flex: 1 }} />
            <button onClick={addPromptGroup} style={vrSmallBtnStyle('neutral')}><VRFolderIcon /> Группа</button>
            <button onClick={() => addPrompt()} style={vrSmallBtnStyle('accent')}><VRPlusIcon small /> Промпт</button>
          </div>

          <div ref={textListRef} onDragStart={(e) => e.preventDefault()} style={{ padding: 8, overflowY: 'auto', minHeight: 0, flex: 1 }}>
            {flatItems.length === 0 ? (
              <VREmpty text="Нет промптов. Добавь первый." />
            ) : (
              <>
                {flatItems.map((item) => {
                  if (item.type === 'group') {
                    const group = item.group;
                    const groupPrompts = prompts
                      .map((p, i) => ({ ...p, _idx: i }))
                      .filter(p => p.group_id === group.id)
                      .sort((a, b) => promptPos(a, a._idx) - promptPos(b, b._idx));
                    const isSelected = editingGroupId === group.id;
                    const isDragging = draggingItem?.type === 'group' && draggingItem.id === group.id;
                    return (
                      <div key={`g-${group.id}`}>
                        <div data-dnd-flat-container="true" data-dnd-type="group" data-dnd-id={String(group.id)} style={{ border: '1px solid transparent', borderRadius: 9, marginBottom: 7 }}>
                          <div
                            data-dnd-kind="flat"
                            data-dnd-type="group"
                            data-dnd-id={String(group.id)}
                            onPointerDown={startPointerDrag({ type: 'group', id: group.id }, () => startEditingGroup(group.id))}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 8,
                              padding: '8px 9px',
                              borderRadius: 8,
                              background: isDragging ? 'rgba(124,58,237,0.18)' : (isSelected ? '#24242a' : VR_CARD),
                              border: `1px solid ${isDragging ? VR_VIOLET : (isSelected ? VR_VIOLET : VR_BORDER)}`,
                              boxShadow: isDragging ? '0 0 0 1px rgba(124,58,237,0.18) inset' : 'none',
                              cursor: isDragging ? 'grabbing' : 'pointer',
                              userSelect: 'none',
                              touchAction: 'none',
                              transition: 'background 110ms ease, border-color 110ms ease, box-shadow 110ms ease',
                            }}
                          >
                            <button
                              data-no-card-drag
                              onPointerDown={(e) => e.stopPropagation()}
                              onMouseDown={(e) => e.stopPropagation()}
                              onClick={(e) => { e.stopPropagation(); toggleGroupCollapsed(group.id); }}
                              style={{ border: 'none', background: 'transparent', color: VR_DIM, cursor: 'pointer', padding: 0, width: 18, display: 'flex' }}
                            >
                              <VRChevronIcon open={!group.is_collapsed} />
                            </button>
                            <VRFolderIcon />
                            <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: isSelected ? '#ddd6fe' : VR_TEXT, fontWeight: 650, fontSize: 13 }}>
                              {group.name || 'Группа'}
                            </div>
                            <VRTag>{groupPrompts.length}</VRTag>
                            <VRGrip />
                          </div>
                          {!group.is_collapsed && (
                            <div data-dnd-kind="group-body" data-group-id={String(group.id)} style={{ padding: '6px 0 0 26px' }}>
                              {groupPrompts.length === 0 && (
                                <div data-dnd-kind="group-empty" style={{ padding: '8px', marginBottom: 5, borderRadius: 8, border: '1px dashed #3a2f55', color: '#6f638a', fontSize: 11, textAlign: 'center' }}>
                                  Перетащи промпт сюда
                                </div>
                              )}
                              {groupPrompts.map((prompt) => renderTextPromptCard(prompt, prompt._idx, 'group-prompt', group.id))}
                              <button data-no-card-drag onClick={() => addPrompt(group.id)} style={{ width: '100%', margin: '2px 0 7px', padding: '6px 8px', borderRadius: 8, border: '1px dashed #3a3a42', background: 'transparent', color: VR_DIM, fontSize: 11, cursor: 'pointer' }}>
                                + промпт в группу
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  }
                  return renderTextPromptCard(item.prompt, item.origIdx, 'flat');
                })}
                <div style={{ height: 10 }} />
              </>
            )}
          </div>
        </div>

        <div style={{ minHeight: 0, background: '#17171a', border: `1px solid ${VR_BORDER}`, borderRadius: 10, overflow: 'hidden' }}>
          {selectedPrompt ? (
            <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
              <div style={{ padding: '12px 14px', borderBottom: `1px solid ${VR_BORDER}`, display: 'flex', alignItems: 'center', gap: 10 }}>
                <VRDocIcon />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ color: VR_TEXT, fontSize: 14, fontWeight: 750, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{localInsertionTitle || 'Untitled'}</div>
                </div>
                <VRIconBtn title="Удалить промпт" danger onClick={() => editingInsertionIndex !== null && deletePrompt(editingInsertionIndex)}><VRTrashIcon /></VRIconBtn>
              </div>
              <div style={{ padding: 14, overflowY: 'auto', minHeight: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 14 }}>
                <VRField label="Название">
                  <input
                    value={localInsertionTitle}
                    placeholder="Название промпта"
                    onChange={(e) => setLocalInsertionTitle(e.target.value)}
                    onBlur={() => {
                      saveCurrentInsertion();
                      setSavedInsertionFlash('title');
                      if (savedInsertionTimer.current) clearTimeout(savedInsertionTimer.current);
                      savedInsertionTimer.current = setTimeout(() => setSavedInsertionFlash(null), 400);
                    }}
                    style={{ ...vrFieldStyle, borderColor: savedInsertionFlash === 'title' ? VR_GREEN : VR_BORDER }}
                  />
                </VRField>
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
          ) : selectedGroup ? (
            <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
              <div style={{ padding: '12px 14px', borderBottom: `1px solid ${VR_BORDER}`, display: 'flex', alignItems: 'center', gap: 10 }}>
                <VRFolderIcon />
                <div style={{ color: VR_TEXT, fontSize: 14, fontWeight: 750, flex: 1 }}>Группа</div>
                <VRIconBtn title="Удалить группу" danger onClick={() => deletePromptGroup(selectedGroup.id)}><VRTrashIcon /></VRIconBtn>
              </div>
              <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>
                <VRField label="Название">
                  <input
                    value={localGroupName}
                    onChange={(e) => setLocalGroupName(e.target.value)}
                    onBlur={() => {
                      saveCurrentGroup();
                      setSavedGroupFlash('name');
                      if (savedGroupTimer.current) clearTimeout(savedGroupTimer.current);
                      savedGroupTimer.current = setTimeout(() => setSavedGroupFlash(null), 400);
                    }}
                    style={{ ...vrFieldStyle, borderColor: savedGroupFlash === 'name' ? VR_GREEN : VR_BORDER }}
                  />
                </VRField>
              </div>
            </div>
          ) : (
            <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: VR_DIM, fontSize: 13 }}>
              Выбери промпт или группу слева
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

          <div style={{ padding: 12, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
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
          <div style={{ padding: 12, minHeight: 0, flex: 1, overflowY: 'auto' }}>
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

          <div style={{ padding: 14, overflowY: 'auto', minHeight: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 14 }}>
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

          <div style={{ padding: 8, overflowY: 'auto', minHeight: 0, flex: 1 }}>
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

            <div
              ref={docEditRef}
              onClick={() => !editingDocPrompt && setEditingDocPrompt(true)}
              style={{ padding: 10, background: editingDocPrompt ? '#24242a' : VR_CARD, border: `1px solid ${editingDocPrompt ? VR_GREEN : VR_BORDER}`, borderRadius: 8, cursor: editingDocPrompt ? 'default' : 'pointer', marginBottom: 7 }}
            >
              {editingDocPrompt ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 11, color: VR_DIM }}>Источник:</span>
                    <button onClick={(e) => { e.stopPropagation(); setDocPromptUseFile(true); }} style={{ padding: '4px 9px', backgroundColor: docPrompt.useFile ? VR_GREEN : VR_FIELD, color: docPrompt.useFile ? '#fff' : VR_DIM, border: `1px solid ${docPrompt.useFile ? VR_GREEN : VR_BORDER}`, borderRadius: 7, fontSize: 11, cursor: 'pointer' }}>Файл</button>
                    <button onClick={(e) => { e.stopPropagation(); setDocPromptUseFile(false); }} style={{ padding: '4px 9px', backgroundColor: !docPrompt.useFile ? VR_GREEN : VR_FIELD, color: !docPrompt.useFile ? '#fff' : VR_DIM, border: `1px solid ${!docPrompt.useFile ? VR_GREEN : VR_BORDER}`, borderRadius: 7, fontSize: 11, cursor: 'pointer' }}>Inline</button>
                  </div>
                  {docPrompt.useFile ? (
                    <input type="text" value={localDocFilePath} onChange={(e) => setLocalDocFilePath(e.target.value)} onBlur={handleDocBlur} placeholder="Путь к файлу..." autoFocus style={{ ...vrFieldStyle, fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11.5 }} />
                  ) : (
                    <textarea value={localDocInlineContent} onChange={(e) => setLocalDocInlineContent(e.target.value)} onBlur={handleDocBlur} rows={4} autoFocus style={{ ...vrFieldStyle, height: 'auto', minHeight: 120, resize: 'vertical', fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12 }} />
                  )}
                  <button onClick={(e) => { e.stopPropagation(); resetDoc(); }} style={{ alignSelf: 'flex-start', padding: 0, backgroundColor: 'transparent', color: VR_DIM, border: 'none', fontSize: 11, cursor: 'pointer' }}>Сбросить</button>
                </div>
              ) : (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                    <span style={{ fontSize: 13, color: VR_GREEN, fontWeight: 650 }}>Documentation</span>
                    <VRTag accent={docPrompt.useFile}>{docPrompt.useFile ? 'ФАЙЛ' : 'INLINE'}</VRTag>
                  </div>
                  <div style={{ fontSize: 11, color: VR_DIM, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {docPrompt.useFile ? localDocFilePath : (localDocInlineContent || 'Не задан')}
                  </div>
                </>
              )}
            </div>

            <div
              ref={postCheckEditRef}
              onClick={() => !editingPostCheck && setEditingPostCheck(true)}
              style={{ padding: 10, background: editingPostCheck ? '#24242a' : VR_CARD, border: `1px solid ${editingPostCheck ? '#a78bfa' : VR_BORDER}`, borderRadius: 8, cursor: editingPostCheck ? 'default' : 'pointer' }}
            >
              {editingPostCheck ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <span style={{ fontSize: 11, color: '#a78bfa', fontWeight: 650 }}>Post-check</span>
                  <textarea
                    value={localPostCheckContent}
                    onChange={(e) => setLocalPostCheckContent(e.target.value)}
                    onBlur={(e) => {
                      if (isBlurInsideContainer(e, postCheckEditRef)) return;
                      useUIStore.getState().setPostCheckPrompt(localPostCheckContent);
                      setEditingPostCheck(false);
                    }}
                    rows={5}
                    autoFocus
                    style={{ ...vrFieldStyle, height: 'auto', minHeight: 140, resize: 'vertical', fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12 }}
                  />
                </div>
              ) : (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                    <span style={{ fontSize: 13, color: '#a78bfa', fontWeight: 650 }}>Post-check</span>
                  </div>
                  <div style={{ fontSize: 11, color: VR_DIM, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {localPostCheckContent || 'Не задан'}
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
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const commitClaudeCodeModel = (index: number, patch: { id?: string; label?: string }) => {
    const models = claudeCodeSettings.models.map((m, i) => (i === index ? { ...m, ...patch } : m));
    setClaudeCodeSettings({ ...claudeCodeSettings, models });
  };

  const commitClaudeCodeEffort = (index: number, value: string) => {
    const efforts = claudeCodeSettings.efforts.map((level, i) => (i === index ? value : level));
    setClaudeCodeSettings({ ...claudeCodeSettings, efforts });
  };

  const commitInputOnEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
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
      onClick={(e) => { if (e.target === e.currentTarget && (e.currentTarget as HTMLElement).dataset.mouseDownOnOverlay === 'true') onClose(); (e.currentTarget as HTMLElement).dataset.mouseDownOnOverlay = ''; }}
    >
      <div
        style={{
          backgroundColor: '#1a1a1a',
          borderRadius: '16px',
          border: '1px solid #333',
          // Settings → Размеры теперь содержит 5 блоков (ТАБЫ / ШРИФТЫ / ЗАМЕТКИ / СТАТУСЫ / ПОЛОСКА),
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

          {activeTab === 'projects' && (
            <ProjectIconsSettings />
          )}

          {activeTab === 'fonts' && (
            <>
              {/* SettingsTree pattern:
                  - Главные uppercase-заголовки (Табы / Шрифты / Заметки) идут плоско.
                  - Sub-секции через padding-left 16px + border-left + ╰ префикс.
                  - Все строки настроек — единый FontSizeSlider компонент в 4-col grid.
                  Цель — одна стилистика на весь tab, юзер не различает «у этого блока
                  свой фон, у другого свой». Card-wrapper'ы (свой background+border вокруг
                  блока) убраны для всех секций. */}

              {/* SettingsTree pattern: главные секции (Табы / Терминал / Сайдбар /
                  Prompt picker / Заметки) — каждая отдельная область интерфейса.
                  Внутри каждой секции собраны ВСЕ её настройки: padding/радиус/шрифт/
                  поведение. Глобальный пункт «Шрифты интерфейса» убран — он сводил
                  все шрифты в одну кучу без привязки к области, юзер не мог понять
                  «шрифт «Сайдбар» — это про какой именно сайдбар». Теперь шрифт
                  каждой области лежит рядом с её другими настройками. */}

              {/* 1. ТАБЫ */}
              <SettingsSectionHeader title="Табы" first />
              <SettingsSubSectionHeader title="Терминал" />
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

              {/* 2. ТЕРМИНАЛ — шрифт самого терминала + Таймлайн как часть терминала */}
              <SettingsSectionHeader title="Терминал" />
              <SettingsGrid4>
                <FontSizeSlider label="Шрифт" value={terminalFontSize} onChange={setTerminalFontSize} min={8} max={24} />
                <FontSizeSlider label="Шрифт SDK" value={sdkFontSize} onChange={setSdkFontSize} min={8} max={24} />
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

              {/* 3. САЙДБАР — файловый (Cmd+/): шрифт + превью файла + поведение */}
              <SettingsSectionHeader title="Сайдбар" />
              <SettingsGrid4>
                <FontSizeSlider label="Шрифт" value={sidebarFontSize} onChange={setSidebarFontSize} min={10} max={20} />
              </SettingsGrid4>

              <SettingsSubSectionHeader title="Превью файла" />
              <SettingsGrid4>
                <FontSizeSlider label="Шрифт" value={filePreviewFontSize} onChange={setFilePreviewFontSize} min={10} max={24} />
              </SettingsGrid4>

              <SettingsSubSectionHeader title="Поведение" />
              <SidebarBehaviorToggles />

              {/* 4. PROMPT PICKER — отдельная подсистема (overlay с быстрыми промптами) */}
              <SettingsSectionHeader title="Prompt picker" />
              <SettingsGrid4>
                <FontSizeSlider label="Шрифт" value={promptPickerFontSize} onChange={setPromptPickerFontSize} min={9} max={20} />
                <FontSizeSlider label="Отступ снизу" description="От низа viewport'а до picker'а" value={promptPickerBottomOffsetPx} onChange={setPromptPickerBottomOffsetPx} min={0} max={400} suffix="px" />
                <FontSizeSlider label="Отступ слева" description="0 — центр или прижатие к правому. >0 — прижатие к левому краю" value={promptPickerLeftOffsetPx} onChange={setPromptPickerLeftOffsetPx} min={0} max={2000} suffix="px" />
                <FontSizeSlider label="Отступ справа" description="0 — центр или прижатие к левому. >0 — приоритет: прижатие к правому краю" value={promptPickerRightOffsetPx} onChange={setPromptPickerRightOffsetPx} min={0} max={2000} suffix="px" />
              </SettingsGrid4>

              {/* 5. ЗАМЕТКИ + подсекция Превью CMD+hover */}
              <SettingsSectionHeader title="Заметки" />
              <SettingsGrid4>
                <FontSizeSlider label="Шрифт в сайдбаре" value={notesSidebarFontSize} onChange={setNotesSidebarFontSize} min={10} max={28} />
                <FontSizeSlider label="Шрифт раскрытый" value={notesExpandedFontSize} onChange={setNotesExpandedFontSize} min={10} max={28} />
              </SettingsGrid4>
              <div style={{ marginTop: '10px' }}>
                <LineNumbersToggle
                  checked={notesEditorShowLineNumbers}
                  onChange={setNotesEditorShowLineNumbers}
                  label="Номера строк"
                  description="Показывать колонку с номерами строк в редакторе заметки"
                  tooltip="Колонка с номерами строк слева в раскрытом редакторе заметок (slide-out)."
                />
              </div>

              <SettingsSubSectionHeader title="Превью CMD+hover" />
              <SettingsGrid4>
                <FontSizeSlider label="Шрифт" value={notesTooltipFontSize} onChange={setNotesTooltipFontSize} min={10} max={28} />
                <PaddingRow
                  valueX={notesEditorPaddingX} onChangeX={setNotesEditorPaddingX}
                  valueY={notesEditorPaddingY} onChangeY={setNotesEditorPaddingY}
                  maxX={48} maxY={48}
                />
                <FontSizeSlider label="Макс. ширина [resize]" description="Задаётся перетаскиванием правого края превью" value={Math.round(tabPreviewMaxWidth)} onChange={setTabPreviewMaxWidth} min={120} max={900} disabled />
                <FontSizeSlider label="Макс. высота" description="До неё растёт высота, дальше скролл" value={Math.round(tabPreviewMaxHeight)} onChange={setTabPreviewMaxHeight} min={80} max={900} />
              </SettingsGrid4>
              <div style={{ marginTop: '10px' }}>
                <LineNumbersToggle
                  checked={notesPreviewShowLineNumbers}
                  onChange={setNotesPreviewShowLineNumbers}
                  label="Номера строк"
                  description="Показывать колонку с номерами строк в превью (CMD+hover)"
                  tooltip="Колонка с номерами строк слева в CMD+hover превью заметки."
                />
              </div>
            </>
          )}

          {activeTab === 'colors' && (
            <>
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

              <div style={{ padding: '14px', backgroundColor: '#222', border: '1px solid #333', borderRadius: '10px', marginBottom: '12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: '10px' }}>
                  <div style={{ fontSize: '11px', fontWeight: '600', color: '#666', textTransform: 'uppercase' }}>
                    Claude Code команды
                  </div>
                  <button
                    type="button"
                    onClick={() => setClaudeCodeSettings(DEFAULT_CLAUDE_CODE_SETTINGS)}
                    style={{ ...vrSmallBtnStyle('neutral'), height: 24, padding: '0 8px' }}
                  >
                    reset
                  </button>
                </div>

                <SettingsSubSectionHeader title="Модели" />
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 6 }}>
                  {claudeCodeSettings.models.map((model, index) => (
                    <div key={`${index}-${model.id}`} style={{ display: 'grid', gridTemplateColumns: '70px 1fr', gap: 6, alignItems: 'center' }}>
                      <input
                        defaultValue={model.label}
                        onBlur={(e) => commitClaudeCodeModel(index, { label: e.currentTarget.value })}
                        onKeyDown={commitInputOnEnter}
                        style={{ ...vrFieldStyle, height: 28, fontSize: 11.5, padding: '5px 7px' }}
                      />
                      <input
                        defaultValue={model.id}
                        onBlur={(e) => commitClaudeCodeModel(index, { id: e.currentTarget.value })}
                        onKeyDown={commitInputOnEnter}
                        style={{ ...vrFieldStyle, height: 28, fontSize: 11.5, padding: '5px 7px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
                      />
                    </div>
                  ))}
                </div>

                <SettingsSubSectionHeader title="Effort" />
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(86px, 1fr))', gap: 6 }}>
                  {claudeCodeSettings.efforts.map((level, index) => (
                    <input
                      key={`${index}-${level}`}
                      defaultValue={level}
                      onBlur={(e) => commitClaudeCodeEffort(index, e.currentTarget.value)}
                      onKeyDown={commitInputOnEnter}
                      style={{ ...vrFieldStyle, height: 28, fontSize: 11.5, padding: '5px 7px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
                    />
                  ))}
                </div>
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
            </>
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

function VRGrip() {
  return (
    <div
      title="Перетащить"
      style={{ display: 'grid', gridTemplateColumns: '3px 3px', gap: 2, padding: '4px 2px', cursor: 'grab', flexShrink: 0 }}
    >
      {[...Array(6)].map((_, i) => (
        <span key={i} style={{ width: 3, height: 3, borderRadius: '50%', background: '#666' }} />
      ))}
    </div>
  );
}

function VRIconBtn({ children, onClick, title, danger, small }: { children: React.ReactNode; onClick: () => void; title: string; danger?: boolean; small?: boolean }) {
  const [hovered, setHovered] = useState(false);
  const size = small ? 24 : 28;
  return (
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
const VRTrashIcon = ({ small }: { small?: boolean }) => (
  <svg width={small ? 13 : 14} height={small ? 13 : 14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M3 6h18" />
    <path d="M8 6V4h8v2" />
    <path d="M6 6l1 15h10l1-15" />
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
