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

test('preparing/stale/failed keep globals usable and do not expose old project callbacks',()=>{
  for(const status of ['cold','preparing','stale','failed']){
    const picked=[],rows=buildPromptMenuTemplate({projectCatalog:{tabId:'T',prompts:[{id:'old',title:'Old'}]},
      projectCatalogState:{status,label:'Docs'},prompts:[{id:8,title:'Global',position:0}],onPick:p=>picked.push(p.id)});
    assert.equal(rows[0].enabled,false);assert.match(rows[0].label,status==='failed'?/Недоступны/:/Подготавливаются/);
    assert.equal(rows[0].click,undefined);assert.equal(rows[0].submenu,undefined);
    rows.at(-1).click();assert.deepEqual(picked,[8]);
    assert.equal(typeof rows.then,'undefined','pure sync builder returns a finite array');
  }
});

test('known ready empty is distinct from an unavailable catalog',()=>{
  assert.deepEqual(buildPromptMenuTemplate({projectCatalog:{tabId:'T',prompts:[]},projectCatalogState:{status:'ready'},onPick(){}}),[]);
  const failed=buildPromptMenuTemplate({projectCatalogState:{status:'failed'},onPick(){}});
  assert.equal(failed.length,1);assert.equal(failed[0].enabled,false);
});
