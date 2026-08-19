'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

function handler(channel, nextMarker) {
  const start = main.indexOf(`ipcMain.handle('${channel}'`);
  const end = main.indexOf(nextMarker, start);
  assert.ok(start >= 0 && end > start, channel);
  return main.slice(start, end);
}

test('public Claude message history uses the incremental active-branch API', () => {
  const block = handler('claude-sdk:active-branch-messages', '// Mobile-web Timeline view');
  assert.match(block, /claudeDataApi\.getActiveBranchMessages/);
  assert.doesNotMatch(block, /readFileSync|\.split\('\\n'\)/);
});

test('public Claude Timeline uses the shared incremental Timeline API', () => {
  const block = handler('claude-sdk:timeline-entries', '// Fork an existing Claude session');
  assert.match(block, /claudeDataApi\.getTimeline/);
  assert.doesNotMatch(block, /parseTimelineEntries|readFileSync/);
});
