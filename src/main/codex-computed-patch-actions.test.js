'use strict';

/**
 * apply_patch with a COMPUTED patch argument inside a nested exec.
 *
 * Production shape (rollout 01a00884, 16.08): the model writes
 *   const patch = "*** Begin Patch\n" + files.map(...) + "*** End Patch";
 *   const applied = await tools.apply_patch(patch);
 * The literal-value parser cannot resolve `patch` (it is a computed
 * expression), so the feed used to render the junk «Edit (patch)» card with
 * no file and no diff, alternating with «Bash node» for pages. The rollout,
 * however, carries the authoritative `patch_apply_end` event with the real
 * per-file changes on the SAME call_id — these tests lock the two-layer fix:
 * the event attaches to the nested-exec call, and the action decoder consumes
 * it when the patch text is unresolvable.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const {
  _api: { codexHistoryActionsForCall },
} = require(path.join(__dirname, 'ipc', 'codex-data.js'));

const NESTED_EXEC_INPUT = [
  'const r = await tools.exec_command({"cmd":"node <<\'NODE\'\\nconsole.log(1)\\nNODE"});',
  'const root = "/repo/";',
  'const files = ["a.md", "b.md"];',
  'const patch = "*** Begin Patch\\n" + files.map(p=>`*** Delete File: ../${p}\\n`).join("") + "*** End Patch";',
  'const applied = await tools.apply_patch(patch);',
  'text(JSON.stringify({applied}));',
].join('\n');

const APPLY_END_EVENT = {
  type: 'patch_apply_end',
  call_id: 'exec-1',
  success: true,
  changes: {
    '/repo/a.md': { type: 'delete' },
    '/repo/b.md': { type: 'delete' },
  },
};

test('computed apply_patch consumes the patch_apply_end event instead of junk «(patch)»', () => {
  const call = {
    toolName: 'exec',
    callId: 'exec-1',
    args: { input: NESTED_EXEC_INPUT },
    patchApplyEvents: [APPLY_END_EVENT],
    cwd: '/repo',
  };
  const { actions } = codexHistoryActionsForCall(call, undefined, false);
  const rawTools = actions.map((a) => a.rawTool).filter(Boolean);
  const edits = rawTools.filter((t) => t.family === 'edit' || /Edit|Write/.test(t.toolName));
  assert.ok(edits.length >= 2, 'both deleted files become edit actions: ' + JSON.stringify(rawTools.map(t => [t.toolName, t.args?.file_path])));
  const paths = edits.map((t) => String(t.args?.file_path || ''));
  assert.ok(paths.some((p) => p.endsWith('a.md')));
  assert.ok(paths.some((p) => p.endsWith('b.md')));
  assert.ok(!paths.includes('(patch)'), 'the junk placeholder is gone');
});

test('without the event the computed patch still degrades gracefully', () => {
  const call = {
    toolName: 'exec',
    callId: 'exec-1',
    args: { input: NESTED_EXEC_INPUT },
    patchApplyEvents: [],
    cwd: '/repo',
  };
  const { actions } = codexHistoryActionsForCall(call, undefined, false);
  assert.ok(actions.length > 0, 'still produces actions');
});

/**
 * A TEMPLATE LITERAL patch — the second computed form, and the one that did
 * not merely render an empty card but printed the SOURCE of the value as if
 * it were the value: the header read «Edit ${file}» and the diff body showed
 * `${content.split("` as three added lines (user screenshot, 16.08).
 */
const TEMPLATE_PATCH_INPUT = [
  'const file = "/repo/config.js";',
  'const content = "a\\nb";',
  'const patch = `*** Begin Patch',
  '*** Update File: ${file}',
  '@@',
  '${content.split("\\n").map(line => "+" + line).join("\\n")}',
  '*** End Patch`;',
  'await tools.apply_patch(patch);',
].join('\n');

test('a template-literal patch never prints its own source as a file name', () => {
  const call = {
    toolName: 'exec',
    callId: 'exec-2',
    args: { input: TEMPLATE_PATCH_INPUT },
    patchApplyEvents: [],
    cwd: '/repo',
  };
  const { actions } = codexHistoryActionsForCall(call, undefined, false);
  const subjects = actions
    .map((a) => String(a.rawTool?.args?.file_path || a.rawTool?.args?.summary || ''))
    .join(' | ');
  assert.ok(!subjects.includes('${'), 'no unresolved template shown as a subject: ' + subjects);
});

test('a template-literal patch shows the files the apply event proves', () => {
  const call = {
    toolName: 'exec',
    callId: 'exec-2',
    args: { input: TEMPLATE_PATCH_INPUT },
    patchApplyEvents: [{
      type: 'patch_apply_end',
      call_id: 'exec-2',
      success: true,
      changes: { '/repo/config.js': { type: 'update', unified_diff: '@@ -1 +1 @@\n-a\n+b\n' } },
    }],
    cwd: '/repo',
  };
  const { actions } = codexHistoryActionsForCall(call, undefined, false);
  const paths = actions.map((a) => String(a.rawTool?.args?.file_path || ''));
  assert.ok(paths.some((p) => p.endsWith('config.js')), 'real file name: ' + paths.join(','));
});

test('a patch that never applied says so instead of claiming an edit', () => {
  // Production cause: the script that was to BUILD the patch crashed, so no
  // event exists and no file changed. «Edit (patch)» painted that as success.
  const call = {
    toolName: 'apply_patch',
    callId: 'call-3',
    args: { input: 'const patch = buildIt();' },
    patchApplyEvents: [],
    cwd: '/repo',
  };
  const { actions } = codexHistoryActionsForCall(call, undefined, true);
  const raw = actions.map((a) => a.rawTool).filter(Boolean);
  assert.equal(raw.length, 1);
  assert.equal(raw[0].toolName, 'Patch');
  assert.ok(!String(raw[0].args?.file_path || '').length, 'claims no file');
  // Still collapses WITH the edits around it rather than standing alone.
  assert.equal(raw[0].family, 'edit');
});

test('an exec that calls no tool is a script run, not an invented category', () => {
  const call = {
    toolName: 'exec',
    callId: 'exec-4',
    args: { input: 'text(typeof atob);' },
    patchApplyEvents: [],
    cwd: '/repo',
  };
  const { actions } = codexHistoryActionsForCall(call, undefined, false);
  const raw = actions.map((a) => a.rawTool).filter(Boolean);
  assert.equal(raw.length, 1);
  assert.equal(raw[0].toolName, 'Script');
  assert.equal(raw[0].family, 'run', 'joins the noise class instead of splitting groups');
  assert.equal(raw[0].args.command, 'text(typeof atob);', 'the source is kept for the body');
});
