export interface HistoryPrimaryEffectiveSettings {
  model?: string;
  effort?: string;
  proofAt: number;
  proof: 'rollout-turn-context';
}
export function readHistoryPrimaryEffectiveSettings(reader: any, header: any, options?: {
  signal?: AbortSignal;
  owns?: () => boolean;
  invoke?: (channel: string, payload: any) => Promise<any>;
}): Promise<Readonly<HistoryPrimaryEffectiveSettings> | null>;
