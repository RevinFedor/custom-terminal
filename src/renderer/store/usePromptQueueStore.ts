import { create } from 'zustand';

const { ipcRenderer } = window.require('electron');

// SQLite-backed persistence via the existing app:setState / app:getState
// pattern (same as defaultClaudeEffort, debugHoverBridges, freePorts).
// Persist: items, autoRun, stopAfter, firstDelaySeconds, postPromptEnabled,
// postPromptText, panelCollapsed, previewId PER TAB. Skip:
// firstChipHintActive (UI-only).
// Serialized shape: { [tabId]: { items, autoRun, stopAfter, firstDelaySeconds,
//                                postPromptEnabled, postPromptText, panelCollapsed,
//                                previewId } }.
const APP_STATE_KEY_QUEUE = 'promptQueueByTab';

// Throttle disk writes — drag-reorder fires many state updates per second and
// SQLite IO on every keystroke would be wasteful. 250ms covers fast typing and
// drag-reorder without losing the last value on unmount.
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let hasHydratedPromptQueueStore = false;

function serializePromptQueueSnapshot(snapshot: Map<string, TabQueue>): Record<string, Pick<TabQueue, 'items' | 'autoRun' | 'stopAfter' | 'closeAfter' | 'firstDelaySeconds' | 'postPromptEnabled' | 'postPromptText' | 'runAfterTabId' | 'panelCollapsed' | 'previewId'>> {
  const out: Record<string, Pick<TabQueue, 'items' | 'autoRun' | 'stopAfter' | 'closeAfter' | 'firstDelaySeconds' | 'postPromptEnabled' | 'postPromptText' | 'runAfterTabId' | 'panelCollapsed' | 'previewId'>> = {};
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
      runAfterTabId: q.runAfterTabId,
      panelCollapsed: q.panelCollapsed,
      previewId: q.previewId,
    };
  }
  return out;
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
  try {
    const out = serializePromptQueueSnapshot(usePromptQueueStore.getState().queues);
    if (!hasHydratedPromptQueueStore) {
      console.warn('[PromptQueue] skip pre-hydrate sync save entries=' + Object.keys(out).length);
      return;
    }
    ipcRenderer.sendSync('app:setStateSync', { key: APP_STATE_KEY_QUEUE, value: JSON.stringify(out) });
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
  images: number; // number of [Image] / [Pasted image] placeholders the original input had
  // Resolved disk paths for each [Image #N] in `text`, in order of appearance.
  // Length may be < `images` if some files were missing at grab time (logged
  // as [GrabImages] ... :MISSING). Undefined for legacy chips loaded from
  // pre-imagePaths persisted state — UI should treat that as "unknown" not "zero".
  imagePaths?: QueuedImageRef[];
  attachmentState?: QueuedPromptAttachmentState;
  createdAt: number;
};

function collectClaudeImageRefIds(text: string): Set<number> {
  const ids = new Set<number>();
  const re = /\[Image\s+#?(\d+)\]/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const id = Number(match[1]);
    if (Number.isFinite(id)) ids.add(id);
  }
  return ids;
}

function retainImagePathsForText(text: string, imagePaths?: QueuedImageRef[]): QueuedImageRef[] | undefined {
  if (!imagePaths || imagePaths.length === 0) return undefined;
  const ids = collectClaudeImageRefIds(text);
  if (ids.size === 0) return undefined;
  const retained = imagePaths.filter((ref) => ids.has(ref.id));
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

export function buildQueuedPromptPayload(item: Pick<QueuedPrompt, 'text' | 'imagePaths'>): string {
  const imagePaths = item.imagePaths || [];
  const byId = new Map<number, QueuedImageRef>();
  for (const ref of imagePaths) byId.set(ref.id, ref);

  return item.text.replace(/\[Image\s+#?(\d+)\]/gi, (_match, rawId) => {
    const id = Number(rawId);
    const resolved = byId.get(id);
    if (!resolved?.path || resolved.availability === 'missing') {
      return `[imageError: queued_image_path_unavailable #${rawId}]`;
    }
    return `[imagePath: ${resolved.path}]`;
  });
}

export function getQueuedPromptAttachmentState(
  item: Pick<QueuedPrompt, 'text' | 'images' | 'imagePaths' | 'attachmentState'>,
): QueuedPromptAttachmentState {
  if (item.attachmentState === 'materializing') return 'materializing';
  if (item.attachmentState === 'missing') return 'missing';
  if (item.images > 0 && /\[imageError:\s*[^\]\r\n]+\]/i.test(item.text)) return 'missing';
  const ids = collectClaudeImageRefIds(item.text);
  if (ids.size === 0) return 'ready';
  const byId = new Map((item.imagePaths || []).map((ref) => [Number(ref.id), ref]));
  for (const id of ids) {
    const ref = byId.get(id);
    if (!ref?.path || ref.availability === 'missing') return 'missing';
  }
  return item.attachmentState === 'missing' ? 'missing' : 'ready';
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
  //                            to 0/null so the UI returns to the empty placeholder.
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
  // The UI surfaces this with a "!" icon (waiting for activation) vs spinner
  // (already busy, waiting for finish).
  //
  // Persistent so the choice survives restarts. Stale ids (target tab was
  // closed) are validated lazily in the runner — if the tab no longer exists
  // in any project workspace, the slot self-clears to null and falls back to
  // standard own-tab behaviour. Don't validate in the store (would create a
  // dependency cycle with useWorkspaceStore).
  runAfterTabId: string | null;
};

interface PromptQueueStore {
  // Per-tab queues. Outside Claude tabs the overlay is hidden, but state survives tab switching.
  queues: Map<string, TabQueue>;

  addPrompt: (tabId: string, text: string, images?: number, imagePaths?: QueuedImageRef[], title?: string) => string;
  removePrompt: (tabId: string, id: string) => void;
  updatePrompt: (tabId: string, id: string, patch: { text?: string; title?: string; titleManual?: boolean; enabled?: boolean }) => void;
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
  setRunAfterTab: (tabId: string, targetTabId: string | null) => void;
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
  disarmQueuesForTrigger: (triggerTabId: string) => string[];

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
  panelCollapsed: false,
  firstChipHintActive: false,
  stopBeforeCloseArm: false,
  runAfterTabId: null,
};

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
  };
}

// Count image placeholders in queue text. Claude TUI renders pasted images as
// "[Image #N]" tokens; Codex [imagePath: /full/path] markers are normalized to
// the same short token when entering the queue. Pasted-text-chips like
// "[Pasted text #N +M lines]" are NOT counted here — those are full-text
// expansions the editor view exposes verbatim.
const IMAGE_RE = /\[Image(?:\s+#?\d+)?\]/gi;
const IMAGE_PATH_RE = /\[imagePath:\s*([^\]\r\n]+?)\s*\]/gi;
function countImages(text: string): number {
  return (text.match(IMAGE_RE) || []).length;
}

export function countPromptCharacters(text: string): number {
  return Array.from(text).length;
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

// Once Enter was written, the queue no longer owns this prompt. A late
// history/JSONL audit can time out after the agent has already started; keeping
// the item in that case would make a retry duplicate the submission.
export function queueSendTransferredOwnership(result: unknown): boolean {
  if (!result || typeof result !== 'object') return true;
  const sendResult = result as { success?: boolean; submitted?: boolean };
  return sendResult.success !== false || sendResult.submitted === true;
}

function getInitialQueuedPromptAttachmentState(
  text: string,
  imagePaths?: QueuedImageRef[],
  imagesHint = 0,
): QueuedPromptAttachmentState {
  if (imagesHint > 0 && /\[imageError:\s*[^\]\r\n]+\]/i.test(text)) return 'missing';
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
  const next = {
    ...item,
    enabled: item.enabled !== false,
    text: normalized.text,
    images: Math.max(item.images || 0, countImages(normalized.text), normalized.imagePaths?.length ?? 0),
    imagePaths: normalized.imagePaths,
  };
  return {
    ...next,
    attachmentState: getInitialQueuedPromptAttachmentState(next.text, next.imagePaths, next.images),
  };
}

export const usePromptQueueStore = create<PromptQueueStore>((set, get) => {
  // setAndPersist: write next state, then schedule a debounced disk save.
  // PreviewId-only mutations skip the save (UI-only, see scheduleSave).
  const setAndPersist = (updater: (state: { queues: Map<string, TabQueue> }) => { queues: Map<string, TabQueue> }, opts?: { skipSave?: boolean }) => {
    set((state) => {
      const next = updater(state);
      if (!opts?.skipSave) scheduleSave(next.queues);
      return next;
    });
  };

  return {
    queues: new Map(),

    addPrompt: (tabId, text, images, imagePaths, title) => {
      const id = nextId();
      setAndPersist((state) => {
        const next = new Map(state.queues);
        const cur = next.get(tabId) ?? EMPTY;
        const normalized = normalizeImagePathMarkersForQueue(text, imagePaths);
        const detectedImages = Math.max(images ?? 0, countImages(normalized.text), normalized.imagePaths?.length ?? 0);
        const defaultTitle = makeDefaultPromptTitle(normalized.text);
        const normalizedTitle = typeof title === 'string' ? title.trim() : '';
        const titleManual = normalizedTitle.length > 0 && normalizedTitle !== defaultTitle;
        const items = [...cur.items, {
          id,
          enabled: true,
          title: titleManual ? normalizedTitle : defaultTitle,
          titleManual,
          text: normalized.text,
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
        next.set(tabId, { ...cur, items, firstChipHintActive: shouldArmHint ? true : cur.firstChipHintActive });
        return { queues: next };
      });
      const added = get().getQueue(tabId).items.find((item) => item.id === id);
      if (added?.attachmentState === 'materializing') {
        void ensureQueuedPromptImagesReady(tabId, id);
      }
      return id;
    },

    removePrompt: (tabId, id) => {
      setAndPersist((state) => {
        const cur = state.queues.get(tabId);
        if (!cur) return state;
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
          previewId: cur.previewId === id ? null : cur.previewId,
        });
        return { queues: next };
      });
    },

    updatePrompt: (tabId, id, patch) => {
      setAndPersist((state) => {
        const cur = state.queues.get(tabId);
        if (!cur) return state;
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
                p.attachmentState === 'missing' && /\[imageError:\s*[^\]\r\n]+\]/i.test(text) ? p.images : 0,
              )
            : p.images;
          const imagePaths = normalized.imagePaths;
          const defaultTitle = makeDefaultPromptTitle(text);
          let titleManual = !!p.titleManual;
          let title = p.title || defaultTitle;
          if (typeof patch.title === 'string') {
            const normalized = patch.title.trim();
            title = normalized || defaultTitle;
            titleManual = normalized.length > 0 && normalized !== defaultTitle;
          } else if (typeof patch.text === 'string' && !titleManual) {
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
        const queueEmptied = activeBefore > 0 && countEnabledQueuedPrompts(items) === 0;
        next.set(tabId, {
          ...cur,
          items,
          autoRun: queueEmptied ? false : cur.autoRun,
          stopAfter: queueEmptied ? false : cur.stopAfter,
          closeAfter: queueEmptied ? false : cur.closeAfter,
          stopBeforeCloseArm: queueEmptied ? false : cur.stopBeforeCloseArm,
          firstDelayCountdownAt: queueEmptied ? null : cur.firstDelayCountdownAt,
          firstChipHintActive: queueEmptied ? false : cur.firstChipHintActive,
        });
        return { queues: next };
      });
      if (typeof patch.text === 'string') {
        const updated = get().getQueue(tabId).items.find((item) => item.id === id);
        if (updated?.attachmentState === 'materializing') {
          void ensureQueuedPromptImagesReady(tabId, id);
        }
      }
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
            p.attachmentState === 'missing' && /\[imageError:\s*[^\]\r\n]+\]/i.test(normalized.text) ? p.images : 0,
          );
          return {
            ...p,
            text: normalized.text,
            images,
            imagePaths: normalized.imagePaths,
            attachmentState: getInitialQueuedPromptAttachmentState(normalized.text, normalized.imagePaths, images),
            title: p.titleManual ? p.title : makeDefaultPromptTitle(normalized.text),
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
        next.set(tabId, {
          ...cur,
          autoRun: value,
          firstChipHintActive: false,
          firstDelayCountdownAt: value ? cur.firstDelayCountdownAt : null,
        });
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
        next.set(tabId, { ...cur, stopAfter: value, closeAfter, stopBeforeCloseArm: false });
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
          next.set(tabId, {
            ...cur,
            closeAfter: true,
            stopAfter: true,
            stopBeforeCloseArm: cur.stopAfter,
          });
        } else {
          // Disarming closeAfter: restore stopAfter to what it was BEFORE this
          // close-arm cycle. If user had stopAfter on independently before,
          // it stays on. If user clicked ⏻ from the all-off baseline, both
          // toggles return to off — matching user expectation:
          //   "click ⏻ once → both on; click ⏻ again → both off."
          next.set(tabId, {
            ...cur,
            closeAfter: false,
            stopAfter: cur.stopBeforeCloseArm,
            stopBeforeCloseArm: false,
          });
        }
        return { queues: next };
      });
    },

    setRunAfterTab: (tabId, targetTabId) => {
      setAndPersist((state) => {
        const next = new Map(state.queues);
        const cur = next.get(tabId) ?? EMPTY;
        // Self-target makes no semantic sense (waiting on yourself = waiting
        // forever, since the same Stop hook would fire). Coerce to null.
        const value = targetTabId === tabId ? null : targetTabId;
        // Picking a target tab is an explicit Run-after intent. Auto-arm on
        // non-null selection so "on tab" cannot sit as a passive label while
        // the queue is actually off.
        next.set(tabId, {
          ...cur,
          runAfterTabId: value,
          autoRun: value ? true : cur.autoRun,
          firstChipHintActive: value ? false : cur.firstChipHintActive,
        });
        return { queues: next };
      });
    },

    setFirstDelaySeconds: (tabId, value) => {
      const clamped = Math.max(0, Math.min(3600, Math.floor(value)));
      setAndPersist((state) => {
        const next = new Map(state.queues);
        const cur = next.get(tabId) ?? EMPTY;
        // Editing the input while a countdown is running is treated as cancel-edit-restart:
        // we drop the active countdown slot, the new value becomes the value the input shows.
        next.set(tabId, { ...cur, firstDelaySeconds: clamped, firstDelayCountdownAt: null });
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
        const elapsedMs = Date.now() - cur.firstDelayCountdownAt;
        const remaining = Math.max(0, cur.firstDelaySeconds - Math.floor(elapsedMs / 1000));
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
          const next = new Map(state.queues);
          next.set(tabId, { ...cur, runAfterTabId: null });
          targetCleared = true;
          return { queues: next };
        }
        const items = cur.items.filter((_, itemIndex) => itemIndex !== index);
        targetCleared = consumesCurrentTarget;
        const next = new Map(state.queues);
        next.set(tabId, {
          ...cur,
          items,
          autoRun: beforeCount === 1 ? false : cur.autoRun,
          runAfterTabId: targetCleared ? null : cur.runAfterTabId,
          previewId: cur.previewId === id ? null : cur.previewId,
        });
        removed = true;
        return { queues: next };
      });
      return { removed, beforeCount, targetCleared };
    },

    disarmQueuesForTrigger: (triggerTabId) => {
      const disarmed: string[] = [];
      setAndPersist((state) => {
        let changed = false;
        const next = new Map(state.queues);
        for (const [ownerTabId, cur] of state.queues) {
          const ownsTrigger = ownerTabId === triggerTabId;
          const waitsOnTrigger = cur.runAfterTabId === triggerTabId;
          const hasActivePromise = cur.autoRun || cur.stopAfter || cur.closeAfter || cur.firstDelayCountdownAt !== null;
          if ((!ownsTrigger && !waitsOnTrigger) || !hasActivePromise) continue;
          next.set(ownerTabId, {
            ...cur,
            autoRun: false,
            stopAfter: false,
            closeAfter: false,
            stopBeforeCloseArm: false,
            firstDelayCountdownAt: null,
            runAfterTabId: null,
          });
          disarmed.push(ownerTabId);
          changed = true;
        }
        return changed ? { queues: next } : state;
      });
      return disarmed;
    },

    cleanupClosedTab: (closedTabId) => {
      setAndPersist((state) => {
        let changed = false;
        const next = new Map(state.queues);

        if (next.delete(closedTabId)) changed = true;

        for (const [ownerTabId, queue] of next) {
          if (queue.runAfterTabId !== closedTabId) continue;
          next.set(ownerTabId, { ...queue, runAfterTabId: null });
          changed = true;
        }

        if (!changed) return state;
        return { queues: next };
      });
    },

    getQueue: (tabId) => get().queues.get(tabId) ?? EMPTY,
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
    const refs = Array.isArray(result?.refs)
      ? result.refs as QueuedImageRef[]
      : normalized.imagePaths.map((ref) => ({ ...ref, availability: 'missing' as const, error: 'materialize_failed' }));
    const byId = new Map(refs.map((ref) => [Number(ref.id), ref]));
    const ready = Array.from(ids).every((id) => {
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

// Hydrate from SQLite on app boot. Called by App.tsx once at mount. Idempotent —
// safe to call multiple times but only the first one with non-empty data wins
// (we merge, not replace, in case a tab already added entries before hydrate
// completed — unlikely but harmless).
export async function hydratePromptQueueStore(): Promise<void> {
  try {
    const raw = await ipcRenderer.invoke('app:getState', APP_STATE_KEY_QUEUE);
    if (!raw) {
      hasHydratedPromptQueueStore = true;
      scheduleSave(usePromptQueueStore.getState().queues);
      return;
    }
    // database.getAppState() already JSON.parses the stored string and returns
    // an OBJECT (it only returns the raw string when the parse fails). So `raw`
    // is normally an object here, not a string. Blindly JSON.parse-ing it again
    // coerces the object to "[object Object]" and throws — which is exactly the
    // `[PromptQueue] hydrate failed: {}` that fired on every boot, silently
    // dropping a queue that WAS saved correctly. Accept either shape.
    const parsed = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, {
      items?: QueuedPrompt[];
      autoRun?: boolean;
      stopAfter?: boolean;
      closeAfter?: boolean;
      firstDelaySeconds?: number;
      postPromptEnabled?: boolean;
      postPromptText?: string;
      runAfterTabId?: string | null;
      panelCollapsed?: boolean;
      previewId?: string | null;
    }>;
    if (!parsed || typeof parsed !== 'object') {
      hasHydratedPromptQueueStore = true;
      scheduleSave(usePromptQueueStore.getState().queues);
      return;
    }
    const hydratedItemsByTab = new Map<string, QueuedPrompt[]>();
    await Promise.all(Object.entries(parsed).map(async ([tabId, entry]) => {
      const items = Array.isArray(entry.items) ? entry.items : [];
      hydratedItemsByTab.set(
        tabId,
        await Promise.all(items.map((item) => materializeQueuedPromptRecord(item))),
      );
    }));
    usePromptQueueStore.setState((state) => {
      const next = new Map(state.queues);
      for (const [tabId, entry] of Object.entries(parsed)) {
        if (next.has(tabId)) continue; // don't clobber an in-memory entry
        const items = hydratedItemsByTab.get(tabId) || [];
        const fd = typeof entry.firstDelaySeconds === 'number'
          ? Math.max(0, Math.min(3600, Math.floor(entry.firstDelaySeconds)))
          : 0;
        const previewId = typeof entry.previewId === 'string' && items.some((item) => item.id === entry.previewId)
          ? entry.previewId
          : null;
        next.set(tabId, {
          items,
          autoRun: !!entry.autoRun,
          stopAfter: !!entry.stopAfter,
          closeAfter: !!entry.closeAfter,
          firstDelaySeconds: fd,
          firstDelayCountdownAt: null, // never restore an in-flight countdown across restart
          postPromptEnabled: !!entry.postPromptEnabled,
          postPromptText: typeof entry.postPromptText === 'string' ? entry.postPromptText : '',
          panelCollapsed: !!entry.panelCollapsed,
          firstChipHintActive: false, // UI-only, never restored
          stopBeforeCloseArm: false, // UI-only memory, never restored
          runAfterTabId: typeof entry.runAfterTabId === 'string' ? entry.runAfterTabId : null,
          previewId,
        });
      }
      return { queues: next };
    });
    hasHydratedPromptQueueStore = true;
    scheduleSave(usePromptQueueStore.getState().queues);
  } catch (e) {
    // Surface the real message — an Error serializes to `{}` through the
    // renderer→file log forwarder (JSON.stringify drops non-enumerable props),
    // which once hid this exact bug for days.
    console.warn('[PromptQueue] hydrate failed:', e instanceof Error ? e.message : String(e));
  }
}
