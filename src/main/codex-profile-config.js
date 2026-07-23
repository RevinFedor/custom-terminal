'use strict';

function rewriteCodexDeveloperProfile(existingConfig, developerInstructions) {
  const text = String(developerInstructions || '').trim();
  if (!text) return null;
  const assignment = 'developer_instructions = ' + JSON.stringify(text);
  const lines = String(existingConfig || '')
    .replace(/\r\n/g, '\n')
    .split('\n');
  const next = [];
  let insideTable = false;
  let inserted = false;

  for (const line of lines) {
    if (/^\s*\[[^\]]+\]\s*(?:#.*)?$/.test(line)) {
      if (!inserted) {
        next.push(assignment, '');
        inserted = true;
      }
      insideTable = true;
    }
    const rootKey = !insideTable
      ? line.match(/^\s*([A-Za-z0-9_-]+)\s*=/)?.[1]
      : null;
    if (rootKey === 'developer_instructions') {
      if (!inserted) {
        next.push(assignment);
        inserted = true;
      }
      continue;
    }
    next.push(line);
  }

  if (!inserted) {
    while (next.length > 0 && next[next.length - 1] === '') next.pop();
    if (next.length > 0) next.push('');
    next.push(assignment);
  }
  return next.join('\n').replace(/\n*$/, '\n');
}

module.exports = {
  rewriteCodexDeveloperProfile,
};
