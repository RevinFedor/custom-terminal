const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizePrefixText,
  createMetaPromptMarker,
  findPresetPrefixMatch,
  headTailExcerpt,
  buildBoundedPromptExcerpts,
  sourceSha256,
  prepareGroupingInput,
  validateOutline,
} = require('./timeline-outline-service');

test('normalizes BOM, CRLF, and leading whitespace for anchored preset matching', () => {
  const preset = { id: 'docs-update', title: 'Update docs', content: '\uFEFF  First line\r\nSecond line' };
  const message = '\n\tFirst line\nSecond line\nTask-specific suffix';
  const match = findPresetPrefixMatch(message, [preset]);

  assert.deepEqual(match.marker, {
    kind: 'meta_prompt',
    presetId: 'docs-update',
    title: 'Update docs',
  });
  assert.equal(normalizePrefixText(' \t\uFEFF \r\nHello\rWorld'), 'Hello\nWorld');
});

test('uses the longest anchored preset and never fuzzy-matches the middle of a prompt', () => {
  const presets = [
    { id: 'short', title: 'Short', content: 'Update documentation' },
    { id: 'long', title: 'Full update', content: 'Update documentation\nRead all affected files' },
  ];

  assert.equal(
    findPresetPrefixMatch('Update documentation\nRead all affected files\nNow do it', presets).marker.presetId,
    'long'
  );
  assert.equal(findPresetPrefixMatch('Please Update documentation', presets), null);
  assert.deepEqual(createMetaPromptMarker(presets[0]), {
    kind: 'meta_prompt',
    presetId: 'short',
    title: 'Short',
  });
});

test('head-tail excerpts retain both ends and respect the exact character limit', () => {
  const text = 'HEAD-' + 'x'.repeat(500) + '-TAIL';
  const excerpt = headTailExcerpt(text, 80);
  assert.equal(excerpt.length, 80);
  assert.ok(excerpt.startsWith('HEAD-'));
  assert.ok(excerpt.endsWith('-TAIL'));
  assert.match(excerpt, /middle omitted/);
  assert.equal(headTailExcerpt(text, 23).length, 23);
});

test('bounded excerpts share one total budget and leave meta markers content-free', () => {
  const entries = [
    { uuid: 'a', kind: 'prompt', text: 'A'.repeat(1_000) },
    { uuid: 'meta', kind: 'meta_prompt', presetId: 'preset', title: 'Preset' },
    { uuid: 'b', kind: 'prompt', text: 'B'.repeat(1_000) },
    { uuid: 'c', kind: 'prompt', text: 'short' },
  ];
  const bounded = buildBoundedPromptExcerpts(entries, { totalCharBudget: 205, maxPerEntry: 500 });
  const ordinaryChars = bounded
    .filter((entry) => entry.kind === 'prompt')
    .reduce((sum, entry) => sum + entry.text.length, 0);

  assert.ok(ordinaryChars <= 205);
  assert.deepEqual(bounded[1], entries[1]);
  assert.equal('text' in bounded[1], false);
  assert.equal(bounded[3].text, 'short');
});

test('prepares canonical input without compact content and replaces preset bodies with metadata', () => {
  const presetBody = 'Long documentation workflow\n' + 'secret instructions '.repeat(100);
  const result = prepareGroupingInput([
    { uuid: 'compact-a', type: 'compact', content: 'encrypted compact summary must not leak' },
    { uuid: 'u1', type: 'user', content: presetBody + '\nlocal suffix' },
    { uuid: 'continued', type: 'continued', content: 'continued bridge text' },
    { uuid: 'sub', type: 'user', content: 'sub-agent prompt', isSubAgent: true },
    { uuid: 'slash', type: 'user', content: '/compact' },
    { uuid: 'u2', kind: 'user', full: 'Implement the tree view', isPlan: true },
  ], [{ id: 'docs', title: 'Documentation update', content: presetBody }], {
    totalCharBudget: 200,
  });

  assert.equal(result.compactCount, 1);
  assert.deepEqual(result.eligibleUuids, ['u1', 'u2']);
  assert.deepEqual(result.entries[0], {
    uuid: 'u1',
    order: 0,
    timestamp: null,
    kind: 'meta_prompt',
    presetId: 'docs',
    title: 'Documentation update',
  });
  assert.equal(JSON.stringify(result.entries).includes('secret instructions'), false);
  assert.equal(result.entries[1].hints.isPlan, true);
  assert.equal(result.sourceEntryCount, 2);
  assert.equal(result.sourceLastUuid, 'u2');
});

test('source hashes are stable across object key order and change with semantic source content', () => {
  assert.equal(sourceSha256({ b: 2, a: 1 }), sourceSha256({ a: 1, b: 2 }));
  assert.notEqual(sourceSha256({ text: 'one' }), sourceSha256({ text: 'two' }));
  assert.match(sourceSha256({ a: 1 }), /^[a-f0-9]{64}$/);
});

function validOutline() {
  return {
    groups: [
      {
        title: 'Initial implementation',
        description: 'Built the first version and clarified its boundaries.',
        members: [
          { uuid: 'a', description: 'Set the implementation goal', role: 'implementation' },
          { uuid: 'b', description: 'Clarified the required behavior', role: 'clarification' },
        ],
      },
      {
        title: 'Verification',
        description: 'Checked the completed behavior.',
        members: [
          { uuid: 'c', description: 'Ran the focused checks', role: 'verification' },
        ],
      },
    ],
  };
}

test('accepts a flat ordered contiguous partition and derives stable local group IDs', () => {
  const validated = validateOutline(validOutline(), ['a', 'b', 'c']);
  assert.equal(validated.groups.length, 2);
  assert.deepEqual(validated.groups[0].memberUuids, ['a', 'b']);
  assert.equal(validated.groups[0].startUuid, 'a');
  assert.equal(validated.groups[0].endUuid, 'b');
  assert.match(validated.groups[0].id, /^timeline-group-[a-f0-9]{16}$/);
  assert.equal(
    validated.groups[0].id,
    validateOutline(validOutline(), ['a', 'b', 'c']).groups[0].id
  );
});

test('rejects missing, unknown, duplicate, reordered, and nested UUID layouts', () => {
  const missing = validOutline();
  missing.groups.pop();
  assert.throws(() => validateOutline(missing, ['a', 'b', 'c']), { code: 'missing_outline_uuid' });

  const unknown = validOutline();
  unknown.groups[1].members[0].uuid = 'unknown';
  assert.throws(() => validateOutline(unknown, ['a', 'b', 'c']), { code: 'unknown_outline_uuid' });

  const duplicate = validOutline();
  duplicate.groups[1].members[0].uuid = 'b';
  assert.throws(() => validateOutline(duplicate, ['a', 'b', 'c']), { code: 'duplicate_outline_uuid' });

  const reordered = validOutline();
  reordered.groups[0].members.reverse();
  assert.throws(() => validateOutline(reordered, ['a', 'b', 'c']), { code: 'non_contiguous_outline' });

  const nested = validOutline();
  nested.groups[0].groups = [];
  assert.throws(() => validateOutline(nested, ['a', 'b', 'c']), { code: 'invalid_outline' });
});

test('rejects extra response fields and unsupported member roles', () => {
  const extra = validOutline();
  extra.note = 'not in the contract';
  assert.throws(() => validateOutline(extra, ['a', 'b', 'c']), { code: 'invalid_outline' });

  const role = validOutline();
  role.groups[0].members[0].role = 'nested-research-phase';
  assert.throws(() => validateOutline(role, ['a', 'b', 'c']), { code: 'invalid_outline' });
});

test('marks deterministic barriers and rejects a group that crosses one', () => {
  const prepared = prepareGroupingInput([
    { uuid: 'a', type: 'user', content: 'first' },
    { uuid: 'bridge', type: 'continued', content: 'context overflow' },
    { uuid: 'b', type: 'user', content: 'second' },
  ]);
  assert.equal(prepared.entries[1].boundaryBefore, true);

  const crossing = {
    groups: [{
      title: 'Crossing group',
      description: 'This incorrectly crosses the structural bridge.',
      members: [
        { uuid: 'a', description: 'Before', role: 'implementation' },
        { uuid: 'b', description: 'After', role: 'implementation' },
      ],
    }],
  };
  assert.throws(() => validateOutline(crossing, prepared.entries), { code: 'outline_crosses_boundary' });
});
