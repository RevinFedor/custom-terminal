// Claude usage limits chip for the project toolbar.
//
// Compact display: weekly utilization % colored by severity, with Codex's
// 5-hour % shown inline when available. Two
// affordances per project convention (Cmd+Hover, design.md::Closing /
// Cmd+Shift pin):
//
//   • click          → opens popover, pinned to CURRENT tab. Switching tabs
//                      closes it. Click outside or Esc closes.
//   • Cmd+hover      → transient peek. Cursor exit closes.
//   • Cmd+Shift      → STICKY pin. White border. Survives tab/project switch,
//                      survives losing Cmd. Cmd+Shift again or click outside
//                      to release.
//
// Popover contents:
//   1. Global limits — weekly / 5-hour / per-model split / extra credits.
//      These don't depend on the active tab; same across the whole app.
//   2. Expandable "This tab (sessionId…)" section — per-tab token cost from
//      JSONL on disk. Reads via claude-tokens:summary IPC. Expanded state
//      persists across tab switches via localStorage.
//
// Backend: ipc 'claude-usage:get' (limits) + 'claude-tokens:summary' (per-tab).

import { useEffect, useRef, useState, useCallback, useId } from 'react';
import { RefreshCw, ChevronRight } from 'lucide-react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { ClaudeSparkle } from './CopySessionButton';

const { ipcRenderer } = (window as any).require('electron');

interface UsageBucket {
  utilization?: number | null;
  resets_at?: string | null;
}
interface ExtraUsage {
  is_enabled?: boolean;
  utilization?: number | null;
  used_credits?: number | null;
  monthly_limit?: number | null;
  currency?: string;
}
interface UsageResponse {
  five_hour?: UsageBucket | null;
  seven_day?: UsageBucket | null;
  seven_day_opus?: UsageBucket | null;
  seven_day_sonnet?: UsageBucket | null;
  extra_usage?: ExtraUsage | null;
}
interface ApiPlatformBilling {
  ok?: boolean;
  source?: string;
  adminKeyConfigured?: boolean;
  currency?: string;
  monthSpendUsd?: number | null;
  last7dSpendUsd?: number | null;
  last31dSpendUsd?: number | null;
  bucketCount?: number | null;
  latestBucketDate?: string | null;
  balanceAvailable?: boolean;
  balanceNote?: string | null;
  error?: string | null;
  cachedMsAgo?: number | null;
  lastAttemptAt?: number | null;
  apiKeyStatus?: {
    ok?: boolean;
    orgId?: string | null;
    orgIdShort?: string | null;
    error?: string | null;
  } | null;
}
interface ClaudeUsageAccount {
  accountKey: string;
  kind?: 'max-oauth' | 'api-platform' | string;
  label: string;
  accountHint?: string | null;
  accountIdHint?: string | null;
  source?: string | null;
  isCurrent?: boolean;
  usage?: UsageResponse | null;
  billing?: ApiPlatformBilling | null;
  notice?: string | null;
  error?: string | null;
}
interface ClaudeUsageIpcResponse {
  ok?: boolean;
  error?: string | null;
  notice?: string | null;
  data?: UsageResponse | null;
  accounts?: ClaudeUsageAccount[];
  selectedAccountKey?: string | null;
  currentAccountKey?: string | null;
  authKind?: string | null;
  billing?: ApiPlatformBilling | null;
  cachedMsAgo?: number | null;
  lastAttemptAt?: number | null;
}

interface ModelBucket {
  input: number;
  output: number;
  cache_write: number;
  cache_read: number;
  count: number;
  cost: number;
  totalTokens: number;
}
interface TokenSummary {
  ok: boolean;
  error?: string;
  sessionId?: string;
  chainLength?: number;
  total?: { models: Record<string, ModelBucket>; totalCost: number; totalTokens: number; totalTurns: number };
  active?: { models: Record<string, ModelBucket>; totalCost: number; totalTokens: number; totalTurns: number };
  wasted?: { cost: number; tokens: number; turns: number };
}

interface DailyHistoryEntry {
  date: string;        // YYYY-MM-DD
  delta: number;       // weekly% spent during this day (after baseline correction)
  max: number;         // peak weekly% seen during the day
  fiveHourMax: number;
  wasReset: boolean;
  sampleCount: number;
}
interface DailyHistoryResponse {
  ok: boolean;
  error?: string;
  history?: DailyHistoryEntry[];
}

interface ActivityByDay {
  date: string;            // YYYY-MM-DD (local)
  ms: number;
  byEngine: { claude: number; 'claude-sdk': number; gemini: number; codex: number; [key: string]: number };
}
interface ActivityByProject {
  projectId: string | null;
  projectName: string | null;
  projectPath: string | null;
  ms: number;
  tabCount: number;
}
interface ActivityByTab {
  tabId: string | null;
  tabName: string | null;
  projectName: string | null;
  engine: string;
  ms: number;
}
interface ActivityResponse {
  ok: boolean;
  error?: string;
  totalMs?: number;
  byDay?: ActivityByDay[];
  byProject?: ActivityByProject[];
  byTab?: ActivityByTab[];
}

interface CodexUsageData {
  primary?: UsageBucket | null;
  secondary?: UsageBucket | null;
  five_hour?: UsageBucket | null;
  seven_day?: UsageBucket | null;
  limit_id?: string | null;
  limit_name?: string | null;
  plan_type?: string | null;
  timestamp?: string | null;
}
interface CodexUsageAccount {
  accountKey: string;
  label: string;
  accountHint?: string | null;
  accountIdHint?: string | null;
  plan_type?: string | null;
  timestamp?: string | null;
  source?: string | null;
  usage: CodexUsageData;
}
interface CodexUsageResponse {
  success?: boolean;
  error?: string;
  data?: CodexUsageData | null;
  accounts?: CodexUsageAccount[];
  selectedAccountKey?: string | null;
  source?: string | null;
  refreshing?: boolean;
  stale?: boolean;
  cacheAgeMs?: number | null;
  lastAttemptAt?: number | null;
}

const CODEX_USAGE_ACCOUNT_STORAGE_KEY = 'noted.codexUsage.accountKey';

function loadStoredCodexUsageAccountKey(): string | null {
  try {
    return window.localStorage.getItem(CODEX_USAGE_ACCOUNT_STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeCodexUsageAccountKey(value: string | null) {
  try {
    if (value) window.localStorage.setItem(CODEX_USAGE_ACCOUNT_STORAGE_KEY, value);
    else window.localStorage.removeItem(CODEX_USAGE_ACCOUNT_STORAGE_KEY);
  } catch {
    // localStorage is a convenience for this view, not the source of truth.
  }
}

function formatUsd(amount: number | null | undefined): string {
  if (amount == null) return '—';
  if (amount < 0.01) return '<$0.01';
  return `$${amount.toFixed(2)}`;
}

function formatBillingUsd(amount: number | null | undefined): string {
  if (amount == null) return '—';
  if (amount === 0) return '$0.00';
  if (amount < 0.01) return '<$0.01';
  if (amount >= 1000) return `$${amount.toFixed(0)}`;
  return `$${amount.toFixed(2)}`;
}

function formatUsdCents(cents: number | null | undefined): string {
  if (cents == null) return '—';
  return `$${(cents / 100).toFixed(2)}`;
}

function formatTokens(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return (n / 1_000).toFixed(n < 10_000 ? 1 : 0) + 'k';
  return (n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1) + 'M';
}

function formatPct(p: number | null | undefined): string {
  if (p == null) return '—';
  return `${Math.round(p)}%`;
}

function colorForPct(p: number | null | undefined): string {
  if (p == null) return '#888';
  if (p < 50) return '#4ade80';
  if (p < 75) return '#facc15';
  if (p < 90) return '#fb923c';
  return '#f87171';
}

function CodexIcon({ size = 12, muted = false }: { size?: number; muted?: boolean }) {
  const gradientId = `codex-icon-gradient-${useId().replace(/:/g, '')}`;
  return (
    <svg
      aria-hidden
      focusable="false"
      viewBox="0 0 24 24"
      style={{
        width: size,
        height: size,
        flexShrink: 0,
        display: 'block',
        opacity: muted ? 0.45 : 1,
      }}
    >
      <path
        d="M9.064 3.344a4.578 4.578 0 012.285-.312c1 .115 1.891.54 2.673 1.275.01.01.024.017.037.021a.09.09 0 00.043 0 4.55 4.55 0 013.046.275l.047.022.116.057a4.581 4.581 0 012.188 2.399c.209.51.313 1.041.315 1.595a4.24 4.24 0 01-.134 1.223.123.123 0 00.03.115c.594.607.988 1.33 1.183 2.17.289 1.425-.007 2.71-.887 3.854l-.136.166a4.548 4.548 0 01-2.201 1.388.123.123 0 00-.081.076c-.191.551-.383 1.023-.74 1.494-.9 1.187-2.222 1.846-3.711 1.838-1.187-.006-2.239-.44-3.157-1.302a.107.107 0 00-.105-.024c-.388.125-.78.143-1.204.138a4.441 4.441 0 01-1.945-.466 4.544 4.544 0 01-1.61-1.335c-.152-.202-.303-.392-.414-.617a5.81 5.81 0 01-.37-.961 4.582 4.582 0 01-.014-2.298.124.124 0 00.006-.056.085.085 0 00-.027-.048 4.467 4.467 0 01-1.034-1.651 3.896 3.896 0 01-.251-1.192 5.189 5.189 0 01.141-1.6c.337-1.112.982-1.985 1.933-2.618.212-.141.413-.251.601-.33.215-.089.43-.164.646-.227a.098.098 0 00.065-.066 4.51 4.51 0 01.829-1.615 4.535 4.535 0 011.837-1.388zm3.482 10.565a.637.637 0 000 1.272h3.636a.637.637 0 100-1.272h-3.636zM8.462 9.23a.637.637 0 00-1.106.631l1.272 2.224-1.266 2.136a.636.636 0 101.095.649l1.454-2.455a.636.636 0 00.005-.64L8.462 9.23z"
        fill={`url(#${gradientId})`}
      />
      <defs>
        <linearGradient gradientUnits="userSpaceOnUse" id={gradientId} x1="12" x2="12" y1="3" y2="21">
          <stop stopColor="#B1A7FF" />
          <stop offset=".5" stopColor="#7A9DFF" />
          <stop offset="1" stopColor="#3941FF" />
        </linearGradient>
      </defs>
    </svg>
  );
}

function formatResetDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

// Ultra-compact reset countdown for the CHIP itself (always visible, must be
// tiny): "1d 12h" / "12h 30m" / "45m" / "now". Always ≤2 units. The header
// popover uses the exact local reset date/time; this one trades precision for width.
function formatResetShort(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const diffMs = d.getTime() - Date.now();
  if (diffMs <= 0) return 'now';
  const totalMin = Math.floor(diffMs / 60000);
  const days = Math.floor(totalMin / (60 * 24));
  const hrs = Math.floor((totalMin % (60 * 24)) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `${days}d ${hrs}h`;
  if (hrs > 0) return `${hrs}h ${mins}m`;
  return `${mins}m`;
}

// Human duration for activity totals: "3h 12m" / "12m" / "47s" / "0m".
function formatDuration(ms: number | null | undefined): string {
  if (ms == null || ms <= 0) return '0m';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

const MODEL_LABEL: Record<string, string> = {
  opus: 'Opus',
  'opus-1m': 'Opus 1M',
  sonnet: 'Sonnet',
  haiku: 'Haiku',
  unknown: 'Other',
};

function ProgressRow({ label, pct, resetsAt }: { label: string; pct?: number | null; resetsAt?: string | null }) {
  const v = Math.max(0, Math.min(100, pct ?? 0));
  const color = colorForPct(pct);
  return (
    <div style={{ padding: '8px 12px' }}>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        fontSize: 11,
        marginBottom: 4,
      }}>
        <span style={{ color: '#ddd' }}>{label}</span>
        <span style={{ fontVariantNumeric: 'tabular-nums', color }}>
          {formatPct(pct)}
          {resetsAt && (
            <span style={{ color: '#666', marginLeft: 8, fontSize: 10 }}>
              resets {formatResetDateTime(resetsAt)}
            </span>
          )}
        </span>
      </div>
      <div style={{
        height: 4,
        background: 'rgba(255,255,255,0.06)',
        borderRadius: 2,
        overflow: 'hidden',
      }}>
        <div style={{
          width: `${v}%`,
          height: '100%',
          background: color,
          transition: 'width 0.3s ease',
        }} />
      </div>
    </div>
  );
}

// Single line: "Opus 1.2M tok • $1.32 • 14 turns"
function ModelLine({ modelKey, bucket }: { modelKey: string; bucket: ModelBucket }) {
  if (bucket.count === 0) return null;
  return (
    <div style={{
      display: 'flex',
      justifyContent: 'space-between',
      fontSize: 10,
      color: '#aaa',
      padding: '2px 0',
    }}>
      <span>{MODEL_LABEL[modelKey] || modelKey} <span style={{ color: '#666' }}>×{bucket.count}</span></span>
      <span style={{ fontVariantNumeric: 'tabular-nums', color: '#ddd' }}>
        {formatTokens(bucket.totalTokens)} <span style={{ color: '#888' }}>· {formatUsd(bucket.cost)}</span>
      </span>
    </div>
  );
}

// Day label: "Mon", "Tue", … with "today"/"yest" for the two most recent days.
// Computed from the ACTUAL date vs the local calendar today — not the array
// index. The usage chart has a sample every day so index==date there, but
// activity has gaps (no agent run = no row), where byDay[0] may be days ago.
// The `idx` arg is kept for call-site compatibility but no longer trusted.
function dayLabel(dateStr: string, _idx?: number): string {
  // Parse YYYY-MM-DD; new Date('YYYY-MM-DD') is UTC but we want local-day name.
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const today = new Date();
  const dayMs = 24 * 60 * 60 * 1000;
  const diffDays = Math.round(
    (new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() - dt.getTime()) / dayMs
  );
  if (diffDays === 0) return 'today';
  if (diffDays === 1) return 'yest';
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dt.getDay()];
}

// 7-day bar chart. Bars are horizontal rows (label | bar | %), not vertical
// columns — vertical would compress to ~30px each which makes 1% bars invisible
// and labels rotate ugly. Horizontal scales naturally with content. Today's
// row gets a subtle pulse.
function DailyBarChart({ history }: { history: DailyHistoryEntry[] }) {
  // Find scale: highest delta in window, clamp at 100% for color thresholds.
  const maxDelta = Math.max(1, ...history.map(h => h.delta));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {history.map((entry, idx) => {
        const widthPct = Math.min(100, (entry.delta / maxDelta) * 100);
        const color = colorForPct(entry.max);
        const isToday = idx === 0;
        return (
          <div
            key={entry.date}
            style={{
              display: 'grid',
              gridTemplateColumns: '38px 1fr 42px',
              alignItems: 'center',
              gap: 6,
              fontSize: 10,
              fontVariantNumeric: 'tabular-nums',
            }}
            title={`${entry.date} • peak ${entry.max}% • +${entry.delta}% spent${entry.wasReset ? ' (week reset on this day)' : ''} • ${entry.sampleCount} samples`}
          >
            <span style={{ color: isToday ? '#ddd' : '#888' }}>
              {dayLabel(entry.date, idx)}
            </span>
            <div style={{
              height: 8,
              background: 'rgba(255,255,255,0.04)',
              borderRadius: 2,
              overflow: 'hidden',
              position: 'relative',
            }}>
              <div style={{
                width: `${widthPct}%`,
                height: '100%',
                background: color,
                transition: 'width 0.3s ease',
                animation: isToday ? 'glow-pulse 2.4s ease-in-out infinite' : 'none',
                opacity: entry.delta === 0 ? 0.25 : 1,
              }} />
              {entry.wasReset && (
                <div style={{
                  position: 'absolute',
                  top: 0,
                  right: 0,
                  height: '100%',
                  width: 2,
                  background: 'rgba(255,255,255,0.4)',
                }} title="Weekly bucket reset on this day" />
              )}
            </div>
            <span style={{
              color,
              textAlign: 'right',
            }}>
              +{entry.delta}%
            </span>
          </div>
        );
      })}
    </div>
  );
}

// Engine brand colors for activity bars — matches the rest of the app's
// Claude-orange / Gemini-blue palette so a glance reads "which agent".
const ENGINE_COLOR: Record<string, string> = {
  claude: '#DA7756',        // Claude orange (PTY)
  'claude-sdk': '#C9826A',  // Claude orange, slightly muted (SDK)
  gemini: '#4E86F8',        // Gemini blue
  codex: '#22c55e',         // Codex green (matches Codex session chip)
};
const ENGINE_LABEL: Record<string, string> = {
  claude: 'Claude',
  'claude-sdk': 'Claude SDK',
  gemini: 'Gemini',
  codex: 'Codex',
};

// Activity section body: total wall-clock active time + per-day stacked bars
// (segmented by engine) + a by-project breakdown.
function ActivityView({ activity }: { activity: ActivityResponse }) {
  const byDay = activity.byDay || [];
  const byProject = activity.byProject || [];
  const maxDayMs = Math.max(1, ...byDay.map(d => d.ms));
  const maxProjMs = Math.max(1, ...byProject.map(p => p.ms));
  const engines = ['claude', 'claude-sdk', 'gemini', 'codex'];

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      maxHeight: 280,
      overflowY: 'auto',
      overscrollBehavior: 'contain',
      paddingRight: 4,
    }}>
      {/* Total */}
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#888' }}>
        <span>Total wall time (14d)</span>
        <span style={{ color: '#ddd', fontVariantNumeric: 'tabular-nums' }}>
          {formatDuration(activity.totalMs)}
        </span>
      </div>

      {/* Per-day stacked bars */}
      {byDay.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {byDay.map((entry, idx) => {
            const totalWidthPct = Math.min(100, (entry.ms / maxDayMs) * 100);
            return (
              <div
                key={entry.date}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '38px 1fr 46px',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 10,
                  fontVariantNumeric: 'tabular-nums',
                }}
                title={`${entry.date} • ${formatDuration(entry.ms)} active`}
              >
                <span style={{ color: idx === 0 ? '#ddd' : '#888' }}>
                  {dayLabel(entry.date, idx)}
                </span>
                <div style={{
                  height: 8,
                  background: 'rgba(255,255,255,0.04)',
                  borderRadius: 2,
                  overflow: 'hidden',
                  display: 'flex',
                  width: `${totalWidthPct}%`,
                  minWidth: entry.ms > 0 ? 2 : 0,
                }}>
                  {engines.map((eng) => {
                    const segMs = entry.byEngine[eng] || 0;
                    if (segMs <= 0) return null;
                    const segPct = (segMs / entry.ms) * 100;
                    return (
                      <div
                        key={eng}
                        style={{ width: `${segPct}%`, height: '100%', background: ENGINE_COLOR[eng] }}
                      />
                    );
                  })}
                </div>
                <span style={{ color: '#aaa', textAlign: 'right' }}>
                  {formatDuration(entry.ms)}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* By project */}
      {byProject.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 2 }}>
          <div style={{ fontSize: 9, color: '#666', textTransform: 'uppercase', letterSpacing: 0.4 }}>
            By project
          </div>
          {byProject.slice(0, 6).map((p, idx) => {
            const widthPct = Math.min(100, (p.ms / maxProjMs) * 100);
            return (
              <div
                key={(p.projectId || p.projectPath || idx) + ''}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 46px',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 10,
                }}
                title={p.projectPath || p.projectName || 'Unknown project'}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    color: '#bbb',
                    marginBottom: 2,
                  }}>
                    {p.projectName || p.projectPath?.split('/').pop() || 'Unknown'}
                    {p.tabCount > 0 && <span style={{ color: '#666' }}> · {p.tabCount} tab{p.tabCount > 1 ? 's' : ''}</span>}
                  </div>
                  <div style={{ height: 4, background: 'rgba(255,255,255,0.04)', borderRadius: 2, overflow: 'hidden' }}>
                    <div style={{ width: `${widthPct}%`, height: '100%', background: '#6b7280' }} />
                  </div>
                </div>
                <span style={{ color: '#aaa', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                  {formatDuration(p.ms)}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {byDay.length === 0 && byProject.length === 0 && (
        <div style={{ fontSize: 10, color: '#666' }}>
          No activity recorded yet. Run an agent and its working time will show up here.
        </div>
      )}

      {/* Engine legend */}
      <div style={{ display: 'flex', gap: 10, marginTop: 2, fontSize: 9, color: '#666', flexWrap: 'wrap' }}>
        {(['claude', 'claude-sdk', 'gemini', 'codex'] as const).map((eng) => (
          <span key={eng} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
            <span style={{ width: 7, height: 7, borderRadius: 1, background: ENGINE_COLOR[eng] }} />
            {ENGINE_LABEL[eng]}
          </span>
        ))}
      </div>
    </div>
  );
}

function ClaudeUsageChip() {
  // Pin states (3-level):
  //   clicked  → light pin (current-tab scope, closes on tab switch)
  //   sticky   → strong pin (Cmd+Shift) — survives tab/project switch
  const [clicked, setClicked] = useState(false);
  const [sticky, setSticky] = useState(false);

  // Hover tracking for Cmd+hover transient open
  const [cmdPressed, setCmdPressed] = useState(false);
  const [triggerHover, setTriggerHover] = useState(false);
  const [popoverHover, setPopoverHover] = useState(false);

  // Global usage limits (independent of tab)
  const [data, setData] = useState<UsageResponse | null>(null);
  const [accounts, setAccounts] = useState<ClaudeUsageAccount[]>([]);
  const [selectedAccountKey, setSelectedAccountKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Timestamp последней live-попытки (от backend). Banner показывает «Xs ago»,
  // чтобы юзер видел, что force-refresh реально стрельнул, даже если та же
  // ошибка вернулась.
  const [lastAttemptAt, setLastAttemptAt] = useState<number | null>(null);

  // Per-tab tokens
  const [tokens, setTokens] = useState<TokenSummary | null>(null);
  const [tokensLoading, setTokensLoading] = useState(false);

  // Daily history — separate fetch, separate expand state. Section sits next
  // to "This tab" inside popover.
  const [history, setHistory] = useState<DailyHistoryEntry[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyExpanded, setHistoryExpanded] = useState<boolean>(false);

  // Agent activity (loader-on time) — separate fetch + expand state.
  const [activity, setActivity] = useState<ActivityResponse | null>(null);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityExpanded, setActivityExpanded] = useState<boolean>(false);

  // Expanded "This tab" section — ephemeral. Survives tab switches while the
  // popover stays open (component stays mounted), but resets to collapsed when
  // the popover closes. User must opt-in to per-tab details every time they
  // open the bar.
  const [expanded, setExpanded] = useState<boolean>(false);

  const rootRef = useRef<HTMLDivElement>(null);

  // ── Active tab resolution (sub-agent aware) ──
  // We need the Claude sessionId of whatever tab the user is currently looking
  // at. The "current tab" snaps to a NEW tab each time the user switches; the
  // popover content reactively re-fetches.
  const activeTabId = useWorkspaceStore((s) => s.getEffectiveTabId());
  const activeClaudeSessionId = useWorkspaceStore((s) => {
    if (!activeTabId) return null;
    for (const [, ws] of s.openProjects) {
      const t = ws.tabs.get(activeTabId);
      if (t?.claudeSessionId) return t.claudeSessionId;
    }
    return null;
  });
  const activeCwd = useWorkspaceStore((s) => {
    if (!activeTabId) return null;
    for (const [, ws] of s.openProjects) {
      const t = ws.tabs.get(activeTabId);
      if (t) return t.cwd || null;
    }
    return null;
  });

  // Remember the tab the popover was OPENED FROM (for non-sticky pin).
  // When the user switches tabs while pinned non-sticky, the popover closes.
  // When sticky, the popover stays open AND the "This tab" section
  // re-fetches for whatever tab is now active.
  const [pinnedTabId, setPinnedTabId] = useState<string | null>(null);

  const refresh = useCallback(async (force = false) => {
    setLoading(true);
    // На force-refresh держим spinner минимум 400ms — backend может вернуться
    // мгновенно (cache hit / cooldown), без задержки иконка не мигает, юзер
    // не понимает что клик сработал.
    const minSpinUntil = force ? Date.now() + 400 : 0;
    try {
      const res: ClaudeUsageIpcResponse = await ipcRenderer.invoke('claude-usage:get', {
        force,
        accountKey: selectedAccountKey,
      });
      const nextAccounts = Array.isArray(res?.accounts) ? res.accounts : [];
      const nextKey = res?.selectedAccountKey
        || nextAccounts.find((account) => account.isCurrent)?.accountKey
        || nextAccounts[0]?.accountKey
        || null;
      const selected = nextAccounts.find((account) => account.accountKey === nextKey) || nextAccounts[0] || null;
      const selectedUsage = selected?.usage || res?.data || null;
      setAccounts(nextAccounts);
      if (nextKey !== selectedAccountKey) setSelectedAccountKey(nextKey);
      if (res?.ok) {
        setData(selectedUsage);
        setError(null);
        setNotice(res?.notice || selected?.notice || null);
      } else {
        setData(selectedUsage);
        setError(res?.error || selected?.error || 'Failed to fetch usage');
        setNotice(res?.notice || selected?.notice || null);
      }
      if (typeof res?.lastAttemptAt === 'number') setLastAttemptAt(res.lastAttemptAt);
      const weekly = selectedUsage?.seven_day?.utilization ?? null;
      const fiveHour = selectedUsage?.five_hour?.utilization ?? null;
      console.log(
        `[ClaudeUsage] refresh ${res?.ok ? 'ok' : 'failed'} account=${selected?.label || 'unknown'} kind=${selected?.kind || res?.authKind || 'unknown'} accounts=${nextAccounts.length} weekly=${weekly ?? 'null'} fiveHour=${fiveHour ?? 'null'} force=${force}`
      );
    } catch (e: any) {
      setError(e?.message || String(e));
      setNotice(null);
      console.warn(`[ClaudeUsage] refresh exception error=${e?.message || String(e)} force=${force}`);
    } finally {
      const remain = minSpinUntil - Date.now();
      if (remain > 0) setTimeout(() => setLoading(false), remain);
      else setLoading(false);
    }
  }, [selectedAccountKey]);

  const refreshTokens = useCallback(async () => {
    if (!activeClaudeSessionId) { setTokens(null); return; }
    setTokensLoading(true);
    try {
      const res = await ipcRenderer.invoke('claude-tokens:summary', {
        sessionId: activeClaudeSessionId,
        cwd: activeCwd,
      });
      setTokens(res);
    } catch (e: any) {
      setTokens({ ok: false, error: e?.message || String(e) });
    } finally {
      setTokensLoading(false);
    }
  }, [activeClaudeSessionId, activeCwd]);

  const refreshHistory = useCallback(async () => {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const res: DailyHistoryResponse = await ipcRenderer.invoke('claude-usage:daily-history', { days: 7 });
      if (res?.ok) {
        setHistory(res.history || []);
      } else {
        setHistoryError(res?.error || 'Failed to load history');
      }
    } catch (e: any) {
      setHistoryError(e?.message || String(e));
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  const refreshActivity = useCallback(async () => {
    setActivityLoading(true);
    try {
      const res: ActivityResponse = await ipcRenderer.invoke('claude-usage:activity', { days: 14 });
      setActivity(res);
    } catch (e: any) {
      setActivity({ ok: false, error: e?.message || String(e) });
    } finally {
      setActivityLoading(false);
    }
  }, []);

  // Initial + periodic refresh of GLOBAL limits (3 min interval).
  // Anthropic `/oauth/usage` 429-ит даже при 1 req/min — 3 мин заметно реже
  // ловит rate-limit окно. Backend кэширует ~170s server-side. Pause polling
  // while window is hidden — visibility-change forces immediate refresh on
  // return.
  useEffect(() => {
    refresh(false);
    let id: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (id) return;
      id = setInterval(() => refresh(false), 180 * 1000);
    };
    const stop = () => {
      if (id) { clearInterval(id); id = null; }
    };
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        refresh(false);
        start();
      } else {
        stop();
      }
    };
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVis);
    return () => { stop(); document.removeEventListener('visibilitychange', onVis); };
  }, [refresh]);

  // Re-fetch per-tab tokens whenever active session changes AND popover is open.
  useEffect(() => {
    const open = clicked || sticky || (cmdPressed && triggerHover) || popoverHover;
    if (!open || !expanded) return;
    refreshTokens();
  }, [refreshTokens, expanded, clicked, sticky, cmdPressed, triggerHover, popoverHover]);

  // Refresh daily history when the "By day" section is opened. Also pick up
  // fresh data after every limit refresh (each fetch writes one snapshot to
  // SQLite, so the bar chart updates by ~1 sample/min while open).
  useEffect(() => {
    if (!historyExpanded) return;
    refreshHistory();
  }, [historyExpanded, refreshHistory, data]);

  // Fetch activity stats when its section opens.
  useEffect(() => {
    if (!activityExpanded) return;
    refreshActivity();
  }, [activityExpanded, refreshActivity]);

  // ── Modifier tracking ──
  // Cmd-state: derived visibility (cmd+hover transient open). Window-blur
  // reset is critical — keyup may not fire after Cmd+Tab.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey) setCmdPressed(true);
      // Cmd+Shift toggles sticky pin. !e.repeat guards against rapid toggling
      // when user holds the chord down. Only triggers when popover is already
      // open via something else — otherwise Cmd+Shift would arm a popover the
      // user never asked for.
      if (e.key === 'Shift' && (e.metaKey || e.ctrlKey) && !e.repeat) {
        const currentlyOpen = clicked || sticky || (cmdPressed && triggerHover) || popoverHover;
        if (currentlyOpen) {
          e.preventDefault();
          setSticky(prev => !prev);
          if (!sticky) {
            // Newly pinned: cement the current tab so re-fetch can fire
            setPinnedTabId(activeTabId);
          }
        }
      }
    };
    const up = (e: KeyboardEvent) => { if (!e.metaKey && !e.ctrlKey) setCmdPressed(false); };
    const blur = () => setCmdPressed(false);
    const move = (e: MouseEvent) => { if (cmdPressed && !e.metaKey && !e.ctrlKey) setCmdPressed(false); };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    window.addEventListener('mousemove', move);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
      window.removeEventListener('mousemove', move);
    };
  }, [cmdPressed, clicked, sticky, triggerHover, popoverHover, activeTabId]);

  // ── Auto-close on tab switch (non-sticky only) ──
  // When pinned via click (not sticky), switching tabs closes the popover.
  useEffect(() => {
    if (!clicked || sticky) return;
    if (pinnedTabId && activeTabId && pinnedTabId !== activeTabId) {
      setClicked(false);
      setPinnedTabId(null);
    }
  }, [activeTabId, clicked, sticky, pinnedTabId]);

  // ── Click-outside / Esc to close ──
  // Sticky pin survives EVERYTHING except an explicit Cmd+Shift toggle.
  // Clicking another tab, clicking outside, pressing Esc — none of these
  // release sticky. This is the whole point of sticky: the user wants the
  // popover to track the active tab as they navigate.
  // Light pin (clicked, not sticky) releases on outside click and Esc.
  useEffect(() => {
    if (!clicked || sticky) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (rootRef.current.contains(e.target as Node)) return;
      setClicked(false);
      setPinnedTabId(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setClicked(false); setPinnedTabId(null); }
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [clicked, sticky]);

  const showPopover = clicked || sticky || (cmdPressed && triggerHover) || popoverHover;

  // Reset expanded when popover fully closes — user explicitly wants this
  // ephemeral (not persisted across sessions or close/reopen cycles).
  useEffect(() => {
    if (!showPopover) {
      if (expanded) setExpanded(false);
      if (historyExpanded) setHistoryExpanded(false);
      if (activityExpanded) setActivityExpanded(false);
    }
  }, [showPopover, expanded, historyExpanded, activityExpanded]);

  // Tick-state for countdowns. The CHIP now shows a compact reset countdown
  // ("1d 12h") at all times, so this ticks always — not just while the popover
  // is open. 60s resolution: the coarsest unit shown is minutes, so a sub-
  // minute tick buys nothing.
  const [, setNowTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setNowTick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  const handleChipClick = () => {
    if (sticky) { setSticky(false); setClicked(false); setPinnedTabId(null); return; }
    setClicked(prev => {
      const next = !prev;
      setPinnedTabId(next ? activeTabId : null);
      return next;
    });
  };

  const selectedAccount = accounts.find((account) => account.accountKey === selectedAccountKey)
    || accounts.find((account) => account.isCurrent)
    || accounts[0]
    || null;
  const isApiPlatformAccount = selectedAccount?.kind === 'api-platform';
  const apiBilling = selectedAccount?.billing || null;
  const accountLabel = selectedAccount?.label || null;
  const accountKindLabel = isApiPlatformAccount ? 'API Platform' : 'Claude Max';
  const weeklyPct = data?.seven_day?.utilization ?? null;
  const fiveHourPct = data?.five_hour?.utilization ?? null;
  const sonnetPct = data?.seven_day_sonnet?.utilization ?? null;
  const opusPct = data?.seven_day_opus?.utilization ?? null;
  const extra = data?.extra_usage;
  const chipColor = colorForPct(weeklyPct);
  // Compact "time until weekly reset" for the chip face. null → no resets_at.
  const resetShort = formatResetShort(data?.seven_day?.resets_at);

  const selectAccount = (account: ClaudeUsageAccount) => {
    if (!account?.accountKey) return;
    setSelectedAccountKey(account.accountKey);
    setData(account.usage || null);
    setError(account.error || null);
    setNotice(account.notice || null);
    const accountWeekly = account.usage?.seven_day?.utilization ?? null;
    const accountFiveHour = account.usage?.five_hour?.utilization ?? null;
    console.log(
      `[ClaudeUsage] account selected account=${account.label} kind=${account.kind || 'unknown'} weekly=${accountWeekly ?? 'null'} fiveHour=${accountFiveHour ?? 'null'}`
    );
  };

  // Border style: sticky uses brighter white for "this is pinned long-term"
  const popoverBorder = sticky
    ? '1px solid rgba(255,255,255,0.45)'
    : clicked
      ? '1px solid rgba(255,255,255,0.2)'
      : '1px solid rgba(255,255,255,0.08)';

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <button
        onClick={handleChipClick}
        onMouseEnter={() => setTriggerHover(true)}
        onMouseLeave={() => setTriggerHover(false)}
        title={weeklyPct != null
          ? `Claude ${accountLabel ? `${accountLabel} ` : ''}weekly: ${formatPct(weeklyPct)}${resetShort ? ` • resets in ${resetShort}` : ''}  •  click → pin to tab  •  ⌘+hover → peek  •  ⌘⇧ → sticky pin`
          : (notice || error || `${accountKindLabel}${accountLabel ? ` ${accountLabel}` : ''}` || 'Click to fetch Claude usage')}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          height: 26,
          padding: '0 7px',
          minWidth: 76,
          background: showPopover ? `${chipColor}0A` : 'transparent',
          color: weeklyPct != null ? chipColor : '#888',
          border: `1px solid ${sticky ? 'rgba(255,255,255,0.4)' : (showPopover ? `${chipColor}33` : 'rgba(255,255,255,0.12)')}`,
          borderRadius: 4,
          fontSize: 11,
          fontWeight: 600,
          fontVariantNumeric: 'tabular-nums',
          cursor: 'pointer',
          transition: 'background-color 0.12s, color 0.12s, border-color 0.12s',
        }}
      >
        {loading && !data ? (
          '…'
        ) : isApiPlatformAccount && !data && !error ? (
          <>
            <ClaudeSparkle size={12} color="#9ca3af" />
            <span>API</span>
          </>
        ) : error && !data ? (
          <>
            <ClaudeSparkle size={12} color={isApiPlatformAccount ? '#9ca3af' : '#777'} />
            <span>{isApiPlatformAccount ? 'API' : '—'}</span>
          </>
        ) : (
          <>
            <ClaudeSparkle size={12} color={weeklyPct != null ? '#DA7756' : '#777'} />
            <span>{formatPct(weeklyPct)}</span>
            {/* Compact reset countdown. Deliberately muted neutral, NOT the
                severity color — the % already owns the color signal; a second
                colored token would fight it for attention in a tiny chip. */}
            {resetShort && (
              <span style={{ color: '#6b7280', fontWeight: 500 }}>{resetShort}</span>
            )}
          </>
        )}
      </button>

      {showPopover && (
        <div
          onMouseEnter={() => setPopoverHover(true)}
          onMouseLeave={() => setPopoverHover(false)}
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            right: 0,
            width: 320,
            background: '#161616',
            border: popoverBorder,
            borderRadius: 6,
            boxShadow: '0 6px 20px rgba(0,0,0,0.55)',
            zIndex: 1000,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {(accounts.length > 1 || isApiPlatformAccount) && (
            <div style={{
              padding: '7px 12px',
              borderBottom: '1px solid rgba(255,255,255,0.07)',
              display: 'flex',
              justifyContent: 'center',
            }}>
              <div style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 2,
                padding: 2,
                background: 'rgba(255,255,255,0.05)',
                border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: 999,
                maxWidth: '100%',
              }}>
                {accounts.map((account, idx) => {
                  const active = account.accountKey === (selectedAccount?.accountKey || selectedAccountKey);
                  const accountWeekly = account.usage?.seven_day?.utilization ?? null;
                  const accountFiveHour = account.usage?.five_hour?.utilization ?? null;
                  const color = account.kind === 'api-platform' && accountWeekly == null
                    ? '#9ca3af'
                    : colorForPct(accountWeekly);
                  return (
                    <button
                      key={account.accountKey || idx}
                      onClick={(e) => { e.stopPropagation(); selectAccount(account); }}
                      title={`${account.label} • ${account.accountHint || account.kind || 'Claude'}${accountWeekly != null ? ` • weekly ${formatPct(accountWeekly)} • 5-hour ${formatPct(accountFiveHour)}` : ''}${account.notice ? ` • ${account.notice}` : ''}${account.error ? ` • ${account.error}` : ''}`}
                      style={{
                        height: 20,
                        maxWidth: 132,
                        minWidth: 0,
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 5,
                        padding: '0 8px',
                        borderRadius: 999,
                        border: active ? '1px solid rgba(255,255,255,0.28)' : '1px solid transparent',
                        background: active ? 'rgba(255,255,255,0.12)' : 'transparent',
                        color: active ? '#f3f4f6' : '#8a8a8a',
                        fontSize: 10,
                        fontWeight: active ? 700 : 500,
                        cursor: 'pointer',
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      <span style={{
                        width: 6,
                        height: 6,
                        borderRadius: 999,
                        background: color,
                        boxShadow: active ? `0 0 8px ${color}66` : 'none',
                        flexShrink: 0,
                      }} />
                      <span style={{
                        minWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}>
                        {account.label}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '8px 12px',
            borderBottom: '1px solid rgba(255,255,255,0.07)',
            fontSize: 11,
            color: '#aaa',
          }}>
            {/* Заголовок «Claude usage» убран по запросу: и так понятно из
                содержимого popover'а. На его месте — countdown до недельного
                reset'а (тот же resets_at что в строке "Weekly (all)"). Тикает
                раз в 30с пока popover открыт. */}
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {accountLabel && !isApiPlatformAccount && (
                <span style={{ color: '#aaa', maxWidth: 116, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {accountLabel}
                </span>
              )}
              {isApiPlatformAccount ? (
                <>
                  <span style={{ color: '#666' }}>Claude auth</span>
                  <span style={{ color: '#ddd' }}>API Platform</span>
                </>
              ) : data?.seven_day?.resets_at ? (
                <>
                  <span style={{ color: '#666' }}>weekly reset</span>
                  <span style={{ color: '#ddd' }}>
                    {formatResetDateTime(data.seven_day.resets_at)}
                  </span>
                </>
              ) : (
                <span style={{ color: '#666' }}>weekly reset —</span>
              )}
              {sticky && (
                <span style={{
                  fontSize: 9,
                  padding: '1px 5px',
                  borderRadius: 2,
                  background: 'rgba(255,255,255,0.1)',
                  color: '#ddd',
                  letterSpacing: 0.4,
                }}>PINNED</span>
              )}
            </span>
            <button
              onClick={(e) => { e.stopPropagation(); refresh(true); }}
              disabled={loading}
              style={{
                background: 'transparent',
                border: 'none',
                color: loading ? '#555' : '#888',
                cursor: loading ? 'default' : 'pointer',
                padding: 2,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                fontSize: 10,
              }}
              title="Refresh limits"
            >
              <RefreshCw size={11} style={{
                animation: loading ? 'spin 1s linear infinite' : 'none',
              }} />
              refresh
            </button>
          </div>

          {error && !data && (
            <div style={{ padding: '12px', fontSize: 11, color: '#f87171' }}>
              {error}
              <div style={{ marginTop: 6, color: '#666' }}>
                {isApiPlatformAccount
                  ? 'Check the Claude API key stored by Claude Code.'
                  : <>Sign in via <code>claude</code> CLI first.</>}
              </div>
            </div>
          )}

          {isApiPlatformAccount && !data && !error && (
            <div style={{
              padding: '8px 12px',
              borderTop: '1px solid rgba(255,255,255,0.07)',
              fontSize: 11,
              color: '#aaa',
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                <span>API key</span>
                <span style={{ color: '#d1d5db' }}>active</span>
              </div>
              {apiBilling?.apiKeyStatus?.orgIdShort && (
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                  <span>Org</span>
                  <span style={{ color: '#8a8a8a', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                    {apiBilling.apiKeyStatus.orgIdShort}
                  </span>
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                <span>Month spend</span>
                <span style={{ color: apiBilling?.ok ? '#d1d5db' : '#8a8a8a', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                  {apiBilling?.ok
                    ? formatBillingUsd(apiBilling.monthSpendUsd)
                    : (apiBilling?.adminKeyConfigured === false ? 'admin key missing' : '—')}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                <span>Last 7d</span>
                <span style={{ color: apiBilling?.ok ? '#d1d5db' : '#8a8a8a', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                  {apiBilling?.ok ? formatBillingUsd(apiBilling.last7dSpendUsd) : '—'}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                <span>Credits left</span>
                <span
                  title={apiBilling?.balanceNote || 'Anthropic Admin API exposes spend reports, not remaining balance.'}
                  style={{ color: '#8a8a8a', textAlign: 'right' }}
                >
                  not exposed
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                <span>Usage source</span>
                <span style={{ color: '#8a8a8a', textAlign: 'right' }}>
                  {apiBilling?.adminKeyConfigured === false ? 'local session / Console' : 'Admin API / Console'}
                </span>
              </div>
              {apiBilling?.latestBucketDate && (
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, color: '#666', fontSize: 10 }}>
                  <span>Updated</span>
                  <span style={{ textAlign: 'right' }}>{apiBilling.latestBucketDate}</span>
                </div>
              )}
              {apiBilling?.error && (
                <div style={{
                  color: '#fca5a5',
                  background: 'rgba(248,113,113,0.08)',
                  border: '1px solid rgba(248,113,113,0.12)',
                  borderRadius: 4,
                  padding: '6px 7px',
                  lineHeight: 1.35,
                }}>
                  Admin API: {apiBilling.error}
                </div>
              )}
              {apiBilling?.apiKeyStatus?.error && (
                <div style={{ color: '#a3a3a3', fontSize: 10, lineHeight: 1.35 }}>
                  API key check: {apiBilling.apiKeyStatus.error}
                </div>
              )}
            </div>
          )}

          {notice && !data && !error && (
            <div style={{
              padding: '10px 12px',
              fontSize: 11,
              color: '#a3a3a3',
              borderTop: '1px solid rgba(255,255,255,0.07)',
              lineHeight: 1.35,
            }}>
              {notice}
              <div style={{ marginTop: 6, color: '#666' }}>
                Claude Code can run with this key; this panel just has no Max quota meter for it.
              </div>
            </div>
          )}

          {data && (
            <>
              <ProgressRow label="Weekly (all)" pct={data.seven_day?.utilization} resetsAt={data.seven_day?.resets_at} />
              <ProgressRow label="5-hour" pct={fiveHourPct} resetsAt={data.five_hour?.resets_at} />
              {opusPct != null && opusPct > 0 && (
                <ProgressRow label="Weekly Opus" pct={opusPct} resetsAt={data.seven_day_opus?.resets_at} />
              )}
              {sonnetPct != null && sonnetPct > 0 && (
                <ProgressRow label="Weekly Sonnet" pct={sonnetPct} resetsAt={data.seven_day_sonnet?.resets_at} />
              )}

              {extra?.is_enabled && (
                <div style={{
                  padding: '8px 12px',
                  borderTop: '1px solid rgba(255,255,255,0.07)',
                  fontSize: 11,
                  color: '#aaa',
                  display: 'flex',
                  justifyContent: 'space-between',
                }}>
                  <span>Extra credits</span>
                  <span style={{ color: '#ddd', fontVariantNumeric: 'tabular-nums' }}>
                    {formatUsdCents(extra.used_credits)} / {formatUsdCents(extra.monthly_limit)}
                  </span>
                </div>
              )}
            </>
          )}

          {/* Per-tab tokens — collapsible. */}
          <div style={{ borderTop: '1px solid rgba(255,255,255,0.07)' }}>
            <button
              onClick={() => setExpanded(e => !e)}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '8px 12px',
                background: 'transparent',
                border: 'none',
                color: '#aaa',
                fontSize: 11,
                cursor: 'pointer',
                textAlign: 'left',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.03)'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <ChevronRight size={11} style={{
                  transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
                  transition: 'transform 0.15s',
                }} />
                This tab
                {activeClaudeSessionId && (
                  <span style={{ color: '#666', fontSize: 10, fontFamily: 'ui-monospace, monospace' }}>
                    ({activeClaudeSessionId.substring(0, 6)}…)
                  </span>
                )}
              </span>
              {expanded && activeClaudeSessionId && (
                <span
                  onClick={(e) => { e.stopPropagation(); refreshTokens(); }}
                  style={{
                    fontSize: 10,
                    color: tokensLoading ? '#555' : '#888',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 3,
                    cursor: 'pointer',
                  }}
                >
                  <RefreshCw size={9} style={{
                    animation: tokensLoading ? 'spin 1s linear infinite' : 'none',
                  }} />
                </span>
              )}
            </button>

            {expanded && (
              <div style={{ padding: '0 12px 10px' }}>
                {!activeClaudeSessionId ? (
                  <div style={{ fontSize: 10, color: '#666', padding: '4px 0' }}>
                    No active Claude session. Open a tab with Claude to see token usage.
                  </div>
                ) : !tokens ? (
                  <div style={{ fontSize: 10, color: '#666', padding: '4px 0' }}>
                    {tokensLoading ? 'Loading…' : '—'}
                  </div>
                ) : !tokens.ok ? (
                  <div style={{ fontSize: 10, color: '#f87171', padding: '4px 0' }}>
                    {tokens.error}
                  </div>
                ) : (
                  <>
                    {/* Active branch — what current state costs */}
                    <div style={{ marginBottom: 8 }}>
                      <div style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        fontSize: 10,
                        color: '#888',
                        marginBottom: 4,
                      }}>
                        <span>Active branch</span>
                        <span style={{ fontVariantNumeric: 'tabular-nums', color: '#ddd' }}>
                          {formatTokens(tokens.active?.totalTokens)} · {formatUsd(tokens.active?.totalCost)} · {tokens.active?.totalTurns ?? 0} turns
                        </span>
                      </div>
                      <div style={{
                        background: 'rgba(255,255,255,0.03)',
                        borderRadius: 3,
                        padding: '4px 8px',
                      }}>
                        {tokens.active && Object.entries(tokens.active.models).map(([k, b]) => (
                          <ModelLine key={k} modelKey={k} bucket={b} />
                        ))}
                      </div>
                    </div>

                    {/* Total in JSONL — what you actually paid */}
                    {tokens.total && tokens.total.totalCost > (tokens.active?.totalCost ?? 0) + 0.01 && (
                      <div style={{ marginBottom: 8 }}>
                        <div style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          fontSize: 10,
                          color: '#888',
                          marginBottom: 4,
                        }}>
                          <span title="Includes turns deleted by edit-range or forked away">
                            Total billed
                          </span>
                          <span style={{ fontVariantNumeric: 'tabular-nums', color: '#ddd' }}>
                            {formatTokens(tokens.total.totalTokens)} · {formatUsd(tokens.total.totalCost)}
                          </span>
                        </div>
                        {tokens.wasted && tokens.wasted.cost > 0 && (
                          <div style={{
                            fontSize: 10,
                            color: '#fb923c',
                            display: 'flex',
                            justifyContent: 'space-between',
                            paddingLeft: 8,
                          }}>
                            <span>↳ wasted on edits/forks</span>
                            <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                              {formatTokens(tokens.wasted.tokens)} · {formatUsd(tokens.wasted.cost)}
                            </span>
                          </div>
                        )}
                      </div>
                    )}

                    {(tokens.chainLength ?? 1) > 1 && (
                      <div style={{ fontSize: 9, color: '#555', textAlign: 'right', marginTop: 4 }}>
                        chain: {tokens.chainLength} files
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>

          {/* By day — collapsible 7-day bar chart of weekly% delta */}
          <div style={{ borderTop: '1px solid rgba(255,255,255,0.07)' }}>
            <button
              onClick={() => setHistoryExpanded(e => !e)}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '8px 12px',
                background: 'transparent',
                border: 'none',
                color: '#aaa',
                fontSize: 11,
                cursor: 'pointer',
                textAlign: 'left',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.03)'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <ChevronRight size={11} style={{
                  transform: historyExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                  transition: 'transform 0.15s',
                }} />
                By day
                <span style={{ color: '#666', fontSize: 10 }}>(last 7d)</span>
              </span>
              {historyExpanded && (
                <span
                  onClick={(e) => { e.stopPropagation(); refreshHistory(); }}
                  style={{
                    fontSize: 10,
                    color: historyLoading ? '#555' : '#888',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 3,
                    cursor: 'pointer',
                  }}
                >
                  <RefreshCw size={9} style={{
                    animation: historyLoading ? 'spin 1s linear infinite' : 'none',
                  }} />
                </span>
              )}
            </button>

            {historyExpanded && (
              <div style={{ padding: '0 12px 10px' }}>
                {historyError ? (
                  <div style={{ fontSize: 10, color: '#f87171', padding: '4px 0' }}>
                    {historyError}
                  </div>
                ) : history === null ? (
                  <div style={{ fontSize: 10, color: '#666', padding: '4px 0' }}>
                    {historyLoading ? 'Loading…' : '—'}
                  </div>
                ) : history.length === 0 ? (
                  <div style={{ fontSize: 10, color: '#666', padding: '4px 0' }}>
                    No history yet. Snapshots are recorded once per minute; come back tomorrow for a real number.
                  </div>
                ) : (
                  <DailyBarChart history={history} />
                )}
              </div>
            )}
          </div>

          {/* Activity — collapsible: how long agents were actively working */}
          <div style={{ borderTop: '1px solid rgba(255,255,255,0.07)' }}>
            <button
              onClick={() => setActivityExpanded(e => !e)}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '8px 12px',
                background: 'transparent',
                border: 'none',
                color: '#aaa',
                fontSize: 11,
                cursor: 'pointer',
                textAlign: 'left',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.03)'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <ChevronRight size={11} style={{
                  transform: activityExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                  transition: 'transform 0.15s',
                }} />
                Activity
                <span style={{ color: '#666', fontSize: 10 }}>(wall time)</span>
              </span>
              {activityExpanded && (
                <span
                  onClick={(e) => { e.stopPropagation(); refreshActivity(); }}
                  style={{
                    fontSize: 10,
                    color: activityLoading ? '#555' : '#888',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 3,
                    cursor: 'pointer',
                  }}
                >
                  <RefreshCw size={9} style={{
                    animation: activityLoading ? 'spin 1s linear infinite' : 'none',
                  }} />
                </span>
              )}
            </button>

            {activityExpanded && (
              <div style={{ padding: '0 12px 10px' }}>
                {!activity ? (
                  <div style={{ fontSize: 10, color: '#666', padding: '4px 0' }}>
                    {activityLoading ? 'Loading…' : '—'}
                  </div>
                ) : !activity.ok ? (
                  <div style={{ fontSize: 10, color: '#f87171', padding: '4px 0' }}>
                    {activity.error}
                  </div>
                ) : (
                  <ActivityView activity={activity} />
                )}
              </div>
            )}
          </div>

          {error && data && (() => {
            const ageMs = lastAttemptAt ? Date.now() - lastAttemptAt : null;
            const ageLabel = ageMs == null
              ? null
              : ageMs < 5_000
                ? 'just now'
                : ageMs < 60_000
                  ? `${Math.round(ageMs / 1000)}s ago`
                  : `${Math.round(ageMs / 60_000)}m ago`;
            const fresh = ageMs != null && ageMs < 2000;
            return (
              <div
                key={lastAttemptAt ?? 0}
                style={{
                  padding: '6px 12px',
                  fontSize: 10,
                  color: '#f87171',
                  borderTop: '1px solid rgba(255,255,255,0.07)',
                  animation: fresh ? 'flash-fail 0.45s ease-out' : 'none',
                }}
              >
                <span style={{ color: '#888' }}>Last attempt {ageLabel || '—'}:</span>{' '}
                <span>{error}</span>
              </div>
            );
          })()}

          {/* Hint footer for Cmd+Shift */}
          {!sticky && (clicked || popoverHover) && (
            <div style={{
              padding: '6px 12px',
              fontSize: 9,
              color: '#555',
              borderTop: '1px solid rgba(255,255,255,0.05)',
              textAlign: 'right',
              letterSpacing: 0.2,
            }}>
              ⌘⇧ to pin across tabs
            </div>
          )}
        </div>
      )}

      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        @keyframes glow-pulse {
          0%, 100% { filter: brightness(1); }
          50% { filter: brightness(1.35); }
        }
        @keyframes flash-fail {
          0%   { background: rgba(248,113,113,0.22); }
          100% { background: transparent; }
        }
      `}</style>
    </div>
  );
}

function CodexUsageChip() {
  const [clicked, setClicked] = useState(false);
  const [cmdPressed, setCmdPressed] = useState(false);
  const [triggerHover, setTriggerHover] = useState(false);
  const [popoverHover, setPopoverHover] = useState(false);
  const [data, setData] = useState<CodexUsageData | null>(null);
  const [accounts, setAccounts] = useState<CodexUsageAccount[]>([]);
  const [selectedAccountKey, setSelectedAccountKey] = useState<string | null>(() => loadStoredCodexUsageAccountKey());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [backgroundRefreshing, setBackgroundRefreshing] = useState(false);
  const [activity, setActivity] = useState<ActivityResponse | null>(null);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityExpanded, setActivityExpanded] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const refreshRetryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshSeqRef = useRef(0);

  const refresh = useCallback(async (force = false) => {
    const seq = ++refreshSeqRef.current;
    setLoading(true);
    try {
      const res: CodexUsageResponse = await ipcRenderer.invoke('codex:get-usage', {
        accountKey: selectedAccountKey,
        force,
      });
      if (seq !== refreshSeqRef.current) return;
      if (res?.success) {
        const nextAccounts = Array.isArray(res.accounts) ? res.accounts : [];
        const isRefreshing = !!res.refreshing;
        setBackgroundRefreshing(isRefreshing);
        if (nextAccounts.length > 0 || !isRefreshing) {
          setAccounts(nextAccounts);
        }
        if (res.data || !isRefreshing) {
          setData(res.data || null);
        }
        if (res.error && !res.data && nextAccounts.length === 0) {
          setError(res.error);
        } else {
          setError(null);
        }
        const nextKey = res.selectedAccountKey || nextAccounts[0]?.accountKey || null;
        if (nextAccounts.length > 0 && nextKey !== selectedAccountKey) {
          setSelectedAccountKey(nextKey);
          storeCodexUsageAccountKey(nextKey);
        }
        const selected = nextAccounts.find((account) => account.accountKey === nextKey);
        const usage = selected?.usage || res.data || null;
        const weeklyPct = usage?.seven_day?.utilization ?? usage?.secondary?.utilization ?? null;
        const fiveHourPct = usage?.five_hour?.utilization ?? usage?.primary?.utilization ?? null;
        console.log(
          `[CodexUsage] refresh ok source=${res.source || 'unknown'} account=${selected?.label || 'latest'} accounts=${nextAccounts.length} weekly=${weeklyPct ?? 'null'} fiveHour=${fiveHourPct ?? 'null'} refreshing=${isRefreshing ? 1 : 0} stale=${res.stale ? 1 : 0} force=${force}`
        );
        if (!isRefreshing && refreshRetryRef.current) {
          clearTimeout(refreshRetryRef.current);
          refreshRetryRef.current = null;
        }
        if (isRefreshing && !refreshRetryRef.current) {
          refreshRetryRef.current = setTimeout(() => {
            refreshRetryRef.current = null;
            if (document.visibilityState === 'visible') {
              refresh(false);
            }
          }, 1500);
        }
      } else {
        setBackgroundRefreshing(false);
        setError(res?.error || 'Failed to read Codex usage');
        console.warn(`[CodexUsage] refresh failed error=${res?.error || 'unknown'} force=${force}`);
      }
    } catch (e: any) {
      setBackgroundRefreshing(false);
      setError(e?.message || String(e));
      console.warn(`[CodexUsage] refresh exception error=${e?.message || String(e)} force=${force}`);
    } finally {
      if (seq === refreshSeqRef.current) {
        setLoading(false);
      }
    }
  }, [selectedAccountKey]);

  useEffect(() => {
    return () => {
      if (refreshRetryRef.current) {
        clearTimeout(refreshRetryRef.current);
        refreshRetryRef.current = null;
      }
    };
  }, []);

  const refreshActivity = useCallback(async () => {
    setActivityLoading(true);
    try {
      const res: ActivityResponse = await ipcRenderer.invoke('claude-usage:activity', { days: 14 });
      setActivity(res);
    } catch (e: any) {
      setActivity({ ok: false, error: e?.message || String(e) });
    } finally {
      setActivityLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    let id: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (id) return;
      id = setInterval(() => refresh(false), 180 * 1000);
    };
    const stop = () => {
      if (id) { clearInterval(id); id = null; }
    };
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        refresh(false);
        start();
      } else {
        stop();
      }
    };
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVis);
    return () => { stop(); document.removeEventListener('visibilitychange', onVis); };
  }, [refresh]);

  useEffect(() => {
    if (!activityExpanded) return;
    refreshActivity();
  }, [activityExpanded, refreshActivity]);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey) setCmdPressed(true);
    };
    const up = (e: KeyboardEvent) => {
      if (!e.metaKey && !e.ctrlKey) setCmdPressed(false);
    };
    const blur = () => setCmdPressed(false);
    const move = (e: MouseEvent) => {
      if (cmdPressed && !e.metaKey && !e.ctrlKey) setCmdPressed(false);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    window.addEventListener('mousemove', move);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
      window.removeEventListener('mousemove', move);
    };
  }, [cmdPressed]);

  useEffect(() => {
    if (!clicked) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (rootRef.current.contains(e.target as Node)) return;
      setClicked(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setClicked(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [clicked]);

  const showPopover = clicked || (cmdPressed && triggerHover) || popoverHover;
  useEffect(() => {
    if (!showPopover && activityExpanded) setActivityExpanded(false);
  }, [showPopover, activityExpanded]);

  const [, setNowTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setNowTick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  const selectedAccount = accounts.find((account) => account.accountKey === selectedAccountKey) || accounts[0] || null;
  const usageData = selectedAccount?.usage || data;
  const weekly = usageData?.seven_day || usageData?.secondary || null;
  const fiveHour = usageData?.five_hour || usageData?.primary || null;
  const weeklyPct = weekly?.utilization ?? null;
  const fiveHourPct = fiveHour?.utilization ?? null;
  const chipColor = colorForPct(weeklyPct);
  const fiveHourColor = colorForPct(fiveHourPct);
  const resetShort = formatResetShort(weekly?.resets_at);
  const fiveHourResetShort = formatResetShort(fiveHour?.resets_at);
  const resetTextColor = '#bbb';
  const accountLabel = selectedAccount?.label || null;
  const refreshVisualLoading = loading || backgroundRefreshing;

  const selectAccount = (account: CodexUsageAccount) => {
    if (!account?.accountKey) return;
    setSelectedAccountKey(account.accountKey);
    storeCodexUsageAccountKey(account.accountKey);
    setData(account.usage || null);
    setError(null);
    const accountWeekly = account.usage?.seven_day?.utilization ?? account.usage?.secondary?.utilization ?? null;
    const accountFiveHour = account.usage?.five_hour?.utilization ?? account.usage?.primary?.utilization ?? null;
    console.log(
      `[CodexUsage] account selected account=${account.label} weekly=${accountWeekly ?? 'null'} fiveHour=${accountFiveHour ?? 'null'}`
    );
  };

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <button
        onClick={() => setClicked(v => !v)}
        onMouseEnter={() => setTriggerHover(true)}
        onMouseLeave={() => setTriggerHover(false)}
        title={weeklyPct != null
          ? `Codex${accountLabel ? ` ${accountLabel}` : ''} weekly: ${formatPct(weeklyPct)} • 5-hour: ${formatPct(fiveHourPct)}${resetShort ? ` • weekly resets in ${resetShort}` : ''}${fiveHourResetShort ? ` • 5-hour resets in ${fiveHourResetShort}` : ''}${backgroundRefreshing ? ' • updating' : ''}`
          : (backgroundRefreshing ? 'Codex usage is updating' : (error || 'Codex usage appears after Codex writes a token_count record'))}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          height: 26,
          minWidth: 76,
          padding: '0 7px',
          background: showPopover ? `${chipColor}0A` : 'transparent',
          color: weeklyPct != null ? chipColor : '#888',
          border: `1px solid ${showPopover ? `${chipColor}33` : 'rgba(255,255,255,0.12)'}`,
          borderRadius: 4,
          fontSize: 11,
          fontWeight: 600,
          fontVariantNumeric: 'tabular-nums',
          cursor: 'pointer',
          transition: 'background-color 0.12s, color 0.12s, border-color 0.12s',
        }}
      >
        {refreshVisualLoading && !usageData ? (
          <>
            <CodexIcon size={15} muted />
            <span>…</span>
          </>
        ) : error && !usageData ? (
          <>
            <CodexIcon size={15} muted />
            <span>—</span>
          </>
        ) : (
          <>
            <CodexIcon size={15} muted={weeklyPct == null} />
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <span>{formatPct(weeklyPct)}</span>
              {resetShort && <span style={{ color: resetTextColor, fontWeight: 500 }}>{resetShort}</span>}
            </span>
            <span style={{ color: resetTextColor, fontWeight: 500 }}>/</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <span style={{ color: fiveHourPct != null ? fiveHourColor : '#6b7280' }}>{formatPct(fiveHourPct)}</span>
              {fiveHourResetShort && <span style={{ color: resetTextColor, fontWeight: 500 }}>{fiveHourResetShort}</span>}
            </span>
          </>
        )}
      </button>

      {showPopover && (
        <div
          onMouseEnter={() => setPopoverHover(true)}
          onMouseLeave={() => setPopoverHover(false)}
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            right: 0,
            width: 320,
            background: '#161616',
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: 6,
            boxShadow: '0 6px 20px rgba(0,0,0,0.55)',
            zIndex: 1000,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {accounts.length > 1 && (
            <div style={{
              padding: '7px 12px',
              borderBottom: '1px solid rgba(255,255,255,0.07)',
              display: 'flex',
              justifyContent: 'center',
            }}>
              <div style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 2,
                padding: 2,
                background: 'rgba(255,255,255,0.05)',
                border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: 999,
                maxWidth: '100%',
              }}>
                {accounts.map((account, idx) => {
                  const active = account.accountKey === (selectedAccount?.accountKey || selectedAccountKey);
                  const accountWeekly = account.usage?.seven_day?.utilization ?? account.usage?.secondary?.utilization ?? null;
                  const accountFiveHour = account.usage?.five_hour?.utilization ?? account.usage?.primary?.utilization ?? null;
                  const color = colorForPct(accountWeekly);
                  return (
                    <button
                      key={account.accountKey || idx}
                      onClick={(e) => { e.stopPropagation(); selectAccount(account); }}
                      title={`${account.label} • weekly ${formatPct(accountWeekly)} • 5-hour ${formatPct(accountFiveHour)}${account.plan_type ? ` • ${account.plan_type}` : ''}`}
                      style={{
                        height: 20,
                        maxWidth: 132,
                        minWidth: 0,
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 5,
                        padding: '0 8px',
                        borderRadius: 999,
                        border: active ? '1px solid rgba(255,255,255,0.28)' : '1px solid transparent',
                        background: active ? 'rgba(255,255,255,0.12)' : 'transparent',
                        color: active ? '#f3f4f6' : '#8a8a8a',
                        fontSize: 10,
                        fontWeight: active ? 700 : 500,
                        cursor: 'pointer',
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      <span style={{
                        width: 6,
                        height: 6,
                        borderRadius: 999,
                        background: color,
                        boxShadow: active ? `0 0 8px ${color}66` : 'none',
                        flexShrink: 0,
                      }} />
                      <span style={{
                        minWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}>
                        {account.label}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '8px 12px',
            borderBottom: '1px solid rgba(255,255,255,0.07)',
            fontSize: 11,
            color: '#aaa',
          }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <CodexIcon size={15} />
              {accountLabel && (
                <span style={{ color: '#aaa', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {accountLabel}
                </span>
              )}
              {weekly?.resets_at ? (
                <>
                  <span style={{ color: '#666' }}>weekly reset</span>
                  <span style={{ color: '#ddd' }}>{formatResetDateTime(weekly.resets_at)}</span>
                </>
              ) : (
                <span style={{ color: '#666' }}>weekly reset —</span>
              )}
            </span>
            <button
              onClick={(e) => { e.stopPropagation(); refresh(true); }}
              disabled={loading}
              style={{
                background: 'transparent',
                border: 'none',
                color: loading ? '#555' : (backgroundRefreshing ? '#aaa' : '#888'),
                cursor: loading ? 'default' : 'pointer',
                padding: 2,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                fontSize: 10,
              }}
              title="Refresh Codex usage"
            >
              <RefreshCw size={11} style={{ animation: refreshVisualLoading ? 'spin 1s linear infinite' : 'none' }} />
              {backgroundRefreshing && !loading ? 'updating' : 'refresh'}
            </button>
          </div>

          {error && !usageData && (
            <div style={{ padding: '12px', fontSize: 11, color: '#f87171' }}>
              {error}
              <div style={{ marginTop: 6, color: '#666' }}>
                Run Codex until it writes a token count, then refresh.
              </div>
            </div>
          )}

          {usageData ? (
            <>
              <ProgressRow label="Weekly (Codex)" pct={weekly?.utilization} resetsAt={weekly?.resets_at} />
              <ProgressRow label="5-hour" pct={fiveHour?.utilization} resetsAt={fiveHour?.resets_at} />
              {(usageData.plan_type || usageData.limit_id || usageData.timestamp) && (
                <div style={{
                  padding: '6px 12px',
                  borderTop: '1px solid rgba(255,255,255,0.07)',
                  fontSize: 10,
                  color: '#777',
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 8,
                }}>
                  <span>Plan</span>
                  <span style={{ color: '#aaa', fontFamily: 'ui-monospace, monospace' }}>
                    {[usageData.plan_type, usageData.limit_id, usageData.timestamp ? formatResetDateTime(usageData.timestamp) : null].filter(Boolean).join(' · ')}
                  </span>
                </div>
              )}
            </>
          ) : !error ? (
            <div style={{ padding: '12px', fontSize: 11, color: '#666' }}>
              No Codex limit sample yet.
            </div>
          ) : null}

          <div style={{ borderTop: '1px solid rgba(255,255,255,0.07)' }}>
            <button
              onClick={() => setActivityExpanded(e => !e)}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '8px 12px',
                background: 'transparent',
                border: 'none',
                color: '#aaa',
                fontSize: 11,
                cursor: 'pointer',
                textAlign: 'left',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.03)'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <ChevronRight size={11} style={{
                  transform: activityExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                  transition: 'transform 0.15s',
                }} />
                Activity
                <span style={{ color: '#666', fontSize: 10 }}>(wall time)</span>
              </span>
              {activityExpanded && (
                <span
                  onClick={(e) => { e.stopPropagation(); refreshActivity(); }}
                  style={{
                    fontSize: 10,
                    color: activityLoading ? '#555' : '#888',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 3,
                    cursor: 'pointer',
                  }}
                >
                  <RefreshCw size={9} style={{ animation: activityLoading ? 'spin 1s linear infinite' : 'none' }} />
                </span>
              )}
            </button>

            {activityExpanded && (
              <div style={{ padding: '0 12px 10px' }}>
                {!activity ? (
                  <div style={{ fontSize: 10, color: '#666', padding: '4px 0' }}>
                    {activityLoading ? 'Loading…' : '—'}
                  </div>
                ) : !activity.ok ? (
                  <div style={{ fontSize: 10, color: '#f87171', padding: '4px 0' }}>
                    {activity.error}
                  </div>
                ) : (
                  <ActivityView activity={activity} />
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function ClaudeUsageButton() {
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <ClaudeUsageChip />
      <CodexUsageChip />
    </div>
  );
}
