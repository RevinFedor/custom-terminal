'use strict';
// Host Electron-as-Node only. Actual organization/SQLite; process/input ports
// are recorded objects. No app, provider, shell or user database is started.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const DatabaseManager = require('./database');
const { createWorkflowOrganizationApi } = require('./workflow-organization-api');
const { createWorkflowSessionStop } = require('./workflow-session-stop');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-workflow-stop-sqlite-'));
  const sql = new Database(path.join(root, 'owned.db'));
  const database = new DatabaseManager({ existingConnection: sql }); database.initTables();
  sql.prepare('INSERT INTO projects(id,path,name) VALUES(?,?,?)').run('legacy=', root, 'Legacy');
  sql.prepare("INSERT INTO tabs(project_id,tab_id,name,cwd,command_type) VALUES('legacy=','legacy','Legacy',?,'codex')").run(root);
  const organization = createWorkflowOrganizationApi({ database });
  organization.bootstrap({ migrationId: 'stop-fixture-migrate', mutationId: 'stop-fixture-activate',
    workspace: { activeSpaceId: 'work', spaces: [
      { id: 'work', name: 'Work', projectIds: ['legacy='], layout: {} },
      { id: 'other', name: 'Other', projectIds: [], layout: {} },
    ] } });
  const create = (tabId, workflowId = 'work', record = {}) => organization.createTab({ mutationId: 'create:' + tabId,
    tabId, workflowId, cwd: root, record: { name: tabId, commandType: 'codex', ...record } });
  create('reserve'); create('hidden'); create('placed'); create('foreign', 'other');
  create('file', 'work', { tabType: 'file', commandType: null, filePath: path.join(root, 'no-disk-read.md') });
  const workflow = organization.service.getWorkflow('work');
  organization.service.saveLayout({ mutationId: 'stop-layout', workflowId: 'work',
    expectedRevision: organization.read().publication.revision, expectedWorkflowRevision: workflow.revision,
    layout: { splitPanes: [{ windowId: 'visible', tabIds: ['placed'], tabId: 'placed' }],
      hiddenWindows: [{ windowId: 'hidden-window', tabIds: ['hidden'] }] } });
  t.after(() => { sql.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const rows = organization.service.listMembers('work');
  const owners = new Map([...rows, ...organization.service.listMembers('other')].map(row => [row.tabId, { live: true, token: {} }]));
  const writes = [];
  const controller = createWorkflowSessionStop({ organization,
    captureOwner: row => owners.get(row.tabId), sameOwner: (a, b) => a.token === b.token,
    readBusy: () => ({ known: true, busy: false }), observe: async () => ({ known: true }),
    stop: async (tabId, owner, proof, guard) => {
      const check = guard(); if (!check.allowed) return { success: false, guardRejected: true, error: check.reason };
      const row = organization.service.getTab(tabId);
      writes.push({ tabId, subject: row.executionSubject, membership: row.membership });
      return { success: true };
    },
  });
  return { root, sql, organization, writes, controller, owners };
}

test('actual SQLite full canonical membership preserves mixed v1/v2 addresses and placed/hidden/reserve records', async t => {
  const f = fixture(t), before = f.organization.read();
  const result = await f.controller({ workflowId: 'work', mode: 'all' });
  assert.equal(result.success, true); assert.equal(result.stoppedCount, 4);
  assert.deepEqual(new Set(f.writes.map(row => row.tabId)), new Set(['legacy', 'reserve', 'hidden', 'placed']));
  assert.equal(f.writes.find(row => row.tabId === 'legacy').subject.projectId, 'legacy=');
  assert.ok(f.writes.filter(row => row.tabId !== 'legacy').every(row => row.subject.executionNamespace === '__tab_catalog_v2__'));
  assert.deepEqual(f.organization.read(), before, 'Stop selection never edits organization/identity/metadata/layout');
});

test('actual SQLite membership revision invalidates an old selection before the final Stop port', async t => {
  const f = fixture(t), originalStop = f.controller;
  let moved = false;
  const controller = createWorkflowSessionStop({ organization: f.organization,
    captureOwner: row => f.owners.get(row.tabId), sameOwner: (a, b) => a.token === b.token,
    readBusy: () => ({ known: true, busy: false }), observe: async tabId => {
      if (tabId === 'reserve' && !moved) {
        moved = true;
        f.organization.service.moveTab({ mutationId: 'stop-move', tabId, workflowId: 'other',
          expectedRevision: f.organization.read().publication.revision,
          expectedMembershipRevision: f.organization.service.getMembership(tabId).revision });
      }
      return { known: true };
    }, stop: async tabId => { f.writes.push(tabId); return { success: true }; },
  });
  const result = await controller({ workflowId: 'work', mode: 'idle' });
  assert.equal(result.skippedCount, 1); assert.equal(f.writes.includes('reserve'), false);
  assert.equal(f.organization.service.getMembership('reserve').workflowId, 'other');
  assert.ok(originalStop);
});
