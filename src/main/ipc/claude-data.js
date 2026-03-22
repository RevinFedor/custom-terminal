const { ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

let _projectManager = null;

// ========== JSONL INCREMENTAL CACHE ==========
// JSONL is append-only — when file grows we only parse NEW bytes, not the whole file.
// For a 159MB session file: first read ~3.5s, all subsequent reads ~0ms (if no new entries)
// or microseconds (if only a few new lines added).
const _jsonlCache = new Map();
// filePath → { size, mtimeMs, recordMap, lastRecord, bridgeSessionId, progressEntries }

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

// Parse JSONL lines into an existing recordMap (shared logic for full + incremental reads)
function _parseJsonlLines(lines, sessionId, recordMap, progressEntries, startFileIndex, bridgeSessionIdIn) {
  let lastRecord = null;
  let bridgeSessionId = bridgeSessionIdIn;
  let fileIndex = startFileIndex;

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'progress' && entry.data?.type === 'agent_progress' && entry.parentToolUseID) {
        progressEntries.push(entry);
      }
      if (entry.uuid) {
        entry._fileIndex = fileIndex++;
        entry._fromFile = sessionId;
        recordMap.set(entry.uuid, entry);
        lastRecord = entry;
        if (bridgeSessionId === null && entry.sessionId && entry.sessionId !== sessionId) {
          bridgeSessionId = entry.sessionId;
          entry._isBridge = true;
        } else if (bridgeSessionId === null && entry.sessionId === sessionId) {
          bridgeSessionId = undefined;
        }
      }
    } catch {}
  }

  return { lastRecord, bridgeSessionId, fileIndex };
}

// Load all records from a JSONL file into a Map (uuid → record)
// Incremental: JSONL is append-only — when file grows we only parse NEW bytes.
// First read of a 159MB file takes ~3.5s (CPU-bound JSON parse).
// Subsequent reads with new entries only parse the delta — near-instant.
async function loadJsonlRecords(filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return { recordMap: new Map(), lastRecord: null, bridgeSessionId: null, progressEntries: [] };
  }

  const cached = _jsonlCache.get(filePath);
  const sessionId = path.basename(filePath, '.jsonl');

  // ── Case 1: File unchanged → return cached result immediately ──────────────
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    return { recordMap: cached.recordMap, lastRecord: cached.lastRecord, bridgeSessionId: cached.bridgeSessionId, progressEntries: cached.progressEntries };
  }

  // ── Case 2: File grew (normal for active sessions) → read ONLY new bytes ──
  if (cached && stat.size > cached.size) {
    const fd = await fs.promises.open(filePath, 'r');
    let newContent = '';
    try {
      const newByteCount = stat.size - cached.size;
      const buf = Buffer.allocUnsafe(newByteCount);
      await fd.read(buf, 0, newByteCount, cached.size);
      newContent = buf.toString('utf-8');
    } finally {
      await fd.close();
    }

    // The first "line" may be a partial line from the previous read — prepend leftover
    const content = (cached.leftover || '') + newContent;
    const lines = content.split('\n');
    // Last element may be incomplete (file written mid-line) — save as leftover
    const leftover = lines.pop();

    const { lastRecord, bridgeSessionId, fileIndex } = _parseJsonlLines(
      lines, sessionId, cached.recordMap, cached.progressEntries,
      cached.fileIndex, cached.bridgeSessionId
    );

    const newLastRecord = lastRecord || cached.lastRecord;
    const newBridgeId = bridgeSessionId !== undefined ? bridgeSessionId : cached.bridgeSessionId;

    _jsonlCache.set(filePath, {
      size: stat.size, mtimeMs: stat.mtimeMs, leftover: leftover || '',
      recordMap: cached.recordMap, lastRecord: newLastRecord,
      bridgeSessionId: newBridgeId, progressEntries: cached.progressEntries,
      fileIndex
    });

    return { recordMap: cached.recordMap, lastRecord: newLastRecord, bridgeSessionId: newBridgeId, progressEntries: cached.progressEntries };
  }

  // ── Case 3: First read or file shrunk (shouldn't happen for JSONL) → full read ──
  const content = await fs.promises.readFile(filePath, 'utf-8');
  const lines = content.split('\n');
  const leftover = lines.pop(); // may be incomplete last line

  const recordMap = new Map();
  const progressEntries = [];
  const { lastRecord, bridgeSessionId, fileIndex } = _parseJsonlLines(
    lines, sessionId, recordMap, progressEntries, 0, null
  );

  _jsonlCache.set(filePath, {
    size: stat.size, mtimeMs: stat.mtimeMs, leftover: leftover || '',
    recordMap, lastRecord, bridgeSessionId: bridgeSessionId || null,
    progressEntries, fileIndex
  });

  return { recordMap, lastRecord, bridgeSessionId: bridgeSessionId || null, progressEntries };
}

// Resolve the full chain of JSONL files by following bridge entries backwards.
// Returns a merged recordMap with all records from all files in the chain,
// plus metadata about session boundaries.
// sessionBoundaries: array of { childSessionId, parentSessionId, bridgeUuid }
async function resolveSessionChain(sessionId, cwd, maxDepth = 10) {
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

    const { recordMap, lastRecord: fileLastRecord, bridgeSessionId, progressEntries } = await loadJsonlRecords(found.filePath);
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
        const parentId = _projectManager?.db?.getSessionParent(currentSessionId);
        console.log('[SessionChain] SQLite check for', currentSessionId.substring(0, 8) + ':', parentId ? parentId.substring(0, 8) : 'null', '_projectManager=' + !!_projectManager, 'db=' + !!_projectManager?.db);
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
      } catch (e) {
        console.error('[SessionChain] SQLite check FAILED for', currentSessionId.substring(0, 8) + ':', e.message);
      }
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
            // Check: is this a fork copy or a real bridge?
            // Fork copies (our copyFileSync) have original sessionId but are NOT bridges.
            // Real bridges are created by Clear Context and are NOT fork targets.
            try {
              const forkInfo = _projectManager.db.getParentSession(fId);
              if (forkInfo) {
                // This is a fork target — skip, not a bridge
                continue;
              }
            } catch {}
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
        const sqliteChild = _projectManager.db.getSessionChild(currentId);
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

function register({ projectManager, formatToolAction }) {
  _projectManager = projectManager;

  // Export a range of messages from Claude session
  ipcMain.handle('claude:copy-range', async (event, { sessionId, cwd, startUuid, endUuid, includeEditing = false, includeReading = false, includeSubagentResult = false, includeSubagentHistory = false }) => {
    console.log('[Claude Export] Exporting range from', startUuid, 'to', endUuid);

    if (!sessionId) return { success: false, error: 'No session ID' };

    try {
      // Use the same chain resolution as claude:get-timeline
      // This ensures we can find UUIDs across plan mode boundaries
      const { mergedMap: recordMap, lastRecord, sessionBoundaries, progressEntries: allProgressEntries } = await resolveSessionChain(sessionId, cwd);

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

  // Create a pre-filled Claude JSONL session (user question + assistant analysis)
  // Used by Update API: API response is embedded as assistant message, then Claude --resume shows it
  ipcMain.handle('claude:create-prefilled-session', async (event, { content, cwd }) => {
    try {
      const sessionId = crypto.randomUUID();
      const uuid1 = crypto.randomUUID();
      const uuid2 = crypto.randomUUID();
      const now = new Date().toISOString();

      const projectSlug = cwd.replace(/\//g, '-');
      const projectDir = path.join(os.homedir(), '.claude', 'projects', projectSlug);
      if (!fs.existsSync(projectDir)) fs.mkdirSync(projectDir, { recursive: true });

      // Entry 1: user message with FULL API response (visible in Claude TUI)
      const userEntry = {
        parentUuid: null,
        isSidechain: false,
        userType: 'external',
        cwd,
        sessionId,
        version: '1.0.0',
        type: 'user',
        message: { role: 'user', content: 'Результат анализа сессии внешним AI-агентом:\n\n' + content },
        uuid: uuid1,
        timestamp: now
      };

      // Entry 2: short assistant ack (completes the turn so Claude shows prompt on resume)
      const assistantEntry = {
        parentUuid: uuid1,
        isSidechain: false,
        userType: 'external',
        cwd,
        sessionId,
        version: '1.0.0',
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Принял. Готов применить изменения из анализа выше. Подтвердите командой.' }],
          model: 'external-api',
          stop_reason: 'end_turn',
          stop_sequence: null
        },
        uuid: uuid2,
        timestamp: new Date(Date.now() + 1000).toISOString()
      };

      const filePath = path.join(projectDir, sessionId + '.jsonl');
      fs.writeFileSync(filePath, JSON.stringify(userEntry) + '\n' + JSON.stringify(assistantEntry) + '\n', 'utf-8');

      console.log('[Claude Prefilled] Created: ' + filePath + ' (' + content.length + ' chars)');
      return { success: true, sessionId, filePath, totalChars: content.length };
    } catch (error) {
      console.error('[Claude Prefilled] Error:', error);
      return { success: false, error: error.message };
    }
  });

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

  // Edit range: remove entries from JSONL and insert compact summary
  // Flow: read file → backtrace → remove range → insert compact entry → relink → write atomically
  ipcMain.handle('claude:edit-range', async (event, { sessionId, cwd, startUuid, endUuid, compactText }) => {
    console.log('[EditRange] ========================================');
    console.log('[EditRange] Session:', sessionId, 'Range:', startUuid?.slice(0, 8), '→', endUuid?.slice(0, 8));

    try {
      const found = findSessionFile(sessionId, cwd);
      if (!found) return { success: false, error: 'Session file not found' };

      const filePath = found.filePath;
      const content = await fs.promises.readFile(filePath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());

      // Parse all records
      const allRecords = [];
      const recordMap = new Map();
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          allRecords.push(entry);
          if (entry.uuid) recordMap.set(entry.uuid, entry);
        } catch { allRecords.push(null); }
      }

      // Build backtrace chain (active branch)
      const lastRecord = allRecords.filter(r => r?.uuid).pop();
      if (!lastRecord) return { success: false, error: 'No records in file' };

      const activeBranch = [];
      let cur = lastRecord.uuid;
      const seen = new Set();
      while (cur && !seen.has(cur)) {
        seen.add(cur);
        const rec = recordMap.get(cur);
        if (!rec) break;
        activeBranch.unshift(rec);
        cur = rec.logicalParentUuid || rec.parentUuid;
      }

      // Find range in active branch by UUID
      const startIdx = activeBranch.findIndex(e => e.uuid === startUuid);
      const endIdx = activeBranch.findIndex(e => e.uuid === endUuid);
      if (startIdx === -1 || endIdx === -1) {
        return { success: false, error: 'Range UUIDs not found in active branch' };
      }
      const rangeStart = Math.min(startIdx, endIdx);
      const rangeEnd = Math.max(startIdx, endIdx);

      // Remove everything from startUuid to endUuid inclusive.
      // If endUuid is a user entry, also remove the SINGLE assistant response right after it
      // (but NOT system entries like turn_duration — they may belong to entries outside the range).
      const removeUuids = new Set();
      for (let i = rangeStart; i <= rangeEnd; i++) {
        removeUuids.add(activeBranch[i].uuid);
      }
      // Forward-expand: remove the ENTIRE response chain after the range
      // (assistant → tool_result → assistant → ... until next REAL user message)
      for (let i = rangeEnd + 1; i < activeBranch.length; i++) {
        const entry = activeBranch[i];
        if (entry.type === 'assistant') {
          removeUuids.add(entry.uuid);
        } else if (entry.type === 'user') {
          const content = entry.message?.content;
          const isToolResult = Array.isArray(content) && content.some(b => b.type === 'tool_result');
          if (isToolResult) {
            removeUuids.add(entry.uuid);
          } else {
            break; // Real user message — stop
          }
        } else {
          break; // system or other — stop
        }
      }

      // Also remove progress entries linked to removed entries
      for (const rec of allRecords) {
        if (!rec || !rec.parentToolUseID) continue;
        if (rec.type !== 'progress') continue;
        for (const uuid of removeUuids) {
          const entry = recordMap.get(uuid);
          if (entry?.type === 'assistant' && Array.isArray(entry.message?.content) &&
              entry.message.content.some(b => b.type === 'tool_use' && b.id === rec.parentToolUseID)) {
            removeUuids.add(rec.uuid);
            break;
          }
        }
      }

      // Find actual last removed index in activeBranch (after forward expand)
      let actualEnd = rangeEnd;
      for (let i = rangeEnd + 1; i < activeBranch.length; i++) {
        if (removeUuids.has(activeBranch[i].uuid)) actualEnd = i;
        else break;
      }

      // Create compact replacement entry
      const entryBefore = rangeStart > 0 ? activeBranch[rangeStart - 1] : null;
      const entryAfter = actualEnd < activeBranch.length - 1 ? activeBranch[actualEnd + 1] : null;

      console.log('[EditRange] Range:', rangeStart, '→', rangeEnd, '→ actualEnd:', actualEnd,
        'of', activeBranch.length, 'active. Removing', removeUuids.size, 'records');
      console.log('[EditRange] Active branch:', activeBranch.map((e, i) => `${i}:${e.type}(${e.uuid?.slice(0,6)})`).join(' '));
      console.log('[EditRange] entryBefore:', entryBefore?.uuid?.slice(0,8), entryBefore?.type, '| entryAfter:', entryAfter?.uuid?.slice(0,8), entryAfter?.type);
      console.log('[EditRange] File records:', allRecords.filter(r => r).length, '→ Keeping:', allRecords.filter(r => r && !removeUuids.has(r.uuid)).length);
      const compactUuid = crypto.randomUUID();

      // Compact entry — sessionId MUST match what Claude will use on resume.
      // Always use the IPC sessionId (tab's claudeSessionId) — this is what Claude --resume uses.
      // Using file entries' sessionId (e.g. original 2fa76efe in a fork) causes a DAG fork:
      // compact(sid=2fa76efe) and Claude's new entry(sid=e713a1a9) both point to same parent.
      const fileSessionId = sessionId;
      const compactTs = entryAfter?.timestamp
        ? new Date(new Date(entryAfter.timestamp).getTime() - 1).toISOString()
        : entryBefore?.timestamp || new Date().toISOString();
      console.log('[EditRange] Compact: sid=' + fileSessionId?.slice(0, 8) + ' ts=' + compactTs?.slice(0, 19) + ' uuid=' + compactUuid?.slice(0, 8));
      const compactEntry = {
        parentUuid: entryBefore?.uuid || null,
        isSidechain: false,
        userType: 'external',
        cwd: cwd || '',
        sessionId: fileSessionId,
        version: '1.0.0',
        type: 'user',
        message: { role: 'user', content: compactText },
        uuid: compactUuid,
        timestamp: compactTs
      };

      // Clean up: if the VERY LAST entry in active chain is [Request interrupted],
      // remove it — it was created by our Ctrl+C when exiting Claude.
      // Only remove ONE (the last). If user had their own interrupted before — leave it.
      const lastEntry = activeBranch[activeBranch.length - 1];
      if (lastEntry && !removeUuids.has(lastEntry.uuid)) {
        const lastContent = lastEntry.message?.content;
        if (typeof lastContent === 'string' && lastContent.startsWith('[Request interrupted')) {
          removeUuids.add(lastEntry.uuid);
          console.log('[EditRange] Removing Ctrl+C interrupted:', lastEntry.uuid?.slice(0, 8));
        }
      }

      // If editing from start (rangeStart=0), remove ALL records that are not
      // in the active branch AFTER the deleted range. This cleans bridge entries,
      // dead branches, last-prompt markers from parent sessions, etc.
      if (rangeStart === 0) {
        const keepUuids = new Set();
        // Keep: entries after range in active branch
        for (let i = (entryAfter ? activeBranch.indexOf(entryAfter) : activeBranch.length); i < activeBranch.length; i++) {
          if (i >= 0) keepUuids.add(activeBranch[i].uuid);
        }
        // Mark everything else for removal
        for (const rec of allRecords) {
          if (!rec) continue;
          if (rec.uuid && !keepUuids.has(rec.uuid) && !removeUuids.has(rec.uuid)) {
            removeUuids.add(rec.uuid);
          }
        }
        console.log('[EditRange] rangeStart=0: keeping', keepUuids.size, 'post-range entries, total removing', removeUuids.size);
      }

      // Build output: filter removed + remove orphan last-prompt/non-uuid entries
      const outputLines = [];
      for (const rec of allRecords) {
        if (!rec) continue;
        if (rec.uuid && removeUuids.has(rec.uuid)) continue;
        // Remove last-prompt entries when editing from start (clean slate)
        if (rangeStart === 0 && rec.type === 'last-prompt') continue;

        // Relink: entry after range points to compact instead of last removed
        if (entryAfter && rec.uuid === entryAfter.uuid) {
          rec.parentUuid = compactUuid;
        }

        outputLines.push(JSON.stringify(rec));
      }

      // Insert compact + ack entries (before the entry-after-range for logical order)
      if (entryAfter) {
        const afterIdx = outputLines.findIndex(l => {
          try { return JSON.parse(l).uuid === entryAfter.uuid; } catch { return false; }
        });
        if (afterIdx !== -1) {
          outputLines.splice(afterIdx, 0, JSON.stringify(compactEntry));
        } else {
          outputLines.push(JSON.stringify(compactEntry));
        }
      } else {
        outputLines.push(JSON.stringify(compactEntry));
      }

      // Write atomically: tmp file → rename
      const tmpPath = filePath + '.edit-tmp';
      await fs.promises.writeFile(tmpPath, outputLines.join('\n') + '\n', 'utf-8');
      await fs.promises.rename(tmpPath, filePath);

      // Invalidate cache
      _jsonlCache.delete(filePath);

      // If range started from beginning (bridge removed), clean session_links
      // so resolveSessionChain doesn't re-attach parent session
      if (rangeStart === 0 && projectManager?.db) {
        try {
          projectManager.db.db.prepare('DELETE FROM session_links WHERE child_session_id = ?').run(fileSessionId);
          console.log('[EditRange] Cleaned session_links for', fileSessionId?.slice(0, 8));
        } catch (e) {
          console.warn('[EditRange] Could not clean session_links:', e.message);
        }
      }

      // Count removed by type
      let removedUsers = 0, removedAssistants = 0, removedOther = 0;
      for (const uuid of removeUuids) {
        const rec = recordMap.get(uuid);
        if (!rec) continue;
        if (rec.type === 'user') removedUsers++;
        else if (rec.type === 'assistant') removedAssistants++;
        else removedOther++;
      }

      console.log('[EditRange] Written', outputLines.length, 'records. Removed:', removeUuids.size,
        `(${removedUsers} user, ${removedAssistants} assistant, ${removedOther} other)`);
      return { success: true, removedCount: removeUuids.size, removedUsers, removedAssistants, compactUuid, fileSessionId };

    } catch (error) {
      console.error('[EditRange] Error:', error);
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
      const { mergedMap: recordMap, lastRecord, sessionBoundaries } = await resolveSessionChain(sessionId, cwd);

      if (!lastRecord) {
        console.log('[Timeline:Backtrace] No lastRecord for session:', sessionId.substring(0, 8));
        return { success: true, entries: [] };
      }

      console.log('[Timeline:Backtrace] session=' + sessionId.substring(0, 8) + ' recordMap.size=' + recordMap.size + ' lastRecord=' + lastRecord.uuid.substring(0, 8) + ' type=' + lastRecord.type + ' boundaries=' + sessionBoundaries.length);

      // BACKTRACE: Walk backwards from the last record following parentUuid
      // Now works across file boundaries thanks to merged recordMap
      const activeBranch = [];
      let currentUuid = lastRecord.uuid;
      const seen = new Set();
      let _compactRecoveryCount = 0;
      let _bridgeFollowCount = 0;

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
                _compactRecoveryCount++;
                console.log('[Timeline:Backtrace] Compact gap recovery L1: logicalParent=' + lastAdded.logicalParentUuid.substring(0, 8) + ' → parentUuid=' + lastAdded.parentUuid.substring(0, 8));
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
                  _compactRecoveryCount++;
                  console.log('[Timeline:Backtrace] Compact gap recovery L2: physicalPred=' + bestPred.uuid.substring(0, 8) + ' fileIndex=' + bestPred._fileIndex);
                } else {
                  console.log('[Timeline:Backtrace] Compact gap recovery FAILED: logicalParent=' + currentUuid.substring(0, 8) + ' parentUuid=' + (lastAdded.parentUuid || 'null') + ' _fromFile=' + lastAdded._fromFile?.substring(0, 8));
                }
              }
            } else {
              console.log('[Timeline:Backtrace] BREAK: uuid=' + currentUuid.substring(0, 8) + ' not in recordMap. lastAdded.type=' + lastAdded.type + ' subtype=' + (lastAdded.subtype || 'none'));
            }
          } else {
            console.log('[Timeline:Backtrace] BREAK: uuid=' + currentUuid.substring(0, 8) + ' not in recordMap (activeBranch empty)');
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
              _bridgeFollowCount++;
              console.log('[Timeline:Backtrace] Bridge follow: ' + record.sessionId.substring(0, 8) + ' → bridge.parentUuid=' + entry.parentUuid.substring(0, 8) + ' bridge.sessionId=' + entry.sessionId.substring(0, 8));
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
                _bridgeFollowCount++;
                console.log('[Timeline:Backtrace] SQLite bridge: ' + record.sessionId.substring(0, 8) + ' → parent last record: ' + parentLastRecord.uuid.substring(0, 8));
              }
            }
          }
        }

        currentUuid = nextUuid;
      }

      console.log('[Timeline:Backtrace] DONE session=' + sessionId.substring(0, 8) + ' activeBranch=' + activeBranch.length + ' compactRecoveries=' + _compactRecoveryCount + ' bridgeFollows=' + _bridgeFollowCount + ' root=' + (activeBranch.length > 0 ? activeBranch[0].uuid.substring(0, 8) + '/' + activeBranch[0].type : 'empty'));

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
          let hasImage = false;

          // Skip tool_result entries - these are automatic, not user input
          if (Array.isArray(rawContent)) {
            const hasToolResult = rawContent.some(item => item.type === 'tool_result');
            if (hasToolResult) {
              skippedToolResult++;
              continue;
            }
            // Detect image blocks (Claude Code shows these as [Image #N] in terminal)
            hasImage = rawContent.some(item => item.type === 'image');
            // Find first text block for other array types
            const textBlock = rawContent.find(item => item.type === 'text' && item.text);
            rawContent = textBlock?.text || (hasImage ? '[Image]' : null);
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
            hasImage: hasImage || undefined,
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
        } else if (entry.type === 'assistant') {
          // Detect docs/CLAUDE.md edits from tool_use blocks
          const contentBlocks = entry.message?.content;
          if (Array.isArray(contentBlocks)) {
            const docFiles = [];
            for (const block of contentBlocks) {
              if (block.type === 'tool_use' && (block.name === 'Edit' || block.name === 'Write')) {
                const fp = block.input?.file_path || '';
                if (fp.includes('/docs/') || fp.endsWith('/CLAUDE.md') || fp === 'CLAUDE.md') {
                  // Extract short name: last 2 path segments
                  const segments = fp.split('/');
                  const shortName = segments.length >= 2
                    ? segments.slice(-2).join('/')
                    : segments[segments.length - 1];
                  if (!docFiles.includes(shortName)) {
                    docFiles.push(shortName);
                  }
                }
              }
            }
            if (docFiles.length > 0) {
              entries.push({
                uuid: entry.uuid,
                type: 'docs_edit',
                timestamp: entry.timestamp,
                content: docFiles.join(', '),
                docsEdited: docFiles,
                sessionId: entry.sessionId || entry._fromFile
              });
            }
          }
        }
      }

      console.log('[Timeline:Backtrace] session=' + sessionId.substring(0, 8) + ' entries=' + entries.length + ' skipped: sidechain=' + skippedSidechain + ' toolResult=' + skippedToolResult + ' noContent=' + skippedNoContent + ' system=' + skippedSystem + ' summary=' + skippedSummary);

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
      const { mergedMap: recordMap, lastRecord, sessionBoundaries, progressEntries: allProgressEntries } = await resolveSessionChain(sessionId, cwd);

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
        outputParts.push('\uD83D\uDD35\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 FORK \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\uD83D\uDD35');
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
          outputParts.push('\uD83D\uDC64 USER:');
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
            outputParts.push('\uD83E\uDD16 CLAUDE:');
            if (textContent.trim()) outputParts.push(textContent);
            if (toolActions.length > 0) {
              if (includeEditing || includeReading) {
                outputParts.push('\n**Actions:**\n' + toolActions.join('\n\n'));
              } else {
                outputParts.push(`   [\u0414\u0435\u0439\u0441\u0442\u0432\u0438\u044F: ${toolActions.join(', ')}]`);
              }
            }
            outputParts.push('');
          }
        }

        else if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
          outputParts.push('');
          outputParts.push('\u2550\u2550\u2550 COMPACTED \u2550\u2550\u2550');
          outputParts.push('');
        }

        // Insert fork separator after boundary entries
        if (forkBoundaryUuids.has(entry.uuid)) {
          outputParts.push('');
          outputParts.push('\uD83D\uDD35\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 FORK \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\uD83D\uDD35');
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
      const { mergedMap: recordMap, lastRecord, sessionBoundaries, progressEntries: allProgressEntries } = await resolveSessionChain(sessionId, cwd);

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

      // Fork-at-beginning detection (empty snapshot = fork before any entries)
      let hasForkAtBeginning = false;
      try {
        const forkMarkers = projectManager.db.getForkMarkers(sessionId);
        for (const marker of forkMarkers) {
          if ((marker.entry_uuids || []).length === 0) {
            hasForkAtBeginning = true;
            break;
          }
        }
      } catch (e) {
        // Fork markers not available — that's OK
      }

      // Build structured entries
      const entries = [];
      let prevSessionId = null;
      let lastWasCompact = false;

      if (hasForkAtBeginning) {
        entries.push({ uuid: 'fork-begin', role: 'fork', timestamp: '', content: 'FORK', sessionId: '' });
      }

      for (let i = 0; i < activeBranch.length; i++) {
        const entry = activeBranch[i];
        if (entry.isSidechain || entry.type === 'summary') continue;

        // Plan mode / clear context boundary detection
        const entrySid = entry.sessionId || entry._fromFile;
        if (prevSessionId && entrySid !== prevSessionId && !lastWasCompact) {
          // Check if bridge-based transition (clear context) or fork
          // Skip after compact — compact already serves as the boundary marker
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
        lastWasCompact = (entry.type === 'system' && entry.subtype === 'compact_boundary');
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
          // Look ahead for compact summary content
          let compactSummary = '';
          for (let j = i + 1; j < activeBranch.length; j++) {
            const next = activeBranch[j];
            if (next.isCompactSummary && next.type === 'user') {
              const raw = typeof next.message?.content === 'string'
                ? next.message.content
                : Array.isArray(next.message?.content)
                  ? (next.message.content.find(c => c.type === 'text')?.text || '')
                  : '';
              compactSummary = raw
                .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
                .replace(/\[200~/g, '').replace(/~\]/g, '').trim();
              break;
            }
            if (next.type === 'user' && !next.isSidechain && !next.isMeta) break;
          }
          entries.push({
            uuid: entry.uuid,
            role: 'compact',
            timestamp: entry.timestamp || '',
            content: 'COMPACTED',
            compactSummary: compactSummary || undefined,
            preTokens: entry.compactMetadata?.preTokens || undefined,
            sessionId: entrySid
          });
        }

        // Fork boundary markers (forkBoundaryUuids) are NOT inserted here —
        // session boundary detection (sessionId change check above) already handles fork separators.
        // Adding them here caused duplicate FORK labels due to inherited markers accumulating.
      }

      const latestSessionId = resolveLatestSessionInChain(sessionId, cwd);

      return { success: true, entries, latestSessionId };
    } catch (error) {
      console.error('[Claude FullHistory] Error:', error);
      return { success: false, error: error.message };
    }
  });

  // ========== TIMELINE NOTES ==========

  ipcMain.handle('timeline:get-notes', async (event, { sessionId }) => {
    try {
      const db = projectManager.db;
      const rows = db.getTimelineNotes(sessionId);
      const notesMap = {};
      const positionsMap = {};
      for (const row of rows) {
        notesMap[row.entry_uuid] = row.content;
        positionsMap[row.entry_uuid] = row.position || 'before';
      }
      return { success: true, notes: notesMap, positions: positionsMap };
    } catch (error) {
      console.error('[TimelineNotes] get-notes error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('timeline:save-note', async (event, { entryUuid, sessionId, tabId, content, position }) => {
    try {
      const db = projectManager.db;
      db.saveTimelineNote(entryUuid, sessionId, tabId, content, position || 'before');
      return { success: true };
    } catch (error) {
      console.error('[TimelineNotes] save-note error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('timeline:delete-note', async (event, { entryUuid, sessionId }) => {
    try {
      const db = projectManager.db;
      db.deleteTimelineNote(entryUuid, sessionId);
      return { success: true };
    } catch (error) {
      console.error('[TimelineNotes] delete-note error:', error);
      return { success: false, error: error.message };
    }
  });
}

module.exports = { register, findSessionFile, loadJsonlRecords, resolveSessionChain, resolveLatestSessionInChain, parseTimelineUuids };
