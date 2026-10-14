export { collapsibleFoldService } from './collapsibleFold'
export { createMarkdownSyntaxPlugin, createConcealClickFix, type MarkdownSyntaxConfig } from './markdownSyntax'
export { createImageField, type ImageFieldConfig } from './imageField'
export { createTableField } from './tableField'
export { createImageDeleteHandler } from './imageDelete'
export {
  createClipboardKeymap,
  activateAIPasteMode,
  cancelAIPasteMode,
  isAIPasteModeActive,
  activateNonAIPasteMode,
  cancelNonAIPasteMode,
  isNonAIPasteModeActive,
  aiPasteTrackerPlugin,
  type ClipboardConfig,
} from './clipboard'
export {
  navigatorClipboardAdapter,
  resolveClipboardAdapter,
  type ClipboardAdapter,
  type ClipboardItemLike,
} from './clipboardAdapter'
export { createWrapSelectionHandler } from './wrapSelection'
export { createImagePasteHandler, type ImagePasteConfig } from './imagePaste'
export { foldEffect, unfoldEffect } from '@codemirror/language'
export {
  createContextMenuHandler,
  showContextMenu,
  hideContextMenu,
  addLinePrefix,
  removeLinePrefix,
  toggleLinePrefix,
  wrapSelection,
  setHeadingLevel,
  getDefaultMenuItems,
  type MenuItem,
  type ContextMenuConfig,
  type EmojiShortcut,
  type LineBackgroundEntry,
  showCommandPalette,
  hideCommandPalette,
  selectionTrackerPlugin
} from './contextMenu'
export {
  lineBackgroundExtension,
  applyLineBackground,
  serializeLineBackgrounds,
  loadLineBackgrounds,
  applyLineBackgroundMap,
  setLineBackgroundPalette,
  getActiveLineBackground,
  getSelectedBackgroundCharCount,
  changeLineBgEffect,
  type LineBackgroundEntry as LineBgEntry,
  type SerializedLineBackgrounds,
} from './lineBackground'
export { hangingIndentPlugin } from './hangingIndent'
export * from './headerClick'
export { cursorOutOfFoldPlugin } from './cursorOutOfFold'
export { lineNumbersWithFold, createLineNumbersWithVirtual, type IncludeOffset } from './gutterClick'
export { collapsibleGutter } from './collapsibleGutter'
export { collapsibleArrowPlugin, createCollapsibleArrowClickHandler, createCollapsibleEnterHandler, createCollapsibleFoldParentHandler, createCollapsibleBackspaceHandler, createCollapsibleArrowDownHandler, collapsibleFoldHistorySupport, foldBoundaryAssocFix, toggleFoldAtPos } from './collapsibleArrow'
export { createCollapsibleHoverPreview } from './collapsibleHoverPreview'
export { collapsibleScopePlugin } from './collapsibleScopePlugin'
export { fullLineSelectionPlugin } from './fullLineSelection'
export { stableWordSelection, createStableWordSelection } from './wordSelection'
export { tabStopIndent, blockIndent, blockOutdent } from './tabIndent'
export { moveBlockUp, moveBlockDown } from './blockMove'
export { createEmojiHoverTooltip, type EmojiHoverTooltipConfig } from './emojiHoverTooltip'
export { createCustomEmojiPlugin, type CustomEmojiConfig, type CustomEmojiEntry } from './customEmoji'
export {
  createIncludeLinkPlugin,
  createIncludeLinkClickHandler,
  resolveAllIncludes,
  INCLUDE_PATTERN,
  type IncludeLinkConfig
} from './includeLink'
export {
  createEmbeddingLinkPlugin,
  extractEmbeddingPaths,
  EMBEDDING_PATTERN,
  type EmbeddingLinkConfig
} from './embeddingLink'
export {
  createLinkProtocolPlugin,
  LINK_PATTERN,
  type LinkProtocolConfig
} from './linkProtocol'
export { showWidgetContextMenu, hideWidgetContextMenu } from './widgetContextMenu'
export { createAtTriggerMenuPlugin, type AtTriggerMenuConfig } from './atTriggerMenu'
export { createFrontmatterProtocolPlugin } from './frontmatterProtocol'
export { createLinkIconPlugin, type LinkIconConfig, type DomainRule } from './linkIcon'
export {
  createAnchorLinkPlugin,
  createAnchorLinkClickHandler,
  type AnchorLinkConfig
} from './anchorLink'
export {
  createAnchorAutocompletion,
  createAnchorCompletionSource,
  type AnchorCompleteConfig
} from './anchorComplete'
export {
  buildAnchorIndex,
  parseAnchorFragment,
  resolveAnchor,
  buildFragment,
  slugify as slugifyAnchor,
  anchorKey,
  type AnchorIndex,
  type AnchorEntry,
  type AnchorType
} from './anchorIndex'
