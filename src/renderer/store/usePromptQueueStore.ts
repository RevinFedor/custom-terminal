import { create } from 'zustand';
import {
  buildPromptImagePayload,
  collectPromptImageRefIds,
  getPromptImageAttachmentState,
  getPromptImageMarkerHighlightRanges,
  hasMalformedPromptImageMarker,
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

const { ipcRenderer } = window.require('electron');

// SQLite-backed persistence via the existing app:setState / app:getState
// pattern (same as defaultClaudeEffort, debugHoverBridges, freePorts).
// Persist: items, autoRun, stopAfter, firstDelaySeconds, postPromptEnabled,
// postPromptText, loopPromptEnabled, panelCollapsed, previewId PER TAB. Skip:
// firstChipHintActive (UI-only).
// Serialized shape: { [tabId]: { items, autoRun, stopAfter, firstDelaySeconds,
//                                postPromptEnabled, postPromptText, panelCollapsed,
//                                previewId } }.
const APP_STATE_KEY_QUEUE = 'promptQueueByTab';
const APP_STATE_KEY_SHARED_LOOP_PROMPT = 'promptQueueSharedLoopPrompt';
export const DEFAULT_SHARED_LOOP_PROMPT = [
  'Проверь, полностью ли выполнена исходная задача.',
  'Если осталась работа, продолжай её сейчас и не ограничивайся планом или обещанием.',
].join(' ');

export function parsePersistedSharedLoopPrompt(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'string') return parsed;
  } catch {
    // Older/dev rows may contain the prompt directly rather than JSON text.
  }
  return raw;
}

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
  | 'runAfterTabId' | 'workflowArmedAt' | 'panelCollapsed' | 'previewId'
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
      !q.panelCollapsed &&
      !q.previewId
    ) continue;
    out[tabId] = {
      items: q.items,
      autoRun: q.autoRun,
      stopAfter: q.stopAfter,
      closeAfter: q.closeAfter,
      firstDelaySeconds: q.firstDelaySeconds,
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
    ipcRenderer.invoke('app:setState', {
      key: APP_STATE_KEY_SHARED_LOOP_PROMPT,
      value: JSON.stringify(text),
    }).catch((e: unknown) => console.warn('[PromptQueue] shared Loop prompt save failed:', e));
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
    ipcRenderer.sendSync('app:setStateSync', {
      key: APP_STATE_KEY_SHARED_LOOP_PROMPT,
      value: JSON.stringify(usePromptQueueStore.getState().sharedLoopPromptText),
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
  createdAt?: number;
};

export type QueuedPrompt = {
  id: string;
  // false = keep visible in the list, but skip it when Run-after picks the
  // next prompt. Undefined legacy rows are treated as enabled.
  enabled?: boolean;
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
  // When true, after the next Claude turn ends AND the queue is empty, we invoke
  // terminal:stop-ai-process for this tab (SIGTERM the claude process).
  // Independent from autoRun: works even without queued items so the user can fire-and-forget
  // a single prompt then have Claude shut down automatically.
  stopAfter: boolean;
  // When true, after stop fires (see stopAfter above) we ALSO close the whole
  // tab via useWorkspaceStore.closeTab — no confirm. Implies stopAfter must be
  // true to make sense (you can't close a tab without stopping its process),
  // so the UI auto-arms stopAfter whenever closeAfter is turned on. Turning
  // closeAfter off does NOT turn stopAfter off — they are two-toggle stack.
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
  // Per-tab UI state for the Run-after panel. Default is expanded (false);
  // if the user collapses a specific tab, that choice persists across tab
  // navigation and app restart until they manually expand it again.
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

  // ── Close-after restore memory ──────────────────────────────────────────
  // Remembers whether stopAfter was already ON at the moment the user armed
  // closeAfter. Turning closeAfter OFF restores stopAfter to that prior value
  // instead of leaving it stuck on, so:
  //   (stop=OFF, close=OFF) → click ⏻ → (stop=ON, close=ON)
  //                         → click ⏻ → (stop=OFF, close=OFF)   ← restored
  //   (stop=ON,  close=OFF) → click ⏻ → (stop=ON, close=ON)
  //                         → click ⏻ → (stop=ON,  close=OFF)   ← preserved
  // Reset to false whenever user clicks left zone directly OR closeAfter
  // returns to OFF (after a restore-cycle the slot has done its job).
  // Non-persistent — across restarts there is no "prior" state to restore to.
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
    options?: { preservePivoted?: boolean; preserveLoop?: boolean },
  ) => string[];

  // Drop queue state owned by a closed tab and clear run-after pivots that
  // pointed at it. Called from workspace closeTab.
  cleanupClosedTab: (tabId: string) => void;

  getQueue: (tabId: string) => TabQueue;
}

const EMPTY: TabQueue = {
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
  panelCollapsed: false,
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
    firstDelayCountdownAt: current.firstDelayCountdownAt,
    firstChipHintActive: current.firstChipHintActive,
    stopBeforeCloseArm: current.stopBeforeCloseArm,
  };
  if (changed?.has('items')) merged.items = mergeHydratedItems(persisted.items, current.items);
  if (changed?.has('autoRun')) merged.autoRun = current.autoRun;
  if (changed?.has('stopAfter')) merged.stopAfter = current.stopAfter;
  if (changed?.has('closeAfter')) merged.closeAfter = current.closeAfter;
  if (changed?.has('firstDelaySeconds')) merged.firstDelaySeconds = current.firstDelaySeconds;
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

// ── Cross-client core shape ──────────────────────────────────────────────────
// The subset of a TabQueue that crosses the wire to mobile (and that SQLite
// persists). Presentation-only slots (previewId, firstChipHintActive,
// firstDelayCountdownAt, stopBeforeCloseArm) are intentionally NOT here — they are local-presentation
// state, meaningless on another client. Mobile reads this via the getPromptQueue
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

export function makeDefaultPromptTitle(text: string): string {
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
  imagesHint = 0,
): QueuedPromptAttachmentState {
  if (imagesHint > 0 && /\[imageError:\s*[^\]\r\n]+\]/i.test(text)) return 'missing';
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
  const next = {
    ...item,
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

export const usePromptQueueStore = create<PromptQueueStore>((set, get) => {
  // setAndPersist: write next state, then schedule a debounced disk save.
  // PreviewId-only mutations skip the save (UI-only, see scheduleSave).
  const setAndPersist = (updater: (state: PromptQueueStore) => { queues: Map<string, TabQueue> }, opts?: { skipSave?: boolean }) => {
    set((state) => {
      const next = updater(state);
      let normalizedQueues = next.queues;
      for (const [tabId, queue] of next.queues) {
        if (queue.loopPromptText === state.sharedLoopPromptText) continue;
        if (normalizedQueues === next.queues) normalizedQueues = new Map(next.queues);
        normalizedQueues.set(tabId, { ...queue, loopPromptText: state.sharedLoopPromptText });
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
        const defaultTitle = makeDefaultPromptTitle(serializedDraft);
        const normalizedTitle = typeof title === 'string' ? title.trim() : '';
        const titleManual = normalizedTitle.length > 0 && normalizedTitle !== defaultTitle;
        const items = [...cur.items, {
          id,
          enabled: true,
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
          const normalized = typeof patch.text === 'string'
            ? normalizeImagePathMarkersForQueue(patch.text, p.imagePaths)
            : { text: p.text, imagePaths: p.imagePaths };
          const text = normalized.text;
          const images = typeof patch.text === 'string'
            ? Math.max(
                countImages(text),
                normalized.imagePaths?.length ?? 0,
                hasMalformedQueuedImageMarker(text, normalized.imagePaths) ? p.images : 0,
                p.attachmentState === 'missing' && /\[imageError:\s*[^\]\r\n]+\]/i.test(text) ? p.images : 0,
              )
            : p.images;
          const imagePaths = normalized.imagePaths;
          const chips = Array.isArray(patch.chips)
            ? normalizeComposerChips(patch.chips) as QueuedComposerChip[]
            : (p.chips || []);
          const defaultTitle = makeDefaultPromptTitle(serializeComposerDraft({
            text,
            chips,
          }));
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
            attachmentState: typeof patch.text === 'string'
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
      if (typeof patch.text === 'string') {
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
            p.attachmentState === 'missing' && /\[imageError:\s*[^\]\r\n]+\]/i.test(normalized.text) ? p.images : 0,
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
                })),
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
        const items = cur.items.map((item) => {
          if (item.id !== id || (expectedText !== undefined && item.text !== expectedText)) return item;
          changed = true;
          return {
            ...item,
            imagePaths: retainImagePathsForText(item.text, imagePaths),
            images: Math.max(
              countImages(item.text),
              imagePaths?.length ?? 0,
              attachmentState === 'missing' && /\[imageError:\s*[^\]\r\n]+\]/i.test(item.text) ? item.images : 0,
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
        // Turning Stop after OFF must also disable closeAfter — closing a tab
        // whose stop is not scheduled would never fire. (Inverse: turning
        // stopAfter ON doesn't touch closeAfter; user decides separately.)
        const closeAfter = value ? cur.closeAfter : false;
        // User clicked the LEFT zone directly. Whatever the close-arm memory
        // was holding is now stale (the new baseline is whatever stop=value
        // means), so wipe it. Otherwise the next close-arm/disarm cycle
        // would restore stop=true based on data from BEFORE this click.
        const updated = { ...cur, stopAfter: value, closeAfter, stopBeforeCloseArm: false };
        const explicitArm = value && !hasActiveQueueWorkflow(cur);
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
        if (value) {
          // Arming closeAfter forces stopAfter ON (can't close a tab whose
          // process never gets stopped). Remember whether stopAfter was ALREADY
          // on, so the inverse click can restore it accurately.
          const updated = {
            ...cur,
            closeAfter: true,
            stopAfter: true,
            stopBeforeCloseArm: cur.stopAfter,
          };
          const explicitArm = !hasActiveQueueWorkflow(cur);
          if (explicitArm) markRuntimeWorkflowArm(tabId);
          next.set(tabId, {
            ...updated,
            workflowArmedAt: retainedWorkflowArmedAt(cur, updated, explicitArm),
          });
        } else {
          // Disarming closeAfter: restore stopAfter to what it was BEFORE this
          // close-arm cycle. If user had stopAfter on independently before,
          // it stays on. If user clicked ⏻ from the all-off baseline, both
          // toggles return to off — matching user expectation:
          //   "click ⏻ once → both on; click ⏻ again → both off."
          const updated = {
            ...cur,
            closeAfter: false,
            stopAfter: cur.stopBeforeCloseArm,
            stopBeforeCloseArm: false,
          };
          next.set(tabId, {
            ...updated,
            workflowArmedAt: retainedWorkflowArmedAt(cur, updated),
          });
          if (!hasActiveQueueWorkflow(updated)) runtimeWorkflowArmTabs.delete(tabId);
        }
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
          loopPromptArmedAt: value ? Date.now() : null,
        });
        return { queues: next };
      });
    },

    setLoopPromptText: (tabId, text) => {
      if (!hasHydratedPromptQueueStore) preHydrateSharedLoopPromptChanged = true;
      set((state) => {
        if (state.sharedLoopPromptText === text) return state;
        const next = new Map(state.queues);
        const editedAt = Date.now();
        for (const [ownerTabId, queue] of next) {
          next.set(ownerTabId, {
            ...queue,
            loopPromptText: text,
            // Editing the shared body changes every enabled Loop operation.
            loopPromptArmedAt: queue.loopPromptEnabled ? editedAt : queue.loopPromptArmedAt,
          });
        }
        trackPreHydrateQueueChanges(state.queues, next);
        scheduleSave(next);
        scheduleSharedLoopPromptSave(text);
        return { queues: next, sharedLoopPromptText: text };
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

    disarmQueuesForTrigger: (triggerTabId, outcomeTs = null, options = {}) => {
      const disarmed: string[] = [];
      const classifiedOutcomeTs = Number.isFinite(outcomeTs) ? Number(outcomeTs) : null;
      setAndPersist((state) => {
        let changed = false;
        const next = new Map(state.queues);
        for (const [ownerTabId, cur] of state.queues) {
          const ownsTrigger = ownerTabId === triggerTabId;
          const waitsOnTrigger = cur.runAfterTabId === triggerTabId;
          const hasQueuePromise = cur.autoRun || cur.stopAfter || cur.closeAfter || cur.firstDelayCountdownAt !== null;
          const queueMatches = hasQueuePromise
            && (ownsTrigger || (waitsOnTrigger && options.preservePivoted !== true));
          const loopMatches = ownsTrigger
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
              stopAfter: false,
              closeAfter: false,
              stopBeforeCloseArm: false,
              firstDelayCountdownAt: null,
              runAfterTabId: null,
              workflowArmedAt: null,
            } : {}),
            ...(disarmLoop ? {
              loopPromptEnabled: false,
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
          if (queue.runAfterTabId !== closedTabId) continue;
          automaticRunAfterTargetClearTabs.add(ownerTabId);
          next.set(ownerTabId, { ...queue, runAfterTabId: null });
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

const promptImageMaterializationInflight = new Map<string, Promise<{
  ready: boolean;
  state: QueuedPromptAttachmentState;
  item: QueuedPrompt | null;
}>>();

async function materializeQueuedPromptRecord(item: QueuedPrompt): Promise<QueuedPrompt> {
  const normalized = normalizeQueuedPrompt(item);
  if (getQueuedPromptAttachmentState(normalized) === 'missing'
    && normalized.images > 0
    && /\[imageError:\s*[^\]\r\n]+\]/i.test(normalized.text)) {
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
): Promise<{ ready: boolean; state: QueuedPromptAttachmentState; item: QueuedPrompt | null }> {
  const key = tabId + ':' + itemId;
  const existing = promptImageMaterializationInflight.get(key);
  if (existing) return existing;

  const work = (async () => {
    const before = usePromptQueueStore.getState().getQueue(tabId).items.find((item) => item.id === itemId) || null;
    if (!before) return { ready: false, state: 'missing' as const, item: null };
    if (hasMalformedQueuedImageMarker(before.text, before.imagePaths)) {
      return { ready: false, state: 'missing' as const, item: before };
    }
    if (collectClaudeImageRefIds(before.text).size === 0
      && !(before.images > 0 && /\[imageError:\s*[^\]\r\n]+\]/i.test(before.text))) {
      return { ready: true, state: 'ready' as const, item: before };
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
    return { ready: state === 'ready', state, item: current };
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
  const normalized = normalizeQueuedPrompt({
    id: typeof item.id === 'string' && item.id ? item.id : nextId(),
    enabled: item.enabled !== false,
    title: typeof item.title === 'string' ? item.title : undefined,
    titleManual: item.titleManual === true,
    text: item.text,
    chips: normalizeComposerChips(item.chips) as QueuedComposerChip[],
    images: Number.isFinite(Number(item.images)) ? Math.max(0, Number(item.images)) : 0,
    imagePaths,
    attachmentState,
    createdAt: Number.isFinite(Number(item.createdAt)) ? Number(item.createdAt) : Date.now(),
  });
  if (collectClaudeImageRefIds(normalized.text).size > 0 && normalized.attachmentState !== 'missing') {
    return { ...normalized, attachmentState: 'materializing' };
  }
  return normalized;
}

function makeHydratedTabQueue(entry: PersistedTabQueue): TabQueue {
  const items = Array.isArray(entry.items)
    ? entry.items.map(normalizePersistedQueuedPrompt).filter((item): item is QueuedPrompt => item !== null)
    : [];
  const firstDelaySeconds = typeof entry.firstDelaySeconds === 'number'
    ? normalizeFirstDelaySeconds(entry.firstDelaySeconds)
    : 0;
  const previewId = typeof entry.previewId === 'string' && items.some((item) => item.id === entry.previewId)
    ? entry.previewId
    : null;
  return {
    items,
    autoRun: !!entry.autoRun,
    stopAfter: !!entry.stopAfter,
    closeAfter: !!entry.closeAfter,
    firstDelaySeconds,
    firstDelayCountdownAt: null,
    postPromptEnabled: !!entry.postPromptEnabled,
    postPromptText: typeof entry.postPromptText === 'string' ? entry.postPromptText : '',
    loopPromptEnabled: !!entry.loopPromptEnabled,
    loopPromptText: typeof entry.loopPromptText === 'string' ? entry.loopPromptText : '',
    loopPromptArmedAt: typeof entry.loopPromptArmedAt === 'number' && Number.isFinite(entry.loopPromptArmedAt)
      ? Number(entry.loopPromptArmedAt)
      : null,
    panelCollapsed: !!entry.panelCollapsed,
    firstChipHintActive: false,
    stopBeforeCloseArm: false,
    runAfterTabId: typeof entry.runAfterTabId === 'string' ? entry.runAfterTabId : null,
    workflowArmedAt: typeof entry.workflowArmedAt === 'number' && Number.isFinite(entry.workflowArmedAt)
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
      const [raw, rawSharedLoopPrompt] = await Promise.all([
        ipcRenderer.invoke('app:getState', APP_STATE_KEY_QUEUE),
        ipcRenderer.invoke('app:getState', APP_STATE_KEY_SHARED_LOOP_PROMPT),
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

      const legacySharedLoopPrompt = Array.from(persistedQueues.values())
        .filter((queue) => queue.loopPromptText.trim().length > 0)
        .sort((a, b) => (b.loopPromptArmedAt ?? -1) - (a.loopPromptArmedAt ?? -1))[0]
        ?.loopPromptText;
      const persistedSharedLoopPrompt = parsePersistedSharedLoopPrompt(rawSharedLoopPrompt)
        ?? legacySharedLoopPrompt
        ?? DEFAULT_SHARED_LOOP_PROMPT;

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
      scheduleSharedLoopPromptSave(usePromptQueueStore.getState().sharedLoopPromptText);

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
      markPromptQueueStoreHydrated();
      preHydrateQueueChanges.clear();
      preHydrateSharedLoopPromptChanged = false;
      if (usePromptQueueStore.getState().queues.size > 0) {
        scheduleSave(usePromptQueueStore.getState().queues);
      }
      scheduleSharedLoopPromptSave(usePromptQueueStore.getState().sharedLoopPromptText);
      console.warn('[PromptQueue] hydrate failed:', e instanceof Error ? e.message : String(e));
    }
  })().finally(() => {
    hydratePromptQueuePromise = null;
  });
  return hydratePromptQueuePromise;
}
