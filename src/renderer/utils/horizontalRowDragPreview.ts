import { setCustomNativeDragPreview } from '@atlaskit/pragmatic-drag-and-drop/element/set-custom-native-drag-preview';

type NativeSetDragImage = Parameters<typeof setCustomNativeDragPreview>[0]['nativeSetDragImage'];

/**
 * Suppress the browser ghost for a row-constrained reorder.
 *
 * The real source chip stays mounted in its row and the FLIP preview moves it
 * only along X. A second native bitmap following X and Y would claim a second
 * visual position for the same object and make vertical pointer travel look
 * like a cross-surface move that the product does not support.
 */
export function setHorizontalRowDragPreview(nativeSetDragImage: NativeSetDragImage) {
  setCustomNativeDragPreview({
    nativeSetDragImage,
    render({ container }) {
      Object.assign(container.style, {
        width: '1px',
        height: '1px',
        opacity: '0',
        pointerEvents: 'none',
      });
    },
  });
}
