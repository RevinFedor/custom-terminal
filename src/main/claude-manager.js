const { ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { exec } = require('child_process');

// Helper: async exec with timeout
const execAsync = (cmd, timeout = 1000) => {
  return new Promise((resolve, reject) => {
    const child = exec(cmd, { encoding: 'utf-8', timeout }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
};

class ClaudeManager {
  constructor(terminals, terminalProjects, claudeState) {
    this.terminals = terminals;
    this.terminalProjects = terminalProjects;
    this.claudeState = claudeState; // State machine for thinking mode handshake
    this.registerHandlers();
  }

  registerHandlers() {
    // Get Claude session ID by finding recently modified .jsonl file for this process
    ipcMain.handle('terminal:getClaudeSession', async (event, tabId) => {
      const term = this.terminals.get(tabId);
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
      const term = this.terminals.get(tabId);
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

    // Get active process running in terminal (child of shell)
    ipcMain.handle('terminal:getActiveProcess', async (event, tabId) => {
      const term = this.terminals.get(tabId);
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

    // Fork Claude session file: copy .jsonl with new UUID
    ipcMain.handle('claude:fork-session-file', async (event, { sourceSessionId, cwd }) => {
      console.log('[Claude Fork] ========================================');
      console.log('[Claude Fork] Copying session:', sourceSessionId);
      console.log('[Claude Fork] Current cwd:', cwd);

      try {
        const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');
        console.log('[Claude Fork] Claude projects dir:', claudeProjectsDir);

        // Find session file across ALL project directories
        let sourcePath = null;
        let projectDir = null;

        // First, try the cwd-based path (most likely)
        const projectSlug = cwd.replace(/\//g, '-');
        const primaryDir = path.join(claudeProjectsDir, projectSlug);
        const primaryPath = path.join(primaryDir, `${sourceSessionId}.jsonl`);

        if (fs.existsSync(primaryPath)) {
          sourcePath = primaryPath;
          projectDir = primaryDir;
          console.log('[Claude Fork] Found in primary location:', sourcePath);
        } else {
          // Search all project directories
          console.log('[Claude Fork] Not in primary location, searching ALL projects...');
          if (fs.existsSync(claudeProjectsDir)) {
            const projectDirs = fs.readdirSync(claudeProjectsDir, { withFileTypes: true })
              .filter(dirent => dirent.isDirectory())
              .map(dirent => dirent.name);

            for (const dir of projectDirs) {
              const checkPath = path.join(claudeProjectsDir, dir, `${sourceSessionId}.jsonl`);
              const exists = fs.existsSync(checkPath);
              if (exists) {
                sourcePath = checkPath;
                projectDir = path.join(claudeProjectsDir, dir);
                console.log('[Claude Fork] ✓ FOUND in:', sourcePath);
                break;
              }
            }
          } else {
            console.log('[Claude Fork] ERROR: Claude projects dir does not exist!');
          }
        }

        if (!sourcePath) {
          console.error('[Claude Fork] ✗ Source file not found in ANY project directory');
          return { success: false, error: 'Session file not found: ' + sourceSessionId };
        }

        // Generate new UUID
        const newSessionId = crypto.randomUUID();
        console.log('[Claude Fork] New session ID:', newSessionId);

        const destPath = path.join(projectDir, `${newSessionId}.jsonl`);

        if (!fs.existsSync(sourcePath)) {
          return { success: false, error: 'Session file not found: ' + sourceSessionId };
        }

        // Check source file is not empty
        const stats = fs.statSync(sourcePath);
        if (stats.size === 0) {
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
      try {
        const newSessionId = crypto.randomUUID();
        const projectSlug = cwd.replace(/\//g, '-');
        const projectDir = path.join(os.homedir(), '.claude', 'projects', projectSlug);

        if (existingSessionId) {
          const oldPath = path.join(projectDir, `${existingSessionId}.jsonl`);
          const newPath = path.join(projectDir, `${newSessionId}.jsonl`);

          if (fs.existsSync(oldPath)) {
            fs.copyFileSync(oldPath, newPath);
            console.log('[Claude Fork] Copied session file:', oldPath, '->', newPath);
          }
        }

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

  }
}

module.exports = ClaudeManager;
