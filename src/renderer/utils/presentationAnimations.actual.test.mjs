import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? files(file) : /\.tsx$/.test(file) ? [file] : [];
  });
}

test('every authored inline infinite indicator opts into the retained animation pause', () => {
  const missing = [], covered = [], compositorDots = [];
  const componentFiles = files(path.join(root, 'components'));
  for (const file of componentFiles) {
    const source = fs.readFileSync(file, 'utf8');
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    function visit(node) {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const attributes = node.attributes.properties;
        const className = attributes.find(a => ts.isJsxAttribute(a) && a.name.text === 'className');
        const classes = className?.initializer?.getText(ast) || '';
        if (classes.includes('noted-background-task-dot')) {
          assert.ok(classes.includes('animate-glow-yellow') && classes.includes('noted-infinite-animation'),
            'background-task dots keep the shared compositor glow and hidden-owner pause');
          compositorDots.push(path.relative(root, file));
        }
        const style = attributes.find(a => ts.isJsxAttribute(a) && a.name.text === 'style');
        const expression = style?.initializer && ts.isJsxExpression(style.initializer) ? style.initializer.expression : null;
        if (expression) {
          let infinite = false;
          const inspect = value => {
            if (ts.isPropertyAssignment(value) && value.name.getText(ast) === 'animation'
              && value.initializer.getText(ast).includes('infinite')) infinite = true;
            ts.forEachChild(value, inspect);
          };
          inspect(expression);
          if (infinite) {
            const location = path.relative(root, file) + ':' + (ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1);
            if (className?.initializer?.getText(ast).includes('noted-infinite-animation')) covered.push(location);
            else missing.push(location);
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
  assert.ok(covered.length > 0 && componentFiles.some(file => file.endsWith('/Workspace/HistoryPanel.tsx')),
    'audit scans the actual renderer tree; moving animations to CSS must not fail a fixed inline-count floor');
  assert.deepEqual(compositorDots.sort(), [
    'components/Workspace/ClaudeSDK/BackgroundTasksBar.tsx',
    'components/Workspace/HistoryPanel.tsx',
  ]);
  assert.deepEqual(missing, [], 'a new inline loop needs the explicit pause marker on the same element');
});

test('the pause target stays exact and covers every authored glow variant', () => {
  const css = fs.readFileSync(path.join(root, 'styles/presentationAnimations.css'), 'utf8');
  const globals = fs.readFileSync(path.join(root, 'styles/globals.css'), 'utf8');
  assert.doesNotMatch(css, /\[(?:style|class)\s*[*^$|~]?=/, 'generic attribute selectors expand retained subtree invalidation');
  const glows = [...globals.matchAll(/^\.(animate-glow-[a-z]+)\s*\{/gm)].map(m => m[1]);
  assert.ok(glows.length >= 7);
  for (const glow of glows) assert.ok(css.includes('.' + glow), glow + ' keeps background pause');
  assert.match(css, /\.noted-infinite-animation/);
  assert.match(css, /animation-play-state: paused, running !important/,
    'finite dismissal remains live while its infinite notification ring is paused');
});
