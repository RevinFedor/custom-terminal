const test = require('node:test');
const assert = require('node:assert/strict');

const { CodexImageBindingRegistry } = require('./codex-image-bindings');

function ref(name) {
  return {
    id: 0,
    assetId: name.padEnd(64, name[0]) + '.png',
    path: '/stable/' + name + '.png',
    mediaType: 'image/png',
    size: 10,
    availability: 'available',
  };
}

test('slot bindings survive deletion and preserve the remaining exact image', () => {
  const registry = new CodexImageBindingRegistry();
  const token = registry.stage('tab', [ref('a'), ref('b')]);
  assert.equal(registry.begin('tab', token), true);
  registry.observe('tab', '\u001b[2J› [Image #1] [Image #2]');

  const result = registry.resolveGrab('tab', 'describe this [Image #1]');
  assert.equal(result.missing, 0);
  assert.equal(result.refs.length, 1);
  assert.equal(result.refs[0].path, '/stable/a.png');
});

test('reordered placeholders resolve by slot id rather than recent-path order', () => {
  const registry = new CodexImageBindingRegistry();
  const token = registry.stage('tab', [ref('a'), ref('b')]);
  registry.begin('tab', token);
  registry.observe('tab', '› [Image #1] [Image #2]');

  const result = registry.resolveGrab('tab', '[Image #2] then [Image #1]');
  assert.deepEqual(result.refs.map((item) => item.path), ['/stable/b.png', '/stable/a.png']);
  assert.equal(result.text, '[Image #2] then [Image #1]');
});

test('ambiguous offset slot never falls back to the wrong recent path', () => {
  const registry = new CodexImageBindingRegistry();
  const token = registry.stage('tab', [ref('a'), ref('b')]);
  registry.begin('tab', token);

  const result = registry.resolveGrab('tab', '[Image #4]');
  assert.equal(result.refs.length, 0);
  assert.equal(result.missing, 1);
  assert.equal(result.text, '[imageError: codex_image_path_unavailable #4]');
});

test('deletion before the first redraw still uses the predicted exact slot', () => {
  const registry = new CodexImageBindingRegistry();
  const token = registry.stage('tab', [ref('a'), ref('b')]);
  registry.begin('tab', token);

  const result = registry.resolveGrab('tab', '[Image #2]');
  assert.equal(result.missing, 0);
  assert.deepEqual(result.refs.map((item) => item.path), ['/stable/b.png']);
});

test('fast grab reconciles pending refs when slot and pending counts are exact', () => {
  const registry = new CodexImageBindingRegistry();
  const token = registry.stage('tab', [ref('a'), ref('b')]);
  registry.begin('tab', token);

  const result = registry.resolveGrab('tab', '[Image #4]\n[Image #5]');
  assert.equal(result.missing, 0);
  assert.deepEqual(result.refs.map((item) => [item.id, item.path]), [
    [4, '/stable/a.png'],
    [5, '/stable/b.png'],
  ]);
});

test('Ctrl+C during an active turn keeps image bindings for the queued draft', () => {
  const registry = new CodexImageBindingRegistry();
  const token = registry.stage('tab', [ref('a'), ref('b')]);
  registry.begin('tab', token);
  registry.observe('tab', '\u001b[2J\u203a [Image #1] text [Image #2]');

  assert.equal(registry.handleTerminalInput('tab', '\x03'), false);
  const result = registry.resolveGrab('tab', '[Image #1] text [Image #2]');

  assert.equal(result.missing, 0);
  assert.deepEqual(result.refs.map((item) => item.path), ['/stable/a.png', '/stable/b.png']);
});

test('Enter transfers composer ownership and clears old image bindings', () => {
  const registry = new CodexImageBindingRegistry();
  const token = registry.stage('tab', [ref('a')]);
  registry.begin('tab', token);
  registry.observe('tab', '\u001b[2J\u203a [Image #1]');

  assert.equal(registry.handleTerminalInput('tab', '\r'), true);
  const result = registry.resolveGrab('tab', '[Image #1]');

  assert.equal(result.missing, 1);
  assert.equal(result.refs.length, 0);
});
