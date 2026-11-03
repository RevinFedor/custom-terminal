'use strict';
// Where is a blocking tab? Two different answers, and a build-blocker list
// needs the one the user navigates by.
//
// Reported 02Nov against `build:i-obs`: a blocker printed `sc-desktop`, so the
// user went looking in the sc-desk workflow — where that tab had not been for
// weeks. It lives in the `main` workflow and only RUNS in ~/Desktop/sc-desktop.
// Moving a tab between workflows deliberately keeps cwd/execution identity
// (fact-workspace.md::Workflow, вкладка и исполнение), so these two names
// diverge by design and a label that names only execution is unusable for
// finding the tab.
//
// This executes the REAL `labelFor` sliced out of computeActiveLoaders, so the
// lookup order, the caches and the organization read are the shipped ones.
//
// Run: node --test src/main/install-blocker-label.actual.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(process.env.ACTUAL_SOURCE_DIR || __dirname, 'main.js'), 'utf8');
const from = source.indexOf('  const projNameCache = new Map();',
  source.indexOf('function computeActiveLoaders'));
assert.ok(from > 0, 'labelFor must live in computeActiveLoaders');
const to = source.indexOf('\n  };', source.indexOf('  const labelFor = (tabId) => {', from));
assert.ok(to > from, 'labelFor must be sliceable');
const body = source.slice(from, to + '\n  };'.length);

function build({ membership = 'space-1', workflowName = 'main', ready = true,
  projectName = 'sc-desktop', tabRow = { name: 'позиционирование анализ конкурентов' },
  organizationThrows = false } = {}) {
  const queries = [];
  const context = {
    terminalProjectIds: new Map(),
    terminalProjects: new Map([['T', '/Users/fedor/Desktop/sc-desktop']]),
    tabRowFor: () => (tabRow ? { ...tabRow, project_id: 'ns-exec', command_type: 'codex' } : null),
    projectManager: { db: { db: { prepare: (sql) => ({ get: () => { queries.push(sql); return { name: projectName }; } }) } } },
    workflowOrganization: {
      ready: () => ready,
      service: {
        getMembership: (tabId) => {
          if (organizationThrows) throw new Error('organization unavailable');
          queries.push('membership:' + tabId);
          return membership ? { tabId, workflowId: membership } : null;
        },
        getWorkflow: (id) => {
          queries.push('workflow:' + id);
          return workflowName ? { metadata: { name: workflowName } } : null;
        },
      },
    },
    module: { exports: {} },
  };
  vm.createContext(context);
  vm.runInContext(body + '\nmodule.exports = labelFor;', context);
  return { labelFor: context.module.exports, queries };
}

test('a moved tab reports BOTH the workflow it lives in and the directory it runs in', () => {
  const h = build();
  const label = h.labelFor('T');
  assert.equal(label.workflow, 'main', 'the sidebar name — this is how the user finds the tab');
  assert.equal(label.project, 'sc-desktop', 'the execution namespace is kept, not replaced');
  assert.equal(label.cwd, '/Users/fedor/Desktop/sc-desktop');
  assert.equal(label.name, 'позиционирование анализ конкурентов');
});

test('before the workflow migration the label degrades to execution only', () => {
  // A pre-migration app has no workflow layer at all. `null` keeps the old
  // single-name output instead of inventing a workflow.
  const h = build({ ready: false });
  assert.equal(h.labelFor('T').workflow, null);
  assert.equal(h.labelFor('T').project, 'sc-desktop');
  assert.ok(!h.queries.some(q => String(q).startsWith('membership:')), 'no organization read when it is not ready');
});

test('a tab with no membership, and an unreadable organization, stay survivable', () => {
  assert.equal(build({ membership: null }).labelFor('T').workflow, null);
  assert.equal(build({ workflowName: null }).labelFor('T').workflow, null);
  const broken = build({ organizationThrows: true });
  assert.doesNotThrow(() => broken.labelFor('T'));
  assert.equal(broken.labelFor('T').workflow, null);
  assert.equal(broken.labelFor('T').project, 'sc-desktop', 'a failed workflow read cannot lose the execution name');
});

test('both names are cached per call: many tabs in one workflow cost one lookup', () => {
  // computeActiveLoaders calls this once per blocking tab; an uncached read
  // would be two SQL statements per tab on a list that exists to be cheap.
  const h = build();
  h.labelFor('T'); h.labelFor('T2'); h.labelFor('T3');
  assert.equal(h.queries.filter(q => String(q).startsWith('workflow:')).length, 1);
  assert.equal(h.queries.filter(q => typeof q === 'string' && q.includes('FROM projects')).length, 1);
  assert.equal(h.queries.filter(q => String(q).startsWith('membership:')).length, 3,
    'membership is per tab and must not be cached across tabs');
});

test('a tab with no name falls back to its id, never to an empty label', () => {
  const h = build({ tabRow: { name: null } });
  assert.match(h.labelFor('tab-abcdef123456').name, /^tab /);
});
