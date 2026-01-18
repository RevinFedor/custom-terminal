# Font Loading Race Condition

## Problem
Terminal text appears jittery, characters overlap, or cursor position is wrong. The terminal grid seems "broken".

## Symptoms
- Characters overlap or have gaps between them
- Cursor doesn't align with text
- `Char width: 8.4287109375` (fractional width indicates measurement issue)
- DevTools shows wrong font:
  ```
  Requested font: "JetBrainsMono NF", monospace
  Computed font: -apple-system, sans-serif  // WRONG!
  ```

## Root Cause
Electron/xterm.js initializes faster than the browser loads custom fonts. Sequence:
1. xterm.js creates terminal
2. xterm.js measures character width using current font
3. Font loads (too late!)
4. xterm.js already has wrong metrics, never recalculates

Result: xterm thinks characters are X pixels wide, but actual rendering uses different width.

## Solution

### 1. Bundle Font Locally
Don't rely on system fonts. Include font in project:
```
assets/fonts/JetBrainsMonoNerdFont-Regular.ttf
```

### 2. CSS @font-face with font-display: block
```css
@font-face {
  font-family: 'JetBrainsMono NF';
  src: url('./assets/fonts/JetBrainsMonoNerdFont-Regular.ttf') format('truetype');
  font-weight: normal;
  font-style: normal;
  font-display: block; /* CRITICAL: blocks rendering until font loads */
}
```

### 3. Wait for Font Before Terminal Init (renderer.js)
```javascript
async function init() {
  // Wait for ALL fonts to be ready
  await document.fonts.ready;

  // Double-check our specific font
  const fontLoaded = document.fonts.check("14px 'JetBrainsMono NF'");
  if (!fontLoaded) {
    await document.fonts.load("14px 'JetBrainsMono NF'");
  }

  // NOW create terminal
  createTab();
}
```

## Verification
In DevTools console:
```javascript
getComputedStyle(document.querySelector('.xterm')).fontFamily
// Should return: "'JetBrainsMono NF', monospace"
// NOT: "-apple-system, ..."
```

Font availability test:
```javascript
document.fonts.check("14px 'JetBrainsMono NF'")
// Should return: true
```

## Why Monospace is Critical
xterm.js is a character grid. It assumes all characters have identical width. If using proportional font:
- `i` = 3px wide
- `W` = 10px wide
- xterm thinks both = 8px

This causes:
- Cursor in wrong position
- Text overlap
- Visual jitter on every update

## Files Involved
- `input.css` - @font-face declaration
- `renderer.js` - document.fonts.ready wait
- `assets/fonts/` - actual font file
