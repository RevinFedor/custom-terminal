const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execSync } = require('child_process');

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
   * Export Gemini session using "Trojan Horse" method
   * @param {string} projectPath - Current project path
   * @param {string} sessionKey - Tag name for the checkpoint
   * @returns {Promise<{success: boolean, message: string}>}
   */
  async exportGeminiSession(projectPath, sessionKey) {
    console.log('\n[SessionManager] ===== EXPORT GEMINI SESSION =====');
    console.log('[SessionManager] Project path:', projectPath);
    console.log('[SessionManager] Session key:', sessionKey);

    try {
      const normalizedPath = path.resolve(projectPath);
      console.log('[SessionManager] Normalized path:', normalizedPath);

      // Calculate directory hash (SHA-256 of absolute path)
      const dirHash = this.calculateGeminiHash(normalizedPath);
      console.log('[SessionManager] Directory hash:', dirHash);

      // Find checkpoint file
      const geminiTmpDir = path.join(os.homedir(), '.gemini', 'tmp', dirHash);
      console.log('[SessionManager] Gemini tmp dir:', geminiTmpDir);

      const checkpointPattern = `checkpoint-${sessionKey}.json`;
      const checkpointPath = path.join(geminiTmpDir, checkpointPattern);
      console.log('[SessionManager] Looking for checkpoint at:', checkpointPath);

      // List all files in directory for debugging
      if (fs.existsSync(geminiTmpDir)) {
        const files = fs.readdirSync(geminiTmpDir);
        console.log('[SessionManager] Files in gemini tmp dir:', files);
      } else {
        console.log('[SessionManager] ⚠️ Gemini tmp dir does not exist!');
      }

      if (!fs.existsSync(checkpointPath)) {
        console.log('[SessionManager] ❌ Checkpoint file not found');
        return {
          success: false,
          message: `Checkpoint "${sessionKey}" not found. Run "/chat save ${sessionKey}" first.`
        };
      }

      console.log('[SessionManager] ✅ Checkpoint file found, reading...');
      // Read checkpoint content
      const checkpointContent = fs.readFileSync(checkpointPath, 'utf-8');
      console.log('[SessionManager] Checkpoint size:', checkpointContent.length, 'bytes');

      // Save to database
      console.log('[SessionManager] Saving to database...');
      const sessionId = this.db.saveAISession(
        normalizedPath,
        'gemini',
        sessionKey,
        checkpointContent,
        normalizedPath,
        dirHash
      );
      console.log('[SessionManager] ✅ Saved to database with ID:', sessionId);

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
   * Import Gemini session using "Direct Injection" method
   * @param {string} projectPath - Current project path
   * @param {string} sessionKey - Tag name to restore
   * @param {Function} sendCommand - Function to send commands to PTY (tabId, command) [UNUSED in new version]
   * @param {number} tabId - Tab ID to send commands to [UNUSED in new version]
   * @returns {Promise<{success: boolean, message: string, commands: string[]}>}
   */
  async importGeminiSession(projectPath, sessionKey, sendCommand, tabId) {
    console.log('\n[SessionManager] ===== IMPORT GEMINI SESSION (Direct Injection) =====');
    console.log('[SessionManager] Project path:', projectPath);
    console.log('[SessionManager] Session key:', sessionKey);

    try {
      const normalizedPath = path.resolve(projectPath);
      console.log('[SessionManager] Normalized path:', normalizedPath);

      // Get session from database
      console.log('[SessionManager] Looking for session in database...');
      const session = this.db.getAISession(normalizedPath, 'gemini', sessionKey);

      if (!session) {
        console.log('[SessionManager] ❌ Session not found in database');
        // List available sessions for debugging
        const allSessions = this.db.getAISessions(normalizedPath, 'gemini');
        console.log('[SessionManager] Available Gemini sessions:', allSessions.map(s => s.session_key));
        return {
          success: false,
          message: `Session "${sessionKey}" not found in database. Available: ${allSessions.map(s => s.session_key).join(', ')}`
        };
      }

      console.log('[SessionManager] ✅ Session found in database');
      console.log('[SessionManager] Session original_cwd:', session.original_cwd);
      console.log('[SessionManager] Session original_hash:', session.original_hash);

      // Calculate new hash for target directory
      const newHash = this.calculateGeminiHash(normalizedPath);
      console.log('[SessionManager] New hash:', newHash);

      // Target directory and file
      const geminiTmpDir = path.join(os.homedir(), '.gemini', 'tmp', newHash);
      const targetPath = path.join(geminiTmpDir, `checkpoint-${sessionKey}.json`);

      // Create directory if it doesn't exist
      if (!fs.existsSync(geminiTmpDir)) {
        console.log('[SessionManager] Creating gemini tmp directory...');
        fs.mkdirSync(geminiTmpDir, { recursive: true });
      }

      // Patch the saved session content
      console.log('[SessionManager] Patching session content...');
      let patchedContent = session.content_blob;

      // Replace old path with new path
      if (session.original_cwd !== normalizedPath) {
        console.log(`[SessionManager] Replacing paths: ${session.original_cwd} -> ${normalizedPath}`);
        patchedContent = patchedContent.replace(
          new RegExp(session.original_cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
          normalizedPath
        );
      }

      // Replace old hash with new hash
      if (session.original_hash && session.original_hash !== newHash) {
        console.log(`[SessionManager] Replacing hashes: ${session.original_hash} -> ${newHash}`);
        patchedContent = patchedContent.replace(
          new RegExp(session.original_hash, 'g'),
          newHash
        );
      }

      // Write patched content directly to target file
      console.log('[SessionManager] Writing checkpoint file directly...');
      fs.writeFileSync(targetPath, patchedContent, 'utf-8');
      console.log('[SessionManager] ✅ Checkpoint file created at:', targetPath);

      console.log('[SessionManager] ✅ Direct injection complete');

      return {
        success: true,
        message: `Session "${sessionKey}" restored. Click "🔄 Resume" or run: gemini → /chat resume ${sessionKey}`,
        commands: [
          'gemini',
          `/chat resume ${sessionKey}`
        ]
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
   * Calculate Gemini directory hash (SHA-256)
   */
  calculateGeminiHash(dirPath) {
    const normalizedPath = path.resolve(dirPath);
    return crypto.createHash('sha256').update(normalizedPath).digest('hex');
  }

  // ========== CLAUDE CODE ==========

  /**
   * Export Claude session (JSONL extraction)
   * @param {string} projectPath - Current project path
   * @param {string} sessionKey - Session UUID or identifier
   * @returns {Promise<{success: boolean, message: string}>}
   */
  async exportClaudeSession(projectPath, sessionKey) {
    try {
      const normalizedPath = path.resolve(projectPath);

      // Convert path to Claude's project slug format
      // Example: /Users/fedor/Desktop/custom-terminal -> -Users-fedor-Desktop-custom-terminal
      const projectSlug = normalizedPath.replace(/\//g, '-');

      const claudeProjectDir = path.join(os.homedir(), '.claude', 'projects', projectSlug);

      if (!fs.existsSync(claudeProjectDir)) {
        return {
          success: false,
          message: `Claude project directory not found: ${claudeProjectDir}`
        };
      }

      // Find session JSONL file
      const sessionFile = path.join(claudeProjectDir, `${sessionKey}.jsonl`);

      if (!fs.existsSync(sessionFile)) {
        // Try to find any recent JSONL file
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
            message: 'No Claude session files found'
          };
        }

        // Use the most recent file
        const recentFile = files[0];
        const content = fs.readFileSync(recentFile.path, 'utf-8');

        // Extract UUID from filename (remove .jsonl extension)
        const extractedKey = path.basename(recentFile.name, '.jsonl');

        this.db.saveAISession(
          normalizedPath,
          'claude',
          extractedKey,
          content,
          normalizedPath,
          null // Claude doesn't use hash
        );

        return {
          success: true,
          message: `Claude session exported (auto-detected: ${extractedKey})`
        };
      }

      // Read session content
      const sessionContent = fs.readFileSync(sessionFile, 'utf-8');

      // Save to database
      this.db.saveAISession(
        normalizedPath,
        'claude',
        sessionKey,
        sessionContent,
        normalizedPath,
        null
      );

      return {
        success: true,
        message: `Claude session "${sessionKey}" exported successfully`
      };
    } catch (error) {
      return {
        success: false,
        message: `Export failed: ${error.message}`
      };
    }
  }

  /**
   * Import Claude session (JSONL injection)
   * @param {string} projectPath - Current project path
   * @param {string} sessionKey - Session UUID to restore
   * @returns {Promise<{success: boolean, message: string, commands: string[]}>}
   */
  async importClaudeSession(projectPath, sessionKey) {
    try {
      const normalizedPath = path.resolve(projectPath);

      // Get session from database
      const session = this.db.getAISession(normalizedPath, 'claude', sessionKey);

      if (!session) {
        return {
          success: false,
          message: `Session "${sessionKey}" not found in database`
        };
      }

      // Convert path to Claude's project slug format
      const projectSlug = normalizedPath.replace(/\//g, '-');

      const claudeProjectDir = path.join(os.homedir(), '.claude', 'projects', projectSlug);

      // Create project directory if it doesn't exist
      if (!fs.existsSync(claudeProjectDir)) {
        fs.mkdirSync(claudeProjectDir, { recursive: true });
      }

      // Patch JSONL content (replace old paths with new paths)
      let patchedContent = session.content_blob;

      if (session.original_cwd !== normalizedPath) {
        // Parse JSONL line by line
        const lines = patchedContent.split('\n').filter(l => l.trim());
        const patchedLines = lines.map(line => {
          try {
            const obj = JSON.parse(line);

            // Replace paths in common fields
            if (obj.cwd) {
              obj.cwd = obj.cwd.replace(session.original_cwd, normalizedPath);
            }
            if (obj.project) {
              obj.project = obj.project.replace(session.original_cwd, normalizedPath);
            }

            // Handle tool results with file paths
            if (obj.type === 'tool_result' && obj.result) {
              obj.result = obj.result.replace(
                new RegExp(session.original_cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
                normalizedPath
              );
            }

            return JSON.stringify(obj);
          } catch (e) {
            // If line is not valid JSON, return as-is
            return line;
          }
        });

        patchedContent = patchedLines.join('\n');
      }

      // Write patched session file
      const targetFile = path.join(claudeProjectDir, `${sessionKey}.jsonl`);
      fs.writeFileSync(targetFile, patchedContent, 'utf-8');

      // Create empty session-env folder (as observed in research)
      const sessionEnvDir = path.join(os.homedir(), '.claude', 'session-env', sessionKey);
      if (!fs.existsSync(sessionEnvDir)) {
        fs.mkdirSync(sessionEnvDir, { recursive: true });
      }

      return {
        success: true,
        message: `Session "${sessionKey}" restored. Run "claude --resume ${sessionKey}"`,
        commands: [
          `claude --resume ${sessionKey}`
        ]
      };
    } catch (error) {
      return {
        success: false,
        message: `Import failed: ${error.message}`
      };
    }
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
