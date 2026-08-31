import { useCallback, useRef } from 'react';
import { focusAndSelectInlineName } from '../utils/inlineRenameFocus.mjs';

/**
 * Focus/select exactly once when an inline name input becomes active.
 *
 * A callback ref follows the real DOM mount. A parent effect can run before a
 * delayed group/folder row has mounted; `autoFocus` alone focuses but does not
 * provide the Ctrl+A replacement contract. The node identity guard prevents a
 * controlled input rerender from selecting newly typed text again.
 */
export function useInlineRenameInputRef(active = true) {
  const nodeRef = useRef<HTMLInputElement | null>(null);
  const selectedNodeRef = useRef<HTMLInputElement | null>(null);
  const ref = useCallback((node: HTMLInputElement | null) => {
    nodeRef.current = node;
    if (!node || !active) {
      selectedNodeRef.current = null;
      return;
    }
    if (selectedNodeRef.current === node) return;
    selectedNodeRef.current = node;
    focusAndSelectInlineName(node);
  }, [active]);
  return { ref, nodeRef };
}
