interface Span {
  from: number
  to: number
}

/** Point membership in half-open ranges, including nested/overlapping spans.
 * Sort a copy: parser precedence and decoration ordering belong to the caller.
 */
export function createRangeContains(ranges: readonly Span[]): (pos: number) => boolean {
  const sorted = ranges.slice().sort((a, b) => a.from - b.from)
  const maxTo: number[] = []
  let end = -Infinity
  for (const range of sorted) {
    end = Math.max(end, range.to)
    maxTo.push(end)
  }
  return (pos) => {
    let lo = 0, hi = sorted.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (sorted[mid].from <= pos) lo = mid + 1
      else hi = mid
    }
    return lo > 0 && pos < maxTo[lo - 1]
  }
}
