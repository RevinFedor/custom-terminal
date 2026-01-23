/**
 * Markdown Editor Styles
 * Copied from gt-editor/src/components/Editor.jsx createDarkTheme()
 *
 * These styles are designed for CodeMirror editor but can be adapted
 * for any markdown rendering (react-markdown, etc.)
 */

import { colors } from './colors';

/**
 * Markdown element colors
 */
export const markdownColors = {
  // Inline formatting
  bold: '#ffa348',
  italic: '#69dbdb',
  strike: '#868e96',
  code: '#50fa7b',
  codeBackground: 'rgba(80, 80, 80, 0.4)',

  // Headings (H1-H6 gradient from purple to violet)
  h1: '#c678dd',
  h2: '#b197fc',
  h3: '#a78bfa',
  h4: '#9775fa',
  h5: '#8b5cf6',
  h6: '#7c3aed',

  // Markup symbols (*, **, `, #, etc.)
  markup: '#6c7086',

  // Lists
  listBullet: '#6c7086',
  listMarker: '#6c7086',

  // Code blocks
  codeBlockBackground: 'rgba(80, 80, 80, 0.25)',

  // Images
  imageError: '#f38ba8',

  // Headings inside code blocks (muted)
  headingMuted: '#9595c8',
} as const;

/**
 * Heading sizes (relative to base font)
 */
export const headingSizes = {
  h1: '1.5em',
  h2: '1.3em',
  h3: '1.15em',
  h4: '1.1em',
  h5: '1em',
  h6: '1em',
} as const;

/**
 * CodeMirror theme object for markdown highlighting
 * Use with EditorView.theme()
 */
export const codeMirrorMarkdownTheme = {
  '&': {
    backgroundColor: colors.bgBase,
    color: '#e8e8e8',
    height: '100%',
  },
  '.cm-content': {
    fontFamily: '"SF Mono", "Fira Code", monospace',
    lineHeight: '1.6',
    padding: '16px',
  },
  '.cm-cursor': {
    borderLeftColor: '#f5e0dc',
  },
  '.cm-activeLine': {
    backgroundColor: 'rgba(255, 255, 255, 0.02)',
    boxShadow: 'inset 0 1px 0 0 rgba(255, 255, 255, 0.08), inset 0 -1px 0 0 rgba(255, 255, 255, 0.08)',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'rgba(255, 255, 255, 0.02)',
    color: '#e8e8e8',
    boxShadow: 'inset 0 1px 0 0 rgba(255, 255, 255, 0.08), inset 0 -1px 0 0 rgba(255, 255, 255, 0.08)',
  },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: colors.selection,
  },
  '.cm-selectionMatch': {
    backgroundColor: colors.selectionMatch,
    borderRadius: '2px',
  },
  '.cm-gutters': {
    backgroundColor: colors.bgBase,
    color: colors.textMuted,
    border: 'none',
    paddingRight: '8px',
  },
  '.cm-hidden-markup': {
    display: 'none',
  },
  '.cm-panels': {
    backgroundColor: colors.bgSurface,
    borderBottom: `1px solid ${colors.border}`,
  },
  '.cm-panels input, .cm-panels button': {
    color: colors.text,
  },
  '.cm-searchMatch': {
    backgroundColor: colors.searchMatch,
    borderRadius: '2px',
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: colors.searchMatchSelected,
  },

  // Markdown styles
  '.cm-md-bold': {
    color: markdownColors.bold,
    fontWeight: 'bold',
  },
  '.cm-md-italic': {
    color: markdownColors.italic,
    fontStyle: 'italic',
  },
  '.cm-md-strike': {
    color: markdownColors.strike,
    textDecoration: 'line-through',
  },
  '.cm-md-code': {
    color: markdownColors.code,
    backgroundColor: markdownColors.codeBackground,
    borderRadius: '3px',
    padding: '1px 4px',
  },
  '.cm-md-heading': {
    fontWeight: 'bold',
  },
  '.cm-md-h1': { color: markdownColors.h1, fontSize: headingSizes.h1 },
  '.cm-md-h2': { color: markdownColors.h2, fontSize: headingSizes.h2 },
  '.cm-md-h3': { color: markdownColors.h3, fontSize: headingSizes.h3 },
  '.cm-md-h4': { color: markdownColors.h4, fontSize: headingSizes.h4 },
  '.cm-md-h5': { color: markdownColors.h5 },
  '.cm-md-h6': { color: markdownColors.h6 },
  '.cm-md-markup': {
    color: markdownColors.markup,
  },
  '.cm-md-heading-muted': {
    color: markdownColors.headingMuted,
    fontWeight: 'normal',
  },

  // Lists
  '.cm-list-bullet': {
    color: markdownColors.listBullet,
  },
  '.cm-md-list-marker': {
    color: markdownColors.listMarker,
  },

  // Images
  '.cm-image-container': {
    display: 'block',
    margin: '8px 0',
    lineHeight: '0',
  },
  '.cm-image-widget': {
    maxWidth: '100%',
    borderRadius: '4px',
    cursor: 'pointer',
  },
  '.cm-image-error': {
    color: markdownColors.imageError,
    fontStyle: 'italic',
    fontSize: '0.9em',
  },
} as const;

/**
 * CSS classes for markdown elements (for use outside CodeMirror)
 * Can be used with react-markdown custom components
 */
export const markdownCssClasses = `
/* Markdown inline styles */
.md-bold {
  color: ${markdownColors.bold};
  font-weight: bold;
}

.md-italic {
  color: ${markdownColors.italic};
  font-style: italic;
}

.md-strike {
  color: ${markdownColors.strike};
  text-decoration: line-through;
}

.md-code {
  color: ${markdownColors.code};
  background-color: ${markdownColors.codeBackground};
  border-radius: 3px;
  padding: 1px 4px;
  font-family: "SF Mono", "Fira Code", monospace;
}

/* Markdown headings */
.md-h1 { color: ${markdownColors.h1}; font-size: ${headingSizes.h1}; font-weight: bold; }
.md-h2 { color: ${markdownColors.h2}; font-size: ${headingSizes.h2}; font-weight: bold; }
.md-h3 { color: ${markdownColors.h3}; font-size: ${headingSizes.h3}; font-weight: bold; }
.md-h4 { color: ${markdownColors.h4}; font-size: ${headingSizes.h4}; font-weight: bold; }
.md-h5 { color: ${markdownColors.h5}; font-weight: bold; }
.md-h6 { color: ${markdownColors.h6}; font-weight: bold; }

/* Code blocks */
.md-code-block {
  background: ${markdownColors.codeBlockBackground};
  border-radius: 6px;
  padding: 12px;
  overflow-x: auto;
}

/* Horizontal rule */
.md-hr {
  height: 1px;
  background: rgba(255, 255, 255, 0.3);
  margin: 8px 0;
  border: none;
}

/* Lists */
.md-list-bullet {
  color: ${markdownColors.listBullet};
}
`;

export type MarkdownColors = typeof markdownColors;
export type HeadingSizes = typeof headingSizes;
