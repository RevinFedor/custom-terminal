export const GEMINI_MODEL_OPTIONS = [
  { value: 'gemini-3.5-flash', label: 'Flash 3.5' },
  { value: 'gemini-3.1-flash-lite', label: 'Flash-Lite 3.1' },
  { value: 'gemini-3.1-pro-preview', label: 'Pro 3.1' },
  { value: 'gemini-3-flash-preview', label: 'Flash 3' },
] as const;

export type GeminiModelId = typeof GEMINI_MODEL_OPTIONS[number]['value'];

export function isGeminiModelId(value: unknown): value is GeminiModelId {
  return typeof value === 'string' && GEMINI_MODEL_OPTIONS.some((m) => m.value === value);
}
