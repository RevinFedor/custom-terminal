'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const ts = require('typescript');

const sourcePath = path.join(__dirname, '..', 'web-server.js');
const bindingNames = ['isDesktopCodexCompactQueueRequest', 'DESKTOP_COMPACT_ADMISSION',
  'BUILD_CONTINUE_ADMISSION', 'SELF_REWIND_ADMISSION', 'compactSendDeliveryIdentity'];
const installed = new WeakMap();
let defaultTree;

function declares(binding, name) {
  if (ts.isIdentifier(binding)) return binding.text === name;
  return binding.elements?.some(element => element.name && declares(element.name, name)) === true;
}

// Existing tests extract selected Web functions, not the entire service. Keep
// their new lexical dependencies real: import the actual top-level statements
// instead of inventing a Symbol/helper/global fallback in each fixture.
function installAgentSendWebBindings(context, tree) {
  assert.ok(vm.isContext(context), 'an existing Web VM context is required');
  if (!tree) {
    defaultTree ||= ts.createSourceFile(sourcePath, fs.readFileSync(sourcePath, 'utf8'), ts.ScriptTarget.Latest, true);
    tree = defaultTree;
  } else if (typeof tree === 'string') {
    tree = ts.createSourceFile(sourcePath, tree, ts.ScriptTarget.Latest, true);
  }
  const selected = bindingNames.map(name => {
    const matches = tree.statements.filter(node => ts.isVariableStatement(node)
      && node.declarationList.declarations.some(declaration => declares(declaration.name, name)));
    assert.equal(matches.length, 1, 'actual Web binding must have one top-level declaration: ' + name);
    return matches[0];
  });
  const code = [...new Set(selected)].sort((left, right) => left.pos - right.pos)
    .map(node => node.getText(tree)).join('\n');
  if (installed.has(context)) {
    assert.equal(installed.get(context), code, 'cannot replace Web bindings in an existing VM');
    return context;
  }
  // Some older fixtures intentionally restrict require() for unrelated route
  // dependencies. Resolve these real imports with the actual Web loader only
  // while evaluating their declarations, then restore that fixture boundary.
  const dependencies = { require: createRequire(sourcePath), path, srcMainDir: path.dirname(sourcePath) };
  const previous = Object.fromEntries(Object.keys(dependencies)
    .map(key => [key, Object.getOwnPropertyDescriptor(context, key)]));
  try {
    Object.assign(context, dependencies);
    vm.runInContext(code, context, { filename: 'actual-web-send-bindings.js' });
    installed.set(context, code);
  } finally {
    for (const key of Object.keys(dependencies)) {
      if (previous[key]) Object.defineProperty(context, key, previous[key]);
      else delete context[key];
    }
  }
  return context;
}

module.exports = { installAgentSendWebBindings };
