import { EditorView } from '@codemirror/view'

// Dark theme
export const createDarkTheme = (fontSize = 14, contentPaddingX = 16, contentPaddingY = 16) =>
  EditorView.theme(
    {
      '&': {
        backgroundColor: 'var(--gt-md-bg)',
        color: 'var(--gt-md-fg)',
        height: '100%'
      },
      '.cm-content': {
        fontFamily: '"SF Mono", "Fira Code", monospace',
        fontSize: `${fontSize}px`,
        lineHeight: '1.6',
        padding: `${contentPaddingY}px ${contentPaddingX}px`
      },
      '.cm-cursor': {
        borderLeftColor: '#f5e0dc'
      },
      // Secondary cursors (multi-cursor mode)
      '.cm-cursor-secondary': {
        borderLeftColor: '#f5e0dc'
      },
      // Secondary selection (multi-cursor mode)
      '&.cm-focused .cm-selectionBackground-secondary, .cm-selectionBackground-secondary': {
        backgroundColor: 'rgba(69, 71, 90, 0.7)'
      },
      '.cm-activeLine': {
        backgroundColor: 'rgba(255, 255, 255, 0.02)',
        boxShadow: 'inset 0 1px 0 0 rgba(255, 255, 255, 0.08), inset 0 -1px 0 0 rgba(255, 255, 255, 0.08)'
      },
      '.cm-activeLineGutter': {
        backgroundColor: 'rgba(255, 255, 255, 0.02)',
        color: 'var(--gt-md-fg)',
        boxShadow: 'inset 0 1px 0 0 rgba(255, 255, 255, 0.08), inset 0 -1px 0 0 rgba(255, 255, 255, 0.08)'
      },
      '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
        backgroundColor: 'color-mix(in srgb, var(--gt-md-selection) 35%, transparent) !important'
      },
      '.cm-selectionMatch': {
        backgroundColor: 'color-mix(in srgb, var(--gt-md-selection) 25%, transparent)',
        borderRadius: '2px'
      },
      '.cm-gutters': {
        backgroundColor: '#1e1e2e',
        color: '#6c7086',
        border: 'none',
        paddingRight: '8px',
        fontSize: `${fontSize}px`,
        fontFamily: '"SF Mono", "Fira Code", monospace',
        position: 'relative'
      },
      // foldGutter накладывается поверх контента справа от номеров
      '& .cm-foldGutter': {
        position: 'absolute',
        right: '-24px',  // Выносим за пределы gutters в область контента
        top: '0',
        width: '24px',
        zIndex: '5',
        backgroundColor: 'transparent'
      },
      '.cm-hidden-markup': {
        visibility: 'hidden'
      },
      '.cm-panels': {
        backgroundColor: '#181825',
        borderBottom: '1px solid #45475a'
      },
      '.cm-panels input, .cm-panels button': {
        color: '#cdd6f4'
      },
      '.cm-searchMatch': {
        backgroundColor: 'rgba(249, 226, 175, 0.3)',
        borderRadius: '2px'
      },
      '.cm-searchMatch.cm-searchMatch-selected': {
        backgroundColor: 'rgba(249, 226, 175, 0.5)'
      },
      // Markdown styles
      '.cm-md-bold': {
        color: 'var(--gt-md-bold)',
        fontWeight: 'bold'
      },
      '.cm-md-italic': {
        color: 'var(--gt-md-italic)',
        fontStyle: 'italic'
      },
      '.cm-md-strike': {
        color: 'var(--gt-md-strike)',
        textDecoration: 'line-through'
      },
      '.cm-md-code': {
        color: 'var(--gt-md-code)',
        backgroundColor: 'rgba(80, 80, 80, 0.4)',
        borderRadius: '3px',
        padding: '1px 4px'
      },
      '.cm-md-link': {
        color: 'var(--gt-md-link)',
        textDecoration: 'underline'
        // cursor inherits from .cm-content (text); scoped .cmd-held link rules opt into pointer
      },
      '.cm-md-heading': {
        fontWeight: 'bold'
      },
      // Color only at line level (fontSize moved to mark-level to preserve ch units)
      '.cm-md-h1': { color: 'var(--gt-md-h1)' },
      '.cm-md-h2': { color: 'var(--gt-md-h2)' },
      '.cm-md-h3': { color: 'var(--gt-md-h3)' },
      '.cm-md-h4': { color: 'var(--gt-md-h4)' },
      '.cm-md-h5': { color: 'var(--gt-md-h5)' },
      '.cm-md-h6': { color: 'var(--gt-md-h6)' },

      // Heading tags [logs], [links], [deprecated] — override heading level color
      '.cm-heading-tag-logs': { color: 'var(--gt-md-tag-logs) !important' },
      '.cm-heading-tag-links': { color: 'var(--gt-md-tag-links) !important' },
      '.cm-heading-tag-deprecated': { color: 'var(--gt-md-tag-deprecated) !important' },
      '.cm-heading-tag-status': { color: 'var(--gt-md-tag-status) !important' },

      // Font-size on inline mark (span), not on .cm-line — keeps ch unit stable for indent guides
      '.cm-heading-size-1': { fontSize: '1.1em' },
      '.cm-heading-size-2': { fontSize: '1.1em' },
      '.cm-heading-size-3': { fontSize: '1.1em' },
      '.cm-heading-size-4': { fontSize: '1.1em' },
      '.cm-heading-size-5': { fontSize: '1.1em' },
      '.cm-heading-size-6': { fontSize: '1.1em' },
      '.cm-md-markup': {
        color: 'var(--gt-md-markup)'
      },
      '.cm-md-heading-muted': {
        color: '#9595c8',
        fontWeight: 'normal'
      },
      // List styles — жёлтый
      '.cm-list-bullet': {
        color: 'var(--gt-md-list)'
      },
      '.cm-md-list-marker': {
        color: 'var(--gt-md-list)'
      },
      // Image styles
      '.cm-image-container': {
        display: 'block',
        marginTop: '0',
        marginBottom: '0'
      },
      '.cm-image-widget': {
        maxWidth: '100%',
        borderRadius: '4px',
        cursor: 'pointer',
        // Always-on subtle frame so the preview never blends into the editor
        // background when the image's own edges are dark/transparent. The
        // brighter blue outline below still marks the ACTIVE (cursor-on-line)
        // state on top of this.
        border: '1px solid rgba(180, 160, 250, 0.45)',
        backgroundColor: 'rgba(255, 255, 255, 0.03)'
      },
      // Border when image is active - use outline (doesn't affect layout)
      '.cm-image-active .cm-image-widget': {
        outline: '2px solid #89b4fa',
        outlineOffset: '2px'
      },
      // Muted markdown syntax for image (when active)
      '.cm-md-image-syntax': {
        opacity: 0.5
      },
      // Inline chip shown in place of `![...](path)` when cursor is OFF the
      // line: `▸ [thumbnail] image` / `▾ [thumbnail] image`. Pilule in the same family as the
      // @link widget (.cm-link-widget) but LAVENDER, so it reads as a distinct
      // semantic next to green/pink/blue/peach chips (методология::цвета чипов).
      // The arrow glyph/hover comes from .cm-collapsible-arrow (editor.css).
      '.cm-image-chip': {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '5px',
        padding: '1px 8px',
        background: 'rgba(180, 160, 250, 0.13)',
        border: '1px solid rgba(180, 160, 250, 0.32)',
        borderRadius: '4px',
        fontSize: '0.9em',
        color: '#b4a0fa',
        verticalAlign: 'baseline',
        // Indented lines carry text-indent: -Nch (hangingIndent.ts). It inherits
        // into the chip; inline-flex blockifies the children so each glyph would
        // slide left out of the border box (arrow/icon overlap the label, only
        // on indented lines). Reset it so children inherit 0.
        textIndent: '0'
      },
      '.cm-image-chip:hover': {
        background: 'rgba(180, 160, 250, 0.22)',
        borderColor: 'rgba(180, 160, 250, 0.55)'
      },
      '.cm-image-chip-arrow': {
        lineHeight: '1' // arrow visuals from .cm-collapsible-arrow; center the 1.2em glyph
      },
      '.cm-image-chip-thumbnail': {
        width: '20px',
        height: '20px',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flex: '0 0 20px',
        overflow: 'hidden',
        borderRadius: '3px',
        background: 'rgba(180, 160, 250, 0.12)'
      },
      '.cm-image-chip-thumbnail img': {
        width: '100%',
        height: '100%',
        objectFit: 'cover',
        display: 'block',
        userSelect: 'none',
        pointerEvents: 'none'
      },
      '.cm-image-chip-thumbnail-fallback': {
        fontSize: '1em',
        lineHeight: '1'
      },
      '.cm-image-chip-label': {
        color: '#b4a0fa',
        userSelect: 'none'
      },
      '.cm-image-error': {
        color: '#f38ba8',
        fontStyle: 'italic',
        fontSize: '0.9em'
      },
      // Collapsible section styles (base style, can be overridden by headings/inline)
      '.cm-collapsible-header': {
        color: 'var(--gt-md-collapsible)'  // белый по умолчанию, не синий
      },
      // Headings inside collapsible override base color
      '.cm-collapsible-header.cm-md-h1': { color: 'var(--gt-md-h1)' },
      '.cm-collapsible-header.cm-md-h2': { color: 'var(--gt-md-h2)' },
      '.cm-collapsible-header.cm-md-h3': { color: 'var(--gt-md-h3)' },
      '.cm-collapsible-header.cm-md-h4': { color: 'var(--gt-md-h4)' },
      '.cm-collapsible-header.cm-md-h5': { color: 'var(--gt-md-h5)' },
      '.cm-collapsible-header.cm-md-h6': { color: 'var(--gt-md-h6)' },
      // Inline styles inside collapsible should override base color
      '.cm-collapsible-header .cm-md-bold': {
        color: 'var(--gt-md-bold)'
      },
      '.cm-collapsible-header .cm-md-italic': {
        color: 'var(--gt-md-italic)'
      },
      '.cm-collapsible-header .cm-md-code': {
        color: 'var(--gt-md-code)'
      },
      '.cm-collapsible-header .cm-md-strike': {
        color: 'var(--gt-md-strike)'
      },
      // Цвет стрелки теперь определяется в JavaScript (CollapsibleArrowWidget)
      '.cm-collapsible-marker': {
        display: 'none' // Hidden, button is now in gutter
      },
      // Fold marker - белый по умолчанию, больше
      '& .cm-fold-marker': {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        width: '100%',
        color: '#cdd6f4',
        fontSize: '20px',
        cursor: 'pointer',
        opacity: '0.6',
        transition: 'opacity 0.15s, color 0.15s'
      },
      '& .cm-fold-marker:hover': {
        opacity: '1',
        color: '#f38ba8'
      },
      '.cm-gutterElement': {
        transition: 'color 0.15s'
      },
      // Hover на номерах строк
      '.cm-lineNumbers .cm-gutterElement': {
        cursor: 'pointer'
      },
      '.cm-lineNumbers .cm-gutterElement:hover': {
        color: '#f38ba8'
      },
      // Placeholder for folded content
      '.cm-foldPlaceholder': {
        backgroundColor: 'rgba(137, 180, 250, 0.2)',
        border: '1px solid rgba(137, 180, 250, 0.4)',
        borderRadius: '4px',
        padding: '2px 12px',
        margin: '0 8px',
        color: '#89b4fa',
        fontSize: '0.9em',
        fontWeight: '500',
        cursor: 'pointer',
        verticalAlign: 'middle',
        display: 'inline-flex',
        alignItems: 'center',
        height: '1.4em'
      },
      // Unclosed formatting markers (warning)
      '.cm-md-unclosed': {
        backgroundColor: 'rgba(243, 139, 168, 0.25)',
        borderRadius: '2px'
      }
    },
    { dark: true }
  )
