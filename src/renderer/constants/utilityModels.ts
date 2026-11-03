import { GEMINI_MODEL_OPTIONS } from './geminiModels';

// Модели OpenAI, предлагаемые для utility-промптов (названия вкладок и Run
// After, пересказы промптов, тема задачи, описание, сообщение Git-коммита).
// Цены за 1M токенов проверены 03.11.2026 по developers.openai.com/api/docs/pricing.
export const OPENAI_UTILITY_MODEL_OPTIONS = [
  { value: 'gpt-5-nano', label: 'Nano 5' },            // $0.05 / $0.40 — дефолт
  { value: 'gpt-6-luna', label: 'Luna 6' },            // $0.10 / $0.50
  { value: 'gpt-5.4-nano', label: 'Nano 5.4' },        // $0.20 / $1.25
  { value: 'gpt-5-mini', label: 'Mini 5' },            // $0.25 / $2.00
] as const;

export type OpenAIUtilityModelId = typeof OPENAI_UTILITY_MODEL_OPTIONS[number]['value'];

// Промпты, которые ходят через общий utility-провайдер. Для них в Settings
// показываются модели выбранного провайдера, а не только Gemini.
// Сознательно НЕ входят: `timeline-grouping` и `rewind` (остаются на Gemini по
// решению пользователя), `mini-orchestrator-review` (Gemini-специфичный
// tool-calling с thoughtSignature), `run-after-loop` (исполняется агентом
// вкладки своей моделью, а не отдельным API-вызовом).
export const UTILITY_PROMPT_IDS = new Set([
  'tab-title',
  'run-after-title',
  'prompt-summary',
  'task-theme',
  'description',
  'git-commit',
]);

export function isUtilityPromptId(id: unknown): boolean {
  return typeof id === 'string' && UTILITY_PROMPT_IDS.has(id);
}

/** Набор чипов модели для окна редактирования промпта. */
export function modelOptionsForPrompt(promptId: unknown, provider: string) {
  if (isUtilityPromptId(promptId) && provider === 'openai') return OPENAI_UTILITY_MODEL_OPTIONS;
  return GEMINI_MODEL_OPTIONS;
}
