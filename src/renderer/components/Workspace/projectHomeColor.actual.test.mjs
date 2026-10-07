import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const homeFile = path.join(import.meta.dirname, 'ProjectHome.tsx');
const homeSource = fs.readFileSync(homeFile, 'utf8');
const homeAst = ts.createSourceFile(homeFile, homeSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const resolver = homeAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'homeCardColor');
assert.ok(resolver, 'Home uses one color boundary for archived records');
const chrome = fs.readFileSync(path.join(import.meta.dirname, 'tabChrome.ts'), 'utf8');
const context = { exports: {} };
vm.runInNewContext(ts.transpileModule(chrome, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, context);
context.getTabChromeColorConfig = context.exports.getTabChromeColorConfig;
vm.runInNewContext(ts.transpileModule(resolver.getText(homeAst) + '\nglobalThis.resolve = homeCardColor;', {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText, context);

test('Home сохраняет известные цвета и нейтральный фон, не заводит собственную палитру', () => {
  for (const entry of context.exports.TAB_COLORS) {
    const result = context.resolve(entry.color);
    assert.equal(result.borderColor, entry.borderColor);
    assert.equal(result.bgColor, entry.color === 'default' ? 'rgba(255,255,255,0.05)' : entry.bgColor);
  }
  assert.doesNotMatch(homeSource, /const TAB_COLORS[\s=:]|TAB_COLORS\[/);
  assert.equal((homeSource.match(/homeCardColor\(entry\.color\)/g) || []).length, 2);
  assert.match(homeSource, /homeCardColor\(hovered\.color\)\.borderColor/);
});

test('старые/неизвестные цвета безопасно отображаются без изменения сохранённого значения', () => {
  for (const color of ['retired-color', '#not-a-palette-id', 'toString', '__proto__', '', null, undefined, 42]) {
    const entry = { color };
    const result = context.resolve(entry.color);
    assert.equal(result.bgColor, 'rgba(255,255,255,0.05)');
    assert.equal(result.borderColor, '#666');
    assert.equal(entry.color, color);
  }
});
