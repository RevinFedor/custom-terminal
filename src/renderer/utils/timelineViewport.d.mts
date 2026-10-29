export interface TimelineViewportBinding {
  getSnapshot(): boolean;
  subscribe(notify: () => void): () => void;
}
export interface TimelineViewportSource {
  setActive(active: boolean): void;
  bind(index: number, count?: number): TimelineViewportBinding;
}
export function createTimelineViewportSource(options: {
  entries: readonly { uuid: string; isCompactSummary?: boolean }[];
  read: () => readonly string[] | undefined;
  subscribe: (notify: () => void) => () => void;
  active?: boolean;
}): TimelineViewportSource;
