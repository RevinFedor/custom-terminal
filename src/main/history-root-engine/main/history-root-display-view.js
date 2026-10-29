'use strict';

// Opt-in Source sidecar. The caller supplies a COMPLETE, frozen canonical
// array root AFTER live merge/Rewind. Nothing here registers a production
// reader, changes actor busy, persists a canonical root, or activates UI.
// Targeted storage port of historyDisplayUnits.mjs SHA256
// 2f68d97ec19f625e6db0652f6a8e05bede08e48d2218a4b825b3da5138404210.
// All growing collections (including scratch, facts, caption dedupe, whole-
// message membership, family details and navigation) use the existing arena.
// The unchanged ESM oracle is test-only; no dynamic runtime imports/eval.
const { HistoryProjectionArena } = require('./history-projection-arena');
const text = require('./history-paged-text');
const { historyPrimaryPhysicalKey } = require('./history-primary-physical-key');
const { HISTORY_CAPTION_MAX_CHARS, historyActionPresentationMeta,
  historyDisplayPath } = require('../shared/history-action-grammar.cjs');
const { isStandaloneHistoryAnswerPhase } = require('../shared/history-text-phase.cjs');
const { systemPromptSource } = require('../shared/prompt-origin.cjs');
const { normalizeHistoryRecordTime } = require('../shared/history-record-time.cjs');

// Fixed vocabulary, independent of history size. Do not infer a missing raw
// family from tool name: the original classifier also refuses that row.
const CLASS = Object.freeze({ read: 'noise', search: 'noise', git: 'noise',
  run: 'noise', mcp: 'noise', web: 'noise', toolsearch: 'noise', plan: 'noise',
  task: 'noise', wait: 'noise', other: 'noise', edit: 'edit' });
const RAW_FIELDS = Object.freeze(['toolUseId', 'toolName', 'family', 'bashWord',
  'bashDetail', 'mcpServer', 'mcpMethod']);
const SUMMARY_FIELDS = Object.freeze([...RAW_FIELDS, 'subject', 'aggregateKey',
  'targetKey', 'targetLabel', 'operationLabel', 'docsKind']);
// Only these argument fields are read by the pinned headline/presentation
// grammar. Never visit result, diff hunks, file content, patch text or reasoning.
const GRAMMAR_ARGS = Object.freeze(['file_path', 'path', 'offset', 'limit',
  'summary', 'query', 'url', 'command', 'glob']);
const object = v => v !== null && typeof v === 'object' && !text.isText(v);
const truth = v => text.isText(v) ? v.length > 0 : !!v;
const eq = (a, b) => text.isText(a) && text.isText(b) ? text.equal(a, b) : a === b;
const string = v => text.isText(v) ? v.length <= text.SMALL_CHARS ? text.small(v)
  : text.materialize(v, 'display-classifier-scalar') : String(v);
const or = (v, fallback) => truth(v) ? v : fallback;
const error = code => Object.assign(new Error(code), { code });

async function createHistoryRootDisplayView(store, canonicalRoot, options = {}) {
  if (options.complete !== true || options.frozen !== true) throw error('history_display_complete_frozen_required');
  // Match the synchronous oracle's option snapshot before any cooperative
  // yield. A caller changing its next view must not splice two topologies
  // into this already-started finite projection.
  const enabled = options.enabled !== false;
  const responseWork = options.responseWork === true;
  const threshold = Math.max(2, Number(options.threshold) || 2);
  const arena = new HistoryProjectionArena(store, canonicalRoot);
  const step = fn => arena.step(fn);
  const make = kind => step(() => arena.make(kind));
  const record = fields => step(() => arena.record(fields));
  const push = (list, value) => step(() => list.push(value));
  const set = (target, key, value) => step(() => target.set(key, value));
  const add = (target, value) => step(() => target.add(value));
  const assign = (target, key, value) => step(() => { target[key] = value; });
  const concatKey = (prefix, value) => step(() => text.concat([prefix, text.coerce(value)], '', arena));
  const check = () => options.control?.assertCurrent();
  const checkpoint = async () => {
    check();
    if (options.control?.checkpoint) await options.control.checkpoint();
    else await new Promise(resolve => setImmediate(resolve));
    check();
  };
  const metrics = { classifiedRows: 0, classifiedActions: 0, grammarCalls: 0,
    maxGrammarScalarChars: 0 };
  // A single argument/name scalar remains an explicit legacy grammar boundary:
  // its tokenizer may allocate proportional to that scalar, never to the
  // number of source rows/actions. This sidecar does NOT claim global memory.
  function scalar(v) {
    const value = text.isText(v) ? string(v) : v;
    if (typeof value === 'string') metrics.maxGrammarScalarChars = Math.max(metrics.maxGrammarScalarChars, value.length);
    return value;
  }
  function recordTime(value) {
    if (!value || value.version !== 1) return null;
    const small = part => text.isText(part) && part.length <= 64 ? scalar(part) : null;
    return normalizeHistoryRecordTime({ version: 1, kind: small(value.kind),
      scope: small(value.scope), timestamp: small(value.timestamp) }) || null;
  }
  function grammarInput(raw, summary) {
    const args = {};
    if (!summary && raw?.args != null) for (const key of GRAMMAR_ARGS) {
      // Lazy per-field scalar projection; no whole action/args materialization.
      Object.defineProperty(args, key, { get: () => scalar(raw.args?.[key]), enumerable: true });
    }
    return { toolName: scalar(raw?.toolName), family: scalar(raw?.family),
      bashWord: scalar(raw?.bashWord), bashDetail: scalar(raw?.bashDetail),
      mcpServer: scalar(raw?.mcpServer), mcpMethod: scalar(raw?.mcpMethod), args };
  }
  function actionFact(action, summary = false) {
    const raw = summary ? action : action?.rawTool;
    if (!summary && (!object(action) || !eq(action.tool, '__raw__') || !object(raw))) {
      return object(action) && eq(action.tool, 'Task') ? record({
        toolUseId: truth(action.toolUseId) ? text.coerce(action.toolUseId) : '',
        toolName: 'Task', family: 'task', bashWord: '', mcpServer: '', mcpMethod: '', isError: false,
      }) : null;
    }
    metrics.grammarCalls++;
    const presentation = historyActionPresentationMeta(grammarInput(raw, summary));
    const fact = {};
    for (const key of summary ? SUMMARY_FIELDS : RAW_FIELDS) {
      fact[key] = truth(raw?.[key]) ? step(() => text.coerce(raw[key])) : '';
    }
    if (summary) {
      fact.aggregateKey = or(fact.aggregateKey, presentation.aggregateKey);
      fact.docsKind = or(fact.docsKind, presentation.docsKind);
    } else {
      // Exactly hydratedSubject's operationLabel + historyDisplayPath path.
      fact.subject = presentation.operationLabel ? historyDisplayPath(presentation.operationLabel) : '';
      fact.aggregateKey = presentation.aggregateKey; fact.targetKey = presentation.targetKey;
      fact.targetLabel = presentation.targetLabel; fact.operationLabel = presentation.operationLabel;
      fact.docsKind = presentation.docsKind;
    }
    fact.isError = raw?.isError === true;
    if (!summary) fact.inFlight = raw.isError !== true && raw.result == null
      && raw.resultRef == null && raw.backgroundStatus == null;
    return record(fact);
  }
  // Current provenance priority, directly ported (Source's renderer helper
  // is older). A quoted Research phrase is never provenance. Lists stay paged.
  function researchPhase(row) {
    if (!object(row) || !(eq(row.role, 'user') || eq(row.role, 'queued')) || truth(row.questionReplyProof)) return null;
    if (row.queueStatus !== undefined && !eq(row.queueStatus, 'sent')) return null;
    if ((row.isLocal === true || truth(row.handoffId)) && !eq(row.queueStatus, 'sent')) return null;
    const tags = row.semanticTags;
    if (!Array.isArray(tags)) return null;
    let origin = null, firstOrchestration = null, tag = null;
    for (const t of tags) {
      if (eq(t?.kind, 'tab-message') && text.isText(t.messageId) && text.trim(t.messageId).length
        && (eq(t.phase, 'question') || eq(t.phase, 'reply'))
        && text.isText(t.sourceTabId) && text.trim(t.sourceTabId).length
        && text.isText(t.targetTabId) && text.trim(t.targetTabId).length) return null;
      if (eq(t?.kind, 'prompt-origin') && eq(t.source, 'system')
        && systemPromptSource(scalar(t.systemSource)) === 'tab-message-outcome') return null;
      if (!origin && eq(t?.kind, 'prompt-origin') && eq(t.source, 'terminal-mcp')) origin = t;
      if (!firstOrchestration && eq(t?.kind, 'orchestration')) firstOrchestration = t;
      if (!tag && eq(t?.kind, 'orchestration') && text.isText(t.runId) && text.trim(t.runId).length) tag = t;
    }
    if (eq((firstOrchestration || origin)?.source, 'terminal-mcp')) return null;
    return tag && eq(tag.runKind, 'external-research')
      && (eq(tag.phase, 'completion') || eq(tag.phase, 'failure')) ? tag.phase : null;
  }
  const captionEligible = m => m?.assistant === true && m.hasText === true
    && m.contentLength <= HISTORY_CAPTION_MAX_CHARS && !m.standalone;
  const captionForNext = (m, next) => captionEligible(m) && m.facts.length === 0
    && next?.assistant === true && next.facts.length > 0;
  const cls = fact => Object.hasOwn(CLASS, string(fact.family)) ? CLASS[string(fact.family)] : null;
  function seriesFamily(m) {
    if (!m.assistant || !m.facts.length) return null;
    let key = null, mixed = false;
    for (const f of m.facts) {
      const next = cls(f); if (!next) return null;
      if (key === null) key = next; else if (next !== key) mixed = true;
      if (next === 'edit') key = 'edit';
    }
    return mixed && key !== 'edit' ? null : key;
  }
  // Keep the existing supported-family gate, but all supported tool types
  // participate in one work block. Standalone/oversized texts stay visible.
  const workFamily = m => m && m.family !== null && (!m.hasText || captionEligible(m)) ? 'work' : null;
  const groupingFamily = m => {
    const family = workFamily(m);
    return responseWork && family !== null && m.facts?.length !== m.actionCount ? null : family;
  };
  function aggregateKey(m) {
    if (!m.assistant || m.thinking || m.hasText || !m.facts.length) return null;
    let key = null;
    for (const fact of m.facts) {
      if (!cls(fact)) return null;
      const candidate = truth(fact.aggregateKey) ? fact.aggregateKey
        : text.concat([fact.family, ':regular'], '', arena);
      if (key === null) key = candidate; else if (!eq(candidate, key)) return null;
    }
    return key;
  }
  let output = null;
  try {
    const source = arena.state();
    if (!Array.isArray(source)) throw error('history_display_canonical_array_required');
    const rows = make('array'), memberships = make('map'), expanded = make('set'), identities = make('map');
    const entryMetadata = make('map');
    const expansion = options.expandedKeys instanceof Set || Array.isArray(options.expandedKeys) ? options.expandedKeys : [];
    for (const key of expansion) add(expanded, key);
    for (let i = 0; i < source.length; i++) {
      check();
      const row = source[i];
      const classify = enabled || responseWork;
      const facts = !classify ? null : make('array');
      const summary = classify && Array.isArray(row?.actionSummary);
      const actions = !classify ? null
        : summary ? row.actionSummary : Array.isArray(row?.actions) ? row.actions : null;
      if (actions) for (let j = 0; j < actions.length; j++) {
        step(() => { const fact = actionFact(actions[j], summary); if (fact) facts.push(fact); });
        metrics.classifiedActions++;
        if (j % 64 === 63) await checkpoint();
      }
      step(() => {
        // The original kill switch is a true identity projection: no action
        // grammar, caption/body scan or provenance classification at all.
        if (!classify) {
          const m = arena.record({ entry: row }); rows.push(m); entryMetadata.set(row, m);
          if (truth(row?.uuid) && !identities.has(row.uuid)) identities.set(row.uuid, i);
          return;
        }
        const content = row?.content;
        const length = text.isText(content) ? text.trim(content).length
          : Number.isSafeInteger(row?.contentLength) && row.contentLength >= 0 ? row.contentLength
            : row?.hasContent === true ? Infinity : 0;
        const thinking = truth(row?.thinking) || row?.hasThinking === true;
        const hasText = row?.hasContent === true || text.isText(content) && length > 0;
        const seconds = text.number(row?.thinkingSeconds);
        const m = arena.record({ entry: row, facts, assistant: eq(row?.role, 'assistant'),
          contentLength: length, hasText, thinking,
          actionCount: Math.max(Array.isArray(row?.actionSummary) ? row.actionSummary.length : 0,
            Array.isArray(row?.actions) ? row.actions.length : 0),
          thinkingOnly: eq(row?.role, 'assistant') && thinking && !hasText && facts.length === 0,
          standalone: isStandaloneHistoryAnswerPhase(scalar(row?.textPhase)),
          thinkingSeconds: Number.isFinite(seconds) && seconds > 0 ? seconds : 0,
          researchPhase: researchPhase(row),
          messageId: text.isText(row?.messageId) ? row.messageId : '',
        });
        m.family = seriesFamily(m); m.aggregate = aggregateKey(m); rows.push(m); entryMetadata.set(row, m);
        if (truth(row?.uuid) && !identities.has(row.uuid)) identities.set(row.uuid, i);
        const work = groupingFamily(m);
        if (truth(m.messageId) && work !== null) {
          let values = memberships.get(m.messageId);
          if (!values) { values = arena.make('set'); memberships.set(m.messageId, values); }
          values.add(work);
        }
      });
      metrics.classifiedRows++;
      await checkpoint();
    }
    const nextAction = (from, list = rows) => {
      let at = from;
      while (at < list.length && list[at].thinkingOnly) at++;
      if (at < list.length - 1 && captionForNext(list[at], list[at + 1])) at++;
      return at < list.length ? groupingFamily(list[at]) : null;
    };
    // Do not turn an untyped legacy final into a hidden caption. Use the same
    // commentary, composite-row, structural-message and adjacency proofs as
    // the renderer projection.
    const workCaption = (m, next) => {
      if (!captionEligible(m)) return false;
      if (scalar(m.entry?.textPhase) === 'commentary') return m.facts.length === 0 || workFamily(m) !== null;
      if (m.facts.length > 0) return workFamily(m) !== null;
      if (truth(m.messageId) && memberships.get(m.messageId)?.has('work')) return true;
      return captionForNext(m, next) && workFamily(next) !== null;
    };
    let units = make('array');
    const entryUnit = m => record({ kind: 'entry', entry: m.entry });
    function collect(members) {
      const entries = make('array'), facts = make('array');
      let seconds = 0, errors = 0;
      for (const m of members) {
        push(entries, m.entry); seconds += m.thinkingSeconds;
        for (const fact of m.facts) { push(facts, fact); if (fact.isError) errors++; }
      }
      return { entries, facts, seconds, errors };
    }
    const distinct = (facts, field, dropEmpty = false) => {
      const result = make('set');
      for (const fact of facts) if (!dropEmpty || truth(fact[field])) add(result, or(fact[field], ''));
      return result;
    };
    const first = set => set.values().next().value;
    function inner(members, c = collect(members)) {
      let firstId = null;
      for (const f of c.facts) if (truth(f.toolUseId)) { firstId = f.toolUseId; break; }
      const families = distinct(c.facts, 'family'), docs = distinct(c.facts, 'docsKind', true);
      const key = concatKey('sub:', or(firstId, or(c.entries[0]?.rewriteLayoutUuid, or(c.entries[0]?.uuid, 'unknown'))));
      return record({ kind: 'group', level: 2, key,
        familyKey: families.size === 1 ? or(c.facts[0]?.family, 'run') : 'mixed',
        aggregateKey: or(c.facts[0]?.aggregateKey, ''), docsKind: docs.size === 1 ? first(docs) : '',
        entries: c.entries, facts: c.facts, errorCount: c.errors, thinkingSeconds: c.seconds, expanded: expanded.has(key) });
    }
    function emitInner(members) {
      const children = make('array');
      let i = 0;
      while (i < members.length) {
        const signature = members[i].aggregate;
        if (signature === null) { push(children, entryUnit(members[i++])); continue; }
        const actionMembers = make('array'); let cursor = i;
        while (cursor < members.length && eq(members[cursor].aggregate, signature)) push(actionMembers, members[cursor++]);
        const c = collect(actionMembers);
        if (c.facts.length < 2) for (const m of actionMembers) push(children, entryUnit(m));
        else {
          const group = inner(actionMembers, c); push(children, group);
          if (group.expanded) for (let j = 0; j < actionMembers.length; j++) {
            const u = entryUnit(actionMembers[j]);
            assign(u, 'expandedSubgroup', record({ key: group.key, familyKey: group.familyKey, docsKind: group.docsKind,
              first: j === 0, last: j === actionMembers.length - 1 })); push(children, u);
          }
        }
        i = cursor;
      }
      return children;
    }
    let index = 0;
    while (index < rows.length) {
      check();
      // One finite group is one transaction, not one fsync for every member
      // append. All suspended/growing state is still page backed. record()
      // imports no native container graph, so input identities stay empty.
      const resume = step(() => {
        const m = rows[index], e = m.entry;
        if (!enabled || eq(e?.role, 'slash')) { push(units, entryUnit(m)); return index + 1; }
        if (m.researchPhase !== null) {
          let cursor = index + 1;
          while (cursor < rows.length && rows[cursor].researchPhase !== null) cursor++;
          const identity = or(e?.auditEntryUuid, or(e?.auditProof?.entryUuid, e?.uuid));
          const key = text.isText(identity) && truth(identity) ? concatKey('research-grp:', identity) : null;
          if (cursor - index >= 2 && key) {
            const entries = make('array'); let errors = 0;
            for (let j = index; j < cursor; j++) { push(entries, rows[j].entry); if (eq(rows[j].researchPhase, 'failure')) errors++; }
            const group = record({ kind: 'group', key, level: 1, familyKey: 'research', entries,
              facts: make('array'), errorCount: errors, captionEntry: null, expanded: expanded.has(key) });
            push(units, group);
            if (group.expanded) for (let j = index; j < cursor; j++) {
              const u = entryUnit(rows[j]); assign(u, 'expandedGroup', record({ key, familyKey: 'research',
                first: j === index, last: j === cursor - 1 })); push(units, u);
            }
          } else for (let j = index; j < cursor; j++) push(units, entryUnit(rows[j]));
          return cursor;
        }
        let runFamily = groupingFamily(m);
        const firstCaption = responseWork ? false : workCaption(m, rows[index + 1]);
        if (m.hasText && !firstCaption) { push(units, entryUnit(m)); return index + 1; }
        if (runFamily === null && firstCaption && m.facts.length === 0) runFamily = 'work';
        if (groupingFamily(m) === null && !firstCaption && m.thinkingOnly) {
          const structural = truth(m.messageId) ? memberships.get(m.messageId) : null;
          if (structural?.size === 1) runFamily = first(structural);
          else if (!structural || structural.size === 0) runFamily = nextAction(index);
        }
        if (runFamily === null) { push(units, entryUnit(m)); return index + 1; }
        const members = make('array'); let cursor = index, hasCaption = false;
        while (cursor < rows.length) {
          const candidate = rows[cursor], family = groupingFamily(candidate);
          if (candidate.hasText) {
            if (responseWork || !workCaption(candidate, rows[cursor + 1]) || hasCaption) break;
            hasCaption = true; push(members, candidate); cursor++; continue;
          }
          if (eq(family, runFamily)) { push(members, candidate); cursor++; continue; }
          if (family === null && candidate.thinkingOnly) {
            const values = truth(candidate.messageId) ? memberships.get(candidate.messageId) : null;
            const known = values && values.size > 0;
            if (values?.has(runFamily) || !known && eq(nextAction(cursor), runFamily)) {
              push(members, candidate); cursor++; continue;
            }
          }
          break;
        }
        const c = collect(members);
        if ((c.facts.length < threshold && !(hasCaption && c.facts.length > 0)) || !members.length) {
          for (const member of members) push(units, entryUnit(member));
          return Math.max(cursor, index + 1);
        }
        const captions = make('array'), seen = make('set');
        const addCaption = row => {
          const identity = or(row?.uuid, row);
          if (!seen.has(identity)) { add(seen, identity); push(captions, row); }
        };
        for (const member of members) if (captionEligible(member)) addCaption(member.entry);
        const detail = captions[captions.length - 1] || null;
        let firstCall = null;
        for (const fact of c.facts) if (truth(fact.toolUseId)) { firstCall = fact.toolUseId; break; }
        const key = concatKey('grp:', or(firstCall, or(c.entries[0]?.rewriteLayoutUuid, or(c.entries[0]?.uuid, String(index)))));
        const aggregateKeys = distinct(c.facts, 'aggregateKey', true);
        let pure = aggregateKeys.size === 1;
        if (pure) for (const member of members) if (member.aggregate === null) { pure = false; break; }
        if (pure) {
          const group = inner(members, c);
          assign(group, 'key', key); assign(group, 'expanded', expanded.has(key));
          assign(group, 'captionEntry', detail); assign(group, 'captionEntries', captions); push(units, group);
          if (group.expanded) for (let j = 0; j < members.length; j++) {
            const u = entryUnit(members[j]);
            assign(u, 'expandedSubgroup', record({ key: group.key, familyKey: group.familyKey, docsKind: group.docsKind,
              first: j === 0, last: j === members.length - 1 })); push(units, u);
          }
          return cursor;
        }
        const docs = distinct(c.facts, 'docsKind');
        const group = record({ kind: 'group', level: 1, key, familyKey: runFamily,
          docsKind: docs.size === 1 ? first(docs) : '', entries: c.entries, captionEntry: detail, captionEntries: captions,
          facts: c.facts, errorCount: c.errors, thinkingSeconds: c.seconds });
        if (expanded.has(key)) assign(group, 'expanded', true);
        push(units, group);
        if (group.expanded) {
          const uniform = distinct(c.facts, 'family').size <= 1;
          const children = responseWork ? make('array') : emitInner(members);
          if (responseWork) for (const member of members) push(children, entryUnit(member));
          for (let j = 0; j < children.length; j++) {
            const child = children[j];
            assign(child, eq(child.kind, 'group') ? 'parentGroup' : 'expandedGroup', record({ key, familyKey: runFamily,
              uniform, first: j === 0, last: j === children.length - 1 })); push(units, child);
          }
        }
        return cursor;
      });
      index = resume;
      await checkpoint();
    }
    if (responseWork) {
      // Work chapters are another paged presentation level, not an imported
      // native transcript. First collect each existing tool header together
      // with its visible members so its original rows are counted once.
      const items = make('array');
      for (let i = 0; i < units.length;) {
        const unit = units[i], itemUnits = make('array');
        push(itemUnits, unit);
        let end = i + 1;
        if (eq(unit.kind, 'group') && unit.expanded === true) {
          while (end < units.length) {
            const child = units[end];
            if (!eq(child.expandedGroup?.key, unit.key) && !eq(child.parentGroup?.key, unit.key)
              && !(unit.level === 2 && eq(child.expandedSubgroup?.key, unit.key))) break;
            push(itemUnits, child); end++;
          }
        }
        const sourceRows = eq(unit.kind, 'group') ? unit.entries : step(() => {
          const one = arena.make('array'); one.push(unit.entry); return one;
        });
        push(items, record({ units: itemUnits, entries: sourceRows, group: eq(unit.kind, 'group'),
          research: eq(unit.familyKey, 'research') }));
        i = end;
        await checkpoint();
      }
      const workItem = (item, next) => {
        if (!item || item.research) return false;
        const m = entryMetadata.get(item.entries[0]);
        if (!m?.assistant || truth(m.entry?.responseTiming) || eq(m.entry?.textPhase, 'final_answer')) return false;
        if (m.actionCount > 0 && (m.family === null || m.facts.length !== m.actionCount)) return false;
        if (!m.hasText) return m.family !== null || m.thinkingOnly;
        if (eq(m.entry?.textPhase, 'commentary') || eq(m.entry?.textPhase, 'partial_answer')) return true;
        if (m.family !== null) return true;
        if (truth(m.messageId) && memberships.get(m.messageId)?.has('work')) return true;
        const n = next ? entryMetadata.get(next.entries[0]) : null;
        return !!(captionForNext(m, n) && n.family !== null);
      };
      const completedTiming = item => {
        if (!item || item.group) return null;
        const m = entryMetadata.get(item.entries[0]), t = m?.entry?.responseTiming;
        if (!m?.assistant || !m.hasText || eq(m.entry?.textPhase, 'commentary')
          || eq(m.entry?.textPhase, 'partial_answer') || !t) return null;
        const startTs = Number(t.startTs), endTs = Number(t.endTs), durationMs = Number(t.durationMs);
        if (!Number.isFinite(startTs) || !Number.isFinite(endTs) || !Number.isFinite(durationMs)
          || endTs < startTs || durationMs < 0) return null;
        const intervalId = Number(t.intervalId);
        return record({ state: 'completed', intervalId: Number.isFinite(intervalId) ? intervalId : null,
          startTs, endTs, durationMs });
      };
      const projected = make('array');
      let i = 0, timedFinal = null;
      while (i < items.length) {
        if (!workItem(items[i], items[i + 1])) {
          const item = items[i++];
          for (let n = 0; n < item.units.length; n++) {
            const unit = item.units[n];
            if (timedFinal && n === 0 && eq(unit.kind, 'entry')) {
              const copy = step(() => arena.assign(unit)); assign(copy, 'suppressResponseTiming', true); push(projected, copy);
            } else push(projected, unit);
          }
          timedFinal = null;
          await checkpoint();
          continue;
        }
        const members = make('array'), children = make('array');
        let firstTime = null, lastTime = null, timeComplete = true, timeActions = 0;
        let previewEntry = null, previewFact = null, previewRecordTime = null;
        const takeTime = value => {
          if (!value) return;
          if (!firstTime || Date.parse(value.timestamp) < Date.parse(firstTime.timestamp)) firstTime = value;
          if (!lastTime || Date.parse(value.timestamp) > Date.parse(lastTime.timestamp)) lastTime = value;
        };
        const physical = step(() => historyPrimaryPhysicalKey(arena, { kind: 'entry', entry: items[i].entries[0] }));
        const stable = !eq(physical, 'uuid:');
        const key = stable ? concatKey('work:', physical) : null;
        const isOpen = stable && expanded.has(key);
        let end = i;
        while (end < items.length && workItem(items[end], items[end + 1])) {
          for (const member of items[end].entries) {
            push(members, member);
            const memberMeta = entryMetadata.get(member);
            if (memberMeta?.hasText) {
              previewEntry = member; previewFact = null;
              previewRecordTime = recordTime(member?.recordTime);
            } else if (!previewEntry && memberMeta?.facts?.length) {
              previewFact = memberMeta.facts[memberMeta.facts.length - 1];
              const sourceActions = Array.isArray(member?.actionSummary) ? member.actionSummary : member?.actions;
              const lastAction = Array.isArray(sourceActions) ? sourceActions[sourceActions.length - 1] : null;
              previewRecordTime = recordTime(lastAction?.rawTool?.recordTime) || recordTime(lastAction?.recordTime);
            }
            const own = recordTime(member?.recordTime);
            let known = !!own;
            takeTime(own);
            const actions = Array.isArray(member?.actions) && member.actions.length ? member.actions
              : Array.isArray(member?.actionSummary) ? member.actionSummary : [];
            for (const action of actions) {
              const time = recordTime(action?.rawTool?.recordTime) || recordTime(action?.recordTime);
              if (time) { known = true; takeTime(time); }
              else if (!own) timeComplete = false;
              if (++timeActions % 64 === 0) await checkpoint();
            }
            if (!known) timeComplete = false;
            if (members.length % 64 === 0) await checkpoint();
          }
          if (!stable || isOpen) for (const child of items[end].units) {
              push(children, child);
              if (children.length % 64 === 0) await checkpoint();
            }
          end++;
        }
        if (!stable) {
          for (const child of children) push(projected, child);
          i = end; await checkpoint(); continue;
        }
        const tail = end === items.length;
        const stamp = members[0]?.timestamp;
        const firstTimestamp = text.isText(stamp) && stamp.length <= 64 ? scalar(stamp) : '';
        const timing = completedTiming(items[end]);
        if (timing) timedFinal = true;
        const timeAttributes = timeComplete && firstTime && lastTime ? record({
          'data-history-time-key': step(() => text.concat([key, ':time-range'], '', arena)),
          'data-history-time-kind': 'group', 'data-history-time-at': firstTime.timestamp,
          'data-history-time-scope': firstTime.scope, 'data-history-time-source-kind': firstTime.kind,
          'data-history-time-end-at': lastTime.timestamp,
        }) : record({});
        const group = record({ kind: 'group', key, level: 0, familyKey: 'response-work',
          entries: members, facts: make('array'), expanded: isOpen, responseTiming: timing, activeTail: tail,
          firstTimestamp, recordTimeAttributes: timeAttributes, previewEntry, previewFact,
          previewRecordTime: previewRecordTime ? record(previewRecordTime) : null });
        push(projected, group);
        if (isOpen) for (let n = 0; n < children.length; n++) {
          const child = step(() => arena.assign(children[n]));
          assign(child, 'responseWork', record({ key, first: n === 0, last: n === children.length - 1,
            activeTail: tail, firstTimestamp }));
          push(projected, child);
          if (n % 64 === 63) await checkpoint();
        }
        i = end;
        await checkpoint();
      }
      units = projected;
    }
    // Compact headers hold references, never inline members/facts/details.
    // The compatibility unit graph is also paged and retains original source
    // rows by identity; only tests explicitly materialize its complete output.
    const headers = make('array'), nav = make('map'), groups = make('map');
    const rowAddresses = make('map'), keyAddresses = make('map'), firstGroupAddresses = make('map');
    for (let rank = 0; rank < units.length; rank++) {
      let deferredWorkMembers = null, deferredWorkTarget = null;
      step(() => {
        const unit = units[rank], isGroup = eq(unit.kind, 'group');
        const metadata = isGroup ? null : entryMetadata.get(unit.entry);
        const facts = isGroup ? unit.facts : metadata?.facts;
        let inFlightCount = facts ? 0 : undefined, errors = isGroup ? unit.errorCount : facts ? 0 : undefined;
        if (facts) for (const fact of facts) {
          if (fact.inFlight === true) inFlightCount++;
          if (!isGroup && fact.isError === true) errors++;
        }
        const physicalKey = historyPrimaryPhysicalKey(arena, unit);
        const header = record({ kind: unit.kind, key: unit.key, physicalKey, level: unit.level, rank,
          firstUuid: isGroup ? unit.entries[0]?.uuid : unit.entry?.uuid,
          lastUuid: isGroup ? unit.entries[unit.entries.length - 1]?.uuid : unit.entry?.uuid,
          entryCount: isGroup ? unit.entries.length : 1, callCount: facts?.length,
          errorCount: errors, thinkingSeconds: isGroup ? unit.thinkingSeconds : metadata?.thinkingSeconds,
          familyKey: unit.familyKey, docsKind: unit.docsKind, expanded: unit.expanded === true,
          unit, members: isGroup ? unit.entries : undefined, facts,
          captions: unit.captionEntries, captionEntry: unit.captionEntry });
        assign(header, 'inFlightCount', inFlightCount);
        if (facts) assign(header, 'families', familyBreakdown(facts));
        if (isGroup) {
          set(groups, unit.key, rank);
          // Preserve Panel's first-match navigation independently of the
          // existing caption selector's last-key map (duplicate keys can occur).
          if (!firstGroupAddresses.has(unit.key)) set(firstGroupAddresses, unit.key, rank);
        }
        push(headers, header);
        const target = record(isGroup ? { index: rank, groupKey: unit.key } : { index: rank });
        set(keyAddresses, physicalKey, keyAddresses.has(physicalKey) ? -1 : rank);
        const address = row => {
          if (!rowAddresses.has(row)) set(rowAddresses, row, target);
          const uuid = row?.uuid; if (truth(uuid) && !nav.has(uuid)) set(nav, uuid, target);
        };
        if (!isGroup) address(unit.entry);
        else if (unit.expanded !== true) {
          if (eq(unit.familyKey, 'response-work')) {
            deferredWorkMembers = unit.entries; deferredWorkTarget = target;
          } else for (const member of unit.entries) address(member);
        }
      });
      if (deferredWorkMembers) for (let n = 0; n < deferredWorkMembers.length; n++) {
        step(() => {
          const row = deferredWorkMembers[n];
          if (!rowAddresses.has(row)) set(rowAddresses, row, deferredWorkTarget);
          if (truth(row?.uuid) && !nav.has(row.uuid)) set(nav, row.uuid, deferredWorkTarget);
        });
        if (n % 64 === 63) await checkpoint();
      }
      await checkpoint();
    }
    function familyBreakdown(facts) {
      const byFamily = make('map');
      for (const fact of facts) {
        const family = or(fact?.family, 'other'), docsKind = or(fact?.docsKind, '');
        let b = byFamily.get(family);
        if (!b) {
          b = record({ family, docsKind: '', docsKinds: make('set'), count: 0, callCount: 0,
            words: make('map'), subjects: make('array'), targets: make('map'), subjectSeen: make('set') });
          set(byFamily, family, b);
        }
        add(b.docsKinds, docsKind); assign(b, 'callCount', b.callCount + 1);
        const word = eq(family, 'git') ? or(fact.bashDetail, 'git') : eq(family, 'mcp')
          ? or(fact.mcpServer, 'mcp') : or(fact.bashWord, or(fact.toolName, ''));
        if (truth(word)) set(b.words, word, (b.words.get(word) || 0) + 1);
        const subject = or(fact.subject, '');
        if (truth(subject) && !b.subjectSeen.has(subject)) { add(b.subjectSeen, subject); push(b.subjects, subject); }
        const targetKey = or(fact.targetKey, ''), targetLabel = or(fact.targetLabel, subject);
        const key = or(targetKey, targetLabel);
        if (truth(key) && !b.targets.has(key)) set(b.targets, key, targetLabel);
      }
      const result = make('array');
      for (const b of byFamily.values()) {
        assign(b, 'count', b.callCount); assign(b, 'docsKind', b.docsKinds.size === 1 ? first(b.docsKinds) : '');
        step(() => { delete b.docsKinds; delete b.subjectSeen; }); push(result, b);
      }
      return result;
    }
    // Do not publish scratch classification/membership indices as public view
    // fields. Their backing nodes remain reclaimable with this arena/root.
    const envelope = record({ kind: 'history-display-view-v1', units, headers, nav, groups, source, identities, rowAddresses, keyAddresses, firstGroupAddresses,
      sourceCount: source.length, complete: true, frozen: true });
    output = step(() => arena.publish(envelope));
    const stats = { ...metrics, arena: arena.stats() };
    check();
    const view = openHistoryRootDisplayView(store, output, stats);
    output.release(); output = null;
    return view;
  } catch (err) { output?.release(); throw err; }
  finally { arena.close(); }
}

function openHistoryRootDisplayView(store, root, buildStats = null) {
  const arena = new HistoryProjectionArena(store, root);
  let lease = null, closed = false;
  try {
    if (!eq(arena.state().kind, 'history-display-view-v1')) throw error('history_display_view_required');
    lease = root.fork();
  } catch (err) { arena.close(); throw err; }
  const assert = () => { if (closed) throw error('history_display_closed'); arena.assertOpen(); };
  function caption(groupKey, identity = null, previous = false) {
    assert();
    const state = arena.state(), rank = state.groups.get(groupKey);
    if (rank === undefined) return { entry: null, index: -1, count: 0 };
    const list = state.units[rank].captionEntries;
    if (!list?.length) return { entry: null, index: -1, count: 0 };
    const exact = typeof identity === 'string' ? identity.trim() : '';
    let index = list.length - 1;
    if (exact) for (let i = 0; i < list.length; i++) {
      const entry = list[i];
      let found = eq(entry?.uuid, exact) || eq(entry?.sourceIdentity, exact);
      if (!found) for (const name of ['sourceIdentityAliases', 'sourceUuidAliases']) {
        const aliases = entry?.[name];
        if (Array.isArray(aliases)) for (const alias of aliases) if (eq(alias, exact)) { found = true; break; }
        if (found) break;
      }
      if (found) { index = i; break; }
    }
    if (previous) index = (index - 1 + list.length) % list.length;
    return { entry: lease.cursor().field('units').at(rank).field('captionEntries').at(index), index, count: list.length };
  }
  return Object.freeze({
    root: lease,
    get length() { assert(); return arena.state().units.length; },
    unitAt(rank) { assert(); if (!Number.isSafeInteger(rank) || rank < 0 || rank >= arena.state().units.length) return null;
      return lease.cursor().field('units').at(rank); },
    headerAt(rank) { assert(); if (!Number.isSafeInteger(rank) || rank < 0 || rank >= arena.state().headers.length) return null;
      return lease.cursor().field('headers').at(rank); },
    sourceCursor() { assert(); return lease.cursor().field('source'); },
    sourceOrdinal(uuid) { assert(); return arena.state().identities.get(uuid) ?? null; },
    addressForSourceRank(ordinal) {
      assert(); const state = arena.state();
      if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= state.source.length) return null;
      const address = state.rowAddresses.get(state.source[ordinal]);
      return address ? { index: address.index } : null;
    },
    addressForGroup(key) { assert(); const rank = arena.state().firstGroupAddresses.get(key); return rank === undefined ? null : { index: rank }; },
    addressForKey(key) { assert(); const rank = arena.state().keyAddresses.get(key);
      return rank === undefined ? null : rank === -1 ? { ambiguous: true } : { index: rank }; },
    rowByUuid(uuid) { assert(); if (!uuid) return null;
      const ordinal = arena.state().identities.get(uuid);
      return ordinal === undefined ? null : lease.cursor().field('source').at(ordinal); },
    resolveAddress(uuid) { assert(); if (!uuid) return null;
      const result = arena.state().nav.get(uuid);
      return !result ? null : result.groupKey === undefined ? { index: result.index }
        : { index: result.index, groupKey: lease.cursor().field('units').at(result.index).field('key') }; },
    // Explicit compatibility scalar sink. resolveAddress keeps even an
    // arbitrarily long internal key on pages; only this method decodes it.
    resolve(uuid) { assert(); if (!uuid) return null; const result = arena.state().nav.get(uuid);
      return result ? result.groupKey === undefined ? { index: result.index }
        : { index: result.index, groupKey: string(result.groupKey) } : null; },
    caption,
    stats() { assert(); return { build: buildStats, reader: arena.stats(),
      bounds: { rowLookup: 'paged-hash-exact', displayRank: 'paged-vector', navigation: 'paged-hash-exact',
        captionSelection: 'paged-linear-scan', classification: 'finite-full-scan',
        arbitraryGrammarScalarBounded: false, completePrimary: false, actualUI: false, globalMemory: false } }; },
    close() { if (closed) return; closed = true; lease.release(); arena.close(); },
  });
}

module.exports = { createHistoryRootDisplayView, openHistoryRootDisplayView };
