export interface TerminalHydrationChunk {
  data: string;
  writeSeq: number | null;
  generation: string | null;
  generationOrdinal: number | null;
}

export interface TerminalHydrationBuffer {
  chunks: TerminalHydrationChunk[];
  chars: number;
}

export interface TerminalHydrationActivity {
  depth: number;
}

export interface TerminalSerializedCheckpoint {
  serialized: string;
  headlessWriteSeq: number | null;
  headlessGeneration: string | null;
  headlessGenerationOrdinal: number | null;
  cols?: number | null;
  rows?: number | null;
}

export const createTerminalHydrationBuffer = (): TerminalHydrationBuffer => ({
  chunks: [],
  chars: 0,
});

export const createTerminalHydrationActivity = (): TerminalHydrationActivity => ({ depth: 0 });

export const beginTerminalHydration = (activity: TerminalHydrationActivity): (() => void) => {
  activity.depth += 1;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    activity.depth = Math.max(0, activity.depth - 1);
  };
};

export const isTerminalHydrationActive = (
  activity: TerminalHydrationActivity,
): boolean => activity.depth > 0;

export const appendTerminalHydrationChunk = (
  buffer: TerminalHydrationBuffer,
  data: string,
  writeSeq?: number | null,
  generation?: string | null,
  generationOrdinal?: number | null,
  maxChars = 100_000,
  retainChars = 50_000,
) => {
  if (!data) return;
  const normalizedSeq = Number.isFinite(writeSeq) ? Number(writeSeq) : null;
  const normalizedGeneration = typeof generation === 'string' && generation ? generation : null;
  const normalizedGenerationOrdinal = Number.isFinite(generationOrdinal)
    ? Number(generationOrdinal)
    : null;
  buffer.chunks.push({
    data,
    writeSeq: normalizedSeq,
    generation: normalizedGeneration,
    generationOrdinal: normalizedGenerationOrdinal,
  });
  buffer.chars += data.length;

  if (buffer.chars <= maxChars) return;

  // Drop complete old PTY chunks. Never slice the newest chunk in the middle:
  // one Codex/Ink frame can be larger than the nominal tail budget and a
  // partial ANSI frame cannot be replayed safely even as a fallback.
  while (buffer.chunks.length > 1 && buffer.chars > retainChars) {
    const removed = buffer.chunks.shift();
    buffer.chars -= removed?.data.length || 0;
  }
};

export const drainTerminalHydrationBuffer = (
  buffer: TerminalHydrationBuffer,
  snapshotWriteSeq?: number | null,
  snapshotGeneration?: string | null,
): string => {
  return takeTerminalHydrationChunks(
    buffer,
    snapshotWriteSeq,
    snapshotGeneration,
  ).map((chunk) => chunk.data).join('');
};

export const takeTerminalHydrationChunks = (
  buffer: TerminalHydrationBuffer,
  snapshotWriteSeq?: number | null,
  snapshotGeneration?: string | null,
): TerminalHydrationChunk[] => {
  const chunks = buffer.chunks;
  buffer.chunks = [];
  buffer.chars = 0;

  if (!Number.isFinite(snapshotWriteSeq)) {
    return chunks;
  }

  const boundary = Number(snapshotWriteSeq);
  return chunks
    .filter((chunk) => {
      if (snapshotGeneration && chunk.generation && chunk.generation !== snapshotGeneration) {
        return false;
      }
      return chunk.writeSeq === null || chunk.writeSeq > boundary;
    });
};

export const getTerminalHydrationTailMaxSeq = (
  buffer: TerminalHydrationBuffer,
  snapshotWriteSeq?: number | null,
  snapshotGeneration?: string | null,
): number | null => {
  const hasBoundary = Number.isFinite(snapshotWriteSeq);
  const boundary = Number(snapshotWriteSeq);
  let maxSeq: number | null = null;
  for (const chunk of buffer.chunks) {
    if (snapshotGeneration && chunk.generation && chunk.generation !== snapshotGeneration) continue;
    if (!Number.isFinite(chunk.writeSeq)) continue;
    const seq = Number(chunk.writeSeq);
    if (hasBoundary && seq <= boundary) continue;
    maxSeq = maxSeq === null ? seq : Math.max(maxSeq, seq);
  }
  return maxSeq;
};

export const hasNewerTerminalHydrationGeneration = (
  buffer: TerminalHydrationBuffer,
  snapshotGenerationOrdinal?: number | null,
): boolean => {
  if (!Number.isFinite(snapshotGenerationOrdinal)) return false;
  const boundary = Number(snapshotGenerationOrdinal);
  return buffer.chunks.some((chunk) => (
    Number.isFinite(chunk.generationOrdinal)
    && Number(chunk.generationOrdinal) > boundary
  ));
};

export type TerminalHydrationGenerationDecision =
  | 'continue'
  | 'retry-authoritative-snapshot'
  | 'preserve-and-retry-later';

export const decideTerminalHydrationGeneration = (
  buffer: TerminalHydrationBuffer,
  snapshotGenerationOrdinal: number | null | undefined,
  hasAuthoritativeSnapshot: boolean,
): TerminalHydrationGenerationDecision => {
  if (!hasNewerTerminalHydrationGeneration(buffer, snapshotGenerationOrdinal)) {
    return 'continue';
  }
  return hasAuthoritativeSnapshot
    ? 'retry-authoritative-snapshot'
    : 'preserve-and-retry-later';
};

export const shouldPreferSavedTerminalCheckpoint = (
  saved: TerminalSerializedCheckpoint | null | undefined,
  main: TerminalSerializedCheckpoint | null | undefined,
): boolean => (
  !!saved
  && !!main
  && !!saved.headlessGeneration
  && saved.headlessGeneration === main.headlessGeneration
  && Number.isFinite(saved.headlessWriteSeq)
  && Number.isFinite(main.headlessWriteSeq)
  && Number(saved.headlessWriteSeq) === Number(main.headlessWriteSeq)
  && Number.isFinite(saved.cols)
  && Number.isFinite(saved.rows)
  && Number.isFinite(main.cols)
  && Number.isFinite(main.rows)
  && Number(saved.cols) === Number(main.cols)
  && Number(saved.rows) === Number(main.rows)
  && saved.serialized.length > main.serialized.length
);
