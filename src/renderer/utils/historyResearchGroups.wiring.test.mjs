import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const source = name => fs.readFileSync(new URL('../components/Workspace/' + name, import.meta.url), 'utf8');
const primary = source('HistoryPanel.tsx'), shared = source('HistoryTranscriptPresentation.tsx');

test('user-side group reuses the real user shell and one native button, not an extra painted parent', () => {
  const start = shared.indexOf("if (group.familyKey === 'research')");
  const end = shared.indexOf('const live =', start);
  const branch = shared.slice(start, end);
  assert.match(branch, /ConversationMessage layout="user"/);
  assert.match(branch, /contentClassName="hp-history-research-group-bubble"/);
  assert.match(branch, /onClick=\{onToggle\}/);
  assert.match(branch, /aria-expanded=\{expanded\}/);
  assert.doesNotMatch(branch, /entry\.content|caption|model|timestamp|onDoubleClick|scrollTop|bubbleClassName/);
});

test('primary and nested members reuse the shared rail and existing collapse transaction', () => {
  for (const text of [primary, shared]) assert.match(text, /expandedGroup\.familyKey === 'research' \? ' hp-history-group-member--research'/);
  assert.match(primary, /collapseGroupPreservingViewport\(group\.key\)/);
  assert.match(primary, /expandGroupPreservingViewport\(group\.key, 'click'\)/);
  assert.match(primary, /paddingTop: expandedGroup \|\| expandedSubgroup \? 0 : 4/);
  assert.match(primary, /paddingBottom: expandedGroup \|\| expandedSubgroup \? 0 : 4/);
});

test('research header leaves geometry and scroll ownership to the host', () => {
  assert.match(shared, /data-history-research-group-expanded=\{expanded \? '1' : undefined\}/);
  const branch = shared.slice(shared.indexOf("if (group.familyKey === 'research')"), shared.indexOf('const live =', shared.indexOf("if (group.familyKey === 'research')")));
  assert.doesNotMatch(branch, /getBoundingClientRect|ResizeObserver|useEffect|setTimeout/);
});
