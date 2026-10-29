import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import net from 'node:net';
import { build } from 'vite';
import { codeInspectorPlugin } from 'code-inspector-plugin';

const root = resolve(import.meta.dirname, '..');
const config = await readFile(join(root, 'electron.vite.config.js'), 'utf8');
assert.match(config, /injectTo:\s*resolve\(__dirname,\s*'src\/renderer\/main\.tsx'\)/);
assert.match(config, /skipSnippets:\s*\[\s*'htmlScript'\s*\]/);
assert.match(config, /server:\s*'close'/);
assert.match(config, /hotKeys:\s*\[\s*'altKey',\s*'shiftKey'\s*\]/);
assert.match(config, /copy:\s*false/);
assert.match(config, /locate:\s*false/);
const temp = await realpath(await mkdtemp(join(tmpdir(), 'noted-inspector-repro-')));
const originalCwd = process.cwd();
const originalListen = net.Server.prototype.listen;
let listenCalls = 0;
net.Server.prototype.listen = function () { listenCalls++; throw new Error('unexpected TCP listener'); };
try {
  for (const present of [false, true]) {
    const fixture = join(temp, present ? 'present' : 'absent');
    await mkdir(join(fixture, 'src'), { recursive: true });
    await writeFile(join(fixture, 'index.html'), '<html><head></head><body><script type="module" src="/src/main.tsx"></script></body></html>');
    await writeFile(join(fixture, 'src/main.tsx'), 'const node = <div>Hello fixture</div>; console.log(node);');
    if (present) await writeFile(join(fixture, 'main.js'), '// incidental root artifact\n');
    process.chdir(fixture);
    for (const mode of ['old', 'fixed']) {
      const options = { bundler: 'vite', dev: () => true, server: 'close', behavior: { locate: false, copy: false }, hotKeys: ['altKey', 'shiftKey'], pathType: 'relative' };
      if (mode === 'fixed') Object.assign(options, { injectTo: join(fixture, 'src/main.tsx'), skipSnippets: ['htmlScript'] });
      const result = await build({ configFile: false, root: fixture, logLevel: 'error', plugins: [codeInspectorPlugin(options)], esbuild: { jsx: 'transform', jsxFactory: 'h' }, build: { write: false, minify: false, reportCompressedSize: false } });
      const outputs = result.output;
      const html = outputs.find(x => x.fileName === 'index.html').source;
      const js = outputs.filter(x => x.type === 'chunk').map(x => x.code).join('\n');
      const count = s => (s.match(/createElement\(["']code-inspector-component["']/g) || []).length;
      const resultCounts = { html: count(html), js: count(js), stamped: js.includes('data-insp-path') };
      console.log(JSON.stringify({ mode, rootMain: present, ...resultCounts }));
      assert.match(js, /data-insp-path[^\n]*main\.tsx:1:/);
      if (mode === 'old') assert.equal(resultCounts.html, present ? 1 : 0);
      else { assert.equal(resultCounts.html, 0); assert.equal(resultCounts.js, 1); assert.match(js, /altKey,shiftKey/); assert.match(js, /code-inspector:trackCode/); assert.match(js, /\.copy\s*=\s*false/); assert.match(js, /\.locate\s*=\s*(?:!!)?false/); }
    }
  }
  assert.equal(listenCalls, 0);
  console.log('PASS: no TCP listen calls; fixtures removed');
} finally {
  net.Server.prototype.listen = originalListen;
  process.chdir(originalCwd);
  await rm(temp, { recursive: true, force: true });
}
