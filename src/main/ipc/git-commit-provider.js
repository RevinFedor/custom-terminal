'use strict';

// Привязка utility-провайдера к функции вызова на стороне main.
//
// Какой провайдер выбран и какая у него модель по умолчанию — решает общий
// `shared/utility-ai-provider.cjs` (его же читает renderer для названий вкладок
// и пересказов). Здесь остаётся только то, чего в shared быть не может:
// сопоставление провайдера с его main-функцией вызова. Обе функции —
// `callGeminiApi` и `callOpenAIApi` — имеют общий контракт
// `(system, prompt, model, thinking) -> { success, text, usage }`, поэтому
// пайплайн в `ipc/git.js` провайдера не знает.

const { callGeminiApi } = require('./gemini-api');
const { callOpenAIApi } = require('./openai-api');
const { resolveUtilityAIModel, UTILITY_AI_PROVIDER } = require('../../shared/utility-ai-provider.cjs');

const CALLS = {
  openai: callOpenAIApi,
  gemini: callGeminiApi,
};

/**
 * Возвращает фактическую пару модель/размышление для текущего провайдера плюс
 * саму функцию вызова. `replacedModel` непустой, когда в Settings сохранена
 * модель другого провайдера: вызывающий обязан записать в журнал `model`, а не
 * сохранённое значение.
 */
function resolveGitCommitModel(savedModel, savedThinking, providerId) {
  const resolved = resolveUtilityAIModel(savedModel, savedThinking, providerId);
  return { ...resolved, call: CALLS[resolved.provider] || callOpenAIApi };
}

module.exports = {
  GIT_COMMIT_PROVIDER: UTILITY_AI_PROVIDER,
  resolveGitCommitModel,
};
