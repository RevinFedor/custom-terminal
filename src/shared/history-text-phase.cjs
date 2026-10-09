'use strict';

// Presentation only. A stable partial answer is not commentary, but it is
// never authority for turn completion, delivery, or the final Timeline target.
function normalizeCodexTextPhase(value) {
  return value === 'commentary' || value === 'partial_answer' || value === 'final_answer'
    ? value : undefined;
}

function isStandaloneHistoryAnswerPhase(value) {
  return value === 'partial_answer' || value === 'final_answer';
}

module.exports = { normalizeCodexTextPhase, isStandaloneHistoryAnswerPhase };
