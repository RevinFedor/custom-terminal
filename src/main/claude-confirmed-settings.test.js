'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  deriveConfirmedClaudeSettings,
  deriveLatestConfirmedClaudeRuntimeEffort,
  projectConfirmedClaudeSettingsForRuntime,
  traceClaudeActiveBranch,
} = require('./claude-confirmed-settings');

function wrapper(uuid, parentUuid, kind, value, index, sessionId = 'session-a') {
  return {
    uuid,
    parentUuid,
    type: 'user',
    message: {
      content: `<command-name>/${kind}</command-name>\n<command-args>${value}</command-args>`,
    },
    timestamp: `2026-07-23T10:00:0${index}.000Z`,
    sessionId,
    _fromFile: sessionId,
    _fileIndex: index,
  };
}

function stdout(uuid, parentUuid, text, index, sessionId = 'session-a') {
  return {
    uuid,
    parentUuid,
    type: 'user',
    message: { content: `<local-command-stdout>${text}</local-command-stdout>` },
    timestamp: `2026-07-23T10:00:0${index}.000Z`,
    sessionId,
    _fromFile: sessionId,
    _fileIndex: index,
  };
}

test('requires direct wrapper → stdout proof and ignores an unfinished dialog', () => {
  const unfinished = wrapper('model-open', null, 'model', 'opus', 1);
  const effort = wrapper('effort-wrapper', 'model-open', 'effort', 'high', 2);
  const effortOut = stdout(
    'effort-out',
    'effort-wrapper',
    'Set effort level to high (saved as your default for new sessions)',
    3,
  );
  const unrelatedOut = stdout('wrong-parent', 'model-open', 'Set effort level to low', 4);

  assert.deepEqual(
    deriveConfirmedClaudeSettings([unfinished, effort, effortOut, unrelatedOut]),
    {
      effort: {
        value: 'high',
        proofAt: Date.parse(effortOut.timestamp),
        proofSessionId: 'session-a',
        wrapperUuid: 'effort-wrapper',
        stdoutUuid: 'effort-out',
      },
    },
  );
});

test('latest confirmed model and effort win independently', () => {
  const modelA = wrapper('model-a', null, 'model', 'haiku', 1);
  const modelAOut = stdout('model-a-out', 'model-a', 'Set model to Haiku 4.5', 2);
  const effort = wrapper('effort', 'model-a-out', 'effort', 'max', 3);
  const effortOut = stdout('effort-out', 'effort', 'Set effort level to max', 4);
  const modelB = wrapper('model-b', 'effort-out', 'model', 'sonnet', 5);
  const modelBOut = stdout('model-b-out', 'model-b', 'Set model to Sonnet 5', 6);
  const result = deriveConfirmedClaudeSettings([
    modelA,
    modelAOut,
    effort,
    effortOut,
    modelB,
    modelBOut,
  ]);

  assert.equal(result.model.value, 'sonnet');
  assert.equal(result.model.wrapperUuid, 'model-b');
  assert.equal(result.effort.value, 'max');
});

test('active parentUuid branch excludes a physically newer abandoned Rewind future', () => {
  const base = wrapper('base', null, 'model', 'haiku', 1);
  const baseOut = stdout('base-out', 'base', 'Set model to Haiku 4.5', 2);
  const abandoned = wrapper('abandoned', 'base-out', 'model', 'opus', 3);
  const abandonedOut = stdout('abandoned-out', 'abandoned', 'Set model to Opus 4.8', 4);
  const live = wrapper('live', 'base-out', 'model', 'sonnet', 5);
  const liveOut = stdout('live-out', 'live', 'Set model to Sonnet 5', 6);
  const map = new Map([
    [base.uuid, base],
    [baseOut.uuid, baseOut],
    [abandoned.uuid, abandoned],
    [abandonedOut.uuid, abandonedOut],
    [live.uuid, live],
    [liveOut.uuid, liveOut],
  ]);

  const { activeBranch } = traceClaudeActiveBranch({
    recordMap: map,
    lastRecord: liveOut,
  });
  assert.deepEqual(activeBranch.map((item) => item.uuid), [
    'base',
    'base-out',
    'live',
    'live-out',
  ]);
  assert.equal(deriveConfirmedClaudeSettings(activeBranch).model.value, 'sonnet');
});

test('process-local effort remains provable after the conversation branch moves past its slash pair', () => {
  const base = wrapper('base-model', null, 'model', 'opus', 1);
  const baseOut = stdout('base-model-out', 'base-model', 'Set model to Opus 5', 2);
  const effort = wrapper('runtime-effort', 'base-model-out', 'effort', 'max', 3);
  const effortOut = stdout(
    'runtime-effort-out',
    'runtime-effort',
    'Set effort level to max (this session only)',
    4,
  );
  const laterTurn = {
    uuid: 'later-turn',
    parentUuid: 'base-model-out',
    type: 'user',
    message: { content: 'Continue working' },
    timestamp: '2026-07-23T10:00:05.000Z',
    sessionId: 'session-a',
    _fromFile: 'session-a',
    _fileIndex: 5,
  };
  const records = [base, baseOut, effort, effortOut, laterTurn];
  const { activeBranch } = traceClaudeActiveBranch({
    recordMap: new Map(records.map((record) => [record.uuid, record])),
    lastRecord: laterTurn,
  });

  assert.equal(deriveConfirmedClaudeSettings(activeBranch)?.effort, undefined);
  assert.deepEqual(
    deriveLatestConfirmedClaudeRuntimeEffort(records, { sessionId: 'session-a' }),
    {
      value: 'max',
      proofAt: Date.parse(effortOut.timestamp),
      proofSessionId: 'session-a',
      wrapperUuid: 'runtime-effort',
      stdoutUuid: 'runtime-effort-out',
    },
  );
});

test('interactive effort picker recovers its value from the direct stdout child', () => {
  const effort = wrapper('picker-effort', null, 'effort', '', 1);
  const effortOut = stdout(
    'picker-effort-out',
    'picker-effort',
    'Set effort level to xhigh (saved as your default for new sessions)',
    2,
  );
  assert.deepEqual(
    deriveLatestConfirmedClaudeRuntimeEffort([effort, effortOut], { sessionId: 'session-a' }),
    {
      value: 'xhigh',
      proofAt: Date.parse(effortOut.timestamp),
      proofSessionId: 'session-a',
      wrapperUuid: 'picker-effort',
      stdoutUuid: 'picker-effort-out',
    },
  );
  assert.equal(deriveConfirmedClaudeSettings([effort, effortOut]).effort.value, 'xhigh');
});

test('interactive effort picker keeps the latest exact stdout value', () => {
  const xhigh = wrapper('effort-xhigh', null, 'effort', '', 1);
  const xhighOut = stdout('effort-xhigh-out', 'effort-xhigh', 'Set effort level to xhigh', 2);
  const high = wrapper('effort-high', 'effort-xhigh-out', 'effort', '', 3);
  const highOut = stdout('effort-high-out', 'effort-high', 'Set effort level to high', 4);
  const max = wrapper('effort-max', 'effort-high-out', 'effort', '', 5);
  const maxOut = stdout('effort-max-out', 'effort-max', 'Set effort level to max (this session only)', 6);
  assert.equal(deriveLatestConfirmedClaudeRuntimeEffort([
    xhigh, xhighOut, high, highOut, max, maxOut,
  ], { sessionId: 'session-a' }).value, 'max');
});

test('interactive model picker recovers its concrete label from stdout', () => {
  const model = wrapper('picker-model', null, 'model', '', 1);
  const modelOut = stdout(
    'picker-model-out',
    'picker-model',
    'Set model to Opus 5 (1M context)',
    2,
  );
  assert.equal(deriveConfirmedClaudeSettings([model, modelOut]).model.value, 'Opus 5 (1M context)');
});

test('linked resume chain can inherit a confirmed parent setting', () => {
  const parent = wrapper('parent-model', null, 'model', 'sonnet', 1, 'parent-session');
  const parentOut = stdout(
    'parent-model-out',
    'parent-model',
    'Set model to Sonnet 5',
    2,
    'parent-session',
  );
  const child = {
    uuid: 'child-turn',
    parentUuid: 'parent-model-out',
    type: 'user',
    message: { content: 'hello' },
    sessionId: 'child-session',
    _fromFile: 'child-session',
    _fileIndex: 1,
  };
  const map = new Map([
    [parent.uuid, parent],
    [parentOut.uuid, parentOut],
    [child.uuid, child],
  ]);

  const { activeBranch } = traceClaudeActiveBranch({
    recordMap: map,
    lastRecord: child,
    sessionBoundaries: [{
      parentSessionId: 'parent-session',
      childSessionId: 'child-session',
    }],
  });
  assert.equal(deriveConfirmedClaudeSettings(activeBranch).model.value, 'sonnet');
});

test('historical effort does not claim a newer Claude process generation', () => {
  const projected = projectConfirmedClaudeSettingsForRuntime({
    success: true,
    sessionId: 'session-a',
    effort: 'max',
    effortProofAt: 100,
    effortProofSessionId: 'session-a',
  }, {
    generation: 'launch-2',
    startedAt: 200,
    sessionId: 'session-a',
    processAlive: true,
  });
  assert.equal(projected.effortHistorical, 'max');
  assert.equal(projected.effort, null);
  assert.equal(projected.effortCurrentRuntime, false);
});

test('effort proof written inside the current live generation is current', () => {
  const projected = projectConfirmedClaudeSettingsForRuntime({
    success: true,
    sessionId: 'session-a',
    effort: 'low',
    effortProofAt: 250,
    effortProofSessionId: 'session-a',
  }, {
    generation: 'launch-2',
    startedAt: 200,
    sessionId: 'session-a',
    processAlive: true,
  });
  assert.equal(projected.effortHistorical, 'low');
  assert.equal(projected.effort, 'low');
  assert.equal(projected.effortCurrentRuntime, true);
});
