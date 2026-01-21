const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

/**
 * SessionManager - Unified session persistence for Gemini CLI and Claude Code
 *
 * Architecture:
 * - Visual Layer: xterm buffer serialization (handled by renderer)
 * - Brain Layer: AI context persistence (handled here)
 */
class SessionManager {
  constructor(database) {
    this.db = database;
  }

  // ========== GEMINI CLI ==========

  /**
   * List available Gemini checkpoints from filesystem
   * @param {string} projectPath - Current project path
   * @returns {Promise<string[]>} - Array of checkpoint names
   */
  async listAvailableGeminiCheckpoints(projectPath) {
    try {
      const normalizedPath = path.resolve(projectPath);
      const dirHash = this.calculateGeminiHash(normalizedPath);
      const geminiTmpDir = path.join(os.homedir(), '.gemini', 'tmp', dirHash);

      if (!fs.existsSync(geminiTmpDir)) {
        return [];
      }

      const files = fs.readdirSync(geminiTmpDir);
      const checkpoints = files
        .filter(f => f.startsWith('checkpoint-') && f.endsWith('.json'))
        .map(f => f.replace('checkpoint-', '').replace('.json', ''));

      return checkpoints;
    } catch (error) {
      console.error('[SessionManager] Error listing checkpoints:', error);
      return [];
    }
  }

  /**
   * Export Gemini session
   * @param {string} dirPath - Current tab working directory (where Gemini saved checkpoint)
   * @param {string} sessionKey - Tag name for the checkpoint
   * @param {string} projectPath - Project root path (for DB organization, optional - defaults to dirPath)
   * @returns {Promise<{success: boolean, message: string}>}
   */
  async exportGeminiSession(dirPath, sessionKey, projectPath = null) {

    try {
      const normalizedCwd = path.resolve(dirPath);
      const normalizedProject = projectPath ? path.resolve(projectPath) : normalizedCwd;

      // Calculate directory hash (SHA-256 of tab cwd - this is what Gemini uses)
      const dirHash = this.calculateGeminiHash(normalizedCwd);

      // Find checkpoint file
      const geminiTmpDir = path.join(os.homedir(), '.gemini', 'tmp', dirHash);

      const checkpointPattern = `checkpoint-${sessionKey}.json`;
      const checkpointPath = path.join(geminiTmpDir, checkpointPattern);

      console.log('[SessionManager] Looking for checkpoint at:', checkpointPath);

      if (!fs.existsSync(checkpointPath)) {
        // List available checkpoints for debugging
        if (fs.existsSync(geminiTmpDir)) {
          const files = fs.readdirSync(geminiTmpDir).filter(f => f.startsWith('checkpoint-'));
          console.log('[SessionManager] Available checkpoints:', files);
        }
        return {
          success: false,
          message: `Checkpoint "${sessionKey}" not found. Run "/chat save ${sessionKey}" first.`
        };
      }

      // Read checkpoint content
      const checkpointContent = fs.readFileSync(checkpointPath, 'utf-8');

      // Save to database
      // - projectPath for organization (which project this belongs to)
      // - original_cwd = dirPath (where checkpoint was created, for import patching)
      const sessionId = this.db.saveAISession(
        normalizedProject,    // project for DB organization
        'gemini',
        sessionKey,
        checkpointContent,
        normalizedCwd,        // original_cwd = tab cwd where checkpoint was created
        dirHash
      );

      return {
        success: true,
        message: `Gemini session "${sessionKey}" exported successfully`
      };
    } catch (error) {
      console.error('[SessionManager] ❌ Export failed:', error);
      return {
        success: false,
        message: `Export failed: ${error.message}`
      };
    }
  }

  /**
   * Import Gemini session using "Trojan Horse" method
   *
   * Flow:
   * 1. Return commands to: start gemini, send message, /chat save <tag>
   * 2. After Gemini creates the checkpoint file, we overwrite it with our content
   * 3. Then /chat resume <tag> will load our patched session
   *
   * @param {string} targetCwd - Target directory where to restore (tab cwd)
   * @param {string} sessionKey - Tag name to restore
   * @param {number} sessionId - Session ID (for cross-project import)
   * @returns {Promise<{success: boolean, message: string, patchData: object}>}
   */
  async importGeminiSession(targetCwd, sessionKey, sendCommand, tabId, sessionId = null) {

    try {
      const normalizedTarget = path.resolve(targetCwd);

      // Get session from database - try by ID first (cross-project), then by key
      let session;
      if (sessionId) {
        session = this.db.getAISessionById(sessionId);
      }
      if (!session) {
        // Fallback: search globally by session_key
        const allSessions = this.db.getAllAISessions('gemini');
        session = allSessions.find(s => s.session_key === sessionKey);
      }

      if (!session) {
        return {
          success: false,
          message: `Session "${sessionKey}" not found in database.`
        };
      }

      console.log('[SessionManager] Preparing Trojan Horse import:', session.session_key);
      console.log('[SessionManager] From:', session.original_cwd, 'To:', normalizedTarget);

      // Calculate new hash for target directory
      const newHash = this.calculateGeminiHash(normalizedTarget);

      // Patch the saved session content
      let patchedContent = session.content_blob;

      // Replace old path with new path
      if (session.original_cwd !== normalizedTarget) {
        patchedContent = patchedContent.replace(
          new RegExp(session.original_cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
          normalizedTarget
        );
      }

      // Replace old hash with new hash
      if (session.original_hash && session.original_hash !== newHash) {
        patchedContent = patchedContent.replace(
          new RegExp(session.original_hash, 'g'),
          newHash
        );
      }

      // Record this deployment (if different from original)
      if (session.original_cwd !== normalizedTarget) {
        this.db.addSessionDeployment(session.id, normalizedTarget, newHash);
        console.log('[SessionManager] Added deployment record for:', normalizedTarget);
      }

      // Return data for Trojan Horse method
      // The renderer will:
      // 1. Start Gemini
      // 2. Send a dummy message
      // 3. /chat save <tag> - creates shell checkpoint
      // 4. Call session:patch-checkpoint to overwrite with our content
      // 5. /chat resume <tag> - loads our patched session
      return {
        success: true,
        message: `Trojan Horse prepared for "${sessionKey}"`,
        trojanHorse: true,
        patchData: {
          targetCwd: normalizedTarget,
          targetHash: newHash,
          sessionKey: sessionKey,
          patchedContent: patchedContent
        }
      };
    } catch (error) {
      console.error('[SessionManager] ❌ Import failed:', error);
      return {
        success: false,
        message: `Import failed: ${error.message}`
      };
    }
  }

  /**
   * Patch checkpoint file (Phase 2 of Trojan Horse)
   * Called after Gemini CLI creates the checkpoint file
   */
  patchCheckpointFile(targetCwd, sessionKey, patchedContent) {
    try {
      const normalizedTarget = path.resolve(targetCwd);
      const targetHash = this.calculateGeminiHash(normalizedTarget);
      const geminiTmpDir = path.join(os.homedir(), '.gemini', 'tmp', targetHash);
      const checkpointPath = path.join(geminiTmpDir, `checkpoint-${sessionKey}.json`);

      console.log('[SessionManager] Patching checkpoint at:', checkpointPath);

      if (!fs.existsSync(checkpointPath)) {
        return { success: false, message: 'Checkpoint file not found. Gemini may not have created it yet.' };
      }

      // Overwrite with our patched content
      fs.writeFileSync(checkpointPath, patchedContent, 'utf-8');
      console.log('[SessionManager] ✅ Checkpoint patched successfully');

      return { success: true };
    } catch (error) {
      console.error('[SessionManager] ❌ Patch failed:', error);
      return { success: false, message: error.message };
    }
  }

  /**
   * Delete a deployment (checkpoint file) from a specific location
   * @param {number} sessionId - Session ID in database
   * @param {string} sessionKey - Tag name
   * @param {string} deployedCwd - Directory where checkpoint was deployed
   * @returns {{success: boolean, message?: string}}
   */
  deleteDeployment(sessionId, sessionKey, deployedCwd) {
    try {
      const normalizedCwd = path.resolve(deployedCwd);
      const hash = this.calculateGeminiHash(normalizedCwd);
      const checkpointPath = path.join(os.homedir(), '.gemini', 'tmp', hash, `checkpoint-${sessionKey}.json`);

      console.log('[SessionManager] Deleting deployment:', checkpointPath);

      // Delete the checkpoint file if it exists
      if (fs.existsSync(checkpointPath)) {
        fs.unlinkSync(checkpointPath);
        console.log('[SessionManager] ✅ Checkpoint file deleted');
      } else {
        console.log('[SessionManager] ⚠️ Checkpoint file not found (already deleted?)');
      }

      // Remove from session_deployments table
      // Note: If this is the original_cwd, we don't remove from ai_sessions - just the file
      this.db.removeSessionDeployment(sessionId, normalizedCwd);

      return { success: true };
    } catch (error) {
      console.error('[SessionManager] ❌ Delete deployment failed:', error);
      return { success: false, message: error.message };
    }
  }

  /**
   * Calculate Gemini directory hash (SHA-256)
   */
  calculateGeminiHash(dirPath) {
    const normalizedPath = path.resolve(dirPath);
    return crypto.createHash('sha256').update(normalizedPath).digest('hex');
  }

  // ========== CLAUDE CODE ==========

  /**
   * Calculate Claude project slug from path
   * Example: /Users/fedor/Desktop/custom-terminal -> -Users-fedor-Desktop-custom-terminal
   */
  calculateClaudeSlug(dirPath) {
    const normalizedPath = path.resolve(dirPath);
    return normalizedPath.replace(/\//g, '-');
  }

  /**
   * Export Claude session (JSONL extraction)
   * Uses explicit sessionId detected from terminal output (Output Sniffing)
   *
   * @param {string} projectPath - Current project path (tab cwd)
   * @param {string} sessionId - Claude session UUID (detected from "Starting/Resuming session <UUID>")
   * @param {string} customName - Optional custom name for the session
   * @returns {Promise<{success: boolean, message: string}>}
   */
  async exportClaudeSession(projectPath, sessionId, customName = null) {
    try {
      const normalizedPath = path.resolve(projectPath);
      const projectSlug = this.calculateClaudeSlug(normalizedPath);
      const claudeProjectDir = path.join(os.homedir(), '.claude', 'projects', projectSlug);

      console.log('[SessionManager] Exporting Claude session:', sessionId);
      console.log('[SessionManager] Project path:', normalizedPath);
      console.log('[SessionManager] Looking in:', claudeProjectDir);

      if (!fs.existsSync(claudeProjectDir)) {
        return {
          success: false,
          message: `Claude project directory not found: ${claudeProjectDir}`
        };
      }

      // If no sessionId provided, fallback to most recent file (legacy behavior)
      let targetSessionId = sessionId;
      let sessionFile;

      if (!targetSessionId) {
        console.log('[SessionManager] No sessionId provided, falling back to most recent file');
        const files = fs.readdirSync(claudeProjectDir)
          .filter(f => f.endsWith('.jsonl'))
          .map(f => ({
            name: f,
            path: path.join(claudeProjectDir, f),
            mtime: fs.statSync(path.join(claudeProjectDir, f)).mtime
          }))
          .sort((a, b) => b.mtime - a.mtime);

        if (files.length === 0) {
          return {
            success: false,
            message: 'No Claude session files found. Start a Claude session first.'
          };
        }

        targetSessionId = path.basename(files[0].name, '.jsonl');
        sessionFile = files[0].path;
        console.log('[SessionManager] Auto-detected session:', targetSessionId);
      } else {
        sessionFile = path.join(claudeProjectDir, `${targetSessionId}.jsonl`);
      }

      if (!fs.existsSync(sessionFile)) {
        // List available sessions for debugging
        const available = fs.readdirSync(claudeProjectDir)
          .filter(f => f.endsWith('.jsonl'))
          .map(f => path.basename(f, '.jsonl'));
        console.log('[SessionManager] Available sessions:', available);

        return {
          success: false,
          message: `Session file not found: ${targetSessionId}.jsonl`
        };
      }

      // Read session content
      const sessionContent = fs.readFileSync(sessionFile, 'utf-8');

      // Use custom name or UUID as session key
      const sessionKey = customName || targetSessionId;

      // Save to database
      this.db.saveAISession(
        normalizedPath,
        'claude',
        sessionKey,
        sessionContent,
        normalizedPath,
        targetSessionId // Store original UUID for resume
      );

      console.log('[SessionManager] ✅ Claude session exported:', sessionKey);

      return {
        success: true,
        message: `Claude session "${sessionKey}" exported successfully`,
        sessionId: targetSessionId
      };
    } catch (error) {
      console.error('[SessionManager] ❌ Export failed:', error);
      return {
        success: false,
        message: `Export failed: ${error.message}`
      };
    }
  }

  /**
   * Import Claude session (JSONL injection)
   * Patches paths and prepares for explicit --resume <UUID>
   *
   * @param {string} targetCwd - Target directory where to restore (tab cwd)
   * @param {string} sessionKey - Session key in database
   * @param {number} sessionId - Optional session ID for cross-project import
   * @returns {Promise<{success: boolean, message: string, resumeCommand: string}>}
   */
  async importClaudeSession(targetCwd, sessionKey, sessionId = null) {
    try {
      const normalizedTarget = path.resolve(targetCwd);

      console.log('[SessionManager] Importing Claude session:', sessionKey);
      console.log('[SessionManager] Target path:', normalizedTarget);

      // Get session from database - try by ID first (cross-project), then by key
      let session;
      if (sessionId) {
        session = this.db.getAISessionById(sessionId);
      }
      if (!session) {
        // Fallback: search globally by session_key
        const allSessions = this.db.getAllAISessions('claude');
        session = allSessions.find(s => s.session_key === sessionKey);
      }

      if (!session) {
        return {
          success: false,
          message: `Session "${sessionKey}" not found in database`
        };
      }

      // Get the original UUID (stored in original_hash field for Claude)
      // This is the actual UUID needed for --resume
      const originalUUID = session.original_hash || session.session_key;

      console.log('[SessionManager] Original UUID:', originalUUID);
      console.log('[SessionManager] Original path:', session.original_cwd);

      // Calculate new slug for target directory
      const newSlug = this.calculateClaudeSlug(normalizedTarget);
      const claudeProjectDir = path.join(os.homedir(), '.claude', 'projects', newSlug);

      console.log('[SessionManager] Target Claude dir:', claudeProjectDir);

      // Create project directory if it doesn't exist
      if (!fs.existsSync(claudeProjectDir)) {
        fs.mkdirSync(claudeProjectDir, { recursive: true });
        console.log('[SessionManager] Created Claude project directory');
      }

      // Patch JSONL content (replace old paths with new paths)
      let patchedContent = session.content_blob;

      if (session.original_cwd !== normalizedTarget) {
        console.log('[SessionManager] Patching paths:', session.original_cwd, '->', normalizedTarget);

        // Parse JSONL line by line for precise patching
        const lines = patchedContent.split('\n').filter(l => l.trim());
        const patchedLines = lines.map(line => {
          try {
            const obj = JSON.parse(line);

            // Replace paths in common fields
            if (obj.cwd) {
              obj.cwd = obj.cwd.replace(session.original_cwd, normalizedTarget);
            }
            if (obj.project) {
              obj.project = obj.project.replace(session.original_cwd, normalizedTarget);
            }

            // Handle tool results with file paths (global replace)
            if (obj.type === 'tool_result' && obj.result) {
              obj.result = obj.result.replace(
                new RegExp(this.escapeRegExp(session.original_cwd), 'g'),
                normalizedTarget
              );
            }

            return JSON.stringify(obj);
          } catch (e) {
            // If line is not valid JSON, do simple string replace
            return line.replace(
              new RegExp(this.escapeRegExp(session.original_cwd), 'g'),
              normalizedTarget
            );
          }
        });

        patchedContent = patchedLines.join('\n');
      }

      // Write patched session file with original UUID
      const targetFile = path.join(claudeProjectDir, `${originalUUID}.jsonl`);
      fs.writeFileSync(targetFile, patchedContent, 'utf-8');
      console.log('[SessionManager] ✅ Wrote session file:', targetFile);

      // Record this deployment (if different from original)
      if (session.original_cwd !== normalizedTarget) {
        this.db.addSessionDeployment(session.id, normalizedTarget, newSlug);
        console.log('[SessionManager] Added deployment record');
      }

      // Return explicit resume command
      const resumeCommand = `claude --resume ${originalUUID}`;

      return {
        success: true,
        message: `Session "${sessionKey}" restored`,
        resumeCommand: resumeCommand,
        sessionUUID: originalUUID
      };
    } catch (error) {
      console.error('[SessionManager] ❌ Import failed:', error);
      return {
        success: false,
        message: `Import failed: ${error.message}`
      };
    }
  }

  /**
   * Escape special regex characters in string
   */
  escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // ========== UTILITIES ==========

  async sendCommandAndWait(sendCommand, tabId, command, waitMs) {
    sendCommand(tabId, command);
    await this.sleep(waitMs);
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * List all saved sessions for a project
   */
  listSessions(projectPath, toolType = null) {
    return this.db.getAISessions(projectPath, toolType);
  }

  /**
   * Delete a session
   */
  deleteSession(sessionId) {
    this.db.deleteAISession(sessionId);
  }
}

module.exports = SessionManager;
