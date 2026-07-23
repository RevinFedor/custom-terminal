import React, { useEffect, useRef, useState } from 'react';
import {
  Activity,
  CheckCircle2,
  Command,
  FileText,
  FolderOpen,
  Loader2,
  MousePointer2,
  Play,
  RotateCcw,
  ShieldCheck,
  Workflow,
  X,
} from 'lucide-react';
import { useControlHelpStore } from '../../store/useControlHelpStore';

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

const COMPLEX_HELP_TOPICS = [
  {
    id: 'restart-after',
    label: 'Restart after',
    title: 'Перезапуск после работы AI-вкладки',
    summary: 'Привязывает terminal/dev-server вкладку к штатному завершению работы одной или нескольких AI-вкладок и запускает выбранную команду.',
    steps: [
      'Откройте контекстное меню terminal/dev-server вкладки и в Restart after выберите AI-вкладки, окончания которых нужно ждать.',
      'В Script выберите команду. Если команда не выбрана явно, интерфейс может использовать последнюю подходящую команду этой вкладки.',
      'После настройки на вкладке появляется фиолетовая кнопка ручного запуска и отдельная кнопка паузы. Пауза сохраняет настройки, но временно отключает автозапуск.',
    ],
    note: 'Cmd+click по фиолетовой кнопке удаляет настройку Restart after. У обычной зелёной dev-server вкладки без этой настройки Cmd+click на том же месте останавливает процесс.',
    videoLabel: 'Restart after',
  },
] as const;

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
  const [activeTopicId, setActiveTopicId] = useState<string>(COMPLEX_HELP_TOPICS[0].id);
  const hintsEnabled = useControlHelpStore((state) => state.enabled);
  const setHintsEnabled = useControlHelpStore((state) => state.setEnabled);
  const overlayRef = useRef<HTMLDivElement>(null);
  const activeTopic = COMPLEX_HELP_TOPICS.find((topic) => topic.id === activeTopicId) || COMPLEX_HELP_TOPICS[0];

  useEffect(() => {
    if (!isOpen) {
      setDiagnosticOpen(false);
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

        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
          <div style={{ width: 'min(800px, calc(100% - 40px))', margin: '0 auto', padding: '26px 0 34px' }}>
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
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14 }}>
                    <SectionTitle>Подсказки интерфейса</SectionTitle>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={hintsEnabled}
                      data-testid="control-hints-toggle"
                      aria-label={hintsEnabled ? 'Выключить подсказки интерфейса' : 'Включить подсказки интерфейса'}
                      onClick={() => setHintsEnabled(!hintsEnabled)}
                      style={{
                        width: 32,
                        height: 18,
                        padding: 2,
                        display: 'flex',
                        justifyContent: hintsEnabled ? 'flex-end' : 'flex-start',
                        flexShrink: 0,
                        border: 'none',
                        borderRadius: 9,
                        background: hintsEnabled ? 'rgba(116, 199, 236, 0.38)' : '#343941',
                        cursor: 'pointer',
                      }}
                    >
                      <span
                        aria-hidden="true"
                        style={{
                          width: 14,
                          height: 14,
                          borderRadius: '50%',
                          background: hintsEnabled ? COLORS.sapphire : '#858d98',
                        }}
                      />
                    </button>
                  </div>
                  <div style={{ display: 'flex', gap: 10, marginTop: 10, color: COLORS.muted, fontSize: 12, lineHeight: 1.55 }}>
                    <MousePointer2 size={17} color={COLORS.sapphire} style={{ flexShrink: 0, marginTop: 1 }} />
                    <span>Наведите курсор на обычный контрол и удерживайте Cmd. Сложные preview и элементы со своим Cmd-действием продолжают работать в собственном режиме.</span>
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
                  <div style={{ fontSize: 11.5, fontWeight: 600 }}>Cmd + hover</div>
                  <div style={{ fontSize: 10.5 }}>место для короткого видео</div>
                </div>
              </div>
            </section>

            <section style={{ marginTop: 28, paddingTop: 24, borderTop: `1px solid ${COLORS.borderSoft}` }}>
              <SectionTitle>Сложные сценарии</SectionTitle>
              <p style={{ margin: '7px 0 0', color: COLORS.muted, fontSize: 11.5, lineHeight: 1.5 }}>
                Здесь собраны действия, которые состоят из нескольких шагов и не помещаются в короткую подсказку.
              </p>

              <div
                role="tablist"
                aria-label="Сложные сценарии"
                style={{
                  display: 'flex',
                  gap: 18,
                  marginTop: 15,
                  overflowX: 'auto',
                  borderBottom: `1px solid ${COLORS.borderSoft}`,
                }}
              >
                {COMPLEX_HELP_TOPICS.map((topic) => {
                  const selected = topic.id === activeTopic.id;
                  return (
                    <button
                      key={topic.id}
                      type="button"
                      role="tab"
                      aria-selected={selected}
                      onClick={() => setActiveTopicId(topic.id)}
                      style={{
                        minHeight: 34,
                        padding: '0 1px',
                        flexShrink: 0,
                        border: 'none',
                        borderBottom: `2px solid ${selected ? COLORS.sapphire : 'transparent'}`,
                        background: 'transparent',
                        color: selected ? COLORS.text : COLORS.muted,
                        fontSize: 12,
                        fontWeight: selected ? 650 : 500,
                        cursor: 'pointer',
                      }}
                    >
                      {topic.label}
                    </button>
                  );
                })}
              </div>

              <div className="grid grid-cols-1 min-[760px]:grid-cols-[minmax(0,1fr)_minmax(240px,330px)]" style={{ gap: 30, alignItems: 'start', marginTop: 18 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <RotateCcw size={15} color={COLORS.peach} />
                    <h3 style={{ margin: 0, color: COLORS.text, fontSize: 13.5, lineHeight: 1.4, fontWeight: 650 }}>
                      {activeTopic.title}
                    </h3>
                  </div>
                  <p style={{ margin: '8px 0 0', color: COLORS.muted, fontSize: 11.5, lineHeight: 1.55 }}>
                    {activeTopic.summary}
                  </p>
                  <ol style={{ margin: '12px 0 0', paddingLeft: 19, color: COLORS.muted, fontSize: 11.5, lineHeight: 1.55 }}>
                    {activeTopic.steps.map((step) => (
                      <li key={step} style={{ marginTop: 6, paddingLeft: 3 }}>{step}</li>
                    ))}
                  </ol>
                  <p style={{ margin: '13px 0 0', paddingTop: 12, borderTop: `1px solid ${COLORS.borderSoft}`, color: COLORS.peach, fontSize: 11.5, lineHeight: 1.55 }}>
                    {activeTopic.note}
                  </p>
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
                  <Play size={17} color={COLORS.peach} fill="currentColor" />
                  <div style={{ fontSize: 11.5, fontWeight: 600 }}>{activeTopic.videoLabel}</div>
                  <div style={{ fontSize: 10.5 }}>место для видео</div>
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>

      {diagnosticOpen && <DiagnosticExportDialog onClose={() => setDiagnosticOpen(false)} />}
    </div>
  );
}
