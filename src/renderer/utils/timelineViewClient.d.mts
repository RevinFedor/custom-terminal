export const TIMELINE_VIEW_PROFILE: string;
export function mergeTimelineReadClass(a: string | null, b: string): string;
export function timelineViewError(code: string): Error;
export function checkedTimelineLayout(layout: any): any;
export class TimelineViewClient {
  constructor(invoke: any, header: any);
  header: any; identity: any; root: any; layout: any;
  query(operation: string, args?: any, options?: any): Promise<any>;
  endpoint(node: any, options?: any): Promise<any>;
  subject(value: any, logicalRank: number, uuid: string): any;
  row(rank: number, options?: any): Promise<any>; annotation(kind: string, n: number, options?: any): Promise<any>;
  field(node: any, fieldName: string, options?: any): Promise<any>;
  group(key: string, options?: any): Promise<any>; decode(descriptor: any, options?: any): Promise<any>;
  retainSnapshot(options?: any): Promise<TimelineViewClient>;
  retain(): () => Promise<any>;
  document(args: any, options?: any): Promise<string>; close(): Promise<any>;
}
export function openTimelineView(invoke: any, payload: any, options?: any): Promise<TimelineViewClient>;
