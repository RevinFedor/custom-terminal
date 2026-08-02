// Unified Codex + Claude usage control for the project toolbar.
//
// Compact display: the adjoining halves show each provider's available limit
// windows; Claude appends its Fable sublimit. Both halves
// open the same popover shell; its provider toggle swaps the limit details
// while shared activity stays mounted.
// Two affordances per project convention (Cmd+Hover, design.md::Closing /
// Cmd+Shift pin):
//
//   • click          → opens popover, pinned to CURRENT tab. Switching tabs
//                      closes it. Click outside or Esc closes.
//   • Cmd+hover      → transient peek. Cursor exit closes.
//   • Cmd+Shift      → STICKY pin. White border. Survives tab/project switch,
//                      survives losing Cmd. Cmd+Shift again or click the same
//                      provider face to release.
//
// Popover contents:
//   1. Provider toggle and account history.
//   2. Current provider limits, source freshness, and provider-specific detail.
//   3. One shared expandable wall-time activity section.
//
// Backend: provider usage limits plus one shared activity summary.

import { useEffect, useLayoutEffect, useRef, useState, useCallback, useId, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  RefreshCw,
  ChevronRight,
  Plus,
  LogIn,
  LogOut,
  X,
  Copy,
  Check,
  ExternalLink,
  Loader2,
  Trash2,
} from 'lucide-react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import {
  buildCodexAdditionalLimitRows,
  buildCodexMainUsageView,
  visibleCodexResetCredits,
} from '../../utils/codexUsagePresentation.mjs';
import { ClaudeSparkle } from './CopySessionButton';

const { ipcRenderer, shell, clipboard } = (window as any).require('electron');

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
interface ModelScopedUsage {
  display_name?: string | null;
  utilization?: number | null;
  resets_at?: string | null;
}
interface UsageResponse {
  five_hour?: UsageBucket | null;
  seven_day?: UsageBucket | null;
  seven_day_opus?: UsageBucket | null;
  seven_day_sonnet?: UsageBucket | null;
  model_scoped?: ModelScopedUsage[];
  // Retained in the data contract for a possible later return; not rendered.
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
  kind?: 'max-oauth' | 'api-platform' | 'claude-managed-key' | string;
  label: string;
  accountHint?: string | null;
  accountIdHint?: string | null;
  source?: string | null;
  isCurrent?: boolean;
  stale?: boolean;
  timestamp?: string | null;
  lastError?: string | null;
  lastAttemptAt?: number | null;
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
  lastSuccessAt?: string | null;
  source?: string | null;
  stale?: boolean;
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
  authoritative_windows?: boolean;
  additional_rate_limits?: Array<{
    key: string;
    label: string;
    five_hour?: UsageBucket | null;
    seven_day?: UsageBucket | null;
  }>;
  credits?: {
    has_credits?: boolean | null;
    unlimited?: boolean | null;
    overage_limit_reached?: boolean | null;
    balance?: number | null;
  } | null;
}
interface CodexResetCredits {
  available_count: number;
  timestamp?: string | null;
  credits: Array<{
    title: string;
    expires_at: string;
  }>;
}
interface CodexUsageAccount {
  accountKey: string;
  label: string;
  accountHint?: string | null;
  accountIdHint?: string | null;
  plan_type?: string | null;
  timestamp?: string | null;
  source?: string | null;
  sourceThreadId?: string | null;
  isCurrent?: boolean;
  stale?: boolean;
  lastError?: string | null;
  warning?: string | null;
  lastAttemptAt?: number | null;
  reset_credits?: CodexResetCredits | null;
  profileId?: string | null;
  connected?: boolean;
  authStatus?: string | null;
  isDefaultProfile?: boolean;
  usage: CodexUsageData;
}
interface CodexAccountProfile {
  profileId: string;
  label: string;
  accountHint?: string | null;
  accountKey?: string | null;
  planType?: string | null;
  status: 'connected' | 'signed_out' | 'signing_in' | 'error';
  isDefault: boolean;
  canRemove: boolean;
  lastError?: string | null;
  lastCheckedAt?: number | null;
  login?: {
    verificationUrl: string;
    userCode: string;
    expiresAt: number;
  } | null;
}
interface CodexUsageResponse {
  success?: boolean;
  error?: string;
  data?: CodexUsageData | null;
  accounts?: CodexUsageAccount[];
  profiles?: CodexAccountProfile[];
  selectedAccountKey?: string | null;
  currentAccountKey?: string | null;
  source?: string | null;
  refreshing?: boolean;
  stale?: boolean;
  cacheAgeMs?: number | null;
  lastAttemptAt?: number | null;
  lastSuccessAt?: string | null;
  warning?: string | null;
}

const CODEX_USAGE_ACCOUNT_STORAGE_KEY = 'noted.codexUsage.accountKey';
const CLAUDE_USAGE_ACCOUNT_STORAGE_KEY = 'noted.claudeUsage.accountKey';

function loadStoredUsageAccountKey(storageKey: string): string | null {
  try {
    return window.localStorage.getItem(storageKey);
  } catch {
    return null;
  }
}

function storeUsageAccountKey(storageKey: string, value: string | null) {
  try {
    if (value) window.localStorage.setItem(storageKey, value);
    else window.localStorage.removeItem(storageKey);
  } catch {
    // localStorage only remembers the selection; main owns the account data.
  }
}

function loadStoredCodexUsageAccountKey(): string | null {
  return loadStoredUsageAccountKey(CODEX_USAGE_ACCOUNT_STORAGE_KEY);
}

function storeCodexUsageAccountKey(value: string | null) {
  storeUsageAccountKey(CODEX_USAGE_ACCOUNT_STORAGE_KEY, value);
}

function loadStoredClaudeUsageAccountKey(): string | null {
  return loadStoredUsageAccountKey(CLAUDE_USAGE_ACCOUNT_STORAGE_KEY);
}

function storeClaudeUsageAccountKey(value: string | null) {
  storeUsageAccountKey(CLAUDE_USAGE_ACCOUNT_STORAGE_KEY, value);
}

const CODEX_USAGE_IPC_DEADLINE_MS = 12_000;
const CLAUDE_USAGE_IPC_DEADLINE_MS = 12_000;
const USAGE_DETAILS_IPC_DEADLINE_MS = 12_000;

function invokeIpcWithDeadline<T>(
  channel: string,
  payload: Record<string, unknown>,
  timeoutMessage: string,
  timeoutMs = USAGE_DETAILS_IPC_DEADLINE_MS
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(timeoutMessage));
    }, timeoutMs);

    ipcRenderer.invoke(channel, payload).then(
      (value: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (reason: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(reason);
      }
    );
  });
}

function invokeCodexUsage(payload: Record<string, unknown>): Promise<CodexUsageResponse> {
  return invokeIpcWithDeadline<CodexUsageResponse>(
    'codex:get-usage',
    payload,
    'Codex usage refresh timed out',
    CODEX_USAGE_IPC_DEADLINE_MS
  );
}

interface CodexProfileActionResponse {
  success?: boolean;
  error?: string;
  profiles?: CodexAccountProfile[];
  profile?: CodexAccountProfile;
  login?: CodexAccountProfile['login'];
}

function invokeCodexProfileAction(
  channel: string,
  payload: Record<string, unknown> = {}
): Promise<CodexProfileActionResponse> {
  return invokeIpcWithDeadline<CodexProfileActionResponse>(
    channel,
    payload,
    'Codex account action timed out',
    15_000
  );
}

function invokeClaudeUsage(payload: Record<string, unknown>): Promise<ClaudeUsageIpcResponse> {
  return invokeIpcWithDeadline<ClaudeUsageIpcResponse>(
    'claude-usage:get',
    payload,
    'Claude usage refresh timed out',
    CLAUDE_USAGE_IPC_DEADLINE_MS
  );
}

function codexUsageSourceLabel(source: string | null | undefined): string {
  if (source === 'openai-usage-api') return 'OpenAI';
  if (source === 'codex-app-server') return 'Codex';
  if (source === 'active-session-rollout') return 'Codex session';
  if (source === 'codex-log' || source === 'account-log') return 'Local Codex cache';
  if (source === 'latest-rollout-unverified') return 'Unverified local cache';
  return 'Unknown source';
}

function formatSnapshotAge(timestamp: string | null | undefined): string {
  if (!timestamp) return 'unknown time';
  const ms = Date.parse(timestamp);
  if (!Number.isFinite(ms)) return 'unknown time';
  const ageMs = Math.max(0, Date.now() - ms);
  if (ageMs < 60_000) return 'just now';
  if (ageMs < 60 * 60_000) return `${Math.floor(ageMs / 60_000)}m ago`;
  if (ageMs < 24 * 60 * 60_000) return `${Math.floor(ageMs / (60 * 60_000))}h ago`;
  return formatResetDateTime(timestamp);
}

function formatBillingUsd(amount: number | null | undefined): string {
  if (amount == null) return '—';
  if (amount === 0) return '$0.00';
  if (amount < 0.01) return '<$0.01';
  if (amount >= 1000) return `$${amount.toFixed(0)}`;
  return `$${amount.toFixed(2)}`;
}

function formatPct(p: number | null | undefined): string {
  if (p == null) return '—';
  return `${Math.round(p)}%`;
}

function pctRemaining(usedPct: number | null | undefined): number | null {
  if (usedPct == null || !Number.isFinite(usedPct)) return null;
  return Math.max(0, Math.min(100, 100 - usedPct));
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

type UsageProvider = 'codex' | 'claude';

interface UsagePopoverLayout {
  top: number | null;
  bottom: number | null;
  left: number;
  width: number;
  maxHeight: number;
  bridgeTop: number;
  bridgeLeft: number;
  bridgeWidth: number;
}

interface UsageAccountOption {
  key: string;
  label: string;
  title: string;
  selected: boolean;
  current: boolean;
  connected?: boolean;
  onSelect: () => void;
}

interface UsageProviderChipProps {
  showPopover: boolean;
  sticky: boolean;
  popoverHost: HTMLDivElement | null;
  onTriggerClick: () => void;
  onTriggerEnter: () => void;
  onTriggerLeave: () => void;
  onProviderChange: (provider: UsageProvider) => void;
}

function UsageProviderToggle({
  provider,
  onChange,
}: {
  provider: UsageProvider;
  onChange: (provider: UsageProvider) => void;
}) {
  const nextProvider: UsageProvider = provider === 'codex' ? 'claude' : 'codex';
  return (
    <button
      type="button"
      data-usage-provider-toggle
      onClick={(event) => {
        event.stopPropagation();
        onChange(nextProvider);
      }}
      aria-label={`Show ${nextProvider === 'codex' ? 'Codex' : 'Claude'} usage`}
      title={`Switch to ${nextProvider === 'codex' ? 'Codex' : 'Claude'}`}
      style={{
        position: 'relative',
        width: 52,
        height: 24,
        padding: 2,
        border: '1px solid rgba(255,255,255,0.11)',
        borderRadius: 999,
        background: 'rgba(255,255,255,0.045)',
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        alignItems: 'center',
        cursor: 'pointer',
        flexShrink: 0,
      }}
    >
      <span
        aria-hidden
        style={{
          position: 'absolute',
          top: 2,
          bottom: 2,
          left: provider === 'codex' ? 2 : 26,
          width: 22,
          borderRadius: 999,
          background: 'rgba(255,255,255,0.14)',
          border: '1px solid rgba(255,255,255,0.18)',
          transition: 'left 0.14s ease',
        }}
      />
      <span style={{ position: 'relative', zIndex: 1, display: 'grid', placeItems: 'center' }}>
        <CodexIcon size={14} muted={provider !== 'codex'} />
      </span>
      <span style={{ position: 'relative', zIndex: 1, display: 'grid', placeItems: 'center' }}>
        <ClaudeSparkle size={13} color={provider === 'claude' ? '#DA7756' : '#666'} />
      </span>
    </button>
  );
}

function UsagePopoverTopRow({
  provider,
  onProviderChange,
  accounts,
  trailingAction,
}: {
  provider: UsageProvider;
  onProviderChange: (provider: UsageProvider) => void;
  accounts: UsageAccountOption[];
  trailingAction?: ReactNode;
}) {
  const visibleAccountRef = useRef<HTMLButtonElement | null>(null);
  const visibleAccountKey = accounts.find((account) => account.selected)?.key
    || accounts.find((account) => account.current)?.key
    || null;

  useLayoutEffect(() => {
    visibleAccountRef.current?.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
    });
  }, [provider, visibleAccountKey]);

  return (
    <div style={{
      minHeight: 39,
      padding: '7px 12px',
      borderBottom: '1px solid rgba(255,255,255,0.07)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 10,
    }}>
      <UsageProviderToggle provider={provider} onChange={onProviderChange} />
      <div style={{
        minWidth: 0,
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-start',
        gap: 6,
      }}>
        <div style={{ minWidth: 0, flex: 1, display: 'flex', justifyContent: 'flex-end', overflowX: 'auto' }}>
          {accounts.length > 0 && (
            <div style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 2,
              padding: 2,
              background: 'rgba(255,255,255,0.05)',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 999,
              flexShrink: 0,
              marginLeft: 'auto',
            }}>
              {accounts.map((account) => (
                <button
                  key={account.key}
                  ref={(node) => {
                    if (account.key === visibleAccountKey) visibleAccountRef.current = node;
                  }}
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    account.onSelect();
                  }}
                  title={account.title}
                  aria-label={account.title}
                  aria-pressed={account.selected}
                  aria-current={account.current ? 'true' : undefined}
                  style={{
                    height: 20,
                    maxWidth: 132,
                    minWidth: 0,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 5,
                    padding: '0 8px',
                    borderRadius: 999,
                    border: account.selected ? '1px solid rgba(255,255,255,0.28)' : '1px solid transparent',
                    background: account.selected ? 'rgba(255,255,255,0.12)' : 'transparent',
                    color: account.selected ? '#f3f4f6' : '#8a8a8a',
                    fontSize: 10,
                    fontWeight: account.selected ? 700 : 500,
                    cursor: 'pointer',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  <span style={{
                    width: 6,
                    height: 6,
                    borderRadius: 999,
                    background: account.connected || account.current ? '#4ade80' : '#555',
                    boxShadow: account.connected || account.current ? '0 0 8px #4ade8066' : 'none',
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
              ))}
            </div>
          )}
        </div>
        {trailingAction && (
          <div style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>
            {trailingAction}
          </div>
        )}
      </div>
    </div>
  );
}

function UsageSourceRefreshRow({
  sourceText,
  loading,
  refreshDisabled,
  refreshTitle,
  onRefresh,
  actions,
}: {
  sourceText: string;
  loading: boolean;
  refreshDisabled: boolean;
  refreshTitle: string;
  onRefresh: () => void;
  actions?: ReactNode;
}) {
  return (
    <div style={{
      minHeight: 36,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 10,
      padding: '7px 12px',
      borderBottom: '1px solid rgba(255,255,255,0.07)',
      fontSize: 10,
    }}>
      <span style={{
        color: sourceText.includes('stale') ? '#d6a34a' : '#aaa',
        fontFamily: 'ui-monospace, monospace',
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}>
        {sourceText}
      </span>
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
        {actions}
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onRefresh();
          }}
          disabled={refreshDisabled}
          title={refreshTitle}
          style={{
            background: 'transparent',
            border: 'none',
            color: refreshDisabled ? '#555' : '#888',
            cursor: refreshDisabled ? 'default' : 'pointer',
            padding: 2,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 10,
            flexShrink: 0,
          }}
        >
          <RefreshCw size={11} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} />
          {loading ? 'updating' : 'refresh'}
        </button>
      </div>
    </div>
  );
}

function claudeUsageSourceLabel(source: string | null | undefined, kind?: string | null): string {
  if (source === 'claude-statusline' || source === 'statusline' || source === 'claude-code-statusline') {
    return 'Claude Code';
  }
  if (source === 'anthropic-usage-api' || source === 'anthropic-oauth-api') return 'Anthropic';
  if (source === 'admin-api') return 'Anthropic Admin';
  if (source?.startsWith('keychain:')) return kind === 'max-oauth' ? 'Anthropic' : 'Claude Code';
  if (source === 'persisted') return 'Anthropic';
  return kind === 'api-platform' || kind === 'claude-managed-key' ? 'Claude Code' : 'Anthropic';
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

function formatCodexResetCreditExpiry(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
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

function ProgressRow({
  label,
  pct,
  resetsAt,
  displayPct,
  colorPct,
}: {
  label: string;
  pct?: number | null;
  resetsAt?: string | null;
  displayPct?: number | null;
  colorPct?: number | null;
}) {
  const v = Math.max(0, Math.min(100, pct ?? 0));
  const color = colorForPct(colorPct ?? pct);
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
          {formatPct(displayPct ?? pct)}
          {resetsAt && (
            <span style={{ color: '#666', marginLeft: 8, fontSize: 10 }}>
              resets {formatResetDateTime(resetsAt)}
            </span>
          )}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={`${label}: ${formatPct(displayPct ?? pct)}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={displayPct ?? pct ?? undefined}
        style={{
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

function codexLimitShortLabel(label: string): string {
  const trimmed = String(label || '').trim();
  return trimmed.replace(/^GPT-[\d.]+-Codex-/i, '') || 'Additional';
}

function formatCodexCreditBalance(credits: CodexUsageData['credits']): string | null {
  if (!credits) return null;
  if (credits.unlimited) return 'unlimited';
  if (typeof credits.balance === 'number' && Number.isFinite(credits.balance) && credits.balance > 0) {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: credits.balance < 10 ? 2 : 0,
      maximumFractionDigits: 2,
    }).format(credits.balance);
  }
  if (credits.has_credits) return 'available';
  return null;
}

function CodexCreditBalanceRow({ credits }: { credits: CodexUsageData['credits'] }) {
  const value = formatCodexCreditBalance(credits);
  if (!value) return null;
  return (
    <div style={{
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'baseline',
      padding: '8px 12px',
      borderTop: '1px solid rgba(255,255,255,0.08)',
      fontSize: 11,
    }}>
      <span style={{ color: '#aaa' }}>Codex credits</span>
      <span style={{ color: '#ddd', fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  );
}

function CodexResetCreditsSection({
  snapshot,
  connected,
}: {
  snapshot: CodexResetCredits | null | undefined;
  connected: boolean;
}) {
  const credits = visibleCodexResetCredits(snapshot, Date.now());
  if (!connected && !snapshot) return null;
  const availableLabel = snapshot
    ? `${credits.length} available`
    : 'unavailable';
  return (
    <div style={{
      padding: '8px 12px',
      borderTop: '1px solid rgba(255,255,255,0.08)',
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
      fontSize: 11,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ color: '#ddd' }}>Usage resets</span>
        <span style={{ color: '#aaa', fontVariantNumeric: 'tabular-nums' }}>
          {availableLabel}
        </span>
      </div>
      {credits.length > 0 && (
        <div role="list" aria-label="Available Codex usage resets" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {credits.map((credit, index) => (
            <div
              role="listitem"
              key={`${credit.expires_at}-${index}`}
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}
            >
              <span style={{ color: '#888' }}>{credit.title || 'Full reset'}</span>
              <span style={{ color: '#bbb', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                expires {formatCodexResetCreditExpiry(credit.expires_at)}
              </span>
            </div>
          ))}
        </div>
      )}
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

function ClaudeUsageChip({
  showPopover,
  sticky,
  popoverHost,
  onTriggerClick,
  onTriggerEnter,
  onTriggerLeave,
  onProviderChange,
}: UsageProviderChipProps) {
  // Global usage limits (independent of tab)
  const [data, setData] = useState<UsageResponse | null>(null);
  const [accounts, setAccounts] = useState<ClaudeUsageAccount[]>([]);
  const [selectedAccountKey, setSelectedAccountKey] = useState<string | null>(() => loadStoredClaudeUsageAccountKey());
  const [currentAccountKey, setCurrentAccountKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [source, setSource] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [lastSuccessAt, setLastSuccessAt] = useState<string | null>(null);
  // Timestamp последней live-попытки (от backend). Banner показывает «Xs ago»,
  // чтобы юзер видел, что force-refresh реально стрельнул, даже если та же
  // ошибка вернулась.
  const [lastAttemptAt, setLastAttemptAt] = useState<number | null>(null);
  const refreshSeqRef = useRef(0);
  const refreshContextRef = useRef('');
  refreshContextRef.current = selectedAccountKey || '';

  const refresh = useCallback(async (force = false) => {
    const seq = ++refreshSeqRef.current;
    const requestedContext = selectedAccountKey || '';
    setLoading(true);
    try {
      const res = await invokeClaudeUsage({
        force,
        accountKey: selectedAccountKey,
      });
      if (seq !== refreshSeqRef.current || requestedContext !== refreshContextRef.current) return;
      const nextAccounts = Array.isArray(res?.accounts) ? res.accounts : [];
      const nextKey = res?.selectedAccountKey
        || nextAccounts.find((account) => account.isCurrent)?.accountKey
        || nextAccounts[0]?.accountKey
        || null;
      const selected = nextAccounts.find((account) => account.accountKey === nextKey) || nextAccounts[0] || null;
      const selectedUsage = selected?.usage || res?.data || null;
      setAccounts(nextAccounts);
      setCurrentAccountKey(res?.currentAccountKey || null);
      setSource(selected?.source || res?.source || null);
      setStale(selected?.stale ?? !!res?.stale);
      setLastSuccessAt(selected?.timestamp || res?.lastSuccessAt || null);
      if (nextKey !== selectedAccountKey) {
        setSelectedAccountKey(nextKey);
        storeClaudeUsageAccountKey(nextKey);
      }
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
      const fable = selectedUsage?.model_scoped?.find(
        (item) => String(item?.display_name || '').trim().toLowerCase() === 'fable'
      )?.utilization ?? null;
      console.log(
        `[ClaudeUsage] refresh ${res?.ok ? 'ok' : 'failed'} account=${selected?.label || 'unknown'} kind=${selected?.kind || res?.authKind || 'unknown'} accounts=${nextAccounts.length} source=${selected?.source || res?.source || 'unknown'} weekly=${weekly ?? 'null'} fiveHour=${fiveHour ?? 'null'} fable=${fable ?? 'null'} force=${force}`
      );
    } catch (e: any) {
      if (seq !== refreshSeqRef.current || requestedContext !== refreshContextRef.current) return;
      setError(e?.message || String(e));
      setNotice(null);
      console.warn(`[ClaudeUsage] refresh exception error=${e?.message || String(e)} force=${force}`);
    } finally {
      if (seq === refreshSeqRef.current) setLoading(false);
    }
  }, [selectedAccountKey]);

  useEffect(() => () => {
    refreshSeqRef.current += 1;
  }, []);

  // The existing Claude bridge emits after main has committed the statusline
  // quota sample, so normal updates are event-driven. A slow fallback catches
  // auth changes made outside a running session without hammering OAuth.
  useEffect(() => {
    refresh(false);
    let id: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (id) return;
      id = setInterval(() => refresh(false), 10 * 60 * 1000);
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
    const onBridgeUpdate = () => {
      if (document.visibilityState === 'visible') refresh(false);
    };
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVis);
    ipcRenderer.on('claude:bridge-update', onBridgeUpdate);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVis);
      ipcRenderer.removeListener('claude:bridge-update', onBridgeUpdate);
    };
  }, [refresh]);

  // Tick-state for countdowns. The CHIP now shows a compact reset countdown
  // ("1d 12h") at all times, so this ticks always — not just while the popover
  // is open. 60s resolution: the coarsest unit shown is minutes, so a sub-
  // minute tick buys nothing.
  const [, setNowTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setNowTick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  const selectedAccount = accounts.find((account) => account.accountKey === selectedAccountKey)
    || accounts.find((account) => account.isCurrent)
    || accounts[0]
    || null;
  const isApiPlatformAccount = selectedAccount?.kind === 'api-platform';
  const isManagedClaudeLogin = selectedAccount?.kind === 'claude-managed-key';
  const apiBilling = selectedAccount?.billing || null;
  const accountLabel = selectedAccount?.label || null;
  const accountKindLabel = selectedAccount?.kind === 'max-oauth'
    ? 'Claude Max'
    : (isApiPlatformAccount ? 'Claude API' : 'Claude');
  const weeklyUsedPct = data?.seven_day?.utilization ?? null;
  const fiveHourUsedPct = data?.five_hour?.utilization ?? null;
  const weeklyLeftPct = pctRemaining(weeklyUsedPct);
  const fiveHourLeftPct = pctRemaining(fiveHourUsedPct);
  const fableUsage = data?.model_scoped?.find((usage) => (
    /^fable(?:\s+\d+)?$/i.test(usage.display_name?.trim() || '')
  )) || null;
  const fableUsedPct = fableUsage?.utilization ?? null;
  const fableLeftPct = pctRemaining(fableUsedPct);
  const chipColor = colorForPct(weeklyUsedPct);
  const fiveHourColor = colorForPct(fiveHourUsedPct);
  const fableColor = colorForPct(fableUsedPct);
  // Compact "time until weekly reset" for the chip face. null → no resets_at.
  const resetShort = formatResetShort(data?.seven_day?.resets_at);
  const fiveHourResetShort = formatResetShort(data?.five_hour?.resets_at);
  const resetTextColor = '#bbb';
  const selectedIsCurrent = !!selectedAccount?.accountKey
    && (selectedAccount.isCurrent || selectedAccount.accountKey === currentAccountKey);
  const hasCurrentAccount = !!currentAccountKey
    && accounts.some((account) => account.accountKey === currentAccountKey);
  const canRetryMissingCurrentAccount = !!currentAccountKey && !hasCurrentAccount;
  const selectedStale = selectedAccount?.stale ?? stale;
  const selectedSource = selectedAccount?.source || source;
  const snapshotTimestamp = selectedAccount?.timestamp || lastSuccessAt || null;
  const refreshDisabled = loading
    || (!!selectedAccount && !selectedIsCurrent && !canRetryMissingCurrentAccount);
  const claudeSourceText = `${claudeUsageSourceLabel(selectedSource, selectedAccount?.kind)} · ${formatSnapshotAge(snapshotTimestamp)}${selectedStale ? ' · stale' : ''}${selectedIsCurrent ? ' · current' : ''}`;

  const selectAccount = (account: ClaudeUsageAccount) => {
    if (!account?.accountKey) return;
    refreshSeqRef.current += 1;
    refreshContextRef.current = account.accountKey;
    setLoading(false);
    setSelectedAccountKey(account.accountKey);
    storeClaudeUsageAccountKey(account.accountKey);
    setData(account.usage || null);
    setError(account.lastError || account.error || null);
    setNotice(account.notice || null);
    setSource(account.source || null);
    setStale(!!account.stale);
    setLastSuccessAt(account.timestamp || null);
    const accountWeekly = account.usage?.seven_day?.utilization ?? null;
    const accountFiveHour = account.usage?.five_hour?.utilization ?? null;
    console.log(
      `[ClaudeUsage] account selected account=${account.label} kind=${account.kind || 'unknown'} weekly=${accountWeekly ?? 'null'} fiveHour=${accountFiveHour ?? 'null'}`
    );
  };

  const accountOptions: UsageAccountOption[] = accounts.map((account) => {
    const accountWeeklyUsed = account.usage?.seven_day?.utilization ?? null;
    const accountFiveHourUsed = account.usage?.five_hour?.utilization ?? null;
    const accountFableUsed = account.usage?.model_scoped?.find((usage) => (
      /^fable(?:\s+\d+)?$/i.test(usage.display_name?.trim() || '')
    ))?.utilization ?? null;
    const accountCurrent = !!account.accountKey
      && (account.isCurrent || account.accountKey === currentAccountKey);
    return {
      key: account.accountKey,
      label: account.label,
      selected: account.accountKey === (selectedAccount?.accountKey || selectedAccountKey),
      current: accountCurrent,
      onSelect: () => selectAccount(account),
      title: `${account.label} • ${account.accountHint || account.kind || 'Claude'}${accountWeeklyUsed != null ? ` • weekly left ${formatPct(pctRemaining(accountWeeklyUsed))} (used ${formatPct(accountWeeklyUsed)}) • 5-hour left ${formatPct(pctRemaining(accountFiveHourUsed))} (used ${formatPct(accountFiveHourUsed)})${accountFableUsed != null ? ` • Fable left ${formatPct(pctRemaining(accountFableUsed))} (used ${formatPct(accountFableUsed)})` : ''}` : ''}${accountCurrent ? ' • current Claude login' : ''}${account.stale ? ' • stale' : ''}${account.notice ? ` • ${account.notice}` : ''}${account.lastError || account.error ? ` • ${account.lastError || account.error}` : ''}`,
    };
  });

  return (
    <div style={{ position: 'static', display: 'inline-flex', minWidth: 0, flexShrink: 0 }}>
      <button
        type="button"
        className="usage-provider-trigger usage-provider-trigger--claude"
        data-usage-provider-trigger="claude"
        onClick={onTriggerClick}
        onMouseEnter={onTriggerEnter}
        onMouseLeave={onTriggerLeave}
        aria-label={`Claude usage${accountLabel ? ` for ${accountLabel}` : ''}: weekly left ${formatPct(weeklyLeftPct)}, 5-hour left ${formatPct(fiveHourLeftPct)}${fableUsedPct != null ? `, Fable left ${formatPct(fableLeftPct)}` : ''}`}
        aria-expanded={showPopover}
        aria-haspopup="dialog"
        title={weeklyUsedPct != null || fiveHourUsedPct != null
          ? `Claude${accountLabel ? ` ${accountLabel}` : ''} weekly left: ${formatPct(weeklyLeftPct)} (used ${formatPct(weeklyUsedPct)}) • 5-hour left: ${formatPct(fiveHourLeftPct)} (used ${formatPct(fiveHourUsedPct)})${fableUsedPct != null ? ` • Fable left: ${formatPct(fableLeftPct)} (used ${formatPct(fableUsedPct)})` : ''}${resetShort ? ` • weekly resets in ${resetShort}` : ''}${fiveHourResetShort ? ` • 5-hour resets in ${fiveHourResetShort}` : ''}${loading ? ' • updating' : ''}${selectedStale ? ' • stale' : ''}  •  click → pin to tab  •  ⌘+hover → peek  •  ⌘⇧ → sticky pin`
          : (notice || error || `${accountKindLabel}${accountLabel ? ` ${accountLabel}` : ''}` || 'Click to fetch Claude usage')}
        style={{
          position: 'relative',
          zIndex: showPopover ? 1 : 0,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          height: 26,
          padding: '0 7px',
          minWidth: 76,
          maxWidth: 260,
          background: showPopover ? `${chipColor}0A` : 'transparent',
          color: weeklyUsedPct != null ? chipColor : '#888',
          border: `1px solid ${sticky ? 'rgba(255,255,255,0.4)' : (showPopover ? `${chipColor}33` : 'rgba(255,255,255,0.12)')}`,
          borderRadius: '0 4px 4px 0',
          fontSize: 11,
          fontWeight: 600,
          fontVariantNumeric: 'tabular-nums',
          whiteSpace: 'nowrap',
          cursor: 'pointer',
          transition: 'background-color 0.12s, color 0.12s, border-color 0.12s',
        }}
      >
        {loading && !data ? (
          <>
            <ClaudeSparkle size={13} color="#777" />
            <span>…</span>
          </>
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
            <ClaudeSparkle size={13} color={weeklyUsedPct != null ? '#DA7756' : '#777'} />
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <span>{formatPct(weeklyLeftPct)}</span>
              {resetShort && <span className="usage-provider-reset" style={{ color: resetTextColor, fontWeight: 500 }}>{resetShort}</span>}
            </span>
            <span style={{ color: resetTextColor, fontWeight: 500 }}>/</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <span style={{ color: fiveHourUsedPct != null ? fiveHourColor : '#6b7280' }}>{formatPct(fiveHourLeftPct)}</span>
              {fiveHourResetShort && <span className="usage-provider-reset" style={{ color: resetTextColor, fontWeight: 500 }}>{fiveHourResetShort}</span>}
            </span>
            {fableUsedPct != null && (
              <>
                <span style={{ color: resetTextColor, fontWeight: 500 }}>/</span>
                <span style={{ color: fableColor }}>{formatPct(fableLeftPct)}</span>
              </>
            )}
          </>
        )}
      </button>

      {showPopover && popoverHost && createPortal(
        <>
          <UsagePopoverTopRow
            provider="claude"
            onProviderChange={onProviderChange}
            accounts={accountOptions}
          />
          <UsageSourceRefreshRow
            sourceText={claudeSourceText}
            loading={loading}
            refreshDisabled={refreshDisabled}
            refreshTitle={selectedAccount && !selectedIsCurrent
              ? (canRetryMissingCurrentAccount
                ? 'Retry current Claude login usage'
                : 'Sign in to this Claude account to refresh it')
              : 'Refresh Claude usage'}
            onRefresh={() => refresh(true)}
          />

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
              {isApiPlatformAccount && (
                <div style={{ marginTop: 6, color: '#666' }}>
                  Claude Code can run with this key; subscription limits do not apply to API billing.
                </div>
              )}
              {isManagedClaudeLogin && (
                <div style={{ marginTop: 6, color: '#666' }}>
                  The meter appears after this Claude login returns its first response with rate limits.
                </div>
              )}
            </div>
          )}

          {data && (
            <>
              <ProgressRow
                label="Weekly left (Claude)"
                pct={weeklyLeftPct}
                displayPct={weeklyLeftPct}
                colorPct={weeklyUsedPct}
                resetsAt={data.seven_day?.resets_at}
              />
              <ProgressRow
                label="5-hour left"
                pct={fiveHourLeftPct}
                displayPct={fiveHourLeftPct}
                colorPct={fiveHourUsedPct}
                resetsAt={data.five_hour?.resets_at}
              />
              {fableUsedPct != null && (
                <ProgressRow
                  label="Fable left"
                  pct={fableLeftPct}
                  displayPct={fableLeftPct}
                  colorPct={fableUsedPct}
                />
              )}
            </>
          )}

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

        </>,
        popoverHost
      )}

      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        @keyframes flash-fail {
          0%   { background: rgba(248,113,113,0.22); }
          100% { background: transparent; }
        }
        @media (max-width: 1100px) {
          .usage-provider-reset {
            display: none !important;
          }
          .usage-provider-trigger {
            max-width: none !important;
            gap: 4px !important;
            padding-left: 5px !important;
            padding-right: 5px !important;
          }
        }
        @media (max-width: 620px) {
          [data-usage-summary-controls] {
            display: none !important;
          }
        }
      `}</style>
    </div>
  );
}

function codexProfileStatusView(profile: CodexAccountProfile) {
  if (profile.status === 'connected') return { label: 'Connected', color: '#4ade80' };
  if (profile.status === 'signing_in') return { label: 'Waiting for browser', color: '#facc15' };
  if (profile.status === 'error') return { label: 'Needs attention', color: '#f87171' };
  return { label: 'Sign in required', color: '#777' };
}

function CodexDeviceLoginSection({
  profiles,
  busyProfileId,
  actionError,
  nowMs,
  onCancelLogin,
}: {
  profiles: CodexAccountProfile[];
  busyProfileId: string | null;
  actionError: string | null;
  nowMs: number;
  onCancelLogin: (profileId: string) => void;
}) {
  const [copiedControl, setCopiedControl] = useState<string | null>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingProfiles = profiles.filter((profile) => profile.login);

  useEffect(() => () => {
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
  }, []);

  const copyText = async (value: string, control: string) => {
    try {
      if (clipboard?.writeText) clipboard.writeText(value);
      else await navigator.clipboard?.writeText?.(value);
      setCopiedControl(control);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => setCopiedControl(null), 1400);
    } catch (copyError: any) {
      console.warn(`[CodexUsage] clipboard write failed error=${copyError?.message || String(copyError)}`);
    }
  };

  if (pendingProfiles.length === 0 && !actionError) return null;

  return (
    <div data-codex-device-login-section style={{ borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
      {pendingProfiles.map((profile) => {
        const status = codexProfileStatusView(profile);
        const login = profile.login || null;
        const remainingMinutes = login
          ? Math.max(0, Math.ceil((login.expiresAt - nowMs) / 60_000))
          : 0;
        return (
          <div
            key={profile.profileId}
            data-codex-account-profile={profile.profileId}
            data-codex-account-status={profile.status}
            style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}
          >
            <div style={{
              minHeight: 40,
              padding: '6px 12px',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}>
              <span style={{
                width: 7,
                height: 7,
                borderRadius: 999,
                background: status.color,
                boxShadow: profile.status === 'connected' ? `0 0 8px ${status.color}66` : 'none',
                flexShrink: 0,
              }} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  color: '#ddd',
                  fontSize: 11,
                }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {profile.label}
                  </span>
                  {profile.isDefault && (
                    <span style={{ color: '#777', fontSize: 9, flexShrink: 0 }}>default</span>
                  )}
                </div>
                <div style={{ color: status.color, fontSize: 9, marginTop: 1 }}>
                  {status.label}{profile.planType ? ` · ${profile.planType}` : ''}
                </div>
              </div>

              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onCancelLogin(profile.profileId);
                }}
                disabled={busyProfileId === profile.profileId}
                title="Cancel sign in"
                aria-label="Cancel Codex sign in"
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: busyProfileId === profile.profileId ? '#555' : '#888',
                  padding: 4,
                  cursor: busyProfileId === profile.profileId ? 'default' : 'pointer',
                }}
              >
                {busyProfileId === profile.profileId
                  ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} />
                  : <X size={13} />}
              </button>
            </div>

            {login && (
              <div
                data-codex-device-login
                style={{
                  padding: '7px 12px 9px 27px',
                  display: 'grid',
                  gridTemplateColumns: 'minmax(0, 1fr) auto auto',
                  alignItems: 'center',
                  gap: 6,
                  background: 'rgba(250,204,21,0.035)',
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ color: '#f5f5f5', fontSize: 12, fontFamily: 'ui-monospace, monospace', fontWeight: 700 }}>
                    {login.userCode}
                  </div>
                  <div style={{ color: '#777', fontSize: 9, marginTop: 2 }}>
                    expires in {remainingMinutes}m
                  </div>
                </div>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    void copyText(login.userCode, `${profile.profileId}:code`);
                  }}
                  title="Copy one-time code"
                  aria-label="Copy one-time Codex code"
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: copiedControl === `${profile.profileId}:code` ? '#4ade80' : '#999',
                    padding: 4,
                    cursor: 'pointer',
                  }}
                >
                  {copiedControl === `${profile.profileId}:code` ? <Check size={13} /> : <Copy size={13} />}
                </button>
                <div style={{ display: 'inline-flex', alignItems: 'stretch' }}>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      void shell.openExternal(login.verificationUrl);
                    }}
                    title="Open OpenAI sign in"
                    style={{
                      height: 24,
                      padding: '0 7px',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                      border: '1px solid rgba(250,204,21,0.24)',
                      borderRadius: '4px 0 0 4px',
                      background: 'rgba(250,204,21,0.06)',
                      color: '#d8c36d',
                      fontSize: 10,
                      cursor: 'pointer',
                    }}
                  >
                    <ExternalLink size={11} />
                    Open browser
                  </button>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      void copyText(login.verificationUrl, `${profile.profileId}:link`);
                    }}
                    title="Copy OpenAI sign-in link"
                    aria-label="Copy OpenAI sign-in link"
                    style={{
                      width: 25,
                      height: 24,
                      display: 'grid',
                      placeItems: 'center',
                      border: '1px solid rgba(250,204,21,0.24)',
                      borderLeft: 'none',
                      borderRadius: '0 4px 4px 0',
                      background: 'rgba(250,204,21,0.06)',
                      color: copiedControl === `${profile.profileId}:link` ? '#4ade80' : '#d8c36d',
                      cursor: 'pointer',
                    }}
                  >
                    {copiedControl === `${profile.profileId}:link` ? <Check size={12} /> : <Copy size={12} />}
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}

      {actionError && (
        <div style={{ padding: '7px 12px', color: '#f87171', fontSize: 10 }}>
          {actionError}
        </div>
      )}
    </div>
  );
}

function CodexUsageChip({
  showPopover,
  sticky,
  popoverHost,
  onTriggerClick,
  onTriggerEnter,
  onTriggerLeave,
  onProviderChange,
}: UsageProviderChipProps) {
  const [data, setData] = useState<CodexUsageData | null>(null);
  const [accounts, setAccounts] = useState<CodexUsageAccount[]>([]);
  const [profiles, setProfiles] = useState<CodexAccountProfile[]>([]);
  const [selectedAccountKey, setSelectedAccountKey] = useState<string | null>(() => loadStoredCodexUsageAccountKey());
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [source, setSource] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [lastSuccessAt, setLastSuccessAt] = useState<string | null>(null);
  const [currentAccountKey, setCurrentAccountKey] = useState<string | null>(null);
  const [profileAction, setProfileAction] = useState<string | null>(null);
  const [profileActionError, setProfileActionError] = useState<string | null>(null);
  const refreshSeqRef = useRef(0);
  const refreshContextRef = useRef('');

  const activeTabId = useWorkspaceStore((s) => s.getEffectiveTabId());
  const activeCodexSessionId = useWorkspaceStore((s) => {
    if (!activeTabId) return null;
    for (const [, ws] of s.openProjects) {
      const t = ws.tabs.get(activeTabId);
      if (t?.codexSessionId) return t.codexSessionId;
    }
    return null;
  });
  const activeCodexCwd = useWorkspaceStore((s) => {
    if (!activeTabId) return null;
    for (const [, ws] of s.openProjects) {
      const t = ws.tabs.get(activeTabId);
      if (t?.codexSessionId) return t.cwd || null;
    }
    return null;
  });

  const refreshContext = `${selectedAccountKey || ''}|${activeCodexSessionId || ''}|${activeCodexCwd || ''}`;
  refreshContextRef.current = refreshContext;

  const refresh = useCallback(async (force = false) => {
    const seq = ++refreshSeqRef.current;
    const requestedContext = `${selectedAccountKey || ''}|${activeCodexSessionId || ''}|${activeCodexCwd || ''}`;
    setLoading(true);
    try {
      const res = await invokeCodexUsage({
        accountKey: selectedAccountKey,
        force,
        sessionId: activeCodexSessionId || undefined,
        cwd: activeCodexCwd || undefined,
      });
      if (seq !== refreshSeqRef.current || requestedContext !== refreshContextRef.current) return;
      if (res?.success) {
        const nextAccounts = Array.isArray(res.accounts) ? res.accounts : [];
        setAccounts(nextAccounts);
        setProfiles(Array.isArray(res.profiles) ? res.profiles : []);
        setData(res.data || null);
        setError(res.error || null);
        setWarning(res.warning || null);
        setSource(res.source || null);
        setStale(!!res.stale);
        setLastSuccessAt(res.lastSuccessAt || res.data?.timestamp || null);
        setCurrentAccountKey(res.currentAccountKey || null);
        const nextKey = res.selectedAccountKey || nextAccounts[0]?.accountKey || null;
        if (nextAccounts.length > 0 && nextKey !== selectedAccountKey) {
          setSelectedAccountKey(nextKey);
          storeCodexUsageAccountKey(nextKey);
        }
        const selected = nextAccounts.find((account) => account.accountKey === nextKey);
        const usage = selected?.usage || res.data || null;
        const weeklyPct = usage?.seven_day?.utilization ?? null;
        const fiveHourPct = usage?.five_hour?.utilization ?? null;
        console.log(
          `[CodexUsage] refresh ok source=${res.source || 'unknown'} account=${selected?.label || 'latest'} accounts=${nextAccounts.length} weekly=${weeklyPct ?? 'null'} fiveHour=${fiveHourPct ?? 'null'} refreshing=0 stale=${res.stale ? 1 : 0} force=${force} session=${activeCodexSessionId ? activeCodexSessionId.slice(0, 8) : 'none'}`
        );
      } else {
        setError(res?.error || 'Failed to read Codex usage');
        setWarning(null);
        setStale(true);
        console.warn(`[CodexUsage] refresh failed error=${res?.error || 'unknown'} force=${force}`);
      }
    } catch (e: any) {
      if (seq !== refreshSeqRef.current || requestedContext !== refreshContextRef.current) return;
      setError(e?.message || String(e));
      setWarning(null);
      setStale(true);
      console.warn(`[CodexUsage] refresh exception error=${e?.message || String(e)} force=${force}`);
    } finally {
      if (seq === refreshSeqRef.current) {
        setLoading(false);
      }
    }
  }, [selectedAccountKey, activeCodexSessionId, activeCodexCwd]);

  useEffect(() => {
    return () => {
      refreshSeqRef.current += 1;
    };
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
    const onProfilesUpdated = (_event: unknown, payload: any) => {
      if (Array.isArray(payload?.profiles)) setProfiles(payload.profiles);
      if (payload?.event?.error) setProfileActionError(payload.event.error);
      if (['login-completed', 'logout-completed', 'profile-removed'].includes(payload?.event?.type)) {
        void refresh(true);
      }
    };
    ipcRenderer.on('codex:account-profiles-updated', onProfilesUpdated);
    return () => ipcRenderer.removeListener('codex:account-profiles-updated', onProfilesUpdated);
  }, [refresh]);

  const runProfileAction = useCallback(async (
    channel: string,
    payload: Record<string, unknown>,
    actionKey: string,
    refreshAfter = false
  ) => {
    setProfileAction(actionKey);
    setProfileActionError(null);
    try {
      const result = await invokeCodexProfileAction(channel, payload);
      if (Array.isArray(result.profiles)) setProfiles(result.profiles);
      if (!result.success) {
        setProfileActionError(result.error || 'Codex account action failed');
        return false;
      }
      if (refreshAfter) await refresh(true);
      return true;
    } catch (profileError: any) {
      setProfileActionError(profileError?.message || String(profileError));
      return false;
    } finally {
      setProfileAction(null);
    }
  }, [refresh]);

  const startProfileLogin = useCallback((profileId?: string) => {
    void runProfileAction(
      'codex:start-account-login',
      profileId ? { profileId } : {},
      profileId || 'new'
    );
  }, [runProfileAction]);

  const cancelProfileLogin = useCallback((profileId: string) => {
    void runProfileAction('codex:cancel-account-login', { profileId }, profileId);
  }, [runProfileAction]);

  const logoutProfile = useCallback((profile: CodexAccountProfile) => {
    const warningText = profile.isDefault
      ? `Sign out ${profile.label}? New ordinary Codex launches will also be signed out.`
      : `Sign out ${profile.label}?`;
    if (!window.confirm(warningText)) return;
    void runProfileAction('codex:logout-account-profile', { profileId: profile.profileId }, profile.profileId, true);
  }, [runProfileAction]);

  const removeProfile = useCallback((profile: CodexAccountProfile) => {
    if (!window.confirm(`Remove ${profile.label} from Noted Terminal?`)) return;
    void runProfileAction('codex:remove-account-profile', { profileId: profile.profileId }, profile.profileId, true);
  }, [runProfileAction]);

  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const selectedAccount = accounts.find((account) => account.accountKey === selectedAccountKey) || accounts[0] || null;
  const selectedProfile = selectedAccount
    ? profiles.find((profile) => (
      (selectedAccount.profileId && profile.profileId === selectedAccount.profileId)
      || (profile.accountKey && profile.accountKey === selectedAccount.accountKey)
    )) || null
    : profiles.find((profile) => profile.isDefault) || null;
  const usageData = selectedAccount?.usage || data;
  const weekly = usageData?.seven_day || null;
  const fiveHour = usageData?.five_hour || null;
  const mainUsageView = buildCodexMainUsageView(usageData);
  const weeklyUsedPct = mainUsageView.weeklyUsed;
  const fiveHourUsedPct = mainUsageView.fiveHourUsed;
  const weeklyLeftPct = pctRemaining(weeklyUsedPct);
  const fiveHourLeftPct = pctRemaining(fiveHourUsedPct);
  const hasWeekly = mainUsageView.hasWeekly;
  const hasFiveHour = mainUsageView.hasFiveHour;
  const chipColor = colorForPct(hasWeekly ? weeklyUsedPct : fiveHourUsedPct);
  const fiveHourColor = colorForPct(fiveHourUsedPct);
  const resetShort = formatResetShort(weekly?.resets_at);
  const fiveHourResetShort = formatResetShort(fiveHour?.resets_at);
  const resetTextColor = '#bbb';
  const accountLabel = selectedAccount?.label || null;
  const selectedSource = selectedAccount?.source || source;
  const selectedStale = selectedAccount?.stale ?? stale;
  const selectedIsCurrent = !!selectedAccount?.accountKey
    && (selectedAccount.isCurrent || selectedAccount.accountKey === currentAccountKey);
  const selectedIsConnected = selectedAccount?.connected === true || selectedIsCurrent;
  const resetCredits = selectedIsConnected ? selectedAccount?.reset_credits : null;
  const additionalRateLimits = Array.isArray(usageData?.additional_rate_limits)
    ? usageData.additional_rate_limits
    : [];
  const additionalLimitRows = buildCodexAdditionalLimitRows(additionalRateLimits);
  const hasCurrentAccount = !!currentAccountKey
    && accounts.some((account) => account.accountKey === currentAccountKey);
  const canRetryMissingCurrentAccount = !!currentAccountKey && !hasCurrentAccount;
  const refreshDisabled = loading
    || (!!selectedAccount && !selectedIsConnected && !canRetryMissingCurrentAccount);
  const snapshotTimestamp = selectedAccount?.timestamp || lastSuccessAt || usageData?.timestamp || null;
  const refreshVisualLoading = loading;
  const ariaMetrics = [
    hasWeekly ? `weekly left ${formatPct(weeklyLeftPct)}` : null,
    hasFiveHour ? `5-hour left ${formatPct(fiveHourLeftPct)}` : null,
  ].filter(Boolean).join(', ');
  const titleMetrics = [
    hasWeekly
      ? `weekly left: ${formatPct(weeklyLeftPct)} (used ${formatPct(weeklyUsedPct)})${resetShort ? `, resets in ${resetShort}` : ''}`
      : null,
    hasFiveHour
      ? `5-hour left: ${formatPct(fiveHourLeftPct)} (used ${formatPct(fiveHourUsedPct)})${fiveHourResetShort ? `, resets in ${fiveHourResetShort}` : ''}`
      : null,
  ].filter(Boolean).join(' • ');

  const selectAccount = (account: CodexUsageAccount) => {
    if (!account?.accountKey) return;
    refreshSeqRef.current += 1;
    refreshContextRef.current = `${account.accountKey}|${activeCodexSessionId || ''}|${activeCodexCwd || ''}`;
    setLoading(false);
    setSelectedAccountKey(account.accountKey);
    storeCodexUsageAccountKey(account.accountKey);
    setData(account.usage || null);
    setError(account.lastError || null);
    setSource(account.source || null);
    setStale(!!account.stale);
    setLastSuccessAt(account.timestamp || account.usage?.timestamp || null);
    const accountIsCurrent = !!account.accountKey
      && (account.isCurrent || account.accountKey === currentAccountKey);
    const accountIsConnected = account.connected === true || accountIsCurrent;
    setWarning(!accountIsConnected && account.stale
      ? 'This Codex account is not connected. Showing its last known value.'
      : (accountIsConnected ? (account.warning || null) : null));
    const accountWeekly = account.usage?.seven_day?.utilization ?? null;
    const accountFiveHour = account.usage?.five_hour?.utilization ?? null;
    console.log(
      `[CodexUsage] account selected account=${account.label} weekly=${accountWeekly ?? 'null'} fiveHour=${accountFiveHour ?? 'null'}`
    );
  };
  const accountOptions: UsageAccountOption[] = accounts.map((account) => {
    const accountWeeklyUsed = account.usage?.seven_day?.utilization ?? null;
    const accountFiveHourUsed = account.usage?.five_hour?.utilization ?? null;
    const accountMetrics = [
      accountWeeklyUsed != null
        ? `weekly left ${formatPct(pctRemaining(accountWeeklyUsed))} (used ${formatPct(accountWeeklyUsed)})`
        : null,
      accountFiveHourUsed != null
        ? `5-hour left ${formatPct(pctRemaining(accountFiveHourUsed))} (used ${formatPct(accountFiveHourUsed)})`
        : null,
    ].filter(Boolean).join(' • ');
    const accountCurrent = !!account.accountKey
      && (account.isCurrent || account.accountKey === currentAccountKey);
    return {
      key: account.accountKey,
      label: account.label,
      selected: account.accountKey === (selectedAccount?.accountKey || selectedAccountKey),
      current: accountCurrent,
      connected: account.connected === true || accountCurrent,
      onSelect: () => selectAccount(account),
      title: `${account.label}${accountMetrics ? ` • ${accountMetrics}` : ''}${account.plan_type ? ` • ${account.plan_type}` : ''}${accountCurrent ? ' • default Codex login' : ''}${account.connected ? ' • connected' : ''}${account.stale ? ' • stale' : ''}`,
    };
  });
  const codexSourceText = `${codexUsageSourceLabel(selectedSource)} · ${formatSnapshotAge(snapshotTimestamp)}${selectedStale ? ' · stale' : ''}${selectedIsCurrent ? ' · current' : ''}`;
  const selectedProfileStatus = selectedProfile
    ? codexProfileStatusView(selectedProfile)
    : (selectedIsConnected
      ? { label: 'Connected', color: '#4ade80' }
      : { label: 'Sign in required', color: '#777' });
  const selectedProfileBusy = !!selectedProfile && profileAction === selectedProfile.profileId;
  const hasPendingLogin = profiles.some((profile) => profile.status === 'signing_in' && profile.login);
  const addAccountDisabled = profileAction !== null || hasPendingLogin;
  const sourceAccountActions = (
    <>
      <span style={{ color: selectedProfileStatus.color, fontSize: 9, whiteSpace: 'nowrap' }}>
        {selectedProfileStatus.label}{selectedProfile?.planType ? ` · ${selectedProfile.planType}` : ''}
      </span>
      {selectedProfile?.status === 'connected' ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            logoutProfile(selectedProfile);
          }}
          disabled={selectedProfileBusy}
          title={`Sign out ${selectedProfile.label}`}
          aria-label={`Sign out ${selectedProfile.label}`}
          style={{
            width: 20,
            height: 20,
            display: 'grid',
            placeItems: 'center',
            background: 'transparent',
            border: 'none',
            color: selectedProfileBusy ? '#555' : '#888',
            padding: 0,
            cursor: selectedProfileBusy ? 'default' : 'pointer',
          }}
        >
          {selectedProfileBusy
            ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} />
            : <LogOut size={12} />}
        </button>
      ) : selectedProfile?.status === 'signing_in' ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            cancelProfileLogin(selectedProfile.profileId);
          }}
          disabled={selectedProfileBusy}
          title="Cancel sign in"
          aria-label="Cancel Codex sign in"
          style={{
            width: 20,
            height: 20,
            display: 'grid',
            placeItems: 'center',
            background: 'transparent',
            border: 'none',
            color: selectedProfileBusy ? '#555' : '#888',
            padding: 0,
            cursor: selectedProfileBusy ? 'default' : 'pointer',
          }}
        >
          {selectedProfileBusy
            ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} />
            : <X size={12} />}
        </button>
      ) : (
        <>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              startProfileLogin(selectedProfile?.profileId);
            }}
            disabled={selectedProfileBusy || profileAction !== null}
            title="Sign in to Codex"
            aria-label="Sign in to Codex"
            style={{
              width: 20,
              height: 20,
              display: 'grid',
              placeItems: 'center',
              background: 'transparent',
              border: 'none',
              color: selectedProfileBusy || profileAction !== null ? '#555' : '#aaa',
              padding: 0,
              cursor: selectedProfileBusy || profileAction !== null ? 'default' : 'pointer',
            }}
          >
            {selectedProfileBusy
              ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} />
              : <LogIn size={12} />}
          </button>
          {selectedProfile?.canRemove && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                removeProfile(selectedProfile);
              }}
              disabled={selectedProfileBusy || profileAction !== null}
              title={`Remove ${selectedProfile.label}`}
              aria-label={`Remove ${selectedProfile.label}`}
              style={{
                width: 20,
                height: 20,
                display: 'grid',
                placeItems: 'center',
                background: 'transparent',
                border: 'none',
                color: selectedProfileBusy || profileAction !== null ? '#555' : '#777',
                padding: 0,
                cursor: selectedProfileBusy || profileAction !== null ? 'default' : 'pointer',
              }}
            >
              <Trash2 size={11} />
            </button>
          )}
        </>
      )}
    </>
  );

  return (
    <div style={{ position: 'static', display: 'inline-flex', minWidth: 0, flexShrink: 0 }}>
      <button
        type="button"
        className="usage-provider-trigger usage-provider-trigger--codex"
        data-usage-provider-trigger="codex"
        onClick={onTriggerClick}
        onMouseEnter={onTriggerEnter}
        onMouseLeave={onTriggerLeave}
        aria-label={`Codex usage${accountLabel ? ` for ${accountLabel}` : ''}${ariaMetrics ? `: ${ariaMetrics}` : ''}`}
        aria-expanded={showPopover}
        aria-haspopup="dialog"
        title={titleMetrics
          ? `Codex${accountLabel ? ` ${accountLabel}` : ''} ${titleMetrics}${loading ? ' • updating' : ''}${selectedStale ? ' • stale' : ''}`
          : (loading ? 'Codex usage is updating' : (error || 'Codex usage is unavailable'))}
        style={{
          position: 'relative',
          zIndex: showPopover ? 1 : 0,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          height: 26,
          minWidth: 76,
          maxWidth: 210,
          padding: '0 7px',
          background: showPopover ? `${chipColor}0A` : 'transparent',
          color: hasWeekly || hasFiveHour ? chipColor : '#888',
          border: `1px solid ${sticky ? 'rgba(255,255,255,0.4)' : (showPopover ? `${chipColor}33` : 'rgba(255,255,255,0.12)')}`,
          borderRadius: '4px 0 0 4px',
          fontSize: 11,
          fontWeight: 600,
          fontVariantNumeric: 'tabular-nums',
          whiteSpace: 'nowrap',
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
            <CodexIcon size={15} muted={!hasWeekly && !hasFiveHour} />
            {hasWeekly && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <span>{formatPct(weeklyLeftPct)}</span>
                {resetShort && <span className="usage-provider-reset" style={{ color: resetTextColor, fontWeight: 500 }}>{resetShort}</span>}
              </span>
            )}
            {mainUsageView.showDivider && <span style={{ color: resetTextColor, fontWeight: 500 }}>/</span>}
            {hasFiveHour && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <span style={{ color: fiveHourColor }}>{formatPct(fiveHourLeftPct)}</span>
                {fiveHourResetShort && <span className="usage-provider-reset" style={{ color: resetTextColor, fontWeight: 500 }}>{fiveHourResetShort}</span>}
              </span>
            )}
            {!hasWeekly && !hasFiveHour && <span>—</span>}
          </>
        )}
      </button>

      {showPopover && popoverHost && createPortal(
        <>
          <UsagePopoverTopRow
            provider="codex"
            onProviderChange={onProviderChange}
            accounts={accountOptions}
            trailingAction={(
              <button
                type="button"
                data-codex-add-account
                onClick={(event) => {
                  event.stopPropagation();
                  startProfileLogin();
                }}
                disabled={addAccountDisabled}
                title={hasPendingLogin ? 'Finish the current Codex sign in first' : 'Connect another Codex account'}
                aria-label="Connect another Codex account"
                style={{
                  width: 24,
                  height: 24,
                  display: 'grid',
                  placeItems: 'center',
                  border: '1px solid rgba(255,255,255,0.12)',
                  borderRadius: 4,
                  background: 'rgba(255,255,255,0.04)',
                  color: addAccountDisabled ? '#555' : '#aaa',
                  padding: 0,
                  cursor: addAccountDisabled ? 'default' : 'pointer',
                }}
              >
                {profileAction === 'new'
                  ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} />
                  : <Plus size={13} />}
              </button>
            )}
          />
          <UsageSourceRefreshRow
            sourceText={codexSourceText}
            loading={refreshVisualLoading}
            refreshDisabled={refreshDisabled}
            refreshTitle={selectedAccount && !selectedIsConnected
              ? (canRetryMissingCurrentAccount
                ? 'Retry current Codex login usage'
                : 'Connect this Codex account to refresh it')
              : 'Refresh Codex usage'}
            onRefresh={() => refresh(true)}
            actions={sourceAccountActions}
          />
          <CodexDeviceLoginSection
            profiles={profiles}
            busyProfileId={profileAction}
            actionError={profileActionError}
            nowMs={nowTick}
            onCancelLogin={cancelProfileLogin}
          />

          {(error || warning) && (
            <div style={{ padding: '8px 12px', fontSize: 11, color: error ? '#f87171' : '#d6a34a' }}>
              {error || warning}
            </div>
          )}

          {usageData ? (
            <>
              {hasWeekly && (
                <ProgressRow
                  label="Weekly left (Codex)"
                  pct={weeklyLeftPct}
                  displayPct={weeklyLeftPct}
                  colorPct={weeklyUsedPct}
                  resetsAt={weekly?.resets_at}
                />
              )}
              {hasFiveHour && (
                <ProgressRow
                  label="5-hour left"
                  pct={fiveHourLeftPct}
                  displayPct={fiveHourLeftPct}
                  colorPct={fiveHourUsedPct}
                  resetsAt={fiveHour?.resets_at}
                />
              )}
              {additionalLimitRows.map((row) => (
                <ProgressRow
                  key={row.key}
                  label={`${codexLimitShortLabel(row.label)} ${row.kind === 'five-hour' ? '5-hour' : 'weekly'} left`}
                  pct={pctRemaining(row.usedPercent)}
                  displayPct={pctRemaining(row.usedPercent)}
                  colorPct={row.usedPercent}
                  resetsAt={row.resetsAt}
                />
              ))}
              <CodexCreditBalanceRow credits={usageData.credits} />
            </>
          ) : !error ? (
            <div style={{ padding: '12px', fontSize: 11, color: '#666' }}>
              No Codex limit sample yet.
            </div>
          ) : null}

          <CodexResetCreditsSection snapshot={resetCredits} connected={selectedIsConnected} />

        </>,
        popoverHost
      )}
    </div>
  );
}

function SharedActivitySection({
  expanded,
  loading,
  activity,
  onToggle,
  onRefresh,
}: {
  expanded: boolean;
  loading: boolean;
  activity: ActivityResponse | null;
  onToggle: () => void;
  onRefresh: () => void;
}) {
  return (
    <div style={{ borderTop: '1px solid rgba(255,255,255,0.07)' }}>
      <div style={{
        display: 'flex',
        alignItems: 'stretch',
      }}>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          style={{
            minWidth: 0,
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            padding: '8px 12px',
            background: 'transparent',
            border: 'none',
            color: '#aaa',
            fontSize: 11,
            cursor: 'pointer',
            textAlign: 'left',
          }}
          onMouseEnter={(event) => { event.currentTarget.style.background = 'rgba(255,255,255,0.03)'; }}
          onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <ChevronRight size={11} style={{
              transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
              transition: 'transform 0.15s',
            }} />
            Activity
            <span style={{ color: '#666', fontSize: 10 }}>(wall time)</span>
          </span>
        </button>
        {expanded && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onRefresh();
            }}
            title="Refresh activity"
            aria-label="Refresh activity"
            disabled={loading}
            style={{
              width: 34,
              display: 'grid',
              placeItems: 'center',
              background: 'transparent',
              border: 'none',
              color: loading ? '#555' : '#888',
              cursor: loading ? 'default' : 'pointer',
            }}
          >
            <RefreshCw size={10} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} />
          </button>
        )}
      </div>

      {expanded && (
        <div style={{ padding: '0 12px 10px' }}>
          {!activity ? (
            <div style={{ fontSize: 10, color: '#666', padding: '4px 0' }}>
              {loading ? 'Loading…' : '—'}
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
  );
}

export default function ClaudeUsageButton() {
  const [activeProvider, setActiveProvider] = useState<UsageProvider>('codex');
  const [clicked, setClicked] = useState(false);
  const [sticky, setSticky] = useState(false);
  const [cmdPressed, setCmdPressed] = useState(false);
  const [hoveredProvider, setHoveredProvider] = useState<UsageProvider | null>(null);
  const [popoverHover, setPopoverHover] = useState(false);
  const [pinnedTabId, setPinnedTabId] = useState<string | null>(null);
  const [activity, setActivity] = useState<ActivityResponse | null>(null);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityExpanded, setActivityExpanded] = useState(false);
  const [popoverHost, setPopoverHost] = useState<HTMLDivElement | null>(null);
  const [popoverLayout, setPopoverLayout] = useState<UsagePopoverLayout | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const popoverShellRef = useRef<HTMLDivElement>(null);
  const activitySeqRef = useRef(0);
  const restoreToggleFocusRef = useRef(false);
  const focusDialogOnOpenRef = useRef(false);
  const restoreInvokerFocusRef = useRef(false);
  const invokerProviderRef = useRef<UsageProvider>('codex');
  const activeTabId = useWorkspaceStore((state) => state.getEffectiveTabId());
  const showPopover = clicked || sticky || (cmdPressed && hoveredProvider !== null) || popoverHover;

  useLayoutEffect(() => {
    if (!showPopover) {
      setPopoverLayout(null);
      return;
    }

    const updateLayout = () => {
      const root = rootRef.current;
      if (!root) return;
      const rect = root.getBoundingClientRect();
      const margin = 8;
      const gap = 4;
      const viewportWidth = Math.max(1, window.innerWidth);
      const viewportHeight = Math.max(1, window.innerHeight);
      const width = Math.max(1, Math.min(380, viewportWidth - margin * 2));
      const maxLeft = Math.max(margin, viewportWidth - width - margin);
      const left = Math.max(margin, Math.min(rect.right - width, maxLeft));
      const availableBelow = Math.max(1, viewportHeight - rect.bottom - gap - margin);
      const availableAbove = Math.max(1, rect.top - gap - margin);
      const openAbove = availableBelow < 180 && availableAbove > availableBelow;
      const next: UsagePopoverLayout = {
        top: openAbove ? null : rect.bottom + gap,
        bottom: openAbove ? viewportHeight - rect.top + gap : null,
        left,
        width,
        maxHeight: openAbove ? availableAbove : availableBelow,
        bridgeTop: openAbove ? rect.top - gap : rect.bottom,
        bridgeLeft: left,
        bridgeWidth: width,
      };
      setPopoverLayout((previous) => (
        previous
        && previous.top === next.top
        && previous.bottom === next.bottom
        && previous.left === next.left
        && previous.width === next.width
        && previous.maxHeight === next.maxHeight
        && previous.bridgeTop === next.bridgeTop
        && previous.bridgeLeft === next.bridgeLeft
        && previous.bridgeWidth === next.bridgeWidth
          ? previous
          : next
      ));
    };

    updateLayout();
    window.addEventListener('resize', updateLayout);
    window.addEventListener('scroll', updateLayout, true);
    const observer = typeof ResizeObserver !== 'undefined' && rootRef.current
      ? new ResizeObserver(updateLayout)
      : null;
    const toolbar = rootRef.current?.closest<HTMLElement>('[data-project-toolbar]') || null;
    const observeLayoutElements = () => {
      if (!observer) return;
      if (rootRef.current) observer.observe(rootRef.current);
      if (toolbar) {
        observer.observe(toolbar);
        for (const child of Array.from(toolbar.children)) {
          if (child instanceof Element) observer.observe(child);
        }
      }
    };
    observeLayoutElements();
    const mutationObserver = toolbar && typeof MutationObserver !== 'undefined'
      ? new MutationObserver(() => {
          observeLayoutElements();
          updateLayout();
        })
      : null;
    mutationObserver?.observe(toolbar, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
    return () => {
      window.removeEventListener('resize', updateLayout);
      window.removeEventListener('scroll', updateLayout, true);
      observer?.disconnect();
      mutationObserver?.disconnect();
    };
  }, [showPopover]);

  useLayoutEffect(() => {
    if (!restoreToggleFocusRef.current || !popoverHost) return;
    const toggle = rootRef.current?.querySelector<HTMLButtonElement>('[data-usage-provider-toggle]');
    if (!toggle) return;
    restoreToggleFocusRef.current = false;
    toggle.focus();
  }, [activeProvider, popoverHost]);

  useLayoutEffect(() => {
    if (!focusDialogOnOpenRef.current || !popoverLayout || !popoverShellRef.current) return;
    focusDialogOnOpenRef.current = false;
    popoverShellRef.current.focus();
  }, [popoverLayout]);

  useLayoutEffect(() => {
    if (showPopover || !restoreInvokerFocusRef.current) return;
    restoreInvokerFocusRef.current = false;
    rootRef.current
      ?.querySelector<HTMLButtonElement>(`[data-usage-provider-trigger="${invokerProviderRef.current}"]`)
      ?.focus();
  }, [showPopover]);

  const refreshActivity = useCallback(async () => {
    const seq = ++activitySeqRef.current;
    setActivityLoading(true);
    try {
      const response = await invokeIpcWithDeadline<ActivityResponse>(
        'claude-usage:activity',
        { days: 14 },
        'Usage activity timed out'
      );
      if (seq !== activitySeqRef.current) return;
      setActivity(response);
    } catch (error: any) {
      if (seq !== activitySeqRef.current) return;
      setActivity({ ok: false, error: error?.message || String(error) });
    } finally {
      if (seq === activitySeqRef.current) setActivityLoading(false);
    }
  }, []);

  useEffect(() => () => {
    activitySeqRef.current += 1;
  }, []);

  useEffect(() => {
    if (!activityExpanded || !showPopover) return;
    refreshActivity();
  }, [activityExpanded, showPopover, refreshActivity]);

  useEffect(() => {
    if (!showPopover && activityExpanded) setActivityExpanded(false);
  }, [showPopover, activityExpanded]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey) setCmdPressed(true);
      if (
        event.key === 'Shift'
        && (event.metaKey || event.ctrlKey)
        && !event.repeat
        && showPopover
      ) {
        event.preventDefault();
        setSticky((value) => {
          const next = !value;
          if (next) setPinnedTabId(activeTabId);
          return next;
        });
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (!event.metaKey && !event.ctrlKey) setCmdPressed(false);
    };
    const onBlur = () => {
      setCmdPressed(false);
      setHoveredProvider(null);
    };
    const onMove = (event: MouseEvent) => {
      if (cmdPressed && !event.metaKey && !event.ctrlKey) setCmdPressed(false);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    window.addEventListener('mousemove', onMove);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('mousemove', onMove);
    };
  }, [activeTabId, cmdPressed, showPopover]);

  useEffect(() => {
    if (!clicked || sticky) return;
    if (pinnedTabId && activeTabId && pinnedTabId !== activeTabId) {
      setClicked(false);
      setPinnedTabId(null);
    }
  }, [activeTabId, clicked, pinnedTabId, sticky]);

  useEffect(() => {
    if (!clicked || sticky) return;
    const onMouseDown = (event: MouseEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setClicked(false);
      setPopoverHover(false);
      setPinnedTabId(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      restoreInvokerFocusRef.current = true;
      setClicked(false);
      setPopoverHover(false);
      setPinnedTabId(null);
    };
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [clicked, sticky]);

  const handleTriggerClick = (provider: UsageProvider) => {
    if (sticky && provider === activeProvider) {
      setSticky(false);
      setClicked(false);
      setPinnedTabId(null);
      return;
    }
    if (clicked && provider === activeProvider) {
      setClicked(false);
      setPinnedTabId(null);
      return;
    }
    if (!showPopover) {
      focusDialogOnOpenRef.current = true;
      invokerProviderRef.current = provider;
    }
    setActiveProvider(provider);
    setClicked(true);
    setPinnedTabId(activeTabId);
  };

  const handleProviderChange = (provider: UsageProvider) => {
    const focused = document.activeElement;
    restoreToggleFocusRef.current = focused instanceof HTMLElement
      && focused.hasAttribute('data-usage-provider-toggle');
    setActiveProvider(provider);
  };

  const handleTriggerEnter = (provider: UsageProvider) => {
    setHoveredProvider(provider);
    if (!clicked && !sticky && cmdPressed) setActiveProvider(provider);
  };

  const activitySection = (
    <SharedActivitySection
      expanded={activityExpanded}
      loading={activityLoading}
      activity={activity}
      onToggle={() => setActivityExpanded((value) => !value)}
      onRefresh={refreshActivity}
    />
  );

  return (
    <div
      ref={rootRef}
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 0,
        minWidth: 0,
        maxWidth: 'min(420px, 45vw)',
        flexShrink: 0,
      }}
    >
      <CodexUsageChip
        showPopover={showPopover && activeProvider === 'codex'}
        sticky={sticky}
        popoverHost={popoverHost}
        onTriggerClick={() => handleTriggerClick('codex')}
        onTriggerEnter={() => handleTriggerEnter('codex')}
        onTriggerLeave={() => setHoveredProvider((value) => value === 'codex' ? null : value)}
        onProviderChange={handleProviderChange}
      />
      <ClaudeUsageChip
        showPopover={showPopover && activeProvider === 'claude'}
        sticky={sticky}
        popoverHost={popoverHost}
        onTriggerClick={() => handleTriggerClick('claude')}
        onTriggerEnter={() => handleTriggerEnter('claude')}
        onTriggerLeave={() => setHoveredProvider((value) => value === 'claude' ? null : value)}
        onProviderChange={handleProviderChange}
      />
      {showPopover && popoverLayout && (
        <div
          ref={popoverShellRef}
          role="dialog"
          aria-label={`${activeProvider === 'codex' ? 'Codex' : 'Claude'} usage`}
          tabIndex={-1}
          onMouseEnter={() => setPopoverHover(true)}
          onMouseLeave={() => setPopoverHover(false)}
          style={{
            position: 'fixed',
            top: popoverLayout.top ?? undefined,
            bottom: popoverLayout.bottom ?? undefined,
            left: popoverLayout.left,
            width: popoverLayout.width,
            maxHeight: popoverLayout.maxHeight,
            overflowY: 'auto',
            overscrollBehavior: 'contain',
            background: '#161616',
            border: sticky
              ? '1px solid rgba(255,255,255,0.45)'
              : '1px solid rgba(255,255,255,0.12)',
            borderRadius: 6,
            boxShadow: '0 6px 20px rgba(0,0,0,0.55)',
            zIndex: 1000,
            display: 'flex',
            flexDirection: 'column',
            outline: 'none',
          }}
        >
          <div
            ref={setPopoverHost}
            style={{
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
            }}
          />
          {activitySection}
          {!sticky && (
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
      {showPopover && popoverLayout && (
        <span
          aria-hidden
          onMouseEnter={() => setPopoverHover(true)}
          onMouseLeave={() => setPopoverHover(false)}
          style={{
            position: 'fixed',
            top: popoverLayout.bridgeTop,
            left: popoverLayout.bridgeLeft,
            width: popoverLayout.bridgeWidth,
            height: 4,
            zIndex: 999,
          }}
        />
      )}
    </div>
  );
}
