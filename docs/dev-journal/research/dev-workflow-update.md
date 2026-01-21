# Dev Workflow Update

**Date:** 2026-01-19
**Change:** Removed auto-reload/hot-reload system

---

## What Changed

### Before:
```json
"dev": "NODE_ENV=development nodemon --exec electron . --watch ..."
```

**Features:**
- ✅ Auto-restart on file changes (nodemon)
- ✅ Auto-reload renderer on frontend changes (fs.watch)
- ❌ Hard to debug
- ❌ Unexpected restarts during development

### After:
```json
"dev": "NODE_ENV=development electron ."
```

**Features:**
- ✅ Manual control over restarts
- ✅ No unexpected behavior
- ✅ Traditional development flow
- ✅ Easier debugging

---

## Files Changed

1. **package.json**
   - Removed nodemon from dev script
   - Removed nodemon from devDependencies
   - Simple dev command: `NODE_ENV=development electron .`

2. **main.js**
   - Removed fs.watch live reload block
   - No more automatic renderer reloads

3. **node_modules**
   - Uninstalled nodemon and 21 dependencies

---

## New Workflow

### Development:

```bash
# Start in dev mode (sets NODE_ENV=development)
npm run dev

# Or just start normally
npm start
```

**To see changes:**
1. Make your edits
2. Manually restart: `Cmd+Q` and run `npm run dev` again
3. Or use Cmd+R in Electron to reload renderer only (for CSS/HTML changes)

### CSS Development (unchanged):

```bash
# Auto-compile Tailwind CSS on changes
npm run dev:css
```

This still works with `--watch` flag.

---

## Benefits

1. **Predictable Behavior**
   - You control when app restarts
   - No random reloads during typing

2. **Better Debugging**
   - Console logs don't get cleared unexpectedly
   - Easier to track issues

3. **Cleaner Dependencies**
   - Removed 21 packages (nodemon + deps)
   - Smaller node_modules

4. **Traditional Flow**
   - Same as most Electron apps
   - Familiar to other developers

---

## When to Restart

**Backend changes (need restart):**
- `main.js`
- `database.js`
- `session-manager.js`
- `project-manager.js`
- Any IPC handlers

**Frontend changes (Cmd+R to reload):**
- `renderer.js`
- `index.html`
- `output.css`

**No restart needed:**
- CSS changes (if `npm run dev:css` is running)

---

## Tip: Quick Restart

Add alias to your shell (~/.zshrc):

```bash
alias noted-restart="pkill -9 Electron && cd ~/Desktop/custom-terminal && npm start"
```

Or use VSCode task:

```json
{
  "label": "Restart Noted Terminal",
  "type": "shell",
  "command": "pkill -9 Electron; npm start",
  "problemMatcher": []
}
```

---

## Rollback (if needed)

To restore auto-reload:

```bash
npm install --save-dev nodemon
```

In package.json:
```json
"dev": "NODE_ENV=development nodemon --exec electron . --watch main.js --watch renderer.js"
```

In main.js:
```javascript
// Add back fs.watch block
const fs = require('fs');
fs.watch(path.join(__dirname, 'renderer.js'), () => {
  mainWindow.webContents.reload();
});
```

---

## Summary

✅ Removed nodemon
✅ Removed fs.watch live reload
✅ Traditional dev workflow
✅ Manual control over restarts

**New command:**
```bash
npm run dev  # or npm start
```

Simple and predictable!
