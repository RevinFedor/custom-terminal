export const HISTORY_SURFACE_PRESENTATION_EVENT: 'history-panel:external-presentation';

export interface HistoryPresentationProof {
  presented: boolean;
  visit: number;
  resumes: number;
}

export function createHistoryPresentationProof(presented?: boolean): HistoryPresentationProof;
export function advanceHistoryPresentationProof(previous: HistoryPresentationProof | null | undefined, presented: boolean): HistoryPresentationProof;
export function historyPresentationOwnsWrite(proof: Pick<HistoryPresentationProof, 'presented' | 'visit'> | null | undefined, capturedVisit: number): boolean;
export function resolveHistoryViewportPaintProof(options?: {
  currentOwnerKey?: string;
  currentGeneration?: number;
  currentPresentation?: HistoryPresentationProof | null;
  readyOwnerKey?: string;
  proofRequired?: boolean;
  ownerKey?: string;
  generation?: number;
  presentationVisit?: number;
  proof?: string;
  domRows?: number;
}): { readyOwnerKey: string; proofRequired: boolean; accepted: boolean; changed: boolean };
