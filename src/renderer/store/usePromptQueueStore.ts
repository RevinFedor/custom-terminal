import { create } from 'zustand';
import { queuedRewindLabel, rewindIteration } from '../utils/queuedRewindLabel.mjs';
import { usePromptsStore, RUN_AFTER_LOOP_PROMPT_ID } from './usePromptsStore';
import { DEFAULT_LOOP_PROMPT, parsePersistedSharedLoopPrompt } from '../../shared/prompt-loop.mjs';
export { parsePersistedSharedLoopPrompt };
import {
  buildPromptImagePayload,
  collectPromptImageRefIds,
  getPromptImageAttachmentState,
  getPromptImageMarkerHighlightRanges,
  hasMalformedPromptImageMarker,
  inspectPromptImageAttachments,
  retainPromptImageRefsForText,
} from '../utils/promptImageAttachments.mjs';
import {
  haveSameComposerChips,
  normalizeComposerChips,
  serializeComposerDraft,
} from '../utils/composerChips.mjs';
import {
  getFirstDelayRemainingSeconds,
  normalizeFirstDelaySeconds,
} from '../utils/promptQueueDelay';
import {
  DEFAULT_RUN_AFTER_PANEL_COLLAPSED,
  panelCollapsedIsWorthPersisting,
  resolvePersistedPanelCollapsed,
} from '../utils/promptQueuePanelDefault.mjs';
import {
  appRestartTriggerIsSatisfied,
  normalizeAppRestartTrigger,
} from '../utils/promptQueueAppRestart.mjs';
import {
  isStandaloneAgentLocalCommand,
  normalizeAgentLocalCommand,
} from '../utils/agentLocalCommand.mjs';

const { ipcRenderer } = window.require('electron');

// SQLite-backed persistence via the existing app:setState / app:getState
// pattern (same as defaultClaudeEffort, debugHoverBridges, freePorts).
// Persist: items, autoRun, firstDelaySeconds, postPromptEnabled,
// postPromptText, loopPromptEnabled, panelCollapsed, previewId PER TAB. Skip:
// firstChipHintActive (UI-only).
// Serialized shape: { [tabId]: { items, autoRun, firstDelaySeconds,
//                                postPromptEnabled, postPromptText, panelCollapsed,
//                                previewId } }.
const APP_STATE_KEY_QUEUE = 'promptQueueByTab';
export const DEFAULT_SHARED_LOOP_PROMPT = DEFAULT_LOOP_PROMPT;

// Throttle disk writes — drag-reorder fires many state updates per second and
// SQLite IO on every keystroke would be wasteful. 250ms covers fast typing and
// drag-reorder without losing the last value on unmount.
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let sharedLoopPromptSaveTimer: ReturnType<typeof setTimeout> | null = null;
let hasHydratedPromptQueueStore = false;
let hydratePromptQueuePromise: Promise<void> | null = null;
const promptQueueHydrationListeners = new Set<() => void>();
const runtimeWorkflowArmTabs = new Set<string>();
const automaticRunAfterTargetClearTabs = new Set<string>();
type PromptQueueEditorLock = { token: string; itemId: string | null };
type PromptQueueEditorLockListener = (
  tabId: string,
  lock: PromptQueueEditorLock | null,
  options: { wakeAutoRun: boolean },
) => void;
const promptQueueEditorLocks = new Map<string, PromptQueueEditorLock>();
const promptQueueEditorLockListeners = new Set<PromptQueueEditorLockListener>();

export function isPromptQueueStoreHydrated(): boolean {
  return hasHydratedPromptQueueStore;
}

export function subscribePromptQueueHydration(listener: () => void): () => void {
  promptQueueHydrationListeners.add(listener);
  return () => promptQueueHydrationListeners.delete(listener);
}

export function hasRuntimeWorkflowArm(tabId: string): boolean {
  return runtimeWorkflowArmTabs.has(tabId);
}

export function consumeAutomaticRunAfterTargetClear(tabId: string): boolean {
  return automaticRunAfterTargetClearTabs.delete(tabId);
}

export function acquirePromptQueueEditorLock(
  tabId: string,
  token: string,
  itemId: string | null,
): boolean {
  const current = promptQueueEditorLocks.get(tabId);
  if (current && current.token !== token) return false;
  if (current?.itemId === itemId) return true;
  const lock = { token, itemId };
  promptQueueEditorLocks.set(tabId, lock);
  for (const listener of promptQueueEditorLockListeners) {
    listener(tabId, lock, { wakeAutoRun: false });
  }
  return true;
}

export function releasePromptQueueEditorLock(
  tabId: string,
  token: string,
  options: { wakeAutoRun?: boolean } = {},
): boolean {
  const current = promptQueueEditorLocks.get(tabId);
  if (!current || current.token !== token) return false;
  promptQueueEditorLocks.delete(tabId);
  for (const listener of promptQueueEditorLockListeners) {
    listener(tabId, null, { wakeAutoRun: options.wakeAutoRun !== false });
  }
  return true;
}

export function isPromptQueueEditorLocked(tabId: string): boolean {
  return promptQueueEditorLocks.has(tabId);
}

export function subscribePromptQueueEditorLocks(
  listener: PromptQueueEditorLockListener,
): () => void {
  promptQueueEditorLockListeners.add(listener);
  return () => promptQueueEditorLockListeners.delete(listener);
}

function markRuntimeWorkflowArm(tabId: string): void {
  // Persisted rows never pass through setters, so membership proves an actual
  // user action in this renderer even when it races hydration. Its timestamp
  // is still reconciled against abnormal outcomes before cold-start can run.
  runtimeWorkflowArmTabs.add(tabId);
}

function markPromptQueueStoreHydrated(): void {
  if (hasHydratedPromptQueueStore) return;
  hasHydratedPromptQueueStore = true;
  for (const listener of promptQueueHydrationListeners) {
    try { listener(); }
    catch (error) { console.warn('[PromptQueue] hydration listener failed:', error); }
  }
}

type PersistedTabQueueSnapshot = Pick<TabQueue,
  'items' | 'autoRun' | 'stopAfter' | 'closeAfter' | 'firstDelaySeconds'
  | 'postPromptEnabled' | 'postPromptText' | 'loopPromptEnabled' | 'loopPromptArmedAt'
  | 'runAfterTabId' | 'workflowArmedAt' | 'panelCollapsed' | 'previewId' | 'firstDelayCountdownAt'
  | 'workflowRestartPending' | 'loopRestartPending'
>;

function serializePromptQueueSnapshot(snapshot: Map<string, TabQueue>): Record<string, PersistedTabQueueSnapshot> {
  const out: Record<string, PersistedTabQueueSnapshot> = {};
  for (const [tabId, q] of snapshot) {
    // Skip cold tabs with no persistable state — saves space + avoids polluting
    // the kv store with thousands of empty rows over time. Non-default delay
    // and post-prompt are persistable too so the user's choices survive
    // restarts even when the queue is empty.
    if (
      q.items.length === 0 &&
      !q.autoRun &&
      !q.stopAfter &&
      !q.closeAfter &&
      q.firstDelaySeconds === 0 &&
      !q.postPromptEnabled &&
      !q.postPromptText &&
      !q.loopPromptEnabled &&
      !q.runAfterTabId &&
      // NOT `!q.panelCollapsed`: the panel now defaults to collapsed, so the
      // deliberate choice worth keeping is the OPPOSITE one. Both sides of this
      // pair live in promptQueuePanelDefault.mjs precisely so they cannot drift.
      !panelCollapsedIsWorthPersisting(q.panelCollapsed) &&
      !q.previewId
    ) continue;
    out[tabId] = {
      items: q.items,
      autoRun: q.autoRun,
      stopAfter: q.stopAfter,
      closeAfter: q.closeAfter,
      firstDelaySeconds: q.firstDelaySeconds,
      firstDelayCountdownAt: q.firstDelayCountdownAt,
      workflowRestartPending: q.workflowRestartPending,
      loopRestartPending: q.loopRestartPending,
      postPromptEnabled: q.postPromptEnabled,
      postPromptText: q.postPromptText,
      loopPromptEnabled: q.loopPromptEnabled,
      loopPromptArmedAt: q.loopPromptArmedAt,
      runAfterTabId: q.runAfterTabId,
      workflowArmedAt: q.workflowArmedAt,
      panelCollapsed: q.panelCollapsed,
      previewId: q.previewId,
    };
  }
  return out;
}

function scheduleSharedLoopPromptSave(text: string): void {
  if (!hasHydratedPromptQueueStore) return;
  if (sharedLoopPromptSaveTimer) clearTimeout(sharedLoopPromptSaveTimer);
  sharedLoopPromptSaveTimer = setTimeout(() => {
    sharedLoopPromptSaveTimer = null;
    usePromptsStore.getState().savePromptContent(RUN_AFTER_LOOP_PROMPT_ID, text)
      .catch((e: unknown) => console.warn('[PromptQueue] system Loop prompt save failed:', e));
  }, 250);
}

function scheduleSave(snapshot: Map<string, TabQueue>) {
  const out = serializePromptQueueSnapshot(snapshot);
  if (!hasHydratedPromptQueueStore) {
    console.warn('[PromptQueue] defer pre-hydrate save entries=' + Object.keys(out).length);
    return;
  }
  const serialized = JSON.stringify(out);
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    ipcRenderer.invoke('app:setState', { key: APP_STATE_KEY_QUEUE, value: serialized })
      .catch((e: unknown) => console.warn('[PromptQueue] save failed:', e));
  }, 250);
}

export function flushPromptQueueStoreSync(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (sharedLoopPromptSaveTimer) {
    clearTimeout(sharedLoopPromptSaveTimer);
    sharedLoopPromptSaveTimer = null;
  }
  try {
    const out = serializePromptQueueSnapshot(usePromptQueueStore.getState().queues);
    if (!hasHydratedPromptQueueStore) {
      console.warn('[PromptQueue] skip pre-hydrate sync save entries=' + Object.keys(out).length);
      return;
    }
    ipcRenderer.sendSync('app:setStateSync', { key: APP_STATE_KEY_QUEUE, value: JSON.stringify(out) });
    ipcRenderer.sendSync('ai-prompts:save-content-sync', {
      id: RUN_AFTER_LOOP_PROMPT_ID,
      content: usePromptQueueStore.getState().sharedLoopPromptText,
    });
  } catch (e) {
    console.warn('[PromptQueue] sync save failed:', e);
  }
}

// One queued prompt plus durable image references owned by Noted Terminal.
// Main materializes Claude/Codex cache paths into userData/prompt-queue-assets
// before the item becomes transferable; legacy paths are migrated on hydrate.
export type QueuedImageRef = {
  id: number;        // pasteId Claude assigned (matches the [Image #N] placeholder)
  path: string;      // stable absolute path in Noted Terminal's queue asset store
  assetId?: string;  // content-addressed filename; survives userData path changes
  mediaType: string; // image/png|jpeg|...
  size: number;      // bytes at grab time (purely informational)
  availability?: 'available' | 'missing';
  error?: string;
};

export type QueuedPromptAttachmentState = 'ready' | 'materializing' | 'missing';

export type QueuedComposerChip = {
  id: string;
  kind: 'prompt' | 'paste';
  text: string;
  label?: string;
  sourceKey?: string;
  inheritanceDepth?: number;
  inheritanceParentLabel?: string;
  createdAt?: number;
};

export type QueuedMetaAction =
  | { kind: 'restart' }
  | { kind: 'stop' }
  | { kind: 'close-tab' }
  | {
      kind: 'model-effort';
      toolType: 'claude' | 'codex';
      model: string;
      effort: string;
    }
  | {
      kind: 'rewind';
      targetUuid: string;
      targetText: string;
      targetIteration?: number;
      sourceSessionId: string;
      toolType: 'claude' | 'codex';
    };

export type QueuedPromptContextCondition = {
  kind: 'context-used';
  operator: 'gte' | 'lte';
  percent: number;
};

export function queuedMetaActionDefaultTitle(action: QueuedMetaAction): string {
  if (action.kind === 'restart') return 'Restart tab';
  if (action.kind === 'stop') return 'Stop';
  if (action.kind === 'close-tab') return 'Close tab';
  if (action.kind === 'model-effort') return 'Model → ' + action.model + ' · ' + action.effort;
  return queuedRewindLabel(action);
}

function defaultQueuedPromptContextCondition(text: string): QueuedPromptContextCondition | undefined {
  const command = String(text || '').trim();
  // A slash command is a one-line local action. A prompt that merely starts
  // with the same characters but continues as a multiline message must not be
  // silently gated. The default is applied only at creation: once the user
  // removes it, later title/body edits never resurrect it.
  if (command.includes('\n') || !/^\/compact(?:[ \t]|$)/.test(command)) return undefined;
  return { kind: 'context-used', operator: 'gte', percent: 50 };
}

export type QueuedPrompt = {
  id: string;
  // false = keep visible in the list, but skip it when Run-after picks the
  // next prompt. Undefined legacy rows are treated as enabled.
  enabled?: boolean;
  // Optional one-shot scheduling rule for this queue item. Only the enabled
  // head can consume the queue's single runtime countdown slot.
  trigger?: { kind: 'timer'; seconds: number }
    | { kind: 'onTab'; tabId: string }
    | { kind: 'app-restart'; armedInstanceId: string };
  // Independent eligibility gate. `trigger` answers WHEN to inspect the item;
  // this condition answers WHETHER it may run at that moment. Keeping them
  // separate allows e.g. "after tab B, but only when context used >= 50%".
  condition?: QueuedPromptContextCondition;
  // A queue slot can be a product action instead of text submitted to the
  // agent. Keeping it on the same durable item preserves reorder, enable,
  // per-item trigger and restart/hydration semantics without a second queue.
  metaAction?: QueuedMetaAction;
  // Human-facing label shown in the Run-after menu. The actual payload sent to
  // the agent remains `text`.
  title?: string;
  // false/undefined = title is auto-derived from the current text length.
  // true = user deliberately edited the title; text edits must not overwrite it.
  titleManual?: boolean;
  text: string;
  // Composer authoring metadata stays separate from editable text so Replay can
  // restore chips instead of leaking transport wrappers into the textarea.
  // Undefined is the backward-compatible shape for pre-chip persisted rows.
  chips?: QueuedComposerChip[];
  images: number; // number of [Image] / [Pasted image] placeholders the original input had
  // Resolved disk paths for each [Image #N] in `text`, in order of appearance.
  // Length may be < `images` if some files were missing at grab time (logged
  // as [GrabImages] ... :MISSING). Undefined for legacy chips loaded from
  // pre-imagePaths persisted state — UI should treat that as "unknown" not "zero".
  imagePaths?: QueuedImageRef[];
  attachmentState?: QueuedPromptAttachmentState;
  createdAt: number;
};

export type QueuedPromptExpectedFields = Partial<Pick<
  QueuedPrompt,
  'text' | 'chips' | 'title' | 'titleManual' | 'enabled'
>>;

export type QueuedPromptMutationOptions = {
  expected?: QueuedPromptExpectedFields;
};

export function normalizeQueuedPromptContextCondition(
  value: unknown,
): QueuedPromptContextCondition | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Partial<QueuedPromptContextCondition>;
  if (raw.kind !== 'context-used') return undefined;
  const operator = raw.operator === 'lte' ? 'lte' : raw.operator === 'gte' ? 'gte' : null;
  const rawPercent = raw.percent as unknown;
  if (rawPercent === null || rawPercent === undefined || rawPercent === '') return undefined;
  const percent = Number(rawPercent);
  if (!operator || !Number.isFinite(percent)) return undefined;
  return {
    kind: 'context-used',
    operator,
    percent: Math.max(0, Math.min(100, Math.round(percent))),
  };
}

export function queuedPromptContextConditionKey(value: unknown): string {
  const condition = normalizeQueuedPromptContextCondition(value);
  return condition ? `${condition.kind}:${condition.operator}:${condition.percent}` : '-';
}

export function queuedPromptContextConditionMatches(
  value: unknown,
  contextUsedPct: number | null | undefined,
): boolean {
  const condition = normalizeQueuedPromptContextCondition(value);
  if (!condition) return true;
  const pct = Number(contextUsedPct);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) return false;
  return condition.operator === 'gte'
    ? pct >= condition.percent
    : pct <= condition.percent;
}

function collectClaudeImageRefIds(text: string): Set<number> {
  return collectPromptImageRefIds(text) as Set<number>;
}

export type QueuedImageMarkerRange = {
  start: number;
  end: number;
  id: number;
};

export function getQueuedImageMarkerHighlightRanges(
  text: string,
  imagePaths?: QueuedImageRef[],
): QueuedImageMarkerRange[] {
  return getPromptImageMarkerHighlightRanges(text, imagePaths || []) as QueuedImageMarkerRange[];
}

export function hasMalformedQueuedImageMarker(
  text: string,
  imagePaths?: QueuedImageRef[],
): boolean {
  return hasMalformedPromptImageMarker(text, imagePaths || []);
}

function retainImagePathsForText(text: string, imagePaths?: QueuedImageRef[]): QueuedImageRef[] | undefined {
  const retained = retainPromptImageRefsForText(text, imagePaths || []) as QueuedImageRef[];
  return retained.length > 0 ? retained : undefined;
}

function mediaTypeFromPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.bmp')) return 'image/bmp';
  return 'image/png';
}

function normalizeImagePathMarkersForQueue(text: string, imagePaths?: QueuedImageRef[]): { text: string; imagePaths?: QueuedImageRef[] } {
  const existing = imagePaths || [];
  const existingByPath = new Map<string, QueuedImageRef>();
  for (const ref of existing) existingByPath.set(ref.path, ref);

  let maxId = 0;
  for (const ref of existing) maxId = Math.max(maxId, ref.id);
  for (const id of collectClaudeImageRefIds(text)) maxId = Math.max(maxId, id);

  const additions: QueuedImageRef[] = [];
  const normalizedText = text.replace(IMAGE_PATH_RE, (match, rawPath) => {
    const path = String(rawPath || '').trim();
    if (!path) return match;
    const reused = existingByPath.get(path) || additions.find((ref) => ref.path === path);
    if (reused) return `[Image #${reused.id}]`;
    const ref: QueuedImageRef = {
      id: ++maxId,
      path,
      mediaType: mediaTypeFromPath(path),
      size: 0,
    };
    additions.push(ref);
    return `[Image #${ref.id}]`;
  });

  const merged = additions.length > 0 ? [...existing, ...additions] : existing;
  return {
    text: normalizedText,
    imagePaths: retainImagePathsForText(normalizedText, merged),
  };
}

export function buildQueuedPromptPayload(item: Pick<QueuedPrompt, 'text' | 'chips' | 'imagePaths'>): string {
  // Image refs belong to the editable queue body, not to opaque prompt/paste
  // chip bodies. Materialize the body first so a literal "[Image #1]" copied
  // inside a chip stays literal and cannot consume an unrelated attachment.
  const materializedText = buildPromptImagePayload(item.text, item.imagePaths || []);
  return serializeComposerDraft({
    text: materializedText,
    chips: item.chips || [],
  });
}

export function getQueuedPromptAttachmentState(
  item: Pick<QueuedPrompt, 'text' | 'images' | 'imagePaths' | 'attachmentState'>,
): QueuedPromptAttachmentState {
  return getPromptImageAttachmentState(item) as QueuedPromptAttachmentState;
}

export type TabQueue = {
  items: QueuedPrompt[];
  // When true, as soon as the current Claude turn ends (Stop hook fires) the next item
  // is shifted off and sent via claude:send-command. After the last item runs, autoRun stays
  // true — user must explicitly disarm. This is fine because with no items the loop is a no-op.
  autoRun: boolean;
  // Deprecated wire/storage compatibility only. Stop and Close are visible
  // QueuedMetaAction items now; hydrated true flags are consumed into a tail
  // item and every current writer keeps these fields false.
  stopAfter: boolean;
  closeAfter: boolean;
  // Pinned preview slideout for which item (null = closed). Persistent so a
  // clicked chip's editor survives leaving this tab/project and returning.
  previewId: string | null;
  // Countdown (seconds) BEFORE the first queued prompt fires after Run-after is armed.
  // 0 = fire immediately on arm. Only consumed by the cold-start watcher in the runner —
  // subsequent prompts in the same queue fire on Stop hook with no delay. The value
  // persists while pending, but is consumed back to 0 after the timer actually fires.
  // See usePromptQueueRunner.ts::firstDelay.
  //
  // Two slots:
  //   firstDelaySeconds      — pending delay value (what the input shows when idle).
  //   firstDelayCountdownAt  — timestamp (Date.now()) when the active countdown started,
  //                            OR null if no countdown is running. Remaining seconds =
  //                            firstDelaySeconds - floor((Date.now() - at) / 1000). When
  //                            user disarms Run before fire, we compute remaining,
  //                            overwrite firstDelaySeconds with it, then clear the slot —
  //                            so the input shows what was left, not the original value.
  //                            When countdown reaches 0 and fires, clear both slots
  //                            to 0/null so the UI returns to 0 ч / 0 м / 0 с.
  // Neither slot is consumed for items 2..N — only on the very first arm-after-empty edge.
  firstDelaySeconds: number;
  firstDelayCountdownAt: number | null;

  // ── Post-prompt (Run After post-prompt) ──────────────────────────────────
  // When postPromptEnabled === true, the runner appends `\n\n${postPromptText}`
  // to EVERY queued item just before claude:send-command. Per-tab so different
  // Claude tabs can carry different "answer-all-clarifications-yourself" hints.
  // postPromptText is the raw text user wrote in the editor (empty = treated as
  // disabled even if enabled flag is on — appending empty string is a no-op).
  postPromptEnabled: boolean;
  postPromptText: string;

  // A persistent own-tab continuation. Unlike Post, this is a standalone
  // prompt; unlike queue items, it is not consumed after a successful send.
  // It fires only after an authoritative natural completion and repeats until
  // disabled. The separate arm timestamp prevents a newly edited Loop from
  // consuming an older completion restored from disk.
  loopPromptEnabled: boolean;
  loopPromptText: string;
  loopPromptArmedAt: number | null;

  // ── Overlay collapsed/expanded state ─────────────────────────────────────
  // Per-tab UI state for the Run-after panel. Default is COLLAPSED (see
  // utils/promptQueuePanelDefault.mjs) — a new tab shows only the rail. If the
  // user expands a specific tab, that choice persists across tab navigation and
  // app restart until they collapse it again.
  // Persisted even for empty queues, because the user's layout preference is
  // independent from whether queued prompts currently exist.
  panelCollapsed: boolean;

  // ── First-chip armed hint ────────────────────────────────────────────────
  // True when user added the FIRST chip into an empty queue while Run after
  // was OFF — the Run after pill renders one red blink, then a low-red resting
  // state as a nudge. Cleared only by explicit Run after interaction or by
  // manually emptying the queue. Re-armed every time the queue transitions from
  // 0 → 1 with autoRun=false.
  // UI-only — not persisted (re-restore would just nag the user on each boot).
  firstChipHintActive: boolean;

  // Deprecated UI-only compatibility slot for pre-meta-action state. Current
  // writers keep it false; retained in the shape so HMR/older clients do not
  // crash while crossing the migration boundary.
  stopBeforeCloseArm: boolean;

  // ── Run-after target tab ────────────────────────────────────────────────
  // When non-null, the auto-runner waits for the busy→idle transition on
  // ANOTHER tab (this id) instead of the queue-owner tab. Use case: «когда
  // вот в той вкладке (Claude/Gemini/SDK) закончится текущий стрим — отправь
  // мне следующий промпт здесь». Null = default behaviour (wait on own
  // claude:busy-state for THIS tab).
  //
  // Selecting a tab that is NOT currently active in its project is allowed:
  // runner stays in "waiting" state until that tab's busy-state becomes true
  // (user activates it and sends a prompt → loader starts) and then false.
  // The UI surfaces this with a static hourglass (waiting for activation or a
  // queued dependency) vs spinner (already busy, waiting for finish).
  //
  // Persistent so the choice survives restarts. Stale ids (target tab was
  // closed) are validated lazily in the runner — if the tab no longer exists
  // in any project workspace, the slot self-clears to null and falls back to
  // standard own-tab behaviour. Don't validate in the store (would create a
  // dependency cycle with useWorkspaceStore).
  runAfterTabId: string | null;
  // Time of the latest explicit workflow arm. It correlates restored Run-after
  // promises with classified turn outcomes so an old failure cannot cancel a
  // newer manual retry. Null is the fail-closed legacy migration value.
  workflowArmedAt: number | null;
  // A graceful app restart is not a user cancellation or successful result.
  // Ignore its old turn outcomes until fresh work starts; timers retain their
  // independent absolute deadline and may themselves start that fresh work.
  workflowRestartPending: boolean;
  loopRestartPending: boolean;
};

interface PromptQueueStore {
  // Per-tab queues. Outside Claude tabs the overlay is hidden, but state survives tab switching.
  queues: Map<string, TabQueue>;
  // One editable Loop body shared by every tab. Per-tab state keeps only the
  // enabled flag and arm timestamp; SQLite stores this text under one key.
  sharedLoopPromptText: string;

  addPrompt: (
    tabId: string,
    text: string,
    images?: number,
    imagePaths?: QueuedImageRef[],
    title?: string,
    chips?: QueuedComposerChip[],
  ) => string;
  addMetaAction: (tabId: string, action: QueuedMetaAction, title?: string) => string;
  removePrompt: (
    tabId: string,
    id: string,
    options?: QueuedPromptMutationOptions,
  ) => boolean;
  updatePrompt: (
    tabId: string,
    id: string,
    patch: {
      text?: string;
      chips?: QueuedComposerChip[];
      imagePaths?: QueuedImageRef[];
      title?: string;
      titleManual?: boolean;
      enabled?: boolean;
    },
    options?: QueuedPromptMutationOptions,
  ) => boolean;
  updatePromptText: (tabId: string, id: string, text: string) => void;
  setPromptImageRefs: (
    tabId: string,
    id: string,
    imagePaths: QueuedImageRef[] | undefined,
    attachmentState: QueuedPromptAttachmentState,
    expectedText?: string,
  ) => void;
  reorderPrompt: (tabId: string, fromIndex: number, toIndex: number) => void;
  setPromptTrigger: (tabId: string, promptId: string, trigger: QueuedPrompt['trigger'] | null) => void;
  setPromptCondition: (tabId: string, promptId: string, condition: QueuedPrompt['condition'] | null) => void;
  // Move a currently deferred card behind every other card. Returns false when
  // the item vanished or was already last; one condition pass never scans an id
  // twice, so an all-false queue cannot spin forever.
  deferPromptToEnd: (tabId: string, promptId: string) => boolean;
  clearQueue: (tabId: string) => void;

  setAutoRun: (tabId: string, value: boolean) => void;
  setStopAfter: (tabId: string, value: boolean) => void;
  setCloseAfter: (tabId: string, value: boolean) => void;
  // Set the target tab whose busy→idle transition should trigger the auto-run.
  // null = clear (fall back to own-tab autoRun behaviour).
  setRunAfterTab: (tabId: string, targetTabId: string | null) => boolean;
  // Automatic stale-target repair. Unlike the public user action above, this
  // must not refresh the workflow arm timestamp or create a runtime arm.
  clearStaleRunAfterTab: (tabId: string, expectedTargetTabId: string) => void;
  setFirstDelaySeconds: (tabId: string, value: number) => void;
  // Start the first-delay countdown for this tab. Caller must already have
  // ensured firstDelaySeconds > 0 and autoRun === true.
  startFirstDelayCountdown: (tabId: string) => void;
  // Stop the countdown, freeze remaining seconds into firstDelaySeconds.
  // remaining < 0 (or 0) → store 0 so next arm fires immediately.
  cancelFirstDelayCountdown: (tabId: string) => void;
  // Clear countdown slot WITHOUT touching firstDelaySeconds. Used for reset paths
  // that should preserve whatever pending delay value is already in the input.
  clearFirstDelayCountdown: (tabId: string) => void;
  // Countdown reached zero and is about to fire: clear active countdown and
  // consume the pending delay value so the input returns to the empty state.
  consumeFirstDelayCountdown: (tabId: string) => void;
  setPreviewId: (tabId: string, id: string | null) => void;

  // Post-prompt management. setPostPromptEnabled toggles the per-tab flag;
  // setPostPromptText writes the body. Both are persisted.
  setPostPromptEnabled: (tabId: string, value: boolean) => void;
  setPostPromptText: (tabId: string, text: string) => void;
  setLoopPromptEnabled: (tabId: string, value: boolean) => void;
  setLoopPromptText: (tabId: string, text: string) => void;
  setPanelCollapsed: (tabId: string, value: boolean) => void;

  // First-chip armed hint helpers. consumeFirstChipHint clears the flag after
  // explicit acknowledgement. (Setting it happens implicitly inside addPrompt
  // on the 0→1 edge when autoRun is false.)
  consumeFirstChipHint: (tabId: string) => void;

  // Pops the head item — used by the auto-runner when Stop hook fires. Returns null if empty.
  popNext: (tabId: string) => QueuedPrompt | null;
  commitSentHead: (tabId: string, id: string, triggerTabId: string) => {
    removed: boolean;
    beforeCount: number;
    targetCleared: boolean;
  };

  // Cancel every active workflow whose owner or selected pivot is the trigger.
  // Queued items stay available for a deliberate retry.
  disarmQueuesForTrigger: (
    triggerTabId: string,
    outcomeTs?: number | null,
    options?: {
      preservePivoted?: boolean;
      preserveLoop?: boolean;
      explicitStop?: boolean;
      runtimeInstanceId?: string | null;
      runtimeStartedAt?: number | null;
    },
  ) => string[];
  suspendWorkflowsForRestart: () => void;
  resumeWorkflowsForTrigger: (triggerTabId: string, rendererStartedAt: number) => void;

  // Drop queue state owned by a closed tab and clear run-after pivots that
  // pointed at it. Called from workspace closeTab.
  cleanupClosedTab: (tabId: string) => void;

  getQueue: (tabId: string) => TabQueue;
}

const EMPTY: TabQueue = {
  workflowRestartPending: false,
  loopRestartPending: false,
  items: [],
  autoRun: false,
  stopAfter: false,
  closeAfter: false,
  previewId: null,
  firstDelaySeconds: 0,
  firstDelayCountdownAt: null,
  postPromptEnabled: false,
  postPromptText: '',
  loopPromptEnabled: false,
  loopPromptText: DEFAULT_SHARED_LOOP_PROMPT,
  loopPromptArmedAt: null,
  panelCollapsed: DEFAULT_RUN_AFTER_PANEL_COLLAPSED,
  firstChipHintActive: false,
  stopBeforeCloseArm: false,
  runAfterTabId: null,
  workflowArmedAt: null,
};

function hasActiveQueueWorkflow(queue: Pick<TabQueue, 'autoRun' | 'stopAfter' | 'closeAfter'>): boolean {
  return queue.autoRun || queue.stopAfter || queue.closeAfter;
}

function retainedWorkflowArmedAt(
  current: TabQueue,
  next: Pick<TabQueue, 'autoRun' | 'stopAfter' | 'closeAfter'>,
  explicitArm = false,
): number | null {
  if (!hasActiveQueueWorkflow(next)) return null;
  return explicitArm ? Date.now() : current.workflowArmedAt;
}

type PreHydrateQueueField =
  | 'items'
  | 'autoRun'
  | 'stopAfter'
  | 'closeAfter'
  | 'firstDelaySeconds'
  | 'postPromptEnabled'
  | 'postPromptText'
  | 'loopPromptEnabled'
  | 'loopPromptText'
  | 'loopPromptArmedAt'
  | 'runAfterTabId'
  | 'workflowArmedAt'
  | 'firstDelayCountdownAt'
  | 'workflowRestartPending'
  | 'loopRestartPending'
  | 'panelCollapsed'
  | 'previewId'
  | 'deleted';

const preHydrateQueueChanges = new Map<string, Set<PreHydrateQueueField>>();
let preHydrateSharedLoopPromptChanged = false;

function trackPreHydrateQueueChanges(before: Map<string, TabQueue>, after: Map<string, TabQueue>): void {
  if (hasHydratedPromptQueueStore) return;
  const tabIds = new Set([...before.keys(), ...after.keys()]);
  for (const tabId of tabIds) {
    const previous = before.get(tabId);
    const current = after.get(tabId);
    if (previous === current) continue;

    let changed = preHydrateQueueChanges.get(tabId);
    if (!changed) {
      changed = new Set<PreHydrateQueueField>();
      preHydrateQueueChanges.set(tabId, changed);
    }
    if (!current) {
      if (previous) {
        changed.clear();
        changed.add('deleted');
      }
      continue;
    }

    changed.delete('deleted');
    const baseline = previous ?? EMPTY;
    if (baseline.items !== current.items) changed.add('items');
    if (baseline.autoRun !== current.autoRun) changed.add('autoRun');
    if (baseline.stopAfter !== current.stopAfter) changed.add('stopAfter');
    if (baseline.closeAfter !== current.closeAfter) changed.add('closeAfter');
    if (baseline.firstDelaySeconds !== current.firstDelaySeconds) changed.add('firstDelaySeconds');
    if (baseline.firstDelayCountdownAt !== current.firstDelayCountdownAt) changed.add('firstDelayCountdownAt');
    if (baseline.workflowRestartPending !== current.workflowRestartPending) changed.add('workflowRestartPending');
    if (baseline.loopRestartPending !== current.loopRestartPending) changed.add('loopRestartPending');
    if (baseline.postPromptEnabled !== current.postPromptEnabled) changed.add('postPromptEnabled');
    if (baseline.postPromptText !== current.postPromptText) changed.add('postPromptText');
    if (baseline.loopPromptEnabled !== current.loopPromptEnabled) changed.add('loopPromptEnabled');
    if (baseline.loopPromptText !== current.loopPromptText) changed.add('loopPromptText');
    if (baseline.loopPromptArmedAt !== current.loopPromptArmedAt) changed.add('loopPromptArmedAt');
    if (baseline.runAfterTabId !== current.runAfterTabId) changed.add('runAfterTabId');
    if (baseline.workflowArmedAt !== current.workflowArmedAt) changed.add('workflowArmedAt');
    if (baseline.panelCollapsed !== current.panelCollapsed) changed.add('panelCollapsed');
    if (baseline.previewId !== current.previewId) changed.add('previewId');
    if (changed.size === 0) preHydrateQueueChanges.delete(tabId);
  }
}

function mergeHydratedItems(persisted: QueuedPrompt[], current: QueuedPrompt[]): QueuedPrompt[] {
  const currentById = new Map(current.map((item) => [item.id, item]));
  const merged = persisted.map((item) => currentById.get(item.id) ?? item);
  const persistedIds = new Set(persisted.map((item) => item.id));
  for (const item of current) {
    if (!persistedIds.has(item.id)) merged.push(item);
  }
  return merged;
}

function mergeHydratedQueue(
  persisted: TabQueue,
  current: TabQueue | undefined,
  changed: Set<PreHydrateQueueField> | undefined,
): TabQueue | null {
  if (changed?.has('deleted') && !current) return null;
  if (!current) return persisted;

  const merged: TabQueue = {
    ...persisted,
    firstChipHintActive: current.firstChipHintActive,
    stopBeforeCloseArm: current.stopBeforeCloseArm,
  };
  if (changed?.has('items')) merged.items = mergeHydratedItems(persisted.items, current.items);
  if (changed?.has('autoRun')) merged.autoRun = current.autoRun;
  if (changed?.has('stopAfter')) merged.stopAfter = current.stopAfter;
  if (changed?.has('closeAfter')) merged.closeAfter = current.closeAfter;
  if (changed?.has('firstDelaySeconds')) merged.firstDelaySeconds = current.firstDelaySeconds;
  if (changed?.has('firstDelayCountdownAt') || changed?.has('firstDelaySeconds') || changed?.has('autoRun')) {
    merged.firstDelayCountdownAt = current.firstDelayCountdownAt;
  }
  if (changed?.has('workflowRestartPending')) merged.workflowRestartPending = current.workflowRestartPending;
  if (changed?.has('loopRestartPending')) merged.loopRestartPending = current.loopRestartPending;
  if (changed?.has('postPromptEnabled')) merged.postPromptEnabled = current.postPromptEnabled;
  if (changed?.has('postPromptText')) merged.postPromptText = current.postPromptText;
  if (changed?.has('loopPromptEnabled')) merged.loopPromptEnabled = current.loopPromptEnabled;
  if (changed?.has('loopPromptText')) merged.loopPromptText = current.loopPromptText;
  if (changed?.has('loopPromptArmedAt')) merged.loopPromptArmedAt = current.loopPromptArmedAt;
  if (changed?.has('runAfterTabId')) merged.runAfterTabId = current.runAfterTabId;
  if (changed?.has('workflowArmedAt')) merged.workflowArmedAt = current.workflowArmedAt;
  if (changed?.has('panelCollapsed')) merged.panelCollapsed = current.panelCollapsed;
  if (changed?.has('previewId')) merged.previewId = current.previewId;
  if (merged.autoRun) merged.firstChipHintActive = false;
  return merged;
}

let idCounter = 0;
const nextId = () => `pq-${Date.now().toString(36)}-${(idCounter++).toString(36)}`;

function makeQueuedMetaActionItem(action: QueuedMetaAction, title?: string): QueuedPrompt {
  const defaultTitle = queuedMetaActionDefaultTitle(action);
  const normalizedTitle = String(title || defaultTitle).trim() || defaultTitle;
  return {
    id: nextId(),
    enabled: true,
    metaAction: action,
    title: normalizedTitle,
    titleManual: true,
    text: '',
    images: 0,
    attachmentState: 'ready',
    createdAt: Date.now(),
  };
}

// ── Cross-client core shape ──────────────────────────────────────────────────
// The subset of a TabQueue that crosses the wire to mobile. The full desktop
// persistence shape above is deliberately broader: it also stores the absolute
// countdown start and restart gates, so relaunch does not reset a promised time.
// This remote contract does not transfer timer ownership or presentation slots
// (previewId, firstChipHintActive, stopBeforeCloseArm). Mobile reads it via getPromptQueue
// bridge action and receives live deltas via the `queue-update` SSE event; it
// never holds its own copy of the queue — the desktop store is the single source
// of truth and the desktop runner is the single firing engine (same model the
// effort/think window-maps use: mobile is a thin remote, not a second store).
export type PromptQueueCore = Pick<
  TabQueue,
  'items' | 'autoRun' | 'stopAfter' | 'closeAfter' | 'runAfterTabId'
  | 'firstDelaySeconds' | 'postPromptEnabled' | 'postPromptText'
  | 'loopPromptEnabled' | 'loopPromptText'
>;

export function serializePromptQueueCore(q: TabQueue): PromptQueueCore {
  return {
    items: q.items,
    autoRun: q.autoRun,
    stopAfter: q.stopAfter,
    closeAfter: q.closeAfter,
    runAfterTabId: q.runAfterTabId,
    firstDelaySeconds: q.firstDelaySeconds,
    postPromptEnabled: q.postPromptEnabled,
    postPromptText: q.postPromptText,
    loopPromptEnabled: q.loopPromptEnabled,
    loopPromptText: q.loopPromptText,
  };
}

// Count image placeholders in queue text. Claude TUI renders pasted images as
// "[Image #N]" tokens; Codex [imagePath: /full/path] markers are normalized to
// the same short token when entering the queue. Pasted-text-chips like
// "[Pasted text #N +M lines]" are NOT counted here — those are full-text
// expansions the editor view exposes verbatim.
const IMAGE_RE = /(?<!\\)\[Image(?:\s+#?\d+)?\]/gi;
const IMAGE_PATH_RE = /\[imagePath:\s*([^\]\r\n]+?)\s*\]/gi;
function countImages(text: string): number {
  return (text.match(IMAGE_RE) || []).length;
}

export function countPromptCharacters(text: string): number {
  return Array.from(text).length;
}

export const SHORT_GRAB_TITLE_CHARACTER_LIMIT = 25;

export function getShortGrabPromptTitle(text: string): string | null {
  const normalized = text.trim();
  if (!normalized || countPromptCharacters(normalized) >= SHORT_GRAB_TITLE_CHARACTER_LIMIT) {
    return null;
  }
  return normalized.replace(/\s+/g, ' ');
}

export function getQueuedPromptLocalCommand(
  text: string,
  imageCount = 0,
  chipCount = 0,
): string | null {
  if (!isStandaloneAgentLocalCommand({ prompt: text, imageCount, chipCount })) return null;
  return normalizeAgentLocalCommand(text)?.replace(/[ \t]+/g, ' ') || null;
}

export function makeDefaultPromptTitle(text: string, imageCount = 0, chipCount = 0): string {
  const command = getQueuedPromptLocalCommand(text, imageCount, chipCount);
  if (command) return command;
  return `[${countPromptCharacters(text)} символов]`;
}

export function isQueuedPromptEnabled(item: Pick<QueuedPrompt, 'enabled'>): boolean {
  return item.enabled !== false;
}

export function countEnabledQueuedPrompts(items: QueuedPrompt[]): number {
  return items.reduce((acc, item) => acc + (isQueuedPromptEnabled(item) ? 1 : 0), 0);
}

export function hasPendingPromptQueueContinuation(
  queue: Pick<TabQueue, 'autoRun' | 'items' | 'loopPromptEnabled' | 'loopPromptText'>,
): boolean {
  return (queue.autoRun && countEnabledQueuedPrompts(queue.items) > 0)
    || isLoopPromptActive(queue);
}

export function isLoopPromptActive(
  queue: Pick<TabQueue, 'loopPromptEnabled' | 'loopPromptText'>,
): boolean {
  return queue.loopPromptEnabled && queue.loopPromptText.trim().length > 0;
}

function wouldCreateRunAfterCycle(
  queues: Map<string, TabQueue>,
  ownerTabId: string,
  targetTabId: string,
): boolean {
  const visited = new Set<string>();
  let currentTabId: string | null = targetTabId;

  while (currentTabId) {
    if (currentTabId === ownerTabId || visited.has(currentTabId)) return true;
    visited.add(currentTabId);
    currentTabId = queues.get(currentTabId)?.runAfterTabId ?? null;
  }

  return false;
}

// Once Enter was written, the queue no longer owns this prompt. A late
// history/JSONL audit can time out after the agent has already started; keeping
// the item in that case would make a retry duplicate the submission.
export function queueSendTransferredOwnership(result: unknown): boolean {
  // A void/malformed transport return proves nothing about delivery. Treating
  // it as "transferred" would settle the row as sent with zero audit proof —
  // fail closed instead (ownership stays with the queue/composer).
  if (!result || typeof result !== 'object') return false;
  const sendResult = result as { success?: boolean; submitted?: boolean };
  return sendResult.success !== false || sendResult.submitted === true;
}

function getInitialQueuedPromptAttachmentState(
  text: string,
  imagePaths?: QueuedImageRef[],
  _imagesHint = 0,
): QueuedPromptAttachmentState {
  if (/\[imageError(?:\s*:\s*[^\]\r\n]+)?\]/i.test(text)) return 'missing';
  if (hasMalformedQueuedImageMarker(text, imagePaths)) return 'missing';
  if (/\[Image\s*\]/i.test(text)) return 'missing';
  const ids = collectClaudeImageRefIds(text);
  if (ids.size === 0) return 'ready';
  const byId = new Map((imagePaths || []).map((ref) => [Number(ref.id), ref]));
  let needsMaterialization = false;
  for (const id of ids) {
    const ref = byId.get(id);
    if (!ref?.path || ref.availability === 'missing') return 'missing';
    if (!ref.assetId || ref.availability !== 'available') needsMaterialization = true;
  }
  return needsMaterialization ? 'materializing' : 'ready';
}

function normalizeQueuedPrompt(item: QueuedPrompt): QueuedPrompt {
  const normalized = normalizeImagePathMarkersForQueue(item.text, item.imagePaths);
  const chips = normalizeComposerChips(item.chips) as QueuedComposerChip[];
  const condition = normalizeQueuedPromptContextCondition(item.condition);
  const { condition: _condition, ...itemWithoutCondition } = item;
  const next = {
    ...itemWithoutCondition,
    ...(condition ? { condition } : {}),
    enabled: item.enabled !== false,
    text: normalized.text,
    chips: chips.length > 0 ? chips : undefined,
    images: Math.max(item.images || 0, countImages(normalized.text), normalized.imagePaths?.length ?? 0),
    imagePaths: normalized.imagePaths,
  };
  return {
    ...next,
    attachmentState: getInitialQueuedPromptAttachmentState(next.text, next.imagePaths, next.images),
  };
}

function queuedPromptMatchesExpected(
  item: QueuedPrompt,
  expected?: QueuedPromptExpectedFields,
): boolean {
  if (!expected) return true;
  if (Object.prototype.hasOwnProperty.call(expected, 'text') && item.text !== expected.text) {
    return false;
  }
  if (Object.prototype.hasOwnProperty.call(expected, 'chips')) {
    if (!haveSameComposerChips(item.chips, expected.chips)) return false;
  }
  if (Object.prototype.hasOwnProperty.call(expected, 'title') && item.title !== expected.title) {
    return false;
  }
  if (
    Object.prototype.hasOwnProperty.call(expected, 'titleManual')
    && item.titleManual !== expected.titleManual
  ) {
    return false;
  }
  if (Object.prototype.hasOwnProperty.call(expected, 'enabled') && item.enabled !== expected.enabled) {
    return false;
  }
  return true;
}

function projectSystemLoopPrompt(state: PromptQueueStore, text: string) {
  if (state.sharedLoopPromptText === text) return state;
  const next = new Map(state.queues);
  const editedAt = Date.now();
  for (const [ownerTabId, queue] of next) {
    next.set(ownerTabId, { ...queue, loopPromptText: text,
      loopPromptArmedAt: queue.loopPromptEnabled ? editedAt : queue.loopPromptArmedAt });
  }
  trackPreHydrateQueueChanges(state.queues, next);
  scheduleSave(next);
  return { queues: next, sharedLoopPromptText: text };
}

export const usePromptQueueStore = create<PromptQueueStore>((set, get) => {
  // setAndPersist: write next state, then schedule a debounced disk save.
  // PreviewId-only mutations skip the save (UI-only, see scheduleSave).
  const setAndPersist = (updater: (state: PromptQueueStore) => { queues: Map<string, TabQueue> }, opts?: { skipSave?: boolean }) => {
    set((state) => {
      const next = updater(state);
      let normalizedQueues = next.queues;
      for (const [tabId, queue] of next.queues) {
        let normalized = queue;
        const before = state.queues.get(tabId);
        if (before && queue.firstDelayCountdownAt !== null
          && before.items.find(isQueuedPromptEnabled)?.id !== queue.items.find(isQueuedPromptEnabled)?.id) {
          normalized = { ...normalized, firstDelayCountdownAt: null };
        }
        if (normalized.loopPromptText !== state.sharedLoopPromptText) {
          normalized = { ...normalized, loopPromptText: state.sharedLoopPromptText };
        }
        if (normalized === queue) continue;
        if (normalizedQueues === next.queues) normalizedQueues = new Map(next.queues);
        normalizedQueues.set(tabId, normalized);
      }
      trackPreHydrateQueueChanges(state.queues, normalizedQueues);
      if (!opts?.skipSave) scheduleSave(normalizedQueues);
      return { queues: normalizedQueues };
    });
  };

  return {
    queues: new Map(),
    sharedLoopPromptText: DEFAULT_SHARED_LOOP_PROMPT,

    addPrompt: (tabId, text, images, imagePaths, title, chips) => {
      const id = nextId();
      setAndPersist((state) => {
        const next = new Map(state.queues);
        const cur = next.get(tabId) ?? EMPTY;
        const normalized = normalizeImagePathMarkersForQueue(text, imagePaths);
        const normalizedChips = normalizeComposerChips(chips) as QueuedComposerChip[];
        const serializedDraft = serializeComposerDraft({
          text: normalized.text,
          chips: normalizedChips,
        });
        const detectedImages = Math.max(
          images ?? 0,
          countImages(normalized.text),
          normalized.imagePaths?.length ?? 0,
          hasMalformedQueuedImageMarker(normalized.text, normalized.imagePaths) ? 1 : 0,
        );
        const defaultTitle = makeDefaultPromptTitle(serializedDraft, detectedImages, normalizedChips.length);
        const normalizedTitle = typeof title === 'string' ? title.trim() : '';
        const titleManual = normalizedTitle.length > 0 && normalizedTitle !== defaultTitle;
        const condition = defaultQueuedPromptContextCondition(serializedDraft);
        const items = [...cur.items, {
          id,
          enabled: true,
          ...(condition ? { condition } : {}),
          title: titleManual ? normalizedTitle : defaultTitle,
          titleManual,
          text: normalized.text,
          chips: normalizedChips.length > 0 ? normalizedChips : undefined,
          images: detectedImages,
          imagePaths: normalized.imagePaths,
          attachmentState: getInitialQueuedPromptAttachmentState(normalized.text, normalized.imagePaths, detectedImages),
          createdAt: Date.now(),
        }];
        // First-chip armed hint: only when transitioning empty → 1 AND auto-run
        // is currently OFF. Subsequent adds into a non-empty queue or adds into
        // an already-armed queue don't re-trigger the nudge.
        const wasEmpty = countEnabledQueuedPrompts(cur.items) === 0;
        const shouldArmHint = wasEmpty && !cur.autoRun;
        if (wasEmpty && cur.autoRun) markRuntimeWorkflowArm(tabId);
        next.set(tabId, {
          ...cur,
          items,
          firstChipHintActive: shouldArmHint ? true : cur.firstChipHintActive,
          workflowArmedAt: wasEmpty && cur.autoRun ? Date.now() : cur.workflowArmedAt,
        });
        return { queues: next };
      });
      const added = get().getQueue(tabId).items.find((item) => item.id === id);
      if (added?.attachmentState === 'materializing') {
        void ensureQueuedPromptImagesReady(tabId, id);
      }
      return id;
    },

    addMetaAction: (tabId, action, title) => {
      const item = makeQueuedMetaActionItem(action, title);
      const id = item.id;
      setAndPersist((state) => {
        const next = new Map(state.queues);
        const cur = next.get(tabId) ?? EMPTY;
        const wasEmpty = countEnabledQueuedPrompts(cur.items) === 0;
        const shouldArmHint = wasEmpty && !cur.autoRun;
        if (wasEmpty && cur.autoRun) markRuntimeWorkflowArm(tabId);
        const items = [...cur.items, item];
        next.set(tabId, {
          ...cur,
          items,
          firstChipHintActive: shouldArmHint ? true : cur.firstChipHintActive,
          workflowArmedAt: wasEmpty && cur.autoRun ? Date.now() : cur.workflowArmedAt,
        });
        return { queues: next };
      });
      return id;
    },

    removePrompt: (tabId, id, options) => {
      let removed = false;
      setAndPersist((state) => {
        const cur = state.queues.get(tabId);
        if (!cur) return state;
        const currentItem = cur.items.find((item) => item.id === id);
        if (!currentItem || !queuedPromptMatchesExpected(currentItem, options?.expected)) {
          return state;
        }
        removed = true;
        const activeBefore = countEnabledQueuedPrompts(cur.items);
        const items = cur.items.filter((p) => p.id !== id);
        const next = new Map(state.queues);
        // Manual drain (×-remove OR Replay ▶) emptied the queue. Run after /
        // Stop after / Close after were waiting on this queue to finish — now
        // that there's nothing left to wait for, they MUST disarm. Otherwise
        // the user sees an active "Run after" or "Stop after" pill with zero
        // context — and on the next turn-end the runner would either send a
        // future prompt unexpectedly or SIGTERM the agent unexpectedly.
        //
        // Carefully NOT applied in popNext: there the LAST chip just left the
        // queue to be SENT to the agent — stopAfter SHOULD still be armed so the
        // runner stops the agent after that prompt's turn finishes. popNext is
        // the autoRun-drain path; this hook only covers manual user removals.
        const queueEmptied = activeBefore > 0 && countEnabledQueuedPrompts(items) === 0;
        if (queueEmptied) runtimeWorkflowArmTabs.delete(tabId);
        const autoRun = queueEmptied ? false : cur.autoRun;
        const stopAfter = queueEmptied ? false : cur.stopAfter;
        const closeAfter = queueEmptied ? false : cur.closeAfter;
        const stopBeforeCloseArm = queueEmptied ? false : cur.stopBeforeCloseArm;
        const firstDelayCountdownAt = queueEmptied ? null : cur.firstDelayCountdownAt;
        next.set(tabId, {
          ...cur,
          items,
          autoRun,
          stopAfter,
          closeAfter,
          stopBeforeCloseArm,
          firstDelayCountdownAt,
          firstChipHintActive: queueEmptied ? false : cur.firstChipHintActive,
          workflowArmedAt: queueEmptied ? null : cur.workflowArmedAt,
          previewId: cur.previewId === id ? null : cur.previewId,
        });
        return { queues: next };
      });
      return removed;
    },

    updatePrompt: (tabId, id, patch, options) => {
      let updated = false;
      setAndPersist((state) => {
        const cur = state.queues.get(tabId);
        if (!cur) return state;
        const currentItem = cur.items.find((item) => item.id === id);
        if (!currentItem || !queuedPromptMatchesExpected(currentItem, options?.expected)) {
          return state;
        }
        updated = true;
        const activeBefore = countEnabledQueuedPrompts(cur.items);
        const items = cur.items.map((p) => {
          if (p.id !== id) return p;
          const suppliedImagePaths = Array.isArray(patch.imagePaths)
            ? patch.imagePaths
            : p.imagePaths;
          const normalized = typeof patch.text === 'string'
            ? normalizeImagePathMarkersForQueue(patch.text, suppliedImagePaths)
            : {
                text: p.text,
                imagePaths: Array.isArray(patch.imagePaths)
                  ? retainImagePathsForText(p.text, patch.imagePaths)
                  : p.imagePaths,
              };
          const text = normalized.text;
          const images = typeof patch.text === 'string' || Array.isArray(patch.imagePaths)
            ? Math.max(
                countImages(text),
                normalized.imagePaths?.length ?? 0,
                hasMalformedQueuedImageMarker(text, normalized.imagePaths) ? p.images : 0,
                p.attachmentState === 'missing' && /\[imageError(?:\s*:\s*[^\]\r\n]+)?\]/i.test(text) ? p.images : 0,
              )
            : p.images;
          const imagePaths = normalized.imagePaths;
          const chips = Array.isArray(patch.chips)
            ? normalizeComposerChips(patch.chips) as QueuedComposerChip[]
            : (p.chips || []);
          const defaultTitle = makeDefaultPromptTitle(serializeComposerDraft({
            text,
            chips,
          }), images, chips.length);
          let titleManual = !!p.titleManual;
          let title = p.title || defaultTitle;
          if (typeof patch.title === 'string') {
            const normalized = patch.title.trim();
            title = normalized || defaultTitle;
            titleManual = normalized.length > 0 && normalized !== defaultTitle;
          } else if (
            (typeof patch.text === 'string' || Array.isArray(patch.chips))
            && !titleManual
          ) {
            title = defaultTitle;
          }
          if (typeof patch.titleManual === 'boolean') {
            titleManual = patch.titleManual;
            if (!titleManual) title = defaultTitle;
          }
          const enabled = typeof patch.enabled === 'boolean' ? patch.enabled : p.enabled;
          return {
            ...p,
            enabled,
            text,
            chips,
            images,
            imagePaths,
            attachmentState: typeof patch.text === 'string' || Array.isArray(patch.imagePaths)
              ? getInitialQueuedPromptAttachmentState(text, imagePaths, images)
              : p.attachmentState,
            title,
            titleManual,
          };
        });
        const next = new Map(state.queues);
        const activeAfter = countEnabledQueuedPrompts(items);
        const queueEmptied = activeBefore > 0 && activeAfter === 0;
        const queueBecameRunnable = activeBefore === 0 && activeAfter > 0 && cur.autoRun;
        if (queueEmptied) runtimeWorkflowArmTabs.delete(tabId);
        else if (queueBecameRunnable) markRuntimeWorkflowArm(tabId);
        next.set(tabId, {
          ...cur,
          items,
          autoRun: queueEmptied ? false : cur.autoRun,
          stopAfter: queueEmptied ? false : cur.stopAfter,
          closeAfter: queueEmptied ? false : cur.closeAfter,
          stopBeforeCloseArm: queueEmptied ? false : cur.stopBeforeCloseArm,
          firstDelayCountdownAt: queueEmptied ? null : cur.firstDelayCountdownAt,
          firstChipHintActive: queueEmptied ? false : cur.firstChipHintActive,
          workflowArmedAt: queueEmptied
            ? null
            : (queueBecameRunnable ? Date.now() : cur.workflowArmedAt),
        });
        return { queues: next };
      });
      if (typeof patch.text === 'string' || Array.isArray(patch.imagePaths)) {
        const updated = get().getQueue(tabId).items.find((item) => item.id === id);
        if (updated?.attachmentState === 'materializing') {
          void ensureQueuedPromptImagesReady(tabId, id);
        }
      }
      return updated;
    },

    updatePromptText: (tabId, id, text) => {
      setAndPersist((state) => {
        const cur = state.queues.get(tabId);
        if (!cur) return state;
        const items = cur.items.map((p) => {
          if (p.id !== id) return p;
          const normalized = normalizeImagePathMarkersForQueue(text, p.imagePaths);
          const images = Math.max(
            countImages(normalized.text),
            normalized.imagePaths?.length ?? 0,
            hasMalformedQueuedImageMarker(normalized.text, normalized.imagePaths) ? p.images : 0,
            p.attachmentState === 'missing' && /\[imageError(?:\s*:\s*[^\]\r\n]+)?\]/i.test(normalized.text) ? p.images : 0,
          );
          return {
            ...p,
            text: normalized.text,
            images,
            imagePaths: normalized.imagePaths,
            attachmentState: getInitialQueuedPromptAttachmentState(normalized.text, normalized.imagePaths, images),
            title: p.titleManual
              ? p.title
              : makeDefaultPromptTitle(serializeComposerDraft({
                  text: normalized.text,
                  chips: p.chips || [],
                }), images, p.chips?.length || 0),
          };
        });
        const next = new Map(state.queues);
        next.set(tabId, { ...cur, items });
        return { queues: next };
      });
      const updated = get().getQueue(tabId).items.find((item) => item.id === id);
      if (updated?.attachmentState === 'materializing') {
        void ensureQueuedPromptImagesReady(tabId, id);
      }
    },

    setPromptImageRefs: (tabId, id, imagePaths, attachmentState, expectedText) => {
      setAndPersist((state) => {
        const cur = state.queues.get(tabId);
        if (!cur) return state;
        let changed = false;
        const headId = cur.items.find(isQueuedPromptEnabled)?.id ?? null;
        const items = cur.items.map((item) => {
          if (item.id !== id || (expectedText !== undefined && item.text !== expectedText)) return item;
          changed = true;
          return {
            ...item,
            imagePaths: retainImagePathsForText(item.text, imagePaths),
            images: Math.max(
              countImages(item.text),
              imagePaths?.length ?? 0,
              attachmentState === 'missing' && /\[imageError(?:\s*:\s*[^\]\r\n]+)?\]/i.test(item.text) ? item.images : 0,
            ),
            attachmentState,
          };
        });
        if (!changed) return state;
        const next = new Map(state.queues);
        next.set(tabId, { ...cur, items });
        return { queues: next };
      });
    },

    reorderPrompt: (tabId, fromIndex, toIndex) => {
      setAndPersist((state) => {
        const cur = state.queues.get(tabId);
        if (!cur) return state;
        if (fromIndex === toIndex) return state;
        const items = [...cur.items];
        const [removed] = items.splice(fromIndex, 1);
        if (!removed) return state;
        items.splice(toIndex, 0, removed);
        const next = new Map(state.queues);
        next.set(tabId, { ...cur, items });
        return { queues: next };
      });
    },

    setPromptTrigger: (tabId, promptId, trigger) => {
      setAndPersist((state) => {
        const cur = state.queues.get(tabId);
        if (!cur) return state;
        let changed = false;
        // Head = the element that would fire next. Changing ITS trigger resets
        // the pending countdown; changing a later element must not touch the
        // head's timer.
        const headId = cur.items.find(isQueuedPromptEnabled)?.id ?? null;
        const normalized = trigger?.kind === 'timer'
          ? { kind: 'timer' as const, seconds: normalizeFirstDelaySeconds(trigger.seconds) }
          : trigger?.kind === 'onTab' && trigger.tabId
            ? { kind: 'onTab' as const, tabId: trigger.tabId }
            : normalizeAppRestartTrigger(trigger) || undefined;
        const items = cur.items.map((item) => {
          if (item.id !== promptId) return item;
          if (JSON.stringify(item.trigger) === JSON.stringify(normalized)) return item;
          changed = true;
          return normalized ? { ...item, trigger: normalized } : (() => {
            const { trigger: _trigger, ...rest } = item;
            return rest;
          })();
        });
        if (!changed) return state;
        const changedHead = headId === promptId;
        const next = new Map(state.queues);
        next.set(tabId, {
          ...cur,
          items,
          firstDelayCountdownAt: changedHead ? null : cur.firstDelayCountdownAt,
        });
        return { queues: next };
      });
    },

    setPromptCondition: (tabId, promptId, condition) => {
      const normalized = normalizeQueuedPromptContextCondition(condition);
      setAndPersist((state) => {
        const cur = state.queues.get(tabId);
        if (!cur) return state;
        let changed = false;
        const items = cur.items.map((item) => {
          if (item.id !== promptId) return item;
          if (queuedPromptContextConditionKey(item.condition)
            === queuedPromptContextConditionKey(normalized)) return item;
          changed = true;
          if (normalized) return { ...item, condition: normalized };
          const { condition: _condition, ...rest } = item;
          return rest;
        });
        if (!changed) return state;
        const next = new Map(state.queues);
        next.set(tabId, { ...cur, items });
        return { queues: next };
      });
    },

    deferPromptToEnd: (tabId, promptId) => {
      let moved = false;
      setAndPersist((state) => {
        const cur = state.queues.get(tabId);
        if (!cur) return state;
        const index = cur.items.findIndex((item) => item.id === promptId);
        if (index < 0 || index === cur.items.length - 1) return state;
        const items = cur.items.slice();
        const [item] = items.splice(index, 1);
        if (!item) return state;
        items.push(item);
        moved = true;
        const next = new Map(state.queues);
        next.set(tabId, {
          ...cur,
          items,
          // A countdown belongs to the old head. It cannot follow that card
          // through an automatic rotation and accidentally delay the new head.
          firstDelayCountdownAt: null,
        });
        return { queues: next };
      });
      return moved;
    },

    clearQueue: (tabId) => {
      runtimeWorkflowArmTabs.delete(tabId);
      automaticRunAfterTargetClearTabs.delete(tabId);
      setAndPersist((state) => {
        const next = new Map(state.queues);
        next.delete(tabId);
        return { queues: next };
      });
    },

    setAutoRun: (tabId, value) => {
      setAndPersist((state) => {
        const next = new Map(state.queues);
        const cur = next.get(tabId) ?? EMPTY;
        // Any user interaction with Run after acknowledges the hint — clear it
        // unconditionally. Re-arming only happens on the next 0→1 chip edge.
        const updated = {
          ...cur,
          autoRun: value,
          workflowRestartPending: value === cur.autoRun ? cur.workflowRestartPending : false,
          firstChipHintActive: false,
          firstDelayCountdownAt: value ? cur.firstDelayCountdownAt : null,
        };
        const explicitArm = value && !cur.autoRun;
        if (explicitArm) markRuntimeWorkflowArm(tabId);
        next.set(tabId, {
          ...updated,
          workflowArmedAt: retainedWorkflowArmedAt(cur, updated, explicitArm),
        });
        if (!hasActiveQueueWorkflow(updated)) runtimeWorkflowArmTabs.delete(tabId);
        return { queues: next };
      });
    },

    setStopAfter: (tabId, value) => {
      setAndPersist((state) => {
        const next = new Map(state.queues);
        const cur = next.get(tabId) ?? EMPTY;
        // Backward-compatible remote mutation. Stop/Close are no longer hidden
        // tab flags: old clients now create/remove the same visible lifecycle
        // cards as the desktop Run After menu. Turning Stop off also removes
        // Close, matching the old implication close ⇒ stop.
        const existingClose = cur.items.find((item) => item.metaAction?.kind === 'close-tab');
        const itemsWithoutLifecycle = cur.items.filter((item) => (
          item.metaAction?.kind !== 'stop' && item.metaAction?.kind !== 'close-tab'
        ));
        const items = value
          ? [...itemsWithoutLifecycle, existingClose || makeQueuedMetaActionItem({ kind: 'stop' })]
          : itemsWithoutLifecycle;
        const hasItems = countEnabledQueuedPrompts(items) > 0;
        const explicitArm = value && !cur.autoRun;
        const updated = {
          ...cur,
          items,
          autoRun: value ? true : (hasItems ? cur.autoRun : false),
          stopAfter: false,
          closeAfter: false,
          stopBeforeCloseArm: false,
          firstChipHintActive: false,
          firstDelayCountdownAt: value ? cur.firstDelayCountdownAt : (hasItems ? cur.firstDelayCountdownAt : null),
        };
        if (explicitArm) markRuntimeWorkflowArm(tabId);
        next.set(tabId, {
          ...updated,
          workflowArmedAt: retainedWorkflowArmedAt(cur, updated, explicitArm),
        });
        if (!hasActiveQueueWorkflow(updated)) runtimeWorkflowArmTabs.delete(tabId);
        return { queues: next };
      });
    },

    setCloseAfter: (tabId, value) => {
      setAndPersist((state) => {
        const next = new Map(state.queues);
        const cur = next.get(tabId) ?? EMPTY;
        const existingClose = cur.items.find((item) => item.metaAction?.kind === 'close-tab');
        const itemsWithoutClose = cur.items.filter((item) => item.metaAction?.kind !== 'close-tab');
        const itemsWithoutLifecycle = itemsWithoutClose.filter((item) => item.metaAction?.kind !== 'stop');
        const items = value
          ? [...itemsWithoutLifecycle, existingClose || makeQueuedMetaActionItem({ kind: 'close-tab' })]
          : itemsWithoutClose;
        const hasItems = countEnabledQueuedPrompts(items) > 0;
        const explicitArm = value && !cur.autoRun;
        const updated = {
          ...cur,
          items,
          autoRun: value ? true : (hasItems ? cur.autoRun : false),
          stopAfter: false,
          closeAfter: false,
          stopBeforeCloseArm: false,
          firstChipHintActive: false,
          firstDelayCountdownAt: value ? cur.firstDelayCountdownAt : (hasItems ? cur.firstDelayCountdownAt : null),
        };
        if (explicitArm) markRuntimeWorkflowArm(tabId);
        next.set(tabId, {
          ...updated,
          workflowArmedAt: retainedWorkflowArmedAt(cur, updated, explicitArm),
        });
        if (!hasActiveQueueWorkflow(updated)) runtimeWorkflowArmTabs.delete(tabId);
        return { queues: next };
      });
    },

    setRunAfterTab: (tabId, targetTabId) => {
      automaticRunAfterTargetClearTabs.delete(tabId);
      let accepted = true;
      setAndPersist((state) => {
        const next = new Map(state.queues);
        const cur = next.get(tabId) ?? EMPTY;
        // Self-target makes no semantic sense (waiting on yourself = waiting
        // forever, since the same Stop hook would fire). Coerce to null.
        const value = targetTabId === tabId ? null : targetTabId;
        if (value && wouldCreateRunAfterCycle(next, tabId, value)) {
          accepted = false;
          console.warn('[PromptQueue] refused cyclic Run after dependency owner=' + tabId.slice(-8)
            + ' target=' + value.slice(-8));
          return state;
        }
        // Picking a target tab is an explicit Run-after intent. Auto-arm on
        // non-null selection so "on tab" cannot sit as a passive label while
        // the queue is actually off.
        const updated = {
          ...cur,
          runAfterTabId: value,
          workflowRestartPending: value === cur.runAfterTabId ? cur.workflowRestartPending : false,
          autoRun: value ? true : cur.autoRun,
          firstChipHintActive: value ? false : cur.firstChipHintActive,
        };
        const targetChanged = value !== cur.runAfterTabId;
        const explicitArm = targetChanged && (value !== null || hasActiveQueueWorkflow(updated));
        if (explicitArm) markRuntimeWorkflowArm(tabId);
        next.set(tabId, {
          ...updated,
          workflowArmedAt: retainedWorkflowArmedAt(cur, updated, explicitArm),
        });
        return { queues: next };
      });
      return accepted;
    },

    clearStaleRunAfterTab: (tabId, expectedTargetTabId) => {
      setAndPersist((state) => {
        const cur = state.queues.get(tabId);
        if (!cur || cur.runAfterTabId !== expectedTargetTabId) return state;
        automaticRunAfterTargetClearTabs.add(tabId);
        const next = new Map(state.queues);
        next.set(tabId, { ...cur, runAfterTabId: null });
        return { queues: next };
      });
    },

    setFirstDelaySeconds: (tabId, value) => {
      const normalized = normalizeFirstDelaySeconds(value);
      setAndPersist((state) => {
        const next = new Map(state.queues);
        const cur = next.get(tabId) ?? EMPTY;
        // Editing the input while a countdown is running is treated as cancel-edit-restart:
        // we drop the active countdown slot, the new value becomes the value the input shows.
        next.set(tabId, { ...cur, firstDelaySeconds: normalized, firstDelayCountdownAt: null });
        return { queues: next };
      });
    },

    startFirstDelayCountdown: (tabId) => {
      setAndPersist((state) => {
        const next = new Map(state.queues);
        const cur = next.get(tabId) ?? EMPTY;
        if (cur.firstDelayCountdownAt !== null) return state; // already running
        next.set(tabId, { ...cur, firstDelayCountdownAt: Date.now() });
        return { queues: next };
      });
    },

    cancelFirstDelayCountdown: (tabId) => {
      setAndPersist((state) => {
        const cur = state.queues.get(tabId);
        if (!cur || cur.firstDelayCountdownAt === null) return state;
        const remaining = getFirstDelayRemainingSeconds(
          cur.firstDelaySeconds,
          cur.firstDelayCountdownAt,
        );
        const next = new Map(state.queues);
        next.set(tabId, { ...cur, firstDelaySeconds: remaining, firstDelayCountdownAt: null });
        return { queues: next };
      });
    },

    clearFirstDelayCountdown: (tabId) => {
      setAndPersist((state) => {
        const cur = state.queues.get(tabId);
        if (!cur || cur.firstDelayCountdownAt === null) return state;
        const next = new Map(state.queues);
        next.set(tabId, { ...cur, firstDelayCountdownAt: null });
        return { queues: next };
      });
    },

    consumeFirstDelayCountdown: (tabId) => {
      setAndPersist((state) => {
        const cur = state.queues.get(tabId);
        if (!cur || (cur.firstDelaySeconds === 0 && cur.firstDelayCountdownAt === null)) return state;
        const next = new Map(state.queues);
        next.set(tabId, { ...cur, firstDelaySeconds: 0, firstDelayCountdownAt: null });
        return { queues: next };
      });
    },

    setPreviewId: (tabId, id) => {
      setAndPersist((state) => {
        const next = new Map(state.queues);
        const cur = next.get(tabId) ?? EMPTY;
        next.set(tabId, { ...cur, previewId: id });
        return { queues: next };
      });
    },

    setPostPromptEnabled: (tabId, value) => {
      setAndPersist((state) => {
        const next = new Map(state.queues);
        const cur = next.get(tabId) ?? EMPTY;
        next.set(tabId, { ...cur, postPromptEnabled: value });
        return { queues: next };
      });
    },

    setPostPromptText: (tabId, text) => {
      setAndPersist((state) => {
        const next = new Map(state.queues);
        const cur = next.get(tabId) ?? EMPTY;
        next.set(tabId, { ...cur, postPromptText: text });
        return { queues: next };
      });
    },

    setLoopPromptEnabled: (tabId, value) => {
      setAndPersist((state) => {
        const next = new Map(state.queues);
        const cur = next.get(tabId) ?? EMPTY;
        if (cur.loopPromptEnabled === value) return state;
        next.set(tabId, {
          ...cur,
          loopPromptText: state.sharedLoopPromptText,
          loopPromptEnabled: value,
          loopRestartPending: false,
          loopPromptArmedAt: value ? Date.now() : null,
        });
        return { queues: next };
      });
    },

    setLoopPromptText: (tabId, text) => {
      if (!hasHydratedPromptQueueStore) preHydrateSharedLoopPromptChanged = true;
      set((state) => {
        if (state.sharedLoopPromptText === text) return state;
        scheduleSharedLoopPromptSave(text);
        return projectSystemLoopPrompt(state, text);
      });
    },

    setPanelCollapsed: (tabId, value) => {
      setAndPersist((state) => {
        const next = new Map(state.queues);
        const cur = next.get(tabId) ?? EMPTY;
        next.set(tabId, { ...cur, panelCollapsed: value });
        return { queues: next };
      });
    },

    consumeFirstChipHint: (tabId) => {
      // UI-only state — skip disk save.
      setAndPersist((state) => {
        const cur = state.queues.get(tabId);
        if (!cur || !cur.firstChipHintActive) return state;
        const next = new Map(state.queues);
        next.set(tabId, { ...cur, firstChipHintActive: false });
        return { queues: next };
      }, { skipSave: true });
    },

    popNext: (tabId) => {
      const cur = get().queues.get(tabId);
      if (!cur || cur.items.length === 0) return null;
      const headIndex = cur.items.findIndex(isQueuedPromptEnabled);
      if (headIndex < 0) return null;
      const head = cur.items[headIndex];
      if (!head) return null;
      const rest = cur.items.filter((_, index) => index !== headIndex);
      setAndPersist((state) => {
        const next = new Map(state.queues);
        next.set(tabId, { ...cur, items: rest, previewId: cur.previewId === head.id ? null : cur.previewId });
        return { queues: next };
      });
      return head;
    },

    commitSentHead: (tabId, id, triggerTabId) => {
      let removed = false;
      let beforeCount = 0;
      let targetCleared = false;
      setAndPersist((state) => {
        const cur = state.queues.get(tabId);
        if (!cur) return state;
        const consumesCurrentTarget = tabId !== triggerTabId && cur.runAfterTabId === triggerTabId;
        beforeCount = countEnabledQueuedPrompts(cur.items);
        const index = cur.items.findIndex((item) => item.id === id);
        if (index < 0) {
          if (!consumesCurrentTarget) return state;
          automaticRunAfterTargetClearTabs.add(tabId);
          const next = new Map(state.queues);
          next.set(tabId, { ...cur, runAfterTabId: null });
          targetCleared = true;
          return { queues: next };
        }
        const items = cur.items.filter((_, itemIndex) => itemIndex !== index);
        targetCleared = consumesCurrentTarget;
        if (targetCleared) automaticRunAfterTargetClearTabs.add(tabId);
        const next = new Map(state.queues);
        const updated = {
          ...cur,
          items,
          autoRun: beforeCount === 1 ? false : cur.autoRun,
          runAfterTabId: targetCleared ? null : cur.runAfterTabId,
          previewId: cur.previewId === id ? null : cur.previewId,
        };
        next.set(tabId, {
          ...updated,
          workflowArmedAt: retainedWorkflowArmedAt(cur, updated),
        });
        if (!hasActiveQueueWorkflow(updated)) runtimeWorkflowArmTabs.delete(tabId);
        removed = true;
        return { queues: next };
      });
      return { removed, beforeCount, targetCleared };
    },

    suspendWorkflowsForRestart: () => {
      setAndPersist((state) => {
        const next = new Map(state.queues);
        for (const [tabId, cur] of state.queues) {
          if (cur.autoRun || cur.loopPromptEnabled) next.set(tabId, {
            ...cur, workflowRestartPending: cur.autoRun, loopRestartPending: cur.loopPromptEnabled,
          });
        }
        return { queues: next };
      });
    },

    resumeWorkflowsForTrigger: (triggerTabId, rendererStartedAt) => {
      if (!Number.isFinite(rendererStartedAt)) return;
      setAndPersist((state) => {
        const next = new Map(state.queues);
        let changed = false;
        for (const [ownerTabId, cur] of state.queues) {
          const head = cur.items.find(isQueuedPromptEnabled);
          const trigger = head?.trigger?.kind === 'onTab'
            ? head.trigger.tabId : (cur.runAfterTabId || ownerTabId);
          const workflow = cur.workflowRestartPending && trigger === triggerTabId;
          const loop = cur.loopRestartPending && ownerTabId === triggerTabId;
          if (!workflow && !loop) continue;
          next.set(ownerTabId, { ...cur,
            ...(workflow ? { workflowRestartPending: false,
              workflowArmedAt: Math.max(cur.workflowArmedAt || 0, rendererStartedAt) } : {}),
            ...(loop ? { loopRestartPending: false,
              loopPromptArmedAt: Math.max(cur.loopPromptArmedAt || 0, rendererStartedAt) } : {}),
          });
          changed = true;
        }
        return changed ? { queues: next } : state;
      });
    },

    disarmQueuesForTrigger: (triggerTabId, outcomeTs = null, options = {}) => {
      const disarmed: string[] = [];
      const classifiedOutcomeTs = Number.isFinite(outcomeTs) ? Number(outcomeTs) : null;
      setAndPersist((state) => {
        let changed = false;
        const next = new Map(state.queues);
        for (const [ownerTabId, cur] of state.queues) {
          const ownsTrigger = ownerTabId === triggerTabId;
          const head = cur.items.find(isQueuedPromptEnabled);
          const appRestartSatisfied = head?.trigger?.kind === 'app-restart'
            && appRestartTriggerIsSatisfied(head.trigger, options.runtimeInstanceId);
          const outcomeAfterCurrentAppStart = classifiedOutcomeTs !== null
            && Number.isFinite(options.runtimeStartedAt)
            && classifiedOutcomeTs >= Number(options.runtimeStartedAt);
          // A restart-triggered item belongs to the next main-process lifetime.
          // Outcomes from its arming process and restored pre-boot evidence must
          // not cancel it. Once the new process itself produces a later failure,
          // the ordinary disarm contract resumes.
          const restartTriggerBlocksOutcome = head?.trigger?.kind === 'app-restart'
            && (!appRestartSatisfied || !outcomeAfterCurrentAppStart);
          const waitsOnTrigger = head?.trigger?.kind === 'onTab'
            ? head.trigger.tabId === triggerTabId
            : cur.runAfterTabId === triggerTabId;
          const hasQueuePromise = cur.autoRun || cur.stopAfter || cur.closeAfter || cur.firstDelayCountdownAt !== null;
          const queueMatches = hasQueuePromise
            && (!cur.workflowRestartPending || options.explicitStop === true)
            && !restartTriggerBlocksOutcome
            && (ownsTrigger || (waitsOnTrigger && options.preservePivoted !== true));
          const loopMatches = ownsTrigger
            && (!cur.loopRestartPending || options.explicitStop === true)
            && cur.loopPromptEnabled
            && options.preserveLoop !== true;
          if (!queueMatches && !loopMatches) continue;
          // A user can deliberately re-arm after an old failure while restore is
          // still hydrating. Never let that stale outcome cancel the newer arm;
          // legacy queues without a timestamp remain fail-closed.
          const disarmQueue = queueMatches && (
            cur.workflowArmedAt === null
            || (classifiedOutcomeTs !== null && cur.workflowArmedAt <= classifiedOutcomeTs)
          );
          const disarmLoop = loopMatches && (
            cur.loopPromptArmedAt === null
            || (classifiedOutcomeTs !== null && cur.loopPromptArmedAt <= classifiedOutcomeTs)
          );
          if (!disarmQueue && !disarmLoop) continue;
          next.set(ownerTabId, {
            ...cur,
            ...(disarmQueue ? {
              autoRun: false,
              workflowRestartPending: false,
              stopAfter: false,
              closeAfter: false,
              stopBeforeCloseArm: false,
              firstDelayCountdownAt: null,
              runAfterTabId: null,
              workflowArmedAt: null,
            } : {}),
            ...(disarmLoop ? {
              loopPromptEnabled: false,
              loopRestartPending: false,
              loopPromptArmedAt: null,
            } : {}),
          });
          disarmed.push(ownerTabId);
          if (disarmQueue) {
            runtimeWorkflowArmTabs.delete(ownerTabId);
            automaticRunAfterTargetClearTabs.delete(ownerTabId);
          }
          changed = true;
        }
        return changed ? { queues: next } : state;
      });
      return disarmed;
    },

    cleanupClosedTab: (closedTabId) => {
      runtimeWorkflowArmTabs.delete(closedTabId);
      automaticRunAfterTargetClearTabs.delete(closedTabId);
      if (promptQueueEditorLocks.delete(closedTabId)) {
        for (const listener of promptQueueEditorLockListeners) {
          listener(closedTabId, null, { wakeAutoRun: false });
        }
      }
      setAndPersist((state) => {
        let changed = false;
        const next = new Map(state.queues);

        if (next.delete(closedTabId)) changed = true;

        for (const [ownerTabId, queue] of next) {
          const hasGlobalTarget = queue.runAfterTabId === closedTabId;
          const hasItemTarget = queue.items.some((item) => (
            item.trigger?.kind === 'onTab' && item.trigger.tabId === closedTabId
          ));
          if (!hasGlobalTarget && !hasItemTarget) continue;
          if (hasGlobalTarget) automaticRunAfterTargetClearTabs.add(ownerTabId);
          next.set(ownerTabId, {
            ...queue,
            runAfterTabId: hasGlobalTarget ? null : queue.runAfterTabId,
            items: hasItemTarget
              ? queue.items.map((item) => {
                  if (item.trigger?.kind !== 'onTab' || item.trigger.tabId !== closedTabId) return item;
                  const { trigger: _trigger, ...rest } = item;
                  return rest;
                })
              : queue.items,
          });
          changed = true;
        }

        if (!changed) return state;
        return { queues: next };
      });
    },

    getQueue: (tabId) => {
      const state = get();
      const queue = state.queues.get(tabId) ?? EMPTY;
      return queue.loopPromptText === state.sharedLoopPromptText
        ? queue
        : { ...queue, loopPromptText: state.sharedLoopPromptText };
    },
  };
});

// Settings and the Loop pencil share one system-prompt record; queues contain
// its runtime projection, never a second independently persisted text setting.
usePromptsStore.subscribe((state, previous) => {
  const content = state.prompts.find((prompt) => prompt.id === RUN_AFTER_LOOP_PROMPT_ID)?.content;
  const previousContent = previous.prompts.find((prompt) => prompt.id === RUN_AFTER_LOOP_PROMPT_ID)?.content;
  if (content === undefined || content === previousContent) return;
  if (!hasHydratedPromptQueueStore) {
    if (preHydrateSharedLoopPromptChanged && !previous.isLoaded && state.isLoaded) return;
    if (previous.isLoaded || !state.isLoaded) preHydrateSharedLoopPromptChanged = true;
  }
  // A confirmed Settings edit supersedes a not-yet-written pencil draft.
  // Otherwise its old debounce would overwrite the newer canonical body.
  if (sharedLoopPromptSaveTimer && content !== usePromptQueueStore.getState().sharedLoopPromptText) {
    clearTimeout(sharedLoopPromptSaveTimer);
    sharedLoopPromptSaveTimer = null;
  }
  usePromptQueueStore.setState((queueState) => projectSystemLoopPrompt(queueState, content));
});

const promptImageMaterializationInflight = new Map<string, Promise<{
  ready: boolean;
  state: QueuedPromptAttachmentState;
  item: QueuedPrompt | null;
  degraded?: boolean;
}>>();

async function materializeQueuedPromptRecord(item: QueuedPrompt): Promise<QueuedPrompt> {
  const normalized = normalizeQueuedPrompt(item);
  if (getQueuedPromptAttachmentState(normalized) === 'missing'
    && normalized.images > 0
    && /\[imageError(?:\s*:\s*[^\]\r\n]+)?\]/i.test(normalized.text)
    && collectClaudeImageRefIds(normalized.text).size === 0) {
    return { ...normalized, attachmentState: 'missing' };
  }
  const ids = collectClaudeImageRefIds(normalized.text);
  if (ids.size === 0) return { ...normalized, attachmentState: 'ready' };
  if (!normalized.imagePaths || normalized.imagePaths.length === 0) {
    return { ...normalized, attachmentState: 'missing' };
  }

  try {
    const result = await ipcRenderer.invoke('prompt-queue:materialize-image-refs', {
      refs: normalized.imagePaths,
    });
    const returnedRefs = Array.isArray(result?.refs)
      ? result.refs as QueuedImageRef[]
      : [];
    const returnedById = new Map(returnedRefs.map((ref) => [Number(ref.id), ref]));
    const responseIsComplete = Array.from(ids).every((id) => returnedById.has(id));
    const refs = responseIsComplete ? returnedRefs : normalized.imagePaths;
    const byId = new Map(refs.map((ref) => [Number(ref.id), ref]));
    const ready = responseIsComplete && Array.from(ids).every((id) => {
      const ref = byId.get(id);
      return !!(ref?.path && ref.assetId && ref.availability === 'available');
    });
    return {
      ...normalized,
      imagePaths: retainImagePathsForText(normalized.text, refs),
      attachmentState: ready ? 'ready' : 'missing',
    };
  } catch (error) {
    console.warn('[PromptQueueAssets] renderer materialize failed item=' + item.id + ':', error);
    return {
      ...normalized,
      imagePaths: normalized.imagePaths.map((ref) => ({ ...ref, availability: 'missing', error: 'materialize_ipc_failed' })),
      attachmentState: 'missing',
    };
  }
}

export function ensureQueuedPromptImagesReady(
  tabId: string,
  itemId: string,
): Promise<{
  ready: boolean;
  state: QueuedPromptAttachmentState;
  item: QueuedPrompt | null;
  degraded?: boolean;
}> {
  const key = tabId + ':' + itemId;
  const existing = promptImageMaterializationInflight.get(key);
  if (existing) return existing;

  const work = (async () => {
    const before = usePromptQueueStore.getState().getQueue(tabId).items.find((item) => item.id === itemId) || null;
    if (!before) return { ready: false, state: 'missing' as const, item: null };
    const beforeInspection = inspectPromptImageAttachments(before.text, before.imagePaths || []);
    if (beforeInspection.blocking) {
      return { ready: false, state: 'missing' as const, item: before };
    }
    if (collectClaudeImageRefIds(before.text).size === 0) {
      return {
        ready: true,
        state: beforeInspection.unavailable ? 'missing' as const : 'ready' as const,
        item: before,
        degraded: beforeInspection.unavailable,
      };
    }
    const immediateState = getQueuedPromptAttachmentState(before);
    if (immediateState === 'ready' && before.imagePaths?.every((ref) => ref.assetId && ref.availability === 'available')) {
      // Still revalidate managed paths before every transfer. materializeRef is
      // idempotent and resolves assetId inside the current userData directory.
    } else if (immediateState === 'missing' && (!before.imagePaths || before.imagePaths.length === 0)) {
      return { ready: false, state: 'missing' as const, item: before };
    }

    usePromptQueueStore.getState().setPromptImageRefs(
      tabId,
      itemId,
      before.imagePaths,
      'materializing',
      before.text,
    );
    const materialized = await materializeQueuedPromptRecord(before);
    usePromptQueueStore.getState().setPromptImageRefs(
      tabId,
      itemId,
      materialized.imagePaths,
      materialized.attachmentState || 'missing',
      before.text,
    );
    const current = usePromptQueueStore.getState().getQueue(tabId).items.find((item) => item.id === itemId) || null;
    if (current && current.text !== before.text) {
      promptImageMaterializationInflight.delete(key);
      return ensureQueuedPromptImagesReady(tabId, itemId);
    }
    const state = current ? getQueuedPromptAttachmentState(current) : 'missing';
    const currentInspection = current
      ? inspectPromptImageAttachments(current.text, current.imagePaths || [])
      : null;
    return {
      ready: !!current && currentInspection?.blocking !== true,
      state,
      item: current,
      degraded: currentInspection?.unavailable === true,
    };
  })().finally(() => {
    if (promptImageMaterializationInflight.get(key) === work) {
      promptImageMaterializationInflight.delete(key);
    }
  });
  promptImageMaterializationInflight.set(key, work);
  return work;
}

type PersistedTabQueue = {
  items?: unknown[];
  autoRun?: boolean;
  stopAfter?: boolean;
  closeAfter?: boolean;
  firstDelaySeconds?: number;
  firstDelayCountdownAt?: number | null;
  workflowRestartPending?: boolean;
  loopRestartPending?: boolean;
  postPromptEnabled?: boolean;
  postPromptText?: string;
  loopPromptEnabled?: boolean;
  loopPromptText?: string;
  loopPromptArmedAt?: number | null;
  runAfterTabId?: string | null;
  workflowArmedAt?: number | null;
  panelCollapsed?: boolean;
  previewId?: string | null;
};

function normalizePersistedQueuedPrompt(value: unknown): QueuedPrompt | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<QueuedPrompt>;
  if (typeof item.text !== 'string') return null;
  const imagePaths = Array.isArray(item.imagePaths)
    ? item.imagePaths.flatMap((rawRef) => {
        if (!rawRef || typeof rawRef !== 'object') return [];
        const ref = rawRef as Partial<QueuedImageRef>;
        const id = Number(ref.id);
        if (!Number.isFinite(id) || id <= 0 || typeof ref.path !== 'string') return [];
        const availability = ref.availability === 'missing' ? 'missing' : ref.availability === 'available' ? 'available' : undefined;
        return [{
          id,
          path: ref.path,
          assetId: typeof ref.assetId === 'string' ? ref.assetId : undefined,
          mediaType: typeof ref.mediaType === 'string' ? ref.mediaType : mediaTypeFromPath(ref.path),
          size: Number.isFinite(Number(ref.size)) ? Math.max(0, Number(ref.size)) : 0,
          availability,
          error: typeof ref.error === 'string' ? ref.error : undefined,
        } satisfies QueuedImageRef];
      })
    : undefined;
  const attachmentState = item.attachmentState === 'materializing' || item.attachmentState === 'missing' || item.attachmentState === 'ready'
    ? item.attachmentState
    : undefined;
  const trigger = item.trigger?.kind === 'timer' && Number.isFinite(Number(item.trigger.seconds))
    ? { kind: 'timer' as const, seconds: normalizeFirstDelaySeconds(Number(item.trigger.seconds)) }
    : item.trigger?.kind === 'onTab' && typeof item.trigger.tabId === 'string' && item.trigger.tabId.length > 0
      ? { kind: 'onTab' as const, tabId: item.trigger.tabId }
      : normalizeAppRestartTrigger(item.trigger) || undefined;
  const condition = normalizeQueuedPromptContextCondition(item.condition);
  const metaAction: QueuedMetaAction | undefined = item.metaAction?.kind === 'restart'
    ? { kind: 'restart' }
    : item.metaAction?.kind === 'stop'
      ? { kind: 'stop' }
      : item.metaAction?.kind === 'close-tab'
        ? { kind: 'close-tab' }
        : item.metaAction?.kind === 'model-effort'
          && (item.metaAction.toolType === 'claude' || item.metaAction.toolType === 'codex')
          && typeof item.metaAction.model === 'string'
          && item.metaAction.model.trim().length > 0
          && typeof item.metaAction.effort === 'string'
          && item.metaAction.effort.trim().length > 0
          ? {
              kind: 'model-effort',
              toolType: item.metaAction.toolType,
              model: item.metaAction.model.trim(),
              effort: item.metaAction.effort.trim().toLowerCase(),
            }
        : item.metaAction?.kind === 'rewind'
          && typeof item.metaAction.targetUuid === 'string'
          && typeof item.metaAction.targetText === 'string'
          && typeof item.metaAction.sourceSessionId === 'string'
          && (item.metaAction.toolType === 'claude' || item.metaAction.toolType === 'codex')
          ? {
              kind: 'rewind',
              targetUuid: item.metaAction.targetUuid,
              targetText: item.metaAction.targetText,
              ...(rewindIteration(item.metaAction.targetIteration) ? { targetIteration: item.metaAction.targetIteration } : {}),
              sourceSessionId: item.metaAction.sourceSessionId,
              toolType: item.metaAction.toolType,
            }
          : undefined;
  // A persisted row that claims to be an action but lost required identity
  // must never degrade into an empty prompt and get submitted to the agent.
  if (item.metaAction && !metaAction) return null;
  const normalized = normalizeQueuedPrompt({
    id: typeof item.id === 'string' && item.id ? item.id : nextId(),
    enabled: item.enabled !== false,
    trigger,
    condition,
    metaAction,
    title: typeof item.title === 'string' ? item.title : undefined,
    titleManual: item.titleManual === true,
    text: item.text,
    chips: normalizeComposerChips(item.chips) as QueuedComposerChip[],
    images: Number.isFinite(Number(item.images)) ? Math.max(0, Number(item.images)) : 0,
    imagePaths,
    attachmentState,
    createdAt: Number.isFinite(Number(item.createdAt)) ? Number(item.createdAt) : Date.now(),
  });
  // Old releases stored the length fallback even for local commands. Replace
  // only that automatic label; an explicit user title must survive restore.
  const serializedDraft = serializeComposerDraft({
    text: normalized.text,
    chips: normalized.chips || [],
  });
  const oldLengthTitle = `[${countPromptCharacters(serializedDraft)} символов]`;
  const commandTitle = !normalized.metaAction && !normalized.titleManual
    ? getQueuedPromptLocalCommand(normalized.text, normalized.images, normalized.chips?.length || 0)
    : null;
  if (commandTitle && (!normalized.title?.trim() || normalized.title.trim() === oldLengthTitle)) {
    normalized.title = commandTitle;
  }
  if (collectClaudeImageRefIds(normalized.text).size > 0 && normalized.attachmentState !== 'missing') {
    return { ...normalized, attachmentState: 'materializing' };
  }
  return normalized;
}

function makeHydratedTabQueue(entry: PersistedTabQueue): TabQueue {
  let items = Array.isArray(entry.items)
    ? entry.items.map(normalizePersistedQueuedPrompt).filter((item): item is QueuedPrompt => item !== null)
    : [];
  const alreadyHasLifecycleTail = items.some((item) => (
    item.metaAction?.kind === 'stop' || item.metaAction?.kind === 'close-tab'
  ));
  const migratedLifecycleAction: QueuedMetaAction | null = alreadyHasLifecycleTail
    ? null
    : entry.closeAfter
      ? { kind: 'close-tab' }
      : entry.stopAfter
        ? { kind: 'stop' }
        : null;
  if (migratedLifecycleAction) {
    items = [...items, makeQueuedMetaActionItem(migratedLifecycleAction)];
    console.log('[PromptQueue] migrated legacy '
      + (entry.closeAfter ? 'closeAfter' : 'stopAfter')
      + ' flag to visible tail action');
  }
  let firstDelaySeconds = typeof entry.firstDelaySeconds === 'number'
    ? normalizeFirstDelaySeconds(entry.firstDelaySeconds)
    : 0;
  const previewId = typeof entry.previewId === 'string' && items.some((item) => item.id === entry.previewId)
    ? entry.previewId
    : null;
  let runAfterTabId = typeof entry.runAfterTabId === 'string' ? entry.runAfterTabId : null;
  if (items.length > 0 && !items[0].trigger && (runAfterTabId !== null || firstDelaySeconds > 0)) {
    items = [...items];
    items[0] = {
      ...items[0],
      trigger: runAfterTabId
        ? { kind: 'onTab', tabId: runAfterTabId }
        : { kind: 'timer', seconds: firstDelaySeconds },
    };
    runAfterTabId = null;
    firstDelaySeconds = 0;
    console.log('[PromptQueue] migrated global trigger to first item');
  }
  return {
    items,
    autoRun: !!entry.autoRun,
    workflowRestartPending: !!entry.autoRun && entry.workflowRestartPending === true,
    loopRestartPending: !!entry.loopPromptEnabled && entry.loopRestartPending === true,
    // Legacy flags are consumed into visible queue actions above. They stay in
    // the public shape as false compatibility fields until older remote clients
    // stop sending their old mutation names.
    stopAfter: false,
    closeAfter: false,
    firstDelaySeconds,
    // Persisted start + duration is one absolute deadline. Downtime counts;
    // a restart must not arm the same duration again from Date.now().
    firstDelayCountdownAt: entry.autoRun && typeof entry.firstDelayCountdownAt === 'number'
      && Number.isFinite(entry.firstDelayCountdownAt) && entry.firstDelayCountdownAt > 0
      ? entry.firstDelayCountdownAt : null,
    postPromptEnabled: !!entry.postPromptEnabled,
    postPromptText: typeof entry.postPromptText === 'string' ? entry.postPromptText : '',
    loopPromptEnabled: !!entry.loopPromptEnabled,
    loopPromptText: typeof entry.loopPromptText === 'string' ? entry.loopPromptText : '',
    loopPromptArmedAt: typeof entry.loopPromptArmedAt === 'number' && Number.isFinite(entry.loopPromptArmedAt)
      ? Number(entry.loopPromptArmedAt)
      : null,
    // Not `!!entry.panelCollapsed`: a row saved before this field existed has
    // no flag, and coercing "absent" to false would expand every restored tab.
    panelCollapsed: resolvePersistedPanelCollapsed(entry.panelCollapsed),
    // A legacy standalone Stop/Close could be armed independently of Play.
    // Auto-starting it on cold restore would stop an idle tab immediately, so
    // migration keeps the action visible and asks for one explicit Play.
    firstChipHintActive: !!migratedLifecycleAction && !entry.autoRun,
    stopBeforeCloseArm: false,
    runAfterTabId,
    workflowArmedAt: entry.autoRun && typeof entry.workflowArmedAt === 'number' && Number.isFinite(entry.workflowArmedAt)
      ? Number(entry.workflowArmedAt)
      : null,
    previewId,
  };
}

// Restore metadata immediately, then validate/copy image bytes in the background.
// This keeps persisted items visible during migration and lets pre-hydrate user
// actions merge into the saved queue instead of replacing the whole tab entry.
export function hydratePromptQueueStore(): Promise<void> {
  if (hasHydratedPromptQueueStore) return Promise.resolve();
  if (hydratePromptQueuePromise) return hydratePromptQueuePromise;

  hydratePromptQueuePromise = (async () => {
    try {
      const [raw] = await Promise.all([
        ipcRenderer.invoke('app:getState', APP_STATE_KEY_QUEUE),
        usePromptsStore.getState().loadPrompts(),
      ]);
      const parsedValue = !raw ? {} : (typeof raw === 'string' ? JSON.parse(raw) : raw);
      const parsed = parsedValue && typeof parsedValue === 'object' && !Array.isArray(parsedValue)
        ? parsedValue as Record<string, PersistedTabQueue>
        : {};
      const persistedQueues = new Map<string, TabQueue>();
      for (const [tabId, entry] of Object.entries(parsed)) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        persistedQueues.set(tabId, makeHydratedTabQueue(entry));
      }

      const persistedSharedLoopPrompt = usePromptsStore.getState()
        .getPromptById(RUN_AFTER_LOOP_PROMPT_ID)?.content ?? DEFAULT_SHARED_LOOP_PROMPT;
      const preserveLocalLoopEdit = preHydrateSharedLoopPromptChanged;

      usePromptQueueStore.setState((state) => {
        const sharedLoopPromptText = preHydrateSharedLoopPromptChanged
          ? state.sharedLoopPromptText
          : persistedSharedLoopPrompt;
        const next = new Map(state.queues);
        for (const [tabId, persisted] of persistedQueues) {
          const merged = mergeHydratedQueue(persisted, next.get(tabId), preHydrateQueueChanges.get(tabId));
          if (merged) next.set(tabId, { ...merged, loopPromptText: sharedLoopPromptText });
          else next.delete(tabId);
        }
        for (const [tabId, queue] of next) {
          if (queue.loopPromptText !== sharedLoopPromptText) {
            next.set(tabId, { ...queue, loopPromptText: sharedLoopPromptText });
          }
        }
        return { queues: next, sharedLoopPromptText };
      });
      markPromptQueueStoreHydrated();
      preHydrateQueueChanges.clear();
      preHydrateSharedLoopPromptChanged = false;
      scheduleSave(usePromptQueueStore.getState().queues);
      if (preserveLocalLoopEdit) scheduleSharedLoopPromptSave(usePromptQueueStore.getState().sharedLoopPromptText);

      const validationTasks: Promise<unknown>[] = [];
      for (const [tabId, queue] of usePromptQueueStore.getState().queues) {
        for (const item of queue.items) {
          if (collectClaudeImageRefIds(item.text).size === 0) continue;
          validationTasks.push(ensureQueuedPromptImagesReady(tabId, item.id));
        }
      }
      await Promise.allSettled(validationTasks);
    } catch (e) {
      // Do not leave the store permanently read-only after one bad row or IPC
      // failure. Existing in-memory actions remain saveable on the next mutation.
      const preserveLocalLoopEdit = preHydrateSharedLoopPromptChanged;
      markPromptQueueStoreHydrated();
      preHydrateQueueChanges.clear();
      preHydrateSharedLoopPromptChanged = false;
      if (usePromptQueueStore.getState().queues.size > 0) {
        scheduleSave(usePromptQueueStore.getState().queues);
      }
      if (preserveLocalLoopEdit) scheduleSharedLoopPromptSave(usePromptQueueStore.getState().sharedLoopPromptText);
      console.warn('[PromptQueue] hydrate failed:', e instanceof Error ? e.message : String(e));
    }
  })().finally(() => {
    hydratePromptQueuePromise = null;
  });
  return hydratePromptQueuePromise;
}
