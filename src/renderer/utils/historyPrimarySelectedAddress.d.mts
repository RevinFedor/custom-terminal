import type { HistoryPrimaryRootReadModel, HistoryPrimaryReadHeader, HistoryPrimaryPresentationAddress,
  HistoryPrimaryReadOptions } from './historyPrimaryRootReadModel.mjs';
import type { readHistoryPrimaryPanelAddress } from './historyPrimaryPanelBindings.mjs';
export type HistoryPrimarySelectedKind = 'key' | 'entry' | 'group' | 'identity';
export interface HistoryPrimarySelectedResolution {
  status: 'pending' | 'superseded' | 'ready' | 'absent' | 'failed';
  root: HistoryPrimaryRootReadModel; header: HistoryPrimaryReadHeader | null;
  address: HistoryPrimaryPresentationAddress | null; error?: unknown;
}
export interface HistoryPrimarySelectedState extends HistoryPrimarySelectedResolution {
  kind: HistoryPrimarySelectedKind; identity: string;
  promise: Promise<HistoryPrimarySelectedState>;
}
export interface HistoryPrimarySelectedAddress {
  read(root: HistoryPrimaryRootReadModel, kind: HistoryPrimarySelectedKind, identity: string,
    options?: HistoryPrimaryReadOptions & {address?: HistoryPrimaryPresentationAddress | null}): HistoryPrimarySelectedState;
  seed(root: HistoryPrimaryRootReadModel, kind: HistoryPrimarySelectedKind, identity: string,
    address: HistoryPrimaryPresentationAddress, options?: HistoryPrimaryReadOptions): HistoryPrimarySelectedState;
  resolve(root: HistoryPrimaryRootReadModel, kind: HistoryPrimarySelectedKind, identity: string,
    options?: HistoryPrimaryReadOptions): Promise<HistoryPrimarySelectedState>;
  resolveKeyOrTarget(root: HistoryPrimaryRootReadModel, key: string | null, identity: string | null,
    options?: HistoryPrimaryReadOptions): Promise<HistoryPrimarySelectedResolution | null>;
  peek(root: HistoryPrimaryRootReadModel, kind: HistoryPrimarySelectedKind, identity: string): HistoryPrimarySelectedState | null;
  clear(): void; dispose(): void;
  stats(): {selected: number; running: number; pending: number};
}
export function createHistoryPrimarySelectedAddress(options?: {
  read?: typeof readHistoryPrimaryPanelAddress; onError?: (error: unknown) => void;
}): HistoryPrimarySelectedAddress;
