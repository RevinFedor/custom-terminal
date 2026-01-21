const { app, BrowserWindow, ipcMain, Menu, dialog } = require('electron');
const path = require('path');
const pty = require('node-pty');

// Load modules from src/main (works for both dev and production)
const srcMainDir = path.join(__dirname, '..', '..', 'src', 'main');
const projectManager = require(path.join(srcMainDir, 'project-manager'));
const SessionManager = require(path.join(srcMainDir, 'session-manager'));

const isDev = !app.isPackaged;

let mainWindow;
const terminals = new Map(); // tabId -> ptyProcess
const terminalProjects = new Map(); // tabId -> cwd path
let sessionManager; // Initialized after projectManager is ready

function createWindow() {
  const windowOptions = {
    width: 1900,
    height: 1000,
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

  // Set dev icon in Dock if in development mode (macOS specific)
  if (isDev && process.platform === 'darwin') {
    const devIconPath = path.join(__dirname, '..', '..', 'build-resources', 'icon-dev.png');
    if (require('fs').existsSync(devIconPath)) {
      app.dock.setIcon(devIconPath);
    }
  }

  // Load from Vite dev server in dev mode, or from built files in production
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  }
}

// Context Menu IPC
ipcMain.on('show-terminal-context-menu', async (event, { hasSelection, prompts }) => {
  const template = [
    {
      label: 'Search Reddit with Gemini',
      enabled: hasSelection,
      click: () => { event.sender.send('context-menu-command', 'gemini-research'); }
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
  // Initialize session manager with database from project manager
  sessionManager = new SessionManager(projectManager.db);
  createWindow();
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
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// Create new terminal for a tab
ipcMain.handle('terminal:create', async (event, { tabId, rows, cols, cwd }) => {
    console.time(`[PERF:main] terminal:create ${tabId}`);
    const shell = process.env.SHELL || '/bin/bash';
    const workingDir = cwd || process.env.HOME;

    console.time(`[PERF:main] pty.spawn ${tabId}`);
    const ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: cols || 80,
      rows: rows || 24,
      cwd: workingDir,
      env: process.env
    });
    console.timeEnd(`[PERF:main] pty.spawn ${tabId}`);

    terminals.set(tabId, ptyProcess);
    terminalProjects.set(tabId, workingDir);

    ptyProcess.onData((data) => {
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
    });

    console.timeEnd(`[PERF:main] terminal:create ${tabId}`);
    return { pid: ptyProcess.pid, cwd: workingDir };
  });

// Safe PTY write with chunking (prevents TTY buffer overflow)
async function writeToPtySafe(term, data) {
  const CHUNK_SIZE = 1024; // 1KB - safe for TTY buffer (OS limit ~4KB)
  const DELAY_MS = 10;     // 10ms - enough for buffer to flush

  for (let i = 0; i < data.length; i += CHUNK_SIZE) {
    const chunk = data.substring(i, i + CHUNK_SIZE);
    term.write(chunk);

    // Wait for Event Loop and TTY to process
    if (i + CHUNK_SIZE < data.length) {
      await new Promise(resolve => setTimeout(resolve, DELAY_MS));
    }
  }
}

// Bracketed Paste Mode escape sequences
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

// Send input to terminal
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
    const contentToSend = endsWithEnter ? data.slice(0, -1) : data;

    await writeToPtySafe(term, PASTE_START + contentToSend + PASTE_END);

    // Send Enter separately, outside of bracketed paste
    if (endsWithEnter) {
      await new Promise(resolve => setTimeout(resolve, 50));
      term.write('\r');
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

// Get Claude session ID by finding recently modified .jsonl file for this process
ipcMain.handle('terminal:getClaudeSession', async (event, tabId) => {
  const term = terminals.get(tabId);
  if (!term) return { success: false, error: 'Terminal not found' };

  try {
    const shellPid = term.pid;
    console.log(`[Claude] Checking session for tab ${tabId}, shell PID: ${shellPid}`);

    if (process.platform === 'darwin' || process.platform === 'linux') {
      // Get child processes of the shell
      const children = await execAsync(`pgrep -P ${shellPid}`);

      if (!children) {
        console.log('[Claude] No child processes found');
        return { success: false, error: 'No child process running' };
      }

      const childPids = children.split('\n').filter(p => p.trim());

      // Find claude process among children
      for (const childPid of childPids) {
        try {
          const processName = await execAsync(`ps -p ${childPid} -o comm=`);
          console.log(`[Claude] PID ${childPid} is: ${processName}`);

          if (!processName.includes('claude')) continue;

          // Get process start time (Unix timestamp)
          const startTimeStr = await execAsync(`ps -p ${childPid} -o lstart=`);
          const processStartTime = new Date(startTimeStr.trim()).getTime();
          console.log(`[Claude] Process start time: ${startTimeStr.trim()} (${processStartTime})`);

          // Get CWD of the claude process
          const cwdResult = await execAsync(`lsof -p ${childPid} | grep cwd | awk '{print $9}'`);
          const claudeCwd = cwdResult.trim();
          console.log(`[Claude] Process CWD: ${claudeCwd}`);

          if (!claudeCwd) continue;

          // Calculate project slug
          const projectSlug = claudeCwd.replace(/\//g, '-');
          const projectDir = path.join(os.homedir(), '.claude', 'projects', projectSlug);
          console.log(`[Claude] Project dir: ${projectDir}`);

          if (!fs.existsSync(projectDir)) {
            console.log('[Claude] Project dir does not exist');
            continue;
          }

          // Find .jsonl files modified AFTER process start
          const files = fs.readdirSync(projectDir)
            .filter(f => f.endsWith('.jsonl'))
            .map(f => {
              const fullPath = path.join(projectDir, f);
              const stat = fs.statSync(fullPath);
              return {
                name: f,
                mtime: stat.mtime.getTime(),
                sessionId: f.replace('.jsonl', '')
              };
            })
            .filter(f => f.mtime >= processStartTime - 5000) // Allow 5s tolerance
            .sort((a, b) => b.mtime - a.mtime);

          console.log(`[Claude] Files modified after process start:`, files.map(f => `${f.sessionId} (${new Date(f.mtime).toISOString()})`));

          if (files.length > 0) {
            const sessionId = files[0].sessionId;
            console.log(`[Claude] ✅ Found active session: ${sessionId}`);
            return { success: true, sessionId, method: 'mtime-after-start' };
          }
        } catch (e) {
          console.log(`[Claude] Error checking PID ${childPid}:`, e.message);
        }
      }
    }

    console.log('[Claude] No active session found');
    return { success: false, error: 'No active Claude session found' };
  } catch (e) {
    console.log('[Claude] Error:', e.message);
    return { success: false, error: e.message };
  }
});

// Check if terminal has running child process (not just idle shell)
ipcMain.handle('terminal:hasRunningProcess', async (event, tabId) => {
  const term = terminals.get(tabId);
  if (!term) return { hasProcess: false };

  try {
    const shellPid = term.pid;

    if (process.platform === 'darwin' || process.platform === 'linux') {
      // Get child processes of the shell (async to not block main process)
      const children = await execAsync(`pgrep -P ${shellPid}`);

      if (children) {
        // Get the name of the first child process
        const childPid = children.split('\n')[0];
        const processName = await execAsync(`ps -p ${childPid} -o comm=`);

        return { hasProcess: true, processName };
      }
    }

    return { hasProcess: false };
  } catch (e) {
    // pgrep returns non-zero if no children - this is normal for idle shell
    return { hasProcess: false };
  }
});

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

// Get active process running in terminal (child of shell)
ipcMain.handle('terminal:getActiveProcess', async (event, tabId) => {
  const term = terminals.get(tabId);
  console.log('[main] terminal:getActiveProcess called, tabId:', tabId);

  if (!term) {
    console.log('[main] ❌ Terminal not found for tabId:', tabId);
    return null;
  }

  const shellPid = term.pid;
  console.log('[main] Shell PID:', shellPid);

  try {
    if (process.platform === 'darwin' || process.platform === 'linux') {
      // Find child processes of the shell (async to not block main process)
      const childPidsRaw = await execAsync(`pgrep -P ${shellPid}`);

      console.log('[main] Child PIDs raw:', childPidsRaw);

      const childPids = childPidsRaw.split('\n').filter(p => p);

      if (childPids.length === 0) {
        console.log('[main] No child processes - shell is idle');
        return null;
      }

      // Get the first child process name
      const firstChildPid = childPids[0];
      const processName = await execAsync(`ps -o comm= -p ${firstChildPid}`);

      console.log('[main] Active process:', processName, '(PID:', firstChildPid + ')');
      return processName;
    }
  } catch (e) {
    // pgrep returns exit code 1 if no processes found - this is normal
    if (e.code === 1 || (e.killed === false && e.signal === null)) {
      console.log('[main] No child processes - shell is idle');
      return null;
    }
    console.error('[main] Error getting active process:', e.message);
  }

  return null;
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
ipcMain.handle('app:getCwd', () => {
  return process.cwd();
});

// List all projects
ipcMain.handle('project:list', () => {
  return Object.values(projectManager.projects);
});

ipcMain.handle('project:save-note', (event, { dirPath, content }) => {
  projectManager.saveProjectNote(dirPath, content);
  return { success: true };
});

ipcMain.handle('project:save-actions', (event, { dirPath, actions }) => {
  projectManager.saveProjectActions(dirPath, actions);
  return { success: true };
});

ipcMain.handle('project:save-tabs', (event, { dirPath, tabs }) => {
  projectManager.saveProjectTabs(dirPath, tabs);
  return { success: true };
});

ipcMain.handle('project:save-metadata', (event, { dirPath, metadata }) => {
  projectManager.saveProjectMetadata(dirPath, metadata);
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
      console.log('[main] ✅ Enter (\\r) sent!');
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
  console.log('[main] ✅ Enter (\\r) sent at', Date.now() - startTime, 'ms');

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

const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

// Sniper Watcher: watch for new .jsonl file creation when claude starts
// This captures the session ID that Claude creates
ipcMain.on('claude:spawn-with-watcher', (event, { tabId, cwd }) => {
  const projectSlug = cwd.replace(/\//g, '-');
  const projectDir = path.join(os.homedir(), '.claude', 'projects', projectSlug);

  console.log('[Sniper] Starting watcher for tab:', tabId);
  console.log('[Sniper] Watching directory:', projectDir);

  const startTime = Date.now();
  let watcher = null;
  let sessionFound = false; // Flag to prevent multiple detections

  const closeWatcher = () => {
    if (watcher) {
      try { watcher.close(); } catch (e) {}
      watcher = null;
      console.log('[Sniper] Watcher closed for tab:', tabId);
    }
  };

  try {
    // Ensure directory exists (Claude may create it)
    if (!fs.existsSync(projectDir)) {
      fs.mkdirSync(projectDir, { recursive: true });
    }

    watcher = fs.watch(projectDir, (eventType, filename) => {
      // Already found a session - ignore all further events
      if (sessionFound) return;

      // Only care about UUID format .jsonl files (ignore agent-* files)
      if (!filename || !filename.endsWith('.jsonl')) return;

      // UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.jsonl
      const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;
      if (!uuidPattern.test(filename)) {
        console.log('[Sniper] Ignoring non-UUID file:', filename);
        return;
      }

      const filePath = path.join(projectDir, filename);

      // Check if file is fresh (created after our start time)
      fs.stat(filePath, (err, stats) => {
        if (err || sessionFound) return;

        // Check birthtime with 500ms tolerance
        const fileTime = stats.birthtimeMs || stats.mtimeMs;
        if (fileTime >= startTime - 500) {
          sessionFound = true; // Lock - no more detections
          const sessionId = filename.replace('.jsonl', '');
          console.log('[Sniper] ✅ Caught session:', sessionId);

          // Send session ID back to renderer
          event.sender.send('claude:session-detected', { tabId, sessionId });

          // Mission complete, close watcher
          closeWatcher();
        }
      });
    });

    // Safety timeout: close watcher after 5 seconds
    setTimeout(() => {
      if (!sessionFound) {
        console.log('[Sniper] Timeout - no session detected for tab:', tabId);
      }
      closeWatcher();
    }, 5000);

  } catch (e) {
    console.error('[Sniper] Error setting up watcher:', e.message);
  }

  // Let the command through - don't intercept, just watch
  const term = terminals.get(tabId);
  if (term) {
    term.write('claude\r');
  }
});

// Fork Claude session: copy .jsonl file with new UUID, signal renderer to create new tab (legacy)
// Fork Claude session file: copy .jsonl with new UUID
ipcMain.handle('claude:fork-session-file', async (event, { sourceSessionId, cwd }) => {
  console.log('[Claude Fork] Copying session:', sourceSessionId);

  try {
    const projectSlug = cwd.replace(/\//g, '-');
    const projectDir = path.join(os.homedir(), '.claude', 'projects', projectSlug);

    // Generate new UUID
    const newSessionId = crypto.randomUUID();
    console.log('[Claude Fork] New session ID:', newSessionId);

    const sourcePath = path.join(projectDir, `${sourceSessionId}.jsonl`);
    const destPath = path.join(projectDir, `${newSessionId}.jsonl`);

    if (!fs.existsSync(sourcePath)) {
      console.error('[Claude Fork] Source file not found:', sourcePath);
      return { success: false, error: 'Session file not found: ' + sourceSessionId };
    }

    // Check source file is not empty
    const stats = fs.statSync(sourcePath);
    if (stats.size === 0) {
      console.error('[Claude Fork] Source file is empty:', sourcePath);
      return { success: false, error: 'Source session is empty' };
    }

    // Copy the file
    fs.copyFileSync(sourcePath, destPath);
    console.log('[Claude Fork] Copied:', sourcePath, '->', destPath);

    // Wait for Claude to index the new file
    await new Promise(resolve => setTimeout(resolve, 500));

    return { success: true, newSessionId };
  } catch (error) {
    console.error('[Claude Fork] Error:', error);
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
