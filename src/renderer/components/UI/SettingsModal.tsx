import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useUIStore } from '../../store/useUIStore';
import { usePromptsStore, AIPrompt, AIModel, ThinkingLevel } from '../../store/usePromptsStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useMirrorStatusStore } from '../../store/useMirrorStatusStore';
import Tooltip from './Tooltip';
import { HexColorPicker } from 'react-colorful';
import { Trash2, Plus } from 'lucide-react';

const { ipcRenderer } = window.require('electron');

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

type SettingsTab = 'shortcuts' | 'fonts' | 'colors' | 'ai';

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

  const requestCreateNow = async () => {
    if (!activeProjectId) return;
    try {
      await window.require('electron').ipcRenderer.invoke('mirror:create-now', { projectId: activeProjectId });
    } catch {}
  };

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

// ProcessBarEditor — настройка полоски процесса (3px слева в табе, мигает пока PTY жив).
// Юзер контролирует: enabled (мигание on/off), colorA (нижняя/статичная фаза),
// colorB (верхняя фаза), durationMs (длительность цикла, 300..6000ms).
// Live-превью полоски (статичная или с анимацией) показано над контролами.
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
  const previewBar = (
    <div style={{
      position: 'relative', width: '100%', height: '32px',
      backgroundColor: '#252526', border: '1px solid #333',
      borderRadius: '6px', overflow: 'hidden',
    }}>
      <div
        className={processBar.enabled ? 'tab-process-bar-busy' : 'tab-process-bar-static'}
        style={{
          position: 'absolute',
          [processBar.position === 'right' ? 'right' : 'left']: 0,
          top: 0, bottom: 0, width: '3px',
          overflow: 'hidden',
          ['--process-bar-color-a' as any]: processBar.colorA,
          ['--process-bar-color-b' as any]: processBar.colorB,
          ['--process-bar-duration' as any]: `${processBar.durationMs}ms`,
        }}
      >
        {/* Блик AI-busy крутится в превью постоянно — юзер видит как он
            наслаивается на пульс цветом. В рантайме блик появляется только
            когда AI стримит (isBusy). */}
        <div className="tab-process-bar-ai-shimmer-overlay" />
      </div>
      <div style={{
        position: 'absolute', left: 12, right: 12, top: '50%', transform: 'translateY(-50%)',
        fontSize: '11px', color: '#888', textAlign: 'center',
      }}>
        {processBar.enabled ? `пульс ${(processBar.durationMs / 1000).toFixed(1)}s` : 'статика'} · {processBar.position === 'right' ? 'справа' : 'слева'} · блик AI
      </div>
    </div>
  );

  const colorChip = (which: 'a' | 'b') => {
    const current = which === 'a' ? processBar.colorA : processBar.colorB;
    const draft = which === 'a' ? hexDraftA : hexDraftB;
    const setDraft = which === 'a' ? setHexDraftA : setHexDraftB;
    const disabled = which === 'b' && !processBar.enabled;

    return (
      <div style={{
        position: 'relative',
        display: 'inline-flex', alignItems: 'center', gap: '6px',
        padding: '4px 8px',
        backgroundColor: '#1e1e1e', border: '1px solid #333', borderRadius: '8px',
        opacity: disabled ? 0.4 : 1,
        flexShrink: 0,
      }}>
        <button
          onClick={() => { if (!disabled) setPickerOpen(pickerOpen === which ? null : which); }}
          style={{
            width: 16, height: 16, borderRadius: '50%',
            backgroundColor: current,
            border: '2px solid rgba(255,255,255,0.15)',
            cursor: disabled ? 'not-allowed' : 'pointer',
            flexShrink: 0, padding: 0,
          }}
          title="Палитра"
        />
        <span style={{ fontSize: '11px', color: '#888' }}>
          {which === 'a' ? 'A' : 'B'}
        </span>
        <input
          type="text"
          disabled={disabled}
          value={(draft ?? current).replace(/^#/, '')}
          onChange={(e) => {
            const next = `#${e.target.value}`;
            setDraft(next);
            const norm = normalizeHexValue(next);
            if (norm) setProcessBar(which === 'a' ? { colorA: norm } : { colorB: norm });
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
              onChange={(c) => setProcessBar(which === 'a' ? { colorA: c.toUpperCase() } : { colorB: c.toUpperCase() })}
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
        {/* Enable toggle */}
        <label
          className="flex items-center gap-2 cursor-pointer select-none"
          style={{
            padding: '4px 8px',
            backgroundColor: '#1e1e1e', border: '1px solid #333', borderRadius: '8px',
            flexShrink: 0,
          }}
        >
          <div
            className="relative w-7 h-3.5 rounded-full transition-colors shrink-0"
            style={{ backgroundColor: processBar.enabled ? 'rgba(74, 222, 128, 0.4)' : 'rgba(255,255,255,0.1)' }}
            onClick={() => setProcessBar({ enabled: !processBar.enabled })}
          >
            <div
              className="absolute top-0.5 w-2.5 h-2.5 rounded-full transition-all"
              style={{
                left: processBar.enabled ? '15px' : '2px',
                backgroundColor: processBar.enabled ? '#4ade80' : '#666',
              }}
            />
          </div>
          <span style={{ fontSize: '11px', color: '#ccc' }}>Пульс</span>
        </label>

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

        {/* Duration — компактный inline-chip */}
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: '6px',
          padding: '4px 8px',
          backgroundColor: '#1e1e1e', border: '1px solid #333', borderRadius: '8px',
          opacity: processBar.enabled ? 1 : 0.4,
          flexShrink: 0,
        }}>
          <span style={{ fontSize: '11px', color: '#888' }}>Цикл</span>
          <input
            type="number"
            disabled={!processBar.enabled}
            min={300}
            max={6000}
            step={100}
            value={processBar.durationMs}
            onChange={(e) => setProcessBar({ durationMs: Number(e.target.value) })}
            style={{
              width: '54px', padding: '3px 6px',
              backgroundColor: '#1a1a1a', border: '1px solid #333', borderRadius: '6px',
              color: '#ccc', fontSize: '11px', fontFamily: 'monospace', outline: 'none',
              textAlign: 'right',
            }}
          />
          <span style={{ fontSize: '10px', color: '#555' }}>ms</span>
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

  // Programmatic open with requested tab (e.g. ПКМ на SemanticIndexButton).
  // Срабатывает на переходе isOpen=false→true когда initialTab задан.
  // Не блокирует ручное переключение табов после открытия — пользователь
  // нажал ПКМ → попал на «Системные», дальше может кликать другие табы.
  const prevIsOpenRef = useRef(isOpen);
  useEffect(() => {
    if (isOpen && !prevIsOpenRef.current && initialTab) {
      const valid: SettingsTab[] = ['shortcuts', 'fonts', 'colors', 'ai'];
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
  const timelineLineClamp = useUIStore((s) => s.timelineLineClamp);
  const setTimelineLineClamp = useUIStore((s) => s.setTimelineLineClamp);
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
  const claudeMdMirrorEnabled = useUIStore((s) => s.claudeMdMirrorEnabled);
  const setClaudeMdMirrorEnabled = useUIStore((s) => s.setClaudeMdMirrorEnabled);
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
  const [localInsertionFilePaths, setLocalInsertionFilePaths] = useState<string[]>([]);
  const [insertionFileInputs, setInsertionFileInputs] = useState<{ value: string; valid: boolean | null }[]>([]);
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
  const [localPromptFilePaths, setLocalPromptFilePaths] = useState<string[]>([]);
  const [filePathInputs, setFilePathInputs] = useState<{ value: string; valid: boolean | null }[]>([]);
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
            { id: 'shortcuts', label: 'Горячие клавиши' }
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

              {/* 2. ТЕРМИНАЛ — шрифт самого терминала + Таймлайн как часть терминала */}
              <SettingsSectionHeader title="Терминал" />
              <SettingsGrid4>
                <FontSizeSlider label="Шрифт" value={terminalFontSize} onChange={setTerminalFontSize} min={8} max={24} />
                <FontSizeSlider label="Шрифт SDK" value={sdkFontSize} onChange={setSdkFontSize} min={8} max={24} />
              </SettingsGrid4>

              <SettingsSubSectionHeader title="Таймлайн" />
              <SettingsGrid4>
                <FontSizeSlider label="Шрифт" value={timelineFontSize} onChange={setTimelineFontSize} min={10} max={18} />
                <FontSizeSlider label="Строки" value={timelineLineClamp} onChange={setTimelineLineClamp} min={1} max={10} suffix="" />
              </SettingsGrid4>

              <SettingsSubSectionHeader title="Run after" />
              <SettingsGrid4>
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

              {/* Семантическая индексация — единственная честно «системная» настройка
                  с runtime-эффектом. Управляет --parallel флагом, который main
                  передаёт build-index.sh при запуске. Выше 20 параллельных claude'ов
                  Anthropic жёстко 429-ит; ниже 4 — индексация N=70 файлов начинает
                  занимать минуты. Default 10 выбран как ровно тот же default, что
                  стоит в самом скрипте (MAX_PARALLEL=10) — UI и CLI consistency.
                  Все визуальные настройки (статусы вкладок, полоска процесса) переехали
                  в «Размеры» — они влияют на UI, а не на админ-инфраструктуру. */}
              <div style={{ padding: '14px', backgroundColor: '#222', border: '1px solid #333', borderRadius: '10px', marginBottom: '12px' }}>
                <div style={{ fontSize: '11px', fontWeight: '600', color: '#666', marginBottom: '10px', textTransform: 'uppercase' }}>
                  Семантическая индексация
                </div>
                <FontSizeSlider
                  label="Параллельные воркеры"
                  description="Сколько claude/Haiku одновременно при запуске индексации"
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
                      {/* File attachments */}
                      <div style={{ marginTop: '8px', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        {localInsertionFilePaths.map((fp, idx) => (
                          <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                            <span style={{ fontSize: '10px', color: '#666', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, direction: 'rtl', textAlign: 'left' }}>{fp}</span>
                            <button onClick={(e) => {
                              e.stopPropagation();
                              const updated = localInsertionFilePaths.filter((_, i) => i !== idx);
                              setLocalInsertionFilePaths(updated);
                              saveCurrentInsertion(updated);
                            }} style={{ background: 'none', border: 'none', color: '#666', fontSize: '12px', cursor: 'pointer', padding: '0 2px', flexShrink: 0 }}>✕</button>
                          </div>
                        ))}
                        {insertionFileInputs.map((input, idx) => (
                          <div key={`input-${idx}`} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                            <input type="text" autoFocus value={input.value}
                              onChange={(e) => { const u = [...insertionFileInputs]; u[idx] = { value: e.target.value, valid: null }; setInsertionFileInputs(u); }}
                              onBlur={async () => {
                                const val = insertionFileInputs[idx]?.value?.trim();
                                if (!val) { setInsertionFileInputs(prev => prev.filter((_, i) => i !== idx)); return; }
                                const result = await ipcRenderer.invoke('ai-prompts:check-file', val);
                                if (result.exists) {
                                  const updated = [...localInsertionFilePaths, val];
                                  setLocalInsertionFilePaths(updated);
                                  setInsertionFileInputs(prev => prev.filter((_, i) => i !== idx));
                                  saveCurrentInsertion(updated);
                                } else {
                                  const u = [...insertionFileInputs]; u[idx] = { ...u[idx], valid: false }; setInsertionFileInputs(u);
                                }
                              }}
                              onKeyDown={(e) => { if (e.key === 'Escape') setInsertionFileInputs(prev => prev.filter((_, i) => i !== idx)); }}
                              placeholder="/Users/..."
                              style={{ flex: 1, padding: '3px 6px', backgroundColor: '#1a1a1a', border: `1px solid ${input.valid === false ? '#ef4444' : '#444'}`, borderRadius: '4px', color: '#aaa', fontSize: '10px', fontFamily: 'monospace', outline: 'none' }}
                            />
                            <button onClick={(e) => { e.stopPropagation(); setInsertionFileInputs(prev => prev.filter((_, i) => i !== idx)); }} style={{ background: 'none', border: 'none', color: '#666', fontSize: '12px', cursor: 'pointer', padding: '0 2px', flexShrink: 0 }}>✕</button>
                          </div>
                        ))}
                        <div style={{ display: 'flex', gap: '4px' }}>
                          <button onClick={(e) => { e.stopPropagation(); setInsertionFileInputs(prev => [...prev, { value: '', valid: null }]); }} style={{ padding: '2px 6px', backgroundColor: 'transparent', color: '#666', border: '1px solid #333', borderRadius: '4px', fontSize: '10px', cursor: 'pointer' }}>+ путь</button>
                          <button onClick={async (e) => {
                            e.stopPropagation();
                            const result = await ipcRenderer.invoke('ai-prompts:select-file');
                            if (result.success && result.data) {
                              const updated = [...localInsertionFilePaths, result.data];
                              setLocalInsertionFilePaths(updated);
                              saveCurrentInsertion(updated);
                            }
                          }} style={{ padding: '2px 6px', backgroundColor: 'transparent', color: '#666', border: '1px solid #333', borderRadius: '4px', fontSize: '10px', cursor: 'pointer' }}>+ файл</button>
                        </div>
                      </div>
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
                        filePaths: localPromptFilePaths,
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

                        {/* File attachments */}
                        <div style={{ marginTop: '8px', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: '4px' }}>
                          {/* Existing file paths */}
                          {localPromptFilePaths.map((fp, idx) => (
                            <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                              <span style={{ fontSize: '10px', color: '#666', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, direction: 'rtl', textAlign: 'left' }}>
                                {fp}
                              </span>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  const updated = localPromptFilePaths.filter((_, i) => i !== idx);
                                  setLocalPromptFilePaths(updated);
                                  saveField({ filePaths: updated });
                                }}
                                style={{ background: 'none', border: 'none', color: '#666', fontSize: '12px', cursor: 'pointer', padding: '0 2px', flexShrink: 0 }}
                              >
                                ✕
                              </button>
                            </div>
                          ))}
                          {/* Pending file path inputs */}
                          {filePathInputs.map((input, idx) => (
                            <div key={`input-${idx}`} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                              <input
                                type="text"
                                autoFocus
                                value={input.value}
                                onChange={(e) => {
                                  const updated = [...filePathInputs];
                                  updated[idx] = { value: e.target.value, valid: null };
                                  setFilePathInputs(updated);
                                }}
                                onBlur={async () => {
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
                                    const upd = [...filePathInputs];
                                    upd[idx] = { ...upd[idx], valid: false };
                                    setFilePathInputs(upd);
                                  }
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === 'Escape') {
                                    setFilePathInputs(prev => prev.filter((_, i) => i !== idx));
                                  }
                                }}
                                placeholder="/Users/..."
                                style={{
                                  flex: 1, padding: '3px 6px', backgroundColor: '#1a1a1a',
                                  border: `1px solid ${input.valid === false ? '#ef4444' : '#444'}`,
                                  borderRadius: '4px', color: '#aaa', fontSize: '10px', fontFamily: 'monospace', outline: 'none'
                                }}
                              />
                              <button
                                onClick={(e) => { e.stopPropagation(); setFilePathInputs(prev => prev.filter((_, i) => i !== idx)); }}
                                style={{ background: 'none', border: 'none', color: '#666', fontSize: '12px', cursor: 'pointer', padding: '0 2px', flexShrink: 0 }}
                              >
                                ✕
                              </button>
                            </div>
                          ))}
                          {/* Add file buttons */}
                          <div style={{ display: 'flex', gap: '4px' }}>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setFilePathInputs(prev => [...prev, { value: '', valid: null }]);
                              }}
                              style={{ padding: '2px 6px', backgroundColor: 'transparent', color: '#666', border: '1px solid #333', borderRadius: '4px', fontSize: '10px', cursor: 'pointer' }}
                            >
                              + путь
                            </button>
                            <button
                              onClick={async (e) => {
                                e.stopPropagation();
                                const result = await ipcRenderer.invoke('ai-prompts:select-file');
                                if (result.success && result.data) {
                                  const updated = [...localPromptFilePaths, result.data];
                                  setLocalPromptFilePaths(updated);
                                  saveField({ filePaths: updated });
                                }
                              }}
                              style={{ padding: '2px 6px', backgroundColor: 'transparent', color: '#666', border: '1px solid #333', borderRadius: '4px', fontSize: '10px', cursor: 'pointer' }}
                            >
                              + файл
                            </button>
                          </div>
                        </div>

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
