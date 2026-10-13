/**
 * History display-units projection — series collapsing.
 *
 * The LAST projection step before Virtuoso (after live merge and rewind
 * preview): `(entries, expandedKeys) → display units`. Approved contract with
 * the functional-History owner (docs/tmp/визуал-history.md::Вердикт):
 *
 *  - Pure and memoizable; groups are презентация — never written to any
 *    durable cache or snapshot.
 *  - Group key (first tool_use id or exact first Research row UUID) is INTERNAL. Everything that
 *    crosses the projection boundary — hydration center, reading anchor,
 *    Timeline jump, search — speaks server-row uuids only.
 *  - Grouping reads ONLY fields that exist on both full rows and row-window
 *    stubs (family/bashWord/mcpServer/mcpMethod/messageId/hasContent/
 *    actionSummary / structural semanticTags) so grouping(any hydration window) === grouping(full).
 *  - Kill switch: `enabled: false` → identity projection.
 *
 * What groups: consecutive assistant work actions form a broad noise/edit
 * block even when their concrete types change; an uninterrupted homogeneous
 * signature may additionally become the inner series. Caption text and
 * structurally owned reasoning ride with the broad block. User rows,
 * standalone replies and interactive questions remain hard boundaries.
 *
 * Corpus grounding (docs/tmp/визуал-history-research-*.md): threshold 2 is
 * the user's pick; families are mandatory because 76% of Claude Bash / 65%
 * of Codex shell are reads and searches.
 */

import {
  HISTORY_CAPTION_MAX_CHARS,
  historyActionHeadline,
  historyActionPresentationMeta,
  historyDisplayPath,
} from '../../shared/history-action-grammar.mjs';
import textPhases from '../../shared/history-text-phase.cjs';
import { resolveHistoryOrchestrationPromptPresentation } from './historyOrchestrationPromptPresentation.mjs';
import { resolveHistoryGroupCaption } from './historyGroupCaption.mjs';

/** Stub-safe provenance only: never read/parse a response body just to group
 * it. Pending application input and native question replies stay reachable. */
export function isHistoryResearchReplyEntry(entry) {
  if (!isObject(entry) || !['user', 'queued'].includes(entry.role) || entry.questionReplyProof) return false;
  if (entry.queueStatus !== undefined && entry.queueStatus !== 'sent') return false;
  if ((entry.isLocal === true || entry.handoffId) && entry.queueStatus !== 'sent') return false;
  const service = resolveHistoryOrchestrationPromptPresentation(entry);
  return service?.runKind === 'external-research' && ['completion', 'failure'].includes(service.phase);
}

export function historyResearchGroupKey(entry) {
  // Exact SENT audit UUID is already the eventual canonical row's address.
  // Run ID alone is not a row identity: repeated runs must not share toggles.
  const identity = entry?.auditEntryUuid || entry?.auditProof?.entryUuid || entry?.uuid;
  return typeof identity === 'string' && identity ? 'research-grp:' + identity : null;
}

/** Short digest subject for a hydrated action — mirrors main's stubActionSubject. */
function hydratedSubject(raw, presentation = null) {
  try {
    const subject = String(presentation?.operationLabel ?? (historyActionHeadline({
        toolName: raw.toolName,
        args: raw.args,
        family: raw.family,
        bashWord: raw.bashWord,
        bashDetail: raw.bashDetail,
        mcpServer: raw.mcpServer,
        mcpMethod: raw.mcpMethod,
      }).subject || ''));
    return subject ? historyDisplayPath(subject) : '';
  } catch {
    return '';
  }
}

/**
 * Two collapsing CLASSES, not one list of families.
 *
 * `noise` — the work log: reads, searches, git/shell, MCP/web, plan updates,
 * agents, waits and generic tool calls. A run of them is one broad block no
 * matter how the types interleave; every type remains named in the header as
 * its own `×N` fragment. AskUser/Question deliberately stays outside — hiding
 * a live request for user input would break the interaction, not compress it.
 *
 * `edit` — every file mutation (Edit / Write / MultiEdit / Update, one verb).
 * Edits collapse only WITH EACH OTHER and never merge into the noise class:
 * which files changed and by how much is the one thing the user scans.
 *
 * Question/AskUser and non-action transcript rows keep their own row.
 */
const CLASS_BY_FAMILY = new Map([
  ['read', 'noise'], ['search', 'noise'], ['git', 'noise'],
  ['run', 'noise'], ['mcp', 'noise'], ['web', 'noise'],
  ['toolsearch', 'noise'], ['plan', 'noise'], ['task', 'noise'],
  ['wait', 'noise'], ['other', 'noise'],
  ['edit', 'edit'],
]);

const GROUPABLE_FAMILIES = new Set(CLASS_BY_FAMILY.keys());

const DEFAULT_THRESHOLD = 2;

/**
 * How many noise CALLS an edit block may swallow between two of its edits
 * (re-read, grep, test run). Corpus: 1–3-call gaps are 38% of all gaps and
 * are the edit cycle itself; 4+ (13%) is a real detour that must stay its
 * own group. Cheap to tune.
 */
const EDIT_GAP_MAX_NOISE = 3;

const isObject = (value) => value !== null && typeof value === 'object';

// One entry is inspected many times while the two grouping levels scan it
// (class, inner signature, captions, facts, counts). Rows are immutable by the
// History contract — every live/durable change replaces the entry object — so
// reference-keyed facts are safe across toggles and disappear with the row.
const actionFactsByEntry = new WeakMap();

/**
 * A collapsed container unit — hides N entries behind one row. One kind
 * today; kept as the single check every walker uses (hydration, addressing,
 * measurement), so a future container kind cannot be forgotten in one of
 * them. (A `slash-group` existed briefly and was rejected live: the wrapper
 * hid WHICH settings changed — the only information those rows carry.)
 */
export const isGroupUnit = (unit) => unit?.kind === 'group';

/**
 * The grouping-visible shape of one entry's actions: works on both hydrated
 * rows (actions[].rawTool) and stubs (actionSummary[]).
 */
export function entryActionFacts(entry) {
  if (!isObject(entry)) return [];
  const cached = actionFactsByEntry.get(entry);
  if (cached) return cached;
  if (Array.isArray(entry.actionSummary)) {
    const facts = entry.actionSummary.map((item) => {
      // Old cached stubs may predate the presentation fields. Family/server
      // are still enough to reconstruct the grouping signature, so hydration
      // never changes a broad group into a homogeneous one mid-scroll.
      const fallback = historyActionPresentationMeta({
        toolName: item?.toolName,
        family: item?.family,
        bashWord: item?.bashWord,
        bashDetail: item?.bashDetail,
        mcpServer: item?.mcpServer,
        mcpMethod: item?.mcpMethod,
        args: {},
      });
      return {
        toolUseId: item?.toolUseId ? String(item.toolUseId) : '',
        toolName: item?.toolName ? String(item.toolName) : '',
        family: item?.family ? String(item.family) : '',
        bashWord: item?.bashWord ? String(item.bashWord) : '',
        bashDetail: item?.bashDetail ? String(item.bashDetail) : '',
        mcpServer: item?.mcpServer ? String(item.mcpServer) : '',
        mcpMethod: item?.mcpMethod ? String(item.mcpMethod) : '',
        subject: item?.subject ? String(item.subject) : '',
        aggregateKey: item?.aggregateKey ? String(item.aggregateKey) : fallback.aggregateKey,
        targetKey: item?.targetKey ? String(item.targetKey) : '',
        targetLabel: item?.targetLabel ? String(item.targetLabel) : '',
        operationLabel: item?.operationLabel ? String(item.operationLabel) : '',
        docsKind: item?.docsKind ? String(item.docsKind) : fallback.docsKind,
        isError: item?.isError === true,
      };
    });
    actionFactsByEntry.set(entry, facts);
    return facts;
  }
  const actions = Array.isArray(entry.actions) ? entry.actions : [];
  const facts = [];
  for (const action of actions) {
    if (!isObject(action)) continue;
    if (action.tool === '__raw__' && isObject(action.rawTool)) {
      const raw = action.rawTool;
      const presentation = historyActionPresentationMeta({
        toolName: raw.toolName,
        args: raw.args,
        family: raw.family,
        bashWord: raw.bashWord,
        bashDetail: raw.bashDetail,
        mcpServer: raw.mcpServer,
        mcpMethod: raw.mcpMethod,
      });
      facts.push({
        toolUseId: raw.toolUseId ? String(raw.toolUseId) : '',
        toolName: raw.toolName ? String(raw.toolName) : '',
        family: raw.family ? String(raw.family) : '',
        bashWord: raw.bashWord ? String(raw.bashWord) : '',
        bashDetail: raw.bashDetail ? String(raw.bashDetail) : '',
        mcpServer: raw.mcpServer ? String(raw.mcpServer) : '',
        mcpMethod: raw.mcpMethod ? String(raw.mcpMethod) : '',
        // Hydrated rows carry args, so the subject is derived here with the
        // same grammar main stamps into stubs — the digest reads identically
        // no matter which side of hydration the row is on.
        subject: hydratedSubject(raw, presentation),
        aggregateKey: presentation.aggregateKey,
        targetKey: presentation.targetKey,
        targetLabel: presentation.targetLabel,
        operationLabel: presentation.operationLabel,
        docsKind: presentation.docsKind,
        isError: raw.isError === true,
        // A call that is genuinely awaiting its result RIGHT NOW: no result,
        // no dehydrated payload ref, not a handed-off background process.
        // This — not "the turn is busy" — is what earns a group its spinner:
        // the old rule (busy turn + last display unit) turned the spinner
        // OFF the moment the group was expanded (the header stopped being
        // the last unit), which read as the toggle changing reality.
        // Stub rows can't be the live tail (alwaysHydrateTail) — false there.
        inFlight: raw.isError !== true
          && raw.result == null
          && raw.resultRef == null
          && raw.backgroundStatus == null,
      });
    } else if (action.tool === 'Task') {
      facts.push({
        toolUseId: action.toolUseId ? String(action.toolUseId) : '',
        toolName: 'Task',
        family: 'task',
        bashWord: '', mcpServer: '', mcpMethod: '', isError: false,
      });
    }
  }
  actionFactsByEntry.set(entry, facts);
  return facts;
}

/**
 * A row whose whole content is the model's reasoning — no text, no calls.
 *
 * Reasoning is NOT an action and not a step of its own: measured over a
 * production Claude session, 362 of 375 reasoning blocks belong to the SAME
 * model response as the calls beside them (Claude merely writes them as
 * separate records), 58% sit directly before their own response's calls, and
 * runs of «call → think → call → think» happen 136 times with up to 18
 * reasoning rows in ONE run. Treating each as a standalone event cut those
 * runs into a ladder of alternating groups and lone rows — exactly the wall
 * this feature removes.
 *
 * So a reasoning row rides along inside the series (see `isSeriesPassenger`)
 * without inflating any TOOL multiplier: two reads stay `Read ×2`. The broad
 * header may additionally end in the purple thinking glyph plus `×3`,
 * counting visible reasoning rows without pretending they were tool calls.
 */
export function isThinkingOnlyRow(entry) {
  if (!isObject(entry) || entry.role !== 'assistant') return false;
  if (!entry.thinking && entry.hasThinking !== true) return false;
  if (entryHasText(entry)) return false;
  return entryActionFacts(entry).length === 0;
}

/** Reasoning seconds carried by one row (0 when absent/unknown). */
const thinkingSecondsOf = (entry) => {
  const value = Number(entry?.thinkingSeconds);
  return Number.isFinite(value) && value > 0 ? value : 0;
};

/** Total reasoning time across a group's members — one figure, not a list. */
export function groupThinkingSeconds(entries) {
  let total = 0;
  for (const entry of (Array.isArray(entries) ? entries : [])) {
    total += thinkingSecondsOf(entry);
  }
  return total;
}

const isStandaloneAnswer = (entry) => textPhases.isStandaloneHistoryAnswerPhase(entry?.textPhase);

const entryHasText = (entry) => {
  if (entry?.hasContent === true) return true;
  return typeof entry?.content === 'string' && entry.content.trim().length > 0;
};

/**
 * Caption vs standalone reply, both providers:
 *  - actions in the same entry → the text IS the caption of those calls;
 *  - Codex: `textPhase === 'commentary'` and short → caption of the NEXT
 *    entry's calls (positional linkage);
 *  - Claude: text-only entry sharing `messageId` with the NEXT entry → same
 *    model response as the calls → caption (structural linkage);
 *  - everything else with text → standalone reply (series boundary).
 */
const contentLength = (entry) => {
  if (typeof entry?.content === 'string') return entry.content.trim().length;
  // Main and the prepared SSD cache preserve this structural fact without
  // the text. Hydrating/dehydrating a caption must not split its group and
  // move the reading position of unrelated rows further down the list.
  if (Number.isSafeInteger(entry?.contentLength) && entry.contentLength >= 0) return entry.contentLength;
  // Legacy/invalid metadata is not proof of a short caption. Updated reader
  // fingerprints rebuild old prepared stubs through the normal cache path.
  return entry?.hasContent === true ? Number.POSITIVE_INFINITY : 0;
};

export function isCaptionForNext(entry, nextEntry) {
  if (!isObject(entry) || entry.role !== 'assistant') return false;
  if (!entryHasText(entry)) return false;
  if (entryActionFacts(entry).length > 0) return false; // caption of own calls
  if (contentLength(entry) > HISTORY_CAPTION_MAX_CHARS) return false;
  if (!isObject(nextEntry) || nextEntry.role !== 'assistant') return false;
  if (entryActionFacts(nextEntry).length === 0) return false;
  // Stable answer fragments stay readable independently even when tools follow.
  if (isStandaloneAnswer(entry)) return false;
  // Everything else: a short text immediately before a call IS that call's
  // headline. Earlier this also demanded structural proof (shared messageId /
  // commentary phase), and rows without it — Claude splits text and tool_use
  // into separate messages routinely — fell out as bare paragraphs with no
  // card indent (user's «оторванный текст» screenshot). Position plus length
  // is the honest signal; the proofs remain as fast-path confirmations.
  return true;
}

/**
 * Detail under a collapsed group answers two related questions with one rule:
 * while the tail group grows it shows the newest meaningful status, and once
 * an outer boundary appears that final status stays frozen with the completed
 * unit. The append projector rebuilds only the open tail and reuses closed
 * prefix units, so no separate mutable "live caption" state is needed.
 */
export function historyGroupCaptionEntries(entries, fallback = null) {
  const captions = [], seen = new Set();
  const add = entry => {
    const identity = entry?.uuid || entry;
    if (seen.has(identity)) return;
    seen.add(identity); captions.push(entry);
  };
  if (fallback) add(fallback);
  for (const entry of (Array.isArray(entries) ? entries : [])) {
    if (!isObject(entry) || entry.role !== 'assistant') continue;
    if (!entryHasText(entry) || isStandaloneAnswer(entry)) continue;
    if (contentLength(entry) > HISTORY_CAPTION_MAX_CHARS) continue;
    add(entry);
  }
  return captions;
}

/**
 * The single family of an entry's groupable actions, or null when the entry
 * does not participate in series grouping (an interactive question,
 * text-only row, or non-assistant row).
 */
/**
 * The collapsing class of one row: 'noise', 'edit', or null (never collapses).
 *
 * A row that mixes classes takes the class of its EDITS. Codex writes one
 * assistant record per exec call, and its normal working shape is «run a
 * script, apply the patch it built» — one record holding a shell run AND the
 * file changes. Refusing to collapse those (the old rule: any mix → null)
 * meant a session that edited 200 files never grouped a single one of them:
 * on the user's screenshot every second row was a lone «Bash node» + «Edit»
 * pair standing between two collapsed blocks, which is the exact wall this
 * feature exists to remove.
 *
 * The class is the edits' because an edit is never allowed to hide inside
 * noise: this row changed files, so it belongs to the edit block, and the
 * shell call that produced the change rides along inside it — the same
 * absorption rule that already lets an edit block swallow ≤3 noise calls
 * BETWEEN two edits, applied to a call sitting in the same record.
 *
 * A mix with no edits at all (never seen in the corpus, but structurally
 * possible) stays uncollapsed: without an edit there is no dominant class to
 * pick and merging would be a guess.
 */
export function entrySeriesFamily(entry) {
  if (!isObject(entry) || entry.role !== 'assistant') return null;
  const facts = entryActionFacts(entry);
  if (facts.length === 0) return null;
  let key = null;
  let mixed = false;
  for (const fact of facts) {
    const cls = CLASS_BY_FAMILY.get(fact.family);
    if (!cls) return null;
    if (key === null) key = cls;
    else if (key !== cls) mixed = true;
    if (cls === 'edit') key = 'edit';
  }
  if (mixed && key !== 'edit') return null;
  return key;
}

/** One homogeneous action signature for the inner presentation level.
 * Outer groups intentionally merge all noise; inner groups are narrower:
 * family + docs scope, and MCP additionally per server. */
export function entryAggregateKey(entry) {
  if (!isObject(entry) || entry.role !== 'assistant') return null;
  // A physical record that carries reasoning remains a broad-work member even
  // if the provider colocated a tool call in the same record. Otherwise the
  // inner file aggregate could still display `thinking` as its child through
  // a composite row — the same hierarchy lie as swallowing a separate row.
  if (entry.thinking || entry.hasThinking === true) return null;
  const facts = entryActionFacts(entry);
  if (facts.length === 0) return null;
  let key = null;
  for (const fact of facts) {
    if (!GROUPABLE_FAMILIES.has(fact.family)) return null;
    const candidate = fact.aggregateKey || `${fact.family}:regular`;
    if (key === null) key = candidate;
    else if (candidate !== key) return null;
  }
  return key;
}

function messageMembershipMap(list, valueOf) {
  const map = new Map();
  for (const entry of list) {
    const messageId = typeof entry?.messageId === 'string' ? entry.messageId : '';
    if (!messageId) continue;
    const value = valueOf(entry);
    if (!value) continue;
    let values = map.get(messageId);
    if (!values) { values = new Set(); map.set(messageId, values); }
    values.add(value);
  }
  return map;
}

function structuralPassengerMatch(entry, membership, expected) {
  const messageId = typeof entry?.messageId === 'string' ? entry.messageId : '';
  if (!messageId) return { known: false, matches: false };
  const values = membership.get(messageId);
  if (!values || values.size === 0) return { known: false, matches: false };
  return { known: true, matches: values.has(expected) };
}

/** First action after a reasoning lead/tail, optionally through one caption.
 * Used only as the fallback when Claude gave no structural messageId proof. */
function nextActionValueAfterPassengers(list, from, valueOf) {
  let probe = from;
  while (probe < list.length && isThinkingOnlyRow(list[probe])) probe += 1;
  if (
    probe < list.length - 1
    && isCaptionForNext(list[probe], list[probe + 1])
  ) {
    probe += 1;
  }
  return probe < list.length ? valueOf(list[probe]) : null;
}

function makeInnerGroup(members, facts, expandedKeys) {
  const firstCallId = facts.find((fact) => fact.toolUseId)?.toolUseId
    || members[0]?.rewriteLayoutUuid || members[0]?.uuid || 'unknown';
  const key = 'sub:' + firstCallId;
  const families = new Set(facts.map((fact) => fact.family));
  const docsKinds = new Set(facts.map((fact) => fact.docsKind).filter(Boolean));
  return {
    kind: 'group',
    level: 2,
    key,
    familyKey: families.size === 1 ? (facts[0]?.family || 'run') : 'mixed',
    aggregateKey: facts[0]?.aggregateKey || '',
    docsKind: docsKinds.size === 1 ? Array.from(docsKinds)[0] : '',
    entries: members,
    facts,
    errorCount: facts.reduce((sum, fact) => sum + (fact.isError ? 1 : 0), 0),
    thinkingSeconds: groupThinkingSeconds(members),
    expanded: expandedKeys.has(key),
  };
}

/**
 * Second presentation level for the members of an expanded broad group.
 *
 * A homogeneous aggregate owns an uninterrupted run of ACTIONS only.
 * Thinking, captions and any other row are hard boundaries: `Read → think →
 * Read` is not a two-file series. This is deliberately stricter than broad
 * grouping, where reasoning may still ride inside one work block.
 *
 * The projection stays flat for Virtuoso. An expanded aggregate is its header
 * followed by ordinary collapsed tool-card entries; every row keeps its raw
 * UUID and no passenger can acquire `expandedSubgroup` by position.
 */
export function buildHistoryInnerUnits(entries, options = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const expandedKeys = options.expandedKeys instanceof Set
    ? options.expandedKeys
    : new Set(Array.isArray(options.expandedKeys) ? options.expandedKeys : []);
  const units = [];
  let index = 0;
  while (index < list.length) {
    const signature = entryAggregateKey(list[index]);
    if (!signature) {
      units.push({ kind: 'entry', entry: list[index] });
      index += 1;
      continue;
    }

    const actionMembers = [];
    let cursor = index;
    while (cursor < list.length) {
      const candidate = list[cursor];
      const candidateKey = entryAggregateKey(candidate);
      if (candidateKey === signature) {
        actionMembers.push(candidate);
        cursor += 1;
        continue;
      }
      break;
    }
    const facts = actionMembers.flatMap((member) => entryActionFacts(member));
    if (facts.length < 2) {
      for (const member of actionMembers) units.push({ kind: 'entry', entry: member });
      index = Math.max(cursor, index + 1);
      continue;
    }
    const group = makeInnerGroup(actionMembers, facts, expandedKeys);
    units.push(group);
    if (group.expanded) {
      for (let actionIndex = 0; actionIndex < actionMembers.length; actionIndex += 1) {
        units.push({
          kind: 'entry',
          entry: actionMembers[actionIndex],
          expandedSubgroup: {
            key: group.key,
            familyKey: group.familyKey,
            docsKind: group.docsKind,
            first: actionIndex === 0,
            last: actionIndex === actionMembers.length - 1,
          },
        });
      }
    }
    index = cursor;
  }
  return units;
}

/**
 * Display unit shapes:
 *   { kind: 'entry', entry }                       — passthrough row
 *   { kind: 'group', key, familyKey, entries,
 *     facts, errorCount, captionEntry }            — collapsed series
 *
 * `key` = 'grp:' + first tool_use id, or 'research-grp:' + first exact
 * Research row UUID. A growing series keeps its first member. An expanded
 * group retains its counter header followed by flat entry units; heavy bodies
 * still wait for the CHILD card's own click. `expandedGroup` is rail metadata,
 * not another History or a persisted provider message.
 */
export function buildHistoryDisplayUnits(entries, options = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const enabled = options.enabled !== false;
  const threshold = Math.max(2, Number(options.threshold) || DEFAULT_THRESHOLD);
  const expandedKeys = options.expandedKeys instanceof Set
    ? options.expandedKeys
    : new Set(Array.isArray(options.expandedKeys) ? options.expandedKeys : []);
  if (!enabled) {
    return list.map((entry) => ({ kind: 'entry', entry }));
  }

  const units = [];
  let index = 0;
  // Claude's messageId is structural ownership: thinking/text/tool records of
  // one model response share it. It outranks position. Codex/live rows can
  // lack it, so the old look-ahead remains a conservative fallback.
  const messageFamilies = messageMembershipMap(list, entrySeriesFamily);
  while (index < list.length) {
    const entry = list[index];
    if (isHistoryResearchReplyEntry(entry)) {
      let cursor = index + 1;
      while (cursor < list.length && isHistoryResearchReplyEntry(list[cursor])) cursor++;
      const members = list.slice(index, cursor), key = historyResearchGroupKey(entry);
      if (members.length >= 2 && key) {
        const expanded = expandedKeys.has(key);
        units.push({ kind: 'group', key, level: 1, familyKey: 'research', entries: members,
          facts: [], errorCount: members.filter(member => resolveHistoryOrchestrationPromptPresentation(member)?.phase === 'failure').length,
          captionEntry: null, expanded });
        if (expanded) for (let child = 0; child < members.length; child++) units.push({
          kind: 'entry', entry: members[child], expandedGroup: { key, familyKey: 'research',
            first: child === 0, last: child === members.length - 1 },
        });
      } else for (const member of members) units.push({ kind: 'entry', entry: member });
      index = cursor;
      continue;
    }
    // A slash command stays its own quiet service line, never a group. The
    // collapsed «Изменены настройки ×2» was tried and rejected live: two
    // one-word rows cost nothing, while the wrapper hid WHICH settings
    // changed — the only information those rows carry.
    if (isObject(entry) && entry.role === 'slash') {
      units.push({ kind: 'entry', entry });
      index += 1;
      continue;
    }
    const familyKey = entrySeriesFamily(entry);
    // A caption entry directly before a groupable run joins the run it
    // captions (becomes the group headline).
    let captionEntry = null;
    let runFamily = familyKey;
    if (familyKey === null && isCaptionForNext(entry, list[index + 1])) {
      const nextFamily = entrySeriesFamily(list[index + 1]);
      if (nextFamily !== null) {
        captionEntry = entry;
        runFamily = nextFamily;
      }
    }
    if (familyKey === null && !captionEntry && isThinkingOnlyRow(entry)) {
      const messageId = typeof entry.messageId === 'string' ? entry.messageId : '';
      const structural = messageId ? messageFamilies.get(messageId) : null;
      if (structural?.size === 1) {
        runFamily = Array.from(structural)[0];
      } else if (structural?.has('edit')) {
        // Same dominance rule as a composite row: a response that both
        // inspected and changed files belongs to the edit block.
        runFamily = 'edit';
      } else if (!structural || structural.size === 0) {
        runFamily = nextActionValueAfterPassengers(list, index, entrySeriesFamily);
      }
    }
    if (runFamily === null) {
      units.push({ kind: 'entry', entry });
      index += 1;
      continue;
    }
    // Extend the run: consecutive assistant rows of the same class key.
    // A text-only row inside the run is allowed only as a caption of the
    // row that follows it (same class); otherwise it ends the run.
    //
    // EDIT ABSORPTION (corpus: 3106 gaps between consecutive edits in 8
    // production sessions): 38% of gaps are 1–3 noise calls — re-read the
    // file, grep, run the test — i.e. the edit CYCLE itself, while 4+ is a
    // real detour (13%). So an edit block swallows up to
    // EDIT_GAP_MAX_NOISE noise rows BETWEEN two of its edits; the absorbed
    // rows must be followed by another edit or they are returned to the
    // stream (a noise TAIL after the last edit is not part of the block —
    // prefix/suffix noise groups on its own terms). The reverse never
    // happens: noise runs do not swallow single edits — an edit is always
    // visible.
    const members = [];
    let cursor = index;
    while (cursor < list.length) {
      const candidate = list[cursor];
      const candidateFamily = entrySeriesFamily(candidate);
      if (candidateFamily === runFamily) {
        members.push(candidate);
        cursor += 1;
        continue;
      }
      // Caption of the next same-class row keeps the run going.
      if (
        candidateFamily === null
        && isCaptionForNext(candidate, list[cursor + 1])
        && entrySeriesFamily(list[cursor + 1]) === runFamily
      ) {
        members.push(candidate);
        cursor += 1;
        continue;
      }
      // messageId proof wins: a trailing thought in the SAME Claude response
      // as the preceding Read stays in that block even when no later Read
      // follows. Only rows without structural proof use positional look-ahead.
      if (candidateFamily === null && isThinkingOnlyRow(candidate)) {
        const structural = structuralPassengerMatch(candidate, messageFamilies, runFamily);
        const fallback = !structural.known
          && nextActionValueAfterPassengers(list, cursor, entrySeriesFamily) === runFamily;
        if (structural.matches || fallback) {
          members.push(candidate);
          cursor += 1;
          continue;
        }
      }
      // Edit block: look ahead — a short pocket of noise/caption rows that
      // ends at another edit belongs to the block.
      if (runFamily === 'edit') {
        let probe = cursor;
        let noiseSeen = 0;
        while (probe < list.length) {
          const pocketRow = list[probe];
          const pocketFamily = entrySeriesFamily(pocketRow);
          if (pocketFamily === 'edit') break;
          if (pocketFamily === 'noise') {
            noiseSeen += entryActionFacts(pocketRow).length;
            if (noiseSeen > EDIT_GAP_MAX_NOISE) { probe = -1; break; }
            probe += 1;
            continue;
          }
          if (
            pocketFamily === null
            && isObject(pocketRow) && pocketRow.role === 'assistant'
            && entryActionFacts(pocketRow).length === 0
            && entryHasText(pocketRow)
            && contentLength(pocketRow) <= HISTORY_CAPTION_MAX_CHARS
            && !isStandaloneAnswer(pocketRow)
          ) {
            probe += 1;
            continue;
          }
          probe = -1;
          break;
        }
        if (probe > cursor && probe < list.length && entrySeriesFamily(list[probe]) === 'edit') {
          for (let inner = cursor; inner < probe; inner += 1) members.push(list[inner]);
          cursor = probe;
          continue;
        }
      }
      break;
    }
    const callCount = members.reduce(
      (sum, member) => sum + entryActionFacts(member).length, 0,
    );
    if (callCount < threshold || members.length === 0) {
      // Below threshold: no group, and NO third text state. Text is either a
      // group headline (inside a collapsed block) or an ordinary paragraph —
      // a mini-caption glued onto a single card was a rejected in-between
      // (wrong indents, wrong size, reads as belonging to nothing).
      for (const member of members) units.push({ kind: 'entry', entry: member });
      index = Math.max(cursor, index + 1);
      continue;
    }
    const allMembers = members;
    const facts = allMembers.flatMap((member) => entryActionFacts(member));
    const captions = historyGroupCaptionEntries(allMembers, captionEntry);
    const detailEntry = captions.at(-1) || null;
    const firstCallId = facts.find((fact) => fact.toolUseId)?.toolUseId
      || allMembers[0]?.rewriteLayoutUuid || allMembers[0]?.uuid || String(index);
    const aggregateKeys = new Set(facts.map((fact) => fact.aggregateKey).filter(Boolean));
    // A PURE homogeneous action run is already the user's second-level entity
    // and may live at the root without a redundant generic stack wrapper.
    // Once reasoning/caption rows are present it is a broad WORK block: keep
    // that outer owner so those rows never masquerade as children of `Read…`.
    const pureHomogeneousRun = aggregateKeys.size === 1
      && allMembers.every((member) => entryAggregateKey(member) !== null);
    if (pureHomogeneousRun) {
      const direct = makeInnerGroup(allMembers, facts, expandedKeys);
      direct.captionEntry = detailEntry;
      direct.captionEntries = captions;
      units.push(direct);
      if (direct.expanded) {
        for (let memberIndex = 0; memberIndex < allMembers.length; memberIndex += 1) {
          units.push({
            kind: 'entry',
            entry: allMembers[memberIndex],
            expandedSubgroup: {
              key: direct.key,
              familyKey: direct.familyKey,
              docsKind: direct.docsKind,
              first: memberIndex === 0,
              last: memberIndex === allMembers.length - 1,
            },
          });
        }
      }
      index = cursor;
      continue;
    }

    const key = 'grp:' + firstCallId;
    const outerDocsKinds = new Set(facts.map((fact) => fact.docsKind || ''));
    const outerDocsKind = outerDocsKinds.size === 1
      ? Array.from(outerDocsKinds)[0]
      : '';
    const groupUnit = {
      kind: 'group',
      level: 1,
      key,
      familyKey: runFamily,
      // The stack glyph inherits a docs colour only when the WHOLE broad
      // block shares that channel. Mixed blocks colour their individual
      // header fragments instead; painting the shared glyph would claim the
      // ordinary calls were documentation work too.
      docsKind: outerDocsKind,
      entries: allMembers,
      captionEntry: detailEntry,
      captionEntries: captions,
      facts,
      errorCount: facts.reduce((sum, fact) => sum + (fact.isError ? 1 : 0), 0),
      // ONE reasoning figure for the whole block, not one per row. «думал 7s,
      // думал 5s, думал 10s» counts thoughts, which nobody reads; the sum
      // answers the question the row actually raises — why three reads took a
      // minute. Zero when the block did no reasoning (header stays silent).
      thinkingSeconds: groupThinkingSeconds(allMembers),
    };
    if (expandedKeys.has(key)) {
      // Expanded: the group HEADER stays (clicking it collapses back —
      // user decision: the verb line must not vanish into a bare button),
      // members follow as their own indented rows under the rail.
      units.push({ ...groupUnit, expanded: true });
      const uniform = new Set(facts.map((fact) => fact.family)).size <= 1;
      const children = buildHistoryInnerUnits(allMembers, { expandedKeys });
      for (let childIndex = 0; childIndex < children.length; childIndex += 1) {
        const child = children[childIndex];
        const parentGroup = {
            key,
            familyKey: runFamily,
            uniform,
            first: childIndex === 0,
            last: childIndex === children.length - 1,
        };
        if (child.kind === 'group') units.push({ ...child, parentGroup });
        else units.push({ ...child, expandedGroup: parentGroup });
      }
    } else {
      units.push(groupUnit);
    }
    index = cursor;
  }
  return units;
}

/**
 * Multi-slot units cache.
 *
 * React's useMemo is ONE slot, so A→B→A tab switching rebuilt the whole
 * projection on every return even when the rows were the exact same array
 * from the snapshot cache — measured live 16.08 (dev): 107-168ms per click
 * on a 6.4K-row session, twice per switch, THE regression behind
 * «клик подорожал 75→300мс». Collapsed groups are static between visits —
 * the projection of the same rows with the same expanded set is the same
 * units, so it is keyed here by the rows ARRAY IDENTITY (WeakMap: evicted
 * together with the rows) plus a small per-array signature map for expanded
 * states (toggle back and forth stays warm). A NEW array (delta reassembly,
 * live merge) legitimately rebuilds once.
 *
 * Correctness rests on rows being replaced, never mutated in place: every
 * renderer path that changes a row ships a new object in a new array (delta
 * reassembly, live projection copies). The pure builder stays exported and
 * untouched for tests.
 */
const unitsCacheByEntries = new WeakMap();
const UNITS_CACHE_SIGNATURES_MAX = 4;

function unitsCacheSignature(options = {}) {
  const enabled = options.enabled !== false;
  if (!enabled) return 'off';
  const threshold = Math.max(2, Number(options.threshold) || DEFAULT_THRESHOLD);
  const keys = options.expandedKeys instanceof Set
    ? Array.from(options.expandedKeys)
    : (Array.isArray(options.expandedKeys) ? options.expandedKeys : []);
  return threshold + ':' + (keys.length === 0 ? '' : keys.slice().sort().join(''));
}

/** Cache lookup only — never builds. Null on miss. */
export function peekHistoryDisplayUnitsCached(entries, options = {}) {
  if (!Array.isArray(entries)) return null;
  const bySignature = unitsCacheByEntries.get(entries);
  if (!bySignature) return null;
  const signature = unitsCacheSignature(options);
  const hit = bySignature.get(signature);
  if (!hit) return null;
  // Map insertion order is the LRU list — promote.
  bySignature.delete(signature);
  bySignature.set(signature, hit);
  return hit;
}

function rememberUnitsInCache(entries, options, units) {
  if (!Array.isArray(entries)) return units;
  let bySignature = unitsCacheByEntries.get(entries);
  if (!bySignature) {
    bySignature = new Map();
    unitsCacheByEntries.set(entries, bySignature);
  }
  bySignature.set(unitsCacheSignature(options), units);
  while (bySignature.size > UNITS_CACHE_SIGNATURES_MAX) {
    const oldest = bySignature.keys().next().value;
    if (oldest === undefined) break;
    bySignature.delete(oldest);
  }
  return units;
}

/** Build and store (call after a peek miss). */
export function buildHistoryDisplayUnitsCached(entries, options = {}) {
  return rememberUnitsInCache(entries, options, buildHistoryDisplayUnits(entries, options));
}

/**
 * Store units computed OUTSIDE the cached builder — the append fast path.
 *
 * The hole this closes: append-built units were returned but never remembered,
 * so a session that STREAMED during a visit left the cross-visit cache keyed
 * only by its pre-append array. The snapshot cache hands the post-append array
 * back on the next wake → peek missed → the panel paid a FULL projection
 * rebuild on every re-visit (measured 20.08: 15-17ms ×3 re-visits on a 1.8K
 * session, 62.8ms on a 3.9K one — pure recomputation of a result that already
 * existed). Remembering the appended units makes a re-wake of a streamed tab
 * as cheap as a re-wake of an idle one.
 */
export function rememberHistoryDisplayUnitsCached(entries, options, units) {
  return rememberUnitsInCache(entries, options, units);
}

/**
 * A row a FUTURE append could pull into a group across it: groupable calls
 * (run may extend / dissolve into an edit block), reasoning-only rows (ride
 * along), short caption-eligible text (may become the headline of a call
 * that has not arrived yet). Everything else — user rows, slash rows,
 * standalone replies, final answers and interactive questions — is a hard grouping boundary:
 * no chain the builder recognizes crosses it, in either direction.
 */
function isGroupingConnectorRow(entry) {
  if (isHistoryResearchReplyEntry(entry)) return true;
  if (entrySeriesFamily(entry) !== null) return true;
  if (isThinkingOnlyRow(entry)) return true;
  return isObject(entry)
    && entry.role === 'assistant'
    && entryHasText(entry)
    && entryActionFacts(entry).length === 0
    && contentLength(entry) <= HISTORY_CAPTION_MAX_CHARS
    && !isStandaloneAnswer(entry);
}

/**
 * Incremental rebuild for a live append/delta.
 *
 * The full projection of a 6.5K-row session costs 100-300ms and used to run
 * on EVERY appended batch (measured 16.08). But a change at row i can only
 * affect units up to the nearest hard grouping boundary before i — so the
 * prefix of units before that boundary is reused verbatim and only the tail
 * is rebuilt.
 *
 * The change witness is ROW REFERENCE identity: the delta reassembly and
 * every pass-through projection preserve object refs for untouched rows, so
 * `prev[i] === next[i]` proves the row — and its grouping-visible facts —
 * did not move. A full reload that recreates every object (Claude today)
 * fails the prefix check honestly and falls back to the full build.
 *
 * Returns null when not applicable; otherwise
 * `{ units, reusedUnits, rebuiltEntries }`.
 */
export function buildHistoryDisplayUnitsAppended(prevEntries, prevUnits, nextEntries, options = {}, prevOptions = options) {
  if (options.enabled === false) return null;
  if (!Array.isArray(prevEntries) || !Array.isArray(prevUnits) || !Array.isArray(nextEntries)) return null;
  if (prevEntries.length === 0 || prevUnits.length === 0) return null;
  // Reused units carry their expanded/collapsed shape — valid only when the
  // expansion signature did not move between the two builds.
  if (unitsCacheSignature(options) !== unitsCacheSignature(prevOptions)) return null;
  // Longest common REFERENCE prefix of the two row arrays.
  const maxPrefix = Math.min(prevEntries.length, nextEntries.length);
  let commonPrefix = 0;
  while (commonPrefix < maxPrefix && prevEntries[commonPrefix] === nextEntries[commonPrefix]) {
    commonPrefix += 1;
  }
  if (commonPrefix === 0) return null;
  // Walk back over connector rows to the last hard boundary within the
  // unchanged prefix; everything at or before it cannot be regrouped by any
  // change at/after `commonPrefix`.
  let boundary = commonPrefix - 1;
  while (boundary >= 0 && isGroupingConnectorRow(prevEntries[boundary])) boundary -= 1;
  if (boundary < 0) return null; // the whole prefix is one connector chain
  const restart = boundary + 1;
  // Nothing reusable is cheaper as a fast path than as a full build.
  if (restart < 8) return null;
  // Reuse prev units whose entry span lies fully before `restart`. Expanded
  // groups are atomic here: header + its member rows move together.
  const reused = [];
  let pos = 0;
  for (let index = 0; index < prevUnits.length; index += 1) {
    const unit = prevUnits[index];
    const take = [unit];
    let span = 1;
    if (unit.kind === 'group') {
      span = unit.entries.length;
      if (unit.expanded === true) {
        let member = index + 1;
        while (
          member < prevUnits.length
          && (
            prevUnits[member].expandedGroup?.key === unit.key
            || prevUnits[member].parentGroup?.key === unit.key
            || (unit.level === 2 && prevUnits[member].expandedSubgroup?.key === unit.key)
          )
        ) {
          take.push(prevUnits[member]);
          member += 1;
        }
        index = member - 1;
      }
    } else if (unit.expandedGroup || unit.expandedSubgroup || unit.parentGroup) {
      // A member without its header ahead of it — inconsistent input.
      return null;
    }
    if (pos + span > restart) break;
    reused.push(...take);
    pos += span;
  }
  if (pos === 0) return null;
  const rebuilt = buildHistoryDisplayUnits(nextEntries.slice(pos), options);
  const units = reused.concat(rebuilt);
  rememberUnitsInCache(nextEntries, options, units);
  return { units, reusedUnits: reused.length, rebuiltEntries: nextEntries.length - pos };
}

/**
 * uuid → position resolver over display units (the owner's required single
 * function). Returns:
 *   { index }                      — uuid is a visible unit at this index
 *   { index, groupKey }            — uuid is inside the collapsed group at
 *                                    this index (caller expands, re-resolves)
 *   null                           — uuid not present in the display list
 */
export function resolveHistoryDisplayTarget(units, uuid) {
  if (!uuid || !Array.isArray(units)) return null;
  for (let index = 0; index < units.length; index += 1) {
    const unit = units[index];
    if (unit.kind === 'entry') {
      if (unit.entry?.uuid === uuid) return { index };
      // A merged caption keeps its uuid addressable at its call's row.
    } else if (unit.kind === 'group') {
      // An EXPANDED group's members follow as their own entry units — they
      // must resolve to those rows, and reporting groupKey here would make
      // "expand and re-resolve" loop forever on an already-open group.
      if (unit.expanded === true) continue;
      if (unit.entries.some((entry) => entry?.uuid === uuid)) {
        return { index, groupKey: unit.key };
      }
    }
  }
  return null;
}

/**
 * The one stub the viewport watcher should hydrate next, or null.
 *
 * Scanned over DISPLAY units, but bounded in ENTRIES — the distinction is the
 * whole fix. The margin («refetch when the viewport comes within N rows of
 * the span's edge») was designed in entry rows; walking it in unit rows made
 * it elastic: one collapsed group is one unit but can hide a hundred entries,
 * so «±250 units» reached thousands of entries — wider than one hydration
 * window can cover. Two stub clusters flanking such a zone produced the
 * production 05:04 loop (16.08, tab-3314): every response hydrated one flank
 * and evicted the other, `span=167-1667` ↔ `span=918-2289`, ~7 full reloads
 * per second with the user not scrolling at all.
 *
 * Second half of the fix: in the OFF-SCREEN margin a collapsed group is not a
 * hydration target — its header renders from stub-safe fields (actionSummary
 * digest, error count), so hydrating its members off-screen changes nothing
 * the user can see, while its entry count is what made the margin elastic.
 * A collapsed group INSIDE the viewport does hydrate: its caption line
 * («└ …») needs member content, and skipping it would make the header's
 * height differ between stubbed and hydrated states.
 */
export function findHistoryHydrationStub(units, range, entryMargin, captionSelections = null) {
  if (!Array.isArray(units) || units.length === 0) return null;
  const total = units.length;
  const margin = Math.max(0, Number(entryMargin) || 0);
  const entryStubOf = (unit) => {
    if (!unit || isGroupUnit(unit)) return null;
    return unit.entry?.rowStub ? unit.entry : null;
  };
  const anyStubOf = (unit) => {
    if (!unit) return null;
    if (isGroupUnit(unit)) {
      // Research headers are counters only. Unlike tool-group captions, they
      // need no hidden body; expanded children hydrate as their own entry units.
      if (unit.familyKey === 'research') return null;
      // An explicit caption choice takes priority within the same visible
      // group; the ordinary member/body hydration policy stays unchanged.
      const choice = captionSelections?.get(unit.key);
      if (choice) {
        const caption = resolveHistoryGroupCaption(unit.captionEntries, choice).entry;
        if (caption?.rowStub) return caption;
      }
      for (const member of unit.entries) {
        if (member?.rowStub) return member;
      }
      return null;
    }
    return entryStubOf(unit);
  };
  // Entry weight of one unit for the margin walk. An EXPANDED group's header
  // counts 0 — its members follow as their own entry units and carry the
  // weight themselves.
  const entrySpanOf = (unit) => {
    if (!unit) return 0;
    if (isGroupUnit(unit)) {
      return unit.expanded === true ? 0 : unit.entries.length;
    }
    return 1;
  };
  const start = Math.max(0, Math.min(total - 1, Number(range?.start) || 0));
  const end = Math.max(start, Math.min(total - 1, Number(range?.end) || 0));
  // The most recent explicit visible caption choice beats unrelated automatic
  // stub warming. It still uses the same request/queue and raw UUID address.
  if (captionSelections?.size) {
    const visibleGroups = new Map();
    for (let index = start; index <= end; index++) {
      if (isGroupUnit(units[index]) && units[index].expanded !== true) visibleGroups.set(units[index].key, index);
    }
    for (const [key, identity] of Array.from(captionSelections).reverse()) {
      const index = visibleGroups.get(key);
      if (index === undefined) continue;
      const caption = resolveHistoryGroupCaption(units[index].captionEntries, identity).entry;
      if (caption?.rowStub) return { entry: caption, index, caption: true };
    }
  }
  // Visible entry bodies and tool captions hydrate; counters-only SC headers do not.
  for (let index = start; index <= end; index += 1) {
    const found = anyStubOf(units[index]);
    if (found) return { entry: found, index };
  }
  // Off-screen: walk outward until the walk has covered `margin` ENTRIES.
  let covered = 0;
  for (let index = start - 1; index >= 0 && covered < margin; index -= 1) {
    const found = entryStubOf(units[index]);
    if (found) return { entry: found, index };
    covered += entrySpanOf(units[index]);
  }
  covered = 0;
  for (let index = end + 1; index < total && covered < margin; index += 1) {
    const found = entryStubOf(units[index]);
    if (found) return { entry: found, index };
    covered += entrySpanOf(units[index]);
  }
  return null;
}

/** Stable Virtuoso item key for a display unit. Entry units keep the live/
 * durable presentation key contract of the caller; group units use the
 * group key. */
export function historyDisplayUnitUuid(unit) {
  if (!unit) return '';
  if (unit.kind === 'entry') return unit.entry?.uuid || '';
  return unit.entries[0]?.uuid || '';
}

export const HISTORY_GROUP_THRESHOLD_DEFAULT = DEFAULT_THRESHOLD;
export const HISTORY_GROUPABLE_FAMILIES = GROUPABLE_FAMILIES;

/**
 * Per-family breakdown of a group's calls, in FIRST-APPEARANCE order.
 *
 * The header of a mixed run speaks in ACTION TYPES and CALL COUNTS —
 * `Read ×3 · Git ×1` — rather than pretending that three Read calls always
 * mean three different files. Distinct subjects are still collected for the
 * optional detail line and for the inner homogeneous series, but they never
 * redefine the counter. The order is the order the families first appeared,
 * which matches how the run actually unfolded.
 */
export function groupFamilyBreakdown(facts) {
  const list = Array.isArray(facts) ? facts : [];
  const byFamily = new Map();
  for (const fact of list) {
    const family = fact?.family || 'other';
    const docsKind = fact?.docsKind || '';
    // The broad header counts TYPES, not presentation scopes. Splitting one
    // family into `Edit ×1 · Edit ×1` merely because one target lived under
    // docs/ looked like a duplicated operation. Scope remains a hard boundary
    // for INNER series and stays on each child card; here equal families add.
    let bucket = byFamily.get(family);
    if (!bucket) {
      bucket = {
        family,
        docsKind: '',
        docsKinds: new Set(),
        count: 0,
        callCount: 0,
        words: new Map(),
        subjects: [],
        targets: new Map(),
      };
      byFamily.set(family, bucket);
    }
    bucket.docsKinds.add(docsKind);
    bucket.callCount += 1;
    // The distinguishing token per family: git → subcommand, MCP → server,
    // shell → command word, native tools → their name.
    const word = family === 'git'
      ? (fact.bashDetail || 'git')
      : family === 'mcp'
        // The distinguishing token of an MCP call is the SERVER — the header
        // fragment reads `MCP electron ×7`. Methods are member-level detail
        // (each expanded row already says `server · method`).
        ? (fact.mcpServer || 'mcp')
        : (fact.bashWord || fact.toolName || '');
    if (word) bucket.words.set(word, (bucket.words.get(word) || 0) + 1);
    const subject = fact.subject ? String(fact.subject) : '';
    if (subject && !bucket.subjects.includes(subject)) bucket.subjects.push(subject);
    const targetKey = String(fact.targetKey || '');
    const targetLabel = String(fact.targetLabel || subject || '');
    if (targetKey) {
      if (!bucket.targets.has(targetKey)) bucket.targets.set(targetKey, targetLabel);
    } else if (targetLabel) {
      if (!bucket.targets.has(targetLabel)) bucket.targets.set(targetLabel, targetLabel);
    }
  }
  const result = Array.from(byFamily.values());
  // One multiplier has one meaning everywhere: number of source tool calls.
  // A docs accent survives only when EVERY call of this family has the same
  // docs channel; a mixed docs/regular `Edit ×2` stays neutral rather than
  // colouring the ordinary edit or splitting the word into a fake duplicate.
  for (const bucket of result) {
    bucket.count = bucket.callCount;
    bucket.docsKind = bucket.docsKinds.size === 1
      ? (Array.from(bucket.docsKinds)[0] || '')
      : '';
    delete bucket.docsKinds;
  }
  return result;
}
