/**
 * History display-units projection — series collapsing.
 *
 * The LAST projection step before Virtuoso (after live merge and rewind
 * preview): `(entries, expandedKeys) → display units`. Approved contract with
 * the functional-History owner (docs/tmp/визуал-history.md::Вердикт):
 *
 *  - Pure and memoizable; groups are презентация — never written to any
 *    durable cache or snapshot.
 *  - Group key (first member's tool_use id) is INTERNAL. Everything that
 *    crosses the projection boundary — hydration center, reading anchor,
 *    Timeline jump, search — speaks server-row uuids only.
 *  - Grouping reads ONLY fields that exist on both full rows and row-window
 *    stubs (family/bashWord/mcpServer/mcpMethod/messageId/hasContent/
 *    actionSummary) so grouping(any hydration window) === grouping(full).
 *  - Kill switch: `enabled: false` → identity projection.
 *
 * What groups: consecutive assistant entries whose actions all belong to one
 * family (git/read/search/run/mcp — MCP additionally per server), with no
 * standalone reply, no user row, no edit and no family change in between.
 * Caption texts (entry text in the same model response as its calls — Claude:
 * shared messageId; Codex: commentary phase directly before calls) do NOT
 * break a series; a standalone reply does.
 *
 * Corpus grounding (docs/tmp/визуал-history-research-*.md): threshold 2 is
 * the user's pick; families are mandatory because 76% of Claude Bash / 65%
 * of Codex shell are reads and searches.
 */

import {
  HISTORY_CAPTION_MAX_CHARS,
  historyActionHeadline,
} from '../../shared/history-action-grammar.mjs';

/** Short digest subject for a hydrated action — mirrors main's stubActionSubject. */
function hydratedSubject(raw) {
  try {
    const subject = String(historyActionHeadline({
      toolName: raw.toolName,
      args: raw.args,
      family: raw.family,
      bashWord: raw.bashWord,
      bashDetail: raw.bashDetail,
      mcpServer: raw.mcpServer,
      mcpMethod: raw.mcpMethod,
    }).subject || '');
    if (!subject) return '';
    if (subject.includes('/')) {
      const parts = subject.split('/').filter(Boolean);
      return parts[parts.length - 1] || '';
    }
    return subject.length > 60 ? subject.slice(0, 60) : subject;
  } catch {
    return '';
  }
}

/**
 * Two collapsing CLASSES, not one list of families.
 *
 * `noise` — reads, searches, git, shell runs, MCP calls, web lookups. The user
 * does not open these; a run of them is one line no matter how the types
 * interleave, because "read, then git, then read, then npm" as four separate
 * rows is exactly the wall this feature exists to remove.
 *
 * `edit` — every file mutation (Edit / Write / MultiEdit / Update, one verb).
 * Edits collapse only WITH EACH OTHER and never merge into the noise class:
 * which files changed and by how much is the one thing the user scans.
 *
 * Everything else (plan, task, question, wait, other) keeps its own row.
 */
const CLASS_BY_FAMILY = new Map([
  ['read', 'noise'], ['search', 'noise'], ['git', 'noise'],
  ['run', 'noise'], ['mcp', 'noise'], ['web', 'noise'],
  ['toolsearch', 'noise'],
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

/**
 * The grouping-visible shape of one entry's actions: works on both hydrated
 * rows (actions[].rawTool) and stubs (actionSummary[]).
 */
export function entryActionFacts(entry) {
  if (!isObject(entry)) return [];
  if (Array.isArray(entry.actionSummary)) {
    return entry.actionSummary.map((item) => ({
      toolUseId: item?.toolUseId ? String(item.toolUseId) : '',
      toolName: item?.toolName ? String(item.toolName) : '',
      family: item?.family ? String(item.family) : '',
      bashWord: item?.bashWord ? String(item.bashWord) : '',
      bashDetail: item?.bashDetail ? String(item.bashDetail) : '',
      mcpServer: item?.mcpServer ? String(item.mcpServer) : '',
      mcpMethod: item?.mcpMethod ? String(item.mcpMethod) : '',
      subject: item?.subject ? String(item.subject) : '',
      isError: item?.isError === true,
    }));
  }
  const actions = Array.isArray(entry.actions) ? entry.actions : [];
  const facts = [];
  for (const action of actions) {
    if (!isObject(action)) continue;
    if (action.tool === '__raw__' && isObject(action.rawTool)) {
      const raw = action.rawTool;
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
        subject: hydratedSubject(raw),
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
  return facts;
}

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
  // A stub with hasContent but no content: length unknown — treat as long
  // (standalone) so hydration state can only SPLIT groups it cannot verify,
  // never merge across a possible reply.
  return entry?.hasContent === true ? Number.POSITIVE_INFINITY : 0;
};

export function isCaptionForNext(entry, nextEntry) {
  if (!isObject(entry) || entry.role !== 'assistant') return false;
  if (!entryHasText(entry)) return false;
  if (entryActionFacts(entry).length > 0) return false; // caption of own calls
  if (contentLength(entry) > HISTORY_CAPTION_MAX_CHARS) return false;
  if (!isObject(nextEntry) || nextEntry.role !== 'assistant') return false;
  if (entryActionFacts(nextEntry).length === 0) return false;
  // Codex's final answer is the one text that must NEVER glue to what follows.
  if (entry.textPhase === 'final_answer') return false;
  // Everything else: a short text immediately before a call IS that call's
  // headline. Earlier this also demanded structural proof (shared messageId /
  // commentary phase), and rows without it — Claude splits text and tool_use
  // into separate messages routinely — fell out as bare paragraphs with no
  // card indent (user's «оторванный текст» screenshot). Position plus length
  // is the honest signal; the proofs remain as fast-path confirmations.
  return true;
}

/**
 * The single family of an entry's groupable actions, or null when the entry
 * does not participate in series grouping (mixed families, edits, tasks,
 * text-only rows, non-assistant rows).
 * MCP rows return `mcp:<server>` — a server change breaks the series by
 * construction (user decision: «MCP · 12 calls» must not hide which system
 * was touched).
 */
/**
 * The collapsing class of one row: 'noise', 'edit', or null (never collapses).
 *
 * A row with several actions of MIXED classes never collapses — an assistant
 * turn that both read and edited in one message is a real composite step.
 */
export function entrySeriesFamily(entry) {
  if (!isObject(entry) || entry.role !== 'assistant') return null;
  const facts = entryActionFacts(entry);
  if (facts.length === 0) return null;
  let key = null;
  for (const fact of facts) {
    const cls = CLASS_BY_FAMILY.get(fact.family);
    if (!cls) return null;
    if (key === null) key = cls;
    else if (key !== cls) return null;
  }
  return key;
}

/**
 * Display unit shapes:
 *   { kind: 'entry', entry }                       — passthrough row
 *   { kind: 'group', key, familyKey, entries,
 *     facts, errorCount, captionEntry }            — collapsed series
 *
 * `key` = 'grp:' + first member's first tool_use id (stable across appends:
 * a growing live series keeps its first member). Expanded groups are NOT
 * returned as groups — the caller passes `expandedKeys`, and expanded
 * members come back as plain entry units (so heavy bodies mount only then),
 * with `expandedGroup` metadata on each for rail rendering.
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
  while (index < list.length) {
    const entry = list[index];
    const familyKey = entrySeriesFamily(entry);
    // A caption entry directly before a groupable run joins the run it
    // captions (becomes the group headline).
    let captionEntry = null;
    let runStart = index;
    if (familyKey === null && isCaptionForNext(entry, list[index + 1])) {
      const nextFamily = entrySeriesFamily(list[index + 1]);
      if (nextFamily !== null) {
        captionEntry = entry;
        runStart = index + 1;
      }
    }
    const runFamily = captionEntry ? entrySeriesFamily(list[runStart]) : familyKey;
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
    let cursor = runStart;
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
            && pocketRow.textPhase !== 'final_answer'
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
      if (captionEntry) units.push({ kind: 'entry', entry: captionEntry });
      for (const member of members) units.push({ kind: 'entry', entry: member });
      index = Math.max(cursor, index + 1);
      continue;
    }
    const allMembers = captionEntry ? [captionEntry, ...members] : members;
    const facts = members.flatMap((member) => entryActionFacts(member));
    const firstCallId = facts.find((fact) => fact.toolUseId)?.toolUseId
      || allMembers[0]?.uuid || String(index);
    const key = 'grp:' + firstCallId;
    const groupUnit = {
      kind: 'group',
      key,
      familyKey: runFamily,
      entries: allMembers,
      captionEntry,
      facts,
      errorCount: facts.reduce((sum, fact) => sum + (fact.isError ? 1 : 0), 0),
    };
    if (expandedKeys.has(key)) {
      // Expanded: the group HEADER stays (clicking it collapses back —
      // user decision: the verb line must not vanish into a bare button),
      // members follow as their own indented rows under the rail.
      units.push({ ...groupUnit, expanded: true });
      // Uniform = every call in the run is the same family. Members of a
      // uniform run hide their verb (the header said it once); members of a
      // mixed run keep it, because there the verb is what tells the rows apart.
      const uniform = new Set(facts.map((fact) => fact.family)).size <= 1;
      for (let m = 0; m < allMembers.length; m += 1) {
        units.push({
          kind: 'entry',
          entry: allMembers[m],
          expandedGroup: {
            key,
            familyKey: runFamily,
            uniform,
            first: m === 0,
            last: m === allMembers.length - 1,
          },
        });
      }
    } else {
      units.push(groupUnit);
    }
    index = cursor;
  }
  return units;
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
 * The header of a mixed run must speak honest phrases — «Read 3 files ·
 * Ran git 3 commands · npm» — rather than a synthetic «6 steps», so it needs
 * the counts per family plus the distinct subjects each family touched. The
 * order is the order the families first appeared, which matches how the run
 * actually unfolded.
 */
export function groupFamilyBreakdown(facts) {
  const list = Array.isArray(facts) ? facts : [];
  const byFamily = new Map();
  for (const fact of list) {
    const family = fact?.family || 'other';
    let bucket = byFamily.get(family);
    if (!bucket) {
      bucket = { family, count: 0, words: new Map(), subjects: [] };
      byFamily.set(family, bucket);
    }
    bucket.count += 1;
    // The distinguishing token per family: git → subcommand, mcp → method,
    // shell → command word, native tools → their name.
    const word = family === 'git'
      ? (fact.bashDetail || 'git')
      : family === 'mcp'
        // The distinguishing token of an MCP call is the SERVER — the header
        // phrase reads «Called electron ×7». Methods are member-level detail
        // (each expanded row already says `server · method`). Counting
        // methods here once made the phrase print «Called evaluate», which
        // reads as a mystery verb with no server and no count.
        ? (fact.mcpServer || 'mcp')
        : (fact.bashWord || fact.toolName || '');
    if (word) bucket.words.set(word, (bucket.words.get(word) || 0) + 1);
    const subject = fact.subject ? String(fact.subject) : '';
    if (subject && !bucket.subjects.includes(subject)) bucket.subjects.push(subject);
  }
  return Array.from(byFamily.values());
}
