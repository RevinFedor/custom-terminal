'use strict';

const path = require('path');
const {
  classifyHistoryAction,
  historyActionHeadline,
} = require(path.join(__dirname, '..', 'shared', 'history-action-grammar.cjs'));

const COPY_FAMILY_ICONS = {
  read: '📄',
  search: '🔍',
  edit: '✏️',
  run: '🖥',
  git: '🌿',
  mcp: '🔌',
  web: '🌐',
  plan: '📋',
  agent: '🧵',
  other: '⚙️',
};

function canonicalToolName(toolName) {
  if (toolName === 'NotebookRead') return 'Read';
  if (toolName === 'NotebookEdit') return 'Edit';
  if (toolName === 'Monitor') return 'Bash';
  return toolName;
}

function copyActionFamily({ toolName, args, mcpServer, mcpMethod } = {}) {
  if (toolName === 'Task' || toolName === 'Agent' || toolName === 'Subagent') return 'agent';
  const canonicalName = canonicalToolName(String(toolName || 'Tool'));
  const classified = classifyHistoryAction({
    toolName: canonicalName,
    args,
    mcpServer,
    mcpMethod,
  });
  if (classified.family === 'question'
    || classified.family === 'wait'
    || classified.family === 'toolsearch') return 'plan';
  if (classified.family === 'task') return 'agent';
  if (classified.family === 'read'
    || classified.family === 'search'
    || classified.family === 'edit'
    || classified.family === 'run'
    || classified.family === 'git'
    || classified.family === 'mcp'
    || classified.family === 'web'
    || classified.family === 'plan') return classified.family;
  return 'other';
}

function actionDetailsEnabled(family, filters = {}) {
  switch (family) {
    case 'read': return !!filters.includeReading;
    case 'search': return !!(filters.includeSearch ?? filters.includeBash);
    case 'edit': return !!filters.includeEditing;
    case 'run': return !!(filters.includeRun ?? filters.includeBash);
    case 'git': return !!(filters.includeGit ?? filters.includeBash);
    case 'mcp': return !!(filters.includeMcp ?? filters.includeTools);
    case 'web': return !!(filters.includeWeb ?? filters.includeWebSearch);
    case 'plan': return !!(filters.includePlan ?? filters.includeOtherTools);
    case 'other': return !!(filters.includeOther ?? filters.includeOtherTools ?? filters.includeToolSearch);
    case 'agent': return !!(filters.includeSubagentResult || filters.includeSubagentHistory);
    default: return false;
  }
}

function stripBase64Images(text) {
  return String(text || '').replace(
    /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=_-]+/g,
    '[image: base64 omitted]',
  );
}

function resultText(value) {
  if (value == null) return '';
  const content = value && typeof value === 'object' && 'content' in value
    ? value.content
    : value;
  if (typeof content === 'string') return stripBase64Images(content);
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (!block) continue;
      if (typeof block === 'string') parts.push(block);
      else if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
      else if (block.type === 'image' && block.source) {
        const mime = block.source.media_type || 'image/?';
        const bytes = String(block.source.data || '').length;
        const kb = bytes > 0 ? Math.round(bytes / 1024) : 0;
        parts.push(`[image: ${mime}${kb ? `, ~${kb}KB` : ''} base64 omitted]`);
      } else {
        try { parts.push(JSON.stringify(block)); } catch {}
      }
    }
    return stripBase64Images(parts.join('\n'));
  }
  try { return stripBase64Images(JSON.stringify(content, null, 2)); } catch { return String(content); }
}

function cleanArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args || {};
  const copy = { ...args };
  delete copy.caller;
  return copy;
}

function fenced(text, language = '') {
  const value = String(text || '').trimEnd();
  return value ? `\n\`\`\`${language}\n${value}\n\`\`\`` : '';
}

function diffText(action) {
  if (Array.isArray(action.diffHunks) && action.diffHunks.length > 0) {
    return action.diffHunks.map((hunk) => (hunk.entries || []).map((row) => (
      (row.tag === 'add' ? '+' : row.tag === 'del' ? '-' : ' ') + String(row.line || '')
    )).join('\n')).join('\n');
  }
  const args = action.args || {};
  if (args.old_string != null || args.new_string != null) {
    return String(args.old_string || '').split('\n').map((line) => `-${line}`).join('\n')
      + '\n'
      + String(args.new_string || '').split('\n').map((line) => `+${line}`).join('\n');
  }
  if (typeof args.content === 'string') return args.content;
  return '';
}

function actionLabel(action, family) {
  if (family === 'agent') {
    const args = action.args || {};
    const subject = String(action.description || args.description || args.task_name || '').trim();
    return `${COPY_FAMILY_ICONS.agent} Agent${subject ? ` ${subject}` : ''}`;
  }
  const toolName = canonicalToolName(String(action.toolName || 'Tool'));
  const classified = classifyHistoryAction({
    toolName,
    args: action.args,
    mcpServer: action.mcpServer,
    mcpMethod: action.mcpMethod,
  });
  const headline = historyActionHeadline({
    toolName,
    args: action.args,
    family: classified.family,
    bashWord: classified.bashWord,
    bashDetail: classified.bashDetail,
    mcpServer: action.mcpServer || classified.mcpServer,
    mcpMethod: action.mcpMethod || classified.mcpMethod,
  });
  let semanticHeadline = headline;
  if (family === 'plan') {
    const verb = classified.family === 'question'
      ? 'Question'
      : classified.family === 'wait'
        ? 'Wait'
        : classified.family === 'toolsearch'
          ? 'Tools'
          : 'Plan';
    semanticHeadline = {
      verb,
      subject: headline.subject || String(action.args?.summary || action.args?.explanation || ''),
      detail: headline.detail || '',
    };
  }
  const verb = semanticHeadline.verb || ({
    read: 'Read', search: 'Search', edit: 'Edit', run: 'Run', git: 'Git',
    mcp: 'MCP', web: 'Web', plan: 'Plan', other: 'Tool',
  })[family] || 'Tool';
  const tail = [semanticHeadline.subject, semanticHeadline.detail].filter(Boolean).join(' · ');
  return `${COPY_FAMILY_ICONS[family] || COPY_FAMILY_ICONS.other} ${verb}${tail ? ` ${tail}` : ''}`;
}

function subagentDetail(action, filters, progressEntries) {
  let detail = '';
  const response = resultText(action.result);
  if (filters.includeSubagentResult && response) {
    detail += '\n> **Result:** ' + response.split('\n').join('\n> ');
  }
  if (filters.includeSubagentHistory && Array.isArray(progressEntries) && progressEntries.length > 0) {
    const lines = [];
    for (const progress of progressEntries) {
      const message = progress?.data?.message;
      if (!message) continue;
      if (message.type === 'user') {
        const text = resultText(message.message?.content).trim();
        if (text) lines.push('> 👤 ' + text.slice(0, 200));
      } else if (message.type === 'assistant') {
        const content = message.message?.content;
        if (typeof content === 'string') {
          if (content.trim()) lines.push('> 🤖 ' + content.trim().slice(0, 200));
        } else if (Array.isArray(content)) {
          const text = content.filter((part) => part?.type === 'text').map((part) => part.text).join(' ').trim();
          if (text) lines.push('> 🤖 ' + text.slice(0, 200));
          for (const tool of content.filter((part) => part?.type === 'tool_use')) {
            const nested = {
              toolName: tool.name,
              args: tool.input || {},
            };
            lines.push('> ' + actionLabel(nested, copyActionFamily(nested)));
          }
        }
      }
    }
    if (lines.length > 0) detail += '\n>\n> **History:**\n' + lines.join('\n');
  }
  if (filters.includeSubagentHistory
    && (!Array.isArray(progressEntries) || progressEntries.length === 0)) {
    const body = { request: cleanArgs(action.args || {}) };
    if (response) body.response = response;
    try { detail += fenced(JSON.stringify(body, null, 2), 'json'); } catch {}
  }
  return detail;
}

function formatCopyAction(action = {}, filters = {}, options = {}) {
  if (filters.includeActions === false || filters.includeClaude === false) return '';
  const family = copyActionFamily(action);
  const label = actionLabel(action, family);
  if (!actionDetailsEnabled(family, filters)) return label;
  if (family === 'agent') {
    return label + subagentDetail(action, filters, options.progressEntries || []);
  }

  const args = cleanArgs(action.args || {});
  const response = resultText(action.result);
  let detail = '';
  if (family === 'read') {
    detail = fenced(response);
  } else if (family === 'edit') {
    const diff = diffText(action);
    if (diff) detail = fenced(diff, Array.isArray(action.diffHunks) || action.args?.old_string != null ? 'diff' : '');
    else if (action.args?.command) detail = fenced([`$ ${action.args.command}`, response].filter(Boolean).join('\n\n'));
    else detail = fenced(response);
  } else if ((family === 'run' || family === 'git' || family === 'search') && action.args?.command) {
    detail = fenced([`$ ${action.args.command}`, response].filter(Boolean).join('\n\n'));
  } else {
    const body = { request: args };
    if (response) body.response = response;
    if (action.isError) body.isError = true;
    try { detail = fenced(JSON.stringify(body, null, 2), 'json'); } catch { detail = ''; }
  }
  return label + detail;
}

module.exports = {
  actionDetailsEnabled,
  copyActionFamily,
  formatCopyAction,
  resultText,
};
