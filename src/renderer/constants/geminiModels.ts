export const GEMINI_MODEL_OPTIONS = [
  { value: 'gemini-3.8-flash', label: 'Flash 3.8' },
  { value: 'gemini-3.5-flash-lite', label: 'Flash-Lite 3.5' },
  { value: 'gemini-3.1-pro-preview', label: 'Pro 3.1' },
  { value: 'gemini-3.7-flash', label: 'Flash 3.7' },
] as const;

// Saved prompt/model selections are user-owned. Keep older exact IDs readable
// and executable until the user chooses a newer chip explicitly.
export const GEMINI_LEGACY_MODEL_OPTIONS = [
  { value: 'gemini-3.5-flash', label: 'Flash 3.5' },
  { value: 'gemini-3.1-flash-lite', label: 'Flash-Lite 3.1' },
  { value: 'gemini-3-flash-preview', label: 'Flash 3' },
] as const;

export type GeminiModelId = typeof GEMINI_MODEL_OPTIONS[number]['value']
  | typeof GEMINI_LEGACY_MODEL_OPTIONS[number]['value'];

export function isGeminiModelId(value: unknown): value is GeminiModelId {
  return typeof value === 'string' && (GEMINI_MODEL_OPTIONS.some((m) => m.value === value)
    || GEMINI_LEGACY_MODEL_OPTIONS.some((m) => m.value === value));
}

export function legacyGeminiModelLabel(value: string): string | null {
  return GEMINI_LEGACY_MODEL_OPTIONS.find(model => model.value === value)?.label || null;
}
