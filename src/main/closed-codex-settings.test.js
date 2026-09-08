'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { prepareClosedCodexSettings } = require('./closed-codex-settings');

test('an explicit full pair restores the exact archived Codex target, without a launch capability', async () => {
  const archive = { ok: true, toolType: 'codex', tabId: 'closed', historyId: 7 };
  const seen = [];
  const result = await prepareClosedCodexSettings({
    tabId: 'closed', model: 'gpt-6-astra', effort: 'xhigh',
    findOpen: () => null, findArchived: (id) => { assert.equal(id, 'closed'); return archive; },
    restore: async (...args) => { seen.push(args); return { restored: true }; },
  });
  assert.equal(result.restored, true);
  assert.deepEqual(seen, [['closed', archive]]);
});

test('open tabs, implicit/partial settings and non-Codex or ambiguous archives never trigger restore', async () => {
  const cases = [
    { open: {} }, { model: '' }, { effort: undefined }, { model: 'none' },
    { archive: { ok: true, toolType: 'claude' } }, { archive: { ok: false, code: 'ambiguous' } },
  ];
  for (const item of cases) {
    const result = await prepareClosedCodexSettings({
      tabId: 't', model: 'm', effort: 'high', ...item,
      findOpen: () => item.open || null,
      findArchived: () => item.archive || { ok: true, toolType: 'codex' },
      restore: async () => { assert.fail('must not restore this target'); },
    });
    assert.equal(result.restored, false);
  }
});

test('restore errors remain errors instead of creating a new unrelated tab', async () => {
  await assert.rejects(prepareClosedCodexSettings({
    tabId: 'closed', model: 'm', effort: 'high', findOpen: () => null,
    findArchived: () => ({ ok: true, toolType: 'codex' }),
    restore: async () => { throw new Error('exact cwd unavailable'); },
  }), /exact cwd unavailable/);
});

test('POST restores before settings, GET stays read-only, and restored unchanged intent is persisted by its main owner', () => {
  const web = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');
  const section = web.slice(web.indexOf('// SDK params (model/effort/thinking)'), web.indexOf('// Fast is a durable desired state.'));
  const post = section.slice(section.indexOf("req.method === 'POST'"));
  assert.ok(post.indexOf('prepareClosedCodexSettings(') < post.indexOf("bridgeRequest('setSDKParams'"));
  assert.doesNotMatch(section.slice(0, section.indexOf("req.method === 'POST'")), /prepareClosedCodexSettings/);
  const app = fs.readFileSync(path.join(__dirname, '../renderer/App.tsx'), 'utf8');
  assert.match(app, /payload\.persistRestoredCodexOptions === true[\s\S]{0,100}provider:set-options/);
  assert.match(post, /\.\.\.body, tabId, persistRestoredCodexOptions: preparation\.restored/);
});
