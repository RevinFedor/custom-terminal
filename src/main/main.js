const { app, BrowserWindow, ipcMain, Menu, dialog } = require('electron');
const path = require('path');
const pty = require('node-pty');
const fs = require('fs');
const os = require('os');
const { stripVTControlCharacters } = require('node:util');

// Disable HTTP cache to ensure fresh code after updates
app.commandLine.appendSwitch('disable-http-cache');

// Load modules from src/main (works for both dev and production)
const srcMainDir = path.join(__dirname, '..', '..', 'src', 'main');
const projectManager = require(path.join(srcMainDir, 'project-manager'));
const SessionManager = require(path.join(srcMainDir, 'session-manager'));
const ClaudeManager = require(path.join(srcMainDir, 'claude-manager'));

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
// Claude Thinking Mode State Machine (Tab Handshake with debounce)
// States: 'WAITING_PROMPT' -> 'DEBOUNCE_PROMPT' -> 'TAB_SENT' -> 'DEBOUNCE_TAB' -> 'READY'
const claudeState = new Map(); // tabId -> state string | null
const claudePendingPrompt = new Map(); // tabId -> prompt string
const claudeDebounceTimers = new Map(); // tabId -> debounce timer ID
let sessionManager; // Initialized after projectManager is ready
let claudeManager; // Initialized with terminals map

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
ipcMain.on('show-terminal-context-menu', async (event, { hasSelection, prompts }) => {
  const template = [
    {
      label: '🔍 Research (Reddit)',
      enabled: hasSelection,
      click: () => { event.sender.send('context-menu-command', 'gemini-research'); }
    },
    {
      label: '📋 Compact (Резюме)',
      enabled: hasSelection,
      click: () => { event.sender.send('context-menu-command', 'gemini-compact'); }
    },
    { type: 'separator' }
  ];

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

// Export a range of messages from Claude session
ipcMain.handle('claude:copy-range', async (event, { sessionId, cwd, startUuid, endUuid }) => {
  console.log('[Claude Export] Exporting range from', startUuid, 'to', endUuid);

  if (!sessionId) return { success: false, error: 'No session ID' };

  try {
    const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');
    let sourcePath = null;

    if (cwd) {
      const projectSlug = cwd.replace(/\//g, '-');
      const primaryPath = path.join(claudeProjectsDir, projectSlug, `${sessionId}.jsonl`);
      if (fs.existsSync(primaryPath)) sourcePath = primaryPath;
    }

    if (!sourcePath && fs.existsSync(claudeProjectsDir)) {
      const projectDirs = fs.readdirSync(claudeProjectsDir).filter(d => fs.statSync(path.join(claudeProjectsDir, d)).isDirectory());
      for (const dir of projectDirs) {
        const checkPath = path.join(claudeProjectsDir, dir, `${sessionId}.jsonl`);
        if (fs.existsSync(checkPath)) {
          sourcePath = checkPath;
          break;
        }
      }
    }

    if (!sourcePath) return { success: false, error: 'File not found' };

    const content = fs.readFileSync(sourcePath, 'utf-8');
    const lines = content.trim().split('\n').filter(l => l.trim());
    
    // First, build the full message map
    const recordMap = new Map();
    let lastEntryWithUuid = null;
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.uuid) {
          recordMap.set(entry.uuid, entry);
          lastEntryWithUuid = entry;
        }
      } catch (e) {}
    }

    // Use backtrace to get the linear active history
    const activeHistory = [];
    let current = lastEntryWithUuid?.uuid;
    while (current) {
      const record = recordMap.get(current);
      if (!record) break;
      activeHistory.unshift(record);
      current = record.logicalParentUuid || record.parentUuid;
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

    for (const entry of range) {
      if (entry.isSidechain || entry.type === 'summary') continue;

      if (entry.type === 'user') {
        let rawContent = entry.message?.content;
        if (Array.isArray(rawContent)) {
          if (rawContent.some(i => i.type === 'tool_result')) continue;
          const textBlock = rawContent.find(i => i.type === 'text');
          rawContent = textBlock?.text || '';
        }
        if (!rawContent || typeof rawContent !== 'string') continue;
        if (rawContent.includes('[Request interrupted')) continue;
        // Skip system artifacts
        if (rawContent.includes('<command-name>') ||
            rawContent.includes('<command-message>') ||
            rawContent.includes('<local-command-stdout>') ||
            rawContent.includes('<system-reminder>') ||
            rawContent.includes('<bash-notification>') ||
            rawContent.startsWith('Caveat: The messages below')) continue;

        output += `## User\n${rawContent.replace(/\[200~/g, '').replace(/~\]/g, '').trim()}\n\n`;
      }
      else if (entry.type === 'assistant') {
        output += `## Claude\n`;
        const content = entry.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text') output += `${block.text}\n`;
            if (block.type === 'thinking') output += `> Thinking: ${block.thinking.slice(0, 200)}...\n`;
            if (block.type === 'tool_use') {
              const name = block.name;
              const fPath = block.input?.file_path || block.input?.path;
              if (name === 'Read') output += `→ Read(${fPath})\n`;
              else if (name === 'Edit') output += `→ Updated ${fPath}\n`;
              else if (name === 'Write') output += `→ Created ${fPath}\n`;
              else output += `→ Tool: ${name}\n`;
            }
          }
        } else if (typeof content === 'string') {
          output += `${content}\n`;
        }
        output += `\n`;
      }
      else if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
        output += `\n═══ HISTORY COMPACTED ═══\n\n`;
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

    terminals.set(tabId, ptyProcess);
    terminalProjects.set(tabId, workingDir);
    terminalCommandState.set(tabId, { isRunning: false, lastExitCode: 0 });

    ptyProcess.onData((data) => {
      // Parse OSC 133 for command lifecycle events (just spy, don't modify)
      parseOSC133AndEmit(tabId, data);

      // ========== CLAUDE THINKING MODE STATE MACHINE (Debounce Handshake) ==========
      // Wait for UI to "settle" (no data for 300ms) before sending Tab/prompt
      const DEBOUNCE_MS = 300;
      const currentState = claudeState.get(tabId);

      if (currentState) {
        const stripped = stripVTControlCharacters(data);
        const term = terminals.get(tabId);

        // STEP 1: WAITING_PROMPT -> See prompt char -> Start debounce for Tab
        // Claude v2.1.32+ uses ⏵ (U+23F5) instead of >
        if (currentState === 'WAITING_PROMPT' && (stripped.includes('⏵') || stripped.includes('>'))) {
          console.log(`[Claude Handshake] Tab ${tabId}: Prompt detected. Starting debounce...`);
          claudeState.set(tabId, 'DEBOUNCE_PROMPT');

          // Start debounce timer
          const timerId = setTimeout(() => {
            console.log(`[Claude Handshake] Tab ${tabId}: UI settled (${DEBOUNCE_MS}ms silence). Sending TAB...`);
            term.write('\t');
            claudeState.set(tabId, 'TAB_SENT');
            claudeDebounceTimers.delete(tabId);
          }, DEBOUNCE_MS);
          claudeDebounceTimers.set(tabId, timerId);
        }

        // STEP 2: DEBOUNCE_PROMPT -> More data = Reset debounce
        else if (currentState === 'DEBOUNCE_PROMPT') {
          console.log(`[Claude Handshake] Tab ${tabId}: More data during debounce, resetting timer...`);
          clearTimeout(claudeDebounceTimers.get(tabId));

          const timerId = setTimeout(() => {
            console.log(`[Claude Handshake] Tab ${tabId}: UI settled. Sending TAB...`);
            term.write('\t');
            claudeState.set(tabId, 'TAB_SENT');
            claudeDebounceTimers.delete(tabId);
          }, DEBOUNCE_MS);
          claudeDebounceTimers.set(tabId, timerId);
        }

        // STEP 3: TAB_SENT -> Data received -> Start debounce for prompt
        else if (currentState === 'TAB_SENT') {
          console.log(`[Claude Handshake] Tab ${tabId}: UI reacted to Tab. Starting prompt debounce...`);
          claudeState.set(tabId, 'DEBOUNCE_TAB');

          const timerId = setTimeout(async () => {
            console.log(`[Claude Handshake] Tab ${tabId}: UI settled after Tab. Sending prompt via Bracketed Paste...`);

            if (claudePendingPrompt.has(tabId)) {
              const pendingPrompt = claudePendingPrompt.get(tabId);
              claudePendingPrompt.delete(tabId);

              // Bracketed Paste Mode: tell terminal "this is a paste, not typing"
              const PASTE_START = '\x1b[200~';
              const PASTE_END = '\x1b[201~';

              // Step 1: Send text wrapped in paste brackets (NO \r inside!)
              console.log(`[Claude Handshake] Tab ${tabId}: Sending PASTE_START + prompt (${pendingPrompt.length} chars) + PASTE_END...`);
              if (pendingPrompt.length > 1024) {
                // AWAIT for chunked write to complete!
                await writeToPtySafe(term, PASTE_START + pendingPrompt + PASTE_END);
                console.log(`[Claude Handshake] Tab ${tabId}: Chunked write complete.`);
              } else {
                term.write(PASTE_START + pendingPrompt + PASTE_END);
              }

              // Step 2: Wait for Ink to exit paste mode, then send Enter
              setTimeout(() => {
                console.log(`[Claude Handshake] Tab ${tabId}: Sending SUBMIT (\\r)...`);
                term.write('\r');
                console.log(`[Claude Handshake] Tab ${tabId}: ✅ Prompt sent!`);
              }, 100);
            }

            claudeState.delete(tabId);
            claudeDebounceTimers.delete(tabId);
          }, DEBOUNCE_MS);
          claudeDebounceTimers.set(tabId, timerId);
        }

        // STEP 4: DEBOUNCE_TAB -> More data = Reset debounce
        else if (currentState === 'DEBOUNCE_TAB') {
          console.log(`[Claude Handshake] Tab ${tabId}: More data after Tab, resetting prompt debounce...`);
          clearTimeout(claudeDebounceTimers.get(tabId));

          const timerId = setTimeout(async () => {
            console.log(`[Claude Handshake] Tab ${tabId}: UI settled. Sending prompt via Bracketed Paste...`);

            if (claudePendingPrompt.has(tabId)) {
              const pendingPrompt = claudePendingPrompt.get(tabId);
              claudePendingPrompt.delete(tabId);

              // Bracketed Paste Mode
              const PASTE_START = '\x1b[200~';
              const PASTE_END = '\x1b[201~';

              console.log(`[Claude Handshake] Tab ${tabId}: Sending PASTE_START + prompt (${pendingPrompt.length} chars) + PASTE_END...`);
              if (pendingPrompt.length > 1024) {
                // AWAIT for chunked write to complete!
                await writeToPtySafe(term, PASTE_START + pendingPrompt + PASTE_END);
                console.log(`[Claude Handshake] Tab ${tabId}: Chunked write complete.`);
              } else {
                term.write(PASTE_START + pendingPrompt + PASTE_END);
              }

              // Wait for Ink to exit paste mode, then send Enter
              setTimeout(() => {
                console.log(`[Claude Handshake] Tab ${tabId}: Sending SUBMIT (\\r)...`);
                term.write('\r');
                console.log(`[Claude Handshake] Tab ${tabId}: ✅ Prompt sent!`);
              }, 100);
            }

            claudeState.delete(tabId);
            claudeDebounceTimers.delete(tabId);
          }, DEBOUNCE_MS);
          claudeDebounceTimers.set(tabId, timerId);
        }
      }
      // ========== END STATE MACHINE ==========

      // Send raw data to renderer - xterm.js handles OSC sequences itself
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('terminal:data', { pid: ptyProcess.pid, tabId, data });
      }
    });

    ptyProcess.onExit((exitCode) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('terminal:exit', tabId, exitCode);
      }
      terminals.delete(tabId);
      terminalProjects.delete(tabId);
      terminalCommandState.delete(tabId);
    });

    console.timeEnd(`[PERF:main] terminal:create ${tabId}`);
    return { pid: ptyProcess.pid, cwd: workingDir };
  });

// Safe PTY write with chunking (prevents TTY buffer overflow)
async function writeToPtySafe(term, data) {
  const CHUNK_SIZE = 1024; // 1KB - safe for TTY buffer (OS limit ~4KB)
  const DELAY_MS = 10;     // 10ms - enough for buffer to flush

  console.log('[writeToPtySafe] Starting write, total length:', data.length);
  console.log('[writeToPtySafe] Data ends with \\r:', data.endsWith('\r'));
  console.log('[writeToPtySafe] Data ends with \\n:', data.endsWith('\n'));
  console.log('[writeToPtySafe] Last 10 chars (escaped):', JSON.stringify(data.slice(-10)));

  const totalChunks = Math.ceil(data.length / CHUNK_SIZE);
  console.log('[writeToPtySafe] Will write in', totalChunks, 'chunk(s)');

  for (let i = 0; i < data.length; i += CHUNK_SIZE) {
    const chunk = data.substring(i, i + CHUNK_SIZE);
    const chunkNum = Math.floor(i / CHUNK_SIZE) + 1;
    console.log(`[writeToPtySafe] Writing chunk ${chunkNum}/${totalChunks}, size: ${chunk.length}`);
    term.write(chunk);

    // Wait for Event Loop and TTY to process
    if (i + CHUNK_SIZE < data.length) {
      console.log('[writeToPtySafe] Waiting', DELAY_MS, 'ms before next chunk...');
      await new Promise(resolve => setTimeout(resolve, DELAY_MS));
    }
  }
  console.log('[writeToPtySafe] ✅ All chunks written');
}

// Bracketed Paste Mode escape sequences
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

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

  // For large data: use chunked write with bracketed paste
  if (data.length > 1024) {
    console.log(`[main] Large input (${data.length} bytes), using chunked write`);

    // Check if data ends with \r (Enter) - need to send it AFTER paste ends
    const endsWithEnter = data.endsWith('\r');
    console.log(`[main] endsWithEnter: ${endsWithEnter}, last chars: ${JSON.stringify(data.slice(-5))}`);
    const contentToSend = endsWithEnter ? data.slice(0, -1) : data;

    console.log('[main] Starting writeToPtySafe...');
    await writeToPtySafe(term, PASTE_START + contentToSend + PASTE_END);
    console.log('[main] writeToPtySafe completed');

    // Send Enter separately, outside of bracketed paste
    if (endsWithEnter) {
      console.log('[main] Waiting 50ms before Enter...');
      await new Promise(resolve => setTimeout(resolve, 50));
      console.log('[main] Sending Enter now!');
      term.write('\r');
      console.log('[main] Enter sent!');
    } else {
      console.log('[main] ⚠️ NO ENTER TO SEND - data did not end with \r');
    }
  } else {
    term.write(data);
  }
});

// Resize terminal
ipcMain.on('terminal:resize', (event, tabId, cols, rows) => {
  const term = terminals.get(tabId);
  if (term) {
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
});

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

ipcMain.handle('project:clear-tab-history', (event, { projectId }) => {
  projectManager.db.clearTabHistory(projectId);
  return { success: true };
});

ipcMain.handle('project:delete-tab-history-entry', (event, { id }) => {
  projectManager.db.deleteTabHistoryEntry(id);
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

// ========== DOCS UPDATE FEATURE ========== 

// Export Claude session for documentation update (with file watcher approach)
ipcMain.handle('docs:export-session', async (event, { tabId, projectPath }) => {
  const fs = require('fs');
  const term = terminals.get(tabId);

  if (!term) {
    return { success: false, error: 'Terminal not found' };
  }

  try {
    // 1. Generate unique filename (Claude Code always saves as .txt regardless of input extension)
    const timestamp = Date.now();
    const baseFilename = `session-export-${timestamp}`;
    const expectedFilename = `${baseFilename}.txt`; // Claude always outputs .txt
    const tmpDir = path.join(projectPath, 'docs', 'tmp');

    // Ensure tmp directory exists
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }

    const absolutePath = path.join(tmpDir, expectedFilename);

    // Use relative path from projectPath (Claude Code treats path as relative to cwd)
    // We send .md but Claude will create .txt
    const relativePath = `docs/tmp/${baseFilename}.md`;
    console.log('[docs:export] Starting export, expecting:', absolutePath);

    // 2. Send /export command to Claude Code (same pattern as terminal:executeCommand)
    term.write(`/export ${relativePath}`);
    await new Promise(resolve => setTimeout(resolve, 150));
    term.write('\r');

    // 3. Wait for file to appear (polling approach)
    const timeout = 15000; // 15 seconds max
    const intervalTime = 200;
    let elapsed = 0;

    return new Promise((resolve) => {
      const checkFile = setInterval(() => {
        elapsed += intervalTime;

        if (fs.existsSync(absolutePath)) {
          const stats = fs.statSync(absolutePath);
          if (stats.size > 0) {
            clearInterval(checkFile);
            console.log('[docs:export] File detected:', absolutePath);
            resolve({ success: true, exportedPath: absolutePath });
          }
        }

        if (elapsed >= timeout) {
          clearInterval(checkFile);
          console.error('[docs:export] Timeout waiting for file');
          resolve({ success: false, error: 'Timeout: Claude did not create export file within 15s' });
        }
      }, intervalTime);
    });
  } catch (error) {
    console.error('[docs:export] Error:', error);
    return { success: false, error: error.message };
  }
});

// Read documentation prompt from file
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

// Save combined prompt to temp file for Gemini (avoids shell escaping issues)
ipcMain.handle('docs:save-prompt-temp', async (event, { projectPath, promptContent, exportedFilePath }) => {
  const fs = require('fs');

  try {
    const tmpDir = path.join(projectPath, 'docs', 'tmp');
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }

    const timestamp = Date.now();
    const promptFile = path.join(tmpDir, `gemini-prompt-${timestamp}.txt`);
    const fullPrompt = `${promptContent}\n\n${exportedFilePath}`;

    fs.writeFileSync(promptFile, fullPrompt, 'utf-8');
    console.log('[docs:save-prompt] Saved prompt to:', promptFile);

    return { success: true, promptFile };
  } catch (error) {
    console.error('[docs:save-prompt] Error:', error);
    return { success: false, error: error.message };
  }
});

// Save terminal selection to temp file (similar to session export, but for copied text)
ipcMain.handle('docs:save-selection', async (event, { projectPath, selectionText }) => {
  const fs = require('fs');

  try {
    const tmpDir = path.join(projectPath, 'docs', 'tmp');
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }

    const timestamp = Date.now();
    const selectionFile = path.join(tmpDir, `selection-${timestamp}.txt`);

    // Add preamble explaining this is copied AI history
    const preamble = '(Весь текст ниже является копипастом из истории Claude Code / нейросетки, а не содержимым файла)\n\n---\n\n';
    const fullContent = preamble + selectionText;

    fs.writeFileSync(selectionFile, fullContent, 'utf-8');
    console.log('[docs:save-selection] Saved selection to:', selectionFile);

    return { success: true, selectionPath: selectionFile };
  } catch (error) {
    console.error('[docs:save-selection] Error:', error);
    return { success: false, error: error.message };
  }
});

// Cleanup temp files after successful Gemini start
ipcMain.handle('docs:cleanup-temp', async (event, { exportedPath, promptPath }) => {
  const fs = require('fs');

  try {
    if (exportedPath && fs.existsSync(exportedPath)) {
      fs.unlinkSync(exportedPath);
      console.log('[docs:cleanup] Deleted:', exportedPath);
    }
    if (promptPath && fs.existsSync(promptPath)) {
      fs.unlinkSync(promptPath);
      console.log('[docs:cleanup] Deleted:', promptPath);
    }
    return { success: true };
  } catch (error) {
    console.error('[docs:cleanup] Error:', error);
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

// ========== CLAUDE INPUT INTERCEPTION ========== 

const crypto = require('crypto');

// Sniper Watcher: detect new .jsonl session files via fs.watch + polling fallback
// fs.watch alone is unreliable on macOS (FSEvents init delay), so we also poll
function startSessionSniper(projectDir, startTime, onFound) {
  let sessionFound = false;
  let watcher = null;
  let pollInterval = null;
  let timeoutTimer = null;

  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

  // Snapshot existing files before Claude starts
  const existingFiles = new Set();
  try {
    const files = fs.readdirSync(projectDir);
    for (const f of files) {
      if (uuidPattern.test(f)) existingFiles.add(f);
    }
  } catch (e) {}
  console.log('[Sniper] Snapshot:', existingFiles.size, 'existing files in', projectDir);

  const cleanup = () => {
    if (watcher) { try { watcher.close(); } catch(e) {} watcher = null; }
    if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
    if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
  };

  const checkFile = (filename) => {
    if (sessionFound) return;
    if (!uuidPattern.test(filename)) return;
    if (existingFiles.has(filename)) return; // old file, skip

    const filePath = path.join(projectDir, filename);
    try {
      const stats = fs.statSync(filePath);
      const fileTime = stats.birthtimeMs || stats.mtimeMs;
      console.log('[Sniper] New file:', filename, 'time:', fileTime, 'startTime:', startTime, 'diff:', fileTime - startTime);
      if (fileTime >= startTime - 1000) {
        sessionFound = true;
        const sessionId = filename.replace('.jsonl', '');
        console.log('[Sniper] ✅ Session detected:', sessionId);
        cleanup();
        onFound(sessionId);
      } else {
        console.log('[Sniper] File too old, skipping');
      }
    } catch (e) {
      console.log('[Sniper] stat error:', e.message);
    }
  };

  // Ensure directory exists
  try {
    if (!fs.existsSync(projectDir)) {
      fs.mkdirSync(projectDir, { recursive: true });
      console.log('[Sniper] Created directory:', projectDir);
    }
  } catch (e) {}

  // Method 1: fs.watch (may or may not fire on macOS)
  try {
    watcher = fs.watch(projectDir, (eventType, filename) => {
      console.log('[Sniper] fs.watch event:', eventType, filename);
      if (filename) checkFile(filename);
    });
    console.log('[Sniper] fs.watch active');
  } catch (e) {
    console.log('[Sniper] fs.watch failed:', e.message);
  }

  // Method 2: Directory polling every 1s (reliable fallback)
  let pollCount = 0;
  pollInterval = setInterval(() => {
    pollCount++;
    try {
      const files = fs.readdirSync(projectDir);
      const newFiles = files.filter(f => uuidPattern.test(f) && !existingFiles.has(f));
      if (newFiles.length > 0) {
        console.log('[Sniper] Poll #' + pollCount + ': found', newFiles.length, 'new file(s):', newFiles[0]);
      }
      for (const f of newFiles) {
        checkFile(f);
        if (sessionFound) break;
      }
    } catch (e) {}
  }, 1000);

  // Safety timeout: 30s
  timeoutTimer = setTimeout(() => {
    if (!sessionFound) {
      console.log('[Sniper] Timeout (30s) — no session detected after', pollCount, 'polls');
    }
    cleanup();
  }, 30000);

  return cleanup;
}

// Sniper Watcher handler: watch for new .jsonl file creation when claude starts
ipcMain.on('claude:spawn-with-watcher', (event, { tabId, cwd }) => {
  const projectSlug = cwd.replace(/\//g, '-');
  const projectDir = path.join(os.homedir(), '.claude', 'projects', projectSlug);
  const startTime = Date.now();

  console.log('[Sniper] Starting for tab:', tabId, 'dir:', projectDir);

  startSessionSniper(projectDir, startTime, (sessionId) => {
    event.sender.send('claude:session-detected', { tabId, sessionId });
  });

  // Let the command through - don't intercept, just watch
  const term = terminals.get(tabId);
  if (term) {
    // Enable thinking mode detection (will send Tab when '>' prompt appears)
    claudeState.set(tabId, 'WAITING_PROMPT');
    term.write('claude --dangerously-skip-permissions\r');
  }
});

// ========== GEMINI INPUT INTERCEPTION ==========

// Store active Gemini watchers by tabId (so we can close them when tab closes)
const geminiWatchers = new Map();

// Gemini Sniper Watcher: watch for new session file creation when gemini starts
// IMPORTANT: Gemini creates session file only AFTER first user message, not at startup!
// Session files are stored in ~/.gemini/tmp/<SHA256_HASH>/chats/session-<datetime>-<id>.json
ipcMain.on('gemini:spawn-with-watcher', (event, { tabId, cwd }) => {
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

  // Calculate SHA256 hash of the cwd (this is how Gemini organizes projects)
  const normalizedCwd = path.resolve(cwd || os.homedir());
  const dirHash = crypto.createHash('sha256').update(normalizedCwd).digest('hex');
  const chatsDir = path.join(os.homedir(), '.gemini', 'tmp', dirHash, 'chats');

  console.log('[Gemini Sniper] Normalized CWD:', normalizedCwd);
  console.log('[Gemini Sniper] Dir hash:', dirHash);
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

      // Check if file is fresh (created after our start time)
      fs.stat(filePath, (err, stats) => {
        if (err || sessionFound) return;

        const fileTime = stats.birthtimeMs || stats.mtimeMs;
        if (fileTime >= startTime - 500) {
          sessionFound = true;
          console.log('[Gemini Sniper] Fresh session file detected!');

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

  // Let the command through - write 'gemini' to PTY
  const term = terminals.get(tabId);
  if (term) {
    console.log('[Gemini Sniper] Writing "gemini" to terminal');
    term.write('gemini\r');
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
        // Calculate hash for chats directory
        const normalizedCwd = path.resolve(termCwd || os.homedir());
        const dirHash = crypto.createHash('sha256').update(normalizedCwd).digest('hex');
        const chatsDir = path.join(os.homedir(), '.gemini', 'tmp', dirHash, 'chats');

        console.log('[Gemini Fork] CWD:', normalizedCwd);
        console.log('[Gemini Fork] Chats dir:', chatsDir);

        if (!fs.existsSync(chatsDir)) {
          console.error('[Gemini Fork] Chats directory not found');
          term.write(`echo "❌ Gemini chats directory not found"\r`);
          return;
        }

        // Find source session file by reading each JSON and matching sessionId
        const files = fs.readdirSync(chatsDir).filter(f => f.startsWith('session-') && f.endsWith('.json'));
        console.log('[Gemini Fork] Found', files.length, 'session files');

        let sourceFile = null;
        let sourceData = null;

        for (const file of files) {
          try {
            const filePath = path.join(chatsDir, file);
            const content = fs.readFileSync(filePath, 'utf-8');
            const data = JSON.parse(content);
            if (data.sessionId === sessionId) {
              sourceFile = filePath;
              sourceData = data;
              console.log('[Gemini Fork] ✓ Found source file:', file);
              break;
            }
          } catch (e) {
            // Ignore parse errors, continue searching
          }
        }

        if (!sourceFile || !sourceData) {
          console.error('[Gemini Fork] Source session not found:', sessionId);
          term.write(`echo "❌ Session not found: ${sessionId}"\r`);
          return;
        }

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
      turns.push({
        turnNumber: turnIndex,
        messageIndex: i,
        preview: msg.content.slice(0, 100).replace(/\n/g, ' '),
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

  // Find the session file
  const normalizedCwd = path.resolve(cwd || os.homedir());
  const dirHash = crypto.createHash('sha256').update(normalizedCwd).digest('hex');
  const chatsDir = path.join(os.homedir(), '.gemini', 'tmp', dirHash, 'chats');

  // Find file by sessionId
  let sessionFilePath = null;
  try {
    const files = fs.readdirSync(chatsDir).filter(f => f.startsWith('session-') && f.endsWith('.json'));
    for (const file of files) {
      const filePath = path.join(chatsDir, file);
      const content = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(content);
      if (data.sessionId === sessionId) {
        sessionFilePath = filePath;
        break;
      }
    }
  } catch (e) {
    console.error('[Gemini TimeMachine] Error finding session file:', e.message);
    return;
  }

  if (!sessionFilePath) {
    console.error('[Gemini TimeMachine] Session file not found:', sessionId);
    return;
  }

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

  // Find the original session file
  const normalizedCwd = path.resolve(cwd || os.homedir());
  const dirHash = crypto.createHash('sha256').update(normalizedCwd).digest('hex');
  const chatsDir = path.join(os.homedir(), '.gemini', 'tmp', dirHash, 'chats');

  let originalFilePath = null;
  try {
    const files = fs.readdirSync(chatsDir).filter(f => f.startsWith('session-') && f.endsWith('.json'));
    for (const file of files) {
      const filePath = path.join(chatsDir, file);
      const content = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(content);
      if (data.sessionId === sessionId) {
        originalFilePath = filePath;
        break;
      }
    }
  } catch (e) {
    return { success: false, error: 'Could not find original session file' };
  }

  if (!originalFilePath) {
    return { success: false, error: 'Original session file not found' };
  }

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

// ========== SESSION CHAIN HELPERS ==========

// Find a JSONL session file by ID, searching cwd-based path first, then all project dirs
function findSessionFile(sessionId, cwd) {
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
}

// Load all records from a JSONL file into a Map (uuid → record)
// Returns { recordMap, lastRecord, bridgeSessionId }
// bridgeSessionId is set if the first entry references a different session (clear-context bridge)
function loadJsonlRecords(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.trim().split('\n').filter(line => line.trim());
  const sessionId = path.basename(filePath, '.jsonl');

  const recordMap = new Map();
  let lastRecord = null;
  let bridgeSessionId = null;

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.uuid) {
        recordMap.set(entry.uuid, entry);
        lastRecord = entry;
        // Detect bridge: first entry with uuid that has a different sessionId
        if (bridgeSessionId === null && entry.sessionId && entry.sessionId !== sessionId) {
          bridgeSessionId = entry.sessionId;
        } else if (bridgeSessionId === null && entry.sessionId === sessionId) {
          bridgeSessionId = undefined; // No bridge
        }
      }
    } catch {}
  }

  return { recordMap, lastRecord, bridgeSessionId: bridgeSessionId || null };
}

// Resolve the full chain of JSONL files by following bridge entries backwards.
// Returns a merged recordMap with all records from all files in the chain,
// plus metadata about session boundaries.
// sessionBoundaries: array of { childSessionId, parentSessionId, bridgeUuid }
function resolveSessionChain(sessionId, cwd, maxDepth = 10) {
  const mergedMap = new Map();
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

    const { recordMap, lastRecord: fileLastRecord, bridgeSessionId } = loadJsonlRecords(found.filePath);

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

    console.log('[SessionChain] Loaded', currentSessionId.slice(0, 12) + '...', ':', recordMap.size, 'records, bridge:', bridgeSessionId ? bridgeSessionId.slice(0, 12) + '...' : 'none');

    if (bridgeSessionId) {
      sessionBoundaries.push({
        childSessionId: currentSessionId,
        parentSessionId: bridgeSessionId,
      });
      currentSessionId = bridgeSessionId;
    } else {
      break;
    }

    depth++;
  }

  return { mergedMap, lastRecord, sessionBoundaries };
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
      console.log('[SessionChain] Found child:', childId.slice(0, 12), '... for parent:', currentId.slice(0, 12) + '...');
      currentId = childId;
    } else {
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

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        recordMap.set(entry.uuid, entry);
        if (entry.uuid) lastRecord = entry;
      } catch {}
    }

    if (!lastRecord) return [];

    // BACKTRACE: Walk backwards from last record following parentUuid
    const activeBranch = [];
    let currentUuid = lastRecord.uuid;

    while (currentUuid) {
      const record = recordMap.get(currentUuid);
      if (!record) break;
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
  console.log('[Fork Markers] Getting markers for session:', sessionId);
  if (!sessionId) return { success: false, error: 'No session ID', markers: [] };
  try {
    const markers = projectManager.db.getForkMarkers(sessionId);
    console.log('[Fork Markers] Found:', markers.length, 'markers');
    if (markers.length > 0) {
      console.log('[Fork Markers] Markers:', JSON.stringify(markers));
    }
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
  console.log('[Claude Timeline] Getting timeline for session:', sessionId);

  if (!sessionId) {
    return { success: false, error: 'No session ID provided' };
  }

  try {
    // Resolve the full session chain (follows bridge entries across "Clear Context" boundaries)
    const { mergedMap: recordMap, lastRecord, sessionBoundaries } = resolveSessionChain(sessionId, cwd);

    console.log('[Claude Timeline] Merged records:', recordMap.size, '| Chain depth:', sessionBoundaries.length + 1);
    console.log('[Claude Timeline] Last record type:', lastRecord?.type);

    if (!lastRecord) {
      console.log('[Claude Timeline] No lastRecord - returning empty');
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
      if (!record) break;

      activeBranch.unshift(record);

      // Move to parent (use logicalParentUuid for compact boundaries, else parentUuid)
      let nextUuid = record.logicalParentUuid || record.parentUuid;

      // If we hit the root (parentUuid=null), check for bridge entry to parent session.
      // Bridge entry has a DIFFERENT sessionId and its parentUuid points into the parent file.
      // We need to follow the bridge to continue backtrace into the parent chain.
      if (!nextUuid && sessionBoundaries.length > 0) {
        // Find bridge entry: an entry in mergedMap with a different sessionId whose parentUuid
        // points to a record in the parent file
        for (const [uuid, entry] of recordMap) {
          if (seen.has(uuid)) continue;
          // Bridge entry: sessionId differs from the file it lives in AND has a parentUuid
          if (entry.parentUuid && entry.sessionId !== record.sessionId) {
            console.log('[Claude Timeline] Following bridge:', uuid.slice(0, 12), '→ parent:', entry.parentUuid?.slice(0, 12));
            nextUuid = entry.parentUuid;
            break;
          }
        }
      }

      currentUuid = nextUuid;
    }

    console.log('[Claude Timeline] Active branch size:', activeBranch.length);

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

        entries.push({
          uuid: entry.uuid,
          type: 'user',
          timestamp: entry.timestamp,
          content: cleanContent,
          isCompactSummary: entry.isCompactSummary || false
        });
      } else if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
        entries.push({
          uuid: entry.uuid,
          type: 'compact',
          timestamp: entry.timestamp,
          content: 'Conversation compacted',
          preTokens: entry.compactMetadata?.preTokens
        });
      }
    }

    console.log('[Claude Timeline] === FILTER RESULTS ===');
    console.log('[Claude Timeline] Skipped sidechain:', skippedSidechain);
    console.log('[Claude Timeline] Skipped summary:', skippedSummary);
    console.log('[Claude Timeline] Skipped tool_result:', skippedToolResult);
    console.log('[Claude Timeline] Skipped no content:', skippedNoContent);
    console.log('[Claude Timeline] Skipped system msg:', skippedSystem);
    console.log('[Claude Timeline] FINAL entries:', entries.length);
    if (entries.length > 0) {
      console.log('[Claude Timeline] First entry:', entries[0].content?.slice(0, 50));
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
ipcMain.handle('claude:export-clean-session', async (event, { sessionId, cwd, includeCode = false, fromStart = true }) => {
  console.log('[Claude Export] ========================================');
  console.log('[Claude Export] Exporting session:', sessionId);
  console.log('[Claude Export] Options:', { includeCode, fromStart, cwd });

  if (!sessionId) {
    return { success: false, error: 'No session ID provided' };
  }

  try {
    const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');

    // Find session file
    let sourcePath = null;

    if (cwd) {
      const projectSlug = cwd.replace(/\//g, '-');
      const primaryPath = path.join(claudeProjectsDir, projectSlug, `${sessionId}.jsonl`);
      if (fs.existsSync(primaryPath)) {
        sourcePath = primaryPath;
      }
    }

    if (!sourcePath && fs.existsSync(claudeProjectsDir)) {
      const projectDirs = fs.readdirSync(claudeProjectsDir, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name);

      for (const dir of projectDirs) {
        const checkPath = path.join(claudeProjectsDir, dir, `${sessionId}.jsonl`);
        if (fs.existsSync(checkPath)) {
          sourcePath = checkPath;
          break;
        }
      }
    }

    if (!sourcePath) {
      return { success: false, error: 'Session file not found' };
    }

    // Read and parse JSONL
    const fileContent = fs.readFileSync(sourcePath, 'utf-8');
    const allRecords = fileContent.trim().split('\n')
      .filter(line => line.trim())
      .map(line => {
        try { return JSON.parse(line); }
        catch (e) { return null; }
      })
      .filter(Boolean);

    // 1. Build UUID -> Record Map
    const recordMap = new Map();
    allRecords.forEach(r => recordMap.set(r.uuid, r));
    console.log('[Claude Export] Total records in file:', allRecords.length);
    console.log('[Claude Export] UUID map size:', recordMap.size);

    // 2. BACKTRACE: Find the active branch starting from the last record (any type)
    // Must use the very last record with a valid UUID (same as timeline)
    let lastRecord = null;
    for (const r of allRecords) {
      if (r.uuid) lastRecord = r;
    }
    console.log('[Claude Export] Last record type:', lastRecord?.type);

    if (!lastRecord) {
      console.log('[Claude Export] Empty session - no records with UUID');
      return { success: true, content: '# Empty session' };
    }

    let currentUuid = lastRecord.uuid;
    console.log('[Claude Export] Starting backtrace from UUID:', currentUuid);

    const activeBranch = [];
    let backtraceSteps = 0;

    while (currentUuid) {
      const record = recordMap.get(currentUuid);
      if (!record) {
        console.log('[Claude Export] Backtrace ended - UUID not found:', currentUuid);
        break;
      }

      activeBranch.unshift(record);
      backtraceSteps++;

      // Stop if we hit a fork point AND fromStart is false
      // A fork point is typically where parentUuid is null but logicalParentUuid exists (compact)
      // or if it's just a resume point.
      if (!fromStart && (record.type === 'system' && record.subtype === 'compact_boundary')) {
        console.log('[Claude Export] Stopping at compact_boundary (fromStart=false)');
        break;
      }

      currentUuid = record.logicalParentUuid || record.parentUuid;
    }

    console.log('[Claude Export] Backtrace complete:', {
      steps: backtraceSteps,
      activeBranchSize: activeBranch.length
    });

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
    const markerBoundaryPairs = []; // { lastBoundaryIdx, sourceSessionId } for tree building
    let hasForkAtBeginning = false; // Fork with empty snapshot = fork before any entries
    try {
      const forkMarkers = projectManager.db.getForkMarkers(sessionId);
      console.log('[Claude Export] Fork markers found:', forkMarkers.length);
      for (const marker of forkMarkers) {
        const snapshotSet = new Set(marker.entry_uuids || []);
        if (snapshotSet.size === 0) {
          // Empty snapshot = fork at the very beginning (before any entries)
          hasForkAtBeginning = true;
          continue;
        }
        let lastBIdx = -1; // Track last boundary index for this marker (for tree)
        // Find boundary: last Timeline-eligible entry in snapshot where next Timeline-eligible entry is NOT in snapshot
        for (let idx = 0; idx < activeBranch.length; idx++) {
          const rec = activeBranch[idx];
          if (!snapshotSet.has(rec.uuid)) continue;
          // Find the NEXT Timeline-eligible entry (skip assistant/tool entries)
          let nextTimelineEntry = null;
          for (let j = idx + 1; j < activeBranch.length; j++) {
            if (isTimelineEntry(activeBranch[j])) {
              nextTimelineEntry = activeBranch[j];
              break;
            }
          }
          if (!nextTimelineEntry) {
            // No more Timeline entries after this — boundary at the end
            forkBoundaryUuids.add(rec.uuid);
            lastBIdx = idx;
          } else if (!snapshotSet.has(nextTimelineEntry.uuid)) {
            // Next Timeline entry is NOT in snapshot — this is the fork boundary
            forkBoundaryUuids.add(rec.uuid);
            lastBIdx = idx;
          }
        }
        if (lastBIdx >= 0) {
          markerBoundaryPairs.push({ lastBoundaryIdx: lastBIdx, sourceSessionId: marker.source_session_id });
        }
      }
      console.log('[Claude Export] Fork boundary UUIDs:', forkBoundaryUuids.size, 'hasForkAtBeginning:', hasForkAtBeginning);
      console.log('[Claude Export] Marker boundary pairs:', markerBoundaryPairs.length);
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

    // Build session tree segments from fork marker boundaries
    markerBoundaryPairs.sort((a, b) => a.lastBoundaryIdx - b.lastBoundaryIdx);

    const treeSegments = [];
    let segStart = 0;

    for (const mb of markerBoundaryPairs) {
      treeSegments.push({
        startIdx: segStart,
        endIdx: mb.lastBoundaryIdx,
        sessionLabel: mb.sourceSessionId.slice(0, 8),
        type: treeSegments.length === 0 && !hasForkAtBeginning ? 'root' : 'fork'
      });
      segStart = mb.lastBoundaryIdx + 1;
    }

    // Current session (final segment)
    treeSegments.push({
      startIdx: segStart,
      endIdx: activeBranch.length - 1,
      sessionLabel: sessionId.slice(0, 8),
      type: treeSegments.length === 0 && !hasForkAtBeginning ? 'root' : 'fork',
      isCurrent: true
    });

    // Compute per-segment stats
    for (const seg of treeSegments) {
      let prompts = 0, tools = 0, compacts = 0;
      for (let i = seg.startIdx; i <= seg.endIdx && i < activeBranch.length; i++) {
        const entry = activeBranch[i];
        if (entry.isSidechain) continue;
        if (entry.type === 'user') {
          const c = entry.message?.content;
          if (Array.isArray(c) && c.some(item => item.type === 'tool_result')) continue;
          if (typeof c === 'string' && (c.startsWith('[Request interrupted') || c.includes('<command-name>'))) continue;
          prompts++;
        } else if (entry.type === 'assistant') {
          const mc = entry.message?.content;
          if (Array.isArray(mc)) { for (const b of mc) { if (b.type === 'tool_use') tools++; } }
        } else if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
          compacts++;
        }
      }
      seg.prompts = prompts;
      seg.tools = tools;
      seg.compacts = compacts;
    }

    // Detect clear-context boundaries (bridge entries with different sessionId)
    const sessionIds = new Set();
    for (const entry of activeBranch) {
      if (entry.sessionId) sessionIds.add(entry.sessionId);
    }
    const clearContextCount = Math.max(0, sessionIds.size - 1);

    console.log('[Claude Export] Tree segments:', treeSegments.length, 'clearContexts:', clearContextCount);

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
      const indent = depth > 0 ? '    '.repeat(depth - 1) + '└── ' : '';

      let tag = '';
      if (seg.type === 'root') tag = ' (root)';
      else if (seg.isCurrent && treeSegments.length > 1) tag = ' (current)';
      else if (!seg.isCurrent) tag = ' (fork)';

      const stats = [];
      if (seg.prompts > 0) stats.push(`${seg.prompts} prompt${seg.prompts !== 1 ? 's' : ''}`);
      if (seg.tools > 0) stats.push(`${seg.tools} tool${seg.tools !== 1 ? 's' : ''}`);
      if (seg.compacts > 0) stats.push(`\u267B\uFE0F \u00D7${seg.compacts}`);

      const statsStr = stats.length > 0 ? ` \u2014 ${stats.join(', ')}` : '';
      outputParts.push(`${indent}${seg.sessionLabel}${tag}${statsStr}`);
    }
    if (clearContextCount > 0) {
      const lastIndent = '    '.repeat(Math.max(0, treeSegments.length - 1));
      outputParts.push(`${lastIndent}(+ ${clearContextCount} clear context${clearContextCount > 1 ? 's' : ''})`);
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

    // Helper: format tool_use
    const formatToolAction = (toolName, input, toolResult = null) => {
      let label = '';
      switch (toolName) {
        case 'Read': label = `📄 Чтение (${input.file_path || '?'})`; break;
        case 'Edit': label = `✏️ Редактирование (${input.file_path || '?'})`; break;
        case 'Write': label = `📝 Создание (${input.file_path || '?'})`; break;
        case 'Bash': 
          const cmd = (input.command || '').substring(0, 50);
          label = `🖥 Команда ("${cmd}${input.command?.length > 50 ? '...' : ''}")`; 
          break;
        case 'Glob': label = `🔍 Поиск файлов (${input.pattern || '?'})`; break;
        case 'Grep': label = `🔍 Поиск в коде (${input.pattern || '?'})`; break;
        default: label = `⚙️ ${toolName}`;
      }

      if (!includeCode) return label;

      // If including code, add the content if available
      let detail = '';
      if (toolName === 'Read' && toolResult?.content) {
        detail = `\n\`\`\`\n${toolResult.content}\n\`\`\``;
      } else if ((toolName === 'Edit' || toolName === 'Write') && input.content) {
        detail = `\n\`\`\`\n${input.content}\n\`\`\``;
      } else if (toolName === 'Bash' && toolResult?.content) {
        detail = `\n\`\`\`\n${toolResult.content}\n\`\`\``;
      }

      return `${label}${detail}`;
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
              const thinking = block.thinking.length > 500 ? block.thinking.substring(0, 500) + '...[truncated]' : block.thinking;
              textParts.push(`<thinking>\n${thinking}\n</thinking>`);
            }
            if (block.type === 'text' && block.text) {
              textParts.push(block.text);
            }
            if (block.type === 'tool_use') {
              // Find matching tool_result in subsequent records
              let toolResult = null;
              if (includeCode) {
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
              const action = formatToolAction(block.name, block.input || {}, toolResult);
              if (action) toolActions.push(action);
            }
          }
          textContent = textParts.join('\n\n');
        }

        if (textContent.trim() || toolActions.length > 0) {
          outputParts.push('🤖 CLAUDE:');
          if (textContent.trim()) outputParts.push(textContent);
          if (toolActions.length > 0) {
            if (includeCode) {
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
      // New session - start sniper and run claude
      const projectSlug = cwd.replace(/\//g, '-');
      const projectDir = path.join(os.homedir(), '.claude', 'projects', projectSlug);

      console.log('[Claude Runner] Starting new session, sniper dir:', projectDir);

      startSessionSniper(projectDir, Date.now(), (sessionId) => {
        console.log('[Claude Runner] Sniper detected session:', sessionId);
        event.sender.send('claude:session-detected', { tabId, sessionId });
      });

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