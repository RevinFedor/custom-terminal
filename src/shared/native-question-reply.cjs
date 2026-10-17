'use strict';

const OPEN = '<send_user_message_question_reply>';
const CLOSE = '</send_user_message_question_reply>';
const CLAUDE_OPEN = 'User has answered your questions: ';
const CLAUDE_CLOSE = ". You can now continue with the user's answers in mind.";
const HASH = /^[a-f0-9]{64}$/;
const object = value => value && typeof value === 'object' && !Array.isArray(value);

// Codex0.162 c1382380, context-fragments/src/answered_question.rs:
// AnsweredQuestion::new takes <=512 UTF-8 bytes at a character boundary,
// then replaces CR and LF individually. Keep this exact wire variant beside
// the original-title hash; arbitrary prefixes/whitespace are NOT equivalent.
// Iterate only the bounded prefix, without Buffer/Node APIs in shared code.
function codexReplyQuestionText(title) {
  let bytes = 0, prefix = '';
  for (const character of title) {
    const code = character.codePointAt(0);
    const width = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    if (bytes + width > 512) break;
    bytes += width;
    prefix += character;
  }
  return prefix.replace(/[\r\n]/g, ' ');
}

function readCodexQuestionReply(content) {
  if (typeof content !== 'string') return null;
  const text = content.trim();
  if (!text.startsWith(OPEN) || !text.endsWith(CLOSE)) return null;
  let rows;
  try { rows = JSON.parse(text.slice(OPEN.length, -CLOSE.length)); } catch { return null; }
  if (!Array.isArray(rows) || !rows.length) return null;
  const ids = new Set(), result = [];
  for (const row of rows) {
    if (!object(row) || Object.keys(row).some(key => !['question', 'answer', 'questionItemId'].includes(key))
      || typeof row.question !== 'string' || typeof row.answer !== 'string' || typeof row.questionItemId !== 'string') return null;
    let id;
    try { id = JSON.parse(row.questionItemId); } catch { return null; }
    if (!Array.isArray(id) || id.length !== 3 || id[0] !== 'request_user_input_async'
      || typeof id[1] !== 'string' || !id[1] || !Number.isSafeInteger(id[2]) || id[2] < 0
      || row.questionItemId !== JSON.stringify(id) || ids.has(row.questionItemId)) return null;
    ids.add(row.questionItemId);
    result.push({ question: row.question, answer: row.answer, callId: id[1], questionIndex: id[2] });
  }
  return result;
}

function codexNativeQuestionDefinition(call, fingerprint) {
  const name = call?.toolName;
  if (!['request_user_input_async', 'functions.request_user_input_async'].includes(name)
    || !['', 'functions'].includes(call.namespace || '') || typeof call.callId !== 'string' || !call.callId
    || !call.sourceIdentity || !call.physicalSessionId || typeof fingerprint !== 'function'
    || !Array.isArray(call.args?.questions) || !call.args.questions.length
    || call.args.questions.some(question => typeof question?.title !== 'string')) return null;
  return { callId: call.callId, sourceIdentity: call.sourceIdentity, physicalSessionId: call.physicalSessionId,
    turnIndex: call.turnIndex, questionHashes: call.args.questions.map(question => fingerprint(question.title)),
    replyQuestionHashes: call.args.questions.map(question => fingerprint(codexReplyQuestionText(question.title))) };
}

function registerNativeQuestionDefinition(definitions, definition) {
  if (!definition) return;
  const previous = definitions.get(definition.callId);
  if (!previous) { definitions.set(definition.callId, definition); return; }
  if (previous.sourceIdentity !== definition.sourceIdentity || previous.physicalSessionId !== definition.physicalSessionId
    || JSON.stringify(previous.questionHashes) !== JSON.stringify(definition.questionHashes)) {
    definitions.set(definition.callId, { ...previous, ambiguous: true });
  }
}

function proveCodexNativeQuestionReply(content, definitions, physicalSessionId, fingerprint) {
  const rows = readCodexQuestionReply(content);
  if (!rows || typeof fingerprint !== 'function') return null;
  const links = [];
  for (const row of rows) {
    const definition = definitions.get(row.callId);
    const questionHash = fingerprint(row.question);
    if (!definition || definition.ambiguous || definition.physicalSessionId !== physicalSessionId
      || (definition.questionHashes[row.questionIndex] !== questionHash
        && definition.replyQuestionHashes?.[row.questionIndex] !== questionHash)) return null;
    links.push({ callId: row.callId, questionIndex: row.questionIndex, questionHash,
      callSourceIdentity: definition.sourceIdentity });
  }
  return { version: 1, provider: 'codex', transportHash: fingerprint(content), links };
}

function claudeQuestions(input) {
  const values = input?.questions;
  if (!Array.isArray(values) || !values.length || values.length > 4
    || values.some(value => typeof value?.question !== 'string')) return null;
  const questions = values.map(value => value.question);
  return new Set(questions).size === questions.length ? questions : null;
}

// Native Claude writes an unescaped, quoted prose carrier. Match only exact
// questions from the linked call and require ONE complete interpretation. An
// answer containing another question's delimiter can be ambiguous: leave it
// literal instead of guessing or silently dropping annotations.
function readClaudeQuestionReply(input, content, data) {
  const questions = claudeQuestions(input);
  if (!questions || typeof content !== 'string') return null;
  const mapped = answers => {
    if (!object(answers) || !Object.keys(answers).length || Object.keys(answers).some(question => (
      !questions.includes(question) || typeof answers[question] !== 'string'
    ))) return null;
    return Object.entries(answers).map(([question, answer]) => ({ question, answer, questionIndex: questions.indexOf(question) }));
  };
  // A single-result record can retain the native tool's structured output.
  // Reconstruct its exact wire text before using it: top-level metadata must
  // not silently supply somebody else's answers or discard preview/notes.
  const structured = object(data) ? data : object(input?.answers) ? input : null;
  if (structured && (!structured.questions
    || Array.isArray(structured.questions) && JSON.stringify(structured.questions.map(question => question?.question)) === JSON.stringify(questions))) {
    const rows = mapped(structured.answers);
    if (rows) {
      let wire = CLAUDE_OPEN;
      for (let index = 0; index < rows.length; index++) {
        const row = rows[index], annotation = structured.annotations?.[row.question];
        if (index) wire += ', ';
        wire += '"' + row.question + '"="';
        row.answerStart = wire.length;
        wire += row.answer;
        row.answerEnd = wire.length;
        wire += '"';
        row.detailsStart = wire.length;
        if (annotation?.preview) wire += ' selected preview:\n' + annotation.preview;
        if (annotation?.notes) wire += ' user notes: ' + annotation.notes;
        row.detailsEnd = wire.length;
      }
      if (wire + CLAUDE_CLOSE === content) return rows;
    }
  }
  try {
    const value = JSON.parse(content);
    if (object(value) && Array.isArray(value.questions)
      && JSON.stringify(value.questions.map(question => question?.question)) === JSON.stringify(questions)
      && !value.annotations) return mapped(value.answers);
  } catch { /* The ordinary native carrier is prose, not JSON. */ }
  if (!content.startsWith(CLAUDE_OPEN) || !content.endsWith(CLAUDE_CLOSE)) return null;
  const body = content.slice(CLAUDE_OPEN.length, -CLAUDE_CLOSE.length), solutions = [];
  const visit = (offset, used, rows) => {
    if (solutions.length > 1) return;
    for (let index = 0; index < questions.length; index++) {
      if (used.has(index)) continue;
      const prefix = '"' + questions[index] + '"="';
      if (!body.startsWith(prefix, offset)) continue;
      const start = offset + prefix.length;
      if (body.endsWith('"')) solutions.push([...rows, {
        question: questions[index], answer: body.slice(start, -1), questionIndex: index,
        answerStart: CLAUDE_OPEN.length + start, answerEnd: content.length - CLAUDE_CLOSE.length - 1,
      }]);
      for (let at = start; at < body.length; at++) {
        if (!body.startsWith('", ', at)) continue;
        const next = at + 3;
        if (!questions.some((question, i) => i !== index && !used.has(i) && body.startsWith('"' + question + '"="', next))) continue;
        const nextUsed = new Set(used); nextUsed.add(index);
        visit(next, nextUsed, [...rows, { question: questions[index], answer: body.slice(start, at), questionIndex: index,
          answerStart: CLAUDE_OPEN.length + start, answerEnd: CLAUDE_OPEN.length + at }]);
      }
    }
  };
  visit(0, new Set(), []);
  return solutions.length === 1 ? solutions[0] : null;
}

function proveClaudeNativeQuestionReply(call, result, fingerprint) {
  if (call?.toolName !== 'AskUserQuestion' || typeof call.callId !== 'string' || !call.callId
    || call.unique !== true || result?.unique !== true || result.toolUseId !== call.callId || result.isError
    || !call.sourceIdentity || !result.sourceIdentity || typeof fingerprint !== 'function') return null;
  const rows = readClaudeQuestionReply(call.args, result.content, result.data);
  if (!rows) return null;
  return { version: 1, provider: 'claude', transportHash: fingerprint(result.content),
    links: rows.map(row => ({ callId: call.callId, questionIndex: row.questionIndex,
      questionHash: fingerprint(row.question), callSourceIdentity: call.sourceIdentity,
      resultSourceIdentity: result.sourceIdentity,
      ...(Number.isSafeInteger(row.answerStart) ? { answerStart: row.answerStart, answerEnd: row.answerEnd } : {}),
      ...(Number.isSafeInteger(row.detailsStart) ? { detailsStart: row.detailsStart, detailsEnd: row.detailsEnd } : {}),
    })) };
}

/** One projection shared by sent History and Timeline. The producer certificate
 * proves the actual call/result link; the full content hash rejects stale,
 * edited or truncated content. It never rewrites the canonical entry. */
function projectNativeQuestionReply(entry, fingerprint) {
  const proof = entry?.questionReplyProof, content = entry?.content;
  if (proof?.version !== 1 || !HASH.test(proof.transportHash || '') || typeof content !== 'string'
    || typeof fingerprint !== 'function' || !Array.isArray(proof.links) || !proof.links.length
    || proof.links.some(link => !object(link))) return null;
  try { if (fingerprint(content) !== proof.transportHash) return null; } catch { return null; }
  let rows;
  if (proof.provider === 'codex') {
    if (!['user', 'queued'].includes(entry.role) && entry.type !== 'user') return null;
    rows = readCodexQuestionReply(content);
  } else if (proof.provider === 'claude') {
    if (entry.toolName !== 'AskUserQuestion' || entry.isError || !entry.toolUseId) return null;
    const questions = claudeQuestions(entry.args);
    if (!questions) return null;
    if (proof.links.every(link => Number.isSafeInteger(link.answerStart))) {
      rows = [];
      const used = new Set();
      for (const link of proof.links) {
        const question = questions[link.questionIndex], prefix = '"' + question + '"="';
        if (typeof question !== 'string' || used.has(link.questionIndex)
          || !Number.isSafeInteger(link.answerEnd) || link.answerStart < prefix.length
          || link.answerEnd < link.answerStart || link.answerEnd >= content.length
          || content.slice(link.answerStart - prefix.length, link.answerStart) !== prefix
          || content[link.answerEnd] !== '"') return null;
        used.add(link.questionIndex);
        let details = '';
        if (link.detailsStart !== undefined || link.detailsEnd !== undefined) {
          if (!Number.isSafeInteger(link.detailsStart) || !Number.isSafeInteger(link.detailsEnd)
            || link.detailsStart !== link.answerEnd + 1 || link.detailsEnd < link.detailsStart
            || link.detailsEnd > content.length - CLAUDE_CLOSE.length) return null;
          details = content.slice(link.detailsStart, link.detailsEnd).trim();
        }
        rows.push({ question, answer: content.slice(link.answerStart, link.answerEnd), details,
          questionIndex: link.questionIndex });
      }
    } else rows = readClaudeQuestionReply(entry.args, content);
  } else return null;
  if (!rows || rows.length !== proof.links.length) return null;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index], link = proof.links[index];
    if (link.questionIndex !== row.questionIndex || link.questionHash !== fingerprint(row.question)
      || !link.callSourceIdentity || link.callId !== (proof.provider === 'claude' ? entry.toolUseId : row.callId)
      || proof.provider === 'claude' && !link.resultSourceIdentity) return null;
  }
  return { kind: 'question-reply', provider: proof.provider, items: rows,
    title: rows.length === 1 ? 'Ответ на вопрос' : 'Ответы на вопросы',
    text: rows.map(row => 'Вопрос: ' + row.question + '\n\nОтвет: ' + row.answer
      + (row.details ? '\n' + row.details : '')).join('\n\n') };
}

module.exports = { readCodexQuestionReply, codexNativeQuestionDefinition, registerNativeQuestionDefinition,
  proveCodexNativeQuestionReply, readClaudeQuestionReply, proveClaudeNativeQuestionReply, projectNativeQuestionReply };
