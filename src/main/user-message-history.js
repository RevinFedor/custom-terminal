'use strict';

const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { isServicePromptEntry, getTabMessageTag } = require('../shared/prompt-origin.cjs');
const { historyReadError } = require('./history-session-resolution');

const KINDS = ['user', 'context-only', 'project-instructions', 'agent-message', 'service', 'compact', 'continuation'];
const SEARCH_METADATA_CHARS = 128000;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const canonical = value => JSON.stringify(value);
const clean = value => typeof value === 'string' ? value.trim() : '';
const normalize = value => String(value || '').normalize('NFKC').toLocaleLowerCase();
let parsers;
async function getParsers() {
  if (!parsers) parsers = (async () => {
    const chips = await import(pathToFileURL(path.join(__dirname, '../shared/composer-chips.mjs')).href);
    const { unified } = await import('unified');
    const { default: markdown } = await import('remark-parse');
    return { parseParts: chips.parsePastedContentParts, markdown: unified().use(markdown) };
  })();
  return parsers;
}

function omitQuotedMarkdown(text, markdown) {
  const excluded = [];
  const walk = node => {
    if (['code', 'inlineCode', 'blockquote'].includes(node.type)) {
      const start = node.position?.start?.offset, end = node.position?.end?.offset;
      if (Number.isInteger(start) && Number.isInteger(end)) excluded.push([start, end]);
      return;
    }
    for (const child of node.children || []) walk(child);
  };
  walk(markdown.parse(text));
  let offset = 0, result = '';
  for (const [start, end] of excluded.sort((a, b) => a[0] - b[0])) {
    result += text.slice(offset, start) + text.slice(start, end).replace(/[^\r\n]/g, ' ');
    offset = end;
  }
  return result + text.slice(offset);
}

function removeProjectPrefix(value) {
  let text = value.trimStart(), removed = false;
  // Only a complete leading provider envelope can be removed. A request after
  // it is still user text; a malformed envelope stays visible and unclassified.
  for (;;) {
    const heading = /^#\s+(?:AGENTS\.md|CLAUDE\.md) instructions for [^\r\n]+\r?\n\s*/i.exec(text);
    if (heading) {
      const body = text.slice(heading[0].length);
      if (!/^<instructions\s*>/i.test(body)) break;
      let depth = 0, end = null;
      for (const tag of body.matchAll(/<\/?instructions\s*>/gi)) {
        depth += tag[0][1] === '/' ? -1 : 1;
        if (depth === 0) { end = tag.index + tag[0].length; break; }
      }
      if (end == null) break;
      text = body.slice(end).trimStart(); removed = true; continue;
    }
    const environment = /^<(environment_context|permissions instructions|collaboration_mode|turn_aborted)\b[^>]*>[\s\S]*?<\/\1>\s*/.exec(text);
    if (!environment) break;
    text = text.slice(environment[0].length).trimStart(); removed = true;
  }
  return { text, removed };
}

async function classifyUserMessage({ text, turn, entry = {} }) {
  if (turn.kind === 'compact_summary' || turn.kind === 'compact_boundary' || !turn.userUuid) {
    return { kind: turn.userUuid ? 'compact' : 'continuation', classificationEvidence: turn.userUuid ? 'provider-compact' : 'no-user-carrier',
      prompts: [], contextUpdates: [], userTailChars: 0, hasUserTail: false, userPreview: '' };
  }
  const { parseParts, markdown } = await getParsers();
  const promptNames = [], contextUpdates = [];
  const masked = text.includes('<saved_prompt') ? omitQuotedMarkdown(text, markdown) : text;
  const parts = parseParts(masked);
  for (const part of parts) {
    if (part.kind !== 'prompt-wrapper') continue;
    if (part.contextUpdateId) contextUpdates.push({ id: part.contextUpdateId, title: part.label });
    else promptNames.push({ name: part.label, evidence: 'saved-prompt-wrapper', activation: 'unproven',
      ...(part.inheritanceDepth ? { inheritanceDepth: part.inheritanceDepth, inheritanceParent: part.inheritanceParentLabel } : {}) });
  }
  // Parsing unmasked text preserves quoted examples and the actual user tail.
  const authored = parseParts(text).filter(part => part.kind !== 'prompt-wrapper' && part.kind !== 'context-file-wrapper')
    .map(part => part.text || '').join('');
  const prefix = removeProjectPrefix(authored);
  const hasAuthoredText = !!prefix.text.trim();
  let kind = 'user', evidence = 'provider-user-carrier';
  if (turn.kind === 'compact_summary' || turn.kind === 'compact_boundary') { kind = 'compact'; evidence = 'provider-compact'; }
  else if (!turn.userUuid) { kind = 'continuation'; evidence = 'no-user-carrier'; }
  else if (isServicePromptEntry(entry)) {
    kind = getTabMessageTag(entry) || entry.semanticTags?.some(tag => tag.kind === 'orchestration') ? 'agent-message' : 'service';
    evidence = 'durable-semantic-tag';
  } else if (/^\s*(?:\[Tab message: (?:question|reply)\]\r?\nMessage ID: [^\r\n]+\r?\nFrom:|\[Оркестрация\]|<task-notification>|<agent-message\b)/.test(prefix.text)) {
    kind = 'agent-message'; evidence = 'service-envelope';
  } else if (!hasAuthoredText && !promptNames.length && prefix.removed) { kind = 'project-instructions'; evidence = 'complete-provider-envelope'; }
  else if (!hasAuthoredText && !promptNames.length && contextUpdates.length) { kind = 'context-only'; evidence = 'context-update-wrapper'; }
  else if (/^\s*<(?:command-name|local-command-stdout|local-command-stderr|local-command-caveat|system-reminder)\b/.test(prefix.text)
    || /^\s*\[Request interrupted/.test(prefix.text)) { kind = 'service'; evidence = 'provider-service-envelope'; }
  return { kind, classificationEvidence: evidence, prompts: promptNames, contextUpdates,
    userTailChars: prefix.text.trim().length, hasUserTail: hasAuthoredText,
    userPreview: prefix.text.trim().slice(0, 500) };
}

function integer(value, fallback, min, max, name) {
  if (value == null) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw fail('history_query_invalid', `${name} must be ${min}..${max}`);
  return number;
}

function dateValue(value, name) {
  if (value == null || value === '') return null;
  const date = Date.parse(String(value));
  if (!Number.isFinite(date)) throw fail('history_query_invalid', `${name} must be an ISO date or timestamp`);
  return date;
}

function encodeCursor(value) { return Buffer.from(canonical(value)).toString('base64url'); }
function decodeCursor(value, mode, queryHash) {
  if (!value) return null;
  let cursor;
  try {
    if (typeof value !== 'string' || value.length > 16000) throw Error('size');
    cursor = JSON.parse(Buffer.from(value, 'base64url').toString());
  } catch { throw fail('history_cursor_invalid', 'Invalid history cursor'); }
  if (cursor.version !== 1 || cursor.mode !== mode || cursor.queryHash !== queryHash) {
    throw fail('history_cursor_mismatch', 'Cursor belongs to a different query');
  }
  for (const key of ['session', 'turn', 'index', 'offset', 'failed', 'visited']) {
    if (cursor[key] != null && (!Number.isSafeInteger(cursor[key]) || cursor[key] < 0)) throw fail('history_cursor_invalid', 'Invalid cursor position');
  }
  const positions = mode === 'search' ? ['session', 'turn', 'visited', 'failed', 'asOf'] : ['index', 'offset', 'failed'];
  if (positions.some(key => !Number.isSafeInteger(cursor[key]) || cursor[key] < 0)
    || (mode === 'search' && !/^[a-f0-9]{64}$/.test(cursor.catalogHash || ''))) {
    throw fail('history_cursor_invalid', 'Incomplete cursor');
  }
  return cursor;
}

function sourceRevision(data) {
  return hash(canonical([data.sessionId, data.contentRevision || null, data.sourceSnapshot || null, data.mtimeMs, data.size]));
}

function safeEnd(text, start, length) {
  let end = Math.min(text.length, start + length);
  if (end < text.length && end > start && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end -= 1;
  return end;
}

class UserMessageHistory {
  constructor({ listCandidates, loadSession, extractText, decorateEntries = entries => entries, getFork = () => null, logger = console }) {
    Object.assign(this, { listCandidates, loadSession, extractText, decorateEntries, getFork, logger });
  }

  async *rows(data, candidate, from = 0) {
    const entries = data.turns.map(turn => ({ uuid: turn.userUuid, timestamp: turn.userTimestamp,
      role: 'user', content: this.extractText(data.recordMap.get(turn.userUuid)) || '' }));
    const decorated = await this.decorateEntries(entries, data.engine || candidate.provider || 'claude', data.sessionId);
    const fork = await this.getFork(data.sessionId);
    const inherited = new Set(fork?.snapshotComplete === true ? fork.entryUuids || [] : []);
    const evidenceUsers = data.engine === 'codex'
      ? new Set((data.timelineEntries || []).filter(row => row.type === 'user').map(row => row.uuid)) : null;
    let evidenceTurn = null;
    for (let index = 0; index < data.turns.length; index += 1) {
      const turn = data.turns[index], entry = decorated[index] || entries[index];
      const text = entries[index].content;
      if (turn.userUuid && ['user', 'queued_command'].includes(turn.kind)
        && (!evidenceUsers || evidenceUsers.has(turn.userUuid))) evidenceTurn = index;
      if (index < from) continue;
      const classification = await classifyUserMessage({ text, turn, entry });
      const physicalInherited = turn.physicalSessionId && turn.physicalSessionId !== data.sessionId;
      yield { sessionId: data.sessionId, provider: data.engine || candidate.provider || 'claude',
        turnIndex: index, userUuid: turn.userUuid || null, timestamp: turn.userTimestamp || null,
        carrierKind: turn.kind, ...classification, chars: text.length, text,
        ref: { sessionId: data.sessionId, turnIndex: index, userUuid: turn.userUuid || null, textHash: hash(text) },
        evidenceTurnIndex: evidenceTurn,
        evidenceAddress: evidenceTurn === index ? 'exact-user' : classification.kind === 'continuation' && evidenceTurn != null
          ? 'previous-real-user' : 'unavailable-for-this-carrier',
        copyStatus: physicalInherited || inherited.has(turn.userUuid) ? 'inherited'
          : fork || data.sessionMeta?.forked_from_id ? 'unknown-fork-boundary' : 'no-known-fork',
        sourceSessionId: physicalInherited ? turn.physicalSessionId : fork?.sourceSessionId || data.sessionMeta?.forked_from_id || null,
        usageProof: 'not-established',
      };
      if (index % 50 === 49) await new Promise(resolve => setImmediate(resolve));
    }
  }

  async search(input = {}) {
    const startedAt = Date.now();
    const project = clean(input.project);
    const sessionIds = input.sessionIds;
    if ((!project && !Array.isArray(sessionIds)) || (project && sessionIds != null)) throw fail('history_query_scope_required', 'Choose a project or explicit sessionIds');
    if (sessionIds != null && (!sessionIds.length || sessionIds.length > 100 || sessionIds.some(id => !/^[\da-f-]{36}$/i.test(id)))) throw fail('history_query_invalid', 'sessionIds must contain 1..100 session UUIDs');
    const kinds = input.kinds == null ? ['user'] : input.kinds;
    if (!Array.isArray(kinds) || !kinds.length || kinds.some(kind => !KINDS.includes(kind))) throw fail('history_query_invalid', 'Unknown message classification');
    const filters = { project, sessionIds: sessionIds ? [...new Set(sessionIds)] : null, kinds: [...new Set(kinds)].sort(),
      dateFrom: dateValue(input.dateFrom, 'dateFrom'), dateTo: dateValue(input.dateTo, 'dateTo'),
      query: clean(input.query), promptName: clean(input.promptName), caseSensitive: input.caseSensitive === true };
    if (filters.dateFrom != null && filters.dateTo != null && filters.dateFrom >= filters.dateTo) throw fail('history_query_invalid', 'dateFrom must precede dateTo');
    const limit = integer(input.limit, 50, 1, 200, 'limit');
    const sessionLimit = integer(input.sessionLimit, 5, 1, 25, 'sessionLimit');
    const queryHash = hash(canonical(filters));
    const cursor = decodeCursor(input.cursor, 'search', queryHash);
    const catalog = await this.listCandidates(filters);
    const catalogHash = hash(canonical(catalog.map(row => [row.provider, row.sessionId, row.cwd])));
    if (cursor && cursor.catalogHash !== catalogHash) throw fail('history_cursor_catalog_changed', 'Session catalog changed; restart the query', 409);
    const asOf = cursor?.asOf || Date.now();
    let session = cursor?.session || 0, turn = cursor?.turn || 0, visited = cursor?.visited || 0, failed = cursor?.failed || 0;
    if (session > catalog.length) throw fail('history_cursor_invalid', 'Cursor is beyond the catalog');
    const messages = [], errors = [];
    let metadataChars = 0;
    let source = null, touched = 0, unknownTimestamps = cursor?.unknownTimestamps || 0;
    for (; session < catalog.length && touched < sessionLimit; session += 1, turn = 0) {
      const candidate = catalog[session]; touched += 1;
      let data;
      try { data = await this.loadSession(candidate.sessionId, candidate.cwd, { provider: candidate.provider }); }
      catch (error) { failed += 1; visited += 1; errors.push({ sessionId: candidate.sessionId, ...historyReadError(error) }); continue; }
      source = sourceRevision(data);
      if (cursor?.session === session && cursor.source && cursor.source !== source) throw fail('history_cursor_source_changed', 'History changed while paging this session; restart the query', 409);
      const rowCount = data.turns.length;
      for await (const row of this.rows(data, candidate, turn)) {
        turn = row.turnIndex + 1;
        if (!filters.kinds.includes(row.kind)) continue;
        const time = Date.parse(row.timestamp || '');
        if (!Number.isFinite(time)) { unknownTimestamps += 1; if (filters.dateFrom != null || filters.dateTo != null) continue; }
        if (time > asOf || (filters.dateFrom != null && time < filters.dateFrom) || (filters.dateTo != null && time >= filters.dateTo)) continue;
        if (filters.promptName && !row.prompts.some(prompt => normalize(prompt.name) === normalize(filters.promptName))) continue;
        const haystack = filters.caseSensitive ? row.text : normalize(row.text);
        if (filters.query && !haystack.includes(filters.caseSensitive ? filters.query : normalize(filters.query))) continue;
        const { text, ...summary } = row;
        const item = { ...summary, prompts: summary.prompts.slice(0, 50).map(prompt => ({ ...prompt,
            name: prompt.name.slice(0, 500), nameTruncated: prompt.name.length > 500,
            ...(prompt.inheritanceParent ? { inheritanceParent: prompt.inheritanceParent.slice(0, 500), inheritanceParentTruncated: prompt.inheritanceParent.length > 500 } : {}) })),
          promptCount: summary.prompts.length, promptsTruncated: summary.prompts.length > 50,
          contextUpdates: summary.contextUpdates.slice(0, 50).map(update => ({ id: update.id.slice(0, 500), title: update.title.slice(0, 500),
            truncated: update.id.length > 500 || update.title.length > 500 })),
          contextUpdateCount: summary.contextUpdates.length, contextUpdatesTruncated: summary.contextUpdates.length > 50,
          projectId: candidate.projectId || null, tabId: candidate.tabId || null,
          title: candidate.title?.slice(0, 500) || null, titleTruncated: (candidate.title?.length || 0) > 500 };
        const itemChars = canonical(item).length;
        if (messages.length && metadataChars + itemChars > SEARCH_METADATA_CHARS) { turn = row.turnIndex; break; }
        metadataChars += itemChars;
        messages.push(item);
        if (messages.length >= limit) break;
      }
      if (turn < rowCount) break;
      visited += 1; source = null;
      if (messages.length >= limit) { session += 1; turn = 0; break; }
    }
    const scanComplete = session >= catalog.length;
    const nextCursor = scanComplete ? null : encodeCursor({ version: 1, mode: 'search', queryHash, catalogHash, asOf,
      session, turn, source, visited, failed, unknownTimestamps });
    this.logger.log('[UserMessageHistory] search candidates=' + catalog.length + ' visited=' + touched + ' returned=' + messages.length + ' errors=' + errors.length + ' more=' + !!nextCursor + ' ms=' + (Date.now() - startedAt));
    return { messages, errors, nextCursor, scanComplete, coverageComplete: scanComplete && failed === 0 && unknownTimestamps === 0,
      candidateTotal: catalog.length, visitedSessions: visited, failedSessions: failed, unknownTimestamps,
      snapshotAt: new Date(asOf).toISOString(), order: 'session-catalog-then-turn', metadataChars, metadataBudgetChars: SEARCH_METADATA_CHARS,
      usageCounting: 'records-not-unique-prompt-uses', rangeUnit: 'utf16', limit, sessionLimit };
  }

  async read(input = {}) {
    const startedAt = Date.now();
    const refs = input.messages;
    if (!Array.isArray(refs) || !refs.length || refs.length > 100) throw fail('history_query_invalid', 'messages must contain 1..100 exact references');
    for (const ref of refs) {
      if (!/^[\da-f-]{36}$/i.test(ref?.sessionId || '') || !Number.isSafeInteger(ref.turnIndex) || ref.turnIndex < 0
        || !(typeof ref.userUuid === 'string' || ref.userUuid === null) || !/^[a-f0-9]{64}$/.test(ref.textHash || '')) throw fail('history_query_invalid', 'Use exact message refs from search_user_messages');
    }
    const maxChars = integer(input.maxChars, 60000, 256, 250000, 'maxChars');
    const queryHash = hash(canonical(refs));
    const cursor = decodeCursor(input.cursor, 'read', queryHash);
    let index = cursor?.index || 0, offset = cursor?.offset || 0, remaining = maxChars, failed = cursor?.failed || 0;
    if (index >= refs.length) throw fail('history_cursor_invalid', 'Cursor is beyond selected messages');
    let currentSession = null, currentData = null, loadedSessions = 0;
    const messages = [], errors = [];
    for (; index < refs.length; index += 1, offset = 0) {
      const ref = refs[index];
      let data = currentSession === ref.sessionId ? currentData : null;
      if (!data) {
        try { data = await this.loadSession(ref.sessionId, null); }
        catch (error) { data = { readError: error }; }
        currentSession = ref.sessionId; currentData = data; loadedSessions += 1;
      }
      if (data.readError) { failed += 1; errors.push({ ref, ...historyReadError(data.readError) }); continue; }
      const turn = data.turns[ref.turnIndex];
      const text = this.extractText(data.recordMap.get(turn?.userUuid)) || '';
      if (!turn || (turn.userUuid || null) !== ref.userUuid || hash(text) !== ref.textHash) {
        failed += 1; errors.push({ ref, error: 'Selected message identity or text changed', code: 'history_message_changed' }); continue;
      }
      if (offset > text.length) throw fail('history_cursor_invalid', 'Cursor exceeds message length');
      if (offset > 0 && /[\uD800-\uDBFF]/.test(text[offset - 1]) && /[\uDC00-\uDFFF]/.test(text[offset] || '')) {
        throw fail('history_cursor_invalid', 'Cursor splits a surrogate pair');
      }
      const end = safeEnd(text, offset, remaining);
      if (end === offset && text.length > offset) break;
      messages.push({ ref, timestamp: turn.userTimestamp || null, carrierKind: turn.kind,
        text: text.slice(offset, end), start: offset, end, totalChars: text.length,
        truncatedBefore: offset > 0, truncatedAfter: end < text.length });
      remaining -= end - offset;
      if (end < text.length) { offset = end; break; }
      if (remaining === 0) { index += 1; offset = 0; break; }
    }
    const nextCursor = index < refs.length ? encodeCursor({ version: 1, mode: 'read', queryHash, index, offset, failed }) : null;
    this.logger.log('[UserMessageHistory] read sessions=' + loadedSessions + ' returned=' + messages.length + ' errors=' + errors.length + ' chars=' + (maxChars - remaining) + ' ms=' + (Date.now() - startedAt));
    return { messages, errors, nextCursor, complete: !nextCursor && failed === 0, failedMessages: failed, maxChars, rangeUnit: 'utf16' };
  }
}

module.exports = { UserMessageHistory, classifyUserMessage, removeProjectPrefix, KINDS };
