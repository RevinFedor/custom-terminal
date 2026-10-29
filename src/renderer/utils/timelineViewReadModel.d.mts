export function isExplicitLegacyTimelineOwner(owner: any): boolean;
export function registerExplicitLegacyTimelineOwner(owner: any): () => void;
export function heldTimelineView(owner: any): TimelineViewReadModel | null;
export function registerTimelineView(owner: any, model: TimelineViewReadModel): () => void;
export class TimelineViewReadModel {
  constructor(invoke: any, options?: any);
  current: any; state: any; demand: any; closed: boolean;
  snapshot: () => any; subscribe: (listener: () => void) => () => void;
  requestWindow(demand: any): Promise<any>; refresh(payload: any, readClass?: string): Promise<any>;
  commitPresentation(adoption: number): void;
  resolve(uuid: string, options?: any): Promise<any>; subject(uuid: string, options?: any): Promise<any>;
  selected(view: any, rank: number, owns: () => boolean): Promise<any>;
  withActionSubject(uuid: string, payload: any, operation: (subject: any, client: any) => Promise<any>): Promise<any>;
  range(start: number, end: number, client?: any): Promise<any>;
  resizeViewport(extent: number): Promise<any>;
  measure(batch: any[]): Promise<any>; close(): Promise<any>;
}
