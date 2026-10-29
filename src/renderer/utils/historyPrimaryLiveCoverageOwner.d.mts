import type { HistoryPrimaryRootReadModel, HistoryPrimaryReadHeader } from './historyPrimaryRootReadModel.mjs';

export interface HistoryPrimaryLiveFold<T> { ownerKey: string; entries: T[] }
export interface HistoryPrimaryLiveDataCommit {
  readonly root: HistoryPrimaryRootReadModel;
  readonly dataSubject: Readonly<object>;
  readonly ownerKey: string;
  readonly generation: number;
}
export interface HistoryPrimaryLiveFoldCommit<T> extends HistoryPrimaryLiveDataCommit {
  readonly live: HistoryPrimaryLiveFold<T>;
  readonly entries: T[];
  readonly fingerprints: readonly string[];
}
export interface HistoryPrimaryLiveCoveragePublication<T> extends HistoryPrimaryLiveDataCommit {
  /** Recheck synchronously after caller coercion and immediately before writes. */
  readonly owns: () => boolean;
  readonly header: HistoryPrimaryReadHeader;
  readonly rows: readonly Readonly<{
    entry: T; fingerprint: string; coveredIdentity: boolean; settingsConflict: boolean;
  }>[];
}
export interface HistoryPrimaryLiveCoverageOwner<T> {
  activate(): void;
  wake(reason?: string): void;
  readUnmatched(ownerKey?: string): Promise<boolean | null>;
  peekUnmatched(ownerKey?: string): boolean | null;
  admits(entry: T, identities: readonly string[], alreadyPresentedLiveIdentities: ReadonlySet<string>): boolean;
  cancelOwner(root: HistoryPrimaryRootReadModel, ownerKey: string, generation: number): void;
  invalidate(): void;
  dispose(): void;
}
export function createHistoryPrimaryLiveCoverageOwner<T>(options: {
  /** Default/full mode validates current values; false is for cheap per-await binding checks only. */
  readCurrent(options?: { verifyValues?: boolean }): {
    root: HistoryPrimaryRootReadModel | null;
    live: HistoryPrimaryLiveFold<T>;
    ownerKey: string;
    generation: number;
    commit: HistoryPrimaryLiveDataCommit | null;
    liveCommit: HistoryPrimaryLiveFoldCommit<T> | null;
  } | null;
  fingerprint(entry: T): string;
  publish(entries: T[], previous: HistoryPrimaryLiveFold<T>, proof: HistoryPrimaryLiveCoveragePublication<T>): HistoryPrimaryLiveFold<T> | null;
  onError?(error: unknown): void;
}): HistoryPrimaryLiveCoverageOwner<T>;
