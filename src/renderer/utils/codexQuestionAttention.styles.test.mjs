import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import postcss from 'postcss';

const css = postcss.parse(fs.readFileSync(new URL('../styles/globals.css', import.meta.url), 'utf8'));
const rule = selector => css.nodes.find(node => node.type === 'rule' && node.selector === selector);
const declarations = node => Object.fromEntries(node.nodes.filter(n => n.type === 'decl').map(n => [n.prop, n.value]));
const ring = declarations(rule('.tab-codex-question-ring'));
const workflow = declarations(rule('.tab-codex-question-ring[data-workflow-codex-question-ring]'));
const glow = declarations(rule('.tab-codex-question-ring::after'));

test('native question uses a blue border with stronger exact-tab intensity', () => {
  assert.equal(ring['--codex-question-ring-width'], '2px');
  assert.equal(workflow['--codex-question-ring-width'], '1.5px');
  assert.equal(ring['--codex-question-ring-track'], 'rgba(59,130,246,.70)');
  assert.equal(workflow['--codex-question-ring-track'], 'rgba(59,130,246,.58)');
  assert.equal(ring['--codex-question-ring-peak'], 'rgba(147,197,253,.98)');
  assert.equal(workflow['--codex-question-ring-peak'], 'rgba(96,165,250,.90)');
});

test('glow changes only its own opacity, with a permanent visible track', () => {
  const frames = css.nodes.find(n => n.type === 'atrule' && n.name === 'keyframes' && n.params === 'codex-question-glow');
  assert.deepEqual(frames.nodes.map(n => declarations(n)), [{ opacity: '.16' }, { opacity: '1' }]);
  assert.match(ring['box-shadow'], /var\(--codex-question-ring-track\)/);
  assert.match(glow['box-shadow'], /var\(--codex-question-ring-peak\)/);
  assert.equal(glow.animation, 'codex-question-glow 2.2s ease-in-out infinite');
  assert.equal(glow['animation-play-state'], 'inherit');
  assert.equal(glow['will-change'], 'opacity');
  assert.ok(!('opacity' in ring) && !('animation' in ring));
});

test('both decorative layers leave geometry and hit targets unchanged', () => {
  for (const layer of [ring, glow]) {
    assert.equal(layer.position, 'absolute');
    assert.equal(layer.inset, '0');
    assert.equal(layer['border-radius'], 'inherit');
    assert.equal(layer['pointer-events'], 'none');
    for (const prop of ['padding', 'border', 'width', 'height', 'filter']) assert.ok(!(prop in layer), prop);
  }
});

test('reduced motion retains an obvious static blue border', () => {
  const media = css.nodes.find(n => n.type === 'atrule' && n.name === 'media' && n.params === '(prefers-reduced-motion: reduce)'
    && n.nodes.some(n => n.selector === '.tab-codex-question-ring::after'));
  assert.deepEqual(declarations(media.nodes[0]), { animation: 'none', opacity: '.75', 'will-change': 'auto' });
});

test('existing tab/workflow carriers retain exact hidden-animation pause markers', () => {
  for (const [name, marker] of [['TabCard.tsx', 'data-tab-codex-question-ring'], ['WorkflowActivityBadges.tsx', 'data-workflow-codex-question-ring']]) {
    const source = fs.readFileSync(new URL('../components/Workspace/' + name, import.meta.url), 'utf8');
    assert.match(source, new RegExp(marker + '[\\s\\S]{0,180}tab-codex-question-ring noted-infinite-animation'));
  }
});
