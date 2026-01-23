/**
 * Catppuccin Mocha Theme - Color Variables
 * Copied from gt-editor/src/styles/main.css
 */

export const colors = {
  // Base colors
  bgBase: '#1e1e2e',
  bgSurface: '#181825',
  bgOverlay: '#313244',

  // Text colors
  text: '#cdd6f4',
  textMuted: '#6c7086',

  // Accent
  accent: '#89b4fa',

  // Border
  border: '#45475a',

  // Additional Catppuccin colors for extended palette
  red: '#f38ba8',
  green: '#a6e3a1',
  yellow: '#f9e2af',
  blue: '#89b4fa',
  purple: '#cba6f7',
  pink: '#f5c2e7',
  teal: '#94e2d5',

  // Selection
  selection: '#45475a',
  selectionMatch: 'rgba(137, 180, 250, 0.25)',

  // Search
  searchMatch: 'rgba(249, 226, 175, 0.3)',
  searchMatchSelected: 'rgba(249, 226, 175, 0.5)',
} as const;

/**
 * CSS Variables string for :root
 * Use this in global CSS or inject via JS
 */
export const cssVariables = `
:root {
  --bg-base: ${colors.bgBase};
  --bg-surface: ${colors.bgSurface};
  --bg-overlay: ${colors.bgOverlay};
  --text: ${colors.text};
  --text-muted: ${colors.textMuted};
  --accent: ${colors.accent};
  --border: ${colors.border};
}
`;

export type ThemeColors = typeof colors;
