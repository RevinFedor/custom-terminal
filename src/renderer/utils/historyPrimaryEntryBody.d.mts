/** Selected-body reader only. This is not source, layout or writer authority. */
export interface HistoryPrimaryEntryBodyReader {
  readonly root: object;
  assertOpen(signal?: AbortSignal | null): void;
  page(node: object, kind: string, options: {offset: number; signal?: AbortSignal}): Promise<unknown>;
  text(node: object): {chunks(options: {signal?: AbortSignal}): AsyncIterable<string>};
  close(): Promise<unknown>;
}
export function readHistoryPrimaryEntryBody(reader: HistoryPrimaryEntryBodyReader,
  options?: {signal?: AbortSignal; owns?: () => boolean}): Promise<unknown>;
