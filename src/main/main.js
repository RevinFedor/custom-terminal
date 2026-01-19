const { app, BrowserWindow, ipcMain, Menu, dialog } = require('electron');
const path = require('path');
const pty = require('node-pty');
const projectManager = require('./project-manager');
const SessionManager = require('./session-manager');

const isDev = process.env.NODE_ENV === 'development';

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
    const devIconPath = path.join(__dirname, 'build-resources', 'icon-dev.png');
    if (require('fs').existsSync(devIconPath)) {
      app.dock.setIcon(devIconPath);
    }
  }

  mainWindow.loadFile('index.html');
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
    console.log('[main] terminal:create called with tabId:', tabId, 'cwd:', cwd);
    const shell = process.env.SHELL || '/bin/bash';
    const workingDir = cwd || process.env.HOME;

    const ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: cols || 80,
      rows: rows || 24,
      cwd: workingDir,
      env: process.env
    });

    console.log('[main] PTY spawned, PID:', ptyProcess.pid);

    terminals.set(tabId, ptyProcess);
    terminalProjects.set(tabId, workingDir);
    console.log('[main] Stored terminal with tabId:', tabId);

    ptyProcess.onData((data) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        console.log('[main] PTY data received for tabId:', tabId, 'length:', data.length);
        mainWindow.webContents.send('terminal:data', { pid: ptyProcess.pid, tabId, data });
      }
    });

    ptyProcess.onExit((exitCode) => {
      console.log('[main] PTY exited, tabId:', tabId, 'exitCode:', exitCode);
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
  console.log('[main] terminal:input received, tabId:', tabId, 'data:', data.substring(0, 20));
  const term = terminals.get(tabId);
  if (term) {
    console.log('[main] Writing to PTY...');
    term.write(data);
  } else {
    console.error('[main] Terminal not found for tabId:', tabId);
    console.log('[main] Available terminals:', Array.from(terminals.keys()));
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
        console.log('[main] Got cwd for', tabId, ':', result);
        return result;
      }
    } else if (process.platform === 'linux') {
      // Linux: read /proc/<pid>/cwd symlink
      const fs = require('fs');
      const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
      console.log('[main] Got cwd for', tabId, ':', cwd);
      return cwd;
    }
  } catch (e) {
    console.error('[main] Failed to get cwd:', e.message);
  }

  // Fallback to stored cwd
  return terminalProjects.get(tabId) || null;
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

// Execute quick action command in terminal
ipcMain.on('terminal:executeCommand', (event, tabId, command) => {
  console.log('[main] ===== EXECUTE COMMAND =====');
  console.log('[main] tabId:', tabId);
  console.log('[main] command:', JSON.stringify(command));
  console.log('[main] command length:', command.length);

  const term = terminals.get(tabId);
  if (term) {
    // Try sending command in parts
    console.log('[main] Step 1: Writing command text...');
    term.write(command);

    console.log('[main] Step 2: Sending Enter (\\r)...');
    term.write('\r');

    console.log('[main] ✅ Command + Enter sent to PTY');
    console.log('[main] PTY process PID:', term.pid);
  } else {
    console.error('[main] ❌ Terminal not found for tabId:', tabId);
    console.log('[main] Available terminals:', Array.from(terminals.keys()));
  }
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
ipcMain.handle('session:export-gemini', async (event, { dirPath, sessionKey }) => {
  try {
    const result = await sessionManager.exportGeminiSession(dirPath, sessionKey);
    return result;
  } catch (error) {
    console.error('[main] Error exporting Gemini session:', error);
    return { success: false, message: error.message };
  }
});

// Import Gemini session
ipcMain.handle('session:import-gemini', async (event, { dirPath, sessionKey, tabId }) => {
  try {
    // Helper function to send commands to PTY
    const sendCommand = (tid, cmd) => {
      const term = terminals.get(tid);
      if (term) {
        term.write(cmd + '\r');
      }
    };

    const result = await sessionManager.importGeminiSession(dirPath, sessionKey, sendCommand, tabId);
    return result;
  } catch (error) {
    console.error('[main] Error importing Gemini session:', error);
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

// List all sessions for a project
ipcMain.handle('session:list', async (event, { dirPath, toolType }) => {
  try {
    const sessions = sessionManager.listSessions(dirPath, toolType);
    return { success: true, data: sessions };
  } catch (error) {
    console.error('[main] Error listing sessions:', error);
    return { success: false, error: error.message };
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
