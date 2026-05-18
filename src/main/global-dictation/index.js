// Global Dictation — system-wide voice input.
//
// Three OS-level windows live independently of the main app window:
//   1. mainWindow    — the regular Noted Terminal app (not owned by us).
//   2. chipWindow    — persistent always-on-top "status chip" floating above
//                      the Dock. Visible only if settings.showChip === true.
//                      Click → toggle recording.
//   3. recWindow     — the recording modal that appears for the duration of a
//                      dictation session. Anchored above the chip, transparent,
//                      always-on-top, focusable:false so the keystrokes the
//                      user is dictating land in whatever app had focus.
//
// State machine: 'idle' → 'recording' → 'delivering' → 'idle'.
//   • idle: chip rendered (if enabled), recWindow hidden.
//   • recording: chip flips to "recording" visual; recWindow visible; audio
//                streams to Soniox in renderer.
//   • delivering: brief transient — we hide recWindow first (so paste target
//                regains focus), then run `osascript ... keystroke "v" ...`.
//
// IPC wiring (main ↔ renderer, both ways):
//   global-dict:settings:get        — returns current settings JSON.
//   global-dict:settings:set        — patches settings, re-registers hotkey,
//                                     toggles chip visibility.
//   global-dict:toggle              — same trigger as the hotkey; used by the
//                                     chip's click handler.
//   global-dict:state               — broadcast push to all GD windows whenever
//                                     state changes ('idle'|'recording'|...).
//   global-dict:rec:transcript      — push from recWindow → ignored by main,
//                                     stored as latest text in case stop()
//                                     needs it.
//   global-dict:rec:stop            — sent by recWindow STOP button OR by hotkey.
//   global-dict:rec:cancel          — X button — drop transcript, no paste.
//   global-dict:rec:final           — recWindow's renderer pushes the FINAL
//                                     transcript after Soniox close.
//                                     main: history.append + maybe paste.
//   global-dict:history:get         — bounded list from JSON file.
//   global-dict:accessibility-check — { trusted: bool, canPrompt: bool }.
//   global-dict:accessibility-open  — open System Settings → Accessibility.
//
// Persisted state lives in ~/.noted-terminal/global-dictation/:
//   settings.json — { enabled, hotkey, showChip, autoEnter, chipPos }.
//   history.json  — [{ ts, text }] capped at 200 entries.

const { app, BrowserWindow, ipcMain, globalShortcut, screen, shell, clipboard, systemPreferences } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const STORAGE_DIR = path.join(os.homedir(), '.noted-terminal', 'global-dictation');
const SETTINGS_PATH = path.join(STORAGE_DIR, 'settings.json');
const HISTORY_PATH = path.join(STORAGE_DIR, 'history.json');
const HISTORY_CAP = 200;

const DEFAULT_SETTINGS = {
  enabled: false,         // off until user explicitly enables
  // NOTE: Cmd+` is reserved by macOS for "Move focus to next window in
  // application" — registering it via globalShortcut returns true but the OS
  // consumes the event first. Use Alt+` (Option+`) which is free.
  hotkey: 'Alt+`',
  // Optional global hotkey to toggle Auto-Enter on/off without touching the UI.
  // Empty string = not registered.
  autoEnterHotkey: '',
  // Optional global cancel hotkey. Triggers cancelRecording — drops the
  // session without pasting. Default 'Esc' is the natural fit but the user
  // may want to free Esc and use Cmd+Esc / Opt+Esc instead.
  cancelHotkey: 'Esc',
  showChip: true,
  // Spacing between the chip and stuff that opens around it (in CSS px).
  menuGap: 6,           // popover above the chip
  recWindowGap: 6,      // recording window above the chip
  // Auto-Enter DEFAULT — what `sessionAutoEnter` is initialised to at the
  // beginning of every recording session. Not the live state during
  // recording; user can toggle per-session via the chip's pill while
  // recording, but the next start resets to this default.
  autoEnterDefault: false,
  transcriptFontSize: 12,         // px, sized to fit ~5 lines in 110px rec window
  transcriptLines: 5,             // number of visible lines before scroll
  chipPos: null,          // { x, y } — null = auto-place above Dock center
};

let settings = { ...DEFAULT_SETTINGS };
let chipWindow = null;
let recWindow = null;
let menuWindow = null;
// Timestamp of the most recent menu close. The chip's click handler can fire
// just after `blur` closes the menu — without a cooldown the same click then
// reopens the menu immediately. 300ms is enough to swallow that re-open
// without making the toggle behaviour feel sluggish.
let menuClosedAt = 0;
const MENU_REOPEN_COOLDOWN_MS = 300;
let state = 'idle';       // 'idle' | 'recording' | 'delivering'
let sessionAutoEnter = false;  // live per-session toggle, reset on every startRecording
let registeredAccelerator = null;
let pendingFinalText = null;
let getMainWindow = () => null;
// Bundle ID of whatever app was frontmost when the recording started. We
// reactivate it just before sending Cmd+V so the paste lands in the right
// place even if our chip click (or some other interaction with our app
// windows) caused macOS to switch frontmost in the meantime.
let targetAppBundleId = null;

// Dimensions — single source of truth.
const CHIP_W = 220;          // wide enough to fit the recording row (X | autoEnter | Stop)
const CHIP_H = 56;
const CHIP_BUTTON_SIZE = 44; // diameter of the idle-mode round button (centered)
const MENU_W = 200;
const MENU_H = 168;          // 3 buttons × ~50px + padding

function ensureDir() {
  try { fs.mkdirSync(STORAGE_DIR, { recursive: true }); } catch {}
}

function loadSettings() {
  ensureDir();
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      settings = { ...DEFAULT_SETTINGS, ...parsed };
      // Migration:
      //  - Cmd+` → Alt+` (Cmd+` is reserved by macOS for "Move focus to next
      //    window in application"; globalShortcut.register returns true but
      //    the OS consumes the event first).
      //  - Anything containing "Dead" → Alt+` (early settings UI captured
      //    macOS dead-key combinations via e.key="Dead", producing nonsense
      //    accelerators like "Alt+Dead" that don't register).
      //  - autoEnter → autoEnterDefault (renamed semantically — it's the
      //    DEFAULT used at the start of each recording, not a live state).
      let needSave = false;
      if (settings.hotkey === 'CommandOrControl+`' || settings.hotkey === 'Command+`' || settings.hotkey === 'Cmd+`') {
        console.log('[GlobalDict] migrating hotkey ' + settings.hotkey + ' → Alt+`');
        settings.hotkey = 'Alt+`';
        needSave = true;
      }
      if (typeof settings.hotkey === 'string' && settings.hotkey.includes('Dead')) {
        console.log('[GlobalDict] migrating dead-key hotkey ' + settings.hotkey + ' → Alt+`');
        settings.hotkey = 'Alt+`';
        needSave = true;
      }
      if (typeof parsed.autoEnter === 'boolean' && typeof parsed.autoEnterDefault === 'undefined') {
        console.log('[GlobalDict] migrating autoEnter=' + parsed.autoEnter + ' → autoEnterDefault');
        settings.autoEnterDefault = parsed.autoEnter;
        delete settings.autoEnter;
        needSave = true;
      }
      if (needSave) {
        try { fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2)); } catch {}
      }
    }
  } catch (e) {
    console.error('[GlobalDict] settings load failed:', e.message);
    settings = { ...DEFAULT_SETTINGS };
  }
  console.log('[GlobalDict] loadSettings done: ' + JSON.stringify(settings));
}

function saveSettings() {
  ensureDir();
  try { fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2)); }
  catch (e) { console.error('[GlobalDict] settings save failed:', e.message); }
}

function loadHistory() {
  ensureDir();
  try {
    if (!fs.existsSync(HISTORY_PATH)) return [];
    return JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
  } catch { return []; }
}

function appendHistory(text) {
  if (!text || !text.trim()) return;
  const list = loadHistory();
  list.unshift({ ts: Date.now(), text: text.trim() });
  const trimmed = list.slice(0, HISTORY_CAP);
  try { fs.writeFileSync(HISTORY_PATH, JSON.stringify(trimmed)); }
  catch (e) { console.error('[GlobalDict] history save failed:', e.message); }
}

function rendererUrl(name) {
  // electron-vite dev: each html input becomes ${ELECTRON_RENDERER_URL}/${name}.html
  // production: dist/renderer/${name}.html
  if (process.env.ELECTRON_RENDERER_URL) {
    return `${process.env.ELECTRON_RENDERER_URL}/${name}.html`;
  }
  return null; // file:// path handled separately
}

// Resolve the production path to a renderer HTML. This module lives at
// app.asar/src/main/global-dictation/index.js, so __dirname is
// app.asar/src/main/global-dictation. The built HTML is at
// app.asar/dist/renderer/<name>.html — that's THREE levels up to asar root,
// then dist/renderer/<name>.html.
//
// PREVIOUS BUG: path was `../../renderer/<name>.html` which resolved to
// app.asar/src/renderer/<name>.html — a path that does not exist in the
// production asar. loadFile() on a missing path silently shows a white frame
// and emits did-fail-load; the React app never executed, IPC never opened,
// dlog() never fired — hence zero [GD:chip]/[GD:rec] log entries in
// production.log while the main window's same renderer dlog() worked fine.
function resolveRendererFilePath(name) {
  return path.join(__dirname, '..', '..', '..', 'dist', 'renderer', `${name}.html`);
}

function loadRendererPage(win, name) {
  const url = rendererUrl(name);
  if (url) {
    console.log('[GlobalDict] loadRendererPage ' + name + ' via URL: ' + url);
    win.loadURL(url);
    return;
  }
  const filePath = resolveRendererFilePath(name);
  console.log('[GlobalDict] loadRendererPage ' + name + ' via file: ' + filePath + ' exists=' + fs.existsSync(filePath));
  win.loadFile(filePath).catch((e) => {
    console.error('[GlobalDict] loadFile FAILED for ' + name + ': ' + e.message);
  });
  // Attach diagnostic handlers so silent loads become loud.
  win.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL) => {
    console.error('[GlobalDict][' + name + '] did-fail-load: ' + errorCode + ' ' + errorDescription + ' url=' + validatedURL);
  });
  win.webContents.on('did-finish-load', () => {
    console.log('[GlobalDict][' + name + '] did-finish-load url=' + win.webContents.getURL());
  });
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    console.log('[GlobalDict][' + name + '][renderer-console L' + level + '] ' + message + ' (' + source + ':' + line + ')');
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[GlobalDict][' + name + '] render-process-gone: ' + JSON.stringify(details));
  });
  win.webContents.on('preload-error', (_e, preloadPath, err) => {
    console.error('[GlobalDict][' + name + '] preload-error: ' + preloadPath + ' ' + err.message);
  });
}

function computeChipPosition() {
  // Preferred: center-based pct + remembered display id.
  // Fall back through: old corner-based pct → old absolute coords → default.
  if (settings.chipPos && typeof settings.chipPos.cxPct === 'number') {
    const targetId = settings.chipPos.displayId;
    let display = screen.getAllDisplays().find((d) => d.id === targetId);
    if (!display) display = screen.getPrimaryDisplay();   // monitor unplugged
    const wa = display.workArea;
    const cx = wa.x + settings.chipPos.cxPct * wa.width;
    const cy = wa.y + settings.chipPos.cyPct * wa.height;
    let x = Math.round(cx - CHIP_W / 2);
    let y = Math.round(cy - CHIP_H / 2);
    x = Math.max(wa.x, Math.min(wa.x + wa.width - CHIP_W, x));
    y = Math.max(wa.y, Math.min(wa.y + wa.height - CHIP_H, y));
    return { x, y };
  }
  // Legacy: corner-based pct (early R2 schema).
  if (settings.chipPos && typeof settings.chipPos.xPct === 'number') {
    const display = screen.getPrimaryDisplay();
    const wa = display.workArea;
    let x = Math.round(wa.x + settings.chipPos.xPct * wa.width);
    let y = Math.round(wa.y + settings.chipPos.yPct * wa.height);
    x = Math.max(wa.x, Math.min(wa.x + wa.width - CHIP_W, x));
    y = Math.max(wa.y, Math.min(wa.y + wa.height - CHIP_H, y));
    return { x, y };
  }
  // Legacy: absolute pixels (pre-pct settings).
  if (settings.chipPos && typeof settings.chipPos.x === 'number') {
    return { x: settings.chipPos.x, y: settings.chipPos.y };
  }
  // Default: bottom-center of primary display, just above the Dock.
  const display = screen.getPrimaryDisplay();
  const { x: dx, y: dy, width, height } = display.workArea;
  return {
    x: Math.round(dx + (width - CHIP_W) / 2),
    y: Math.round(dy + height - CHIP_H - 24),
  };
}

function createChipWindow() {
  if (chipWindow && !chipWindow.isDestroyed()) return chipWindow;
  const pos = computeChipPosition();
  console.log('[GlobalDict] createChipWindow at x=' + pos.x + ' y=' + pos.y + ' size=' + CHIP_W + 'x' + CHIP_H);
  chipWindow = new BrowserWindow({
    width: CHIP_W, height: CHIP_H,
    x: pos.x, y: pos.y,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,            // Don't allow OS-level window drag — drag would
                                // swallow clicks on macOS for this kind of overlay.
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // focusable:false — clicking the chip MUST NOT steal focus from the
    // target app, otherwise our subsequent paste-to-frontmost will send
    // Cmd+V back to ourselves. acceptFirstMouse:true lets clicks register
    // anyway (Electron docs: "Allows the click that activates the window
    // also to be passed to the page").
    focusable: false,
    acceptFirstMouse: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false,
    },
  });
  chipWindow.setAlwaysOnTop(true, 'floating', 1);
  try { chipWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch {}
  chipWindow.on('closed', () => { console.log('[GlobalDict] chipWindow closed'); chipWindow = null; });
  loadRendererPage(chipWindow, 'global-dictation-chip');
  chipWindow.once('ready-to-show', () => {
    console.log('[GlobalDict] chipWindow ready-to-show, will show=' + (settings.showChip && settings.enabled));
    if (settings.showChip && settings.enabled) chipWindow.show();
  });
  return chipWindow;
}

// Popover with 3 buttons (Open App / Speak / Copy) anchored above the chip.
// Auto-closes on blur — user clicks elsewhere → window destroyed.
//
// Toggle semantics: if called while menu is already visible, close it instead
// of opening a second copy. The chip click also calls this — so second click
// on the chip is "close the menu".
function openMenuWindow() {
  // Cooldown: ignore opens within MENU_REOPEN_COOLDOWN_MS of the last close.
  // Without this the user's click on the chip — which causes blur on the
  // menu (closing it via the menuWindow.on('blur') handler) — would then
  // re-open the menu in the SAME click flow.
  const since = Date.now() - menuClosedAt;
  if (since < MENU_REOPEN_COOLDOWN_MS && !(menuWindow && !menuWindow.isDestroyed())) {
    console.log('[GlobalDict] openMenuWindow ignored (cooldown ' + since + 'ms < ' + MENU_REOPEN_COOLDOWN_MS + 'ms since last close)');
    return null;
  }
  if (menuWindow && !menuWindow.isDestroyed()) {
    console.log('[GlobalDict] openMenuWindow toggle → close');
    try { menuWindow.close(); } catch {}
    menuWindow = null;
    menuClosedAt = Date.now();
    broadcastState();
    return null;
  }
  if (!chipWindow || chipWindow.isDestroyed()) return null;
  // Snapshot the user's current frontmost app BEFORE we show the menu —
  // by the time they click "Speak" the menu window will be frontmost, and
  // we'd lose the original target. Fire-and-forget (no await) because the
  // menu doesn't actually grab focus for ~30-50ms while it loads anyway,
  // which is more than enough for osascript to finish.
  captureFrontmostApp().then((bid) => {
    if (bid) {
      console.log('[GlobalDict] openMenuWindow captured target=' + bid);
      targetAppBundleId = bid;
    }
  });
  const [cx, cy] = chipWindow.getPosition();
  // Anchor right edge of menu to right edge of chip; menu sits ABOVE chip.
  const gap = Math.max(0, settings.menuGap || 0);
  const x = Math.max(8, cx + CHIP_W - MENU_W);
  const y = Math.max(8, cy - MENU_H - gap);
  console.log('[GlobalDict] openMenuWindow at x=' + x + ' y=' + y + ' gap=' + gap);
  menuWindow = new BrowserWindow({
    width: MENU_W, height: MENU_H,
    x, y,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: true,
    acceptFirstMouse: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false,
    },
  });
  menuWindow.setAlwaysOnTop(true, 'floating', 2);
  try { menuWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch {}
  menuWindow.on('blur', () => {
    console.log('[GlobalDict] menuWindow blur → close');
    try { menuWindow?.close(); } catch {}
  });
  menuWindow.on('closed', () => {
    console.log('[GlobalDict] menuWindow closed');
    menuWindow = null;
    menuClosedAt = Date.now();
    broadcastState();
  });
  loadRendererPage(menuWindow, 'global-dictation-menu');
  menuWindow.once('ready-to-show', () => {
    menuWindow.show();
    broadcastState();
  });
  return menuWindow;
}

function closeMenuWindow() {
  if (menuWindow && !menuWindow.isDestroyed()) try { menuWindow.close(); } catch {}
  menuWindow = null;
  menuClosedAt = Date.now();
  broadcastState();
}

// Initial recording window size — header only (no transcript lines yet).
// Renderer grows the window as text fills in, via global-dict:rec:resize IPC.
function computeRecWindowInitialSize() {
  const HEADER = 36;
  const FRAME_PAD = 12;
  return { W: 320, H: HEADER + FRAME_PAD };
}
function computeRecWindowMaxHeight() {
  const HEADER = 36;
  const FRAME_PAD = 12;
  const lh = Math.round(settings.transcriptFontSize * 1.5);
  return HEADER + lh * settings.transcriptLines + 12 + FRAME_PAD;
}

function createRecWindow() {
  if (recWindow && !recWindow.isDestroyed()) return recWindow;
  const display = screen.getPrimaryDisplay();
  const { x: dx, y: dy, width, height } = display.workArea;
  const { W, H } = computeRecWindowInitialSize();
  // Default anchor: centered above the dock, above the chip.
  let x = Math.round(dx + (width - W) / 2);
  let y = Math.round(dy + height - H - CHIP_H - 32);
  if (chipWindow && !chipWindow.isDestroyed()) {
    try {
      const [cx, cy] = chipWindow.getPosition();
      const recGap = Math.max(0, settings.recWindowGap || 0);
      x = Math.max(dx + 8, Math.min(dx + width - W - 8, cx + CHIP_W / 2 - W / 2));
      y = Math.max(dy + 8, cy - H - recGap);
    } catch {}
  }
  console.log('[GlobalDict] createRecWindow at x=' + x + ' y=' + y + ' initialSize=' + W + 'x' + H);
  recWindow = new BrowserWindow({
    width: W, height: H,
    x, y,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,     // Critical: don't steal focus from the target app.
    hasShadow: false,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false,
    },
  });
  recWindow.setAlwaysOnTop(true, 'screen-saver', 2);
  try { recWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch {}
  recWindow.on('closed', () => { console.log('[GlobalDict] recWindow closed'); recWindow = null; });
  loadRendererPage(recWindow, 'global-dictation-rec');
  recWindow.once('ready-to-show', () => recWindow.show());
  return recWindow;
}

function broadcastState() {
  const payload = {
    state,
    sessionAutoEnter,
    menuOpen: !!(menuWindow && !menuWindow.isDestroyed()),
    autoEnterDefault: settings.autoEnterDefault,
    transcriptFontSize: settings.transcriptFontSize,
    transcriptLines: settings.transcriptLines,
  };
  for (const w of [chipWindow, recWindow, menuWindow]) {
    if (w && !w.isDestroyed()) {
      try { w.webContents.send('global-dict:state', payload); } catch {}
    }
  }
}

function setState(next) {
  if (state === next) return;
  state = next;
  broadcastState();
}

function startRecording() {
  console.log('[GlobalDict] startRecording, current state=' + state);
  if (state !== 'idle') { console.log('[GlobalDict] startRecording: NOT IDLE, abort'); return; }
  // Close the popover (any path into startRecording — hotkey, chip click,
  // menu's Speak button — should dismiss the menu immediately).
  closeMenuWindow();
  pendingFinalText = null;
  // Reset per-session toggle to the default. User can override during the
  // session via the chip's pill, but the next start resets again.
  sessionAutoEnter = !!settings.autoEnterDefault;
  setState('recording');
  createRecWindow();
  console.log('[GlobalDict] startRecording: recWindow created, sessionAutoEnter=' + sessionAutoEnter);
}

function stopRecording() {
  console.log('[GlobalDict] stopRecording, current state=' + state + ' recWin=' + !!recWindow);
  if (state !== 'recording') { console.log('[GlobalDict] stopRecording: NOT RECORDING, abort'); return; }
  // Tell recWindow to wind down its Soniox session. The renderer will reply
  // with global-dict:rec:final once Soniox has flushed.
  if (recWindow && !recWindow.isDestroyed()) {
    try { recWindow.webContents.send('global-dict:rec:stop-request'); console.log('[GlobalDict] stopRecording: sent stop-request to recWindow'); } catch (e) { console.log('[GlobalDict] stopRecording: send failed ' + e.message); }
  } else {
    console.log('[GlobalDict] stopRecording: no recWindow → setState idle');
    setState('idle');
  }
}

function cancelRecording() {
  if (state !== 'recording') return;
  pendingFinalText = null;
  if (recWindow && !recWindow.isDestroyed()) {
    try { recWindow.webContents.send('global-dict:rec:cancel-request'); } catch {}
  }
  closeRecWindow();
  setState('idle');
}

function closeRecWindow() {
  if (recWindow && !recWindow.isDestroyed()) {
    try { recWindow.close(); } catch {}
  }
  recWindow = null;
}

function toggleRecording() {
  console.log('[GlobalDict] toggleRecording invoked, current state=' + state);
  if (state === 'idle') startRecording();
  else if (state === 'recording') stopRecording();
  else console.log('[GlobalDict] toggleRecording: ignored — state is ' + state);
}

// AppleScript-based paste-to-foreground. Saves the user's clipboard, writes
// our text, presses Cmd+V (and Return if autoEnter), then restores the
// clipboard half a second later. Requires Accessibility permission — without
// it, `osascript` exits non-zero and we surface a toast via main window.
// Synchronous-ish helper: ask System Events which app is frontmost, return
// its bundle identifier. Used to snapshot the target app *before* any of
// our windows could grab focus.
function captureFrontmostApp() {
  return new Promise((resolve) => {
    const script = 'tell application "System Events" to get bundle identifier of first application process whose frontmost is true';
    const child = spawn('osascript', ['-e', script]);
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('close', (code) => {
      if (code === 0) {
        const bid = out.trim();
        console.log('[GlobalDict] captureFrontmostApp → bundle=' + JSON.stringify(bid));
        resolve(bid || null);
      } else {
        console.error('[GlobalDict] captureFrontmostApp osascript exit=' + code + ' stderr=' + err.trim());
        resolve(null);
      }
    });
    child.on('error', (e) => {
      console.error('[GlobalDict] captureFrontmostApp spawn failed: ' + e.message);
      resolve(null);
    });
  });
}

function pasteToFrontmostApp(text, autoEnter) {
  console.log('[GlobalDict] pasteToFrontmostApp ENTER len=' + (text||'').length + ' autoEnter=' + autoEnter);
  if (!text || !text.trim()) {
    console.log('[GlobalDict] pasteToFrontmostApp: empty text, skipping');
    return Promise.resolve({ ok: true, skipped: true });
  }
  if (process.platform !== 'darwin') {
    return Promise.resolve({ ok: false, error: 'paste-to-frontmost only supported on macOS' });
  }
  return new Promise((resolve) => {
    const prevText = (() => { try { return clipboard.readText(); } catch { return ''; } })();
    console.log('[GlobalDict] pasteToFrontmostApp: prevClipboard len=' + prevText.length);
    try {
      clipboard.writeText(text);
      const after = clipboard.readText();
      console.log('[GlobalDict] pasteToFrontmostApp: wrote ' + text.length + ' chars to clipboard, readback len=' + after.length + ' match=' + (after === text));
    } catch (e) {
      console.error('[GlobalDict] pasteToFrontmostApp: clipboard write FAILED: ' + e.message);
      return resolve({ ok: false, error: 'clipboard write failed: ' + e.message });
    }
    // Build script. If we captured the target app's bundle id before
    // recording started, activate it FIRST so the keystroke lands there
    // (defensive against our own chip/menu having stolen focus).
    const lines = [];
    if (targetAppBundleId) {
      // The standard form is: tell application id "com.foo" to activate.
      // Escape any quotes in the bundle id (paranoid — bundle ids never have
      // them, but cheap insurance).
      const safeBid = String(targetAppBundleId).replace(/"/g, '\\"');
      lines.push(`tell application id "${safeBid}" to activate`);
      lines.push('delay 0.08');   // give WindowServer time to flip frontmost
    }
    lines.push('tell application "System Events" to keystroke "v" using command down');
    if (autoEnter) {
      lines.push('delay 0.05');
      lines.push('tell application "System Events" to key code 36');  // 36 = Return
    }
    const script = lines.join('\n');
    console.log('[GlobalDict] pasteToFrontmostApp: spawning osascript, targetBundle=' + JSON.stringify(targetAppBundleId));
    const child = spawn('osascript', ['-e', script]);
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      console.log('[GlobalDict] pasteToFrontmostApp: osascript exit=' + code + ' stderr=' + JSON.stringify(stderr.trim()));
      // Restore clipboard a beat later, after the target app has had time to
      // consume our paste. 600ms is overkill but invisible to the user.
      setTimeout(() => {
        try { clipboard.writeText(prevText); console.log('[GlobalDict] pasteToFrontmostApp: clipboard restored len=' + prevText.length); } catch {}
      }, 600);
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, error: stderr.trim() || ('osascript exit ' + code) });
    });
    child.on('error', (e) => {
      console.error('[GlobalDict] pasteToFrontmostApp: spawn error ' + e.message);
      setTimeout(() => { try { clipboard.writeText(prevText); } catch {} }, 600);
      resolve({ ok: false, error: e.message });
    });
  });
}

function notifyMain(channel, payload) {
  const mw = getMainWindow();
  if (mw && !mw.isDestroyed()) {
    try { mw.webContents.send(channel, payload); } catch {}
  }
}

async function handleFinalTranscript(text) {
  pendingFinalText = text || '';
  const preview = pendingFinalText.length > 60 ? pendingFinalText.slice(0, 60) + '…' : pendingFinalText;
  console.log('[GlobalDict] handleFinalTranscript len=' + pendingFinalText.length + ' preview=' + JSON.stringify(preview));
  appendHistory(pendingFinalText);
  closeRecWindow();
  if (!pendingFinalText.trim()) {
    console.log('[GlobalDict] handleFinalTranscript: EMPTY text → state=idle, no paste');
    setState('idle');
    return;
  }
  setState('delivering');
  // Allow recWindow to actually disappear & focus to settle on the target app
  // before we trigger Cmd+V. 80ms is enough on M-series Macs.
  console.log('[GlobalDict] handleFinalTranscript: waiting 100ms for focus to settle');
  await new Promise(r => setTimeout(r, 100));
  // Use the LIVE per-session toggle (sessionAutoEnter), not the default.
  // User may have flipped the pill during recording.
  console.log('[GlobalDict] handleFinalTranscript: calling pasteToFrontmostApp autoEnter=' + sessionAutoEnter);
  const result = await pasteToFrontmostApp(pendingFinalText, sessionAutoEnter);
  console.log('[GlobalDict] handleFinalTranscript: paste result=' + JSON.stringify(result));
  if (!result.ok) {
    notifyMain('global-dict:paste-failed', { error: result.error });
  }
  // Clear the captured target so next session re-captures fresh.
  targetAppBundleId = null;
  setState('idle');
}

// Tracks all registered accelerators so we can unregister cleanly on change.
let registeredAutoEnterAccelerator = null;
let registeredCancelAccelerator = null;

function registerHotkey() {
  // ── Primary toggle hotkey ──
  if (registeredAccelerator) {
    try { globalShortcut.unregister(registeredAccelerator); console.log('[GlobalDict] unregistered ' + registeredAccelerator); } catch {}
    registeredAccelerator = null;
  }
  if (registeredAutoEnterAccelerator) {
    try { globalShortcut.unregister(registeredAutoEnterAccelerator); console.log('[GlobalDict] unregistered auto-enter ' + registeredAutoEnterAccelerator); } catch {}
    registeredAutoEnterAccelerator = null;
  }
  if (registeredCancelAccelerator) {
    try { globalShortcut.unregister(registeredCancelAccelerator); console.log('[GlobalDict] unregistered cancel ' + registeredCancelAccelerator); } catch {}
    registeredCancelAccelerator = null;
  }
  if (!settings.enabled) { console.log('[GlobalDict] registerHotkey: enabled=false, skip'); return { ok: true }; }
  const accel = settings.hotkey || DEFAULT_SETTINGS.hotkey;
  try {
    const ok = globalShortcut.register(accel, async () => {
      console.log('[GlobalDict] HOTKEY FIRED: ' + accel);
      // Capture target ONLY when transitioning idle→recording. When stopping
      // we already have it from start; recapture would grab our own bundle.
      if (state === 'idle') {
        targetAppBundleId = await captureFrontmostApp();
      }
      toggleRecording();
    });
    if (!ok) {
      console.error('[GlobalDict] globalShortcut.register returned false for ' + accel);
    } else {
      registeredAccelerator = accel;
      console.log('[GlobalDict] hotkey registered: ' + accel + ' (isRegistered=' + globalShortcut.isRegistered(accel) + ')');
    }
  } catch (e) {
    console.error('[GlobalDict] hotkey register failed:', e.message);
  }

  // ── Optional Cancel hotkey ──
  // Cancels in-flight recording (drops the transcript without pasting).
  // Default 'Esc' but the user may want to free Esc and use Cmd+Esc instead.
  const cancelAccel = (settings.cancelHotkey || '').trim();
  if (cancelAccel) {
    try {
      const ok = globalShortcut.register(cancelAccel, () => {
        console.log('[GlobalDict] CANCEL HOTKEY FIRED: ' + cancelAccel + ' (state=' + state + ')');
        if (state === 'recording') cancelRecording();
      });
      if (!ok) {
        console.error('[GlobalDict] cancel globalShortcut.register returned false for ' + cancelAccel);
      } else {
        registeredCancelAccelerator = cancelAccel;
        console.log('[GlobalDict] cancel hotkey registered: ' + cancelAccel);
      }
    } catch (e) {
      console.error('[GlobalDict] cancel register failed:', e.message);
    }
  }

  // ── Optional Auto-Enter hotkey ──
  // While recording → flips sessionAutoEnter for THIS recording.
  // While idle      → flips autoEnterDefault (so next recording inherits the
  // new default). Either way the chip pill / settings UI re-render via state
  // broadcast.
  const aeAccel = (settings.autoEnterHotkey || '').trim();
  if (aeAccel) {
    try {
      const ok = globalShortcut.register(aeAccel, () => {
        console.log('[GlobalDict] AUTO-ENTER HOTKEY FIRED: ' + aeAccel);
        if (state === 'recording') {
          sessionAutoEnter = !sessionAutoEnter;
          console.log('[GlobalDict] sessionAutoEnter flipped → ' + sessionAutoEnter);
          broadcastState();
        } else {
          settings.autoEnterDefault = !settings.autoEnterDefault;
          console.log('[GlobalDict] autoEnterDefault flipped → ' + settings.autoEnterDefault);
          saveSettings();
          broadcastState();
        }
      });
      if (!ok) {
        console.error('[GlobalDict] auto-enter globalShortcut.register returned false for ' + aeAccel);
      } else {
        registeredAutoEnterAccelerator = aeAccel;
        console.log('[GlobalDict] auto-enter hotkey registered: ' + aeAccel);
      }
    } catch (e) {
      console.error('[GlobalDict] auto-enter register failed:', e.message);
    }
  }
  return { ok: true };
}

function applyChipVisibility() {
  if (!settings.enabled || !settings.showChip) {
    if (chipWindow && !chipWindow.isDestroyed()) {
      try { chipWindow.hide(); } catch {}
    }
    return;
  }
  if (!chipWindow || chipWindow.isDestroyed()) {
    createChipWindow();
  } else {
    try { chipWindow.show(); } catch {}
  }
}

function registerIPC() {
  ipcMain.handle('global-dict:settings:get', () => settings);

  ipcMain.handle('global-dict:settings:set', (_e, patch) => {
    const oldHotkey = settings.hotkey;
    const oldAutoEnterHotkey = settings.autoEnterHotkey;
    const oldCancelHotkey = settings.cancelHotkey;
    const oldEnabled = settings.enabled;
    const oldShowChip = settings.showChip;
    settings = { ...settings, ...(patch || {}) };
    saveSettings();
    if (
      settings.enabled !== oldEnabled ||
      settings.hotkey !== oldHotkey ||
      settings.autoEnterHotkey !== oldAutoEnterHotkey ||
      settings.cancelHotkey !== oldCancelHotkey
    ) {
      registerHotkey();
    }
    if (settings.enabled !== oldEnabled || settings.showChip !== oldShowChip) {
      applyChipVisibility();
    }
    broadcastState();
    return settings;
  });

  ipcMain.handle('global-dict:toggle', () => { toggleRecording(); return state; });
  ipcMain.handle('global-dict:cancel', () => { cancelRecording(); return state; });
  ipcMain.handle('global-dict:stop', () => { stopRecording(); return state; });
  ipcMain.on('global-dict:rec:final', (_e, payload) => {
    handleFinalTranscript((payload && payload.text) || '');
  });

  // Recording window asks for height changes as the transcript grows.
  // We anchor the BOTTOM edge — window grows upward, not downward, so the
  // chip below isn't covered.
  ipcMain.on('global-dict:rec:resize', (_e, payload) => {
    if (!recWindow || recWindow.isDestroyed()) return;
    try {
      const newH = Math.max(20, Math.min(payload?.height || 0, computeRecWindowMaxHeight()));
      const b = recWindow.getBounds();
      const bottom = b.y + b.height;
      const x = b.x;
      const y = bottom - newH;
      recWindow.setBounds({ x, y, width: b.width, height: newH }, false);
    } catch (e) { console.error('[GlobalDict] rec:resize failed: ' + e.message); }
  });

  ipcMain.handle('global-dict:history:get', () => loadHistory());
  ipcMain.handle('global-dict:history:clear', () => {
    try { fs.writeFileSync(HISTORY_PATH, '[]'); } catch {}
    return true;
  });
  // Remove a single entry by ts (entries have no id; ts is effectively unique).
  ipcMain.handle('global-dict:history:delete', (_e, ts) => {
    try {
      const list = loadHistory().filter((e) => e.ts !== ts);
      fs.writeFileSync(HISTORY_PATH, JSON.stringify(list));
      return { ok: true, count: list.length };
    } catch (e) { return { ok: false, error: e.message }; }
  });
  // Copy a single entry to system clipboard.
  ipcMain.handle('global-dict:history:copy', (_e, ts) => {
    try {
      const list = loadHistory();
      const entry = list.find((e) => e.ts === ts);
      if (!entry) return { ok: false, error: 'not-found' };
      clipboard.writeText(entry.text);
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });
  // Reveal history.json in Finder so user can inspect / back it up.
  ipcMain.handle('global-dict:history:open-folder', () => {
    try {
      ensureDir();
      // showItemInFolder both opens Finder AND highlights the file.
      if (fs.existsSync(HISTORY_PATH)) {
        shell.showItemInFolder(HISTORY_PATH);
      } else {
        shell.openPath(STORAGE_DIR);
      }
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('global-dict:accessibility-check', () => {
    if (process.platform !== 'darwin') return { trusted: true, supported: false };
    const trusted = systemPreferences.isTrustedAccessibilityClient(false);
    return { trusted, supported: true };
  });
  ipcMain.handle('global-dict:accessibility-prompt', () => {
    if (process.platform !== 'darwin') return { trusted: true };
    // Pass true → triggers the macOS prompt if not yet decided.
    const trusted = systemPreferences.isTrustedAccessibilityClient(true);
    return { trusted };
  });
  ipcMain.handle('global-dict:accessibility-open-settings', () => {
    try {
      shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  // ── Menu (popover above the chip) ──
  ipcMain.handle('global-dict:menu:open', () => { openMenuWindow(); return { ok: true }; });
  ipcMain.handle('global-dict:menu:close', () => { closeMenuWindow(); return { ok: true }; });
  ipcMain.handle('global-dict:menu:select', (_e, action) => {
    console.log('[GlobalDict] menu:select ' + action);
    closeMenuWindow();
    if (action === 'speak') {
      startRecording();
    } else if (action === 'copy' || action === 'copy-last') {
      const hist = loadHistory();
      if (hist.length && hist[0].text) {
        try { clipboard.writeText(hist[0].text); console.log('[GlobalDict] copy: copied ' + hist[0].text.length + ' chars'); }
        catch (e) { console.error('[GlobalDict] copy failed: ' + e.message); }
      }
    } else if (action === 'open-settings') {
      const mw = getMainWindow();
      if (mw && !mw.isDestroyed()) {
        try { mw.show(); mw.focus(); mw.webContents.send('open-settings', { tab: 'dictation' }); } catch {}
      }
    }
    return { ok: true };
  });

  // ── Per-session autoEnter toggle (live during recording) ──
  ipcMain.handle('global-dict:set-session-auto-enter', (_e, v) => {
    sessionAutoEnter = !!v;
    console.log('[GlobalDict] sessionAutoEnter=' + sessionAutoEnter);
    broadcastState();
    return sessionAutoEnter;
  });

  // ── Chip drag persistence ──
  // Renderer reports both drag intent (`drag:start`/`drag:move`) and final
  // position. We move the BrowserWindow itself with setBounds, and on
  // drag-end normalise to a percentage of workArea of the display the chip
  // landed on, so the position survives monitor changes.
  ipcMain.on('global-dict:chip:move-to', (_e, { x, y }) => {
    if (!chipWindow || chipWindow.isDestroyed()) return;
    try {
      const b = chipWindow.getBounds();
      chipWindow.setBounds({ x: Math.round(x), y: Math.round(y), width: b.width, height: b.height }, false);
    } catch (e) { console.error('[GlobalDict] chip move-to failed: ' + e.message); }
  });
  ipcMain.on('global-dict:chip:drag-end', () => {
    if (!chipWindow || chipWindow.isDestroyed()) return;
    try {
      const b = chipWindow.getBounds();
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      const display = screen.getDisplayNearestPoint({ x: cx, y: cy });
      const wa = display.workArea;
      // Store CENTER position as fraction (0..1) of the work area, plus the
      // display id so we can restore onto the same physical monitor next
      // launch even if it's not primary. Storing center (not top-left) means
      // the resulting position is invariant under chip-size changes too.
      settings.chipPos = {
        cxPct: (cx - wa.x) / wa.width,
        cyPct: (cy - wa.y) / wa.height,
        displayId: display.id,
        // Absolute fallback (for migration / monitor lost).
        x: b.x,
        y: b.y,
      };
      saveSettings();
      console.log('[GlobalDict] chip drag-end saved cxPct=' + settings.chipPos.cxPct.toFixed(3) + ' cyPct=' + settings.chipPos.cyPct.toFixed(3) + ' displayId=' + display.id);
    } catch (e) { console.error('[GlobalDict] chip drag-end failed: ' + e.message); }
  });
  ipcMain.handle('global-dict:chip:get-pos', () => {
    if (!chipWindow || chipWindow.isDestroyed()) return null;
    const b = chipWindow.getBounds();
    return { x: b.x, y: b.y, width: b.width, height: b.height };
  });
}

function init(opts = {}) {
  if (process.platform !== 'darwin') {
    console.log('[GlobalDict] Skipped: non-darwin platform');
    return;
  }
  getMainWindow = opts.getMainWindow || (() => null);
  loadSettings();
  // IPC handlers are safe to register before app ready.
  registerIPC();
  // globalShortcut.register and BrowserWindow require app.isReady().
  const proceed = () => {
    registerHotkey();
    applyChipVisibility();
    app.on('will-quit', () => {
      try { globalShortcut.unregisterAll(); } catch {}
    });
    console.log('[GlobalDict] init complete (enabled=' + settings.enabled + ')');
  };
  if (app.isReady()) proceed();
  else app.whenReady().then(proceed);
}

module.exports = { init };
