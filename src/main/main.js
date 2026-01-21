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
    width: 1200,
    height: 800,
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
    const shell = process.env.SHELL || '/bin/bash';
    const workingDir = cwd || process.env.HOME;

    const ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: cols || 80,
      rows: rows || 24,
      cwd: workingDir,
      env: process.env
    });


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

    return { pid: ptyProcess.pid, cwd: workingDir };
  });

// Send input to terminal
ipcMain.on('terminal:input', (event, tabId, data) => {
  const term = terminals.get(tabId);
  if (term) {
    term.write(data);
  } else {
    console.error('[main] Terminal not found for tabId:', tabId);
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

// Check if terminal has running child process (not just idle shell)
ipcMain.handle('terminal:hasRunningProcess', async (event, tabId) => {
  const term = terminals.get(tabId);
  if (!term) return { hasProcess: false };

  try {
    const { execSync } = require('child_process');
    const shellPid = term.pid;

    if (process.platform === 'darwin' || process.platform === 'linux') {
      // Get child processes of the shell
      const children = execSync(`pgrep -P ${shellPid}`, {
        encoding: 'utf-8',
        timeout: 1000
      }).trim();

      if (children) {
        // Get the name of the first child process
        const childPid = children.split('\n')[0];
        const processName = execSync(`ps -p ${childPid} -o comm=`, {
          encoding: 'utf-8',
          timeout: 1000
        }).trim();

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
    const { execSync } = require('child_process');

    // Get child process of shell (the actual foreground process)
    // First try to get the shell's cwd directly
    const pid = term.pid;

    if (process.platform === 'darwin') {
      // macOS: use lsof to get cwd
      const result = execSync(`lsof -p ${pid} | grep cwd | awk '{print $9}'`, {
        encoding: 'utf-8',
        timeout: 1000
      }).trim();

      if (result) {
        return result;
      }
    } else if (process.platform === 'linux') {
      // Linux: read /proc/<pid>/cwd symlink
      const fs = require('fs');
      const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
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
    const { execSync } = require('child_process');

    if (process.platform === 'darwin' || process.platform === 'linux') {
      // Find child processes of the shell
      const childPidsRaw = execSync(`pgrep -P ${shellPid}`, {
        encoding: 'utf-8',
        timeout: 1000
      }).trim();

      console.log('[main] Child PIDs raw:', childPidsRaw);

      const childPids = childPidsRaw.split('\n').filter(p => p);

      if (childPids.length === 0) {
        console.log('[main] No child processes - shell is idle');
        return null;
      }

      // Get the first child process name
      const firstChildPid = childPids[0];
      const processName = execSync(`ps -o comm= -p ${firstChildPid}`, {
        encoding: 'utf-8',
        timeout: 1000
      }).trim();

      console.log('[main] Active process:', processName, '(PID:', firstChildPid + ')');
      return processName;
    }
  } catch (e) {
    // pgrep returns exit code 1 if no processes found - this is normal
    if (e.status === 1) {
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

// Export Claude session
ipcMain.handle('session:export-claude', async (event, { dirPath, sessionKey }) => {
  try {
    const result = await sessionManager.exportClaudeSession(dirPath, sessionKey);
    return result;
  } catch (error) {
    console.error('[main] Error exporting Claude session:', error);
    return { success: false, message: error.message };
  }
});

// Import Claude session
ipcMain.handle('session:import-claude', async (event, { dirPath, sessionKey }) => {
  try {
    const result = await sessionManager.importClaudeSession(dirPath, sessionKey);
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
