/* ============================================================
   @noted/claude-blocks — public API
   ------------------------------------------------------------
   Переносимые блоки рендера Claude-диалога + дизайн-токены.
   Стили подключаются ОТДЕЛЬНО (CSS не импортируется из JS, чтобы
   потребитель сам решал порядок и мог переопределить токены):
     import '@noted/claude-blocks/styles.css';
   ============================================================ */

// ---- Components ----
export { Markdown, MarkdownCodeBlock } from './components/Markdown';
export { ThinkBlock, type ThinkBlockProps } from './components/ThinkBlock';
export { RowCopyButton, type RowCopyButtonProps } from './components/RowCopyButton';
export { TerminalActivityIcon } from './components/TerminalActivityIcon';
export { ToolCard, ColoredToolIcon, type ToolCardProps } from './components/ToolCard';
export { DiffView } from './components/DiffView';
export {
  ToolCallPart,
  BashCard, ReadCard, EditCard, GenericToolCard, McpToolCard,
  type ToolCallProps, type CollapseInjection, type ActionHeadline,
} from './components/ToolCards';
export {
  ConversationMessage,
  MessageStatusBadge,
  MessageActionRail,
  MessageActionButton,
  MessageEvent,
  type ConversationMessageProps,
  type ConversationMessageLayout,
  type ConversationTone,
  type MessageStatusBadgeProps,
  type MessageActionRailProps,
  type MessageActionPlacement,
  type MessageActionButtonProps,
  type MessageEventProps,
} from './components/ConversationMessage';
export {
  ComposerFrame,
  ComposerChip,
  ComposerControlButton,
  ComposerRuntimeControl,
  type ComposerFrameProps,
  type ComposerDensity,
  type ComposerChipProps,
  type ComposerChipKind,
  type ComposerChipState,
  type ComposerControlButtonProps,
  type ComposerRuntimeControlProps,
  type ComposerRuntimeAction,
} from './components/ComposerFrame';

// ---- Полный рендер сообщения чата (расположение + содержимое) ----
export { ChatMessage, type ChatMessageProps } from './components/ChatMessage';
export type {
  ChatEntry, ChatEntryKind, CompactMetrics,
  CollapseController, MessageActions, ChatRenderContext,
} from './messageTypes';

// ---- Icons (inlined SVG, no icon-lib dependency) ----
export {
  TerminalIcon, FileEditIcon, FileTextIcon, FolderSearchIcon, SearchIcon,
  GlobeIcon, BrainIcon, Loader2Icon, AlertTriangleIcon, CopyIcon, CheckIcon,
  RefreshCwIcon, PencilIcon, XIcon, SparklesIcon, PlugIcon, GitBranchIcon,
  StackIcon, ChecklistIcon, ChevronRightIcon, CompressIcon,
  toolIcon,
  type IconProps,
} from './icons';

// ---- Helpers / types ----
export {
  detectLanguage, lineDiff, countDiffStats, numberDiff, extractRawText,
  toolStatusFrom, defaultOpenForTool, resultToText, copyText, setCopyTextImpl,
  type DiffEntry, type DiffHunk, type NumberedDiffEntry, type ToolStatus,
} from './helpers';

export { rehypeHexHighlight } from './rehypeHexHighlight';
export { selectionToMarkdown } from './selectionMarkdown';
