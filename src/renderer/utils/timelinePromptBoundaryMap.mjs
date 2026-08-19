/**
 * Build one atomic mapping used by both Timeline visibility and click
 * navigation. Prompt boundary sequence numbers start at 1: boundary N is the
 * prompt shown after response N, therefore entry N+1 is anchored to boundary N.
 *
 * A resumed/forked terminal can contain fewer live boundaries than JSONL
 * entries. In that case the live terminal markers belong to the newest entries,
 * so the mapping is aligned from the tail rather than from entry zero.
 */
export function mapTimelinePromptBoundaries({
  entryIndices = [],
  boundaries = [],
  initialLine = 0,
} = {}) {
  const indices = entryIndices
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value >= 0);
  const orderedBoundaries = boundaries
    .map((boundary) => ({
      seq: Number(boundary?.seq),
      line: Number(boundary?.line),
    }))
    .filter((boundary) => Number.isFinite(boundary.seq) && Number.isFinite(boundary.line))
    .sort((left, right) => left.seq - right.seq);

  const positions = new Map();
  const bindings = [];
  if (indices.length === 0 || orderedBoundaries.length === 0) {
    return { positions, bindings, startOffset: indices.length };
  }

  const positionable = Math.min(indices.length, orderedBoundaries.length + 1);
  const startOffset = indices.length - positionable;
  positions.set(indices[startOffset], Number(initialLine) || 0);

  for (let offset = 1; offset < positionable; offset += 1) {
    const entryIndex = indices[startOffset + offset];
    const boundary = orderedBoundaries[offset - 1];
    positions.set(entryIndex, boundary.line);
    bindings.push({ entryIndex, promptSeq: boundary.seq, line: boundary.line });
  }

  return { positions, bindings, startOffset };
}
