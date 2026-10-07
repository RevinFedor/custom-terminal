import { claudeEffortsForModel } from '../constants/claudeLevels';
import { CODEX_EFFORT_LEVELS, mergeCodexModelOptions } from '../constants/codexSettings';

export function runAfterActionModels({ provider, providerType, claudeSettings, codexSettings, liveCodexModels = [] }: any) {
  if (provider === 'claude') {
    if (providerType !== 'anthropic') return [];
    return claudeSettings.models.filter((model: any) => model.visible !== false)
      .map((model: any) => ({ id: model.id, label: model.label || model.id, efforts: claudeEffortsForModel(model) }))
      .filter((model: any) => model.id && model.efforts.length > 0);
  }
  if (provider !== 'codex') return [];
  return mergeCodexModelOptions(liveCodexModels, codexSettings.models, codexSettings.removedModelIds)
    .filter(model => model.visible !== false)
    .map(model => ({ id: model.id, label: model.label || model.id,
      efforts: model.efforts?.filter(Boolean).length ? model.efforts.filter(Boolean) : [...CODEX_EFFORT_LEVELS] }))
    .filter(model => model.id && model.efforts.length > 0);
}
