// Settings panel for Global Dictation (system-wide voice input, Cmd+`).
// Mirrors the read/write surface of src/main/global-dictation/index.js.
// All state is persisted on the main side — this component is a thin form.

import { useEffect, useState } from 'react';

const { ipcRenderer } = window.require('electron');

interface GdSettings {
  enabled: boolean;
  hotkey: string;
  autoEnterHotkey: string;
  cancelHotkey: string;
  showChip: boolean;
  autoEnterDefault: boolean;
  transcriptFontSize: number;
  transcriptLines: number;
  menuGap: number;
  recWindowGap: number;
  chipPos: { x?: number; y?: number; xPct?: number; yPct?: number } | null;
}

type AccessibilityState = 'unknown' | 'trusted' | 'untrusted';

interface HistoryEntry { ts: number; text: string }

const DEFAULT: GdSettings = {
  enabled: false,
  hotkey: 'Alt+`',
  autoEnterHotkey: '',
  cancelHotkey: 'Esc',
  showChip: true,
  autoEnterDefault: false,
  transcriptFontSize: 12,
  transcriptLines: 5,
  menuGap: 6,
  recWindowGap: 6,
  chipPos: null,
};

// Convert a keyboard event into an Electron Accelerator string.
//
// IMPORTANT: We use `e.code` (physical key, layout-agnostic) NOT `e.key`.
// Reasons:
//  - Dead keys: on macOS Opt+` is the umlaut/grave dead-key combiner; `e.key`
//    is the literal string "Dead". `e.code` is "Backquote" regardless.
//  - Alt+letter on macOS produces typographical characters (Opt+A = "å",
//    Opt+P = "π", Opt+L = "¬"), so `e.key` returns the symbol — not "A".
//  - Non-Latin layouts (Cyrillic): `e.key` returns "ф" for KeyA; useless for
//    a global hotkey. `e.code === "KeyA"` is stable.
function eventToAccelerator(e: KeyboardEvent): string | null {
  const parts: string[] = [];
  if (e.metaKey) parts.push('CommandOrControl');
  else if (e.ctrlKey) parts.push('Control');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  // Drop modifier-only events.
  const code = e.code;
  if (!code) return null;
  if (code.startsWith('Meta') || code.startsWith('Control') || code.startsWith('Alt') || code.startsWith('Shift')) return null;
  // Map e.code (physical) → Electron Accelerator key name.
  const codeMap: Record<string, string> = {
    Backquote: '`',
    Minus: '-', Equal: '=',
    BracketLeft: '[', BracketRight: ']',
    Semicolon: ';', Quote: "'",
    Comma: ',', Period: '.', Slash: '/', Backslash: '\\',
    Space: 'Space', Tab: 'Tab', Enter: 'Return', Escape: 'Esc', Backspace: 'Backspace', Delete: 'Delete',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  };
  let key: string;
  if (codeMap[code]) {
    key = codeMap[code];
  } else if (/^Key[A-Z]$/.test(code)) {
    key = code.slice(3);                 // KeyA → A
  } else if (/^Digit[0-9]$/.test(code)) {
    key = code.slice(5);                 // Digit1 → 1
  } else if (/^F[0-9]+$/.test(code)) {
    key = code;                          // F1..F24
  } else {
    return null;                          // unknown / unmappable
  }
  parts.push(key);
  if (parts.length === 1) return null;   // Modifier-less hotkeys not allowed globally
  return parts.join('+');
}

export default function GlobalDictationSettings() {
  const [settings, setSettings] = useState<GdSettings>(DEFAULT);
  const [loaded, setLoaded] = useState(false);
  const [accessibility, setAccessibility] = useState<AccessibilityState>('unknown');
  const [accessibilitySupported, setAccessibilitySupported] = useState(true);
  // 'main'   = capturing the primary recording hotkey
  // 'auto'   = capturing the Auto-Enter toggle hotkey
  // 'cancel' = capturing the in-flight cancel hotkey
  const [capturing, setCapturing] = useState<null | 'main' | 'auto' | 'cancel'>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyQuery, setHistoryQuery] = useState('');
  const [copiedTs, setCopiedTs] = useState<number | null>(null);

  const refreshHistory = async () => {
    try {
      const h = await ipcRenderer.invoke('global-dict:history:get');
      setHistory(Array.isArray(h) ? h : []);
    } catch {}
  };

  // Initial load
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const s = await ipcRenderer.invoke('global-dict:settings:get');
        if (alive && s) setSettings({ ...DEFAULT, ...s });
        const a = await ipcRenderer.invoke('global-dict:accessibility-check');
        if (alive) {
          setAccessibilitySupported(a?.supported !== false);
          setAccessibility(a?.trusted ? 'trusted' : 'untrusted');
        }
        await refreshHistory();
      } catch {} finally {
        if (alive) setLoaded(true);
      }
    })();
    return () => { alive = false; };
  }, []);

  const patch = async (delta: Partial<GdSettings>) => {
    const next = { ...settings, ...delta };
    setSettings(next);
    try {
      const result = await ipcRenderer.invoke('global-dict:settings:set', delta);
      if (result) setSettings({ ...DEFAULT, ...result });
    } catch {}
  };

  // Hotkey capture: focus input, swallow next keydown, convert to accelerator,
  // store, unfocus. Handles both the main hotkey and the Auto-Enter hotkey.
  useEffect(() => {
    if (!capturing) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation();
        setCapturing(null);
        return;
      }
      // Backspace on optional-hotkey fields clears them ("no hotkey").
      const clearable = capturing === 'auto' || capturing === 'cancel';
      if (clearable && (e.key === 'Backspace' || e.key === 'Delete') && !e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
        e.preventDefault(); e.stopPropagation();
        const which = capturing;
        setCapturing(null);
        patch(which === 'auto' ? { autoEnterHotkey: '' } : { cancelHotkey: '' });
        return;
      }
      const acc = eventToAccelerator(e);
      if (!acc) return;
      e.preventDefault(); e.stopPropagation();
      const which = capturing;
      setCapturing(null);
      if (which === 'main') patch({ hotkey: acc });
      else if (which === 'auto') patch({ autoEnterHotkey: acc });
      else if (which === 'cancel') patch({ cancelHotkey: acc });
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [capturing, settings]);

  const requestAccessibility = async () => {
    try {
      const r = await ipcRenderer.invoke('global-dict:accessibility-prompt');
      setAccessibility(r?.trusted ? 'trusted' : 'untrusted');
    } catch {}
  };

  const openSystemSettings = async () => {
    try { await ipcRenderer.invoke('global-dict:accessibility-open-settings'); } catch {}
  };

  const Row = ({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) => (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '14px 0',
      borderBottom: '1px solid #2a2a2a',
      gap: 16,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, color: '#fff' }}>{label}</div>
        {hint && <div style={{ fontSize: 11, color: '#666', marginTop: 3 }}>{hint}</div>}
      </div>
      <div style={{ flexShrink: 0 }}>{children}</div>
    </div>
  );

  const Toggle = ({ value, onChange, disabled }: { value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) => (
    <button
      onClick={() => !disabled && onChange(!value)}
      style={{
        width: 40, height: 22, borderRadius: 11,
        background: value ? '#3b82f6' : '#3a3a3a',
        border: 'none',
        cursor: disabled ? 'not-allowed' : 'pointer',
        position: 'relative',
        padding: 0,
        opacity: disabled ? 0.5 : 1,
        transition: 'background 0.15s',
      }}
    >
      <span style={{
        position: 'absolute',
        top: 2, left: value ? 20 : 2,
        width: 18, height: 18, borderRadius: '50%',
        background: '#fff',
        transition: 'left 0.15s',
      }} />
    </button>
  );

  if (!loaded) {
    return <div style={{ color: '#666', fontSize: 13 }}>Loading…</div>;
  }

  const allowEnable = accessibility === 'trusted' || !accessibilitySupported;

  return (
    <div style={{ maxWidth: 980 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: '#666', marginBottom: 8, textTransform: 'uppercase' }}>
        Глобальная диктовка
      </div>
      <div style={{ fontSize: 12, color: '#888', marginBottom: 16, lineHeight: 1.5 }}>
        Горячая клавиша записи поверх любого приложения. Текст после STOP вставляется в активное поле ввода через системный Cmd+V. Транскрибация через Soniox real-time.
      </div>

      {/* Accessibility permission gate */}
      {accessibilitySupported && accessibility === 'untrusted' && (
        <div style={{
          padding: 12,
          background: 'rgba(220,160,0,0.08)',
          border: '1px solid rgba(220,160,0,0.3)',
          borderRadius: 8,
          marginBottom: 16,
        }}>
          <div style={{ fontSize: 12, color: '#e0b050', marginBottom: 6, fontWeight: 600 }}>
            Требуется разрешение Accessibility
          </div>
          <div style={{ fontSize: 11, color: '#aaa', lineHeight: 1.5, marginBottom: 10 }}>
            Без него macOS не даст приложению симулировать Cmd+V для вставки текста в чужие окна. Открой System Settings → Privacy &amp; Security → Accessibility и разреши <b>Noted Terminal</b>.
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={openSystemSettings} style={btnStyle}>Открыть System Settings</button>
            <button onClick={requestAccessibility} style={btnStyleSecondary}>Проверить разрешение</button>
          </div>
        </div>
      )}

      {/* Two-column layout: hotkeys/toggles on left, presentation tweaks on right. */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
        <div>
          <Row
            label="Включить глобальную диктовку"
            hint={allowEnable ? 'Регистрирует системный хоткей и (если включено ниже) показывает плавающий чип.' : 'Сначала выдай Accessibility-разрешение выше.'}
          >
            <Toggle value={settings.enabled} onChange={(v) => patch({ enabled: v })} disabled={!allowEnable} />
          </Row>

          <Row
            label="Горячая клавиша записи"
            hint="Срабатывает в любом приложении. Re-press для остановки."
          >
            <HotkeyCapture
              value={settings.hotkey}
              capturing={capturing === 'main'}
              onCapture={() => setCapturing((c) => c === 'main' ? null : 'main')}
            />
          </Row>

          <Row
            label="Горячая клавиша Auto-Enter"
            hint="Переключает Auto-Enter на лету (во время записи — для текущей сессии, вне записи — меняет значение по умолчанию). Backspace в режиме записи клавиши — очистить."
          >
            <HotkeyCapture
              value={settings.autoEnterHotkey}
              placeholder="не назначено"
              capturing={capturing === 'auto'}
              onCapture={() => setCapturing((c) => c === 'auto' ? null : 'auto')}
            />
          </Row>

          <Row
            label="Горячая клавиша отмены"
            hint="Сбрасывает запись без вставки. По умолчанию Esc. Backspace в режиме записи клавиши — очистить (отключить отмену хоткеем)."
          >
            <HotkeyCapture
              value={settings.cancelHotkey}
              placeholder="не назначено"
              capturing={capturing === 'cancel'}
              onCapture={() => setCapturing((c) => c === 'cancel' ? null : 'cancel')}
            />
          </Row>

          <Row
            label="Auto-Enter по умолчанию"
            hint="Состояние тогла Auto-Enter в чипе на старте каждой записи. Во время записи можно переключить — следующий старт снова сбросит на это значение."
          >
            <Toggle value={settings.autoEnterDefault} onChange={(v) => patch({ autoEnterDefault: v })} />
          </Row>

          <Row
            label="Показывать чип над Dock"
            hint="Маленькая круглая иконка-кнопка, всегда поверх других окон. Клик = меню (Open / Speak / Copy). Зажать = перетащить."
          >
            <Toggle value={settings.showChip} onChange={(v) => patch({ showChip: v })} />
          </Row>
        </div>

        <div>
          <Row
            label={`Размер шрифта транскрипта: ${settings.transcriptFontSize}px`}
            hint="Размер шрифта в окне записи."
          >
            <NumberSlider
              value={settings.transcriptFontSize}
              min={10}
              max={18}
              onChange={(v) => patch({ transcriptFontSize: v })}
            />
          </Row>

          <Row
            label={`Максимум строк в окне записи: ${settings.transcriptLines}`}
            hint="Окно записи стартует «свёрнутым» (только заголовок) и растёт по мере появления текста до этого предела, далее — внутренний скролл."
          >
            <NumberSlider
              value={settings.transcriptLines}
              min={2}
              max={10}
              onChange={(v) => patch({ transcriptLines: v })}
            />
          </Row>

          <Row
            label={`Зазор между чипом и меню: ${settings.menuGap}px`}
            hint="Вертикальное расстояние между чипом и popover-меню (Open / Speak / Copy)."
          >
            <NumberSlider
              value={settings.menuGap}
              min={0}
              max={30}
              onChange={(v) => patch({ menuGap: v })}
            />
          </Row>

          <Row
            label={`Зазор между чипом и окном записи: ${settings.recWindowGap}px`}
            hint="Вертикальное расстояние между чипом и окном с транскриптом."
          >
            <NumberSlider
              value={settings.recWindowGap}
              min={0}
              max={30}
              onChange={(v) => patch({ recWindowGap: v })}
            />
          </Row>
        </div>
      </div>

      {/* HISTORY — expandable, with search + per-entry actions */}
      <div style={{ padding: '14px 0', borderBottom: '1px solid #2a2a2a' }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16,
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <button
              onClick={() => setHistoryOpen((o) => !o)}
              style={{
                background: 'transparent', border: 'none', padding: 0, color: '#fff',
                fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
              }}
            >
              <span style={{ fontSize: 10, color: '#888' }}>{historyOpen ? '▼' : '▶'}</span>
              История транскриптов ({history.length})
            </button>
            <div style={{ fontSize: 11, color: '#666', marginTop: 3 }}>
              Хранится локально в ~/.noted-terminal/global-dictation/history.json
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
            <button
              onClick={async () => {
                try { await ipcRenderer.invoke('global-dict:history:open-folder'); } catch {}
              }}
              style={btnStyleSecondary}
              title="Reveal history.json in Finder"
            >Finder</button>
            <button
              onClick={async () => {
                if (!history.length) return;
                if (!confirm('Очистить всю историю?')) return;
                try {
                  await ipcRenderer.invoke('global-dict:history:clear');
                  await refreshHistory();
                } catch {}
              }}
              style={btnStyleSecondary}
              disabled={history.length === 0}
            >Очистить</button>
          </div>
        </div>

        {historyOpen && (
          <div style={{ marginTop: 12 }}>
            <input
              type="text"
              value={historyQuery}
              onChange={(e) => setHistoryQuery(e.target.value)}
              placeholder="Поиск по записям…"
              style={{
                width: '100%',
                padding: '7px 10px',
                background: '#1a1a1a',
                border: '1px solid #333',
                borderRadius: 6,
                color: '#fff',
                fontSize: 12,
                outline: 'none',
                boxSizing: 'border-box',
                marginBottom: 8,
              }}
            />
            <HistoryList
              entries={history}
              query={historyQuery}
              copiedTs={copiedTs}
              onCopy={async (ts) => {
                try {
                  const r = await ipcRenderer.invoke('global-dict:history:copy', ts);
                  if (r?.ok) {
                    setCopiedTs(ts);
                    setTimeout(() => setCopiedTs(null), 1200);
                  }
                } catch {}
              }}
              onDelete={async (ts) => {
                try {
                  await ipcRenderer.invoke('global-dict:history:delete', ts);
                  await refreshHistory();
                } catch {}
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function HotkeyCapture({ value, placeholder, capturing, onCapture }: {
  value: string;
  placeholder?: string;
  capturing: boolean;
  onCapture: () => void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <code style={{
        fontSize: 12,
        color: value ? '#fff' : '#666',
        background: '#2a2a2a',
        border: '1px solid #444',
        padding: '5px 10px',
        borderRadius: 6,
        fontFamily: 'monospace',
        minWidth: 140, textAlign: 'center',
      }}>{capturing ? 'Press a key…' : (value || placeholder || '—')}</code>
      <button onClick={onCapture} style={btnStyleSecondary}>
        {capturing ? 'Cancel' : 'Изменить'}
      </button>
    </div>
  );
}

function HistoryList({ entries, query, copiedTs, onCopy, onDelete }: {
  entries: HistoryEntry[];
  query: string;
  copiedTs: number | null;
  onCopy: (ts: number) => void;
  onDelete: (ts: number) => void;
}) {
  const q = query.trim().toLowerCase();
  const filtered = q ? entries.filter((e) => e.text.toLowerCase().includes(q)) : entries;
  if (!entries.length) {
    return (
      <div style={{
        padding: 16, textAlign: 'center', color: '#666', fontSize: 12,
        background: '#1a1a1a', borderRadius: 6, border: '1px solid #2a2a2a',
      }}>История пуста. Запиши что-нибудь через диктовку.</div>
    );
  }
  if (!filtered.length) {
    return (
      <div style={{
        padding: 16, textAlign: 'center', color: '#666', fontSize: 12,
        background: '#1a1a1a', borderRadius: 6, border: '1px solid #2a2a2a',
      }}>Нет записей, содержащих «{query}».</div>
    );
  }
  return (
    <div style={{
      maxHeight: 320, overflowY: 'auto',
      background: '#1a1a1a', borderRadius: 6, border: '1px solid #2a2a2a',
    }}>
      {filtered.map((e, idx) => {
        const isCopied = copiedTs === e.ts;
        return (
          <div
            key={e.ts}
            style={{
              padding: '8px 10px',
              borderBottom: idx < filtered.length - 1 ? '1px solid #242424' : 'none',
              display: 'flex', alignItems: 'flex-start', gap: 8,
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 10, color: isCopied ? '#4ade80' : '#888', marginBottom: 3 }}>
                {isCopied ? '✓ скопировано' : formatTs(e.ts)} · {e.text.length} chars
              </div>
              <div style={{
                fontSize: 12, color: '#e0e0e0', lineHeight: 1.4,
                whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                maxHeight: 100, overflow: 'auto',
              }}>{q ? highlightMatches(e.text, q) : e.text}</div>
            </div>
            <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
              <button
                onClick={() => onCopy(e.ts)}
                title="Копировать"
                style={iconBtn}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              </button>
              <button
                onClick={() => onDelete(e.ts)}
                title="Удалить"
                style={iconBtn}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Split `text` into segments and wrap any case-insensitive occurrence of
// `query` in a <mark> with a yellow background. Returns an array of nodes
// suitable for React inline rendering.
function highlightMatches(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const q = query.toLowerCase();
  const lower = text.toLowerCase();
  const out: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < text.length) {
    const idx = lower.indexOf(q, i);
    if (idx === -1) {
      out.push(text.slice(i));
      break;
    }
    if (idx > i) out.push(text.slice(i, idx));
    out.push(
      <mark key={key++} style={{
        background: 'rgba(250, 204, 21, 0.45)',
        color: '#fff',
        padding: '0 1px',
        borderRadius: 2,
      }}>{text.slice(idx, idx + query.length)}</mark>
    );
    i = idx + query.length;
  }
  return out;
}

function formatTs(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  const sameDay = (() => {
    const now = new Date();
    return now.getFullYear() === d.getFullYear()
      && now.getMonth() === d.getMonth()
      && now.getDate() === d.getDate();
  })();
  if (sameDay) return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const iconBtn: React.CSSProperties = {
  width: 26, height: 26,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: 'transparent',
  border: '1px solid #333',
  borderRadius: 4,
  color: '#aaa',
  cursor: 'pointer',
  padding: 0,
};

function NumberSlider({ value, min, max, onChange }: { value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <input
      type="range"
      min={min}
      max={max}
      value={value}
      onChange={(e) => onChange(parseInt(e.target.value, 10))}
      style={{ width: 120 }}
    />
  );
}

const btnStyle: React.CSSProperties = {
  padding: '6px 12px',
  background: '#3b82f6',
  border: 'none',
  borderRadius: 6,
  color: '#fff',
  fontSize: 12,
  cursor: 'pointer',
};

const btnStyleSecondary: React.CSSProperties = {
  padding: '6px 12px',
  background: '#2a2a2a',
  border: '1px solid #444',
  borderRadius: 6,
  color: '#ccc',
  fontSize: 12,
  cursor: 'pointer',
};
