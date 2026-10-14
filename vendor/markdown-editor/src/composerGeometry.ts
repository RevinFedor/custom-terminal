export interface ComposerNaturalHeightSource {
  readonly contentHeight: number
}

/**
 * Return the document's own measured height, not the height of its viewport.
 * A scroll viewport cannot report a scrollHeight below its current clientHeight,
 * which makes it unsuitable for shrinking an auto-growing composer.
 */
export const readComposerNaturalHeight = (
  view: ComposerNaturalHeightSource,
): number => view.contentHeight
