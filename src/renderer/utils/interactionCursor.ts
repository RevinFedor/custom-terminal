// A cursor on body/html is only inherited: a tab, editor or resize handle can
// override it under the held pointer. An active gesture owns the cursor across
// those surfaces without putting an input-blocking element over the workspace.
const cursors = new Map<symbol, string>();
let style: HTMLStyleElement | null = null;

function paintCursor() {
  const cursor = Array.from(cursors.values()).at(-1);
  if (!cursor) {
    style?.remove();
    style = null;
    return;
  }
  if (!style) {
    style = document.createElement('style');
    style.textContent = ':root, :root * {}';
    document.head.appendChild(style);
  }
  style.dataset.interactionCursor = cursor;
  const rule = style.sheet?.cssRules[0] as CSSStyleRule | undefined;
  rule?.style.setProperty('cursor', cursor, 'important');
}

/** Release is idempotent; an older cleanup cannot clear a newer gesture. */
export function acquireInteractionCursor(cursor: string): () => void {
  const owner = Symbol(cursor);
  cursors.set(owner, cursor);
  paintCursor();
  return () => {
    if (!cursors.delete(owner)) return;
    paintCursor();
  };
}
