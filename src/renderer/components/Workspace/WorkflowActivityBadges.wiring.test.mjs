import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { transformSync } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, 'WorkflowActivityBadges.tsx'), 'utf8');

test('three activity counts coexist as static text on the top border, without pills or layout width', () => {
  const require=createRequire(import.meta.url),React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
  const module={exports:{}};
  vm.runInNewContext(transformSync(source,{loader:'tsx',format:'cjs'}).code,{module,exports:module.exports,
    require:name=>name==='./TabSignals'?{useTabCompletionNotificationDismissing:()=>false}:require(name)});
  const render=props=>renderToStaticMarkup(React.createElement(module.exports.default,
    {activeCount:0,busyCount:0,awaitingCount:0,completionNotificationCount:0,active:false,...props}));
  const html=render({activeCount:14,busyCount:3,inheritedBusyCount:2});
  assert.equal(render({activeCount:14,busyCount:3,inheritedBusyCount:2,active:true}),html,
    'workflow selection must not change activity count colours or weight');
  assert.match(html,/data-workflow-active-count/);assert.match(html,/data-workflow-inherited-count/);
  assert.match(html,/data-workflow-busy-count/);assert.match(html,/position:absolute/);
  assert.match(html,/font-size:max\(10px, 0\.9em\)/);assert.match(html,/font-weight:500/);
  assert.match(html,/translateY\(-50%\)/);
  assert.doesNotMatch(html,/background|border:|box-shadow|rounded-full|text-\[10px\]/);
  assert.doesNotMatch(render({}),/data-workflow-activity-counts/);
});

test('completion and AskUserQuestion rings live on workflow, not project', () => {
  assert.match(source, /data-workflow-awaiting-ring/);
  assert.match(source, /className="tab-awaiting-input absolute inset-0 rounded"/);
  assert.match(source, /data-workflow-completion-ring/);
  assert.match(source, /tab-completion-notification-alert/);
  assert.match(source, /data-workflow-completion-count/);
  assert.match(source, /useTabCompletionNotificationDismissing/);
});
