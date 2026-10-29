import type { HistoryPrimaryRootReadModel, HistoryPrimaryReadHeader, HistoryPrimaryPresentationAddress,
  HistoryPrimaryPresentationTarget, HistoryPrimaryReadOptions } from './historyPrimaryRootReadModel.mjs';
export interface HistoryPrimaryPanelInputState {
  witness?: HistoryPrimaryPanelWitness | null;
  root: HistoryPrimaryRootReadModel | null; header: HistoryPrimaryReadHeader | null;
  ownerKey: string; entries: any[]; live: any; results: any; rewind: any;
  ownerGeneration?: number;
  presentation: any; suppressions: Map<any, any>; captions: Map<any, any>;
}
export interface HistoryPrimaryPanelWitness {
  readonly root: HistoryPrimaryRootReadModel; readonly header: HistoryPrimaryReadHeader;
  readonly ownerKey: string; readonly entries: WeakRef<any[]>; readonly rewind: any;
  readonly fingerprint: string | null; readonly settingsKeys: WeakRef<any[]>;
}
export type HistoryPrimaryInputFingerprint = (value: any) => string;
declare const settingsCachePublicationBrand: unique symbol;
export interface HistoryPrimarySettingsCachePublication { readonly [settingsCachePublicationBrand]: true; }
export function captureHistoryPrimarySettingsCachePublication(root: HistoryPrimaryRootReadModel | null,
  entries: any[], output: any[], scope: {cacheWasEmpty: boolean; ownerKey: string; ownerGeneration: number}):
  HistoryPrimarySettingsCachePublication | null;
export interface HistoryPrimaryInputTransaction {
  current(): boolean;
  /** Synchronous only; a thenable result throws and never extends proof lifetime. */
  run<T>(callback: () => T extends PromiseLike<any> ? never : T): T;
  invalidate(): void;
  rebaseSettingsCache(receipt: HistoryPrimarySettingsCachePublication | null, applied: any, presentation: any):
    HistoryPrimaryPanelWitness | null;
}
export function historyPrimaryPanelInputFingerprint(presentation: any, suppressions: Iterable<any>,
  captions: Iterable<any>, fingerprint: HistoryPrimaryInputFingerprint): string | null;
export function captureHistoryPrimaryPanelWitness(input: {
  root: HistoryPrimaryRootReadModel; header: HistoryPrimaryReadHeader; ownerKey: string;
  entries: any[]; rewind: any; presentation: any; fingerprint: string | null;
}): HistoryPrimaryPanelWitness;
export function historyPrimaryPanelWitnessCurrent(witness: HistoryPrimaryPanelWitness | null,
  current: HistoryPrimaryPanelInputState, fingerprint: HistoryPrimaryInputFingerprint): boolean;
export function createHistoryPrimaryPanelInputTransaction(readCurrent: () => HistoryPrimaryPanelInputState,
  fingerprint: HistoryPrimaryInputFingerprint): HistoryPrimaryInputTransaction;
export interface HistoryPrimaryPanelAddressResult {
  readonly root: HistoryPrimaryRootReadModel; readonly header: HistoryPrimaryReadHeader;
  readonly address: HistoryPrimaryPresentationAddress | null;
}
export function readHistoryPrimaryPanelAddress(root: HistoryPrimaryRootReadModel,
  kind: 'group' | 'key' | 'entry' | 'identity', identity: string,
  options?: HistoryPrimaryReadOptions & {tool?: HistoryPrimaryPresentationTarget | null}): Promise<HistoryPrimaryPanelAddressResult>;
export function collectHistoryPrimaryMountedSearchSubjects(scroller: HTMLElement | null, ownerDomId: string,
  root: HistoryPrimaryRootReadModel, keysForEntry: (entry: any) => string[]): { subjects: Map<string, string[]>; keys: Set<string> };
