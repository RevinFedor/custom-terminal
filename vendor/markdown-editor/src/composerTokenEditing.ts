export interface ComposerEditorDeleteRange {
  from: number
  to: number
}

export interface ComposerStatusTokenRange extends ComposerEditorDeleteRange {
  kind: string
}

export interface ComposerTokenPointerBounds {
  left: number
  width: number
}

export interface ComposerPointerPosition {
  x: number
  y: number
}

/**
 * Replacement widgets sit above CodeMirror's painted selection rectangles.
 * Treat any real overlap as selection of the atomic chip itself so the user
 * sees one highlighted object instead of an apparently missing segment.
 */
export const composerTokenIntersectsSelection = (
  token: ComposerEditorDeleteRange,
  selection: ComposerEditorDeleteRange,
) => selection.to > selection.from
  && selection.from < token.to
  && selection.to > token.from

/**
 * Raw image status markers deliberately stay editable instead of becoming
 * replacement widgets. macOS users still expect Option+Backspace at the
 * closing bracket to treat that visible marker as one authoring unit.
 */
export const findComposerStatusTokenBackwardDeleteRange = (
  tokens: readonly ComposerStatusTokenRange[],
  caret: number,
): ComposerEditorDeleteRange | null => {
  if (!Number.isFinite(caret)) return null
  const token = tokens.find((candidate) => (
    (candidate.kind === 'error' || candidate.kind === 'pending')
    && candidate.from >= 0
    && candidate.to > candidate.from
    && (candidate.to === caret || candidate.to - 1 === caret)
  ))
  return token ? { from: token.from, to: token.to } : null
}

/**
 * A compact status chip reveals its serialized marker for explicit editing.
 * Preserve the old left-edge editing position, while a click in the right
 * half places the caret immediately before the closing bracket.  That is the
 * visible boundary users target before pressing Option+Backspace.
 */
export const resolveComposerStatusTokenRevealCaret = (
  token: ComposerStatusTokenRange,
  clientX: number,
  bounds: ComposerTokenPointerBounds,
) => {
  const leftCaret = Math.max(token.from, Math.min(token.to - 1, token.from + 1))
  const hasPointerGeometry = Number.isFinite(clientX)
    && Number.isFinite(bounds.left)
    && Number.isFinite(bounds.width)
    && bounds.width > 0
  const clickedRightHalf = hasPointerGeometry
    && clientX >= bounds.left + (bounds.width / 2)

  if (
    clickedRightHalf
    && (token.kind === 'error' || token.kind === 'pending')
    && token.to > token.from
  ) {
    return Math.max(token.from, token.to - 1)
  }

  return leftCaret
}

export const composerPointerStayedWithinClickThreshold = (
  start: ComposerPointerPosition,
  end: ComposerPointerPosition,
  threshold = 4,
) => {
  if (
    !Number.isFinite(start.x)
    || !Number.isFinite(start.y)
    || !Number.isFinite(end.x)
    || !Number.isFinite(end.y)
    || !Number.isFinite(threshold)
    || threshold < 0
  ) return false
  return Math.hypot(end.x - start.x, end.y - start.y) <= threshold
}
