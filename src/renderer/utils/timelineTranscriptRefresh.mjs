import { historyEntryHasExactIdentity } from './historyPromptPresentation.mjs';
import { resolveHistoryPromptHandoffSemanticTags } from './historyOrchestrationPromptPresentation.mjs';
import { getTerminalMcpTag, isServicePromptEntry, promptOriginTagForSource } from '../../shared/prompt-origin.mjs';

const TIMELINE_SENT_HANDOFF_PREVIEW_MAX_CHARS = 2048;

export function historyNavigationIdentityForTimelineEntry(entry) {
  const sourceIdentity = String(entry?.sourceIdentity || '').trim();
  if ((entry?.isSentHandoffProjection === true || entry?.isLiveUserProjection === true || entry?.isLiveCompactProjection === true)
    && sourceIdentity) return sourceIdentity;
  return String(entry?.uuid || '').trim();
}

/**
 * Keeps one trailing transcript refresh until both the turn and the Timeline
 * surface are ready. An invalidation is never consumed merely because its
 * surface is currently hidden.
 */
export function planTimelineTranscriptRefresh({
  pending = false,
  invalidation = false,
  isTurnBusy = false,
  documentVisible = true,
  surfaceVisible = true,
} = {}) {
  const nextPending = pending || invalidation;
  const refresh = nextPending
    && !isTurnBusy
    && documentVisible
    && surfaceVisible;
  return {
    pending: refresh ? false : nextPending,
    refresh,
  };
}

function timelineSentHandoffPreview(value) {
  const text = String(value || '').trim();
  if (text.length <= TIMELINE_SENT_HANDOFF_PREVIEW_MAX_CHARS) return text;
  return text.slice(0, TIMELINE_SENT_HANDOFF_PREVIEW_MAX_CHARS).trimEnd() + '\n…';
}

function timelineEntryMatchesSentHandoff(entry, handoffEntry) {
  const candidateIdentities = [
    handoffEntry?.uuid,
    handoffEntry?.sourceIdentity,
    ...(Array.isArray(handoffEntry?.sourceIdentityAliases)
      ? handoffEntry.sourceIdentityAliases
      : []),
  ].map((value) => String(value || '').trim()).filter(Boolean);
  return candidateIdentities.some((identity) => (
    historyEntryHasExactIdentity(entry, identity)
  ));
}

/**
 * A confirmed History send already owns an exact durable user record even
 * while Timeline's expensive transcript refresh remains deferred by a busy
 * turn. Project only that one addressable point; never infer it from text or
 * timestamps and never project queue/provider acceptance without audit proof.
 */
export function projectTimelineSentHandoff(handoff, {
  toolType,
  sessionId,
} = {}) {
  if (!handoff || handoff.queueStatus !== 'sent') return null;
  if (handoff.toolType !== toolType) return null;
  const proof = handoff.auditProof;
  if (!proof || typeof proof !== 'object') return null;
  const exactSessionId = String(proof.sessionId || '').trim();
  const currentSessionId = String(sessionId || '').trim();
  if (!exactSessionId || !currentSessionId || exactSessionId !== currentSessionId) return null;

  // Timeline actions address the canonical row by UUID. Source identity is
  // retained for response_item → event_msg alias reconciliation, but it is not
  // converted into a made-up UUID when an older receipt lacks that address.
  const entryUuid = String(proof.entryUuid || '').trim();
  if (!entryUuid) return null;
  const sourceIdentity = String(proof.sourceIdentity || '').trim();
  const submittedAt = Number(handoff.submittedAt);
  const timestamp = String(proof.auditTimestamp || '').trim()
    || new Date(Number.isFinite(submittedAt) ? submittedAt : Date.now()).toISOString();
  const promptOriginTag = promptOriginTagForSource(handoff.source);
  const semanticTags = resolveHistoryPromptHandoffSemanticTags(handoff) || (promptOriginTag ? [promptOriginTag] : []);
  const promptChipLabels = [...new Set((Array.isArray(handoff.promptChips) ? handoff.promptChips : [])
    .filter((chip) => chip?.kind === 'prompt')
    .map((chip) => String(chip?.label || 'PROMPT').trim())
    .filter(Boolean))];

  return {
    uuid: entryUuid,
    type: 'user',
    timestamp,
    content: timelineSentHandoffPreview(handoff.text),
    sessionId: exactSessionId,
    hasImage: Array.isArray(handoff.imagePaths) && handoff.imagePaths.length > 0,
    hasPromptChip: promptChipLabels.length > 0,
    ...(promptChipLabels.length > 0 ? { promptChipLabels } : {}),
    handoffId: String(handoff.handoffId || ''),
    isSentHandoffProjection: true,
    ...(sourceIdentity ? { sourceIdentity } : {}),
    ...(semanticTags.length > 0 ? { semanticTags } : {}),
  };
}

export function projectTimelineSentHandoffs(handoffs, owner = {}) {
  if (!Array.isArray(handoffs)) return [];
  return handoffs
    .map((handoff) => projectTimelineSentHandoff(handoff, owner))
    .filter(Boolean);
}

function timelineLiveUserText(message) {
  const content = Array.isArray(message?.message?.content)
    ? message.message.content
    : [];
  return content.map((item) => {
    if (typeof item === 'string') return item;
    if (typeof item?.text === 'string') return item.text;
    return '';
  }).join('').trim();
}

/**
 * Manual PTY Enter has no History handoff receipt, but main still publishes
 * the exact canonical rollout user carrier. Keep that addressable user point
 * visible while the heavyweight Timeline snapshot is deferred by a busy turn.
 */
export function projectTimelineLiveUserMessage(detail, {
  toolType,
  sessionId,
} = {}) {
  if (!detail || detail.toolType !== toolType) return null;
  const exactSessionId = String(detail.sessionId || '').trim();
  const currentSessionId = String(sessionId || '').trim();
  if (!exactSessionId || exactSessionId !== currentSessionId) return null;
  const message = detail.message;
  if (!message || message.type !== 'user') return null;
  // Codex emits the current AGENTS.md contract as a role=user carrier before
  // the real prompt. History keeps that context visible as a chip, but it is
  // not a user-authored iteration and must never become a Timeline target.
  if (message.serviceCarrier === 'project-instructions'
    || message.serviceCarrier === 'turn-aborted'
    || message.serviceCarrier === 'local-setting') return null;
  const uuid = String(message.uuid || '').trim();
  if (!uuid) return null;
  const sourceIdentity = String(message.sourceIdentity || '').trim();
  const timestamp = String(detail.timestamp || '').trim();
  if (!timestamp || !Number.isFinite(Date.parse(timestamp))) return null;
  const content = timelineLiveUserText(message);
  const imagePaths = Array.isArray(message.imagePaths) ? message.imagePaths : [];
  if (!content && imagePaths.length === 0) return null;
  const sourceIdentityAliases = Array.isArray(message.sourceIdentityAliases)
    ? message.sourceIdentityAliases.map(String).filter(Boolean)
    : [];
  const liveIdentity = sourceIdentity || uuid;
  return {
    uuid,
    type: 'user',
    timestamp,
    content: timelineSentHandoffPreview(content),
    sessionId: exactSessionId,
    hasImage: imagePaths.length > 0,
    handoffId: 'live-user:' + liveIdentity,
    // This is an exact addressable point, but its text is intentionally
    // bounded. Keep expensive AI-derived actions disabled until the complete
    // durable Timeline row adopts it after task_complete.
    isSentHandoffProjection: true,
    isLiveUserProjection: true,
    ...(sourceIdentity ? { sourceIdentity } : {}),
    ...(sourceIdentityAliases.length > 0 ? { sourceIdentityAliases } : {}),
  };
}

/** The same exact compact envelope already used by History, without its body. */
export function projectTimelineLiveCompactEntry(detail, { toolType, sessionId } = {}) {
  if (toolType !== 'codex' || detail?.toolType !== toolType
    || detail?.type !== 'history_entry' || !sessionId || detail.sessionId !== sessionId) return null;
  const entry = detail.entry;
  if (entry?.role !== 'compact' || entry.sessionId !== sessionId) return null;
  const uuid = String(entry.uuid || '').trim();
  const sourceIdentity = String(entry.sourceIdentity || '').trim();
  const timestamp = String(entry.timestamp || detail.timestamp || '').trim();
  if (!uuid || !sourceIdentity || !Number.isFinite(Date.parse(timestamp))) return null;
  return {
    uuid, sourceIdentity, sessionId, timestamp,
    type: 'compact', content: 'Conversation compacted', compactEncrypted: true,
    ...(Number.isFinite(entry.postTokens) && entry.postTokens > 0 ? { postTokens: entry.postTokens } : {}),
    handoffId: 'live-compact:' + sourceIdentity,
    isSentHandoffProjection: true,
    isLiveCompactProjection: true,
  };
}

/** Keep captured SENT points after History consumes its local card. */
export function upsertTimelineSentHandoffEntries(current, incoming) {
  const next = Array.isArray(current) ? [...current] : [];
  for (const candidate of Array.isArray(incoming) ? incoming : []) {
    if (!candidate?.handoffId) continue;
    let semanticTags = candidate.semanticTags;
    for (let index = next.length - 1; index >= 0; index -= 1) {
      // The live carrier can arrive after its audited handoff. Retain its
      // proven origin when replacing the same exact point, never by text.
      if (!semanticTags?.length && next[index]?.semanticTags?.length
        && timelineEntryMatchesSentHandoff(next[index], candidate)) {
        semanticTags = next[index].semanticTags;
      }
      if (next[index]?.handoffId === candidate.handoffId
        || timelineEntryMatchesSentHandoff(next[index], candidate)) {
        next.splice(index, 1);
      }
    }
    next.push(semanticTags?.length && semanticTags !== candidate.semanticTags
      ? { ...candidate, semanticTags }
      : candidate);
  }
  next.sort((left, right) => {
    const timeDelta = Date.parse(left?.timestamp || '') - Date.parse(right?.timestamp || '');
    if (Number.isFinite(timeDelta) && timeDelta !== 0) return timeDelta;
    return String(left?.handoffId || '').localeCompare(String(right?.handoffId || ''));
  });
  return next;
}

export function upsertTimelineLiveUserEntries(current, incoming) {
  return upsertTimelineSentHandoffEntries(current, incoming);
}

export function retainUnmaterializedTimelineSentHandoffs(canonicalEntries, handoffEntries) {
  const canonical = Array.isArray(canonicalEntries) ? canonicalEntries : [];
  const alive = upsertTimelineSentHandoffEntries([], handoffEntries)
    .filter((handoffEntry) => !canonical.some((entry) => (
      timelineEntryMatchesSentHandoff(entry, handoffEntry)
    )));
  // Опознание по идентификатору снимает обещание, когда запись ДОШЛА. Второй
  // исход — она с ветки ушла и не дойдёт никогда; см. функцию выше.
  return retireDetachedTimelineSentHandoffs(canonical, alive);
}

export function retainUnmaterializedTimelineLiveUserEntries(canonicalEntries, liveEntries) {
  return retainUnmaterializedTimelineSentHandoffs(canonicalEntries, liveEntries);
}

/**
 * Сколько ходов разговор должен уйти вперёд, чтобы точку «отправлено» считать
 * потерянной. ОДИН более поздний запрос — это ещё гонка: запись этой отправки
 * могла просто не успеть попасть в перечитанную расшифровку, и убрать точку
 * значило бы соврать про доставку. Два хода — разговор демонстративно ушёл
 * дальше без неё.
 */
const TIMELINE_SENT_HANDOFF_ABANDON_PROMPTS = 2;

/**
 * Точка «отправлено» — это ОБЕЩАНИЕ: запись доставлена и появится в ветке, как
 * только дойдут руки перечитать расшифровку. Обычно обещание снимается
 * опознанием по идентификатору (выше). Но есть исход, когда опознавать нечего
 * никогда: запись ушла с активной ветки — её увёл rewind, компакт или правка
 * истории. Тогда точка остаётся в ленте навсегда и указывает на запись, которой
 * в этом разговоре больше нет: любое действие над ней молча не находит цель,
 * потому что все действия адресуют запись по идентификатору внутри ветки.
 *
 * Признак структурный, а не по часам: разговор ушёл вперёд на столько-то
 * запросов человека, а точки среди них нет. Ожидающая отправка так выглядеть не
 * может — после неё на ветке ещё нечему появиться.
 *
 * Худший исход этого правила — убрать точку-дубль, когда запись на ветке есть, а
 * опознание по идентификатору не сработало: содержимое в этом случае и так
 * видно в самой ветке. Худший исход БЕЗ правила — вечная точка, по которой
 * ничего нельзя сделать.
 */
export function retireDetachedTimelineSentHandoffs(canonicalEntries, handoffEntries) {
  const canonical = Array.isArray(canonicalEntries) ? canonicalEntries : [];
  const handoffs = Array.isArray(handoffEntries) ? handoffEntries : [];
  if (canonical.length === 0 || handoffs.length === 0) return handoffs;

  const promptTimes = [];
  for (const entry of canonical) {
    if (entry?.type !== 'user') continue;
    if (isServicePromptEntry(entry)) continue;
    const at = Date.parse(entry?.timestamp || '');
    if (Number.isFinite(at)) promptTimes.push(at);
  }
  if (promptTimes.length < TIMELINE_SENT_HANDOFF_ABANDON_PROMPTS) return handoffs;

  return handoffs.filter((entry) => {
    const at = Date.parse(entry?.timestamp || '');
    // Без разбираемого времени не судим: молчаливо убрать доставленную точку
    // хуже, чем подержать лишнюю.
    if (!Number.isFinite(at)) return true;
    let newer = 0;
    for (const promptAt of promptTimes) {
      if (promptAt > at) newer += 1;
      if (newer >= TIMELINE_SENT_HANDOFF_ABANDON_PROMPTS) return false;
    }
    return true;
  });
}

/**
 * Canonical transcript rows always win. UUID/source aliases remove the light
 * point in the same render, so the later durable refresh cannot create a
 * duplicate even when a response_item was promoted to event_msg.
 */
export function mergeTimelineEntriesWithSentHandoffs(
  canonicalEntries,
  handoffEntries,
  liveUserEntries = [],
) {
  const source = Array.isArray(canonicalEntries) ? canonicalEntries : [];
  const orchestrationHandoffs = (Array.isArray(handoffEntries) ? handoffEntries : [])
    .filter((handoff) => handoff?.isSentHandoffProjection === true && getTerminalMcpTag(handoff));
  const canonical = orchestrationHandoffs.length === 0 ? source : source.map((entry) => {
    if (getTerminalMcpTag(entry)) return entry;
    const matches = orchestrationHandoffs.filter((handoff) => (
      timelineEntryMatchesSentHandoff(entry, handoff)
    ));
    if (matches.length !== 1) return entry;
    const tag = getTerminalMcpTag(matches[0]);
    return { ...entry, semanticTags: [...(entry.semanticTags || []), tag] };
  });
  const retainedHandoffs = retainUnmaterializedTimelineSentHandoffs(canonical, handoffEntries);
  const retainedLiveUsers = retainUnmaterializedTimelineLiveUserEntries(canonical, liveUserEntries);
  const projected = upsertTimelineSentHandoffEntries(retainedHandoffs, retainedLiveUsers);
  return projected.length > 0 ? [...canonical, ...projected] : canonical;
}

/**
 * A primary History surface and its Timeline are siblings. During an owner
 * switch Timeline may hydrate its cached rail only after History proves that
 * the same tab/session/tool has reached a painted presentation boundary.
 * Matching every identity field prevents a late event from the previous tab
 * from releasing the next owner's heavier render.
 */
export function matchesHistorySurfacePresented({
  detail,
  tabId,
  sessionId,
  toolType,
  ownerKey,
} = {}) {
  if (!detail || typeof detail !== 'object') return false;
  return detail.tabId === tabId
    && (detail.sessionId || null) === (sessionId || null)
    && detail.toolType === toolType
    && detail.ownerKey === ownerKey;
}

/**
 * Replayable record of the LAST presented History surface per tab.
 *
 * The presentation proof is a one-shot window event, and Timeline releases
 * its gate by listening for it. A Timeline instance that MOUNTS after the
 * proof already fired (HMR remount, deferred owner handoff, any future
 * remount) subscribes to a bus that will stay silent — History is happily
 * on screen and has nothing new to announce — so the gate never opened, the
 * initial load never ran, and the panel expanded to a permanent
 * "Loading timeline…" with zero rows (live 05.08: WAVE_DONE entries=0 while
 * History showed the full session). Subscribe-after-publish needs a replay,
 * so the publisher also records the latest proof here and a fresh subscriber
 * checks it synchronously before waiting.
 *
 * Keyed by tabId only: a new presentation for the same tab overwrites the
 * previous one, so a stale (session/tool changed) record simply fails the
 * identity match and the subscriber falls back to waiting for the live event.
 */
const lastPresentedHistorySurfaceByTab = new Map();

export function recordHistorySurfacePresented(detail) {
  if (!detail || typeof detail !== 'object' || !detail.tabId) return;
  lastPresentedHistorySurfaceByTab.set(detail.tabId, {
    tabId: detail.tabId,
    sessionId: detail.sessionId || null,
    toolType: detail.toolType,
    ownerKey: detail.ownerKey || null,
    generation: Number(detail.generation) || 0,
    presentationVisit: Number(detail.presentationVisit) || 0,
    proof: detail.proof || 'unknown',
  });
}

export function readPresentedHistorySurface({ tabId, sessionId, toolType, ownerKey } = {}) {
  const detail = lastPresentedHistorySurfaceByTab.get(tabId);
  if (!detail) return null;
  return matchesHistorySurfacePresented({ detail, tabId, sessionId, toolType, ownerKey })
    ? detail
    : null;
}

export function __resetPresentedHistorySurfacesForTest() {
  lastPresentedHistorySurfaceByTab.clear();
}
