const { ipcMain, dialog, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

// ── gt-editor mirror: include expansion + AI/transclude block strip ──
//
// Mirrors gt-editor's "Copy Content" pipeline so that when a user attaches a
// .md file as a prompt context, the AI sees the same clean markdown the user
// would copy out of their notes. Stripped:
//   * `<!-- @ai: ... -->` blocks — instructions targeted at AI as metadata,
//     would leak as visible junk if included.
//   * `<!-- @include: path -->` markers — replaced by inlined file content.
//   * `<!-- BEGIN/END TRANSCLUDE -->` markers that gt-editor writes around
//     pre-expanded include blocks on disk.
//
// References:
//   - /Users/fedor/Desktop/gt-editor/src/components/Sidebar.jsx::onCopyContent
//   - /Users/fedor/Desktop/gt-editor/src/utils/includeTransform.js
const INCLUDE_LINE_RE = /^<!-- @include: (.+?) -->$/;
const MAX_INCLUDE_DEPTH = 8;

function resolveIncludePath(baseDir, rel) {
  // Match gt-editor's resolvePath: simple split-merge, handles ../ and ./
  const parts = rel.split('/');
  const out = baseDir.split('/');
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p !== '.' && p !== '') out.push(p);
  }
  return out.join('/');
}

function expandIncludesSync(content, currentFilePath, depth, seen) {
  if (depth > MAX_INCLUDE_DEPTH) return content;
  const currentDir = currentFilePath.substring(0, currentFilePath.lastIndexOf('/'));
  const lines = content.split('\n');
  const result = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(INCLUDE_LINE_RE);
    if (!m) { result.push(line); continue; }
    const rel = m[1].trim();
    const abs = resolveIncludePath(currentDir, rel);
    // Skip the pre-expanded BEGIN/END block right after the marker on disk
    if (i + 1 < lines.length && lines[i + 1] === '<!-- BEGIN TRANSCLUDE -->') {
      let j = i + 2;
      while (j < lines.length && lines[j] !== '<!-- END TRANSCLUDE -->') j++;
      i = j; // skip block
    }
    if (seen.has(abs)) {
      // cycle — replace marker with a comment so it's visible but harmless
      result.push(`[INCLUDE CYCLE: ${rel}]`);
      continue;
    }
    let body;
    try { body = fs.readFileSync(abs, 'utf-8'); }
    catch { result.push(`[INCLUDE NOT FOUND: ${rel}]`); continue; }
    // Strip YAML frontmatter from included content (gt-editor parity)
    if (body.startsWith('---\n')) {
      const endIdx = body.indexOf('\n---\n', 3);
      if (endIdx !== -1) body = body.substring(endIdx + 5);
    }
    const nextSeen = new Set(seen); nextSeen.add(abs);
    const expanded = expandIncludesSync(body, abs, depth + 1, nextSeen);
    result.push(expanded);
  }
  return result.join('\n');
}

function sanitizeFileForPrompt(raw, filePath) {
  const seen = new Set([filePath]);
  let out = expandIncludesSync(raw, filePath, 0, seen);
  // Order matters: strip @ai blocks AFTER include expansion so blocks inside
  // included files also get stripped. `\n?` trailing eats the newline that
  // followed the comment to avoid leaving an empty line behind.
  out = out
    .replace(/<!--\s*@ai:[\s\S]*?-->\n?/g, '')
    .replace(/^<!-- @include: .+? -->\n?/gm, '')
    .replace(/^<!-- (?:BEGIN|END) TRANSCLUDE -->\n?/gm, '');
  return out;
}

function register({ projectManager }) {
  // ── Prompts ──

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

  // ── Prompt Groups ──

  ipcMain.handle('prompt-groups:get', async () => {
    try {
      const groups = projectManager.getPromptGroups();
      return { success: true, data: groups };
    } catch (error) {
      console.error('[main] Error getting prompt groups:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('prompt-groups:save', async (event, groups) => {
    try {
      projectManager.savePromptGroups(groups);
      return { success: true };
    } catch (error) {
      console.error('[main] Error saving prompt groups:', error);
      return { success: false, error: error.message };
    }
  });

  // ── AI Prompts (Dynamic System Prompts) ──

  ipcMain.handle('ai-prompts:get', async () => {
    try {
      const prompts = projectManager.getAIPrompts();
      return { success: true, data: prompts };
    } catch (error) {
      console.error('[main] Error getting AI prompts:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('ai-prompts:save', async (event, prompt) => {
    try {
      console.log('[AIPrompts] Saving:', prompt.id, 'thinkingLevel=' + prompt.thinkingLevel, 'model=' + prompt.model);
      projectManager.saveAIPrompt(prompt);
      return { success: true };
    } catch (error) {
      console.error('[main] Error saving AI prompt:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('ai-prompts:delete', async (event, id) => {
    try {
      projectManager.deleteAIPrompt(id);
      return { success: true };
    } catch (error) {
      console.error('[main] Error deleting AI prompt:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('ai-prompts:log-call', async (event, payload) => {
    try {
      projectManager.logAIPromptCall(payload);
      return { success: true };
    } catch (error) {
      console.error('[main] Error logging AI prompt call:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('ai-prompts:usage-stats', async (event, range) => {
    try {
      return { success: true, data: projectManager.getAIPromptUsageStats(range) };
    } catch (error) {
      console.error('[main] Error getting AI prompt usage stats:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('timeline-prompt-summaries:get', async (event, { toolType, sessionId }) => {
    try {
      return { success: true, data: projectManager.getTimelinePromptSummaries(toolType, sessionId) };
    } catch (error) {
      console.error('[main] Error getting timeline prompt summaries:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('timeline-prompt-summaries:save', async (event, payload) => {
    try {
      projectManager.saveTimelinePromptSummary(payload);
      return { success: true };
    } catch (error) {
      console.error('[main] Error saving timeline prompt summary:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('timeline-turn-action-overrides:get', async (event, { toolType, sessionId }) => {
    try {
      return { success: true, data: projectManager.getTimelineTurnActionOverrides(toolType, sessionId) };
    } catch (error) {
      console.error('[main] Error getting Timeline action overrides:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('timeline-turn-action-overrides:save', async (event, payload) => {
    try {
      const saved = projectManager.saveTimelineTurnActionOverride(payload);
      return saved ? { success: true } : { success: false, error: 'Invalid Timeline action override' };
    } catch (error) {
      console.error('[main] Error saving Timeline action override:', error);
      return { success: false, error: error.message };
    }
  });

  // ── AI Prompt File Attachments ──

  ipcMain.handle('ai-prompts:select-file', async () => {
    try {
      const win = BrowserWindow.getFocusedWindow();
      const result = await dialog.showOpenDialog(win, {
        properties: ['openFile']
      });
      if (result.canceled || result.filePaths.length === 0) return { success: true, data: null };
      return { success: true, data: result.filePaths[0] };
    } catch (error) {
      console.error('[AIPrompts] Error selecting file:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('ai-prompts:check-file', async (event, filePath) => {
    try {
      const exists = fs.existsSync(filePath);
      return { success: true, exists };
    } catch (error) {
      return { success: true, exists: false };
    }
  });

  // Batch existence check — one IPC call for the status-bar invalid-paths counter,
  // not N round-trips when there are dozens of prompts × multiple files each. Returns
  // a flat list of missing absolute paths (caller decides how to present them).
  ipcMain.handle('ai-prompts:check-paths', async (event, filePaths) => {
    try {
      if (!Array.isArray(filePaths)) return { success: true, missing: [] };
      const missing = [];
      for (const fp of filePaths) {
        if (typeof fp !== 'string' || !fp.trim()) continue;
        try { if (!fs.existsSync(fp)) missing.push(fp); }
        catch { missing.push(fp); }
      }
      return { success: true, missing };
    } catch (error) {
      return { success: true, missing: [] };
    }
  });

  ipcMain.handle('ai-prompts:read-files', async (event, filePaths) => {
    try {
      const results = [];
      for (const fp of filePaths) {
        try {
          const raw = fs.readFileSync(fp, 'utf-8');
          // Apply the same sanitisation as gt-editor's "Copy Content" so prompt
          // injection mirrors what the editor produces for AI conversations.
          // See gt-editor/src/components/Sidebar.jsx::onCopyContent and
          // utils/includeTransform.js::expandIncludes for the canonical impl.
          //
          // Steps:
          //  1. Inline any `<!-- @include: path -->` references (recursive,
          //     bounded by maxDepth to guard against cycles).
          //  2. Strip `<!-- @ai: ... -->` blocks — AI-only instructions that
          //     must not leak into the prompt the model sees verbatim.
          //  3. Strip leftover `@include` markers and BEGIN/END TRANSCLUDE
          //     boundary markers from any pre-expanded blocks on disk.
          const content = sanitizeFileForPrompt(raw, fp);
          results.push({ path: fp, content });
        } catch (e) {
          console.error('[AIPrompts] Failed to read file:', fp, e.message);
        }
      }
      return { success: true, data: results };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

}

module.exports = { register, sanitizeFileForPrompt };
