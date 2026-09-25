import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const file = path.resolve(import.meta.dirname, '../components/Workspace/ResourceUsageButton.tsx');
const source = fs.readFileSync(file, 'utf8');
const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function declaration(name) {
  let result = null;
  const visit = node => {
    if (ts.isVariableDeclaration(node) && (
      node.name.getText(ast) === name
      || (ts.isArrayBindingPattern(node.name)
        && node.name.elements.some(element => element.name?.getText(ast) === name))
    )) result = node;
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(result, 'real component declares ' + name);
  return result;
}

function evaluate(expression, scope) {
  const js = ts.transpileModule('globalThis.result = ' + expression + ';', {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  vm.runInNewContext(js, scope);
  return scope.result;
}

test('all projects start collapsed; only a click expands a chosen project', () => {
  const stateDecl = declaration('expandedProjects');
  assert.match(stateDecl.initializer.getText(ast), /useState<Set<string>>\(new Set\(\)\)/);
  let expandedProjects = new Set();
  const scope = {
    setExpandedProjects: update => { expandedProjects = update(expandedProjects); },
  };
  const callback = declaration('toggleProject').initializer.arguments[0].getText(ast);
  const toggleProject = evaluate(callback, scope);
  const isOpen = declaration('isOpen').initializer.getText(ast);
  const shown = projectId => evaluate(isOpen, { expandedProjects, project: { projectId } });

  assert.equal(shown('current'), false);
  assert.equal(shown('other'), false);
  toggleProject('current');
  assert.equal(shown('current'), true);
  assert.equal(shown('other'), false);
  toggleProject('other');
  assert.equal(shown('other'), true);
  toggleProject('current');
  assert.equal(shown('current'), false);
  assert.equal(shown('other'), true);
  assert.match(source, /fontWeight: project\.isCurrent \? 600 : 400/,
    'current project stays visually highlighted independent of expansion');
});
