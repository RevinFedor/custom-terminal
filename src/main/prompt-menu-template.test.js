const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPromptMenuTemplate } = require('./prompt-menu-template');

test('native prompt menu puts the project first and keeps source headers', () => {
  const picked = [];
  const rows = buildPromptMenuTemplate({
    projectCatalog: {
      project: { id: 'p1', name: 'Demo' },
      prompts: [
        { id: 'a', title: 'Deploy', sourceName: 'Agaratech' },
        { id: 'b', title: 'Auth', sourceName: 'UAuth' },
      ],
    },
    groups: [{ id: 7, name: 'Global', position: 1 }],
    prompts: [{ id: 8, title: 'Review', group_id: 7, position: 1 }],
    onPick: prompt => picked.push(prompt.id),
  });
  assert.equal(rows[0].label, 'Demo');
  assert.deepEqual(rows[0].submenu.map(row => row.type || row.label), [
    'Agaratech', 'Deploy', 'separator', 'UAuth', 'Auth',
  ]);
  assert.equal(rows[1].type, 'separator');
  assert.equal(rows[2].label, 'Global');
  rows[0].submenu[1].click();
  assert.deepEqual(picked, ['a']);
});
