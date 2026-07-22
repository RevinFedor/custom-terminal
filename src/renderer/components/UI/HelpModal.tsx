import React, { useEffect, useRef, useState } from 'react';
import {
  Activity,
  CheckCircle2,
  Command,
  ExternalLink,
  FileText,
  FolderOpen,
  GitFork,
  History,
  Keyboard,
  ListPlus,
  Loader2,
  MousePointer2,
  Play,
  RotateCcw,
  Scissors,
  ShieldCheck,
  Square,
  Workflow,
  X,
} from 'lucide-react';

const { ipcRenderer, shell } = window.require('electron');

interface HelpModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface DiagnosticExportResult {
  success: boolean;
  cancelled?: boolean;
  error?: string;
  filePath?: string;
  bytes?: number;
  selectedLines?: number;
  droppedLines?: number;
  redactions?: { redactions?: number };
}

const COLORS = {
  modal: '#181a1f',
  surface: '#202329',
  surfaceRaised: '#252930',
  border: '#343941',
  borderSoft: '#2a2e35',
  text: '#f1f3f5',
  muted: '#9aa1aa',
  dim: '#6f7782',
  sapphire: '#74c7ec',
  green: '#a6e3a1',
  peach: '#fab387',
};

const PRODUCT_URL = 'https://f9922.tech/noted-terminal';

function openProductPage() {
  void shell.openExternal(PRODUCT_URL);
}

const HOTKEYS = [
  ['⌘ T', 'Новая вкладка'],
  ['⌘ W', 'Закрыть текущую вкладку'],
  ['⇧ ⌘ T', 'Вернуть последнюю закрытую вкладку'],
  ['⌘ B', 'Показать или скрыть файлы проекта'],
  ['⌘ ,', 'Открыть настройки'],
  ['⌘ \\', 'Показать или скрыть Timeline'],
  ['⌘ ]', 'Показать или скрыть историю'],
  ['⌘ F', 'Поиск по открытому терминалу'],
  ['⌥ V', 'Открыть библиотеку промптов'],
  ['⌘ G', 'Открыть проект в GT Editor'],
  ['⌘ + / −', 'Изменить общий масштаб текста'],
];

const RANGE_OPTIONS = [
  { minutes: 15, label: '15 минут' },
  { minutes: 60, label: '1 час' },
  { minutes: 24 * 60, label: '24 часа' },
];

function formatBytes(bytes?: number) {
  if (!Number.isFinite(bytes)) return '';
  if ((bytes || 0) < 1024) return `${bytes} Б`;
  if ((bytes || 0) < 1024 * 1024) return `${Math.round((bytes || 0) / 1024)} КБ`;
  return `${((bytes || 0) / (1024 * 1024)).toFixed(1)} МБ`;
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 style={{ margin: 0, color: COLORS.text, fontSize: 15, lineHeight: 1.3, fontWeight: 650 }}>
      {children}
    </h2>
  );
}

function ReferenceRow({
  icon,
  title,
  description,
  color,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  color: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${title}: открыть описание на сайте`}
      className="group"
      style={{
      display: 'grid',
      gridTemplateColumns: '28px minmax(0, 1fr)',
      gap: 10,
      width: '100%',
      padding: '11px 0',
      border: 'none',
      borderBottom: `1px solid ${COLORS.borderSoft}`,
      background: 'transparent',
      textAlign: 'left',
      cursor: 'pointer',
    }}>
      <div style={{ color, paddingTop: 1, display: 'flex', justifyContent: 'center' }}>{icon}</div>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: COLORS.text, fontSize: 12.5, lineHeight: 1.35, fontWeight: 600 }}>
          {title}
          <ExternalLink size={11} color={COLORS.dim} />
        </div>
        <div style={{ color: COLORS.muted, fontSize: 11.5, lineHeight: 1.5, marginTop: 2 }}>{description}</div>
      </div>
    </button>
  );
}

type HelpPageId = 'overview' | 'projects' | 'agent' | 'history' | 'external' | 'hotkeys';

const HELP_PAGES: Array<{
  id: HelpPageId;
  label: string;
  icon: React.ComponentType<{ size?: number; color?: string }>;
}> = [
  { id: 'overview', label: 'Обзор', icon: Activity },
  { id: 'projects', label: 'Проекты и вкладки', icon: Workflow },
  { id: 'agent', label: 'AI-сессии', icon: Command },
  { id: 'history', label: 'Timeline и History', icon: History },
  { id: 'external', label: 'Внешнее управление', icon: ExternalLink },
  { id: 'hotkeys', label: 'Горячие клавиши', icon: Keyboard },
];

function HelpPageHeader({ title, description }: { title: string; description: string }) {
  return (
    <header style={{ paddingBottom: 18, borderBottom: `1px solid ${COLORS.borderSoft}` }}>
      <h2 style={{ margin: 0, color: COLORS.text, fontSize: 18, lineHeight: 1.3, fontWeight: 680 }}>{title}</h2>
      <p style={{ margin: '7px 0 0', maxWidth: 720, color: COLORS.muted, fontSize: 12.5, lineHeight: 1.55 }}>{description}</p>
    </header>
  );
}

function HelpRule({
  title,
  children,
  accent = COLORS.sapphire,
}: {
  title: string;
  children: React.ReactNode;
  accent?: string;
}) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '3px minmax(0, 1fr)', gap: 12, padding: '13px 0', borderBottom: `1px solid ${COLORS.borderSoft}` }}>
      <span style={{ width: 3, minHeight: 28, borderRadius: 2, background: accent }} />
      <div>
        <div style={{ color: COLORS.text, fontSize: 12.5, lineHeight: 1.4, fontWeight: 650 }}>{title}</div>
        <div style={{ marginTop: 4, color: COLORS.muted, fontSize: 11.5, lineHeight: 1.55 }}>{children}</div>
      </div>
    </div>
  );
}

function DiagnosticExportDialog({ onClose }: { onClose: () => void }) {
  const [rangeMinutes, setRangeMinutes] = useState(60);
  const [includeMessageText, setIncludeMessageText] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [result, setResult] = useState<DiagnosticExportResult | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !exporting) {
        event.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [exporting, onClose]);

  const createExport = async () => {
    setExporting(true);
    setResult(null);
    try {
      const response = await ipcRenderer.invoke('diagnostics:export-log', {
        rangeMinutes,
        includeMessageText,
      });
      if (!response?.cancelled) setResult(response);
    } catch (error: any) {
      setResult({ success: false, error: error?.message || String(error) });
    } finally {
      setExporting(false);
    }
  };

  return (
    <div
      data-testid="diagnostic-export-dialog"
      role="presentation"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 22000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        background: 'rgba(5, 7, 10, 0.72)',
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) (event.currentTarget as HTMLElement).dataset.overlayDown = 'true';
      }}
      onMouseUp={(event) => {
        const overlay = event.currentTarget as HTMLElement;
        if (event.target === overlay && overlay.dataset.overlayDown === 'true' && !exporting) onClose();
        delete overlay.dataset.overlayDown;
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="diagnostic-export-title"
        style={{
          width: 'min(560px, 92vw)',
          maxHeight: '88vh',
          overflowY: 'auto',
          background: COLORS.modal,
          border: `1px solid ${COLORS.border}`,
          borderRadius: 8,
          boxShadow: '0 24px 70px rgba(0, 0, 0, 0.58)',
        }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 16,
          padding: '18px 20px 16px',
          borderBottom: `1px solid ${COLORS.borderSoft}`,
        }}>
          <div>
            <h2 id="diagnostic-export-title" style={{ margin: 0, color: COLORS.text, fontSize: 16, fontWeight: 650 }}>
              Создать TXT с логами
            </h2>
            <div style={{ color: COLORS.muted, fontSize: 11.5, lineHeight: 1.5, marginTop: 5 }}>
              Выберите период, в котором возникла ошибка.
            </div>
          </div>
          <button
            aria-label="Закрыть"
            onClick={onClose}
            disabled={exporting}
            style={{
              width: 28,
              height: 28,
              flexShrink: 0,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              border: 'none',
              borderRadius: 6,
              color: COLORS.muted,
              background: 'transparent',
              cursor: exporting ? 'not-allowed' : 'pointer',
            }}
          >
            <X size={16} />
          </button>
        </div>

        <div style={{ padding: 20 }}>
          <div style={{ color: COLORS.dim, fontSize: 10.5, fontWeight: 650, textTransform: 'uppercase', marginBottom: 8 }}>
            Период
          </div>
          <div role="radiogroup" aria-label="Период логов" style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
            border: `1px solid ${COLORS.border}`,
            borderRadius: 7,
            overflow: 'hidden',
          }}>
            {RANGE_OPTIONS.map((option, index) => {
              const selected = rangeMinutes === option.minutes;
              return (
                <button
                  key={option.minutes}
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setRangeMinutes(option.minutes)}
                  style={{
                    minHeight: 36,
                    border: 'none',
                    borderLeft: index === 0 ? 'none' : `1px solid ${COLORS.border}`,
                    background: selected ? 'rgba(116, 199, 236, 0.14)' : COLORS.surface,
                    color: selected ? COLORS.sapphire : COLORS.muted,
                    fontSize: 12,
                    fontWeight: selected ? 650 : 500,
                    cursor: 'pointer',
                  }}
                >
                  {option.label}
                </button>
              );
            })}
          </div>

          <label style={{
            display: 'grid',
            gridTemplateColumns: '18px minmax(0, 1fr)',
            gap: 10,
            alignItems: 'start',
            marginTop: 18,
            cursor: 'pointer',
          }}>
            <input
              type="checkbox"
              checked={includeMessageText}
              onChange={(event) => setIncludeMessageText(event.target.checked)}
              style={{ width: 15, height: 15, margin: '2px 0 0', accentColor: COLORS.sapphire }}
            />
            <span>
              <span style={{ display: 'block', color: COLORS.text, fontSize: 12.5, fontWeight: 600 }}>
                Добавить текст запросов и ответов
              </span>
              <span style={{ display: 'block', color: COLORS.muted, fontSize: 11.5, lineHeight: 1.5, marginTop: 3 }}>
                Включает текстовые фрагменты, которые уже попали в технический лог. По умолчанию они заменяются заглушкой.
              </span>
            </span>
          </label>

          <div style={{
            display: 'grid',
            gridTemplateColumns: '20px minmax(0, 1fr)',
            gap: 9,
            marginTop: 18,
            paddingTop: 15,
            borderTop: `1px solid ${COLORS.borderSoft}`,
          }}>
            <ShieldCheck size={16} color={COLORS.green} />
            <div style={{ color: COLORS.muted, fontSize: 11.5, lineHeight: 1.55 }}>
              API-ключи, cookies и авторизационные токены удаляются всегда. ID вкладок, ID сессий, пути, процессы и технические кадры терминала сохраняются: без них нельзя доказать причину ошибки запуска или восстановления.
            </div>
          </div>

          {result && (
            <div style={{
              marginTop: 18,
              paddingTop: 15,
              borderTop: `1px solid ${COLORS.borderSoft}`,
            }}>
              {result.success ? (
                <div style={{ display: 'grid', gridTemplateColumns: '20px minmax(0, 1fr)', gap: 9 }}>
                  <CheckCircle2 size={16} color={COLORS.green} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ color: COLORS.text, fontSize: 12.5, fontWeight: 600 }}>
                      TXT создан{result.bytes ? ` · ${formatBytes(result.bytes)}` : ''}
                    </div>
                    <div style={{ color: COLORS.dim, fontSize: 10.5, lineHeight: 1.45, marginTop: 4, overflowWrap: 'anywhere', fontFamily: 'monospace' }}>
                      {result.filePath}
                    </div>
                    <button
                      onClick={() => result.filePath && shell.showItemInFolder(result.filePath)}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        marginTop: 10,
                        padding: '6px 9px',
                        border: `1px solid ${COLORS.border}`,
                        borderRadius: 6,
                        background: COLORS.surface,
                        color: COLORS.text,
                        fontSize: 11.5,
                        cursor: 'pointer',
                      }}
                    >
                      <FolderOpen size={14} />
                      Показать в Finder
                    </button>
                  </div>
                </div>
              ) : (
                <div style={{ color: '#f38ba8', fontSize: 11.5, lineHeight: 1.5 }}>
                  Не удалось создать TXT: {result.error || 'неизвестная ошибка'}
                </div>
              )}
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
            <button
              onClick={onClose}
              disabled={exporting}
              style={{
                minHeight: 34,
                padding: '0 13px',
                border: `1px solid ${COLORS.border}`,
                borderRadius: 6,
                background: 'transparent',
                color: COLORS.muted,
                fontSize: 12,
                cursor: exporting ? 'not-allowed' : 'pointer',
              }}
            >
              Отмена
            </button>
            <button
              onClick={createExport}
              disabled={exporting}
              style={{
                minWidth: 128,
                minHeight: 34,
                padding: '0 13px',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 7,
                border: 'none',
                borderRadius: 6,
                background: exporting ? '#35515d' : COLORS.sapphire,
                color: '#101418',
                fontSize: 12,
                fontWeight: 700,
                cursor: exporting ? 'wait' : 'pointer',
              }}
            >
              {exporting ? <Loader2 size={14} className="animate-spin" /> : <FileText size={14} />}
              {exporting ? 'Собираю…' : 'Создать TXT'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function HelpModal({ isOpen, onClose }: HelpModalProps) {
  const [diagnosticOpen, setDiagnosticOpen] = useState(false);
  const [page, setPage] = useState<HelpPageId>('overview');
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) {
      setDiagnosticOpen(false);
      setPage('overview');
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || diagnosticOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [diagnosticOpen, isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      ref={overlayRef}
      data-testid="help-modal"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 21000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
        background: 'rgba(5, 7, 10, 0.72)',
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) (event.currentTarget as HTMLElement).dataset.overlayDown = 'true';
      }}
      onMouseUp={(event) => {
        const overlay = event.currentTarget as HTMLElement;
        if (event.target === overlay && overlay.dataset.overlayDown === 'true') onClose();
        delete overlay.dataset.overlayDown;
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-modal-title"
        style={{
          width: 'min(980px, 95vw)',
          height: 'min(760px, 88vh)',
          minHeight: 440,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          background: COLORS.modal,
          border: `1px solid ${COLORS.border}`,
          borderRadius: 8,
          boxShadow: '0 28px 80px rgba(0, 0, 0, 0.62)',
        }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div style={{
          minHeight: 62,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 20,
          padding: '12px 16px 12px 22px',
          borderBottom: `1px solid ${COLORS.borderSoft}`,
          flexShrink: 0,
        }}>
          <div style={{ minWidth: 0 }}>
            <h1 id="help-modal-title" style={{ margin: 0, color: COLORS.text, fontSize: 17, fontWeight: 680 }}>
              Справка
            </h1>
            <div style={{ color: COLORS.muted, fontSize: 11.5, marginTop: 3 }}>
              Terminal-native среда для Claude Code и Codex CLI
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
            <span className="hidden min-[720px]:inline" style={{ color: COLORS.dim, fontSize: 11.5 }}>Возникла ошибка?</span>
            <button
              data-testid="diagnostic-export-open"
              onClick={() => setDiagnosticOpen(true)}
              style={{
                height: 32,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 7,
                padding: '0 10px',
                border: `1px solid ${COLORS.border}`,
                borderRadius: 6,
                background: COLORS.surface,
                color: COLORS.text,
                fontSize: 11.5,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              <FileText size={14} color={COLORS.peach} />
              Создать TXT с логами
            </button>
            <button
              aria-label="Закрыть справку"
              onClick={onClose}
              style={{
                width: 30,
                height: 30,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                border: 'none',
                borderRadius: 6,
                background: 'transparent',
                color: COLORS.muted,
                cursor: 'pointer',
              }}
            >
              <X size={17} />
            </button>
          </div>
        </div>

        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          <nav aria-label="Разделы справки" style={{ width: 184, flexShrink: 0, padding: '14px 10px', overflowY: 'auto', borderRight: `1px solid ${COLORS.borderSoft}`, background: '#15171b' }}>
            {HELP_PAGES.map((item) => {
              const active = page === item.id;
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-current={active ? 'page' : undefined}
                  onClick={() => setPage(item.id)}
                  className="hover:bg-white/[0.05]"
                  style={{
                    width: '100%',
                    minHeight: 36,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 9,
                    padding: '7px 9px',
                    border: 'none',
                    borderRadius: 5,
                    background: active ? 'rgba(116, 199, 236, 0.12)' : 'transparent',
                    color: active ? COLORS.sapphire : COLORS.muted,
                    textAlign: 'left',
                    fontSize: 11.5,
                    lineHeight: 1.3,
                    fontWeight: active ? 650 : 500,
                    cursor: 'pointer',
                  }}
                >
                  <Icon size={14} color={active ? COLORS.sapphire : COLORS.dim} />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>

          <div style={{ flex: 1, overflowY: 'auto', minWidth: 0 }}>
            <div style={{ width: 'min(740px, calc(100% - 40px))', margin: '0 auto', padding: '26px 0 34px' }}>
              {page === 'overview' && <>
              <section>
              <SectionTitle>Модель продукта</SectionTitle>
              <p style={{ margin: '8px 0 0', maxWidth: 780, color: COLORS.muted, fontSize: 12.5, lineHeight: 1.6 }}>
                Живой Claude/Codex остаётся процессом в PTY и источником исполнения. JSONL/rollout отвечает за историю. Desktop, mobile и MCP/API управляют той же сессией без SDK или headless-режима как основного пути.
              </p>

              <div className="grid grid-cols-1 min-[720px]:grid-cols-3" style={{ marginTop: 16, gap: 0 }}>
                <div style={{ padding: '4px 18px 4px 0', minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: COLORS.text, fontSize: 12, fontWeight: 650 }}>
                    <Command size={15} color={COLORS.sapphire} />
                    PTY / исполнение
                  </div>
                  <p style={{ margin: '6px 0 0', color: COLORS.muted, fontSize: 11.5, lineHeight: 1.5 }}>
                    Реальный CLI, локальный логин и подписка, ручной и программный ввод в одном terminal state.
                  </p>
                </div>
                <div className="min-[720px]:border-l min-[720px]:border-r" style={{ padding: '4px 18px', borderColor: COLORS.borderSoft, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: COLORS.text, fontSize: 12, fontWeight: 650 }}>
                    <FileText size={15} color={COLORS.green} />
                    JSONL / история
                  </div>
                  <p style={{ margin: '6px 0 0', color: COLORS.muted, fontSize: 11.5, lineHeight: 1.5 }}>
                    Активная ветка, Timeline, читаемая History, контекст и операции над историей.
                  </p>
                </div>
                <div style={{ padding: '4px 0 4px 18px', minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: COLORS.text, fontSize: 12, fontWeight: 650 }}>
                    <Workflow size={15} color={COLORS.peach} />
                    UI + MCP/API
                  </div>
                  <p style={{ margin: '6px 0 0', color: COLORS.muted, fontSize: 11.5, lineHeight: 1.5 }}>
                    Отправка, stop, статусы, история и оркестрация между живыми сессиями.
                  </p>
                </div>
              </div>

              <div style={{
                display: 'grid',
                gridTemplateColumns: '24px minmax(0, 1fr)',
                gap: 8,
                alignItems: 'start',
                marginTop: 18,
                paddingTop: 14,
                borderTop: `1px solid ${COLORS.borderSoft}`,
              }}>
                <Activity size={15} color="#f5a3bb" style={{ marginTop: 1 }} />
                <div style={{ color: COLORS.muted, fontSize: 11.5, lineHeight: 1.5 }}>
                  Доставка prompt, текущий turn, готовность поля ввода и жизнь процесса — разные состояния. Их подтверждают hooks, OSC и rollout-события; таймеры используются только как fallback.
                </div>
              </div>
              </section>

              <section style={{ marginTop: 28, paddingTop: 24, borderTop: `1px solid ${COLORS.borderSoft}` }}>
              <div className="grid grid-cols-1 min-[760px]:grid-cols-[minmax(0,1fr)_minmax(240px,330px)]" style={{ gap: 30, alignItems: 'center' }}>
                <div>
                  <SectionTitle>Подсказки интерфейса</SectionTitle>
                  <div style={{ display: 'flex', gap: 10, marginTop: 10, color: COLORS.muted, fontSize: 12, lineHeight: 1.55 }}>
                    <MousePointer2 size={17} color={COLORS.sapphire} style={{ flexShrink: 0, marginTop: 1 }} />
                    <span>Откройте меню <strong style={{ color: COLORS.text }}>?</strong> и включите «Подсказки интерфейса». После этого наведение на контрол покажет его действие. Escape выключает режим.</span>
                  </div>
                </div>
                <div style={{
                  aspectRatio: '16 / 9',
                  width: '100%',
                  minHeight: 140,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 9,
                  border: `1px dashed ${COLORS.border}`,
                  borderRadius: 7,
                  background: '#111318',
                  color: COLORS.dim,
                }}>
                  <Play size={17} color={COLORS.sapphire} fill="currentColor" />
                  <div style={{ fontSize: 11.5, fontWeight: 600 }}>Режим подсказок</div>
                  <div style={{ fontSize: 10.5 }}>место для короткого видео</div>
                </div>
              </div>
            </section>

            <section style={{ marginTop: 28, paddingTop: 24, borderTop: `1px solid ${COLORS.borderSoft}` }}>
              <SectionTitle>Ключевые операции</SectionTitle>
              <div className="grid grid-cols-1 min-[720px]:grid-cols-2" style={{ columnGap: 30, marginTop: 8 }}>
                <ReferenceRow
                  icon={<History size={17} />}
                  title="Timeline / History"
                  description="Активная ветка и структурированный transcript вместо сырого terminal scrollback."
                  color={COLORS.sapphire}
                  onClick={openProductPage}
                />
                <ReferenceRow
                  icon={<GitFork size={17} />}
                  title="Fork"
                  description="Новая вкладка с копией истории; исходная сессия не меняется."
                  color={COLORS.green}
                  onClick={openProductPage}
                />
                <ReferenceRow
                  icon={<RotateCcw size={17} />}
                  title="Rewind"
                  description="Возврат к выбранной итерации и продолжение с другой точки."
                  color={COLORS.peach}
                  onClick={openProductPage}
                />
                <ReferenceRow
                  icon={<Scissors size={17} />}
                  title="Edit Range"
                  description="Замена шумного диапазона истории компактным summary."
                  color="#c4b5fd"
                  onClick={openProductPage}
                />
                <ReferenceRow
                  icon={<ListPlus size={17} />}
                  title="Run after"
                  description="Event-driven очередь prompt'ов, в том числе после завершения другой вкладки."
                  color="#f5a3bb"
                  onClick={openProductPage}
                />
                <ReferenceRow
                  icon={<Square size={17} />}
                  title="Interrupt / Stop process"
                  description="Остановка текущего turn и завершение процесса остаются разными командами."
                  color="#f38ba8"
                  onClick={openProductPage}
                />
              </div>
              </section>
              </>}

              {page === 'projects' && (
                <article>
                  <HelpPageHeader
                    title="Проекты и вкладки"
                    description="Основные жесты для навигации, группировки и управления живыми процессами."
                  />
                  <HelpRule title="Проект в верхней строке">
                    Клик открывает проект, двойной клик переименовывает, средняя кнопка закрывает. Вкладки можно перетаскивать между проектами.
                  </HelpRule>
                  <HelpRule title="Выбор вкладок" accent={COLORS.green}>
                    Обычный клик переключает вкладку. Cmd+click добавляет её в multi-select, Shift+click выбирает диапазон. Двойной клик переименовывает, ПКМ открывает операции вкладки и группы.
                  </HelpRule>
                  <HelpRule title="Restart, Stop и Close" accent={COLORS.peach}>
                    Restart перезапускает команду. На правой кнопке dev-server Cmd+click останавливает процесс без перезапуска. Close удаляет саму вкладку; это другая операция.
                  </HelpRule>
                  <HelpRule title="Run after" accent="#f5a3bb">
                    Очередь может ждать штатного завершения текущей или другой AI-вкладки. Cmd+click на правой process-кнопке в этом режиме удаляет подписку, а не останавливает процесс.
                  </HelpRule>
                </article>
              )}

              {page === 'agent' && (
                <article>
                  <HelpPageHeader
                    title="AI-сессии"
                    description="Нижняя панель управляет текущим живым Claude/Codex, а не отдельным API-чатом."
                  />
                  <HelpRule title="Start / Continue / Stop process">
                    Start запускает CLI, Continue восстанавливает сессию, Stop process завершает процесс. Последнее не равно прерыванию только текущего ответа.
                  </HelpRule>
                  <HelpRule title="Prompt, copy и dictation" accent={COLORS.green}>
                    Copy оставляет текст в поле; +clear копирует и очищает. Кнопка микрофона запускает и завершает запись; Cmd+click открывает её историю.
                  </HelpRule>
                  <HelpRule title="Enter и ^C" accent={COLORS.peach}>
                    Enter отправляет текущий ввод в TUI. `^C` передаёт управляющую клавишу в сам CLI: результат зависит от текущего экрана и не равен Stop process.
                  </HelpRule>
                  <HelpRule title="Model, effort и busy reset" accent="#c4b5fd">
                    Меню model/provider открываются наведением и закрепляются кликом. Busy reset сбрасывает только локальную блокировку UI; он не доказывает завершение и не отменяет команду.
                  </HelpRule>
                </article>
              )}

              {page === 'history' && (
                <article>
                  <HelpPageHeader
                    title="Timeline и History"
                    description="Timeline навигирует по активной ветке, History показывает тот же диалог как читаемый документ."
                  />
                  <HelpRule title="Запись Timeline">
                    Клик прокручивает к точке в Terminal или History. Cmd+click гарантированно открывает History. Двойной клик начинает выбор диапазона, ПКМ открывает операции.
                  </HelpRule>
                  <HelpRule title="Rich preview" accent={COLORS.green}>
                    Cmd+hover на записи, заметке или маркере открывает содержимое. Cmd+Shift закрепляет окно. Это отдельный режим, поэтому короткая подсказка `?` на том же триггере не показывается.
                  </HelpRule>
                  <HelpRule title="Range, Rewind и Compact" accent={COLORS.peach}>
                    Range выделяет часть истории для удаления или summary. Rewind возвращает сессию к выбранной точке. Alt+hover на Compact в History временно показывает summary, клик закрепляет.
                  </HelpRule>
                </article>
              )}

              {page === 'external' && (
                <article>
                  <HelpPageHeader
                    title="Внешнее управление"
                    description="Mobile, MCP и внешние API-клиенты управляют теми же вкладками и процессами, которые открыты на desktop."
                  />
                  <HelpRule title="Доставка и завершение">
                    Факт доставки prompt не означает, что ответ готов. Готовность, busy, interrupt и жизнь процесса отделены и подтверждаются своими событиями.
                  </HelpRule>
                  <HelpRule title="MCP" accent={COLORS.green}>
                    Журнал MCP в status bar показывает внешние запуски и позволяет вернуться к целевой вкладке. Terminal output остаётся fallback-каналом, а не доказательством завершения turn.
                  </HelpRule>
                  <HelpRule title="Remote URL и диагностика" accent={COLORS.peach}>
                    URL открывает mobile surface; ПКМ копирует адрес вместе с токеном. При ошибке откройте `?` → «Открыть справку» → «Создать TXT с логами».
                  </HelpRule>
                </article>
              )}

              {page === 'hotkeys' && (
                <section>
                  <HelpPageHeader
                    title="Горячие клавиши"
                    description="Глобальная навигация и действия текущего workspace."
                  />
                  <div className="grid grid-cols-1 min-[700px]:grid-cols-2" style={{ columnGap: 28, marginTop: 12 }}>
                    {HOTKEYS.map(([keys, label]) => (
                      <div key={keys} style={{
                        minHeight: 38,
                        display: 'grid',
                        gridTemplateColumns: '88px minmax(0, 1fr)',
                        alignItems: 'center',
                        gap: 10,
                        borderBottom: `1px solid ${COLORS.borderSoft}`,
                      }}>
                        <kbd style={{ color: COLORS.text, fontSize: 11, fontFamily: 'inherit', fontWeight: 650 }}>{keys}</kbd>
                        <span style={{ color: COLORS.muted, fontSize: 11.5, lineHeight: 1.35 }}>{label}</span>
                      </div>
                    ))}
                  </div>
                </section>
              )}

            </div>
          </div>
        </div>
      </div>

      {diagnosticOpen && <DiagnosticExportDialog onClose={() => setDiagnosticOpen(false)} />}
    </div>
  );
}
