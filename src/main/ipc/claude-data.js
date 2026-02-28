const { ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

let _projectManager = null;

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

// Load all records from a JSONL file into a Map (uuid → record)
// Returns { recordMap, lastRecord, bridgeSessionId }
// bridgeSessionId is set if the first entry references a different session (clear-context bridge)
function loadJsonlRecords(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.trim().split('\n').filter(line => line.trim());
  const sessionId = path.basename(filePath, '.jsonl');

  const recordMap = new Map();
  const progressEntries = [];
  let lastRecord = null;
  let bridgeSessionId = null;
  let fileIndex = 0;

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      // Collect agent_progress entries (sub-agent turns from Task tool)
      if (entry.type === 'progress' && entry.data?.type === 'agent_progress' && entry.parentToolUseID) {
        progressEntries.push(entry);
      }
      if (entry.uuid) {
        entry._fileIndex = fileIndex++;
        entry._fromFile = sessionId;
        recordMap.set(entry.uuid, entry);
        lastRecord = entry;
        // Detect bridge: first entry with uuid that has a different sessionId
        if (bridgeSessionId === null && entry.sessionId && entry.sessionId !== sessionId) {
          bridgeSessionId = entry.sessionId;
          entry._isBridge = true; // Mark for backtrace bridge following
        } else if (bridgeSessionId === null && entry.sessionId === sessionId) {
          bridgeSessionId = undefined; // No bridge
        }
      }
    } catch {}
  }

  return { recordMap, lastRecord, bridgeSessionId: bridgeSessionId || null, progressEntries };
}

// Resolve the full chain of JSONL files by following bridge entries backwards.
// Returns a merged recordMap with all records from all files in the chain,
// plus metadata about session boundaries.
// sessionBoundaries: array of { childSessionId, parentSessionId, bridgeUuid }
function resolveSessionChain(sessionId, cwd, maxDepth = 10) {
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

    const { recordMap, lastRecord: fileLastRecord, bridgeSessionId, progressEntries } = loadJsonlRecords(found.filePath);
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
        const parentId = _projectManager.db.getSessionParent(currentSessionId);
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
      } catch (e) {}
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
            // This file bridges from currentId
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
      const { mergedMap: recordMap, lastRecord, sessionBoundaries, progressEntries: allProgressEntries } = resolveSessionChain(sessionId, cwd);

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
      const { mergedMap: recordMap, lastRecord, sessionBoundaries } = resolveSessionChain(sessionId, cwd);

      if (!lastRecord) {
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
                }
              }
            }
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
                console.log('[Backtrace] SQLite bridge:', record.sessionId.substring(0, 8), '→ parent last record:', parentLastRecord.uuid.substring(0, 8));
              }
            }
          }
        }

        currentUuid = nextUuid;
      }

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
        }
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
      const { mergedMap: recordMap, lastRecord, sessionBoundaries, progressEntries: allProgressEntries } = resolveSessionChain(sessionId, cwd);

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
      const { mergedMap: recordMap, lastRecord, sessionBoundaries, progressEntries: allProgressEntries } = resolveSessionChain(sessionId, cwd);

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

      // Fork markers
      const forkBoundaryUuids = new Set();
      let hasForkAtBeginning = false;
      try {
        const forkMarkers = projectManager.db.getForkMarkers(sessionId);
        for (const marker of forkMarkers) {
          const snapshotSet = new Set(marker.entry_uuids || []);
          if (snapshotSet.size === 0) {
            hasForkAtBeginning = true;
            continue;
          }
          const isTimelineEntry = (rec) => {
            if (rec.type === 'system' && rec.subtype === 'compact_boundary') return true;
            if (rec.type !== 'user') return false;
            if (rec.isSidechain || rec.isMeta) return false;
            const content = rec.message?.content;
            if (Array.isArray(content) && content.some(item => item.type === 'tool_result')) return false;
            return true;
          };
          for (let idx = 0; idx < activeBranch.length; idx++) {
            const rec = activeBranch[idx];
            if (!snapshotSet.has(rec.uuid)) continue;
            let nextTE = null;
            for (let j = idx + 1; j < activeBranch.length; j++) {
              if (isTimelineEntry(activeBranch[j])) { nextTE = activeBranch[j]; break; }
            }
            if (!nextTE || !snapshotSet.has(nextTE.uuid)) {
              forkBoundaryUuids.add(rec.uuid);
            }
          }
        }
      } catch (e) {
        // Fork markers not available — that's OK
      }

      // Build structured entries
      const entries = [];
      let prevSessionId = null;

      if (hasForkAtBeginning) {
        entries.push({ uuid: 'fork-begin', role: 'fork', timestamp: '', content: 'FORK', sessionId: '' });
      }

      for (let i = 0; i < activeBranch.length; i++) {
        const entry = activeBranch[i];
        if (entry.isSidechain || entry.type === 'summary') continue;

        // Plan mode / clear context boundary detection
        const entrySid = entry.sessionId || entry._fromFile;
        if (prevSessionId && entrySid !== prevSessionId) {
          // Check if bridge-based transition (clear context) or fork
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
          entries.push({
            uuid: entry.uuid,
            role: 'compact',
            timestamp: entry.timestamp || '',
            content: 'COMPACTED',
            sessionId: entrySid
          });
        }

        // Fork boundary after entry
        if (forkBoundaryUuids.has(entry.uuid)) {
          entries.push({
            uuid: 'fork-after-' + entry.uuid,
            role: 'fork',
            timestamp: '',
            content: 'FORK',
            sessionId: entrySid
          });
        }
      }

      const latestSessionId = resolveLatestSessionInChain(sessionId, cwd);

      return { success: true, entries, latestSessionId };
    } catch (error) {
      console.error('[Claude FullHistory] Error:', error);
      return { success: false, error: error.message };
    }
  });
}

module.exports = { register, findSessionFile, loadJsonlRecords, resolveSessionChain, resolveLatestSessionInChain, parseTimelineUuids };
