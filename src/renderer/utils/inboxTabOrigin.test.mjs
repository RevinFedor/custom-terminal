import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isInboxApiCreatedTab } from './inboxTabOrigin.mjs';

const here = dirname(fileURLToPath(import.meta.url));

test('Inbox API provenance comes from the durable run receipt, not project or title', () => {
  assert.equal(isInboxApiCreatedTab({
    id: 'renamed-and-moved',
    name: 'Любое название',
    externalRun: { runId: 'run-1' },
  }), true);
  assert.equal(isInboxApiCreatedTab({
    id: '__noted_inbox__-tab-51',
    name: 'Моя личная вкладка',
  }), false);
  assert.equal(isInboxApiCreatedTab({
    id: '__noted_inbox__-tab-external-looking',
    name: 'Inbox API',
    externalRun: {},
  }), false);
});

test('the fixed provenance marker follows the title and precedes pane/process controls', () => {
  const source = fs.readFileSync(join(here, '../components/Workspace/TabBar.tsx'), 'utf8');
  const title = source.indexOf('<span className="truncate min-w-0">{tab.name}</span>');
  const marker = source.indexOf('data-tab-inbox-origin');
  const paneMap = source.indexOf('<TabPaneMap projectId={projectId} tabId={tab.id} />');
  assert.ok(title >= 0 && marker > title && paneMap > marker);
  assert.match(source, /isVerticalMode && !isCollapsed && isInboxApiOrigin/);
  assert.match(source, /data-tab-origin=\{isInboxApiOrigin \? 'inbox-api' : undefined\}/);
});
