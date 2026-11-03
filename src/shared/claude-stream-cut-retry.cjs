'use strict';

// Anthropic can drop the response stream in the middle of an already running
// turn. Claude Code writes a synthetic assistant record for it and stops; the
// turn simply ends with a partial answer and no further work:
//
//   { type: 'assistant', isApiErrorMessage: true, error: 'server_error',
//     streamCutCause: 'server_error', truncatedAfterOutput: true,
//     message: { model: '<synthetic>', content: [{ type: 'text',
//       text: 'API Error: Server error mid-response. The response above may be
//              incomplete.' }] } }
//
// Production 02.11.2026, session be82a19d, record 15ce6c4b at 10:16:28 UTC.
//
// Decision 02.11 (Fedor): always continue automatically, exactly like the
// Codex model-capacity retry. A manual "Continue" button would have sent the
// same word and protected nothing — the risk is identical, it would only cost
// the user a click. Claude also sees the whole transcript on continuation, so
// a tool that already ran is visible to it and is not replayed blindly.
//
// This module is PURE recognition. It decides nothing about sending; the
// caller owns admission, delivery and the shared retry policy.

const STREAM_CUT_CAUSES = new Set(['server_error', 'overloaded_error', 'api_error']);

// Only Claude's own synthetic error carrier qualifies. A quoted error inside
// an ordinary answer, a user prompt or a tool result must never arm a retry.
function claudeStreamCutFromRecord(record) {
  if (!record || record.isSidechain === true) return null;
  if (record.type !== 'assistant' || record.isApiErrorMessage !== true) return null;
  const cause = typeof record.streamCutCause === 'string' ? record.streamCutCause : '';
  if (!STREAM_CUT_CAUSES.has(cause)) return null;
  // A rate limit is a different lane: it has its own usage-limit presentation
  // and waiting rules, and continuing immediately would just hit it again.
  const status = Number(record.apiErrorStatus);
  if (status === 429 || record.error === 'rate_limit_error') return null;

  const content = record.message?.content;
  const text = typeof content === 'string' ? content : (Array.isArray(content) ? content : [])
    .filter(block => block?.type === 'text')
    .map(block => block.text || '')
    .join('\n')
    .trim();

  // The turn's own identity. A record without one cannot be deduplicated
  // against later deliveries of the same error, so it is not retryable.
  const errorId = typeof record.uuid === 'string' && record.uuid ? record.uuid : '';
  if (!errorId) return null;

  return {
    errorId,
    cause,
    // `truncatedAfterOutput` says part of the answer already reached the
    // transcript. It does NOT change whether we continue — it is kept because
    // the log and the notification read better when they can say so.
    truncatedAfterOutput: record.truncatedAfterOutput === true,
    message: text || 'API Error: Server error mid-response.',
    sessionId: typeof record.sessionId === 'string' ? record.sessionId : null,
  };
}

module.exports = { STREAM_CUT_CAUSES, claudeStreamCutFromRecord };
