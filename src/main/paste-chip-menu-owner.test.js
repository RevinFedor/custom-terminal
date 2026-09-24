const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('identical chip ids in two editors keep the native action bound to its request', () => {
  const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const start = source.indexOf("ipcMain.on('show-paste-chip-context-menu'");
  const end = source.indexOf("ipcMain.on('show-terminal-context-menu'", start);
  assert.ok(start >= 0 && end > start);
  let handler; const templates = []; const replies = [];
  vm.runInNewContext(source.slice(start, end), {
    ipcMain: { on: (_channel, fn) => { handler = fn; } },
    Menu: { buildFromTemplate: (items) => { templates.push(items); return { popup() {} }; } },
    BrowserWindow: { fromWebContents: () => ({}) }, clipboard: { writeText() {} },
  });
  const sender = { isDestroyed: () => false, send: (_channel, payload) => replies.push(payload) };
  handler({ sender }, { chipId: 'same-chip', requestId: 'local-A', chars: 12 });
  handler({ sender }, { chipId: 'same-chip', requestId: 'global-B', chars: 12 });
  assert.deepEqual(Array.from(templates[0], item => item.label), ['Вернуть текстом в поле']);
  templates[0].find((item) => item.label === 'Вернуть текстом в поле').click();
  templates[1].find((item) => item.label === 'Вернуть текстом в поле').click();
  assert.equal(replies[0].requestId, 'local-A'); assert.equal(replies[1].requestId, 'global-B');
  assert.equal(replies[0].chipId, replies[1].chipId);
});
