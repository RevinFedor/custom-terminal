import { EditorView } from '@codemirror/view'

export interface ImagePasteConfig {
  onImagePaste?: (base64: string) => Promise<string | null>
}

// Paste handler only for images (domEventHandlers)
export function createImagePasteHandler(config: ImagePasteConfig) {
  // console.log('[ImagePaste] createImagePasteHandler called, config:', !!config.onImagePaste)
  return EditorView.domEventHandlers({
    paste: (event, view) => {
      // console.log('[ImagePaste] === PASTE EVENT ===')
      // console.log('[ImagePaste] onImagePaste exists:', !!config.onImagePaste)
      if (!config.onImagePaste) return false

      const items = event.clipboardData?.items
      if (!items) return false

      for (const item of items) {
        if (item.type.startsWith('image/')) {
          event.preventDefault()

          const blob = item.getAsFile()
          if (!blob) return false

          // Run async operation without blocking
          const handlePaste = async () => {
            try {
              const buffer = await blob.arrayBuffer()
              const uint8Array = new Uint8Array(buffer)
              let binary = ''
              for (let i = 0; i < uint8Array.length; i++) {
                binary += String.fromCharCode(uint8Array[i])
              }
              const base64 = btoa(binary)

              // console.log('[ImagePaste] calling onImagePaste with base64 length:', base64.length)
              const imagePath = await config.onImagePaste!(base64)
              // console.log('[ImagePaste] got imagePath:', imagePath)

              if (imagePath) {
                // Inline insert — NO trailing newline, NO trailing space. Images
                // are inline tokens (any position in a line), so paste behaves
                // like text: drop `![image](path)` at the cursor, caret right
                // after `)`. The caret lands at matchEnd = the token's EDGE, and
                // edge is not strictly-inside, so the fresh paste shows the chip
                // immediately (no raw path). Atomic-range token activation makes
                // this work without the earlier trailing-space hack.
                // fact-images.md::Активация по токену.
                const markdown = `![image](${imagePath})`
                const pos = view.state.selection.main.head
                view.dispatch({
                  changes: { from: pos, insert: markdown },
                  selection: { anchor: pos + markdown.length }
                })
              }
            } catch (err) {
              console.error('Error pasting image:', err)
            }
          }

          handlePaste()
          return true
        }
      }
      return false
    }
  })
}
