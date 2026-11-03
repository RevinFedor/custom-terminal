'use strict';

// Выбор провайдера для utility-вызовов AI: сообщение Git-коммита, названия
// вкладок и Run After, пересказы промптов, тема отложенной задачи.
//
// Это НЕ про Claude/Codex-сессии вкладок и НЕ про семантический индекс
// (`ipc/semantic-search.js`, embeddings Gemini с размерностью 768 — смена
// провайдера там означает пересчёт всей базы). AI-Rewind и группировка Timeline
// тоже сюда не входят: они остаются на Gemini по решению пользователя 03.11.2026.
//
// Один модуль на main и renderer, потому что обе стороны делают эти вызовы:
// сообщение коммита — из main (`ipc/git.js`), названия и пересказы — из renderer
// (`utils/generateTabTitle.ts`). Разъехавшиеся копии давали бы разный провайдер
// для соседних строк одной таблицы статистики.

// ↓↓↓ ЕДИНСТВЕННОЕ МЕСТО ПЕРЕКЛЮЧЕНИЯ: 'openai' | 'gemini' ↓↓↓
const UTILITY_AI_PROVIDER = 'openai';
// ↑↑↑

// Модель по умолчанию для utility-задачи выбрана по цене за 1M токенов
// (проверено 03.11.2026): gpt-5-nano $0.05/$0.40 против gemini-3.1-flash-lite
// $0.25/$1.50 — в пять раз дешевле по входу и почти в четыре по выходу.
// gpt-5.4-mini ($0.75/$4.50) для этих задач дороже прежнего Gemini и потому
// не является разумным умолчанием, хотя и отвечает корректно.
//
// Уровень размышления у gpt-5-nano: `minimal`, а не `none` — API отвергает
// `none` для этой модели («Supported values are: minimal, low, medium, high»).
// Поэтому таблица перевода уровней ниже зависит от модели, а не только от
// провайдера: одинаковый для всех `none` сломал бы вызов.
const PROVIDERS = {
  openai: {
    id: 'openai',
    defaultModel: 'gpt-5-nano',
    defaultThinking: 'NONE',
    ownsModel: (model) => /^(gpt-|o[0-9]|chatgpt-)/i.test(model),
  },
  gemini: {
    id: 'gemini',
    defaultModel: 'gemini-3.1-flash-lite',
    defaultThinking: 'NONE',
    ownsModel: (model) => /^gemini-/i.test(model),
  },
};

// Модели OpenAI, которые принимают `none` как минимальный уровень. Остальные
// reasoning-модели ожидают `minimal`. Неизвестная модель получает `minimal`:
// он поддерживается шире и всегда означает «думай как можно меньше».
const OPENAI_SUPPORTS_NONE = /^(gpt-5\.4|gpt-5\.6|gpt-6)/i;

const OPENAI_EFFORT = {
  NONE: 'none',
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  XHIGH: 'xhigh',
};

function openAIEffortForModel(thinking, model) {
  const level = String(thinking || '').trim().toUpperCase();
  const effort = OPENAI_EFFORT[level];
  if (!effort) return null;
  if (effort !== 'none') return effort;
  return OPENAI_SUPPORTS_NONE.test(String(model || '')) ? 'none' : 'minimal';
}

function getUtilityAIProvider(providerId) {
  return PROVIDERS[providerId || UTILITY_AI_PROVIDER] || PROVIDERS.openai;
}

/**
 * Приводит сохранённую в Settings пару модель/размышление к текущему провайдеру.
 *
 * Сохранённая модель принадлежит конкретному провайдеру: в `ai_prompts` у всех
 * utility-записей лежат модели Gemini, и они старше любого дефолта в коде.
 * Без замены такое имя уходит в OpenAI и возвращается ошибкой `model not found`,
 * поэтому модель чужого провайдера заменяется на его default, а факт замены
 * сообщается полем `replacedModel`: вызывающий записывает в журнал фактически
 * вызванную модель, а не ту, что в настройках.
 */
function resolveUtilityAIModel(savedModel, savedThinking, providerId) {
  const provider = getUtilityAIProvider(providerId);
  const model = String(savedModel || '').trim();
  const usable = model && provider.ownsModel(model);
  return {
    provider: provider.id,
    model: usable ? model : provider.defaultModel,
    thinking: String(savedThinking || '').trim() || provider.defaultThinking,
    replacedModel: usable ? null : (model || null),
  };
}

module.exports = {
  UTILITY_AI_PROVIDER,
  getUtilityAIProvider,
  resolveUtilityAIModel,
  openAIEffortForModel,
};
