import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const terminalAreaSource = readFileSync(join(here, 'TerminalArea.tsx'), 'utf8');
const terminalSource = readFileSync(join(here, 'Terminal.tsx'), 'utf8');

test('pane presentation drives actual fit ownership in both directions', () => {
  assert.match(terminalAreaSource, /typeof detail\.presented !== 'boolean'/);
  assert.match(terminalAreaSource, /panePresentedRef\.current = detail\.presented/);
  assert.match(
    terminalAreaSource,
    /active=\{latched \|\| actualActive\}/,
  );
  assert.match(
    terminalAreaSource,
    /actualPresentationRef=\{persistentPane \? panePresentedRef : undefined\}/,
  );
  assert.doesNotMatch(terminalAreaSource, /setPanePresented/);
});

test('visited center xterm joins the same retained outer-opacity boundary', () => {
  assert.match(terminalAreaSource, /retainedCenterTerminalPresentations\.add\(tab\.id\)/);
  assert.match(terminalAreaSource, /const externallyProjected = inPane \|\| retainCanvasPixels/);
  assert.match(terminalAreaSource, /data-terminal-retained-presentation=\{retainCanvasPixels \? '1'/);
  assert.match(terminalAreaSource, /opacity: terminalSurfacePresented \? 1 : 0/);
  assert.match(terminalAreaSource, /retainCanvasPixels=\{retainCanvasPixels\}/);
});

test('retained Canvas does not grant hidden terminal fit, focus or repaint ownership', () => {
  assert.match(
    terminalSource,
    /useLayoutEffect\(\(\) => \{\s*activeRef\.current = effectivePresented;/,
  );
  assert.match(terminalSource, /if \(actualPresentationRef\.current\) \{\s*window\.requestAnimationFrame/);
  assert.match(terminalSource, /visibility: canvasLayerVisible \? 'inherit' : 'hidden'/);
  assert.match(terminalSource, /pointerEvents: effectivePresented \? 'auto' : 'none'/);
  assert.match(terminalSource, /shouldRepaintTerminalOnActivation\(\{/);
  assert.match(terminalSource, /retained canvas reused without clear\/refresh/);
});

test('visible-set diagnostics do not force layout across every retained xterm', () => {
  const diagnostic = terminalSource.slice(
    terminalSource.indexOf('const collectTerminalLayerSnapshots'),
    terminalSource.indexOf('const rememberDetectedShellCommand'),
  );
  assert.match(diagnostic, /terminalSurfacePresented/);
  assert.doesNotMatch(diagnostic, /getComputedStyle|getBoundingClientRect/);
  assert.match(terminalAreaSource, /data-terminal-surface-presented=\{terminalSurfacePresented \? '1' : '0'\}/);
});
