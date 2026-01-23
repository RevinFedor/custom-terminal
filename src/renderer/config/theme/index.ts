/**
 * Theme Configuration Index
 *
 * Single import for all theme-related settings:
 * import { colors, markdownColors, DEFAULT_SETTINGS } from '@/config/theme';
 */

// Color palette (Catppuccin Mocha)
export { colors, cssVariables } from './colors';
export type { ThemeColors } from './colors';

// Markdown styles
export {
  markdownColors,
  headingSizes,
  codeMirrorMarkdownTheme,
  markdownCssClasses,
} from './markdown';
export type { MarkdownColors, HeadingSizes } from './markdown';

// Editor settings
export {
  DEFAULT_SETTINGS,
  SETTINGS_CONSTRAINTS,
  STORAGE_KEYS,
  loadSettings,
  saveSettings,
  adjustFontSizes,
} from './settings';
export type { EditorSettings } from './settings';
