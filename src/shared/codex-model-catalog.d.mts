export interface CodexCatalogModel {
  id: string;
  label: string;
  defaultEffort?: string;
  efforts?: string[];
  supportedEfforts?: string[];
  visible?: boolean;
}
export const DEFAULT_CODEX_MODEL: 'gpt-5.5';
export const DEFAULT_CODEX_EFFORT: 'xhigh';
export const CODEX_EFFORT_LEVELS: readonly ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
export const DEFAULT_CODEX_MODEL_OPTIONS: CodexCatalogModel[];
export function normalizeCodexRemovedModelIds(raw: unknown): string[];
export function codexSupportedEffortsForModel(model: Pick<CodexCatalogModel, 'id' | 'efforts' | 'supportedEfforts'> | undefined): string[];
export function normalizeCodexModelOptions(raw: unknown, includeFallback?: boolean, preferRawEffortsAsSupported?: boolean): CodexCatalogModel[];
export function mergeCodexModelOptions(liveRaw: unknown, configuredRaw: unknown, removedModelIds?: unknown): CodexCatalogModel[];
export function projectCodexModelOptions(models: CodexCatalogModel[]): { id: string; label: string; defaultEffort: string; efforts: string[] }[];
