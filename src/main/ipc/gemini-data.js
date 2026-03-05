const { ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const MINAYU_HISTORY_DIR = path.join(os.homedir(), '.minayu', 'history');

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

function register({ projectManager, geminiUtils, terminals, terminalProjects, geminiHistoryWatchers }) {
  const { resolveGeminiProjectDir, findGeminiSessionFile, invalidateProjectsJsonCache, getGeminiProjectsJson, calculateGeminiHash } = geminiUtils;

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
        // Track last gemini input tokens for compact detection
        let lastGeminiInputTokens = 0;

        for (let i = 0; i < data.messages.length; i++) {
          const msg = data.messages[i];

          // Track gemini response tokens for compact preTokens
          if (msg.type === 'gemini' && msg.tokens && msg.tokens.input) {
            lastGeminiInputTokens = msg.tokens.input;
          }

          // Detect compact: info message with empty content
          if (msg.type === 'info' && (msg.content === '' || msg.content == null)) {
            entries.push({
              uuid: msg.id || `${sessionId}-compact-${i}`,
              type: 'compact',
              timestamp: msg.timestamp || new Date().toISOString(),
              content: 'Conversation compacted',
              preTokens: lastGeminiInputTokens || undefined,
              sessionId
            });
            continue;
          }

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
      let lastGeminiInputTokens = 0;

      for (let i = 0; i < data.messages.length; i++) {
        const msg = data.messages[i];

        // Track gemini response tokens for compact preTokens
        if (msg.type === 'gemini' && msg.tokens && msg.tokens.input) {
          lastGeminiInputTokens = msg.tokens.input;
        }

        // Detect compact: info message with empty content
        if (msg.type === 'info' && (msg.content === '' || msg.content == null)) {
          entries.push({
            uuid: msg.id || `${sessionId}-compact-${i}`,
            role: 'compact',
            timestamp: msg.timestamp || '',
            content: 'COMPACTED',
            preTokens: lastGeminiInputTokens || undefined,
            sessionId
          });
          continue;
        }

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
      }

      console.log('[Gemini FullHistory] Returning', entries.length, 'entries');
      return { success: true, entries };
    } catch (error) {
      console.error('[Gemini FullHistory] Error:', error);
      return { success: false, error: error.message };
    }
  });
}

module.exports = { register };
