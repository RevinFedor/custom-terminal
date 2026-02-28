const { app, BrowserWindow, ipcMain, Menu, dialog } = require('electron');
const path = require('path');
const pty = require('node-pty');
const fs = require('fs');
const os = require('os');
const { stripVTControlCharacters } = require('node:util');
const crypto = require('crypto');

// Disable HTTP cache to ensure fresh code after updates
app.commandLine.appendSwitch('disable-http-cache');

// Load modules from src/main (works for both dev and production)
const srcMainDir = path.join(__dirname, '..', '..', 'src', 'main');
const projectManager = require(path.join(srcMainDir, 'project-manager'));
const SessionManager = require(path.join(srcMainDir, 'session-manager'));
const ClaudeManager = require(path.join(srcMainDir, 'claude-manager'));
const { resolveGeminiProjectDir, findGeminiSessionFile, invalidateProjectsJsonCache, getGeminiProjectsJson, calculateGeminiHash } = require(path.join(srcMainDir, 'gemini-utils'));
const ClaudeAgentManager = require(path.join(srcMainDir, 'claude-agent'));

const isDev = !app.isPackaged;

// ⚡ КРИТИЧЕСКИ ВАЖНО: Устанавливаем activation policy ДО app.whenReady()
// Это обходит защиту macOS Sequoia/Tahoe от "focus stealing" для дочерних процессов
if (process.platform === 'darwin') {
  console.log('[Startup] Setting activation policy to "regular"...');
  app.setActivationPolicy('regular');
}

let mainWindow;
const terminals = new Map(); // tabId -> ptyProcess
const terminalProjects = new Map(); // tabId -> cwd path
const terminalCommandState = new Map(); // tabId -> { isRunning: boolean, lastExitCode: number }
// Claude Handshake: prompt injection with debounce (thinking handled by alwaysThinkingEnabled)
// States: 'WAITING_PROMPT' -> 'DEBOUNCE_PROMPT' -> send prompt -> done
const claudeState = new Map(); // tabId -> state string | null
const claudePendingPrompt = new Map(); // tabId -> prompt string
const claudeDebounceTimers = new Map(); // tabId -> debounce timer ID
const claudeCtrlCDangerZone = new Map(); // tabId -> { resolve, promise, timer } (event-driven clear on prompt return)
let sessionManager; // Initialized after projectManager is ready
let claudeManager; // Initialized with terminals map
const claudeAgentManager = new ClaudeAgentManager();
const claudeAgentBuffer = new Map(); // tabId -> stripped text buffer for :::claude::: detection
const claudeAgentCooldown = new Map(); // tabId -> timestamp (ms) — ignore detections until cooldown expires
const claudeAgentArmed = new Map();   // tabId -> boolean — only detect after first user input (prevents restore replay)

// ========== PROMPT BOUNDARY MARKERS (OSC 7777 injection for deterministic navigation) ==========
// State machine per tab: 'idle' (prompt visible) → 'busy' (Claude processing) → 'idle' (inject marker!)
// When BUSY→IDLE transition detected, we inject OSC 7777 into PTY data BEFORE sending to renderer.
// xterm.js parser fires registerOscHandler(7777) → registerMarker(0) at exact buffer position.
const promptBoundaryState = new Map(); // tabId → 'idle' | 'busy'
const promptBoundarySeq = new Map();   // tabId → number (auto-increment sequence)

// ========== SESSION BRIDGE (StatusLine-based session detection) ==========
// Claude's statusLine feature calls ~/.claude/statusline-bridge.sh after every response,
// writing {session_id, ppid, cwd, ...} to ~/.claude/bridge/{session_id}.json.
// We watch that directory and match bridge files to tabs via PID tree:
// bridge.ppid (Claude PID) → parent PID (shell) → ptyProcess.pid (our tab)
const bridgeDir = path.join(os.homedir(), '.claude', 'bridge');
const bridgeKnownSessions = new Map(); // tabId → sessionId
const bridgePidCache = new Map(); // claudePid → tabId
const bridgeFileMtimes = new Map(); // filename → mtimeMs
let bridgeWatcher = null;
let bridgePollInterval = null;

function startSessionBridge() {
  try { fs.mkdirSync(bridgeDir, { recursive: true }); } catch {}

  const processFile = async (filename) => {
    const filePath = path.join(bridgeDir, filename);
    try {
      const stat = fs.statSync(filePath);
      if (bridgeFileMtimes.get(filename) === stat.mtimeMs) return;
      bridgeFileMtimes.set(filename, stat.mtimeMs);

      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (!data.session_id || !data.ppid) return;

      // Check PID cache first
      let tabId = bridgePidCache.get(data.ppid);
      let pidSource = tabId ? 'cache' : 'resolve';

      if (!tabId) {
        // Resolve Claude PID → parent (shell PID) → match to our PTY
        try {
          const ppidStr = await execAsync('ps -p ' + data.ppid + ' -o ppid=');
          const shellPid = parseInt(ppidStr.trim());
          for (const [tid, pty] of terminals) {
            if (pty.pid === shellPid) { tabId = tid; break; }
          }
          if (tabId) bridgePidCache.set(data.ppid, tabId);
        } catch {}
      }

      if (!tabId) return; // Not our process

      // Debug: log PID chain resolution for session detection
      const knownForTab = bridgeKnownSessions.get(tabId);
      if (knownForTab !== data.session_id) {
        console.log('[Bridge:PID] session=' + data.session_id.substring(0, 8) + '... claudePid=' + data.ppid + ' → tab=' + tabId + ' (via ' + pidSource + ') | was=' + (knownForTab ? knownForTab.substring(0, 8) + '...' : 'none'));
      }

      // Always send bridge metadata (model, context) on every update
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('claude:bridge-update', {
          tabId,
          sessionId: data.session_id,
          model: data.model || 'unknown',
          contextPct: data.context_pct || 0
        });
      }

      // Check for session change
      const oldSessionId = bridgeKnownSessions.get(tabId);
      if (oldSessionId === data.session_id) return;

      bridgeKnownSessions.set(tabId, data.session_id);
      console.log('[Bridge] Tab', tabId, '-> session:', data.session_id.substring(0, 8) + '...', '(model:', data.model + ', ctx:', data.context_pct + '%)');

      // Save session link for Clear Context chain resolution (old → new)
      if (oldSessionId) {
        console.log('[Bridge] Session transition:', oldSessionId.substring(0, 8) + '...', '→', data.session_id.substring(0, 8) + '...');
        try {
          projectManager.db.saveSessionLink(oldSessionId, data.session_id);
        } catch (e) {
          console.error('[Bridge] Failed to save session link:', e.message);
        }
      }

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('claude:session-detected', { tabId, sessionId: data.session_id });
      }
    } catch {}
  };

  const scan = async () => {
    try {
      const files = fs.readdirSync(bridgeDir).filter(f => f.endsWith('.json') && !f.startsWith('_'));
      for (const f of files) await processFile(f);
    } catch {}
  };

  // Method 1: fs.watch for instant detection
  try {
    bridgeWatcher = fs.watch(bridgeDir, (eventType, filename) => {
      if (filename?.endsWith('.json') && !filename.startsWith('_')) {
        processFile(filename);
      }
    });
    console.log('[Bridge] fs.watch active on', bridgeDir);
  } catch (e) {
    console.log('[Bridge] fs.watch failed:', e.message);
  }

  // Method 2: polling every 2s (reliable fallback)
  bridgePollInterval = setInterval(scan, 2000);
  console.log('[Bridge] Polling active (2s interval)');

  // Initial scan
  scan();
}

function stopSessionBridge() {
  if (bridgeWatcher) { try { bridgeWatcher.close(); } catch {} bridgeWatcher = null; }
  if (bridgePollInterval) { clearInterval(bridgePollInterval); bridgePollInterval = null; }
}

function clearBridgeTab(tabId) {
  bridgeKnownSessions.delete(tabId);
  promptBoundaryState.delete(tabId);
  promptBoundarySeq.delete(tabId);
  for (const [pid, tid] of bridgePidCache) {
    if (tid === tabId) bridgePidCache.delete(pid);
  }
}

// Shell integration directory (for OSC 7 cwd reporting + OSC 133 command lifecycle)
const shellIntegrationDir = path.join(app.getPath('userData'), 'shell-integration');

// Create shell integration files on startup
function setupShellIntegration() {
  // Create directory
  if (!fs.existsSync(shellIntegrationDir)) {
    fs.mkdirSync(shellIntegrationDir, { recursive: true });
  }

  // Zsh integration - .zshrc that loads user's config and adds OSC 7 + OSC 133
  // IMPORTANT: Use \033 (octal) for ESC and \007 for BEL - \e doesn't work reliably
  const zshIntegration = `# Noted Terminal Shell Integration
# This file is auto-generated - do not edit

# Load user's original .zshrc
if [[ -f "$HOME/.zshrc" ]]; then
  ZDOTDIR="$HOME" source "$HOME/.zshrc"
fi

# OSC 7 - Report current directory to terminal
__ct_osc7() {
  printf "\\033]7;file://%s%s\\033\\\\" "$HOST" "$PWD"
}

# ============ OSC 133 - Command Lifecycle (VS Code protocol) ============
# A - Prompt started
# B - Command started (after user presses Enter)
# C - Command executing
# D;exit_code - Command finished with exit code

__ct_precmd() {
  local ret=$?
  # Command finished (D)
  printf "\\033]133;D;%s\\007" "$ret"
  # Report cwd
  printf "\\033]7;file://%s%s\\033\\\\" "$HOST" "$PWD"
  # Prompt starting (A)
  printf "\\033]133;A\\007"
}

__ct_preexec() {
  # Command started (B)
  printf "\\033]133;B\\007"
  # Command executing (C)
  printf "\\033]133;C\\007"
}

# Install hooks
autoload -Uz add-zsh-hook 2>/dev/null
add-zsh-hook precmd __ct_precmd
add-zsh-hook preexec __ct_preexec

# Send initial prompt
printf "\\033]133;A\\007"
`;

  // Bash integration - use \033 (octal) for ESC
  const bashIntegration = `# Noted Terminal Shell Integration
# This file is auto-generated - do not edit

# Load user's original .bashrc
if [[ -f "$HOME/.bashrc" ]]; then
  source "$HOME/.bashrc"
fi

__ct_in_command=0

__ct_prompt_command() {
  local ret=$?
  if [[ "$__ct_in_command" == "1" ]]; then
    # Command finished (D)
    printf "\\033]133;D;%s\\007" "$ret"
    __ct_in_command=0
  fi
  # Report cwd (OSC 7)
  printf "\\033]7;file://%s%s\\033\\\\" "$HOSTNAME" "$PWD"
  # Prompt starting (A)
  printf "\\033]133;A\\007"
}

__ct_preexec() {
  if [[ "$BASH_COMMAND" != "__ct_prompt_command" && "$__ct_in_command" == "0" ]]; then
    # Command started (B) + executing (C)
    printf "\\033]133;B\\007"
    printf "\\033]133;C\\007"
    __ct_in_command=1
  fi
}

PROMPT_COMMAND="__ct_prompt_command"
trap '__ct_preexec' DEBUG

# Initial prompt
printf "\\033]133;A\\007"
`;

  // Write integration files
  fs.writeFileSync(path.join(shellIntegrationDir, '.zshrc'), zshIntegration);
  fs.writeFileSync(path.join(shellIntegrationDir, '.bashrc'), bashIntegration);

  console.log('[Shell Integration] Created at:', shellIntegrationDir);
}

// Parse OSC 133 sequences and emit events
// OSC 133 format: \x1b]133;X\x07 or \x1b]133;X;param\x07
// X can be: A (prompt start), B (command start), C (executing), D;exitcode (finished)
function parseOSC133AndEmit(tabId, data) {
  // Regex to match OSC 133 sequences
  // \x1b] = ESC ]
  // 133; = OSC 133
  // ([A-D]) = command type
  // (;[^]*?)? = optional params (like exit code for D)
  // [\x07\x1b\\] = terminator (BEL or ST)
  const osc133Regex = /\x1b\]133;([A-D])(;[^\x07\x1b]*)?(?:\x07|\x1b\\)/g;

  let match;
  while ((match = osc133Regex.exec(data)) !== null) {
    const type = match[1];
    const param = match[2] ? match[2].slice(1) : null; // Remove leading ';'

    const state = terminalCommandState.get(tabId) || { isRunning: false, lastExitCode: 0 };

    switch (type) {
      case 'A': // Prompt start - shell is waiting for input
        console.log(`[OSC 133] Tab ${tabId}: Prompt ready (A)`);
        break;

      case 'B': // Command start - user pressed Enter
        console.log(`[OSC 133] Tab ${tabId}: Command STARTED (B)`);
        state.isRunning = true;
        terminalCommandState.set(tabId, state);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('terminal:command-started', { tabId });
        }
        break;

      case 'C': // Command executing
        console.log(`[OSC 133] Tab ${tabId}: Executing (C)`);
        // Already handled by B
        break;

      case 'D': // Command finished
        state.isRunning = false;
        state.lastExitCode = param ? parseInt(param, 10) : 0;
        console.log(`[OSC 133] Tab ${tabId}: Command FINISHED (D) exitCode=${state.lastExitCode}`);
        terminalCommandState.set(tabId, state);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('terminal:command-finished', {
            tabId,
            exitCode: state.lastExitCode
          });
        }
        break;
    }
  }
}

function createWindow() {
  console.log('Plan Mode test OK');
  console.log('[Window] Creating main window...');

  const windowOptions = {
    width: 1900,
    height: 1000,
    show: false, // Don't show until ready-to-show
    backgroundColor: '#1a1a1a', // Dark background instead of white flash
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: 'rgba(0,0,0,0)',
      height: 40,
      symbolColor: '#ffffff'
    },
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webviewTag: true,
    },
  };

  mainWindow = new BrowserWindow(windowOptions);
  console.log('[Window] BrowserWindow created');

  // Show window when ready and force focus on macOS (Sequoia/Tahoe workaround)
  mainWindow.once('ready-to-show', () => {
    console.log('[Window] ready-to-show fired, showing window...');
    mainWindow.show();

    // macOS Sequoia/Tahoe: Triple activation для обхода focus stealing protection
    if (process.platform === 'darwin') {
      setTimeout(() => {
        console.log('[Window] Forcing focus (moveTop + focus + steal)...');
        mainWindow.moveTop();
        app.focus({ steal: true });
        mainWindow.focus();
      }, 50);
    }
  });

  // Set dev icon in Dock if in development mode (macOS specific)
  if (isDev && process.platform === 'darwin') {
    const devIconPath = path.join(__dirname, '..', '..', 'build-resources', 'icon-dev.png');
    if (require('fs').existsSync(devIconPath)) {
      app.dock.setIcon(devIconPath);
    }
  }

  // Load from Vite dev server in dev mode, or from built files in production
  if (process.env.ELECTRON_RENDERER_URL) {
    console.log('[Window] Loading URL:', process.env.ELECTRON_RENDERER_URL);
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
    mainWindow.webContents.openDevTools();
  } else if (isDev) {
    console.log('[Window] Loading fallback URL: http://localhost:5182');
    mainWindow.loadURL('http://localhost:5182');
    mainWindow.webContents.openDevTools();
  } else {
    const filePath = path.join(__dirname, '..', 'renderer', 'index.html');
    console.log('[Window] Loading file:', filePath);
    mainWindow.loadFile(filePath);
  }

  // Логи для отладки загрузки
  mainWindow.webContents.on('did-start-loading', () => {
    console.log('[Window] did-start-loading');
  });

  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[Window] did-finish-load');
  });

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.error('[Window] did-fail-load:', errorCode, errorDescription);
  });
}

// Context Menu IPC
ipcMain.on('show-terminal-context-menu', async (event, { hasSelection, prompts, tabId, projectId, cwd }) => {
  // Load dynamic AI prompts from DB
  let aiPrompts = [];
  try {
    aiPrompts = projectManager.getAIPrompts().filter(p => p.showInContextMenu);
  } catch (e) {
    console.error('[ContextMenu] Failed to load AI prompts:', e);
  }

  const template = [];

  // Dynamic AI prompt items
  for (const aiPrompt of aiPrompts) {
    template.push({
      label: `${aiPrompt.name}`,
      enabled: hasSelection,
      click: () => { event.sender.send('context-menu-command', 'ai-prompt', aiPrompt.id); }
    });
  }

  // Fallback if no AI prompts loaded
  if (aiPrompts.length === 0) {
    template.push({
      label: '🔍 Research',
      enabled: hasSelection,
      click: () => { event.sender.send('context-menu-command', 'ai-prompt', 'research'); }
    });
    template.push({
      label: '📋 Compact',
      enabled: hasSelection,
      click: () => { event.sender.send('context-menu-command', 'ai-prompt', 'compact'); }
    });
  }

  template.push({ type: 'separator' });

  // Add Insert Prompt submenu
  if (prompts && prompts.length > 0) {
    const promptsSubmenu = prompts.map(prompt => ({
      label: prompt.title,
      click: () => {
        event.sender.send('context-menu-command', 'insert-prompt', prompt.content);
      }
    }));

    template.push({
      label: 'Insert Prompt',
      submenu: promptsSubmenu
    });
    template.push({ type: 'separator' });
  }

  // Scripts submenu: npm scripts from package.json + .sh files
  const scripts = [];
  if (cwd) {
    try {
      const fs = require('fs');
      const path = require('path');

      // 1. npm scripts from package.json
      const pkgPath = path.join(cwd, 'package.json');
      if (fs.existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
          if (pkg.scripts) {
            Object.keys(pkg.scripts)
              .filter(name => !name.startsWith('_'))
              .forEach(name => {
                scripts.push({
                  label: `npm run ${name}`,
                  click: () => {
                    event.sender.send('context-menu-command', 'run-script', { tabId, command: `npm run ${name}\r` });
                  }
                });
              });
          }
        } catch (e) {
          console.error('[ContextMenu] Failed to parse package.json:', e);
        }
      }

      // 2. .sh files in CWD
      const shFiles = fs.readdirSync(cwd).filter(f => f.endsWith('.sh') && !f.startsWith('.'));
      shFiles.forEach(file => {
        scripts.push({
          label: `./${file}`,
          click: () => {
            event.sender.send('context-menu-command', 'run-script', { tabId, command: `./${file}\r` });
          }
        });
      });
    } catch (e) {
      console.error('[ContextMenu] Failed to load scripts:', e);
    }
  }

  // Check if tab has a running devServer process
  const cmdState = terminalCommandState.get(tabId);
  const isRunning = cmdState && cmdState.isRunning;

  if (scripts.length > 0 || isRunning) {
    const submenu = [];

    // Active process — stop option at top
    if (isRunning) {
      submenu.push({
        label: '\u25CF Stop process (Ctrl+C)',
        click: () => {
          const term = terminals.get(tabId);
          if (term) term.write('\x03');
        }
      });
      if (scripts.length > 0) {
        submenu.push({ type: 'separator' });
      }
    }

    submenu.push(...scripts);

    template.push({
      label: isRunning ? `Scripts (\u25CF running)` : `Scripts (${scripts.length})`,
      submenu
    });
    template.push({ type: 'separator' });
  }

  // Removed: Add to Favorites (only in TabBar context menu)

  template.push({ role: 'copy' });
  template.push({ role: 'paste' });
  template.push({ type: 'separator' });
  template.push({ role: 'selectAll' });

  const menu = Menu.buildFromTemplate(template);
  menu.popup(BrowserWindow.fromWebContents(event.sender));
});

app.whenReady().then(() => {
  // Диагностика для отладки проблемы с окном
  console.log('[Startup] ═══════════════════════════════════════');
  console.log('[Startup] Platform:', process.platform);
  console.log('[Startup] Is packaged:', app.isPackaged);
  console.log('[Startup] isDev:', isDev);
  console.log('[Startup] Process type:', process.type);
  console.log('[Startup] Parent PID:', process.ppid);
  console.log('[Startup] ELECTRON_RENDERER_URL:', process.env.ELECTRON_RENDERER_URL || '(not set)');
  console.log('[Startup] ═══════════════════════════════════════');

  // Setup shell integration (OSC 7 for cwd reporting)
  console.log('[Startup] Setting up shell integration...');
  setupShellIntegration();

  // Initialize session manager with database from project manager
  console.log('[Startup] Initializing SessionManager...');
  try {
    sessionManager = new SessionManager(projectManager.db);
    console.log('[Startup] SessionManager OK');
  } catch (e) {
    console.error('[Startup] SessionManager ERROR:', e.message);
  }

  // Initialize Claude Manager
  console.log('[Startup] Initializing ClaudeManager...');
  try {
    claudeManager = new ClaudeManager(terminals, terminalProjects, claudeState);
    console.log('[Startup] ClaudeManager OK');
  } catch (e) {
    console.error('[Startup] ClaudeManager ERROR:', e.message);
    // Продолжаем без ClaudeManager — окно всё равно должно открыться
  }

  // Initialize Session Bridge (StatusLine-based Claude session detection)
  console.log('[Startup] Starting SessionBridge...');
  try {
    startSessionBridge();
    console.log('[Startup] SessionBridge OK');
  } catch (e) {
    console.error('[Startup] SessionBridge ERROR:', e.message);
  }

  console.log('[Startup] Calling createWindow()...');
  createWindow();
  console.log('[Startup] createWindow() returned');
});

app.on('window-all-closed', () => {
  // Kill all terminals
  for (const [tabId, term] of terminals) {
    term.kill();
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  console.log('[Activate] Dock icon clicked');
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  } else if (mainWindow) {
    // Show and focus existing window when clicking dock icon
    mainWindow.show();
    if (process.platform === 'darwin') {
      mainWindow.moveTop();
      app.focus({ steal: true });
    }
  }
});

// Shared helper: format tool_use block for clean export
function formatToolAction(toolName, input, toolResult = null, includeEditing = false, includeReading = false, opts = {}) {
  const { includeSubagentResult = false, includeSubagentHistory = false, progressEntries = [] } = opts;
  let label = '';
  switch (toolName) {
    case 'Read': label = '📄 Чтение (' + (input.file_path || '?') + ')'; break;
    case 'Edit': label = '✏️ Редактирование (' + (input.file_path || '?') + ')'; break;
    case 'Write': label = '📝 Создание (' + (input.file_path || '?') + ')'; break;
    case 'Bash': {
      const cmd = (input.command || '').substring(0, 50);
      label = '🖥 Команда ("' + cmd + (input.command?.length > 50 ? '...' : '') + '")';
      break;
    }
    case 'Glob': label = '🔍 Поиск файлов (' + (input.pattern || '?') + ')'; break;
    case 'Grep': label = '🔍 Поиск в коде (' + (input.pattern || '?') + ')'; break;
    case 'Task': {
      const desc = input.description || input.prompt?.substring(0, 60) || '';
      label = '🧵 Субагент (' + desc + ')';
      break;
    }
    default: label = '⚙️ ' + toolName;
  }

  const shouldInclude =
    ((toolName === 'Edit' || toolName === 'Write' || toolName === 'Bash') && includeEditing) ||
    (toolName === 'Read' && includeReading) ||
    (toolName === 'Task' && (includeSubagentResult || includeSubagentHistory));

  if (!shouldInclude) return label;

  let detail = '';
  if (toolName === 'Read' && toolResult?.content) {
    detail = '\n```\n' + toolResult.content + '\n```';
  } else if (toolName === 'Edit' && input.old_string != null) {
    detail = '\n```diff\n- ' + input.old_string + '\n+ ' + input.new_string + '\n```';
  } else if (toolName === 'Write' && input.content) {
    detail = '\n```\n' + input.content + '\n```';
  } else if (toolName === 'Bash' && toolResult?.content) {
    detail = '\n```\n' + toolResult.content + '\n```';
  } else if (toolName === 'Task') {
    // Sub-agent result
    if (includeSubagentResult && toolResult) {
      const resultText = typeof toolResult.content === 'string'
        ? toolResult.content
        : Array.isArray(toolResult.content)
          ? toolResult.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
          : '';
      if (resultText) {
        detail += '\n> **Result:** ' + resultText.split('\n').join('\n> ');
      }
    }
    // Sub-agent history from progress entries
    if (includeSubagentHistory && progressEntries.length > 0) {
      const historyLines = [];
      for (const pe of progressEntries) {
        const msg = pe.data?.message;
        if (!msg) continue;
        if (msg.type === 'user') {
          const content = typeof msg.message?.content === 'string'
            ? msg.message.content
            : Array.isArray(msg.message?.content)
              ? msg.message.content.filter(c => c.type === 'text').map(c => c.text).join(' ')
              : '';
          if (content) historyLines.push('> 👤 ' + content.substring(0, 200));
        } else if (msg.type === 'assistant') {
          const mc = msg.message?.content;
          if (typeof mc === 'string') {
            historyLines.push('> 🤖 ' + mc.substring(0, 200));
          } else if (Array.isArray(mc)) {
            const textParts = mc.filter(c => c.type === 'text').map(c => c.text);
            const toolUses = mc.filter(c => c.type === 'tool_use');
            if (textParts.length > 0) historyLines.push('> 🤖 ' + textParts.join(' ').substring(0, 200));
            for (const tu of toolUses) {
              const tuInput = tu.input || {};
              if (tu.name === 'Bash') {
                historyLines.push('> 🖥 Команда ("' + (tuInput.command || '').substring(0, 80) + '")');
              } else if (tu.name === 'Edit' || tu.name === 'Write' || tu.name === 'Read') {
                historyLines.push('> 📄 ' + tu.name + ' (' + (tuInput.file_path || '?') + ')');
              } else {
                historyLines.push('> ⚙️ ' + tu.name);
              }
            }
          }
        }
      }
      if (historyLines.length > 0) {
        detail += '\n>\n> **History:**\n' + historyLines.join('\n');
      }
    }
  }

  return label + detail;
}

// Export a range of messages from Claude session
ipcMain.handle('claude:copy-range', async (event, { sessionId, cwd, startUuid, endUuid, includeEditing = false, includeReading = false, includeSubagentResult = false, includeSubagentHistory = false }) => {
  console.log('[Claude Export] Exporting range from', startUuid, 'to', endUuid);

  if (!sessionId) return { success: false, error: 'No session ID' };

  try {
    // Use the same chain resolution as claude:get-timeline
    // This ensures we can find UUIDs across plan mode boundaries
    const { mergedMap: recordMap, lastRecord, sessionBoundaries, progressEntries: allProgressEntries } = resolveSessionChain(sessionId, cwd);

    // Build progress entries index by parentToolUseID
    const progressByToolUseId = new Map();
    for (const pe of allProgressEntries) {
      const key = pe.parentToolUseID;
      if (!progressByToolUseId.has(key)) progressByToolUseId.set(key, []);
      progressByToolUseId.get(key).push(pe);
    }

    if (!lastRecord) return { success: false, error: 'No records found' };

    // BACKTRACE: identical to claude:get-timeline
    const activeHistory = [];
    let current = lastRecord.uuid;
    const seen = new Set();

    while (current && !seen.has(current)) {
      seen.add(current);
      const record = recordMap.get(current);
      if (!record) {
        let recovered = false;
        if (activeHistory.length > 0) {
          const lastAdded = activeHistory[0];
          if (lastAdded.type === 'system' && lastAdded.subtype === 'compact_boundary' &&
              lastAdded.logicalParentUuid === current) {
            if (lastAdded.parentUuid && recordMap.has(lastAdded.parentUuid) && !seen.has(lastAdded.parentUuid)) {
              current = lastAdded.parentUuid;
              recovered = true;
            } else {
              let bestPred = null;
              for (const [uuid, entry] of recordMap) {
                if (seen.has(uuid)) continue;
                if (entry._fromFile === lastAdded._fromFile &&
                    entry._fileIndex < lastAdded._fileIndex) {
                  if (!bestPred || entry._fileIndex > bestPred._fileIndex) {
                    bestPred = entry;
                  }
                }
              }
              if (bestPred) {
                current = bestPred.uuid;
                recovered = true;
              }
            }
          }
        }
        if (recovered) continue;
        break;
      }

      activeHistory.unshift(record);

      let nextUuid = record.logicalParentUuid || record.parentUuid;
      if (!nextUuid && sessionBoundaries.length > 0) {
        for (const [uuid, entry] of recordMap) {
          if (seen.has(uuid)) continue;
          if (entry._isBridge && entry.parentUuid && entry.sessionId !== record.sessionId &&
              !seen.has(entry.parentUuid)) {
            nextUuid = entry.parentUuid;
            break;
          }
        }
        if (!nextUuid && record.sessionId) {
          const boundary = sessionBoundaries.find(b => b.childSessionId === record.sessionId);
          if (boundary) {
            let parentLast = null;
            for (const [uuid, entry] of recordMap) {
              if (seen.has(uuid)) continue;
              if (entry._fromFile === boundary.parentSessionId) {
                if (!parentLast || entry._fileIndex > parentLast._fileIndex) parentLast = entry;
              }
            }
            if (parentLast) nextUuid = parentLast.uuid;
          }
        }
      }

      current = nextUuid;
    }

    // Find the range in the active history
    const startIndex = activeHistory.findIndex(e => e.uuid === startUuid);
    const endIndex = activeHistory.findIndex(e => e.uuid === endUuid);

    if (startIndex === -1 || endIndex === -1) {
      return { success: false, error: 'Selected range not found in active history' };
    }

    const minIdx = Math.min(startIndex, endIndex);
    let maxIdx = Math.max(startIndex, endIndex);

    // EXPAND RANGE: Include all assistant responses and system messages 
    // that follow the last selected message, until the next user message/compact starts.
    for (let i = maxIdx + 1; i < activeHistory.length; i++) {
      const entry = activeHistory[i];
      // Stop if we hit a new "point" (user message or compact boundary)
      if (entry.type === 'user' || (entry.type === 'system' && entry.subtype === 'compact_boundary')) {
        break;
      }
      maxIdx = i; // Include this assistant/system record
    }

    const range = activeHistory.slice(minIdx, maxIdx + 1);

    // Format the range
    let output = `# Claude Session Export (Range)\nSession: ${sessionId}\n\n---\n\n`;

    for (let i = 0; i < range.length; i++) {
      const entry = range[i];
      if (entry.isSidechain || entry.type === 'summary') continue;

      if (entry.type === 'user') {
        let rawContent = entry.message?.content;
        if (Array.isArray(rawContent)) {
          if (rawContent.some(item => item.type === 'tool_result')) continue;
          const textBlock = rawContent.find(item => item.type === 'text');
          rawContent = textBlock?.text || '';
        }
        if (!rawContent || typeof rawContent !== 'string') continue;
        if (rawContent.includes('[Request interrupted')) continue;
        if (rawContent.includes('<command-name>') ||
            rawContent.includes('<command-message>') ||
            rawContent.includes('<local-command-stdout>') ||
            rawContent.includes('<system-reminder>') ||
            rawContent.includes('<bash-notification>') ||
            rawContent.startsWith('Caveat: The messages below')) continue;

        output += '## User\n' + rawContent.replace(/\[200~/g, '').replace(/~\]/g, '').trim() + '\n\n';
      }
      else if (entry.type === 'assistant') {
        const msgContent = entry.message?.content;
        if (!msgContent) continue;

        let textContent = '';
        const toolActions = [];

        if (typeof msgContent === 'string') {
          textContent = msgContent;
        } else if (Array.isArray(msgContent)) {
          const textParts = [];
          for (const block of msgContent) {
            if (block.type === 'thinking' && block.thinking) {
              textParts.push('<thinking>\n' + block.thinking + '\n</thinking>');
            }
            if (block.type === 'text' && block.text) {
              textParts.push(block.text);
            }
            if (block.type === 'tool_use') {
              // Find matching tool_result in subsequent range records
              let toolResult = null;
              const needResult = includeEditing || includeReading || (block.name === 'Task' && includeSubagentResult);
              if (needResult) {
                for (let j = i + 1; j < range.length; j++) {
                  const nextEntry = range[j];
                  if (nextEntry.type === 'user' && Array.isArray(nextEntry.message?.content)) {
                    const res = nextEntry.message.content.find(c => c.type === 'tool_result' && c.tool_use_id === block.id);
                    if (res) {
                      toolResult = res;
                      break;
                    }
                  }
                }
              }
              const taskProgress = block.name === 'Task' && block.id ? (progressByToolUseId.get(block.id) || []) : [];
              const action = formatToolAction(block.name, block.input || {}, toolResult, includeEditing, includeReading, {
                includeSubagentResult, includeSubagentHistory, progressEntries: taskProgress
              });
              if (action) toolActions.push(action);
            }
          }
          textContent = textParts.join('\n\n');
        }

        if (textContent.trim() || toolActions.length > 0) {
          output += '## Claude\n';
          if (textContent.trim()) output += textContent + '\n';
          if (toolActions.length > 0) {
            if (includeEditing || includeReading) {
              output += '\n**Actions:**\n' + toolActions.join('\n\n') + '\n';
            } else {
              output += '   [Действия: ' + toolActions.join(', ') + ']\n';
            }
          }
          output += '\n';
        }
      }
      else if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
        output += '\n═══ HISTORY COMPACTED ═══\n\n';
      }
    }

    return { success: true, content: output };
  } catch (error) {
    console.error('[Claude Export] Error:', error);
    return { success: false, error: error.message };
  }
});

// Create new terminal for a tab
ipcMain.handle('terminal:create', async (event, { tabId, rows, cols, cwd, initialCommand }) => {
    console.time(`[PERF:main] terminal:create ${tabId}`);
    const shell = process.env.SHELL || '/bin/bash';
    const shellName = path.basename(shell);
    const workingDir = cwd || process.env.HOME;

    // Build env with shell integration
    const shellEnv = {
      ...process.env,
      COLORTERM: 'truecolor',  // Enable 24-bit colors for Ink-based CLIs (gemini, claude)
      LANG: process.env.LANG || 'en_US.UTF-8',
      LC_ALL: process.env.LC_ALL || 'en_US.UTF-8',
      TERM_PROGRAM: 'CustomTerminal',
      TERM_PROGRAM_VERSION: '1.0.0'
    };

    // Zsh: use ZDOTDIR to load our integration
    if (shellName === 'zsh') {
      shellEnv.ZDOTDIR = shellIntegrationDir;
    }

    // Bash: use BASH_ENV to source our integration
    if (shellName === 'bash') {
      shellEnv.BASH_ENV = path.join(shellIntegrationDir, '.bashrc');
    }

    console.time(`[PERF:main] pty.spawn ${tabId}`);

    // Build shell arguments
    // If initialCommand provided, run shell with -c to execute command after loading configs
    let shellArgs = [];
    if (initialCommand) {
      // For zsh/bash: -l (login shell) -c "command; exec shell"
      // This ensures .zshrc/.bashrc loads before command runs, then keeps shell open
      const escapedCmd = initialCommand.replace(/"/g, '\\"');
      shellArgs = ['-l', '-c', `${escapedCmd}; exec ${shell}`];
      console.log(`[terminal:create] ========== FORK DEBUG ==========`);
      console.log(`[terminal:create] tabId: ${tabId}`);
      console.log(`[terminal:create] initialCommand (raw): ${initialCommand}`);
      console.log(`[terminal:create] escapedCmd: ${escapedCmd}`);
      console.log(`[terminal:create] shell: ${shell}`);
      console.log(`[terminal:create] shellArgs:`, shellArgs);
      console.log(`[terminal:create] Full command: ${shell} ${shellArgs.join(' ')}`);
      console.log(`[terminal:create] ================================`);
    }

    const ptyProcess = pty.spawn(shell, shellArgs, {
      name: 'xterm-256color',
      cols: cols || 80,
      rows: rows || 24,
      cwd: workingDir,
      env: shellEnv
    });
    console.timeEnd(`[PERF:main] pty.spawn ${tabId}`);
    console.log(`[PTY:CREATED] tabId=${tabId} pid=${ptyProcess.pid} cwd=${workingDir} shell=${shell} args=${JSON.stringify(shellArgs)}`);

    terminals.set(tabId, ptyProcess);
    terminalProjects.set(tabId, workingDir);
    terminalCommandState.set(tabId, { isRunning: false, lastExitCode: 0 });

    ptyProcess.onData((data) => {
      // Parse OSC 133 for command lifecycle events (just spy, don't modify)
      parseOSC133AndEmit(tabId, data);

      // ========== CLAUDE HANDSHAKE (Prompt Injection) ==========
      // Wait for prompt to appear, debounce UI settling, then send pending prompt.
      // Note: Tab (\t) for thinking mode is NOT sent here — alwaysThinkingEnabled in
      // ~/.claude/settings.json handles it globally. Toggle is available via UI buttons.
      const DEBOUNCE_MS = 300;
      const currentState = claudeState.get(tabId);

      if (currentState) {
        const stripped = stripVTControlCharacters(data);
        const term = terminals.get(tabId);

        // STEP 1: WAITING_PROMPT -> See prompt char -> Start debounce
        // Claude v2.1.32+ uses ⏵ (U+23F5) instead of >
        if (currentState === 'WAITING_PROMPT' && (stripped.includes('⏵') || stripped.includes('>'))) {
          console.log('[Claude Handshake] Tab ' + tabId + ': Prompt detected. Starting debounce...');
          claudeState.set(tabId, 'DEBOUNCE_PROMPT');

          const timerId = setTimeout(async () => {
            console.log('[Claude Handshake] Tab ' + tabId + ': UI settled (' + DEBOUNCE_MS + 'ms silence). Sending prompt...');

            if (claudePendingPrompt.has(tabId)) {
              const pendingPrompt = claudePendingPrompt.get(tabId);
              claudePendingPrompt.delete(tabId);

              console.log('[Claude Handshake] Tab ' + tabId + ': Sending prompt (' + pendingPrompt.length + ' chars) via safePasteAndSubmit...');
              await safePasteAndSubmit(term, pendingPrompt, {
                submit: true,
                logPrefix: '[Handshake:' + tabId + ']'
              });
            } else {
              console.log('[Claude Handshake] Tab ' + tabId + ': ⚠️ No pending prompt found!');
            }

            claudeState.delete(tabId);
            claudeDebounceTimers.delete(tabId);
          }, DEBOUNCE_MS);
          claudeDebounceTimers.set(tabId, timerId);
        }

        // STEP 2: DEBOUNCE_PROMPT -> More data = Reset debounce
        else if (currentState === 'DEBOUNCE_PROMPT') {
          clearTimeout(claudeDebounceTimers.get(tabId));

          const timerId = setTimeout(async () => {
            console.log('[Claude Handshake] Tab ' + tabId + ': UI settled (debounce reset). Sending prompt...');

            if (claudePendingPrompt.has(tabId)) {
              const pendingPrompt = claudePendingPrompt.get(tabId);
              claudePendingPrompt.delete(tabId);

              console.log('[Claude Handshake] Tab ' + tabId + ': (reset) Sending prompt (' + pendingPrompt.length + ' chars) via safePasteAndSubmit...');
              await safePasteAndSubmit(term, pendingPrompt, {
                submit: true,
                logPrefix: '[Handshake:' + tabId + ':reset]'
              });
            } else {
              console.log('[Claude Handshake] Tab ' + tabId + ': (reset) ⚠️ No pending prompt found!');
            }

            claudeState.delete(tabId);
            claudeDebounceTimers.delete(tabId);
          }, DEBOUNCE_MS);
          claudeDebounceTimers.set(tabId, timerId);
        }
      }
      // ========== END HANDSHAKE ==========

      // Detect Session ID from /status TUI output → show toast in renderer
      // Only send if this tab is known to have an active Claude session to avoid Gemini false positives
      {
        const sc = stripVTControlCharacters(data);
        const m = sc.match(/Session\s*ID[:\s]*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
        if (m && bridgeKnownSessions.has(tabId) && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('claude:status-session-detected', { tabId, sessionId: m[1] });
        }
      }

      // ========== CTRL-C DANGER ZONE DETECTION ==========
      // Claude shows "Press Ctrl-C again to exit" after first Ctrl+C.
      // If we send another Ctrl+C (e.g. from send-command ctrlCFirst), Claude exits.
      // Hybrid: ON when marker detected, OFF when prompt returns AFTER minimum hold (3s).
      // Why min hold: Claude's Ink TUI re-renders full screen immediately after Ctrl+C,
      // and that re-render includes ⏵ prompt char. Without min hold, DZ would be set ON
      // and cleared OFF within milliseconds — but Claude's warning lasts ~3-4 seconds.
      {
        const sc = stripVTControlCharacters(data);

        // ENTER danger zone: detected "Press Ctrl-C again to exit" in PTY output
        // Claude Ink TUI uses cursor motion codes — after stripping, text can be:
        //   "PresCtrl-C again to exit" (from ctrlCFirst \x03)
        //   "Press Ctrl-Cagain to exit" (from user keyboard \x03)
        // Match "again to exit" which is stable across all variants.
        if (sc.includes('again to exit')) {
          // Clean up previous if any
          const prev = claudeCtrlCDangerZone.get(tabId);
          if (prev) clearTimeout(prev.timer);

          let resolve;
          const promise = new Promise(r => { resolve = r; });
          const timer = setTimeout(() => {
            // Safety fallback: clear after Claude's warning expires (~4s)
            if (claudeCtrlCDangerZone.has(tabId)) {
              claudeCtrlCDangerZone.delete(tabId);
              resolve();
              console.log('[CtrlC-DangerZone] Tab ' + tabId + ': CLEARED (TTL expired)');
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('claude:ctrlc-danger-zone', { tabId, active: false });
              }
            }
          }, 4000);
          claudeCtrlCDangerZone.set(tabId, { resolve, promise, timer, setAt: Date.now() });
          console.log('[CtrlC-DangerZone] Tab ' + tabId + ': ON — detected "Press Ctrl-C again to exit"');
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('claude:ctrlc-danger-zone', { tabId, active: true });
          }
        } else {
          // EXIT danger zone: prompt returned (⏵ or >) while danger zone is active
          // CRITICAL: must be `else` — same PTY chunk can contain both marker and ⏵.
          // CRITICAL: minimum hold 3s — Claude re-renders ⏵ immediately after Ctrl-C
          // but warning lasts ~3-4 seconds. Only accept ⏵ after min hold.
          const dz = claudeCtrlCDangerZone.get(tabId);
          if (dz && (Date.now() - dz.setAt >= 3000) &&
              (sc.includes('\u23F5') || sc.includes('\u2335') || sc.includes('\u2570'))) {
            // ⏵ (U+23F5) = Claude prompt, ⌵ (U+2335) = alt prompt, ╰ (U+2570) = input box bottom
            clearTimeout(dz.timer);
            claudeCtrlCDangerZone.delete(tabId);
            dz.resolve();
            console.log('[CtrlC-DangerZone] Tab ' + tabId + ': OFF — prompt returned after hold (event-driven)');
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('claude:ctrlc-danger-zone', { tabId, active: false });
            }
          }
        }
      }

      // ========== CLAUDE AGENT PATTERN DETECTOR (:::claude[:cmd] ... :::) ==========
      // Patterns: :::claude <prompt> :::       — send to current session
      //           :::claude:new <prompt> :::   — force new session
      //           :::claude:status :::         — return session meta
      //           :::claude:compact :::        — TODO: compact current session
      // Guards: 1) geminiWatcher (only Gemini tabs — prevents Claude/shell false positives)
      //         2) armed (user typed at least once — prevents restore replay)
      //         3) not running  4) cooldown expired (prevents re-trigger & race condition)
      const cooldownUntil = claudeAgentCooldown.get(tabId) || 0;
      if (geminiWatchers.has(tabId) && claudeAgentArmed.get(tabId) && claudeAgentManager.getStatus(tabId) !== 'running' && Date.now() > cooldownUntil) {
        const sc = stripVTControlCharacters(data);

        // Guard 5: Gemini spinner = TUI re-render. All :::claude in output is OLD history, not fresh.
        // Clear buffer to prevent false positives from re-rendered conversation history.
        const isSpinnerFrame = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(sc) && sc.includes('esc to cancel');
        if (isSpinnerFrame) {
          claudeAgentBuffer.delete(tabId);
        } else {
          const AGENT_BUFFER_LIMIT = 4 * 1024; // 4KB — tight window, old re-rendered content drops out fast
          const prev = claudeAgentBuffer.get(tabId) || '';
          let buf = prev + sc;
          if (buf.length > AGENT_BUFFER_LIMIT) {
            buf = buf.slice(buf.length - AGENT_BUFFER_LIMIT);
          }

          // Match :::claude or :::claude:subcmd, then content, then :::
          const agentMatch = buf.match(/:::claude(?::(\w+))?\s+([\s\S]*?):::/i);
          if (agentMatch) {
            const subcmd = (agentMatch[1] || '').toLowerCase(); // '', 'new', 'status', 'compact'
            const body = agentMatch[2].trim();
            // SYNCHRONOUS LOCK — must happen BEFORE async handler call.
            // Without this, next onData event can slip through before handler sets cooldown.
            claudeAgentBuffer.delete(tabId);
            claudeAgentCooldown.set(tabId, Date.now() + 30000);
            console.log('[ClaudeAgent:Detect] Tab ' + tabId + ': Pattern matched, subcmd=' + (subcmd || 'send') + ', body (' + body.length + ' chars): "' + body.substring(0, 80) + '"');
            handleClaudeAgentCommand(tabId, subcmd, body);
          } else {
            claudeAgentBuffer.set(tabId, buf);
          }
        }
      }
      // ========== END CLAUDE AGENT PATTERN DETECTOR ==========

      // ========== PROMPT BOUNDARY MARKER INJECTION ==========
      // Detect Claude prompt (⏵ U+23F5 / ❯ U+276F) transitions to inject OSC 7777 markers.
      // State machine: IDLE → BUSY (non-prompt data) → IDLE (prompt returns = inject!)
      // Marker is injected into the data stream BEFORE IPC send, so xterm.js parser
      // fires registerOscHandler(7777) at the exact buffer position of the prompt line.
      {
        if (bridgeKnownSessions.has(tabId)) {
          const sc = stripVTControlCharacters(data);
          const hasPrompt = sc.includes('\u23F5') || sc.includes('\u276F');
          const state = promptBoundaryState.get(tabId) || 'idle';

          if (state === 'idle') {
            // Non-prompt data with substance while idle → Claude started processing
            if (!hasPrompt && sc.replace(/\s/g, '').length > 5) {
              promptBoundaryState.set(tabId, 'busy');
            }
          } else if (state === 'busy' && hasPrompt) {
            // Prompt returned while busy → response complete, inject marker
            promptBoundaryState.set(tabId, 'idle');
            const seq = promptBoundarySeq.get(tabId) || 0;
            promptBoundarySeq.set(tabId, seq + 1);
            // Prepend OSC before data chunk so marker lands at start of prompt frame
            data = '\x1b]7777;prompt:' + seq + '\x07' + data;
            console.log('[BoundaryMarker] Tab ' + tabId + ': Injected prompt #' + seq);
          }
        }
      }
      // ========== END PROMPT BOUNDARY MARKER INJECTION ==========

      // Send raw data to renderer - xterm.js handles OSC sequences itself
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('terminal:data', { pid: ptyProcess.pid, tabId, data });
      }
    });

    ptyProcess.onExit((exitCode) => {
      console.error(`[PTY:EXIT] tabId=${tabId} pid=${ptyProcess.pid} exitCode=${JSON.stringify(exitCode)} cwd=${workingDir} shell=${shell} args=${JSON.stringify(shellArgs)}`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('terminal:exit', tabId, exitCode);
      }
      terminals.delete(tabId);
      terminalProjects.delete(tabId);
      terminalCommandState.delete(tabId);
      claudeAgentManager.cleanup(tabId);
      claudeAgentBuffer.delete(tabId);
      claudeAgentArmed.delete(tabId);
      claudeAgentCooldown.delete(tabId);
    });

    console.timeEnd(`[PERF:main] terminal:create ${tabId}`);
    return { pid: ptyProcess.pid, cwd: workingDir };
  });

// Bracketed Paste Mode escape sequences
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

// ============================================================
// Safe Paste + Echo Verification for PTY
// ============================================================
// Problem: macOS TTYHOG = 1024 bytes. Any single term.write() > 1024 bytes
// gets split by the kernel. Ink TUI can't reassemble fragmented bracketed paste.
// Old writeToPtySafe chunked the ENTIRE payload (including escape sequences),
// breaking them across writes.
//
// Solution: Split content into chunks < 900 bytes. Each chunk is a COMPLETE
// bracketed paste (\x1b[200~ + chunk + \x1b[201~), total < 1024 bytes.
// After each chunk, wait for echo in PTY output (event-driven, no fixed timeouts).
// Send \r only after last chunk's echo is confirmed.
// ============================================================

// Wait for Ink render cycle (sync marker \x1b[?2026l = end of synchronized output)
// Used for: Ctrl+C clear, paste chunk confirmation, post-action waits.
// WHY sync marker works for paste: with chunking < 1024 bytes, each paste is delivered
// intact to Ink (no TTYHOG split) → Ink processes it → state update → re-render → sync marker.
// WHY NOT text echo: Ink collapses long pastes into "[Pasted text #N +M lines]",
// so the actual pasted text never appears verbatim in PTY output.
function waitForRender(term, timeoutMs, logPrefix) {
  return new Promise((resolve) => {
    let buf = '';
    let resolved = false;
    let staleCount = 0;
    const subscribeTime = Date.now();

    const cleanup = () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        sub.dispose();
      }
    };

    const timer = setTimeout(() => {
      console.log(logPrefix + ' ⏱️ TIMEOUT (' + timeoutMs + 'ms), buf=' + buf.length + 'B, staleSkipped=' + staleCount);
      cleanup();
      resolve({ timedOut: true });
    }, timeoutMs);

    const sub = term.onData((data) => {
      if (resolved) return;
      buf += data;
      if (buf.includes('\x1b[?2026l')) {
        const elapsed = Date.now() - subscribeTime;
        const isStale = elapsed < 15;
        if (isStale) {
          // Stale marker from previous Ink render (resize, periodic update, etc.)
          // Discard and wait for the REAL marker from our write
          staleCount++;
          console.log(logPrefix + ' ⚠️ STALE sync marker at +' + elapsed + 'ms — discarding, waiting for real marker (stale #' + staleCount + ')');
          buf = ''; // Reset buffer, keep listening
          return;
        }
        console.log(logPrefix + ' ✅ sync marker at +' + elapsed + 'ms' + (staleCount > 0 ? ' (skipped ' + staleCount + ' stale)' : ''));
        cleanup();
        resolve({ timedOut: false, elapsedMs: elapsed, isStale: false });
      }
    });
  });
}

// Helper: drain any pending PTY data (wait for silence)
function drainPtyData(term, ms = 300) {
  return new Promise((resolve) => {
    let buf = '';
    let timer = null;
    const sub = term.onData((data) => {
      buf += data;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { sub.dispose(); resolve(buf); }, ms);
    });
    timer = setTimeout(() => { sub.dispose(); resolve(buf); }, ms);
  });
}

// Helper: wait for specific text/regex in PTY output (deterministic marker)
function waitForPtyText(term, textOrRegex, timeoutMs = 5000, logPrefix = '') {
  return new Promise((resolve) => {
    let buf = '';
    const stripped = require('node:util').stripVTControlCharacters;
    const timer = setTimeout(() => {
      sub.dispose();
      console.log(logPrefix + ' waitForPtyText TIMEOUT (' + timeoutMs + 'ms) waiting for "' + textOrRegex + '" (got ' + buf.length + 'B)');
      resolve(buf);
    }, timeoutMs);
    const sub = term.onData((data) => {
      buf += data;
      const found = typeof textOrRegex === 'string'
        ? stripped(buf).includes(textOrRegex)
        : textOrRegex.test(buf);
      if (found) {
        clearTimeout(timer);
        sub.dispose();
        resolve(buf);
      }
    });
  });
}

// Main helper: chunked paste + sync marker verification + optional submit
async function safePasteAndSubmit(term, content, options = {}) {
  const {
    submit = true,
    ctrlCFirst = false,
    logPrefix = '[safePaste]',
    safetyTimeoutMs = 8000,
    fast = false // Turbo mode for Gemini/Bash (skip render waits)
  } = options;

  // TTYHOG on macOS = 1024 bytes. Paste brackets = 12 bytes. Leave margin.
  const CHUNK_MAX = 900;

  if (!term || typeof term.write !== 'function') {
    console.log(logPrefix + ' ❌ Terminal not available');
    return { success: false, error: 'terminal not available' };
  }

  // Split content into chunks
  const chunks = [];
  for (let i = 0; i < content.length; i += CHUNK_MAX) {
    chunks.push(content.substring(i, i + CHUNK_MAX));
  }

  const t0 = Date.now();
  console.log(logPrefix + ' 🚀 Start: "' + content.substring(0, 40) + '" (' + content.length + ' chars → ' + chunks.length + ' chunk(s), fast=' + fast + ', ctrlCFirst=' + ctrlCFirst + ')');

  // Optional: Ctrl+C to clear input
  if (ctrlCFirst) {
    console.log(logPrefix + ' [+' + (Date.now() - t0) + 'ms] Sending Ctrl+C...');
    term.write('\x03');
    if (!fast) {
      const ctrlCResult = await waitForRender(term, 2000, logPrefix + ':ctrl-c');
      console.log(logPrefix + ' [+' + (Date.now() - t0) + 'ms] Ctrl+C render: timedOut=' + ctrlCResult.timedOut + ' stale=' + (ctrlCResult.isStale || false) + ' elapsed=' + (ctrlCResult.elapsedMs || 'n/a') + 'ms');
      await new Promise(r => setTimeout(r, 50));
    } else {
      // Tiny delay even in fast mode to let kernel process SIGINT
      await new Promise(r => setTimeout(r, 10));
    }
  }

  // Drain deferred renders (from focus loss/regain, periodic updates, etc.)
  // These would produce stale sync markers that pass the 15ms threshold
  if (!fast) {
    await drainPtyData(term, 150);
  }

  const renderTimes = [];

  // Bracketed Paste wrapping strategy:
  // - fast mode (Gemini/bash): single bracket pair across ALL chunks → CLI sees one atomic paste
  //   Chunk 1: \x1b[200~ + text, Chunk 2..N-1: text, Chunk N: text + \x1b[201~
  // - slow mode (Claude Ink TUI): each chunk wrapped individually → Ink renders after each,
  //   sync marker confirms before next chunk
  //   Each chunk: \x1b[200~ + text + \x1b[201~

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    let payload;

    if (fast) {
      // Single bracket pair across all chunks
      payload = chunk;
      if (i === 0) payload = PASTE_START + payload;
      if (i === chunks.length - 1) payload = payload + PASTE_END;
    } else {
      // Per-chunk wrapping for Ink TUI sync marker verification
      payload = PASTE_START + chunk + PASTE_END;
    }

    if (!fast && i > 0) {
      await new Promise(r => setTimeout(r, 50));
    }

    const startTime = Date.now();
    let renderPromise = null;

    if (!fast) {
       renderPromise = waitForRender(term, safetyTimeoutMs, logPrefix + ':chunk' + (i + 1));
    }

    term.write(payload);

    if (!fast && renderPromise) {
      const chunkResult = await renderPromise;
      console.log(logPrefix + ' [+' + (Date.now() - t0) + 'ms] Chunk ' + (i + 1) + '/' + chunks.length + ' render: timedOut=' + chunkResult.timedOut + ' stale=' + (chunkResult.isStale || false) + ' elapsed=' + (chunkResult.elapsedMs || 'n/a') + 'ms');
    } else {
      // In fast mode, tiny tick every 10 chunks to prevent node-pty buffer flooding
      if (i % 10 === 0) await new Promise(r => setTimeout(r, 5));
    }

    renderTimes.push(Date.now() - startTime);
  }

  if (submit) {
    if (fast) {
      // Fast mode: fixed delay (Gemini/bash don't use Ink sync)
      console.log(logPrefix + ' [+' + (Date.now() - t0) + 'ms] Waiting 500ms before Enter (fast mode)...');
      await new Promise(r => setTimeout(r, 500));
    } else {
      // Slow mode: wait for PTY silence (render fully settled)
      // Catches secondary React renders, re-layouts after paste
      console.log(logPrefix + ' [+' + (Date.now() - t0) + 'ms] Draining PTY before Enter (slow mode)...');
      await drainPtyData(term, 150);
    }
    term.write('\r');
    console.log(logPrefix + ' [+' + (Date.now() - t0) + 'ms] ✅ Sent Enter (total: ' + (Date.now() - t0) + 'ms)');
  }

  return { success: true, chunksTotal: chunks.length, renderTimeMs: renderTimes };
}

// Send input to terminal
// Force command-started signal (for Claude commands that bypass OSC 133 detection)
ipcMain.on('terminal:force-command-started', (event, tabId) => {
  console.log('[Force Command Started] Tab:', tabId);
  const state = terminalCommandState.get(tabId) || { isRunning: false, lastCommand: null };
  state.isRunning = true;
  terminalCommandState.set(tabId, state);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('terminal:command-started', { tabId });
  }
});

ipcMain.on('terminal:input', async (event, tabId, data) => {
  const term = terminals.get(tabId);
  if (!term) {
    console.error('[main] Terminal not found for tabId:', tabId);
    return;
  }

  // Arm Claude Agent detector on first user input (prevents restore replay triggers)
  if (!claudeAgentArmed.get(tabId)) {
    claudeAgentArmed.set(tabId, true);
    console.log('[ClaudeAgent:Arm] Tab ' + tabId + ': Armed (first user input)');
  }

  // User paste (Cmd+V) — direct passthrough, no chunking needed.
  if (data.length > 1) {
    const endsWithR = data.endsWith('\r');
    const endsWithN = data.endsWith('\n');
    const hasNewline = data.includes('\r') || data.includes('\n');
    console.log(`[terminal:input] tabId=${tabId} len=${data.length} endsWithR=${endsWithR} endsWithN=${endsWithN} hasNewline=${hasNewline}`);
  }

  // Suppress Claude Agent detection for user input echo (prevents false triggers
  // when user's text contains :::claude::: examples). PTY echoes this text back
  // through onData — cooldown ensures only Gemini's own output triggers detection.
  if (data.length > 10 && data.includes(':::claude')) {
    claudeAgentCooldown.set(tabId, Date.now() + 5000);
    claudeAgentBuffer.delete(tabId);
    console.log('[ClaudeAgent:Input] Tab ' + tabId + ': User input contains :::claude, suppressing detection for 5s');
  }

  term.write(data);
});

// Programmatic paste (used for automated tools like Update Docs)
// Uses safePasteAndSubmit to ensure Bracketed Paste Mode and avoid TTYHOG issues.
ipcMain.handle('terminal:paste', async (event, { tabId, content, submit = true, fast = true }) => {
  const term = terminals.get(tabId);
  if (!term) {
    return { success: false, error: 'terminal not found' };
  }

  console.log('[terminal:paste] Pasting ' + content.length + ' chars to tab ' + tabId + ' (submit=' + submit + ', fast=' + fast + ')');
  
  try {
    const result = await safePasteAndSubmit(term, content, {
      submit,
      ctrlCFirst: false, // Don't clear by default
      logPrefix: '[paste:' + tabId + ']',
      fast // Enable fast mode by default for general paste
    });
    return result;
  } catch (error) {
    console.error('[terminal:paste] Error:', error);
    return { success: false, error: error.message };
  }
});
// Send a slash command to Claude's Ink TUI (chunked paste + echo verification)
ipcMain.on('claude:send-command', (event, tabId, command) => {
  console.log('[send-command] 📩 Received: tabId=' + tabId + ' command="' + command + '" ts=' + Date.now());
  const term = terminals.get(tabId);
  if (!term) { console.log('[send-command] ❌ Terminal not found for tabId=' + tabId); return; }
  (async () => {
    // If in danger zone ("Press Ctrl-C again to exit" is active):
    // Skip ctrlCFirst — input is already cleared by the first Ctrl+C.
    // Sending another \x03 would EXIT Claude.
    const dz = claudeCtrlCDangerZone.get(tabId);
    if (dz) {
      console.log('[send-command] Tab ' + tabId + ': ⚠️ Danger zone — skipping ctrlCFirst, sending command directly');
      // Clear DZ since we're about to send a command (which cancels the warning)
      clearTimeout(dz.timer);
      claudeCtrlCDangerZone.delete(tabId);
      dz.resolve();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('claude:ctrlc-danger-zone', { tabId, active: false });
      }
      await safePasteAndSubmit(term, command, {
        submit: true,
        ctrlCFirst: false,
        logPrefix: '[send-command:' + tabId + ']'
      });
    } else {
      await safePasteAndSubmit(term, command, {
        submit: true,
        ctrlCFirst: true,
        logPrefix: '[send-command:' + tabId + ']'
      });
    }
  })();
});

// Toggle thinking mode reactively: open picker → detect state → navigate → confirm
ipcMain.handle('claude:toggle-thinking', async (event, tabId) => {
  const term = terminals.get(tabId);
  if (!term) return { success: false, error: 'no terminal' };

  // Wait for danger zone to clear (event-driven: resolves when prompt returns)
  const dz = claudeCtrlCDangerZone.get(tabId);
  if (dz) {
    console.log('[Think] ⚠️ Danger zone active — waiting for prompt...');
    await dz.promise;
    console.log('[Think] ✅ Prompt returned, proceeding');
  }

  const stripped = require('node:util').stripVTControlCharacters;

  return new Promise((resolve) => {
    let buffer = '';

    const sub = term.onData((data) => {
      buffer += data;

      // Picker ready when synchronized output ends
      if (!buffer.includes('\x1b[?2026l')) return;
      sub.dispose();

      const clean = stripped(buffer);
      const enabledIdx = clean.indexOf('Enabled');
      const disabledIdx = clean.indexOf('Disabled');
      const checkIdx = clean.indexOf('\u2714'); // ✓

      let wasEnabled = true;
      if (checkIdx >= 0 && enabledIdx >= 0 && disabledIdx >= 0) {
        wasEnabled = Math.abs(checkIdx - enabledIdx) < Math.abs(checkIdx - disabledIdx);
      }

      const newState = !wasEnabled;
      console.log('[Think] clean text:', JSON.stringify(clean).substring(0, 400));
      console.log('[Think] enabledIdx:', enabledIdx, 'disabledIdx:', disabledIdx, 'checkIdx:', checkIdx);
      console.log('[Think] Was:', wasEnabled ? 'Enabled' : 'Disabled', '-> Toggling to:', newState ? 'Enabled' : 'Disabled');

      // Navigate to the other option
      const arrow = wasEnabled ? '\x1b[B' : '\x1b[A';
      console.log('[Think] Sending arrow:', wasEnabled ? 'DOWN' : 'UP');
      term.write(arrow);

      // Confirm with Enter after Ink processes the arrow
      let confirmResolved = false;
      const confirmSub = term.onData((confirmData) => {
        if (confirmResolved) return;
        console.log('[Think] Arrow response RAW (' + confirmData.length + ' bytes):', JSON.stringify(confirmData).substring(0, 300));
        confirmSub.dispose();
        confirmResolved = true;
        console.log('[Think] Sending Enter to confirm selection');
        term.write('\r');

        // Claude may show "Do you want to proceed?" confirmation dialog
        // Listen for it and auto-confirm
        let proceedResolved = false;
        let proceedBuffer = '';
        const proceedSub = term.onData((proceedData) => {
          proceedBuffer += proceedData;
          console.log('[Think] Post-confirm RAW (' + proceedData.length + ' bytes):', JSON.stringify(proceedData).substring(0, 300));

          if (proceedBuffer.includes('proceed') || proceedBuffer.includes('Proceed')) {
            if (proceedResolved) return;
            proceedResolved = true;
            proceedSub.dispose();
            console.log('[Think] Detected "proceed" confirmation, sending Enter');
            term.write('\r');
            resolve({ success: true, thinking: newState });
          }
        });

        // Safety: resolve even if no confirmation dialog appears
        setTimeout(() => {
          proceedSub.dispose();
          if (!proceedResolved) {
            console.log('[Think] No proceed dialog, resolving');
            resolve({ success: true, thinking: newState });
          }
        }, 2000);
      });

      // Safety: if no data after arrow, confirm anyway
      setTimeout(() => {
        if (confirmResolved) return;
        confirmSub.dispose();
        confirmResolved = true;
        console.log('[Think] No arrow response, sending Enter anyway');
        term.write('\r');
        resolve({ success: true, thinking: newState });
      }, 300);
    });

    // Safety timeout
    setTimeout(() => {
      sub.dispose();
      resolve({ success: false, error: 'timeout' });
    }, 5000);

    // Open the picker
    term.write('\x1bt');
  });
});

// Open Rewind menu, navigate to target entry with arrow keys
// Uses specific color detection for reliability
ipcMain.handle('claude:open-history-menu', async (event, { tabId, targetIndex, targetText, skipDuplicates = 0, pasteAfter }) => {
  const term = terminals.get(tabId);
  if (!term) return { success: false, error: 'no terminal' };

  const stripped = require('node:util').stripVTControlCharacters;

  // Helper: clean raw PTY buffer → readable text
  function cleanBuffer(raw) {
    const spaced = raw.replace(/\x1b\[(\d*)C/g, (_, n) => ' '.repeat(parseInt(n) || 1));
    const normalized = spaced
      .replace(/\x1b\[\d*[ABD]/g, '')
      .replace(/\x1b\[\d+;\d+H/g, '\n');
    return stripped(normalized);
  }

  // Helper: parse full Rewind menu (initial render) → { entries[], cursorIndex }
  function parseMenu(cleanText) {
    const allLines = cleanText.split(/[\r\n]+/).map(l => l.trim()).filter(Boolean);
    let cursorIndex = -1;
    const entries = [];
    for (const line of allLines) {
      if (/^[─]+$/.test(line)) continue;
      if (line === 'Rewind') continue;
      if (line.startsWith('Restore and fork')) continue;
      if (line.startsWith('Enter to continue')) continue;
      if (line.startsWith('❯')) {
        const text = line.replace(/^❯\s*/, '').replace(/^\(current\)\s*/, '').trim();
        cursorIndex = entries.length;
        if (text) entries.push(text);
        continue;
      }
      if (line.length > 2) entries.push(line);
    }
    return { entries, cursorIndex };
  }

  // Helper: extract selected text from RAW PTY buffer
  // Strategies:
  // 1. Specific Lavender RGB color used by Claude Code TUI (most reliable)
  // 2. Standard '❯' cursor
  function extractSelectedText(raw) {
    // Strategy 1: Look for the lavender color \x1b[38;2;177;185;249m
    // This persists even when the '❯' cursor is not redrawn in diffs
    const colorStart = '\x1b[38;2;177;185;249m';
    const colorEnd = '\x1b[39m'; // Reset text color
    
    // Search from the end because diffs often append the newest state
    const startIdx = raw.lastIndexOf(colorStart);
    if (startIdx !== -1) {
      let endIdx = raw.indexOf(colorEnd, startIdx);
      if (endIdx === -1) endIdx = raw.length; // If no reset, take till end
      
      const coloredContent = raw.substring(startIdx + colorStart.length, endIdx);
      // Clean up the content (remove nested codes or motion codes)
      return cleanBuffer(coloredContent).trim();
    }
    
    // Strategy 2: Fallback to '❯' if color not found (e.g. initial render)
    const clean = cleanBuffer(raw);
    const match = clean.match(/❯\s*(.*)/);
    if (match) {
        // Remove (current) label if present
        return match[1].replace(/^\(current\)\s*/, '').trim();
    }
    
    return null;
  }

  // Helper: check if cursor text matches target text (prefix comparison)
  function textMatchesTarget(cursorText, targetPrefix) {
    if (!cursorText || !targetPrefix) return false;
    // Normalize spaces for comparison
    // TRIM both to ensure leading spaces (indents) don't break match
    const ct = cursorText.trim().replace(/\s+/g, ' ').substring(0, 50);
    const tp = targetPrefix.trim().replace(/\s+/g, ' ').substring(0, 50);
    
    // Log for debugging failures
    const match = ct.includes(tp) || tp.includes(ct);
    if (!match) {
        // Only log mismatches in verbose mode or if requested, to avoid spam
        // console.log(`[Restore:Debug] Mismatch: TUI="${ct}" vs Target="${tp}"`);
    } else {
        console.log(`[Restore:Debug] MATCH: TUI="${ct}" vs Target="${tp}"`);
    }
    
    return match;
  }

  // Helper: send key → wait for \x1b[?2026l → return RAW buffer
  function sendAndCaptureRaw(key, timeout = 3000) {
    return new Promise((resolve, reject) => {
      let buf = '';
      const sub = term.onData((data) => {
        buf += data;
        if (buf.includes('\x1b[?2026l')) {
          sub.dispose();
          resolve(buf);
        }
      });
      term.write(key);
      setTimeout(() => { sub.dispose(); reject(new Error('sync timeout')); }, timeout);
    });
  }

  try {
    // Step 0: Check DangerZone — if active, wait for it to clear (same pattern as toggle-thinking)
    // Ctrl+C at idle prompt triggers DZ ("Press Ctrl-C again to exit"),
    // and Escape cannot open the Rewind menu while DZ is active.
    const dz = claudeCtrlCDangerZone.get(tabId);
    if (dz) {
      console.log('[Restore:History] ⚠️ DangerZone active — waiting for prompt return...');
      await dz.promise;
      console.log('[Restore:History] ✅ DangerZone cleared, proceeding');
    }

    // Step 1: Ctrl+C to cancel current input (only if Claude might be busy)
    // Use sendAndCaptureRaw to properly wait for Ink re-render before next step
    console.log('[Restore:History] Step 1: Ctrl+C');
    try {
      await sendAndCaptureRaw('\x03', 3000);
    } catch (e) {
      // Ctrl+C might not produce sync marker if Claude is already idle — that's OK
      console.log('[Restore:History] Ctrl+C sync: ' + e.message + ' (OK, continuing)');
    }

    // Step 1.5: If Ctrl+C triggered DangerZone, wait for it to clear
    const dzAfter = claudeCtrlCDangerZone.get(tabId);
    if (dzAfter) {
      console.log('[Restore:History] ⚠️ Ctrl+C triggered DangerZone — waiting for clear...');
      await dzAfter.promise;
      console.log('[Restore:History] ✅ DangerZone cleared after Ctrl+C');
      // Drain any residual PTY data after DZ clear
      await drainPtyData(term, 300);
    }

    // Step 2: First Escape (prep)
    // Escape (\x1b) doesn't produce \x1b[?2026l sync markers — Ink needs ~200ms
    // to distinguish standalone Escape from ANSI sequence start (\x1b[A etc.)
    // So we use fixed delays instead of sendAndCaptureRaw.
    console.log('[Restore:History] Step 2: First Escape');
    term.write('\x1b');
    await new Promise(r => setTimeout(r, 500));

    // Step 3: Second Escape → Rewind menu should open
    // Use drainPtyData to capture whatever Ink renders after the menu opens
    console.log('[Restore:History] Step 3: Second Escape (menu)');
    term.write('\x1b');
    // Wait for Ink to process Escape (~200ms) + render the menu
    const menuRaw = await drainPtyData(term, 800);

    const menuClean = cleanBuffer(menuRaw);
    const initialState = parseMenu(menuClean);
    const knownEntries = initialState.entries;
    let cursorPos = initialState.cursorIndex;

    console.log('[Restore:History] Menu opened: ' + knownEntries.length + ' entries, cursor=' + cursorPos);
    if (knownEntries.length > 0) {
      console.log('[Restore:History] Menu entries: ' + knownEntries.map(e => e.substring(0, 40)).join(' | '));
    } else {
      console.log('[Restore:History] Menu raw (first 500): ' + menuRaw.substring(0, 500).replace(/[\x00-\x1f]/g, '.'));
    }

    // Step 4: Navigate to target entry
    const targetPrefix = (targetText || '').substring(0, 40);
    
    // Check if target is currently visible in the initial menu render
    let targetIdx = -1;
    if (targetPrefix) {
       targetIdx = knownEntries.findIndex(e => textMatchesTarget(e, targetPrefix));
    }
    
    let maxPresses = 0;
    
    if (targetIdx !== -1) {
        // CASE 1: Target is visible immediately. We can calculate exact steps.
        const stepsNeeded = cursorPos - targetIdx;
        maxPresses = stepsNeeded + 2; // +2 safety
        console.log('[Restore:History] Target visible at relative index ' + targetIdx + '. Steps needed: ' + stepsNeeded);
    } else {
        // CASE 2: Target is NOT visible (scrolled out of view).
        // We cannot rely on absolute 'targetIndex' because TUI might use different indexing.
        // STRATEGY: Visual Search. Set a high limit and loop until we see the RGB match.
        maxPresses = 50; 
        console.log('[Restore:History] Target NOT visible initially. Starting visual search (max 50 steps) for: "' + targetPrefix + '..."');
    }

    let found = false;
    let pressCount = 0;
    let duplicatesRemaining = skipDuplicates; // Skip N newer duplicates before accepting match

    console.log('[Restore:History] Navigation: maxPresses=' + maxPresses + ', skipDuplicates=' + skipDuplicates);

    // Unified navigation loop: per-step Lavender RGB verification (see fix-rewind-navigation.md).
    // Ink diff renders corrupt individual characters (cursor-movement artifacts in cleanBuffer),
    // so we use exact match first, then fuzzy word-overlap as fallback.
    for (let i = 0; i < maxPresses; i++) {
      try {
        const diffRaw = await sendAndCaptureRaw('\x1b[A', 1500);
        pressCount++;
        const selectedText = extractSelectedText(diffRaw);
        console.log(`[Restore:History] UP #${pressCount} -> Selected: "${(selectedText || 'null').substring(0, 50)}..."`);

        let matched = false;

        // Exact match (works when diff render is clean)
        if (selectedText && textMatchesTarget(selectedText, targetPrefix)) {
          matched = true;
        }

        // Fuzzy fallback: Ink diff renders corrupt individual characters via cursor
        // repositioning (\x1b[nC, \x1b[r;cH) that cleanBuffer can't simulate.
        // Whole words survive though. Check ≥60% word overlap.
        if (!matched && selectedText && targetPrefix) {
          const targetWords = targetPrefix.trim().split(/\s+/).filter(w => w.length > 2);
          const selectedNorm = selectedText.trim().replace(/\s+/g, ' ');
          if (targetWords.length > 0) {
            const matchedWords = targetWords.filter(w => selectedNorm.includes(w));
            const ratio = matchedWords.length / targetWords.length;
            if (ratio >= 0.6) {
              console.log('[Restore:History] Fuzzy match (' + Math.round(ratio * 100) + '%, ' + matchedWords.length + '/' + targetWords.length + ' words)');
              matched = true;
            }
          }
        }

        if (matched) {
          if (duplicatesRemaining > 0) {
            duplicatesRemaining--;
            console.log('[Restore:History] ⏩ Skipping duplicate (' + duplicatesRemaining + ' remaining)');
            continue;
          }
          console.log('[Restore:History] ✅ Target matched!');
          found = true;
          break;
        }
      } catch (e) {
        console.log('[Restore:History] Error during navigation:', e.message);
        break;
      }
    }

    if (!found) {
        console.error('[Restore:History] ❌ Target NOT found in menu after ' + pressCount + ' steps. Aborting rewind.');
        // GUARD: Close menu with Escape to avoid selecting wrong entry (which defaults to top/bottom)
        try {
            term.write('\x1b');
            await new Promise(r => setTimeout(r, 200));
        } catch (ign) {}

        return { success: false, error: 'Target not found in Claude history menu', cursorIndex: cursorPos, targetIndex: targetIdx, pressCount, menuEntries: knownEntries.length };
    }

    // Step 5: Confirm selection with Enter
    const rewindStartTime = Date.now();
    console.log('[Restore:History] Confirming selection with Enter...');
    
    // We expect a re-render. 
    // Sometimes Enter doesn't produce an immediate sync marker if Claude is busy processing.
    // We use a longer timeout.
    const confirmRaw = await sendAndCaptureRaw('\r', 5000);
    console.log('[Restore:History] Confirm response in ' + (Date.now() - rewindStartTime) + 'ms');

    // Step 6: Paste compact text if provided
    if (pasteAfter && typeof pasteAfter === 'string' && pasteAfter.length > 0) {
      const promptWaitStart = Date.now();
      console.log('[Restore:History] Waiting for prompt to fully render...');

      let promptReady = false;
      let renderCount = 0;

      await new Promise((resolve) => {
        let buf = '';
        let resolved = false;

        const safetyTimer = setTimeout(() => {
          if (resolved) return;
          resolved = true;
          sub.dispose();
          console.log('[Restore:History] Prompt render timeout');
          resolve();
        }, 15000);

        const sub = term.onData((data) => {
          if (resolved) return;
          buf += data;

          while (buf.includes('\x1b[?2026l')) {
            renderCount++;
            // Prompt is ready when we see prompt symbols
            if (buf.includes('\u2335') || buf.includes('\u23F5') || buf.includes('╰') || renderCount >= 5) {
              promptReady = true;
              resolved = true;
              clearTimeout(safetyTimer);
              sub.dispose();
              resolve();
              return;
            }
            buf = buf.split('\x1b[?2026l').slice(1).join('\x1b[?2026l');
          }
        });
      });

      console.log('[Restore:History] Pasting compact text (' + pasteAfter.length + ' chars)...');
      await safePasteAndSubmit(term, pasteAfter, {
        submit: true,
        ctrlCFirst: true,
        logPrefix: '[Restore:History:paste]'
      });
    }

    return { success: true, found, cursorIndex: cursorPos, targetIndex: targetIdx, pressCount };

  } catch (err) {
    console.log('[Restore:History] Error:', err.message);
    term.write('\x1b'); // try to close menu on error
    return { success: false, error: err.message };
  }
});

// Resize terminal
ipcMain.on('terminal:resize', (event, tabId, cols, rows) => {
  const term = terminals.get(tabId);
  if (term) {
    console.log('[terminal:resize] tabId=' + tabId + ' cols=' + cols + ' rows=' + rows + ' ts=' + Date.now());
    term.resize(cols, rows);
  }
});

// Kill terminal
ipcMain.on('terminal:kill', (event, tabId) => {
  const term = terminals.get(tabId);
  if (term) {
    term.kill();
    terminals.delete(tabId);
  }
  claudeAgentManager.cleanup(tabId);
  claudeAgentBuffer.delete(tabId);
  claudeAgentArmed.delete(tabId);
});

// ========== CLAUDE AGENT ORCHESTRATION ==========
// Handles @claude:...@end pattern from Gemini PTY output.
// Sends prompt to Claude via Agent SDK, pastes response back into Gemini.

function formatAgentResponse(result, meta) {
  const sid = meta.sessionId ? meta.sessionId.substring(0, 8) : 'unknown';
  const tokensIn = meta.totalInputTokens || 0;
  const tokensOut = meta.totalOutputTokens || 0;
  const cost = (meta.totalCostUsd || 0).toFixed(4);
  const turn = meta.turn || 0;
  const dur = meta.turnDurationMs ? Math.round(meta.turnDurationMs / 1000) + 's' : '?';
  return '[Claude Agent Response | session: ' + sid + ' | turn: ' + turn + ' | tokens: ' + tokensIn + '/' + tokensOut + ' | cost: \x24' + cost + ' | time: ' + dur + ']\n' + result + '\n[/Claude Agent Response]';
}

function formatStatusResponse(meta) {
  if (!meta) return '[Claude Agent Status] No active session [/Claude Agent Status]';
  const sid = meta.sessionId ? meta.sessionId.substring(0, 8) : 'none';
  return '[Claude Agent Status | session: ' + sid + ' | turns: ' + meta.turns + ' | tokens: ' + meta.totalInputTokens + '/' + meta.totalOutputTokens + ' | cost: \x24' + (meta.totalCostUsd || 0).toFixed(4) + ' | status: ' + meta.status + '] [/Claude Agent Status]';
}

async function handleClaudeAgentCommand(tabId, subcmd, body) {
  // NOTE: Buffer clear + cooldown already set SYNCHRONOUSLY in detector (onData)
  // before this async function is called. No race window possible.
  const cwd = terminalProjects.get(tabId) || process.cwd();
  const term = terminals.get(tabId);

  // ── :status — return meta without calling Claude ──
  if (subcmd === 'status') {
    const meta = claudeAgentManager.getSessionMeta(tabId);
    console.log('[ClaudeAgent:Status] Tab ' + tabId + ':', JSON.stringify(meta));
    if (term) {
      await safePasteAndSubmit(term, formatStatusResponse(meta), {
        submit: true, fast: true,
        logPrefix: '[ClaudeAgent:StatusPaste:' + tabId + ']',
      });
    }
    return;
  }

  // ── :new — force new session, then send ──
  // ── (default) — send to current/resumed session ──
  const isNew = subcmd === 'new';
  const prompt = body;

  if (!prompt) {
    console.log('[ClaudeAgent:Handle] Tab ' + tabId + ': Empty prompt, skipping');
    return;
  }

  console.log('[ClaudeAgent:Handle] Tab ' + tabId + ': ' + (isNew ? 'NEW session' : 'Send') + ' (cwd=' + cwd + ')');

  // Notify renderer: running
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('claude-agent:status', {
      tabId, status: 'running',
      sessionId: claudeAgentManager.getSessionId(tabId),
    });
  }

  try {
    const sendFn = isNew
      ? claudeAgentManager.sendNew.bind(claudeAgentManager)
      : claudeAgentManager.send.bind(claudeAgentManager);

    const result = await sendFn(tabId, prompt, { cwd });

    console.log('[ClaudeAgent:Handle] Tab ' + tabId + ': Done. Session=' + result.sessionId + ' Turn=' + result.meta.turn + ' Cost=\x24' + result.meta.totalCostUsd.toFixed(4) + ' Tokens=' + result.meta.totalInputTokens + '/' + result.meta.totalOutputTokens);

    // Notify renderer: done
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('claude-agent:status', {
        tabId, status: 'done',
        sessionId: result.sessionId,
      });
    }

    // Clear buffer + set cooldown BEFORE paste (paste triggers PTY onData → detector)
    claudeAgentBuffer.delete(tabId);
    claudeAgentCooldown.set(tabId, Date.now() + 10000); // 10s cooldown

    // Paste response back
    if (term) {
      const response = formatAgentResponse(result.result, result.meta);
      await safePasteAndSubmit(term, response, {
        submit: true, fast: true,
        logPrefix: '[ClaudeAgent:Paste:' + tabId + ']',
      });
    }
  } catch (err) {
    console.error('[ClaudeAgent:Handle] Tab ' + tabId + ': Error:', err.message);

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('claude-agent:status', {
        tabId, status: 'error', error: err.message,
        sessionId: claudeAgentManager.getSessionId(tabId),
      });
    }

    claudeAgentBuffer.delete(tabId);
    claudeAgentCooldown.set(tabId, Date.now() + 10000);

    if (term && err.message !== 'Cancelled') {
      const errResponse = '[Claude Agent Error]\n' + err.message + '\n[/Claude Agent Error]';
      await safePasteAndSubmit(term, errResponse, {
        submit: true, fast: true,
        logPrefix: '[ClaudeAgent:ErrPaste:' + tabId + ']',
      });
    }
  }
}

// IPC: Send prompt to Claude Agent manually (from UI)
ipcMain.handle('claude-agent:send', async (event, { tabId, prompt, cwd }) => {
  try {
    const workDir = cwd || terminalProjects.get(tabId) || process.cwd();
    const result = await claudeAgentManager.send(tabId, prompt, { cwd: workDir });
    return { success: true, ...result };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// IPC: Cancel running Claude Agent request
ipcMain.handle('claude-agent:cancel', async (event, { tabId }) => {
  claudeAgentManager.cancel(tabId);
  return { success: true };
});

// IPC: Get Claude Agent status for a tab
ipcMain.handle('claude-agent:status', async (event, { tabId }) => {
  return {
    status: claudeAgentManager.getStatus(tabId),
    sessionId: claudeAgentManager.getSessionId(tabId),
  };
});

// IPC: Get Claude Agent session ID
ipcMain.handle('claude-agent:get-session', async (event, { tabId }) => {
  return { sessionId: claudeAgentManager.getSessionId(tabId) };
});

// ========== END CLAUDE AGENT ORCHESTRATION ==========

// Helper: async exec with timeout
const execAsync = (cmd, timeout = 1000) => {
  return new Promise((resolve, reject) => {
    const { exec } = require('child_process');
    const child = exec(cmd, { encoding: 'utf-8', timeout }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
};

// Get current working directory of terminal process
ipcMain.handle('terminal:getCwd', async (event, tabId) => {
  const term = terminals.get(tabId);
  if (!term) return null;

  try {
    // Get child process of shell (the actual foreground process)
    // First try to get the shell's cwd directly
    const pid = term.pid;

    if (process.platform === 'darwin') {
      // macOS: use lsof to get cwd (async to not block main process)
      const result = await execAsync(`lsof -p ${pid} | grep cwd | awk '{print $9}'`);

      if (result) {
        return result;
      }
    } else if (process.platform === 'linux') {
      // Linux: read /proc/<pid>/cwd symlink (fs.promises for async)
      const fs = require('fs').promises;
      const cwd = await fs.readlink(`/proc/${pid}/cwd`);
      return cwd;
    }
  } catch (e) {
    console.error('[main] Failed to get cwd:', e.message);
  }

  // Fallback to stored cwd
  return terminalProjects.get(tabId) || null;
});

// Get command state (is command running?) - uses OSC 133 tracking
ipcMain.handle('terminal:getCommandState', async (event, tabId) => {
  const state = terminalCommandState.get(tabId);
  return state || { isRunning: false, lastExitCode: 0 };
});

// Notes management
ipcMain.handle('notes:load', () => {
  return loadNotes();
});

ipcMain.on('notes:save', (event, notes) => {
  saveNotes(notes);
});

// Project management
ipcMain.handle('project:get', (event, identifier) => {
  // identifier can be a path (string) or a tabId (for legacy support if needed)
  let cwd = identifier;

  // If identifier seems to be a tabId (e.g. "tab-1"), try to look it up
  if (typeof identifier === 'string' && identifier.startsWith('tab-') && terminalProjects.has(identifier)) {
    cwd = terminalProjects.get(identifier);
  }

  return projectManager.getProject(cwd);
});

// Get current working directory
ipcMain.handle('app:select-directory', async () => {
  const { dialog } = require('electron');
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory']
  });
  if (result.canceled) return null;
  return result.filePaths[0];
});

ipcMain.handle('app:check-path-exists', (event, targetPath) => {
  const fs = require('fs');
  try {
    return fs.existsSync(targetPath) && fs.lstatSync(targetPath).isDirectory();
  } catch (err) {
    return false;
  }
});

ipcMain.handle('app:getCwd', () => {
  return process.cwd();
});

// List all projects
ipcMain.handle('project:list', () => {
  return Object.values(projectManager.projects);
});

// Get project by ID (not path)
ipcMain.handle('project:getById', (event, projectId) => {
  console.log('[Main] project:getById called with:', projectId);
  const result = projectManager.db.getProjectById(projectId);
  console.log('[Main] project:getById result:', result);
  return result;
});

// Create new project instance (allows multiple projects with same path)
ipcMain.handle('project:create-instance', (event, { path: projectPath, name }) => {
  console.log('[Main] project:create-instance called with:', { projectPath, name });
  try {
    const result = projectManager.db.createProjectInstance(projectPath, name);
    console.log('[Main] project:create-instance result:', result);
    return result;
  } catch (err) {
    console.error('[Main] project:create-instance error:', err);
    throw err;
  }
});

// Create new empty project (path can be set later)
ipcMain.handle('project:create-empty', (event, { name }) => {
  console.log('[Main] project:create-empty called with:', { name });
  try {
    const result = projectManager.db.createEmptyProject(name);
    console.log('[Main] project:create-empty result:', result);
    return result;
  } catch (err) {
    console.error('[Main] project:create-empty error:', err);
    throw err;
  }
});

// App state (session, settings)
ipcMain.handle('app:getState', (event, key) => {
  return projectManager.db.getAppState(key);
});

ipcMain.handle('app:setState', (event, { key, value }) => {
  projectManager.db.setAppState(key, value);
  return { success: true };
});

// Synchronous version for beforeunload
ipcMain.on('app:setStateSync', (event, { key, value }) => {
  projectManager.db.setAppState(key, value);
  event.returnValue = { success: true };
});

ipcMain.handle('project:save-note', (event, { projectId, content }) => {
  projectManager.saveProjectNote(projectId, content);
  return { success: true };
});

ipcMain.handle('project:save-actions', (event, { projectId, actions }) => {
  projectManager.saveProjectActions(projectId, actions);
  return { success: true };
});

ipcMain.handle('project:save-tabs', (event, { projectId, tabs }) => {
  projectManager.saveProjectTabs(projectId, tabs);
  return { success: true };
});

ipcMain.handle('project:save-metadata', (event, { projectId, metadata }) => {
  projectManager.saveProjectMetadata(projectId, metadata);
  return { success: true };
});

ipcMain.handle('project:save-sidebar-state', (event, { projectId, sidebarOpen, openFilePath }) => {
  projectManager.db.updateProjectSidebarState(projectId, sidebarOpen, openFilePath);
  return { success: true };
});

ipcMain.handle('project:delete', (event, projectId) => {
  const result = projectManager.deleteProject(projectId);
  return { success: result };
});

// ========== TAB HISTORY ==========

ipcMain.handle('project:archive-tab', (event, { projectId, tab }) => {
  // Count user messages from JSONL at archive time (write-once)
  if (tab.claudeSessionId && tab.cwd) {
    try {
      const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');
      const projectSlug = tab.cwd.replace(/\//g, '-');
      const sessionPath = path.join(claudeProjectsDir, projectSlug, `${tab.claudeSessionId}.jsonl`);
      if (fs.existsSync(sessionPath)) {
        const uuids = parseTimelineUuids(sessionPath);
        // parseTimelineUuids returns user entries + compact boundaries, count only user entries
        // by re-parsing and checking types (compact boundaries are few, this is fast)
        const content = fs.readFileSync(sessionPath, 'utf-8');
        const recordMap = new Map();
        for (const line of content.trim().split('\n')) {
          try { const r = JSON.parse(line); recordMap.set(r.uuid, r); } catch {}
        }
        let count = 0;
        for (const uuid of uuids) {
          const r = recordMap.get(uuid);
          if (r && r.type === 'user') count++;
        }
        tab.messageCount = count;
        console.log('[Archive] Message count for', tab.claudeSessionId?.slice(0, 8), ':', count);
      }
    } catch (e) {
      console.warn('[Archive] Could not count messages:', e.message);
    }
  }
  projectManager.db.archiveTab(projectId, tab);
  return { success: true };
});

ipcMain.handle('project:get-tab-history', (event, { projectId }) => {
  return projectManager.db.getTabHistory(projectId);
});

ipcMain.handle('project:get-tab-history-count', (event, { projectId }) => {
  return projectManager.db.getTabHistoryCount(projectId);
});

ipcMain.handle('project:clear-tab-history', (event, { projectId }) => {
  projectManager.db.clearTabHistory(projectId);
  return { success: true };
});

ipcMain.handle('project:clear-tab-history-except-notes', (event, { projectId }) => {
  projectManager.db.clearTabHistoryExceptNotes(projectId);
  return { success: true };
});

ipcMain.handle('project:delete-tab-history-entry', (event, { id }) => {
  projectManager.db.deleteTabHistoryEntry(id);
  return { success: true };
});

// ========== FAVORITES ==========

ipcMain.handle('project:add-favorite', (event, { projectId, tab }) => {
  projectManager.db.addFavorite(projectId, tab);
  return { success: true };
});

ipcMain.handle('project:get-favorites', (event, { projectId }) => {
  return projectManager.db.getFavorites(projectId);
});

ipcMain.handle('project:delete-favorite', (event, { id }) => {
  projectManager.db.deleteFavorite(id);
  return { success: true };
});

ipcMain.handle('project:select-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const selectedPath = result.filePaths[0];
  // getProject will create the project in JSON if it doesn't exist
  return projectManager.getProject(selectedPath);
});

// ========== BOOKMARKS IPC ==========

ipcMain.handle('bookmark:list', () => {
  return projectManager.db.getAllBookmarks();
});

ipcMain.handle('bookmark:create', (event, { path: dirPath, name, description }) => {
  return projectManager.db.createBookmark(dirPath, name, description || '');
});

ipcMain.handle('bookmark:update', (event, { id, updates }) => {
  return projectManager.db.updateBookmark(id, updates);
});

ipcMain.handle('bookmark:delete', (event, id) => {
  projectManager.db.deleteBookmark(id);
  return { success: true };
});

ipcMain.handle('bookmark:select-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const selectedPath = result.filePaths[0];
  const name = require('path').basename(selectedPath);
  return projectManager.db.createBookmark(selectedPath, name, '');
});

// ========== SYSTEM: CLAUDE PROCESSES ==========
ipcMain.handle('system:get-claude-processes', async () => {
  try {
    // Find all claude CLI processes with PPID for ownership detection
    // Added %cpu,%mem to ps format
    const psOutput = await execAsync(
      'ps -eo pid,ppid,pcpu,pmem,lstart,command | grep -i "claude" | grep -v grep | grep -v electron',
      3000
    );

    if (!psOutput) return [];

    // Build a set of our shell PIDs for ownership matching
    const ourShellPids = new Set();
    const pidToTabId = new Map();
    for (const [tabId, ptyProcess] of terminals) {
      ourShellPids.add(ptyProcess.pid);
      pidToTabId.set(ptyProcess.pid, tabId);
    }

    const lines = psOutput.split('\n').filter(Boolean);
    const processes = [];

    for (const line of lines) {
      try {
        // Parse ps output: PID PPID %CPU %MEM lstart(Day Mon DD HH:MM:SS YYYY) command
        const match = line.trim().match(/^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+\w+\s+\w+\s+\d+\s+(\d+:\d+:\d+)\s+\d+\s+(.+)/);
        if (!match) continue;

        const pid = match[1];
        const ppid = Number(match[2]);
        const cpu = match[3];
        const mem = match[4];
        const startTime = match[5]; // HH:MM:SS
        const command = match[6].trim();

        // Skip non-CLI claude processes
        if (!command.includes('claude') || command.includes('Electron')) continue;

        // Get CWD via lsof
        let cwd = '';
        try {
          cwd = await execAsync('lsof -p ' + pid + ' | grep cwd | awk \'{print ' + '\$' + '9}\'', 2000);
        } catch {
          // Process may have exited
          continue;
        }

        if (!cwd) continue;

        // Check if this process belongs to one of our terminal tabs
        const tabId = pidToTabId.get(ppid) || null;

        processes.push({
          pid: Number(pid),
          cwd,
          startTime: startTime.substring(0, 5), // HH:MM
          command,
          tabId,
          cpu,
          mem,
        });
      } catch {
        // Skip unparseable lines
      }
    }

    return processes;
  } catch {
    return [];
  }
});

ipcMain.handle('system:get-gemini-processes', async () => {
  try {
    // Find gemini processes with no controlling terminal (?? = detached)
    const psOutput = await execAsync(
      'ps aux | grep gemini | grep "\\?\\?" | grep -v grep',
      3000
    );

    if (!psOutput) return [];

    // Build ownership map from our terminal shells
    const ourShellPids = new Set();
    const pidToTabId = new Map();
    for (const [tabId, ptyProcess] of terminals) {
      ourShellPids.add(ptyProcess.pid);
      pidToTabId.set(ptyProcess.pid, tabId);
    }

    const lines = psOutput.split('\n').filter(Boolean);
    const processes = [];

    for (const line of lines) {
      try {
        // ps aux columns: USER PID %CPU %MEM VSZ RSS TT STAT STARTED TIME COMMAND
        const parts = line.trim().split(/\s+/);
        if (parts.length < 11) continue;

        const pid = parts[1];
        const cpu = parts[2]; // %CPU
        const mem = parts[3]; // %MEM
        const startTime = parts[8]; // STARTED column
        const command = parts.slice(10).join(' ');

        // Skip non-CLI gemini processes
        if (!command.includes('gemini')) continue;

        // Get PPID for ownership detection
        let ppid = 0;
        try {
          const ppidStr = await execAsync('ps -o ppid= -p ' + pid, 2000);
          ppid = Number(ppidStr.trim());
        } catch {
          // Process may have exited
        }

        // Get CWD via lsof
        let cwd = '';
        try {
          cwd = await execAsync('lsof -p ' + pid + ' | grep cwd | awk \'{print ' + '\$' + '9}\'', 2000);
        } catch {
          continue;
        }

        if (!cwd) continue;

        const tabId = pidToTabId.get(ppid) || null;

        processes.push({
          pid: Number(pid),
          cwd,
          startTime: startTime || '',
          command,
          tabId,
          cpu,
          mem,
        });
      } catch {
        // Skip unparseable lines
      }
    }

    return processes;
  } catch {
    return [];
  }
});

ipcMain.handle('system:kill-process', async (event, pid) => {
  try {
    await execAsync('kill ' + pid, 2000);
    return { success: true };
  } catch {
    // Try SIGKILL if graceful kill failed
    try {
      await execAsync('kill -9 ' + pid, 2000);
      return { success: true };
    } catch {
      return { success: false };
    }
  }
});

// Execute quick action command in terminal (fire-and-forget version)
// For backwards compatibility - use terminal:executeCommandAsync for sequential commands
ipcMain.on('terminal:executeCommand', (event, tabId, command) => {
  console.log('[main] ========== EXECUTE COMMAND ==========');
  console.log('[main] tabId:', tabId);
  console.log('[main] command:', command);

  const term = terminals.get(tabId);
  if (term) {
    console.log('[main] ✅ Terminal found, PID:', term.pid);
    term.write(command);
    setTimeout(() => {
      term.write('\r');
      console.log('[main] ✅ Enter (\r) sent!');
    }, 150);
  } else {
    console.error('[main] ❌ Terminal NOT FOUND for tabId:', tabId);
  }
});

// Execute command and wait for Enter to be sent (async version)
// Use this when you need to wait before sending next command
ipcMain.handle('terminal:executeCommandAsync', async (event, tabId, command) => {
  const startTime = Date.now();
  console.log('[main] ========== EXECUTE COMMAND ASYNC ==========');
  console.log('[main] tabId:', tabId);
  console.log('[main] command:', command);
  console.log('[main] timestamp:', startTime);

  const term = terminals.get(tabId);
  if (!term) {
    console.error('[main] ❌ Terminal NOT FOUND for tabId:', tabId);
    return { success: false };
  }

  console.log('[main] ✅ Terminal found, PID:', term.pid);

  // Write command text
  console.log('[main] 📝 Writing command text...');
  term.write(command);
  console.log('[main] 📝 Command text written at', Date.now() - startTime, 'ms');

  // Wait 150ms then send Enter
  await new Promise(resolve => setTimeout(resolve, 150));
  console.log('[main] ⏰ 150ms passed, sending Enter...');
  term.write('\r');
  console.log('[main] ✅ Enter (\r) sent at', Date.now() - startTime, 'ms');

  // Wait a bit more for command to start processing
  await new Promise(resolve => setTimeout(resolve, 100));
  console.log('[main] ⏰ 100ms after Enter, returning at', Date.now() - startTime, 'ms');

  return { success: true };
});

// Read file for preview
ipcMain.handle('file:read', async (event, filePath) => {
  try {
    const fs = require('fs');
    const content = fs.readFileSync(filePath, 'utf-8');
    return { success: true, content };
  } catch (error) {
    console.error('[main] Error reading file:', error);
    return { success: false, error: error.message };
  }
});

// Gemini history management
ipcMain.handle('gemini:save-history', async (event, { dirPath, selectedText, prompt, response }) => {
  try {
    const result = projectManager.saveGeminiHistory(dirPath, selectedText, prompt, response);
    return { success: true, data: result };
  } catch (error) {
    console.error('[main] Error saving Gemini history:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('gemini:get-history', async (event, { dirPath, limit }) => {
  try {
    const history = projectManager.getGeminiHistory(dirPath, limit);
    return { success: true, data: history };
  } catch (error) {
    console.error('[main] Error getting Gemini history:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('gemini:delete-history', async (event, historyId) => {
  try {
    projectManager.deleteGeminiHistoryItem(historyId);
    return { success: true };
  } catch (error) {
    console.error('[main] Error deleting Gemini history:', error);
    return { success: false, error: error.message };
  }
});

// Research Conversations (Full Chat History)
ipcMain.handle('research:save-conversation', async (event, { dirPath, conversation }) => {
  try {
    projectManager.db.saveResearchConversation(dirPath, conversation);
    return { success: true };
  } catch (error) {
    console.error('[main] Error saving research conversation:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('research:get-conversations', async (event, dirPath) => {
  try {
    const conversations = projectManager.db.getResearchConversations(dirPath);
    return { success: true, data: conversations };
  } catch (error) {
    console.error('[main] Error getting research conversations:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('research:delete-conversation', async (event, { dirPath, conversationId }) => {
  try {
    projectManager.db.deleteResearchConversation(dirPath, conversationId);
    return { success: true };
  } catch (error) {
    console.error('[main] Error deleting research conversation:', error);
    return { success: false, error: error.message };
  }
});

// Global commands management
ipcMain.handle('commands:get-global', async () => {
  try {
    const commands = projectManager.getGlobalCommands();
    return { success: true, data: commands };
  } catch (error) {
    console.error('[main] Error getting global commands:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('commands:save-global', async (event, commands) => {
  try {
    projectManager.saveGlobalCommands(commands);
    return { success: true };
  } catch (error) {
    console.error('[main] Error saving global commands:', error);
    return { success: false, error: error.message };
  }
});

// Prompts management
ipcMain.handle('prompts:get', async () => {
  try {
    const prompts = projectManager.getPrompts();
    return { success: true, data: prompts };
  } catch (error) {
    console.error('[main] Error getting prompts:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('prompts:save', async (event, prompts) => {
  try {
    projectManager.savePrompts(prompts);
    return { success: true };
  } catch (error) {
    console.error('[main] Error saving prompts:', error);
    return { success: false, error: error.message };
  }
});

// ========== AI PROMPTS (Dynamic System Prompts) ==========

ipcMain.handle('ai-prompts:get', async () => {
  try {
    const prompts = projectManager.getAIPrompts();
    return { success: true, data: prompts };
  } catch (error) {
    console.error('[main] Error getting AI prompts:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('ai-prompts:save', async (event, prompt) => {
  try {
    projectManager.saveAIPrompt(prompt);
    return { success: true };
  } catch (error) {
    console.error('[main] Error saving AI prompt:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('ai-prompts:delete', async (event, id) => {
  try {
    projectManager.deleteAIPrompt(id);
    return { success: true };
  } catch (error) {
    console.error('[main] Error deleting AI prompt:', error);
    return { success: false, error: error.message };
  }
});

// ========== DOCS UPDATE FEATURE ==========

// Export Claude session for documentation update (with file watcher approach)
// Read documentation prompt from file
// Save combined prompt to /tmp/ for Gemini to read via @filepath
ipcMain.handle('docs:save-temp', async (event, { content, projectPath }) => {
  const fs = require('fs');

  try {
    const tmpDir = path.join(projectPath, 'tmp');
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
    const filename = 'noted-docs-' + Date.now() + '.txt';
    const filePath = path.join(tmpDir, filename);
    fs.writeFileSync(filePath, content, 'utf-8');
    console.log('[docs:save-temp] Saved', content.length, 'chars to', filePath);
    return { success: true, filePath };
  } catch (error) {
    console.error('[docs:save-temp] Error:', error);
    return { success: false, error: error.message };
  }
});

// Create a pre-filled Gemini session JSON with full content injected directly.
// Bypasses @file truncation (~96KB) and read_file limit (5000 lines).
// Content goes into content[] (sent to model), displayContent[] shows short summary in TUI.
ipcMain.handle('gemini:create-prefilled-session', async (event, { sessionContent, systemPrompt, additionalPrompt, cwd }) => {
  try {
    // 1. Resolve Gemini project directory
    invalidateProjectsJsonCache();
    let resolved = resolveGeminiProjectDir(cwd);
    if (!resolved) {
      // Predict slug-based path
      const pj = getGeminiProjectsJson();
      const normalizedCwd = path.resolve(cwd);
      const slug = pj?.projects?.[normalizedCwd];
      let chatsDir;
      if (slug) {
        chatsDir = path.join(os.homedir(), '.gemini', 'tmp', slug, 'chats');
      } else {
        const dirHash = calculateGeminiHash(normalizedCwd);
        chatsDir = path.join(os.homedir(), '.gemini', 'tmp', dirHash, 'chats');
      }
      if (!fs.existsSync(chatsDir)) fs.mkdirSync(chatsDir, { recursive: true });
      resolved = { chatsDir, projectDir: path.dirname(chatsDir), method: 'predicted' };
    }

    // 2. Read all docs/knowledge/* files
    const knowledgeDir = path.join(cwd, 'docs', 'knowledge');
    let knowledgeParts = [];
    let knowledgeTotalChars = 0;
    if (fs.existsSync(knowledgeDir)) {
      const files = fs.readdirSync(knowledgeDir).filter(f => f.endsWith('.md')).sort();
      for (const file of files) {
        try {
          const content = fs.readFileSync(path.join(knowledgeDir, file), 'utf-8');
          knowledgeParts.push('=== ' + file + ' ===\n' + content);
          knowledgeTotalChars += content.length;
        } catch (e) { /* skip unreadable files */ }
      }
    }
    const knowledgeContent = knowledgeParts.join('\n\n');

    // 3. Generate session IDs and timestamps
    const sessionId = crypto.randomUUID();
    const shortId = sessionId.slice(0, 8);
    const now = new Date();
    const timestamp = now.toISOString();
    // Filename format: session-2026-02-26T07-27-66148ceb.json
    const dateStr = timestamp.slice(0, 16).replace(/:/g, '-');
    const projectHash = calculateGeminiHash(cwd);

    // 4. Build prompt
    const fullPrompt = [systemPrompt, additionalPrompt].filter(Boolean).join('\n');

    // 5. Build content parts (what model sees - FULL content)
    const contentParts = [{ text: fullPrompt }];
    if (knowledgeContent) {
      contentParts.push({ text: '\n--- Project Knowledge Base (' + knowledgeParts.length + ' files) ---\n' });
      contentParts.push({ text: knowledgeContent });
    }
    if (sessionContent) {
      contentParts.push({ text: '\n--- Session Export ---\n' });
      contentParts.push({ text: sessionContent });
    }

    // 6. Build displayContent (what TUI shows - SHORT summary)
    const sessionLines = sessionContent ? sessionContent.split('\n').length : 0;
    const sessionKB = sessionContent ? Math.round(sessionContent.length / 1024) : 0;
    const displayText = fullPrompt + '\n[📎 Context: ' + knowledgeParts.length + ' knowledge files (' + Math.round(knowledgeTotalChars / 1024) + 'KB) + session export (' + sessionLines + ' lines, ' + sessionKB + 'KB)]';

    // 7. Create session JSON
    const sessionData = {
      sessionId,
      projectHash,
      startTime: timestamp,
      lastUpdated: timestamp,
      messages: [
        {
          id: crypto.randomUUID(),
          timestamp,
          type: 'user',
          content: contentParts,
          displayContent: [{ text: displayText }]
        }
      ]
    };

    // 8. Save to chats dir
    const filename = 'session-' + dateStr + '-' + shortId + '.json';
    const filePath = path.join(resolved.chatsDir, filename);
    fs.writeFileSync(filePath, JSON.stringify(sessionData, null, 2), 'utf-8');

    const totalChars = contentParts.reduce((sum, p) => sum + p.text.length, 0);
    console.log('[Prefilled Session] Created:', filePath);
    console.log('[Prefilled Session] SessionId:', sessionId);
    console.log('[Prefilled Session] Content: ' + knowledgeParts.length + ' knowledge files + ' + sessionLines + ' session lines = ' + totalChars + ' chars total');

    return { success: true, sessionId, filePath, totalChars };
  } catch (error) {
    console.error('[Prefilled Session] Error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('docs:read-prompt-file', async (event, { filePath }) => {
  const fs = require('fs');

  try {
    if (!fs.existsSync(filePath)) {
      return { success: false, error: 'Prompt file not found: ' + filePath };
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    console.log('[docs:read-prompt] Read prompt file:', filePath, '- Length:', content.length);
    return { success: true, content };
  } catch (error) {
    console.error('[docs:read-prompt] Error reading prompt file:', error);
    return { success: false, error: error.message };
  }
});

// Claude API proxy (avoids CORS — renderer can't call api.kiro.cheap directly)
ipcMain.handle('docs:api-request', async (event, { prompt }) => {
  try {
    console.log('[docs:api-request] Sending', Math.round(prompt.length / 1024) + 'KB to Claude API...');
    const response = await fetch('https://api.kiro.cheap/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'sk-aw-57742ca44f8b04d8fdd587f8289c7fb1',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4.6',
        max_tokens: 16000,
        messages: [{ role: 'user', content: prompt }]
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      console.error('[docs:api-request] API error', response.status, errorText.slice(0, 300));
      return { success: false, error: 'API ' + response.status + ': ' + errorText.slice(0, 200) };
    }

    const data = await response.json();
    const textBlock = data.content?.find(b => b.type === 'text');
    if (!textBlock?.text) {
      return { success: false, error: 'No text block in API response' };
    }

    const usage = data.usage || {};
    console.log('[docs:api-request] Response:', Math.round(textBlock.text.length / 1024) + 'KB, input:', usage.input_tokens, 'output:', usage.output_tokens);
    return { success: true, text: textBlock.text, usage };
  } catch (error) {
    console.error('[docs:api-request] Error:', error);
    return { success: false, error: error.message };
  }
});

// ========== SESSION PERSISTENCE ==========

// List available Gemini checkpoints
ipcMain.handle('session:list-gemini-checkpoints', async (event, { dirPath }) => {
  try {
    const checkpoints = await sessionManager.listAvailableGeminiCheckpoints(dirPath);
    return { success: true, data: checkpoints };
  } catch (error) {
    console.error('[main] Error listing Gemini checkpoints:', error);
    return { success: false, error: error.message };
  }
});

// Export Gemini session
ipcMain.handle('session:export-gemini', async (event, { dirPath, projectPath, sessionKey }) => {
  try {
    // dirPath = where Gemini saved checkpoint (tab cwd)
    // projectPath = for DB organization (project root)
    const result = await sessionManager.exportGeminiSession(dirPath, sessionKey, projectPath);
    return result;
  } catch (error) {
    console.error('[main] Error exporting Gemini session:', error);
    return { success: false, message: error.message };
  }
});

// Import Gemini session (Trojan Horse - Phase 1: prepare patch data)
ipcMain.handle('session:import-gemini', async (event, { dirPath, sessionKey, tabId, sessionId }) => {
  try {
    const sendCommand = null; // unused
    // dirPath = target cwd (where to deploy)
    // sessionId = for cross-project import
    const result = await sessionManager.importGeminiSession(dirPath, sessionKey, sendCommand, tabId, sessionId);
    return result;
  } catch (error) {
    console.error('[main] Error importing Gemini session:', error);
    return { success: false, message: error.message };
  }
});

// Patch checkpoint file (Trojan Horse - Phase 2: overwrite after Gemini creates shell)
ipcMain.handle('session:patch-checkpoint', async (event, { targetCwd, sessionKey, patchedContent }) => {
  try {
    const result = sessionManager.patchCheckpointFile(targetCwd, sessionKey, patchedContent);
    return result;
  } catch (error) {
    console.error('[main] Error patching checkpoint:', error);
    return { success: false, message: error.message };
  }
});

// Export Claude session (uses explicit sessionId from output sniffing)
ipcMain.handle('session:export-claude', async (event, { dirPath, sessionId, customName }) => {
  try {
    const result = await sessionManager.exportClaudeSession(dirPath, sessionId, customName);
    return result;
  } catch (error) {
    console.error('[main] Error exporting Claude session:', error);
    return { success: false, message: error.message };
  }
});

// Import Claude session (patches paths and returns explicit resume command)
ipcMain.handle('session:import-claude', async (event, { dirPath, sessionKey, sessionId }) => {
  try {
    const result = await sessionManager.importClaudeSession(dirPath, sessionKey, sessionId);
    return result;
  } catch (error) {
    console.error('[main] Error importing Claude session:', error);
    return { success: false, message: error.message };
  }
});

// List sessions (all or for specific project)
ipcMain.handle('session:list', async (event, { dirPath, toolType, global }) => {
  try {
    let sessions;
    if (global) {
      // Get ALL sessions across all projects
      sessions = projectManager.db.getAllAISessions(toolType);
    } else {
      // Get sessions for specific project
      sessions = sessionManager.listSessions(dirPath, toolType);
    }
    return { success: true, data: sessions };
  } catch (error) {
    console.error('[main] Error listing sessions:', error);
    return { success: false, error: error.message };
  }
});

// Delete deployment (checkpoint file from specific location)
ipcMain.handle('session:delete-deployment', async (event, { sessionId, sessionKey, deployedCwd }) => {
  try {
    const result = sessionManager.deleteDeployment(sessionId, sessionKey, deployedCwd);
    return result;
  } catch (error) {
    console.error('[main] Error deleting deployment:', error);
    return { success: false, message: error.message };
  }
});

// Delete session
ipcMain.handle('session:delete', async (event, sessionId) => {
  try {
    sessionManager.deleteSession(sessionId);
    return { success: true };
  } catch (error) {
    console.error('[main] Error deleting session:', error);
    return { success: false, error: error.message };
  }
});

// Save visual snapshot for a tab
ipcMain.handle('session:save-visual', async (event, { dirPath, tabIndex, snapshot }) => {
  try {
    projectManager.db.saveTabVisualSnapshot(dirPath, tabIndex, snapshot);
    return { success: true };
  } catch (error) {
    console.error('[main] Error saving visual snapshot:', error);
    return { success: false, error: error.message };
  }
});

// Get visual snapshot for a tab
ipcMain.handle('session:get-visual', async (event, { dirPath, tabIndex }) => {
  try {
    const snapshot = projectManager.db.getTabVisualSnapshot(dirPath, tabIndex);
    return { success: true, data: snapshot };
  } catch (error) {
    console.error('[main] Error getting visual snapshot:', error);
    return { success: false, error: error.message };
  }
});

// Validate session ID: check if it exists on disk for Claude/Gemini
ipcMain.handle('session:validate-id', async (event, { input, mode, tabId }) => {
  if (!input || !input.trim()) return {};
  const trimmed = input.trim();
  const cwd = terminalProjects.get(tabId) || null;
  const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const SHORT_RE = /^[0-9a-f]{8}$/i;
  const result = {};

  // Claude check
  if (mode === 'claude' || mode === 'auto') {
    const uuidMatch = trimmed.match(UUID_RE);
    if (uuidMatch) {
      const found = findSessionFile(uuidMatch[0], cwd);
      if (found) {
        let preview = null;
        try {
          const content = fs.readFileSync(found.filePath, 'utf-8');
          const lines = content.trim().split('\n');
          for (const line of lines) {
            const entry = JSON.parse(line);
            if (entry.type === 'human') {
              preview = (entry.message?.content || '').slice(0, 80);
              break;
            }
          }
        } catch (e) { /* ignore */ }
        result.claude = { status: 'found', fullId: uuidMatch[0], preview };
      } else {
        result.claude = { status: 'not-found' };
      }
    } else {
      result.claude = { status: 'invalid-format' };
    }
  }

  // Gemini check
  if (mode === 'gemini' || mode === 'auto') {
    const resolved = resolveGeminiProjectDir(cwd || os.homedir());
    if (!resolved) {
      result.gemini = { status: 'no-project' };
    } else {
      const uuidMatch = trimmed.match(UUID_RE);
      const isShort = SHORT_RE.test(trimmed);
      const searchId = uuidMatch ? uuidMatch[0] : (isShort ? trimmed : null);
      if (searchId) {
        const found = findGeminiSessionFile(searchId, resolved.chatsDir);
        if (found) {
          let preview = null;
          try {
            const msgs = found.data.messages || [];
            for (const msg of msgs) {
              if (msg.role === 'user') {
                preview = (msg.parts?.[0]?.text || '').slice(0, 80);
                break;
              }
            }
          } catch (e) { /* ignore */ }
          result.gemini = { status: 'found', fullId: found.data.sessionId, preview };
        } else {
          result.gemini = { status: 'not-found' };
        }
      } else {
        result.gemini = { status: 'invalid-format' };
      }
    }
  }

  return result;
});

// ========== CLAUDE INPUT INTERCEPTION ==========

// Claude launcher: start claude with handshake (session detected via Bridge watcher)
ipcMain.on('claude:spawn-with-watcher', (event, { tabId, cwd }) => {
  console.log('[Claude Launch] Starting Claude for tab:', tabId);

  const term = terminals.get(tabId);
  if (term) {
    // Enable thinking mode detection (will send Tab when '>' prompt appears)
    claudeState.set(tabId, 'WAITING_PROMPT');
    term.write('claude --dangerously-skip-permissions\r');
  }
  // Session ID will be detected by SessionBridge (via StatusLine)
});

// ========== GEMINI INPUT INTERCEPTION ==========

// Store active Gemini watchers by tabId (so we can close them when tab closes)
const geminiWatchers = new Map();

// Gemini Sniper Watcher: watch for new session file creation when gemini starts
// IMPORTANT: Gemini creates session file only AFTER first user message, not at startup!
// Session files are stored in ~/.gemini/tmp/<SHA256_HASH>/chats/session-<datetime>-<id>.json
ipcMain.on('gemini:spawn-with-watcher', (event, { tabId, cwd, resumeSessionId, bareResume }) => {
  console.log('[Gemini Sniper] ========================================');
  console.log('[Gemini Sniper] IPC received: gemini:spawn-with-watcher');
  console.log('[Gemini Sniper] TabId:', tabId);
  console.log('[Gemini Sniper] CWD from renderer:', cwd);

  // Close any existing watcher for this tab
  if (geminiWatchers.has(tabId)) {
    console.log('[Gemini Sniper] Closing existing watcher for tab');
    const oldWatcher = geminiWatchers.get(tabId);
    try { oldWatcher.close(); } catch (e) {}
    geminiWatchers.delete(tabId);
  }

  // Resolve project directory: slug (v0.30+) → hash (legacy) fallback
  const normalizedCwd = path.resolve(cwd || os.homedir());
  invalidateProjectsJsonCache(); // Fresh read — Gemini may have just created the mapping
  let resolved = resolveGeminiProjectDir(normalizedCwd);
  let chatsDir = resolved ? resolved.chatsDir : null;

  // If no existing dir found, predict slug-based path (Gemini 0.30+ will create it on first message)
  if (!chatsDir) {
    const { getGeminiProjectsJson, calculateGeminiHash } = require(path.join(srcMainDir, 'gemini-utils'));
    const pj = getGeminiProjectsJson();
    const slug = pj?.projects?.[normalizedCwd];
    if (slug) {
      chatsDir = path.join(os.homedir(), '.gemini', 'tmp', slug, 'chats');
    } else {
      // Hash fallback for projects not yet in projects.json
      const dirHash = calculateGeminiHash(normalizedCwd);
      chatsDir = path.join(os.homedir(), '.gemini', 'tmp', dirHash, 'chats');
    }
  }

  console.log('[Gemini Sniper] Normalized CWD:', normalizedCwd);
  console.log('[Gemini Sniper] Resolved method:', resolved ? resolved.method : 'predicted');
  console.log('[Gemini Sniper] Watching directory:', chatsDir);

  // List existing files in chats dir for debugging
  let existingFileCount = 0;
  try {
    if (fs.existsSync(chatsDir)) {
      const existingFiles = fs.readdirSync(chatsDir);
      existingFileCount = existingFiles.length;
      console.log('[Gemini Sniper] Existing files:', existingFileCount);
    } else {
      console.log('[Gemini Sniper] Chats dir does not exist yet');
    }
  } catch (e) {
    console.log('[Gemini Sniper] Could not list chats dir:', e.message);
  }

  const startTime = Date.now();
  let watcher = null;
  let sessionFound = false;

  const closeWatcher = () => {
    if (watcher) {
      try { watcher.close(); } catch (e) {}
      watcher = null;
      geminiWatchers.delete(tabId);
      console.log('[Gemini Sniper] Watcher closed for tab:', tabId);
    }
  };

  try {
    // Ensure directory exists (Gemini may create it)
    if (!fs.existsSync(chatsDir)) {
      console.log('[Gemini Sniper] Creating chats directory');
      fs.mkdirSync(chatsDir, { recursive: true });
    }

    console.log('[Gemini Sniper] Setting up fs.watch (no timeout - waits for first message)...');
    watcher = fs.watch(chatsDir, (eventType, filename) => {
      if (sessionFound) return;

      // Gemini session files: session-2026-01-22T22-19-788e351c.json
      if (!filename || !filename.startsWith('session-') || !filename.endsWith('.json')) return;

      console.log('[Gemini Sniper] Session file event:', eventType, filename);
      const filePath = path.join(chatsDir, filename);

      // Check if file is fresh (created or modified after our start time)
      fs.stat(filePath, (err, stats) => {
        if (err || sessionFound) return;

        const fileTime = Math.max(stats.mtimeMs, stats.birthtimeMs || 0);
        if (fileTime >= startTime - 500) {
          sessionFound = true;
          console.log('[Gemini Sniper] Fresh/modified session file detected!');

          // Read the file to get the full sessionId
          try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const data = JSON.parse(content);
            const sessionId = data.sessionId;

            console.log('[Gemini Sniper] ✅ SUCCESS! Session:', sessionId);
            event.sender.send('gemini:session-detected', { tabId, sessionId });
          } catch (parseErr) {
            // Fallback: extract short ID from filename
            const match = filename.match(/session-.*-([a-f0-9]{8})\.json$/i);
            if (match) {
              console.log('[Gemini Sniper] ✅ Using short ID:', match[1]);
              event.sender.send('gemini:session-detected', { tabId, sessionId: match[1] });
            }
          }
          closeWatcher();
        }
      });
    });

    // Store watcher in map so it can be closed when tab closes
    geminiWatchers.set(tabId, watcher);
    console.log('[Gemini Sniper] fs.watch active (will wait for first Gemini message)');

    // 2s re-check: Gemini may create slug mapping after start — switch watcher if needed
    if (!resolved) {
      setTimeout(() => {
        if (sessionFound || !geminiWatchers.has(tabId)) return;
        invalidateProjectsJsonCache();
        const newResolved = resolveGeminiProjectDir(normalizedCwd);
        if (newResolved && newResolved.chatsDir !== chatsDir) {
          console.log('[Gemini Sniper] Re-check: slug dir appeared, switching watcher →', newResolved.chatsDir);
          closeWatcher();
          chatsDir = newResolved.chatsDir;
          // Re-create watcher on new dir (recursive re-entry via IPC)
          event.sender.send('gemini:watcher-redirect', { tabId, newChatsDir: chatsDir });
          // Note: the watcher restart is handled by re-setting up fs.watch below
          if (!fs.existsSync(chatsDir)) fs.mkdirSync(chatsDir, { recursive: true });
          watcher = fs.watch(chatsDir, (eventType, filename) => {
            if (sessionFound) return;
            if (!filename || !filename.startsWith('session-') || !filename.endsWith('.json')) return;
            const filePath = path.join(chatsDir, filename);
            fs.stat(filePath, (err, stats) => {
              if (err || sessionFound) return;
              const fileTime = Math.max(stats.mtimeMs, stats.birthtimeMs || 0);
              if (fileTime >= startTime - 500) {
                sessionFound = true;
                try {
                  const content = fs.readFileSync(filePath, 'utf-8');
                  const data = JSON.parse(content);
                  console.log('[Gemini Sniper] ✅ SUCCESS (re-check)! Session:', data.sessionId);
                  event.sender.send('gemini:session-detected', { tabId, sessionId: data.sessionId });
                } catch (parseErr) {
                  const match = filename.match(/session-.*-([a-f0-9]{8})\.json$/i);
                  if (match) event.sender.send('gemini:session-detected', { tabId, sessionId: match[1] });
                }
                closeWatcher();
              }
            });
          });
          geminiWatchers.set(tabId, watcher);
        }
      }, 2000);
    }

    // Safety timeout: 5 minutes (user might take a while to send first message)
    setTimeout(() => {
      if (!sessionFound && geminiWatchers.has(tabId)) {
        console.log('[Gemini Sniper] ⏱️ 5 min timeout - closing watcher');
        closeWatcher();
      }
    }, 5 * 60 * 1000);

  } catch (e) {
    console.error('[Gemini Sniper] ❌ Error setting up watcher:', e.message);
  }

  // Let the command through - write 'gemini' (or 'gemini -r <id>') to PTY
  const term = terminals.get(tabId);
  if (term) {
    if (resumeSessionId) {
      console.log('[Gemini Sniper] Writing "gemini -r ' + resumeSessionId + '" to terminal');
      term.write('gemini -r ' + resumeSessionId + '\r');
      // For prefilled sessions, emit session-detected immediately (file already exists)
      sessionFound = true;
      event.sender.send('gemini:session-detected', { tabId, sessionId: resumeSessionId });
      closeWatcher();
    } else if (bareResume) {
      console.log('[Gemini Sniper] Writing "gemini -r" to terminal (bare resume)');
      term.write('gemini -r\r');
      // Bare "gemini -r" resumes latest session — find it by mtime (no new file created)
      closeWatcher(); // Don't need fs.watch, file already exists
      sessionFound = true;
      try {
        const chatFiles = fs.readdirSync(chatsDir)
          .filter(f => f.startsWith('session-') && f.endsWith('.json'))
          .map(f => ({ name: f, mtime: fs.statSync(path.join(chatsDir, f)).mtimeMs }))
          .sort((a, b) => b.mtime - a.mtime);
        if (chatFiles.length > 0) {
          const latestFile = path.join(chatsDir, chatFiles[0].name);
          const data = JSON.parse(fs.readFileSync(latestFile, 'utf-8'));
          console.log('[Gemini Sniper] ✅ Bare resume → latest session:', data.sessionId, '(' + chatFiles[0].name + ')');
          event.sender.send('gemini:session-detected', { tabId, sessionId: data.sessionId });
        } else {
          console.log('[Gemini Sniper] ⚠️ No session files found for bare resume');
        }
      } catch (e) {
        console.error('[Gemini Sniper] ❌ Error finding latest session:', e.message);
      }
    } else {
      console.log('[Gemini Sniper] Writing "gemini" to terminal');
      term.write('gemini\r');
    }
  } else {
    console.log('[Gemini Sniper] ❌ Terminal not found for tabId:', tabId);
  }
});

// Close Gemini watcher when tab closes
ipcMain.on('gemini:close-watcher', (event, { tabId }) => {
  if (geminiWatchers.has(tabId)) {
    console.log('[Gemini Sniper] Closing watcher for closed tab:', tabId);
    const watcher = geminiWatchers.get(tabId);
    try { watcher.close(); } catch (e) {}
    geminiWatchers.delete(tabId);
  }
});

// Gemini run command: execute gemini commands (gemini-c, gemini-f)
ipcMain.on('gemini:run-command', (event, { tabId, command, sessionId, cwd }) => {
  const term = terminals.get(tabId);
  if (!term) {
    console.error('[Gemini] Terminal not found:', tabId);
    return;
  }

  // Get cwd from terminalProjects if not provided
  const termCwd = cwd || terminalProjects.get(tabId);
  console.log('[Gemini] Running command:', command, 'sessionId:', sessionId, 'cwd:', termCwd);

  switch (command) {
    case 'gemini':
      // New session - handled by spawn-with-watcher
      break;

    case 'gemini-c':
      // Continue session (same session)
      if (sessionId) {
        term.write(`gemini -r ${sessionId}\r`);
      } else {
        console.error('[Gemini] No sessionId for gemini-c');
      }
      break;

    case 'gemini-f':
      // TRUE FORK: copy session file with new UUID
      if (!sessionId) {
        console.error('[Gemini] No sessionId for gemini-f');
        return;
      }

      console.log('[Gemini Fork] ========================================');
      console.log('[Gemini Fork] Source sessionId:', sessionId);

      try {
        // Resolve project directory: slug (v0.30+) → hash (legacy) fallback
        const resolved = resolveGeminiProjectDir(termCwd || os.homedir());
        if (!resolved) {
          console.error('[Gemini Fork] Chats directory not found');
          term.write(`echo "❌ Gemini chats directory not found"\r`);
          return;
        }
        const chatsDir = resolved.chatsDir;
        console.log('[Gemini Fork] Chats dir:', chatsDir, '(method:', resolved.method + ')');

        // Find source session file
        const found = findGeminiSessionFile(sessionId, chatsDir);
        if (!found) {
          console.error('[Gemini Fork] Source session not found:', sessionId);
          term.write(`echo "❌ Session not found: ${sessionId}"\r`);
          return;
        }
        const sourceFile = found.filePath;
        const sourceData = found.data;
        console.log('[Gemini Fork] ✓ Found source file:', path.basename(sourceFile));

        // Generate new UUID and timestamp
        const newUUID = crypto.randomUUID();
        const now = new Date();
        const newTimestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, -5); // 2026-01-24T12-30-45
        const shortId = newUUID.slice(-8);

        console.log('[Gemini Fork] New UUID:', newUUID);
        console.log('[Gemini Fork] New timestamp:', newTimestamp);

        // Patch the data
        const newData = {
          ...sourceData,
          sessionId: newUUID,
          startTime: now.toISOString(),
          lastUpdateTime: now.toISOString()
          // projectHash stays the same (same directory)
        };

        // Save with new filename
        const newFilename = `session-${newTimestamp}-${shortId}.json`;
        const newFilePath = path.join(chatsDir, newFilename);

        fs.writeFileSync(newFilePath, JSON.stringify(newData, null, 2), 'utf-8');
        console.log('[Gemini Fork] ✅ Created fork:', newFilename);

        // Run gemini -r with the NEW session ID
        term.write(`gemini -r ${newUUID}\r`);

        // Notify renderer about new session ID
        event.sender.send('gemini:session-detected', { tabId, sessionId: newUUID });
        console.log('[Gemini Fork] Sent session-detected event with new UUID');

      } catch (error) {
        console.error('[Gemini Fork] Error:', error);
        term.write(`echo "❌ Fork error: ${error.message}"\r`);
      }
      break;

    default:
      console.error('[Gemini] Unknown command:', command);
  }
});

// Send a slash command to Gemini CLI (chunked paste, fast mode)
// Serialized per tab: rapid clicks queue up instead of overlapping.
// Without this, two rapid Ctrl+C from ctrlCFirst trigger Gemini's
// "Press Ctrl+C again to exit" → second Ctrl+C kills the process.
const geminiCommandQueue = new Map(); // tabId -> Promise

ipcMain.on('gemini:send-command', (event, tabId, command) => {
  console.log('[gemini:send-command] Received: tabId=' + tabId + ' command="' + command + '"');
  const term = terminals.get(tabId);
  if (!term) { console.log('[gemini:send-command] Terminal not found'); return; }

  const prev = geminiCommandQueue.get(tabId) || Promise.resolve();
  const next = prev.then(async () => {
    // Wait for Gemini to settle after previous command
    await drainPtyData(term, 300);

    // Clear input line WITHOUT Ctrl+C (which triggers "Press Ctrl+C again to exit").
    // Ctrl+C at idle in Gemini = danger zone. Instead:
    // 1. Ctrl+A (Home) to move cursor to start
    // 2. Ctrl+K to kill from cursor to end of line (clears input)
    // Both are readline-compatible and safe in Gemini's TUI.
    term.write('\x01'); // Ctrl+A (beginning of line)
    term.write('\x0b'); // Ctrl+K (kill to end of line)
    await new Promise(r => setTimeout(r, 100));

    await safePasteAndSubmit(term, command, {
      submit: true,
      ctrlCFirst: false,
      fast: true,
      logPrefix: '[gemini:send-command:' + tabId + ']'
    });
    // Wait for Gemini to process the command before allowing next
    await drainPtyData(term, 500);
  });
  geminiCommandQueue.set(tabId, next.catch((err) => {
    console.error('[gemini:send-command] Error:', err.message);
  }));
});

// ========== GEMINI REWIND (TUI NAVIGATION) ==========
// Programmatic rewind: open /rewind menu, navigate to target, confirm.
// Gemini rewind menu:
//   /rewind\r → modal with ● on "Stay at current position" (bottom)
//   UP moves ● through messages (newest→oldest)
//   Enter → confirmation dialog "● 1. Rewind conversation / 2. Do nothing"
//   Enter → rewind executed
// Detection: RGB(166,227,161) green text = selected entry

ipcMain.handle('gemini:open-history-menu', async (event, { tabId, targetText, skipDuplicates = 0, pasteAfter }) => {
  const term = terminals.get(tabId);
  if (!term) return { success: false, error: 'no terminal' };

  const stripped = require('node:util').stripVTControlCharacters;

  // Extract text colored with RGB(166,227,161) — green selection color
  function extractGreenText(raw) {
    const GREEN_START = '\x1b[38;2;166;227;161m';
    const results = [];
    let searchFrom = 0;
    while (true) {
      const startIdx = raw.indexOf(GREEN_START, searchFrom);
      if (startIdx === -1) break;
      let endIdx = startIdx + GREEN_START.length;
      let text = '';
      while (endIdx < raw.length) {
        if (raw[endIdx] === '\x1b') {
          const remaining = raw.substring(endIdx);
          if (remaining.startsWith('\x1b[39m') || remaining.startsWith('\x1b[38;2;') || remaining.startsWith('\x1b[0m')) break;
          const escEnd = remaining.indexOf('m');
          if (escEnd !== -1 && escEnd < 30) { endIdx += escEnd + 1; continue; }
        }
        text += raw[endIdx];
        endIdx++;
      }
      const cleaned = stripped(text).trim();
      if (cleaned.length > 0 && cleaned !== '\u25CF') results.push(cleaned);
      searchFrom = endIdx;
    }
    return results;
  }

  function textMatchesTarget(selectedText, targetPrefix) {
    if (!selectedText || !targetPrefix) return false;
    const st = selectedText.trim().replace(/\s+/g, ' ').substring(0, 50);
    const tp = targetPrefix.trim().replace(/\s+/g, ' ').substring(0, 50);
    if (st.includes(tp) || tp.includes(st)) return true;
    // Fuzzy: >=60% word overlap
    const targetWords = tp.split(/\s+/).filter(w => w.length > 2);
    if (targetWords.length > 0) {
      const matched = targetWords.filter(w => st.includes(w));
      if (matched.length / targetWords.length >= 0.6) return true;
    }
    return false;
  }

  // Serialize with geminiCommandQueue
  const prev = geminiCommandQueue.get(tabId) || Promise.resolve();
  const result = await new Promise((resolveOuter) => {
    const next = prev.then(async () => {
      try {
        // Step 0: Check DangerZone
        const dz = claudeCtrlCDangerZone.get(tabId);
        if (dz) {
          console.log('[Gemini:Rewind] \u26A0\uFE0F DangerZone active — waiting...');
          await dz.promise;
          console.log('[Gemini:Rewind] \u2705 DangerZone cleared');
        }

        // Step 1: Clear input and send /rewind
        console.log('[Gemini:Rewind] Step 1: Sending /rewind...');
        term.write('\x01'); // Ctrl+A
        term.write('\x0b'); // Ctrl+K
        await new Promise(r => setTimeout(r, 100));

        await safePasteAndSubmit(term, '/rewind', {
          submit: true,
          ctrlCFirst: false,
          fast: true,
          logPrefix: '[Gemini:Rewind]'
        });

        // Step 2: Wait for menu to render (deterministic marker)
        console.log('[Gemini:Rewind] Step 2: Waiting for menu...');
        const menuRaw = await waitForPtyText(term, 'Stay at current position', 5000, '[Gemini:Rewind]');

        if (!menuRaw.includes('Rewind') && !menuRaw.includes('\u25CF')) {
          console.error('[Gemini:Rewind] Menu did not open (' + menuRaw.length + 'B)');
          resolveOuter({ success: false, error: 'Rewind menu did not open' });
          return;
        }
        console.log('[Gemini:Rewind] Menu opened (' + menuRaw.length + 'B)');

        // Step 3: Navigate UP to target
        const targetPrefix = (targetText || '').substring(0, 40);
        console.log('[Gemini:Rewind] Step 3: Navigating to: "' + targetPrefix + '"');

        let found = false;
        let pressCount = 0;
        const maxPresses = 50;
        let duplicatesRemaining = skipDuplicates;

        for (let i = 0; i < maxPresses; i++) {
          term.write('\x1b[A'); // UP
          const navRaw = await waitForPtyText(term, /\x1b\[38;2;166;227;161m/, 2000, '[Gemini:Rewind]');
          pressCount++;

          if (navRaw.length === 0) {
            console.log('[Gemini:Rewind] Hit top boundary at press #' + pressCount);
            break;
          }

          const greenTexts = extractGreenText(navRaw);
          // Last green text is the entry text (first is ● symbol)
          const selectedText = greenTexts.length > 0 ? greenTexts[greenTexts.length - 1] : null;
          console.log('[Gemini:Rewind] UP #' + pressCount + ' \u2192 "' + (selectedText || 'null').substring(0, 50) + '"');

          if (selectedText && textMatchesTarget(selectedText, targetPrefix)) {
            if (duplicatesRemaining > 0) {
              duplicatesRemaining--;
              console.log('[Gemini:Rewind] \u23E9 Skipping duplicate (' + duplicatesRemaining + ' remaining)');
              continue;
            }
            console.log('[Gemini:Rewind] \u2705 Target matched!');
            found = true;
            break;
          }
        }

        if (!found) {
          console.error('[Gemini:Rewind] \u274C Target not found after ' + pressCount + ' presses. Closing menu.');
          term.write('\x1b'); // Escape to close
          await waitForPtyText(term, /INSERT|NORMAL/, 2000, '[Gemini:Rewind]');
          resolveOuter({ success: false, error: 'Target not found', pressCount });
          return;
        }

        // Step 4: Confirm selection (Enter)
        console.log('[Gemini:Rewind] Step 4: Confirming selection...');
        term.write('\r');
        const confirmRaw = await waitForPtyText(term, 'Do nothing', 5000, '[Gemini:Rewind]');

        // Step 5: Handle confirmation dialog
        // After selecting an entry, Gemini shows: "● 1. Rewind conversation / 2. Do nothing"
        // ● is already on "Rewind conversation" — just press Enter
        const confirmClean = stripped(confirmRaw.replace(/\x1b\[\d+;\d+[Hf]/g, '\n').replace(/\x1b\[(\d*)C/g, ' '));
        if (confirmClean.includes('Rewind conversation') || confirmClean.includes('Do nothing')) {
          console.log('[Gemini:Rewind] Step 5: Confirmation dialog detected — pressing Enter...');
          term.write('\r');
          await waitForPtyText(term, /shift\+tab|INSERT|NORMAL/, 8000, '[Gemini:Rewind]');
        } else {
          console.log('[Gemini:Rewind] Step 5: No confirmation dialog (direct rewind)');
        }

        // Step 6: Wait for rewind to complete and prompt to restore
        console.log('[Gemini:Rewind] Step 6: Waiting for prompt...');
        await waitForPtyText(term, /shift\+tab|INSERT|NORMAL/, 5000, '[Gemini:Rewind]');

        // Step 7: Paste compact if provided
        if (pasteAfter && typeof pasteAfter === 'string' && pasteAfter.length > 0) {
          console.log('[Gemini:Rewind] Step 7: Pasting compact (' + pasteAfter.length + ' chars)...');

          term.write('\x01'); // Ctrl+A
          term.write('\x0b'); // Ctrl+K
          await new Promise(r => setTimeout(r, 100));

          await safePasteAndSubmit(term, pasteAfter, {
            submit: true,
            ctrlCFirst: false,
            fast: true,
            logPrefix: '[Gemini:Rewind:paste]'
          });
          await waitForPtyText(term, /shift\+tab/, 5000, '[Gemini:Rewind]');
        }

        console.log('[Gemini:Rewind] \u2705 Rewind complete');
        resolveOuter({ success: true, found: true, pressCount });
      } catch (err) {
        console.error('[Gemini:Rewind] Error:', err.message);
        try { term.write('\x1b'); } catch (e) {} // try close menu
        resolveOuter({ success: false, error: err.message });
      }
    });
    geminiCommandQueue.set(tabId, next.catch(() => {}));
  });

  return result;
});

// Copy a range of messages from Gemini session (for compact/rewind)
ipcMain.handle('gemini:copy-range', async (event, { sessionId, cwd, startUuid, endUuid }) => {
  console.log('[Gemini:CopyRange] sessionId=' + sessionId + ' start=' + startUuid + ' end=' + endUuid);

  if (!sessionId || !cwd) {
    return { success: false, content: '' };
  }

  try {
    const resolved = resolveGeminiProjectDir(cwd);
    if (!resolved) return { success: false, content: '', error: 'Project dir not found' };

    const found = findGeminiSessionFile(sessionId, resolved.chatsDir);
    if (!found) return { success: false, content: '', error: 'Session file not found' };

    const { data } = found;
    if (!data.messages || !Array.isArray(data.messages)) {
      return { success: false, content: '', error: 'No messages in session' };
    }

    // Find start and end message indices
    let startIdx = -1;
    let endIdx = -1;
    for (let i = 0; i < data.messages.length; i++) {
      const msg = data.messages[i];
      if (msg.id === startUuid && startIdx === -1) startIdx = i;
      if (msg.id === endUuid) endIdx = i;
    }

    if (startIdx === -1) {
      console.log('[Gemini:CopyRange] Start UUID not found, using first message');
      startIdx = 0;
    }
    if (endIdx === -1) {
      endIdx = data.messages.length - 1;
    }

    // Extract messages in range
    const parts = [];
    for (let i = startIdx; i <= endIdx; i++) {
      const msg = data.messages[i];
      let content = '';
      if (typeof msg.content === 'string') {
        content = msg.content;
      } else if (Array.isArray(msg.content)) {
        content = msg.content.filter(p => p.text).map(p => p.text).join('\n');
      }
      if (!content) continue;

      const role = msg.type === 'user' ? 'Human' : 'Assistant';
      parts.push(role + ': ' + content);
    }

    const result = parts.join('\n\n');
    console.log('[Gemini:CopyRange] Extracted ' + parts.length + ' messages, ' + result.length + ' chars');
    return { success: true, content: result };
  } catch (err) {
    console.error('[Gemini:CopyRange] Error:', err.message);
    return { success: false, content: '', error: err.message };
  }
});

// ========== GEMINI TIME MACHINE ==========
// Auto-backup session on every change, allow rollback to any turn

const MINAYU_HISTORY_DIR = path.join(os.homedir(), '.minayu', 'history');
const geminiHistoryWatchers = new Map(); // sessionId -> { watcher, filePath, lastTurnCount }

// Ensure history directory exists
if (!fs.existsSync(MINAYU_HISTORY_DIR)) {
  fs.mkdirSync(MINAYU_HISTORY_DIR, { recursive: true });
}

// Count user messages (turns) in a session
function countGeminiTurns(sessionData) {
  if (!sessionData.messages) return 0;
  return sessionData.messages.filter(m => m.type === 'user').length;
}

// Get turn info (user message previews)
function getGeminiTurnInfo(sessionData) {
  if (!sessionData.messages) return [];

  const turns = [];
  let turnIndex = 0;

  for (let i = 0; i < sessionData.messages.length; i++) {
    const msg = sessionData.messages[i];
    if (msg.type === 'user') {
      turnIndex++;
      // Normalize content: string || [{text}] → string
      let contentStr = '';
      if (typeof msg.content === 'string') {
        contentStr = msg.content;
      } else if (Array.isArray(msg.content)) {
        contentStr = msg.content.filter(p => p.text).map(p => p.text).join('\n');
      }
      turns.push({
        turnNumber: turnIndex,
        messageIndex: i,
        preview: contentStr.slice(0, 100).replace(/\n/g, ' '),
        timestamp: msg.timestamp
      });
    }
  }

  return turns;
}

// Save a history snapshot for a specific turn
function saveGeminiHistorySnapshot(sessionId, sessionData, turnNumber) {
  const historyDir = path.join(MINAYU_HISTORY_DIR, sessionId);
  if (!fs.existsSync(historyDir)) {
    fs.mkdirSync(historyDir, { recursive: true });
  }

  const snapshotFile = path.join(historyDir, `turn-${String(turnNumber).padStart(3, '0')}.json`);

  // Don't overwrite existing snapshots
  if (fs.existsSync(snapshotFile)) {
    return false;
  }

  fs.writeFileSync(snapshotFile, JSON.stringify(sessionData, null, 2), 'utf-8');
  console.log('[Gemini TimeMachine] Saved snapshot:', snapshotFile);
  return true;
}

// Start watching a session file for changes
ipcMain.on('gemini:start-history-watcher', (event, { sessionId, cwd }) => {
  console.log('[Gemini TimeMachine] Starting history watcher for:', sessionId);

  // Close existing watcher for this session
  if (geminiHistoryWatchers.has(sessionId)) {
    const old = geminiHistoryWatchers.get(sessionId);
    try { old.watcher.close(); } catch (e) {}
    geminiHistoryWatchers.delete(sessionId);
  }

  // Find the session file via slug/hash resolver
  const resolved = resolveGeminiProjectDir(cwd);
  if (!resolved) {
    console.error('[Gemini TimeMachine] Project dir not found for:', cwd);
    return;
  }
  const found = findGeminiSessionFile(sessionId, resolved.chatsDir);
  if (!found) {
    console.error('[Gemini TimeMachine] Session file not found:', sessionId);
    return;
  }
  const sessionFilePath = found.filePath;
  console.log('[Gemini TimeMachine] Watching file:', sessionFilePath);

  // Read initial state
  let lastTurnCount = 0;
  try {
    const data = JSON.parse(fs.readFileSync(sessionFilePath, 'utf-8'));
    lastTurnCount = countGeminiTurns(data);
    // Save initial snapshot
    if (lastTurnCount > 0) {
      saveGeminiHistorySnapshot(sessionId, data, lastTurnCount);
    }
  } catch (e) {
    console.error('[Gemini TimeMachine] Error reading initial state:', e.message);
  }

  // Watch for changes
  const watcher = fs.watch(sessionFilePath, { persistent: false }, (eventType) => {
    if (eventType !== 'change') return;

    // Debounce: wait a bit for file to be fully written
    setTimeout(() => {
      try {
        const content = fs.readFileSync(sessionFilePath, 'utf-8');
        const data = JSON.parse(content);
        const currentTurnCount = countGeminiTurns(data);

        // New turn detected - save snapshot
        if (currentTurnCount > lastTurnCount) {
          console.log('[Gemini TimeMachine] New turn detected:', lastTurnCount, '->', currentTurnCount);
          saveGeminiHistorySnapshot(sessionId, data, currentTurnCount);
          lastTurnCount = currentTurnCount;

          // Notify renderer about new turn
          event.sender.send('gemini:history-updated', { sessionId, turnCount: currentTurnCount });
        }
      } catch (e) {
        // File might be in the middle of being written
      }
    }, 500);
  });

  geminiHistoryWatchers.set(sessionId, { watcher, filePath: sessionFilePath, lastTurnCount });
});

// Stop watching a session
ipcMain.on('gemini:stop-history-watcher', (event, { sessionId }) => {
  if (geminiHistoryWatchers.has(sessionId)) {
    const { watcher } = geminiHistoryWatchers.get(sessionId);
    try { watcher.close(); } catch (e) {}
    geminiHistoryWatchers.delete(sessionId);
    console.log('[Gemini TimeMachine] Stopped watching:', sessionId);
  }
});

// Get history (list of available turns)
ipcMain.handle('gemini:get-timemachine', async (event, { sessionId, cwd }) => {
  console.log('[Gemini TimeMachine] Getting history for:', sessionId);

  const historyDir = path.join(MINAYU_HISTORY_DIR, sessionId);
  const turns = [];

  // Read from saved snapshots
  if (fs.existsSync(historyDir)) {
    const files = fs.readdirSync(historyDir)
      .filter(f => f.startsWith('turn-') && f.endsWith('.json'))
      .sort();

    for (const file of files) {
      try {
        const filePath = path.join(historyDir, file);
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        const turnInfo = getGeminiTurnInfo(data);
        const lastTurn = turnInfo[turnInfo.length - 1];

        if (lastTurn) {
          turns.push({
            turnNumber: lastTurn.turnNumber,
            preview: lastTurn.preview,
            timestamp: lastTurn.timestamp,
            file: file
          });
        }
      } catch (e) {
        console.error('[Gemini TimeMachine] Error reading snapshot:', file, e.message);
      }
    }
  }

  return { success: true, turns };
});

// Rollback to a specific turn
ipcMain.handle('gemini:rollback', async (event, { sessionId, turnNumber, cwd, tabId }) => {
  console.log('[Gemini TimeMachine] Rolling back to turn:', turnNumber);

  const historyDir = path.join(MINAYU_HISTORY_DIR, sessionId);
  const snapshotFile = path.join(historyDir, `turn-${String(turnNumber).padStart(3, '0')}.json`);

  if (!fs.existsSync(snapshotFile)) {
    return { success: false, error: 'Snapshot not found' };
  }

  // Find the original session file via slug/hash resolver
  const resolved = resolveGeminiProjectDir(cwd);
  if (!resolved) {
    return { success: false, error: 'Gemini project directory not found' };
  }
  const found = findGeminiSessionFile(sessionId, resolved.chatsDir);
  if (!found) {
    return { success: false, error: 'Original session file not found' };
  }
  const originalFilePath = found.filePath;

  // Stop the history watcher temporarily
  if (geminiHistoryWatchers.has(sessionId)) {
    const { watcher } = geminiHistoryWatchers.get(sessionId);
    try { watcher.close(); } catch (e) {}
    geminiHistoryWatchers.delete(sessionId);
  }

  // DELETE ALL FUTURE SNAPSHOTS (turns > turnNumber)
  // This is crucial for correct history after rollback
  try {
    const snapshotFiles = fs.readdirSync(historyDir)
      .filter(f => f.startsWith('turn-') && f.endsWith('.json'));

    for (const file of snapshotFiles) {
      const match = file.match(/^turn-(\d+)\.json$/);
      if (match) {
        const fileTurnNumber = parseInt(match[1], 10);
        if (fileTurnNumber > turnNumber) {
          const fileToDelete = path.join(historyDir, file);
          fs.unlinkSync(fileToDelete);
          console.log('[Gemini TimeMachine] Deleted future snapshot:', file);
        }
      }
    }
  } catch (e) {
    console.error('[Gemini TimeMachine] Error cleaning up future snapshots:', e.message);
  }

  // Kill the terminal process
  const term = terminals.get(tabId);
  if (term) {
    console.log('[Gemini TimeMachine] Killing terminal:', tabId);
    term.kill();
    terminals.delete(tabId);
    terminalProjects.delete(tabId);
  }

  // Wait for process to die
  await new Promise(resolve => setTimeout(resolve, 500));

  // Copy snapshot to original location
  try {
    fs.copyFileSync(snapshotFile, originalFilePath);
    console.log('[Gemini TimeMachine] Restored:', snapshotFile, '->', originalFilePath);
  } catch (e) {
    return { success: false, error: 'Failed to restore snapshot: ' + e.message };
  }

  return { success: true, sessionId, cwd };
});

// ========== GEMINI TIMELINE ==========

ipcMain.handle('gemini:get-timeline', async (event, { sessionId, cwd }) => {
  console.log('[Gemini Timeline] Getting timeline for session:', sessionId, 'cwd:', cwd);

  if (!sessionId || !cwd) {
    return { success: false, entries: [], sessionBoundaries: [], latestSessionId: null };
  }

  try {
    const resolved = resolveGeminiProjectDir(cwd);
    if (!resolved) {
      console.log('[Gemini Timeline] Project dir not found');
      return { success: false, entries: [], sessionBoundaries: [], latestSessionId: null };
    }

    const found = findGeminiSessionFile(sessionId, resolved.chatsDir);
    if (!found) {
      console.log('[Gemini Timeline] Session file not found:', sessionId);
      return { success: false, entries: [], sessionBoundaries: [], latestSessionId: null };
    }

    const { data } = found;
    const entries = [];

    if (data.messages && Array.isArray(data.messages)) {
      for (let i = 0; i < data.messages.length; i++) {
        const msg = data.messages[i];
        if (msg.type !== 'user') continue;

        // Prefer displayContent (short summary for prefilled sessions) over full content
        const source = (Array.isArray(msg.displayContent) && msg.displayContent.length > 0) ? msg.displayContent : msg.content;

        // Normalize content: string || [{text}] || [{type:'text', text}] → string
        let content = '';
        if (typeof source === 'string') {
          content = source;
        } else if (Array.isArray(source)) {
          const textParts = source
            .filter(p => p.text)
            .map(p => p.text);
          content = textParts.join('\n') || JSON.stringify(source);
        } else if (source) {
          content = String(source);
        }

        entries.push({
          uuid: msg.id || `${sessionId}-msg-${i}`,
          type: 'user',
          timestamp: msg.timestamp || data.startTime || new Date().toISOString(),
          content,
          sessionId
        });
      }
    }

    console.log('[Gemini Timeline] Returning', entries.length, 'entries');
    return {
      success: true,
      entries,
      sessionBoundaries: [],
      latestSessionId: null
    };
  } catch (error) {
    console.error('[Gemini Timeline] Error:', error);
    return { success: false, entries: [], sessionBoundaries: [], latestSessionId: null };
  }
});

// ========== GEMINI FULL HISTORY ==========

ipcMain.handle('gemini:get-full-history', async (event, { sessionId, cwd }) => {
  console.log('[Gemini FullHistory] Getting full history for session:', sessionId);

  if (!sessionId || !cwd) {
    return { success: false, error: 'No session ID or cwd' };
  }

  try {
    const resolved = resolveGeminiProjectDir(cwd);
    if (!resolved) {
      return { success: false, error: 'Project dir not found' };
    }

    const found = findGeminiSessionFile(sessionId, resolved.chatsDir);
    if (!found) {
      return { success: false, error: 'Session file not found' };
    }

    const { data } = found;
    if (!data.messages || !Array.isArray(data.messages)) {
      return { success: true, entries: [] };
    }

    const entries = [];

    for (let i = 0; i < data.messages.length; i++) {
      const msg = data.messages[i];
      // Normalize content
      let content = '';
      if (typeof msg.content === 'string') {
        content = msg.content;
      } else if (Array.isArray(msg.content)) {
        content = msg.content.filter(p => p.text).map(p => p.text).join('\n');
      }
      if (!content) continue;

      const stableUuid = msg.id || `${sessionId}-msg-${i}`;

      if (msg.type === 'user') {
        entries.push({
          uuid: stableUuid,
          role: 'user',
          timestamp: msg.timestamp || data.startTime || '',
          content,
          sessionId
        });
      } else if (msg.type === 'gemini') {
        entries.push({
          uuid: stableUuid,
          role: 'assistant',
          timestamp: msg.timestamp || '',
          content,
          sessionId
        });
      }
      // Skip 'info' type messages
    }

    console.log('[Gemini FullHistory] Returning', entries.length, 'entries');
    return { success: true, entries };
  } catch (error) {
    console.error('[Gemini FullHistory] Error:', error);
    return { success: false, error: error.message };
  }
});

// ========== SESSION CHAIN HELPERS ==========

// Find a JSONL session file by ID, searching cwd-based path first, then all project dirs
function findSessionFile(sessionId, cwd) {
  try {
    const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');

    if (cwd) {
      const projectSlug = cwd.replace(/\//g, '-');
      const primaryPath = path.join(claudeProjectsDir, projectSlug, `${sessionId}.jsonl`);
      if (fs.existsSync(primaryPath)) {
        return { filePath: primaryPath, projectDir: path.join(claudeProjectsDir, projectSlug) };
      }
    }

    if (fs.existsSync(claudeProjectsDir)) {
      const projectDirs = fs.readdirSync(claudeProjectsDir, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name);
      for (const dir of projectDirs) {
        const checkPath = path.join(claudeProjectsDir, dir, `${sessionId}.jsonl`);
        if (fs.existsSync(checkPath)) {
          return { filePath: checkPath, projectDir: path.join(claudeProjectsDir, dir) };
        }
      }
    }
    return null;
  } catch (e) {
    return null;
  }
}

// Load all records from a JSONL file into a Map (uuid → record)
// Returns { recordMap, lastRecord, bridgeSessionId }
// bridgeSessionId is set if the first entry references a different session (clear-context bridge)
function loadJsonlRecords(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.trim().split('\n').filter(line => line.trim());
  const sessionId = path.basename(filePath, '.jsonl');

  const recordMap = new Map();
  const progressEntries = [];
  let lastRecord = null;
  let bridgeSessionId = null;
  let fileIndex = 0;

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      // Collect agent_progress entries (sub-agent turns from Task tool)
      if (entry.type === 'progress' && entry.data?.type === 'agent_progress' && entry.parentToolUseID) {
        progressEntries.push(entry);
      }
      if (entry.uuid) {
        entry._fileIndex = fileIndex++;
        entry._fromFile = sessionId;
        recordMap.set(entry.uuid, entry);
        lastRecord = entry;
        // Detect bridge: first entry with uuid that has a different sessionId
        if (bridgeSessionId === null && entry.sessionId && entry.sessionId !== sessionId) {
          bridgeSessionId = entry.sessionId;
          entry._isBridge = true; // Mark for backtrace bridge following
        } else if (bridgeSessionId === null && entry.sessionId === sessionId) {
          bridgeSessionId = undefined; // No bridge
        }
      }
    } catch {}
  }

  return { recordMap, lastRecord, bridgeSessionId: bridgeSessionId || null, progressEntries };
}

// Resolve the full chain of JSONL files by following bridge entries backwards.
// Returns a merged recordMap with all records from all files in the chain,
// plus metadata about session boundaries.
// sessionBoundaries: array of { childSessionId, parentSessionId, bridgeUuid }
function resolveSessionChain(sessionId, cwd, maxDepth = 10) {
  const mergedMap = new Map();
  const allProgressEntries = [];
  const sessionBoundaries = [];
  let currentSessionId = sessionId;
  let lastRecord = null;
  let depth = 0;

  while (currentSessionId && depth < maxDepth) {
    const found = findSessionFile(currentSessionId, cwd);
    if (!found) {
      console.log('[SessionChain] File not found for:', currentSessionId);
      break;
    }

    const { recordMap, lastRecord: fileLastRecord, bridgeSessionId, progressEntries } = loadJsonlRecords(found.filePath);
    if (progressEntries.length > 0) {
      allProgressEntries.push(...progressEntries);
    }

    // On the first file (newest), capture the lastRecord for backtrace start
    if (depth === 0) {
      lastRecord = fileLastRecord;
    }

    // Merge records (don't overwrite newer records from child files)
    for (const [uuid, record] of recordMap) {
      if (!mergedMap.has(uuid)) {
        mergedMap.set(uuid, record);
      }
    }

    // SessionChain load logged silently (use [Claude Export] logs for debug)

    if (bridgeSessionId) {
      sessionBoundaries.push({
        childSessionId: currentSessionId,
        parentSessionId: bridgeSessionId,
      });
      currentSessionId = bridgeSessionId;
    } else {
      // No JSONL bridge — check SQLite for session link (Clear Context without bridge entry)
      try {
        const parentId = projectManager.db.getSessionParent(currentSessionId);
        if (parentId) {
          console.log('[SessionChain] SQLite link:', currentSessionId.substring(0, 8) + '...', '→ parent:', parentId.substring(0, 8) + '...');
          sessionBoundaries.push({
            childSessionId: currentSessionId,
            parentSessionId: parentId,
          });
          currentSessionId = parentId;
          depth++;
          continue;
        }
      } catch (e) {}
      break;
    }

    depth++;
  }

  return { mergedMap, lastRecord, sessionBoundaries, progressEntries: allProgressEntries };
}

// Find the latest (tip) session in a chain starting from a given session.
// Walks FORWARD: looks for any JSONL file whose first entry bridges FROM this session.
function resolveLatestSessionInChain(sessionId, cwd) {
  const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');
  let currentId = sessionId;
  const visited = new Set();

  while (!visited.has(currentId)) {
    visited.add(currentId);

    // Look for a child file that bridges from currentId
    const found = findSessionFile(currentId, cwd);
    if (!found) break;

    // Scan project dir for files that reference currentId as bridge
    let childId = null;
    try {
      const files = fs.readdirSync(found.projectDir);
      const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;
      for (const f of files) {
        if (!uuidPattern.test(f)) continue;
        const fId = f.replace('.jsonl', '');
        if (fId === currentId || visited.has(fId)) continue;

        // Read just the first line to check for bridge
        const fPath = path.join(found.projectDir, f);
        const fd = fs.openSync(fPath, 'r');
        const buf = Buffer.alloc(2048);
        const bytesRead = fs.readSync(fd, buf, 0, 2048, 0);
        fs.closeSync(fd);

        const firstLine = buf.toString('utf-8', 0, bytesRead).split('\n')[0];
        try {
          const entry = JSON.parse(firstLine);
          if (entry.sessionId === currentId && entry.uuid) {
            // This file bridges from currentId
            childId = fId;
            break;
          }
        } catch {}
      }
    } catch {}

    if (childId) {
      // SessionChain child found silently
      currentId = childId;
    } else {
      // No JSONL bridge child — check SQLite for session link (Clear Context without bridge entry)
      try {
        const sqliteChild = projectManager.db.getSessionChild(currentId);
        if (sqliteChild && !visited.has(sqliteChild)) {
          console.log('[SessionChain] SQLite forward link:', currentId.substring(0, 8) + '...', '→ child:', sqliteChild.substring(0, 8) + '...');
          currentId = sqliteChild;
          continue;
        }
      } catch (e) {}
      break; // No child found, currentId is the tip
    }
  }

  return currentId;
}

// ========== TIMELINE PARSER FUNCTION ==========
// Shared function to parse Timeline entries from JSONL file using Backtrace algorithm
// Returns array of entry UUIDs in display order (for fork marker snapshot)
function parseTimelineUuids(sourcePath) {
  try {
    const content = fs.readFileSync(sourcePath, 'utf-8');
    const lines = content.trim().split('\n').filter(line => line.trim());

    const recordMap = new Map();
    let lastRecord = null;
    let fileIndex = 0;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.uuid) {
          entry._fileIndex = fileIndex++;
          recordMap.set(entry.uuid, entry);
          lastRecord = entry;
        }
      } catch {}
    }

    if (!lastRecord) return [];

    // BACKTRACE: Walk backwards from last record following parentUuid
    const activeBranch = [];
    let currentUuid = lastRecord.uuid;
    const seen = new Set();

    while (currentUuid && !seen.has(currentUuid)) {
      seen.add(currentUuid);
      const record = recordMap.get(currentUuid);
      if (!record) {
        // Recovery: dangling logicalParentUuid from compact_boundary
        let recovered = false;
        if (activeBranch.length > 0) {
          const lastAdded = activeBranch[0];
          if (lastAdded.type === 'system' && lastAdded.subtype === 'compact_boundary' &&
              lastAdded.logicalParentUuid === currentUuid) {
            if (lastAdded.parentUuid && recordMap.has(lastAdded.parentUuid) && !seen.has(lastAdded.parentUuid)) {
              currentUuid = lastAdded.parentUuid;
              recovered = true;
            } else {
              let bestPred = null;
              for (const [uuid, entry] of recordMap) {
                if (seen.has(uuid)) continue;
                if (entry._fileIndex < lastAdded._fileIndex) {
                  if (!bestPred || entry._fileIndex > bestPred._fileIndex) {
                    bestPred = entry;
                  }
                }
              }
              if (bestPred) {
                currentUuid = bestPred.uuid;
                recovered = true;
              }
            }
          }
        }
        if (recovered) continue;
        break;
      }
      activeBranch.unshift(record);
      currentUuid = record.logicalParentUuid || record.parentUuid;
    }

    // Filter for Timeline display (same logic as get-timeline handler)
    const uuids = [];
    for (const entry of activeBranch) {
      if (entry.isSidechain || entry.type === 'summary') continue;

      if (entry.type === 'user') {
        let rawContent = entry.message?.content;
        if (Array.isArray(rawContent)) {
          if (rawContent.some(item => item.type === 'tool_result')) continue;
          const textBlock = rawContent.find(item => item.type === 'text' && item.text);
          rawContent = textBlock?.text || null;
        }
        if (!rawContent || typeof rawContent !== 'string') continue;
        if (entry.isMeta) continue;
        if (rawContent.includes('<command-name>') ||
            rawContent.includes('<system-reminder>') ||
            rawContent.includes('<task-notification>') ||
            rawContent.startsWith('[Request interrupted')) continue;

        uuids.push(entry.uuid);
      } else if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
        uuids.push(entry.uuid);
      }
    }

    return uuids;
  } catch (e) {
    console.error('[parseTimelineUuids] Error:', e.message);
    return [];
  }
}

// Fork Claude session: copy .jsonl file with new UUID, signal renderer to create new tab (legacy)
// Fork Claude session file: copy .jsonl with new UUID
// Searches ALL project directories under ~/.claude/projects/ to find the session file
ipcMain.handle('claude:fork-session-file', async (event, { sourceSessionId, cwd }) => {
  console.log('[Claude Fork] ========================================');
  console.log('[Claude Fork] Requested source session:', sourceSessionId);
  console.log('[Claude Fork] Current cwd:', cwd);

  try {
    // Resolve the LATEST session in the chain (in case "Clear Context" created child sessions)
    const resolvedSourceId = resolveLatestSessionInChain(sourceSessionId, cwd);
    if (resolvedSourceId !== sourceSessionId) {
      console.log('[Claude Fork] Chain resolved: ', sourceSessionId, '→', resolvedSourceId);
    }

    // Find the resolved source file
    const found = findSessionFile(resolvedSourceId, cwd);
    if (!found) {
      console.error('[Claude Fork] ✗ Source file not found for:', resolvedSourceId);
      return { success: false, error: 'Session file not found: ' + resolvedSourceId };
    }

    const sourcePath = found.filePath;
    const projectDir = found.projectDir;
    console.log('[Claude Fork] Source file:', sourcePath);

    // Check source file is not empty
    const stats = fs.statSync(sourcePath);
    if (stats.size === 0) {
      console.error('[Claude Fork] Source file is empty:', sourcePath);
      return { success: false, error: 'Source session is empty' };
    }

    // Generate new UUID
    const newSessionId = crypto.randomUUID();
    console.log('[Claude Fork] New session ID:', newSessionId);

    const destPath = path.join(projectDir, `${newSessionId}.jsonl`);

    // Get Timeline UUIDs snapshot using Backtrace algorithm (same as Timeline UI)
    const entryUuids = parseTimelineUuids(sourcePath);
    console.log('[Claude Fork] Timeline entries:', entryUuids.length);

    // Copy the file
    fs.copyFileSync(sourcePath, destPath);
    console.log('[Claude Fork] Copied:', sourcePath, '->', destPath);

    // Save fork marker with UUIDs snapshot (always save, even if empty — marks fork at beginning)
    try {
      projectManager.db.saveForkMarker(resolvedSourceId, newSessionId, entryUuids);
      console.log('[Claude Fork] Fork marker saved with', entryUuids.length, 'UUIDs');
    } catch (e) {
      console.warn('[Claude Fork] Could not save fork marker:', e.message);
    }

    // Wait for Claude to index the new file
    await new Promise(resolve => setTimeout(resolve, 500));

    return { success: true, newSessionId, forkEntryCount: entryUuids.length };
  } catch (error) {
    console.error('[Claude Fork] Error:', error);
    return { success: false, error: error.message };
  }
});

// Get fork markers for a session (for Timeline blue lines)
ipcMain.handle('claude:get-fork-markers', async (event, { sessionId }) => {
  if (!sessionId) return { success: false, error: 'No session ID', markers: [] };
  try {
    const markers = projectManager.db.getForkMarkers(sessionId);
    return { success: true, markers };
  } catch (error) {
    console.error('[Fork Markers] Error:', error);
    return { success: false, error: error.message, markers: [] };
  }
});

// Get Claude session timeline for navigation
// Reads JSONL file and returns filtered entries for Timeline component
// Uses BACKTRACE algorithm to handle Escape/Undo branches correctly
ipcMain.handle('claude:get-timeline', async (event, { sessionId, cwd }) => {

  if (!sessionId) {
    return { success: false, error: 'No session ID provided' };
  }

  try {
    // Resolve the full session chain (follows bridge entries across "Clear Context" boundaries)
    const { mergedMap: recordMap, lastRecord, sessionBoundaries } = resolveSessionChain(sessionId, cwd);

    if (!lastRecord) {
      return { success: true, entries: [] };
    }

    // BACKTRACE: Walk backwards from the last record following parentUuid
    // Now works across file boundaries thanks to merged recordMap
    const activeBranch = [];
    let currentUuid = lastRecord.uuid;
    const seen = new Set();

    while (currentUuid && !seen.has(currentUuid)) {
      seen.add(currentUuid);
      const record = recordMap.get(currentUuid);
      if (!record) {
        // Recovery: dangling logicalParentUuid from compact_boundary
        // The compact removed the referenced entry but pre-compact entries still exist in the file
        let recovered = false;
        if (activeBranch.length > 0) {
          const lastAdded = activeBranch[0];
          if (lastAdded.type === 'system' && lastAdded.subtype === 'compact_boundary' &&
              lastAdded.logicalParentUuid === currentUuid) {
            // Option 1: try parentUuid of the compact_boundary
            if (lastAdded.parentUuid && recordMap.has(lastAdded.parentUuid) && !seen.has(lastAdded.parentUuid)) {
              currentUuid = lastAdded.parentUuid;
              recovered = true;
            } else {
              // Option 2: find physical predecessor in the same JSONL file
              let bestPred = null;
              for (const [uuid, entry] of recordMap) {
                if (seen.has(uuid)) continue;
                if (entry._fromFile === lastAdded._fromFile &&
                    entry._fileIndex < lastAdded._fileIndex) {
                  if (!bestPred || entry._fileIndex > bestPred._fileIndex) {
                    bestPred = entry;
                  }
                }
              }
              if (bestPred) {
                currentUuid = bestPred.uuid;
                recovered = true;
              }
            }
          }
        }
        if (recovered) continue;
        break;
      }

      activeBranch.unshift(record);

      // Move to parent (use logicalParentUuid for compact boundaries, else parentUuid)
      let nextUuid = record.logicalParentUuid || record.parentUuid;

      // If we hit the root (parentUuid=null), check for bridge entry to parent session.
      // Bridge entry has a DIFFERENT sessionId and its parentUuid points into the parent file.
      // We need to follow the bridge to continue backtrace into the parent chain.
      if (!nextUuid && sessionBoundaries.length > 0) {
        // Method 1: Find JSONL bridge entry (classic Clear Context with bridge)
        for (const [uuid, entry] of recordMap) {
          if (seen.has(uuid)) continue;
          if (entry._isBridge && entry.parentUuid && entry.sessionId !== record.sessionId &&
              !seen.has(entry.parentUuid)) {
            nextUuid = entry.parentUuid;
            break;
          }
        }

        // Method 2: SQLite session link fallback (Clear Context without JSONL bridge)
        // When no _isBridge entry exists, use sessionBoundaries to find the parent session's last record
        if (!nextUuid && record.sessionId) {
          const boundary = sessionBoundaries.find(b => b.childSessionId === record.sessionId);
          if (boundary) {
            // Find the last record (by _fileIndex) in the parent session
            let parentLastRecord = null;
            for (const [uuid, entry] of recordMap) {
              if (seen.has(uuid)) continue;
              if (entry._fromFile === boundary.parentSessionId) {
                if (!parentLastRecord || entry._fileIndex > parentLastRecord._fileIndex) {
                  parentLastRecord = entry;
                }
              }
            }
            if (parentLastRecord) {
              nextUuid = parentLastRecord.uuid;
              console.log('[Backtrace] SQLite bridge:', record.sessionId.substring(0, 8), '→ parent last record:', parentLastRecord.uuid.substring(0, 8));
            }
          }
        }
      }

      currentUuid = nextUuid;
    }

    // Now filter the active branch for Timeline display
    const entries = [];
    let skippedSidechain = 0, skippedSummary = 0, skippedToolResult = 0, skippedNoContent = 0, skippedSystem = 0;
    for (const entry of activeBranch) {
      // Skip sidechain entries (internal Claude operations)
      if (entry.isSidechain) { skippedSidechain++; continue; }

      // Skip summary type (internal)
      if (entry.type === 'summary') { skippedSummary++; continue; }

      // Include: user messages, compact boundaries
      if (entry.type === 'user') {
        // Normalize content - can be string or array of objects
        let rawContent = entry.message?.content;

        // Skip tool_result entries - these are automatic, not user input
        if (Array.isArray(rawContent)) {
          const hasToolResult = rawContent.some(item => item.type === 'tool_result');
          if (hasToolResult) {
            skippedToolResult++;
            continue;
          }
          // Find first text block for other array types
          const textBlock = rawContent.find(item => item.type === 'text' && item.text);
          rawContent = textBlock?.text || null;
        }

        // Skip if no valid content
        if (!rawContent || typeof rawContent !== 'string') {
          skippedNoContent++;
          continue;
        }

        // Skip system messages that look like user messages
        if (rawContent === '[Request interrupted by user]' ||
            rawContent.startsWith('[Request interrupted') ||
            rawContent === '[User cancelled]') {
          skippedSystem++;
          continue;
        }

        // Skip meta messages (isMeta: true) - these are Claude internal markers
        if (entry.isMeta) {
          skippedSystem++;
          continue;
        }

        // Skip local command artifacts - these appear after /compact and other slash commands
        if (rawContent.includes('<command-name>') ||
            rawContent.includes('<command-message>') ||
            rawContent.includes('<command-args>') ||
            rawContent.includes('<local-command-stdout>') ||
            rawContent.includes('<local-command-stderr>') ||
            rawContent.includes('<bash-notification>') ||
            rawContent.includes('<shell-id>') ||
            rawContent.includes('<user-prompt-submit-hook>') ||
            rawContent.includes('<task-notification>') ||
            rawContent.startsWith('Caveat: The messages below')) {
          skippedSystem++;
          continue;
        }

        // Strip <system-reminder>...</system-reminder> blocks injected by Claude Code
        // These appear in user messages but don't represent actual user input
        // Strip them first, then check if real content remains
        let cleanContent = rawContent
          .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
          .replace(/\[200~/g, '')
          .replace(/~\]/g, '')
          .trim();

        // Skip if content became empty after cleanup
        if (!cleanContent) {
          continue;
        }

        // Detect "continued session" summary (context overflow recovery)
        const isContinued = cleanContent.startsWith('This session is being continued from a previous conversation');

        entries.push({
          uuid: entry.uuid,
          type: isContinued ? 'continued' : 'user',
          timestamp: entry.timestamp,
          content: cleanContent,
          isCompactSummary: entry.isCompactSummary || false,
          sessionId: entry.sessionId || entry._fromFile,
          isPlan: !!entry.planContent
        });
      } else if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
        entries.push({
          uuid: entry.uuid,
          type: 'compact',
          timestamp: entry.timestamp,
          content: 'Conversation compacted',
          preTokens: entry.compactMetadata?.preTokens,
          sessionId: entry.sessionId || entry._fromFile
        });
      }
    }

    // Resolve the latest session ID in the chain (tip)
    // This helps the renderer detect if claudeSessionId needs updating
    const latestSessionId = resolveLatestSessionInChain(sessionId, cwd);

    return { success: true, entries, latestSessionId, sessionBoundaries };

  } catch (error) {
    console.error('[Claude Timeline] Error:', error);
    return { success: false, error: error.message };
  }
});

// Export Claude session as clean text (with options and backtrace)
ipcMain.handle('claude:export-clean-session', async (event, { sessionId, cwd, includeEditing = false, includeReading = false, includeCode, fromStart = true, includeSubagentResult = false, includeSubagentHistory = false }) => {
  // Backward compat: old callers may pass includeCode
  if (includeCode !== undefined && includeEditing === undefined) {
    includeEditing = includeCode;
    includeReading = includeCode;
  }
  console.log('[Claude Export] ========================================');
  console.log('[Claude Export] Exporting session:', sessionId);
  console.log('[Claude Export] Options:', { includeEditing, includeReading, fromStart, includeSubagentResult, includeSubagentHistory, cwd });

  if (!sessionId) {
    return { success: false, error: 'No session ID provided' };
  }

  try {
    // Resolve the full session chain (follows bridge entries across "Clear Context" boundaries)
    // Same as Timeline — loads all JSONL files in the chain and merges records
    const { mergedMap: recordMap, lastRecord, sessionBoundaries, progressEntries: allProgressEntries } = resolveSessionChain(sessionId, cwd);

    console.log('[Claude Export] Merged records:', recordMap.size, '| Chain depth:', sessionBoundaries.length + 1, '| Progress entries:', allProgressEntries.length);
    console.log('[Claude Export] Last record type:', lastRecord?.type);

    if (!lastRecord) {
      console.log('[Claude Export] Empty session - no records with UUID');
      return { success: true, content: '# Empty session' };
    }

    // BACKTRACE: Walk backwards from the last record following parentUuid
    // Same logic as Timeline — follows bridge entries across file boundaries
    const activeBranch = [];
    let currentUuid = lastRecord.uuid;
    const seen = new Set();

    while (currentUuid && !seen.has(currentUuid)) {
      seen.add(currentUuid);
      const record = recordMap.get(currentUuid);
      if (!record) {
        // Recovery: dangling logicalParentUuid from compact_boundary
        let recovered = false;
        if (activeBranch.length > 0) {
          const lastAdded = activeBranch[0];
          if (lastAdded.type === 'system' && lastAdded.subtype === 'compact_boundary' &&
              lastAdded.logicalParentUuid === currentUuid) {
            console.log('[Claude Export] Dangling logicalParentUuid:', currentUuid.slice(0, 12), '- recovering');
            if (lastAdded.parentUuid && recordMap.has(lastAdded.parentUuid) && !seen.has(lastAdded.parentUuid)) {
              currentUuid = lastAdded.parentUuid;
              recovered = true;
              console.log('[Claude Export] Recovered via parentUuid:', currentUuid.slice(0, 12));
            } else {
              let bestPred = null;
              for (const [uuid, entry] of recordMap) {
                if (seen.has(uuid)) continue;
                if (entry._fromFile === lastAdded._fromFile &&
                    entry._fileIndex < lastAdded._fileIndex) {
                  if (!bestPred || entry._fileIndex > bestPred._fileIndex) {
                    bestPred = entry;
                  }
                }
              }
              if (bestPred) {
                currentUuid = bestPred.uuid;
                recovered = true;
                console.log('[Claude Export] Recovered via physical predecessor:', currentUuid.slice(0, 12));
              }
            }
          }
        }
        if (recovered) continue;
        console.log('[Claude Export] Backtrace ended - UUID not found:', currentUuid);
        break;
      }

      activeBranch.unshift(record);

      let nextUuid = record.logicalParentUuid || record.parentUuid;

      // If we hit the root (parentUuid=null), check for bridge entry to parent session
      // Only follow bridges whose target has not been visited yet (prevents cycling)
      if (!nextUuid && sessionBoundaries.length > 0) {
        for (const [uuid, entry] of recordMap) {
          if (seen.has(uuid)) continue;
          if (entry._isBridge && entry.parentUuid && entry.sessionId !== record.sessionId &&
              !seen.has(entry.parentUuid)) {
            console.log('[Claude Export] Following bridge:', uuid.slice(0, 12), '\u2192 parent:', entry.parentUuid?.slice(0, 12));
            nextUuid = entry.parentUuid;
            break;
          }
        }
        if (!nextUuid && record.sessionId) {
          const boundary = sessionBoundaries.find(b => b.childSessionId === record.sessionId);
          if (boundary) {
            let parentLast = null;
            for (const [uuid, entry] of recordMap) {
              if (seen.has(uuid)) continue;
              if (entry._fromFile === boundary.parentSessionId) {
                if (!parentLast || entry._fileIndex > parentLast._fileIndex) parentLast = entry;
              }
            }
            if (parentLast) nextUuid = parentLast.uuid;
          }
        }
      }

      currentUuid = nextUuid;
    }

    console.log('[Claude Export] Backtrace complete, active branch size:', activeBranch.length);

    // Debug: log sessionId distribution in activeBranch
    const sidCounts = {};
    for (const entry of activeBranch) {
      const sid = (entry.sessionId || 'NO-SID').slice(0, 8);
      sidCounts[sid] = (sidCounts[sid] || 0) + 1;
    }
    console.log('[Claude Export] SessionId distribution:', JSON.stringify(sidCounts));

    // 3. FORK MARKERS: Precompute which UUIDs are fork boundaries
    // Helper: check if a record is a Timeline-eligible entry (user message or compact boundary)
    const isTimelineEntry = (rec) => {
      if (rec.type === 'system' && rec.subtype === 'compact_boundary') return true;
      if (rec.type !== 'user') return false;
      if (rec.isSidechain || rec.isMeta) return false;
      const content = rec.message?.content;
      if (Array.isArray(content) && content.some(item => item.type === 'tool_result')) return false;
      return true;
    };

    const forkBoundaryUuids = new Set();
    let hasForkAtBeginning = false; // Fork with empty snapshot = fork before any entries
    let forkMarkers = [];
    try {
      forkMarkers = projectManager.db.getForkMarkers(sessionId);
      console.log('[Claude Export] Fork markers found:', forkMarkers.length);
      for (const marker of forkMarkers) {
        const snapshotSet = new Set(marker.entry_uuids || []);
        if (snapshotSet.size === 0) {
          hasForkAtBeginning = true;
          continue;
        }
        // Find boundary: last Timeline-eligible entry in snapshot where next Timeline-eligible entry is NOT in snapshot
        for (let idx = 0; idx < activeBranch.length; idx++) {
          const rec = activeBranch[idx];
          if (!snapshotSet.has(rec.uuid)) continue;
          let nextTimelineEntry = null;
          for (let j = idx + 1; j < activeBranch.length; j++) {
            if (isTimelineEntry(activeBranch[j])) {
              nextTimelineEntry = activeBranch[j];
              break;
            }
          }
          if (!nextTimelineEntry) {
            forkBoundaryUuids.add(rec.uuid);
          } else if (!snapshotSet.has(nextTimelineEntry.uuid)) {
            forkBoundaryUuids.add(rec.uuid);
          }
        }
      }
      console.log('[Claude Export] Fork boundary UUIDs:', forkBoundaryUuids.size, 'hasForkAtBeginning:', hasForkAtBeginning);
    } catch (e) {
      console.warn('[Claude Export] Could not load fork markers:', e.message);
    }

    // 4. fromStart=false: trim activeBranch to start from the last fork boundary
    if (!fromStart && forkBoundaryUuids.size > 0) {
      let lastForkIdx = -1;
      for (let i = activeBranch.length - 1; i >= 0; i--) {
        if (forkBoundaryUuids.has(activeBranch[i].uuid)) {
          lastForkIdx = i;
          break;
        }
      }
      if (lastForkIdx >= 0) {
        const trimmedUuid = activeBranch[lastForkIdx].uuid;
        activeBranch.splice(0, lastForkIdx + 1);
        forkBoundaryUuids.delete(trimmedUuid);
        hasForkAtBeginning = true; // Show FORK separator at the beginning of trimmed output
        console.log('[Claude Export] Trimmed to fork boundary, remaining entries:', activeBranch.length);
      }
    }

    // Build session tree segments from sessionId boundaries in activeBranch
    // This captures BOTH fork transitions and clear-context transitions
    const treeSegments = [];
    let currentTreeSid = null;

    for (let i = 0; i < activeBranch.length; i++) {
      const entry = activeBranch[i];
      const entrySid = entry.sessionId || 'unknown';

      if (entrySid !== currentTreeSid) {
        currentTreeSid = entrySid;
        treeSegments.push({
          startIdx: i,
          endIdx: i,
          sessionLabel: entrySid.slice(0, 8),
          fullSessionId: entrySid,
        });
      }
      // Update endIdx of current segment
      if (treeSegments.length > 0) {
        treeSegments[treeSegments.length - 1].endIdx = i;
      }
    }

    // Determine segment types using bridge entries from recordMap
    // Bridge entry (_isBridge=true) with sessionId matching PREVIOUS segment = clear-context/plan mode
    // No matching bridge = fork (entries were copied, not bridged)
    for (let i = 0; i < treeSegments.length; i++) {
      const seg = treeSegments[i];

      if (i === 0) {
        seg.type = 'root';
      } else {
        // Check if a bridge entry exists with sessionId matching the previous segment
        // This means the transition was a clear-context (plan mode)
        let hasBridge = false;
        for (const [, entry] of recordMap) {
          if (entry._isBridge && entry.sessionId === treeSegments[i - 1].fullSessionId) {
            hasBridge = true;
            break;
          }
        }
        seg.type = hasBridge ? 'clear-context' : 'fork';
      }
    }

    // If the current export session has no entries in activeBranch, add it as final segment
    // This happens when a fork was just created and Claude hasn't written new entries yet
    const lastSeg = treeSegments[treeSegments.length - 1];
    if (lastSeg.fullSessionId !== sessionId) {
      // Determine type: check fork markers (source = last segment = fork) or session boundary
      const isForkFromLast = forkMarkers.some(m => m.source_session_id === lastSeg.fullSessionId);
      treeSegments.push({
        startIdx: activeBranch.length,
        endIdx: activeBranch.length - 1,
        sessionLabel: sessionId.slice(0, 8),
        fullSessionId: sessionId,
        type: isForkFromLast ? 'fork' : 'clear-context',
        messages: 0, compacts: 0,
      });
    }

    // Mark current session
    for (let i = 0; i < treeSegments.length; i++) {
      treeSegments[i].isCurrent = i === treeSegments.length - 1;
    }

    // Compute per-segment stats
    for (const seg of treeSegments) {
      let messages = 0, compacts = 0;
      for (let i = seg.startIdx; i <= seg.endIdx && i < activeBranch.length; i++) {
        const entry = activeBranch[i];
        if (entry.isSidechain) continue;
        if (entry.type === 'user') {
          const c = entry.message?.content;
          if (Array.isArray(c) && c.some(item => item.type === 'tool_result')) continue;
          if (typeof c === 'string' && (c.startsWith('[Request interrupted') || c.includes('<command-name>'))) continue;
          messages++;
        } else if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
          compacts++;
        }
      }
      seg.messages = messages;
      seg.compacts = compacts;
    }

    console.log('[Claude Export] Tree segments:', treeSegments.length, treeSegments.map(s => `${s.sessionLabel}(${s.type})`).join(' → '));

    const outputParts = [];
    outputParts.push(`# Claude Session Export`);
    outputParts.push(`Session: ${sessionId}`);
    outputParts.push(`CWD: ${cwd || 'unknown'}`);
    outputParts.push('');

    // Render hierarchical session tree
    outputParts.push('Session Tree:');
    for (let i = 0; i < treeSegments.length; i++) {
      const seg = treeSegments[i];
      const depth = i;
      const indent = depth > 0 ? '    '.repeat(depth - 1) + '\u2514\u2500\u2500 ' : '';

      let tag = '';
      if (seg.type === 'root' && treeSegments.length > 1) tag = ' (root)';
      else if (seg.type === 'clear-context') tag = ' (plan mode)';
      else if (seg.type === 'fork') tag = ' (fork)';
      if (seg.isCurrent && treeSegments.length > 1) tag += ' *';

      const stats = [];
      if (seg.compacts > 0) stats.push(`\u267B\uFE0F \u00D7${seg.compacts}`);
      if (seg.messages > 0) stats.push(`${seg.messages} message${seg.messages !== 1 ? 's' : ''}`);

      const statsStr = stats.length > 0 ? ` \u2014 ${stats.join(', ')}` : '';
      outputParts.push(`${indent}${seg.sessionLabel}${tag}${statsStr}`);
    }
    outputParts.push('');
    outputParts.push(`Markers:`);
    outputParts.push(`  \uD83D\uDD35 FORK  \u2014 session branched (search "FORK")`);
    outputParts.push(`  \u2550\u2550\u2550 COMPACTED \u2550\u2550\u2550 \u2014 context window compacted (search "COMPACTED")`);
    outputParts.push('');

    // Insert FORK separator at the beginning if fork was before any entries or trimmed
    if (hasForkAtBeginning) {
      outputParts.push('');
      outputParts.push('🔵═══════════════════════════════ FORK ═══════════════════════════════🔵');
      outputParts.push('');
    }

    // Build progress entries index by parentToolUseID for fast lookup
    const progressByToolUseId = new Map();
    for (const pe of allProgressEntries) {
      const key = pe.parentToolUseID;
      if (!progressByToolUseId.has(key)) progressByToolUseId.set(key, []);
      progressByToolUseId.get(key).push(pe);
    }

    // Delegate to shared formatToolAction with current session's settings
    const formatTool = (toolName, input, toolResult = null, toolUseId = null) => {
      const taskProgress = toolName === 'Task' && toolUseId ? (progressByToolUseId.get(toolUseId) || []) : [];
      return formatToolAction(toolName, input, toolResult, includeEditing, includeReading, {
        includeSubagentResult, includeSubagentHistory, progressEntries: taskProgress
      });
    };

    // Process the active branch
    for (let i = 0; i < activeBranch.length; i++) {
      const entry = activeBranch[i];

      if (entry.isSidechain || entry.type === 'summary') continue;

      if (entry.type === 'user') {
        let rawContent = entry.message?.content;

        // tool_result entries are stored as user messages in JSONL
        if (Array.isArray(rawContent) && rawContent.some(item => item.type === 'tool_result')) {
          // If we are including code, these are handled by matching them to tool_use in formatToolAction
          // or we can list them here. But cleaner to ignore them if they are just results of previous assistant tools.
          continue;
        }

        if (typeof rawContent !== 'string') {
          if (Array.isArray(rawContent)) {
            rawContent = rawContent.find(item => item.type === 'text')?.text || null;
          } else {
            rawContent = null;
          }
        }

        if (!rawContent) continue;

        // Skip system-like messages
        if (rawContent.startsWith('[Request interrupted') || rawContent === '[User cancelled]') continue;
        if (rawContent.includes('<command-name>') || rawContent.includes('<local-command-stdout>')) continue;

        let cleanContent = rawContent.replace(/\[200~/g, '').replace(/~\]/g, '').trim();
        if (!cleanContent) continue;

        outputParts.push('---');
        outputParts.push('');
        outputParts.push('👤 USER:');
        outputParts.push(cleanContent);
        outputParts.push('');
      }

      else if (entry.type === 'assistant') {
        const msgContent = entry.message?.content;
        if (!msgContent) continue;

        let textContent = '';
        const toolActions = [];

        if (typeof msgContent === 'string') {
          textContent = msgContent;
        } else if (Array.isArray(msgContent)) {
          const textParts = [];
          for (const block of msgContent) {
            if (block.type === 'thinking' && block.thinking) {
              textParts.push(`<thinking>\n${block.thinking}\n</thinking>`);
            }
            if (block.type === 'text' && block.text) {
              textParts.push(block.text);
            }
            if (block.type === 'tool_use') {
              // Find matching tool_result in subsequent records
              let toolResult = null;
              const needResult = includeEditing || includeReading || (block.name === 'Task' && includeSubagentResult);
              if (needResult) {
                for (let j = i + 1; j < activeBranch.length; j++) {
                  const nextEntry = activeBranch[j];
                  if (nextEntry.type === 'user' && Array.isArray(nextEntry.message?.content)) {
                    const res = nextEntry.message.content.find(c => c.type === 'tool_result' && c.tool_use_id === block.id);
                    if (res) {
                      toolResult = res;
                      break;
                    }
                  }
                }
              }
              const action = formatTool(block.name, block.input || {}, toolResult, block.id);
              if (action) toolActions.push(action);
            }
          }
          textContent = textParts.join('\n\n');
        }

        if (textContent.trim() || toolActions.length > 0) {
          outputParts.push('🤖 CLAUDE:');
          if (textContent.trim()) outputParts.push(textContent);
          if (toolActions.length > 0) {
            if (includeEditing || includeReading) {
              outputParts.push('\n**Actions:**\n' + toolActions.join('\n\n'));
            } else {
              outputParts.push(`   [Действия: ${toolActions.join(', ')}]`);
            }
          }
          outputParts.push('');
        }
      }

      else if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
        outputParts.push('');
        outputParts.push('═══ COMPACTED ═══');
        outputParts.push('');
      }

      // Insert fork separator after boundary entries
      if (forkBoundaryUuids.has(entry.uuid)) {
        outputParts.push('');
        outputParts.push('🔵═══════════════════════════════ FORK ═══════════════════════════════🔵');
        outputParts.push('');
      }
    }

    const finalContent = outputParts.join('\n');
    console.log('[Claude Export] Export complete:', {
      outputLines: outputParts.length,
      totalLength: finalContent.length,
      preview: finalContent.substring(0, 200) + '...'
    });
    console.log('[Claude Export] ========================================');

    return { success: true, content: finalContent };

  } catch (error) {
    console.error('[Claude Export] Error:', error);
    console.error('[Claude Export] Stack:', error.stack);
    return { success: false, error: error.message };
  }
});

// Get full chat history for History Panel (structured entries, not markdown)
ipcMain.handle('claude:get-full-history', async (event, { sessionId, cwd }) => {
  if (!sessionId) {
    return { success: false, error: 'No session ID provided' };
  }

  try {
    const { mergedMap: recordMap, lastRecord, sessionBoundaries, progressEntries: allProgressEntries } = resolveSessionChain(sessionId, cwd);

    // Build progress entries index by parentToolUseID
    const progressByToolUseId = new Map();
    for (const pe of allProgressEntries) {
      const key = pe.parentToolUseID;
      if (!progressByToolUseId.has(key)) progressByToolUseId.set(key, []);
      progressByToolUseId.get(key).push(pe);
    }

    if (!lastRecord) {
      return { success: true, entries: [], latestSessionId: sessionId };
    }

    // BACKTRACE: Walk backwards from the last record following parentUuid
    const activeBranch = [];
    let currentUuid = lastRecord.uuid;
    const seen = new Set();

    while (currentUuid && !seen.has(currentUuid)) {
      seen.add(currentUuid);
      const record = recordMap.get(currentUuid);
      if (!record) {
        let recovered = false;
        if (activeBranch.length > 0) {
          const lastAdded = activeBranch[0];
          if (lastAdded.type === 'system' && lastAdded.subtype === 'compact_boundary' &&
              lastAdded.logicalParentUuid === currentUuid) {
            if (lastAdded.parentUuid && recordMap.has(lastAdded.parentUuid) && !seen.has(lastAdded.parentUuid)) {
              currentUuid = lastAdded.parentUuid;
              recovered = true;
            } else {
              let bestPred = null;
              for (const [uuid, entry] of recordMap) {
                if (seen.has(uuid)) continue;
                if (entry._fromFile === lastAdded._fromFile &&
                    entry._fileIndex < lastAdded._fileIndex) {
                  if (!bestPred || entry._fileIndex > bestPred._fileIndex) {
                    bestPred = entry;
                  }
                }
              }
              if (bestPred) {
                currentUuid = bestPred.uuid;
                recovered = true;
              }
            }
          }
        }
        if (recovered) continue;
        break;
      }

      activeBranch.unshift(record);

      let nextUuid = record.logicalParentUuid || record.parentUuid;
      if (!nextUuid && sessionBoundaries.length > 0) {
        for (const [uuid, entry] of recordMap) {
          if (seen.has(uuid)) continue;
          if (entry._isBridge && entry.parentUuid && entry.sessionId !== record.sessionId &&
              !seen.has(entry.parentUuid)) {
            nextUuid = entry.parentUuid;
            break;
          }
        }
        if (!nextUuid && record.sessionId) {
          const boundary = sessionBoundaries.find(b => b.childSessionId === record.sessionId);
          if (boundary) {
            let parentLast = null;
            for (const [uuid, entry] of recordMap) {
              if (seen.has(uuid)) continue;
              if (entry._fromFile === boundary.parentSessionId) {
                if (!parentLast || entry._fileIndex > parentLast._fileIndex) parentLast = entry;
              }
            }
            if (parentLast) nextUuid = parentLast.uuid;
          }
        }
      }

      currentUuid = nextUuid;
    }

    // Format tool action label (standalone, no includeCode dependency)
    const mkFileAction = (toolName, input) => {
      const base = { tool: toolName, filePath: input.file_path || '?' };
      if (toolName === 'Edit') {
        return { ...base, oldString: input.old_string || '', newString: input.new_string || '' };
      }
      if (toolName === 'Write') {
        const content = input.content || '';
        const lines = content.split('\n');
        return { ...base, content: lines.length > 100
          ? lines.slice(0, 100).join('\n') + '\n... (' + lines.length + ' lines total)'
          : content };
      }
      return base;
    };

    const fmtAction = (toolName, input, toolUseId = null) => {
      switch (toolName) {
        case 'Read': return { tool: 'Read', filePath: input.file_path || '?' };
        case 'Bash': {
          const cmd = (input.command || '').substring(0, 60);
          return '\u{1F5A5} ' + cmd + (input.command?.length > 60 ? '...' : '');
        }
        case 'Glob': return '\u{1F50D} glob ' + (input.pattern || '?');
        case 'Grep': return '\u{1F50D} grep ' + (input.pattern || '?');
        case 'Task': {
          const taskObj = {
            tool: 'Task',
            description: input.description || input.prompt?.substring(0, 60) || 'Task agent',
            toolUseId: toolUseId,
          };
          // Attach progress history from agent_progress entries
          const taskProgress = toolUseId ? (progressByToolUseId.get(toolUseId) || []) : [];
          if (taskProgress.length > 0) {
            taskObj.history = [];
            for (const pe of taskProgress) {
              const msg = pe.data?.message;
              if (!msg) continue;
              const turn = { type: msg.type };
              if (msg.type === 'user') {
                const c = msg.message?.content;
                turn.content = typeof c === 'string' ? c : Array.isArray(c)
                  ? c.filter(x => x.type === 'text').map(x => x.text).join(' ') : '';
              } else if (msg.type === 'assistant') {
                const mc = msg.message?.content;
                if (typeof mc === 'string') {
                  turn.content = mc;
                } else if (Array.isArray(mc)) {
                  turn.content = mc.filter(x => x.type === 'text').map(x => x.text).join('\n');
                  const tools = mc.filter(x => x.type === 'tool_use');
                  if (tools.length > 0) {
                    turn.tools = tools.map(t => {
                      if (t.name === 'Bash') return '\u{1F5A5} ' + (t.input?.command || '').substring(0, 80);
                      if (t.name === 'Read' || t.name === 'Edit' || t.name === 'Write') return '\u{1F4C4} ' + t.name + ' (' + (t.input?.file_path || '?') + ')';
                      return '\u{2699}\u{FE0F} ' + t.name;
                    });
                  }
                }
              }
              taskObj.history.push(turn);
            }
          }
          return taskObj;
        }
        case 'WebSearch': return '\u{1F310} WebSearch';
        case 'WebFetch': return '\u{1F310} WebFetch';
        default: return '\u{2699}\u{FE0F} ' + toolName;
      }
    };

    // Fork markers
    const forkBoundaryUuids = new Set();
    let hasForkAtBeginning = false;
    try {
      const forkMarkers = projectManager.db.getForkMarkers(sessionId);
      for (const marker of forkMarkers) {
        const snapshotSet = new Set(marker.entry_uuids || []);
        if (snapshotSet.size === 0) {
          hasForkAtBeginning = true;
          continue;
        }
        const isTimelineEntry = (rec) => {
          if (rec.type === 'system' && rec.subtype === 'compact_boundary') return true;
          if (rec.type !== 'user') return false;
          if (rec.isSidechain || rec.isMeta) return false;
          const content = rec.message?.content;
          if (Array.isArray(content) && content.some(item => item.type === 'tool_result')) return false;
          return true;
        };
        for (let idx = 0; idx < activeBranch.length; idx++) {
          const rec = activeBranch[idx];
          if (!snapshotSet.has(rec.uuid)) continue;
          let nextTE = null;
          for (let j = idx + 1; j < activeBranch.length; j++) {
            if (isTimelineEntry(activeBranch[j])) { nextTE = activeBranch[j]; break; }
          }
          if (!nextTE || !snapshotSet.has(nextTE.uuid)) {
            forkBoundaryUuids.add(rec.uuid);
          }
        }
      }
    } catch (e) {
      // Fork markers not available — that's OK
    }

    // Build structured entries
    const entries = [];
    let prevSessionId = null;

    if (hasForkAtBeginning) {
      entries.push({ uuid: 'fork-begin', role: 'fork', timestamp: '', content: 'FORK', sessionId: '' });
    }

    for (let i = 0; i < activeBranch.length; i++) {
      const entry = activeBranch[i];
      if (entry.isSidechain || entry.type === 'summary') continue;

      // Plan mode / clear context boundary detection
      const entrySid = entry.sessionId || entry._fromFile;
      if (prevSessionId && entrySid !== prevSessionId) {
        // Check if bridge-based transition (clear context) or fork
        let hasBridge = false;
        for (const [, rec] of recordMap) {
          if (rec._isBridge && rec.sessionId === prevSessionId) { hasBridge = true; break; }
        }
        entries.push({
          uuid: 'boundary-' + entry.uuid,
          role: hasBridge ? 'plan-mode' : 'fork',
          timestamp: entry.timestamp || '',
          content: hasBridge ? 'CLEAR CONTEXT' : 'FORK',
          sessionId: entrySid
        });
      }
      prevSessionId = entrySid;

      if (entry.type === 'user') {
        let rawContent = entry.message?.content;
        if (Array.isArray(rawContent) && rawContent.some(item => item.type === 'tool_result')) continue;
        if (typeof rawContent !== 'string') {
          if (Array.isArray(rawContent)) {
            rawContent = rawContent.find(item => item.type === 'text')?.text || null;
          } else {
            rawContent = null;
          }
        }
        if (!rawContent) continue;
        if (rawContent.startsWith('[Request interrupted') || rawContent === '[User cancelled]') continue;
        if (rawContent.includes('<command-name>') || rawContent.includes('<local-command-stdout>')) continue;
        if (rawContent.includes('<bash-notification>') || rawContent.includes('<shell-id>')) continue;
        if (rawContent.includes('<user-prompt-submit-hook>') || rawContent.includes('<task-notification>')) continue;
        if (rawContent.startsWith('Caveat: The messages below')) continue;
        if (entry.isMeta) continue;

        let cleanContent = rawContent
          .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
          .replace(/\[200~/g, '').replace(/~\]/g, '').trim();
        if (!cleanContent) continue;

        const isContinued = cleanContent.startsWith('This session is being continued from a previous conversation');

        entries.push({
          uuid: entry.uuid,
          role: isContinued ? 'continued' : 'user',
          timestamp: entry.timestamp || '',
          content: cleanContent,
          sessionId: entrySid
        });
      } else if (entry.type === 'assistant') {
        const msgContent = entry.message?.content;
        if (!msgContent) continue;

        let textContent = '';
        let thinking = '';
        const actions = [];

        if (typeof msgContent === 'string') {
          textContent = msgContent;
        } else if (Array.isArray(msgContent)) {
          const textParts = [];
          for (const block of msgContent) {
            if (block.type === 'thinking' && block.thinking) {
              thinking = block.thinking;
            }
            if (block.type === 'text' && block.text) {
              textParts.push(block.text);
            }
            if (block.type === 'tool_use') {
              const name = block.name;
              const input = block.input || {};
              if (name === 'Edit' || name === 'Write') {
                actions.push(mkFileAction(name, input));
              } else {
                const actionObj = fmtAction(name, input, block.id);
                // For Task: find tool_result to get final answer
                if (name === 'Task' && typeof actionObj === 'object' && actionObj.tool === 'Task') {
                  for (let j = i + 1; j < activeBranch.length; j++) {
                    const nextEntry = activeBranch[j];
                    if (nextEntry.type === 'user' && Array.isArray(nextEntry.message?.content)) {
                      const res = nextEntry.message.content.find(c => c.type === 'tool_result' && c.tool_use_id === block.id);
                      if (res) {
                        const resContent = res.content;
                        if (typeof resContent === 'string') {
                          actionObj.result = resContent;
                        } else if (Array.isArray(resContent)) {
                          actionObj.result = resContent.filter(c => c.type === 'text').map(c => c.text).join('\n');
                        }
                        break;
                      }
                    }
                  }
                }
                actions.push(actionObj);
              }
            }
          }
          textContent = textParts.join('\n\n');
        }

        if (textContent.trim() || actions.length > 0) {
          entries.push({
            uuid: entry.uuid,
            role: 'assistant',
            timestamp: entry.timestamp || '',
            content: textContent.trim(),
            thinking: thinking || undefined,
            actions: actions.length > 0 ? actions : undefined,
            sessionId: entrySid
          });
        }
      } else if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
        entries.push({
          uuid: entry.uuid,
          role: 'compact',
          timestamp: entry.timestamp || '',
          content: 'COMPACTED',
          sessionId: entrySid
        });
      }

      // Fork boundary after entry
      if (forkBoundaryUuids.has(entry.uuid)) {
        entries.push({
          uuid: 'fork-after-' + entry.uuid,
          role: 'fork',
          timestamp: '',
          content: 'FORK',
          sessionId: entrySid
        });
      }
    }

    const latestSessionId = resolveLatestSessionInChain(sessionId, cwd);

    return { success: true, entries, latestSessionId };
  } catch (error) {
    console.error('[Claude FullHistory] Error:', error);
    return { success: false, error: error.message };
  }
});

// Legacy fork handler (for new tab creation)
ipcMain.on('claude:fork-session', async (event, { tabId, existingSessionId, cwd }) => {
  console.log('[Claude Fork] Starting fork for tab:', tabId);
  console.log('[Claude Fork] Existing session:', existingSessionId);
  console.log('[Claude Fork] CWD:', cwd);

  try {
    // Generate new session ID
    const newSessionId = crypto.randomUUID();
    console.log('[Claude Fork] New session ID:', newSessionId);

    // Calculate project slug (Claude uses path with / replaced by -)
    const projectSlug = cwd.replace(/\//g, '-');
    const projectDir = path.join(os.homedir(), '.claude', 'projects', projectSlug);
    console.log('[Claude Fork] Project dir:', projectDir);

    // If we have an existing session, copy its file
    if (existingSessionId) {
      const oldPath = path.join(projectDir, `${existingSessionId}.jsonl`);
      const newPath = path.join(projectDir, `${newSessionId}.jsonl`);

      if (fs.existsSync(oldPath)) {
        fs.copyFileSync(oldPath, newPath);
        console.log('[Claude Fork] Copied session file:', oldPath, '->', newPath);
      } else {
        console.log('[Claude Fork] Source session file not found:', oldPath);
      }
    }

    // Send event to renderer to create new tab and run claude
    // Renderer will handle tab creation and command execution
    event.sender.send('claude:fork-complete', {
      success: true,
      newSessionId,
      cwd
    });
  } catch (error) {
    console.error('[Claude Fork] Error:', error);
    event.sender.send('claude:fork-complete', {
      success: false,
      error: error.message
    });
  }
});

// ========== CLAUDE COMMAND RUNNER (from UI buttons) ========== 
// This handles claude commands triggered from InfoPanel buttons
// bypassing the terminal input interception (which only works for keyboard Enter)
ipcMain.on('claude:run-command', (event, { tabId, command, sessionId, forkSessionId, prompt }) => {
  console.log('[Claude Runner] Command:', command, 'Tab:', tabId, 'Prompt:', prompt ? `${prompt.slice(0, 50)}...` : 'none');

  const term = terminals.get(tabId);
  if (!term) {
    console.error('[Claude Runner] Terminal not found for tab:', tabId);
    return;
  }

  // Get cwd for this terminal
  const cwd = terminalProjects.get(tabId);
  if (!cwd) {
    console.error('[Claude Runner] CWD not found for tab:', tabId);
    return;
  }

  switch (command) {
    case 'claude': {
      // New session — session ID will be detected by SessionBridge (via StatusLine)
      console.log('[Claude Runner] Starting new session for tab:', tabId);

      // Enable thinking mode detection (will send Tab when prompt appears)
      claudeState.set(tabId, 'WAITING_PROMPT');

      // If prompt provided, save it to send AFTER thinking mode is enabled
      if (prompt && prompt.trim()) {
        claudePendingPrompt.set(tabId, prompt.trim());
        console.log('[Claude Runner] Prompt saved, will send after thinking mode enabled');
      }

      // Always launch claude without prompt (prompt will be sent after Tab)
      term.write('claude --dangerously-skip-permissions\r');
      break;
    }

    case 'claude-c':
      // Continue session
      if (sessionId) {
        console.log('[Claude Runner] Continuing session:', sessionId);
        // Enable thinking mode detection (will send Tab when '>' prompt appears)
        claudeState.set(tabId, 'WAITING_PROMPT');
        term.write(`claude --dangerously-skip-permissions --resume ${sessionId}\r`);

        // Signal that command started (for Timeline visibility)
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('terminal:command-started', { tabId });
        }
      } else {
        console.error('[Claude Runner] No sessionId for claude-c');
      }
      break;

    case 'claude-f':
      // Fork session - copy file and signal renderer
      // IMPORTANT: Search ALL project directories because session might be from different project
      if (forkSessionId) {
        console.log('[Claude Runner] Forking session:', forkSessionId);

        const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');
        const forkProjectSlug = cwd.replace(/\//g, '-');
        const primaryDir = path.join(claudeProjectsDir, forkProjectSlug);
        const primaryPath = path.join(primaryDir, `${forkSessionId}.jsonl`);

        let sourcePath = null;
        let sourceDir = null;

        // First try primary location (cwd-based)
        if (fs.existsSync(primaryPath)) {
          sourcePath = primaryPath;
          sourceDir = primaryDir;
          console.log('[Claude Runner] Found in primary location:', sourcePath);
        } else {
          // Search ALL project directories
          console.log('[Claude Runner] Not in primary, searching all projects...');
          if (fs.existsSync(claudeProjectsDir)) {
            const projectDirs = fs.readdirSync(claudeProjectsDir, { withFileTypes: true })
              .filter(dirent => dirent.isDirectory())
              .map(dirent => dirent.name);

            for (const dir of projectDirs) {
              const checkPath = path.join(claudeProjectsDir, dir, `${forkSessionId}.jsonl`);
              if (fs.existsSync(checkPath)) {
                sourcePath = checkPath;
                sourceDir = path.join(claudeProjectsDir, dir);
                console.log('[Claude Runner] ✓ Found in:', sourcePath);
                break;
              }
            }
          }
        }

        if (sourcePath && sourceDir) {
          const newSessionId = crypto.randomUUID();
          // Copy to the SAME directory where source was found
          const destPath = path.join(sourceDir, `${newSessionId}.jsonl`);

          // Get Timeline UUIDs snapshot using Backtrace algorithm
          const entryUuids = parseTimelineUuids(sourcePath);
          console.log('[Claude Runner] Timeline entries:', entryUuids.length);

          fs.copyFileSync(sourcePath, destPath);
          console.log('[Claude Runner] Copied session file, new ID:', newSessionId);
          console.log('[Claude Runner] From:', sourcePath);
          console.log('[Claude Runner] To:', destPath);

          // Save fork marker with UUIDs snapshot (always save, even if empty — marks fork at beginning)
          try {
            projectManager.db.saveForkMarker(forkSessionId, newSessionId, entryUuids);
            console.log('[Claude Runner] Fork marker saved with', entryUuids.length, 'UUIDs');
          } catch (e) {
            console.warn('[Claude Runner] Could not save fork marker:', e.message);
          }

          // Run claude --resume in CURRENT terminal (not new tab!)
          // This is for claude-f <uuid> - resuming external session
          // Enable thinking mode detection (will send Tab when '>' prompt appears)
          claudeState.set(tabId, 'WAITING_PROMPT');
          term.write(`claude --dangerously-skip-permissions --resume ${newSessionId}\r`);

          // Notify renderer about new session ID
          event.sender.send('claude:session-detected', { tabId, sessionId: newSessionId });
          console.log('[Claude Runner] Started claude --resume in current terminal');
        } else {
          console.error('[Claude Runner] Source session not found in ANY project');
          console.error('[Claude Runner] Searched for:', forkSessionId);
          // Just echo error to terminal
          term.write(`echo "❌ Session not found: ${forkSessionId}"\r`);
        }
      } else {
        console.error('[Claude Runner] No forkSessionId for claude-f');
      }
      break;

    default:
      console.error('[Claude Runner] Unknown command:', command);
  }
});