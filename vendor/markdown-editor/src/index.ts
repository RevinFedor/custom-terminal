// Main component
export { MarkdownEditor, type MarkdownEditorProps } from './Editor'
export { MarkdownEditor as default } from './Editor'
// Host-owned popovers can dispose only their own editor's floating surface.
// Reuse the original cleanup (including palette listeners), never synthesize Esc.
export { hideCommandPalette, hideContextMenu } from './plugins/contextMenu'
export {
  ComposerEditor,
  type ComposerEditorHandle,
  type ComposerEditorProps,
  type ComposerEditorSelection,
  type ComposerEditorSnapshot,
  type ComposerInlineToken,
  type ComposerInlineTokenKind,
} from './ComposerEditor'
export {
  composerTokenIntersectsSelection,
  findComposerStatusTokenBackwardDeleteRange,
  type ComposerEditorDeleteRange,
  type ComposerStatusTokenRange,
} from './composerTokenEditing'
export {
  readSynchronousComposerClipboardPayload,
  shouldDeferComposerPasteToNative,
  type ComposerClipboardPayload,
} from './composerClipboard'
export {
  getComposerSearchMatchStats,
  type ComposerSearchMatchStats,
} from './composerSearch'

// Theme
export { createDarkTheme } from './theme'

// Plugins (for advanced usage)
export {
  collapsibleFoldService,
  createMarkdownSyntaxPlugin,
  createClipboardKeymap,
  createWrapSelectionHandler,
  createImagePasteHandler,
  foldEffect,
  unfoldEffect,
  toggleFoldAtPos,
  navigatorClipboardAdapter,
  resolveClipboardAdapter,
  loadLineBackgrounds,
  applyLineBackgroundMap,
  type SerializedLineBackgrounds,
  type MarkdownSyntaxConfig,
  type ImagePasteConfig,
  type ClipboardAdapter,
  type ClipboardItemLike
} from './plugins'

// Anchor system (for App-side cross-file anchor index)
export {
  buildAnchorIndex,
  parseAnchorFragment,
  resolveAnchor,
  buildFragment,
  slugifyAnchor,
  anchorKey,
  type AnchorIndex,
  type AnchorEntry,
  type AnchorType
} from './plugins'

// Widgets (for advanced usage)
export {
  HiddenWidget,
  HorizontalRuleWidget,
  ImageWidget,
  BulletWidget,
  CollapsibleHeaderWidget
} from './widgets'
