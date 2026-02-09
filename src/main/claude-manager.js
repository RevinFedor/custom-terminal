const { ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { exec } = require('child_process');

// Helper: async exec with timeout (increased default for heavy ops)
const execAsync = (cmd, timeout = 5000) => {
  return new Promise((resolve, reject) => {
    exec(cmd, { encoding: 'utf-8', timeout, maxBuffer: 1024 * 1024 }, (err, stdout) => {
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
    // Get Claude session ID — recursive process tree + multi-method session detection
    ipcMain.handle('terminal:getClaudeSession', async (event, tabId) => {
      const term = this.terminals.get(tabId);
      if (!term) {
        console.log('[ClaudeDetect] ❌ Terminal not found for tab:', tabId);
        return { success: false, error: 'Terminal not found' };
      }

      try {
        const shellPid = term.pid;
        console.log('[ClaudeDetect] ========== START ==========');
        console.log('[ClaudeDetect] Tab:', tabId, '| Shell PID:', shellPid);

        // ── Step 1: Build full process tree via single ps call ──
        console.log('[ClaudeDetect] Step 1: Building process tree...');
        const psRaw = await execAsync('ps -eo pid=,ppid=');
        const childrenMap = new Map(); // ppid → [pid, ...]

        for (const line of psRaw.split('\n')) {
          const parts = line.trim().split(/\s+/);
          if (parts.length < 2) continue;
          const [pid, ppid] = parts.map(Number);
          if (!childrenMap.has(ppid)) childrenMap.set(ppid, []);
          childrenMap.get(ppid).push(pid);
        }

        // BFS to find all descendants
        const descendants = [];
        const queue = [shellPid];
        while (queue.length > 0) {
          const current = queue.shift();
          const kids = childrenMap.get(current) || [];
          for (const kid of kids) {
            descendants.push(kid);
            queue.push(kid);
          }
        }

        console.log('[ClaudeDetect] Descendants of shell ' + shellPid + ':', descendants);

        if (descendants.length === 0) {
          console.log('[ClaudeDetect] ❌ No descendants found — shell is idle');
          return { success: false, error: 'No child processes running' };
        }

        // ── Step 2: Find claude process among ALL descendants ──
        console.log('[ClaudeDetect] Step 2: Looking for Claude process...');
        const pids = descendants.join(',');
        let commRaw;
        try {
          commRaw = await execAsync('ps -o pid=,comm= -p ' + pids);
        } catch (e) {
          console.log('[ClaudeDetect] ❌ ps comm failed:', e.message);
          return { success: false, error: 'Failed to get process names' };
        }

        let claudePid = null;
        let claudeComm = null;

        // First pass: look for 'claude' in comm
        for (const line of commRaw.split('\n')) {
          const match = line.trim().match(/^(\d+)\s+(.+)$/);
          if (!match) continue;
          const [, pidStr, comm] = match;
          const basename = comm.split('/').pop();
          console.log('[ClaudeDetect]   PID ' + pidStr + ' → ' + basename);
          if (basename === 'claude' || basename.startsWith('claude')) {
            claudePid = Number(pidStr);
            claudeComm = basename;
            break;
          }
        }

        // Second pass: check node processes for claude in args
        if (!claudePid) {
          console.log('[ClaudeDetect] No direct claude binary found, checking node processes...');
          for (const line of commRaw.split('\n')) {
            const match = line.trim().match(/^(\d+)\s+(.+)$/);
            if (!match) continue;
            const [, pidStr, comm] = match;
            if (comm.split('/').pop() === 'node') {
              try {
                const args = await execAsync('ps -p ' + pidStr + ' -o args=');
                console.log('[ClaudeDetect]   Node PID ' + pidStr + ' args: ' + args.substring(0, 100));
                if (args.includes('claude')) {
                  claudePid = Number(pidStr);
                  claudeComm = 'node(claude)';
                  break;
                }
              } catch { /* skip */ }
            }
          }
        }

        if (!claudePid) {
          console.log('[ClaudeDetect] ❌ No Claude process found in tree');
          return { success: false, error: 'Claude process not found in process tree' };
        }

        console.log('[ClaudeDetect] ✓ Found Claude: PID ' + claudePid + ' (' + claudeComm + ')');

        // ── Step 3: Get CWD of Claude process ──
        console.log('[ClaudeDetect] Step 3: Getting CWD...');
        let claudeCwd = '';
        try {
          claudeCwd = await execAsync('lsof -p ' + claudePid + ' | grep cwd | awk \'{print ' + '\$' + '9}\'', 3000);
        } catch (e) {
          console.log('[ClaudeDetect] lsof on Claude PID failed:', e.message);
        }

        // Fallback: CWD of shell
        if (!claudeCwd) {
          console.log('[ClaudeDetect] Falling back to shell CWD...');
          try {
            claudeCwd = await execAsync('lsof -p ' + shellPid + ' | grep cwd | awk \'{print ' + '\$' + '9}\'', 3000);
          } catch (e) {
            console.log('[ClaudeDetect] ❌ Shell CWD also failed:', e.message);
            return { success: false, error: 'Cannot determine CWD' };
          }
        }

        if (!claudeCwd) {
          console.log('[ClaudeDetect] ❌ CWD is empty');
          return { success: false, error: 'CWD is empty' };
        }

        console.log('[ClaudeDetect] CWD:', claudeCwd);

        const projectSlug = claudeCwd.replace(/\//g, '-');
        const projectDir = path.join(os.homedir(), '.claude', 'projects', projectSlug);
        console.log('[ClaudeDetect] Project dir:', projectDir);

        if (!fs.existsSync(projectDir)) {
          console.log('[ClaudeDetect] ❌ Project dir does not exist');
          return { success: false, error: 'Project dir not found: ' + projectDir };
        }

        // ── Step 4A: sessions-index.json (fast path) ──
        console.log('[ClaudeDetect] Step 4A: Checking sessions-index.json...');
        const indexPath = path.join(projectDir, 'sessions-index.json');
        try {
          if (fs.existsSync(indexPath)) {
            const indexData = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
            const sessions = Array.isArray(indexData) ? indexData : Object.values(indexData);
            console.log('[ClaudeDetect] sessions-index.json has', sessions.length, 'entries');

            if (sessions.length > 0) {
              const sorted = sessions
                .filter(s => s.sessionId || s.id)
                .sort((a, b) => {
                  const ta = new Date(b.modified || b.lastModified || b.updatedAt || 0).getTime();
                  const tb = new Date(a.modified || a.lastModified || a.updatedAt || 0).getTime();
                  return ta - tb;
                });

              if (sorted.length > 0) {
                const best = sorted[0];
                const sessionId = best.sessionId || best.id;
                const jsonlPath = path.join(projectDir, sessionId + '.jsonl');
                if (fs.existsSync(jsonlPath)) {
                  const stat = fs.statSync(jsonlPath);
                  const ageMs = Date.now() - stat.mtime.getTime();
                  console.log('[ClaudeDetect] Best from index:', sessionId, '| age:', Math.round(ageMs / 1000) + 's');
                  if (ageMs < 120000) { // modified <2min ago
                    console.log('[ClaudeDetect] ✅ Found via sessions-index.json:', sessionId);
                    return { success: true, sessionId, method: 'sessions-index', claudePid };
                  }
                }
              }
            }
          } else {
            console.log('[ClaudeDetect] sessions-index.json does not exist');
          }
        } catch (e) {
          console.log('[ClaudeDetect] sessions-index.json parse error:', e.message);
        }

        // ── Step 4B: lsof open .jsonl files (Claude keeps session file open) ──
        console.log('[ClaudeDetect] Step 4B: Checking lsof for open .jsonl files...');
        try {
          const lsofOut = await execAsync('lsof -p ' + claudePid + ' 2>/dev/null | grep .jsonl', 3000);
          if (lsofOut) {
            console.log('[ClaudeDetect] lsof .jsonl output:', lsofOut);
            for (const line of lsofOut.split('\n')) {
              // Extract file path — last column in lsof output
              const parts = line.trim().split(/\s+/);
              const filePath = parts[parts.length - 1];
              if (filePath && filePath.endsWith('.jsonl')) {
                const sessionId = path.basename(filePath, '.jsonl');
                console.log('[ClaudeDetect] ✅ Found via lsof open file:', sessionId);
                return { success: true, sessionId, method: 'lsof-openfile', claudePid };
              }
            }
          } else {
            console.log('[ClaudeDetect] No open .jsonl files found via lsof');
          }
        } catch (e) {
          console.log('[ClaudeDetect] lsof .jsonl failed:', e.message);
        }

        // ── Step 4C: mtime fallback — find recently modified files (macOS) ──
        console.log('[ClaudeDetect] Step 4C: mtime fallback (find recent .jsonl)...');
        try {
          // macOS: use stat -f '%m %N' for epoch + filename
          const findOut = await execAsync(
            'find "' + projectDir + '" -maxdepth 1 -name "*.jsonl" -mmin -5 -exec stat -f "%m %N" {} \\; 2>/dev/null | sort -rn | head -5',
            5000
          );

          if (findOut) {
            const lines = findOut.split('\n').filter(Boolean);
            console.log('[ClaudeDetect] Recent files (last 5min):', lines.length);
            for (const line of lines) {
              console.log('[ClaudeDetect]   ', line);
            }
            if (lines.length > 0) {
              const firstLine = lines[0];
              const filePath = firstLine.split(/\s+/).slice(1).join(' ');
              const sessionId = path.basename(filePath, '.jsonl');
              console.log('[ClaudeDetect] ✅ Found via mtime fallback:', sessionId);
              return { success: true, sessionId, method: 'mtime-fallback', claudePid };
            }
          } else {
            console.log('[ClaudeDetect] No .jsonl files modified in last 5 minutes');
          }
        } catch (e) {
          console.log('[ClaudeDetect] find fallback error:', e.message);
        }

        console.log('[ClaudeDetect] ❌ All methods exhausted — no session found');
        console.log('[ClaudeDetect] See docs/knowledge/claude-session-detection.md for research on this limitation');
        return { success: false, error: 'Session file not found (all 3 methods failed)' };
      } catch (e) {
        console.log('[ClaudeDetect] ❌ Fatal error:', e.message);
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
