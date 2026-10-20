'use strict';
// Whole CJS HTTP route + actual ProjectManager/SQLite, resolver and sanitizer.
// Only Electron lifecycle/transport ports and a deterministic file-read hold
// are substituted. No installed service, provider, renderer or real prompts.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const http = require('node:http'), vm = require('node:vm'), Module = require('node:module');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createInterface } = require('node:readline');
const crypto = require('node:crypto');
const { createSavedPromptService } = require('./saved-prompt-service');
const source = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');
let ownedRoot;
const electronPath = require.resolve('electron'), previousElectron = require.cache[electronPath];
const electron = { app: { getPath: () => ownedRoot, isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] }, ipcMain: { on() {}, removeListener() {}, handle() {} } };
require.cache[electronPath] = { id: electronPath, loaded: true, exports: electron };
const DatabaseManager = require('./database');
const { buildPromptOutline } = require('../shared/prompt-outline.cjs');
test.after(() => { if (previousElectron) require.cache[electronPath] = previousElectron; else delete require.cache[electronPath]; });
const barrier = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const prompt = (id, extra = {}) => ({ id, title: id, content: id + ' text', group_id: null, position: 0, file_paths: [], ...extra });

async function fixture(t) {
  const root = ownedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-prompt-read-http-'));
  const tasks = [], holds = new Map(); let pm, whole, server;
  t.after(async () => {
    for (const hold of holds.values()) hold.release.resolve();
    await Promise.allSettled(tasks);
    if (server) { server.closeAllConnections?.(); await new Promise(r => server.close(r)); }
    await whole?.stop(); pm?.db.close(); fs.rmSync(root, { recursive: true, force: true });
  });
  const seed = new DatabaseManager(); seed.createEmptyProject('PRIVATE prompt read'); seed.close();
  // Full production initialization, private DB already seeded so legacy user
  // JSON migration cannot execute. No injected projectManager global.
  const pmModule = new Module(path.join(__dirname, 'project-manager.js'), module);
  pmModule.filename = path.join(__dirname, 'project-manager.js'); pmModule.paths = module.paths;
  pmModule._compile(fs.readFileSync(pmModule.filename, 'utf8'), pmModule.filename);
  pm = pmModule.exports;
  let mutations = 0, libraryReads = 0, fileReads = 0;
  const getLibrary = pm.getPromptLibrary.bind(pm);
  pm.getPromptLibrary = () => { libraryReads++; return getLibrary(); };
  const service = createSavedPromptService({ projectManager: pm, onChanged: () => mutations++ });
  const load = Module.createRequire(path.join(__dirname, 'web-server.js'));
  const fileSystem = Object.create(fs);
  Object.defineProperty(fileSystem, 'promises', { value: { ...fs.promises, readFile: async (file, ...args) => {
    assert.ok(String(file).startsWith(root + path.sep), 'prompt reader may only read synthetic fixture paths');
    fileReads++; const hold = holds.get(file);
    if (hold) { holds.delete(file); hold.entered.resolve(); await hold.release.promise; }
    return fs.promises.readFile(file, ...args);
  } } });
  const privateProcess = Object.create(process);
  privateProcess.env = { ...process.env, NOTED_DISCOVERY_DIR: path.join(root, 'discovery') };
  const wrapper = vm.runInNewContext('(function(require,module,exports,__dirname,__filename){' + source + `
    return { route: handleApi, configure(service) { token='private-token'; savedPromptService=service; },
      sanitizerAvailable: typeof sanitizeFileForPrompt === 'function', stop };
  })`, { console: { log() {}, warn() {}, error() {} }, process: privateProcess, Buffer, URL,
    setTimeout, clearTimeout, setInterval, clearInterval });
  const cjs = { exports: {} };
  whole = wrapper(id => id === './project-manager' ? pm : id === 'electron' ? electron
    : id === 'fs' ? fileSystem : load(id), cjs, cjs.exports, __dirname, path.join(__dirname, 'web-server.js'));
  assert.equal(whole.sanitizerAvailable, true, 'actual linked-file sanitizer must load');
  whole.configure(service);
  server = http.createServer((req, res) => {
    const parsed = new URL(req.url, 'http://private');
    assert.ok(/^\/api\/(?:me|prompt-library(?:\/read)?|prompts(?:\/[^/]+(?:\/move)?)?|prompt-groups(?:\/\d+)?)$/.test(parsed.pathname));
    tasks.push(whole.route(req, res, { pathname: parsed.pathname, query: Object.fromEntries(parsed.searchParams) }, new Map())
      .catch(error => { res.writeHead(500); res.end(JSON.stringify({ error: error.message })); }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const request = (route, body, authorized = true, method = body === undefined ? 'GET' : 'POST') => new Promise((resolve, reject) => {
    const req = http.request(origin + route, { method,
      headers: { ...(authorized ? { authorization: 'Bearer private-token' } : {}), 'content-type': 'application/json' } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => {
        try { resolve({ status: res.statusCode, value: JSON.parse(Buffer.concat(chunks).toString()) }); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const seedRows = (prompts, groups = []) => { pm.db.savePromptGroups(groups); pm.db.savePrompts(prompts); };
  const read = (id, extra = {}) => request('/api/prompt-library/read', { promptIds: [id], mode: 'resolved', projection: 'steps-v1', ...extra });
  return { root, pm, service, request, read, seedRows, configure: whole.configure,
    port: server.address().port,
    file(name, text) { const file = path.join(root, name); fs.writeFileSync(file, text); return file; },
    hold(file) { const hold = { entered: barrier(), release: barrier() }; holds.set(file, hold); return hold; },
    counts: () => ({ mutations, libraryReads, fileReads }) };
}

async function withPromptMcp(f, run) {
  const discovery = path.join(f.root, 'mcp-fixture'); fs.mkdirSync(discovery);
  fs.writeFileSync(path.join(discovery, 'web-token.txt'), 'private-token');
  fs.writeFileSync(path.join(discovery, `web-server-${process.pid}.json`), JSON.stringify({ port: f.port, updatedAt: Date.now() }));
  fs.writeFileSync(path.join(discovery, `mcp-port-${process.pid}`), JSON.stringify({ port: f.port,
    openProjectPaths: [f.root], openProjects: [{ id: 'private', path: f.root }], updatedAt: Date.now() }));
  const child = spawn(process.execPath, [path.join(__dirname, '../../mcp/terminal-server.mjs'), '--project', f.root], {
    env: { ...process.env, NOTED_DISCOVERY_DIR: discovery, NOTED_MAIN_PID: String(process.pid),
      NOTED_MCP_INSTANCE_ROUTE: '', NOTED_PARENT_PROJECT_ID: 'private', NOTED_PARENT_TAB_ID: 'private-fixture' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = createInterface({ input: child.stdout }), pending = new Map(); let id = 0;
  child.stderr.resume();
  lines.on('line', line => { const value = JSON.parse(line); pending.get(value.id)?.(value); });
  const call = (name, args) => new Promise((resolve, reject) => {
    const key = ++id;
    const timer = setTimeout(() => { pending.delete(key); reject(new Error('owned MCP fixture deadline')); }, 5000);
    pending.set(key, value => { clearTimeout(timer); pending.delete(key); resolve(value); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: key, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  });
  try { await run(call); }
  finally {
    lines.close(); child.stdin.end();
    if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
  }
}

test('mixed prompt order crosses actual MCP, HTTP handler, service and private SQLite without UI or whole-library save', async t => {
  const f = await fixture(t);
  f.seedRows([prompt('a', { position: 10 }), prompt('child', { position: 11, visual_parent_id: 'a' }),
    prompt('b', { position: 30 })], [{ id: 1, name: 'G1', position: 0 }, { id: 2, name: 'G2', position: 20 }]);
  const before = f.pm.getPromptLibrary(), roots = async () =>
    (await f.request('/api/prompt-library?projection=outline-v1')).value.outline.roots.map(row => row.id);
  const initial = await roots();
  await withPromptMcp(f, async call => {
    const invoke = async (name, args) => {
      const reply = await call(name, args);
      assert.notEqual(reply.result?.isError, true, reply.result?.content?.[0]?.text);
      return JSON.parse(reply.result.content[0].text);
    };
    await invoke('create_prompt', { stableId: 'own-last', title: 'Last', text: 'new', position: initial.length });
    assert.deepEqual(await roots(), [...initial, 'prompt:own-last']);
    const group = (await invoke('create_prompt_group', { name: 'Middle', position: 2 })).group;
    assert.deepEqual(await roots(), ['prompt-group:1', 'prompt:a', 'prompt-group:' + group.id, 'prompt-group:2', 'prompt:b', 'prompt:own-last']);
    await invoke('move_prompt', { promptId: 'own-last', revision: f.service.get('own-last').revision, position: 1 });
    const g = f.service.getGroup(2);
    await invoke('update_prompt_group', { groupId: 2, revision: g.revision, position: 2 });
    assert.deepEqual(await roots(), ['prompt-group:1', 'prompt:own-last', 'prompt-group:2', 'prompt:a', 'prompt-group:' + group.id, 'prompt:b']);
    const a = f.service.get('a'), oldOrder = await roots();
    await invoke('update_prompt', { promptId: 'a', revision: a.revision, text: 'edited own' });
    assert.deepEqual(await roots(), oldOrder);
    const saved = f.pm.getPromptLibrary();
    const stale = await call('move_prompt', { promptId: 'a', revision: a.revision, position: 0 });
    assert.equal(stale.result.isError, true); assert.match(stale.result.content[0].text, /changed by another client/);
    assert.deepEqual(f.pm.getPromptLibrary(), saved);
    assert.equal(f.service.get('child').visual_parent_id, 'a');
    assert.equal(f.service.get('b').content, before.prompts.find(row => row.id === 'b').content);
    assert.equal(f.counts().fileReads, 0);
  });
});

test('actual authenticated HTTP capability/outline, mixed roots and empty groups: no file IO or library mutation', async t => {
  const f = await fixture(t);
  f.seedRows([prompt('a'), prompt('leaf', { visual_parent_id: 'a', file_paths: [path.join(f.root, 'not-read.md')], position: 3 }),
    prompt('z', { position: 8 })], [{ id: 4, name: 'Empty', position: 1, is_collapsed: true }]);
  const original = f.pm.getPromptLibrary();
  const me = await f.request('/api/me'); assert.equal(me.status, 200);
  assert.equal(me.value.capabilities.promptLibrary.outlineProjection, 'outline-v1');
  assert.equal(me.value.capabilities.promptLibrary.resolvedProjection, 'steps-v1');
  const plain = await f.request('/api/prompt-library');
  const shown = await f.request('/api/prompt-library?projection=outline-v1&requestId=read-1');
  assert.equal(shown.status, 200); assert.equal(shown.value.read.serviceInstanceId, me.value.service.instanceId);
  assert.equal(shown.value.read.requestId, 'read-1');
  assert.deepEqual(shown.value.prompts, plain.value.prompts); assert.deepEqual(shown.value.groups, plain.value.groups);
  assert.deepEqual(shown.value.outline.roots.map(x => x.id), buildPromptOutline(original.prompts, original.groups).map(x => x.id));
  assert.equal(shown.value.outline.roots[1].expanded, false); assert.deepEqual(shown.value.outline.roots[1].children, []);
  assert.equal(f.counts().fileReads, 0); assert.equal(f.counts().mutations, 0); assert.deepEqual(f.pm.getPromptLibrary(), original);
  assert.equal((await f.request('/api/prompt-library', undefined, false)).status, 401);
  assert.equal((await f.request('/api/prompt-library?projection=future')).value.code, 'saved_prompt_projection_invalid');
});

test('actual file sanitizer and own/resolved/steps HTTP compatibility keep definition, chain and file evidence distinct', async t => {
  const f = await fixture(t);
  const include = f.file('part.md', '---\nsecret-frontmatter: true\n---\nINCLUDED\n<!-- @ai: hidden include -->\n');
  const rootFile = f.file('root.md', '<!-- @ai: hidden -->\nROOT FILE\n<!-- @include: ./part.md -->\n<!-- BEGIN TRANSCLUDE -->\nstale inline\n<!-- END TRANSCLUDE -->\n');
  const empty = f.file('empty.md', '<!-- @ai: only metadata -->');
  const childFile = f.file('child.md', 'CHILD FILE');
  const missing = path.join(f.root, 'missing.md');
  f.seedRows([prompt('root', { file_paths: [rootFile, empty, missing] }), prompt('leaf', { visual_parent_id: 'root', file_paths: [childFile], position: 1 })]);
  const before = f.pm.getPromptLibrary();
  const result = await f.read('leaf', { requestId: 'selected-leaf' });
  assert.equal(result.status, 200); const chain = result.value.composition.steps;
  assert.deepEqual(chain.map(x => x.promptId), ['root', 'leaf']);
  assert.equal(chain[0].text, 'root text\n\nROOT FILE\nINCLUDED');
  assert.equal(chain[1].text, 'leaf text\n\nCHILD FILE');
  assert.deepEqual(chain[0].files.map(x => x.status), ['resolved', 'empty', 'unavailable']);
  assert.equal(chain[0].files[0].sha256, crypto.createHash('sha256').update('ROOT FILE\nINCLUDED').digest('hex'));
  assert.equal(chain[1].inheritanceParentLabel, 'root'); assert.equal(chain[1].sourceKey, 'prompt:leaf');
  assert.equal(result.value.prompts[0].resolvedText, chain.map(x => x.text).join('\n\n'));
  assert.equal(result.value.prompts[0].content, 'leaf text');
  const old = await f.request('/api/prompt-library/read', { promptIds: ['leaf'], mode: 'resolved' });
  assert.equal(old.value.prompts[0].resolvedText, result.value.prompts[0].resolvedText);
  assert.deepEqual(Object.keys(old.value), ['prompts']);
  const own = await f.request('/api/prompt-library/read', { promptIds: ['leaf'], mode: 'own' });
  assert.equal(own.value.prompts[0].content, 'leaf text'); assert.equal('resolvedText' in own.value.prompts[0], false);
  const legacy = await f.request('/api/prompts');
  assert.equal(legacy.value.prompts.find(x => x.id === 'leaf').resolvedText, chain[1].text, 'legacy remains own assembled only');
  assert.equal((await f.request('/api/prompts?etag=' + legacy.value.etag)).value.unchanged, true);
  assert.deepEqual(f.pm.getPromptLibrary(), before); assert.equal(f.counts().mutations, 0);
  assert.ok(include.startsWith(f.root));
});

test('empty/missing files reject complete selection at first empty ancestor; unsupported/absent are distinct', async t => {
  const f = await fixture(t), file = f.file('empty.md', '   ');
  f.seedRows([prompt('root', { content: '', file_paths: [file, path.join(f.root, 'missing.md')] }), prompt('leaf', { visual_parent_id: 'root', position: 1 })]);
  const result = await f.read('leaf');
  assert.equal(result.status, 409); assert.equal(result.value.code, 'saved_prompt_empty');
  assert.equal(result.value.promptId, 'root'); assert.equal(result.value.promptTitle, 'root');
  assert.equal(result.value.read.selectedPromptId, 'leaf'); assert.equal('composition' in result.value, false);
  assert.equal((await f.read('missing')).status, 404);
  assert.equal((await f.read('leaf', { projection: 'future' })).status, 400);
  assert.equal((await f.read('leaf', { promptIds: ['leaf', 'root'] })).status, 400);
  f.configure(null);
  assert.equal((await f.request('/api/prompt-library')).value.code, 'app_update_required');
  assert.equal((await f.request('/api/me')).value.capabilities.promptLibrary, undefined);
});

test('actual HTTP held file read never combines old leaf with new ancestor graph; stale follow-up refuses before file IO', async t => {
  const f = await fixture(t), file = f.file('root.md', 'root file');
  f.seedRows([prompt('root', { file_paths: [file] }), prompt('new-root'), prompt('leaf', { visual_parent_id: 'root', position: 1 })]);
  const catalog = (await f.request('/api/prompt-library?projection=outline-v1')).value;
  const hold = f.hold(file), readsBefore = f.counts().libraryReads;
  const pending = f.read('leaf', { expectedLibraryRevision: catalog.read.libraryRevision, requestId: 'frozen-read' });
  await hold.entered.promise;
  // Existing canonical writer, private SQLite only; happens during the real
  // async read rather than replacing the read result with a canned response.
  let leaf = f.service.get('leaf');
  f.service.update({ stableId: leaf.id, revision: leaf.revision, text: 'new leaf' }); leaf = f.service.get('leaf');
  f.service.movePrompt({ stableId: leaf.id, revision: leaf.revision, parentPromptId: 'new-root' });
  const editsReads = f.counts().libraryReads;
  hold.release.resolve(); const result = await pending;
  assert.equal(result.status, 200); assert.equal(result.value.read.libraryRevision, catalog.read.libraryRevision);
  assert.equal(result.value.prompts[0].resolvedText, 'root text\n\nroot file\n\nleaf text');
  assert.deepEqual(result.value.composition.steps.map(x => x.promptId), ['root', 'leaf']);
  assert.equal(f.counts().libraryReads, editsReads, 'no graph resampling after file await');
  assert.ok(editsReads > readsBefore);
  const fileReads = f.counts().fileReads;
  assert.equal((await f.read('leaf', { expectedLibraryRevision: catalog.read.libraryRevision })).value.code, 'saved_prompt_library_stale');
  assert.equal(f.counts().fileReads, fileReads);
  const current = await f.read('leaf'); assert.deepEqual(current.value.composition.steps.map(x => x.promptId), ['new-root', 'leaf']);
  assert.equal(current.value.composition.steps.at(-1).text, 'new leaf');
});

test('SQLite legacy cycles/cross-group/orphan graph follows desktop tree and shared ancestors have stable keys', async t => {
  const f = await fixture(t);
  f.seedRows([prompt('root', { group_id: 4 }), prompt('a', { group_id: 4, visual_parent_id: 'root', position: 1 }),
    prompt('b', { group_id: 4, visual_parent_id: 'root', position: 2 }),
    prompt('cross', { visual_parent_id: 'root' }), prompt('missing', { visual_parent_id: 'absent' }),
    prompt('x', { visual_parent_id: 'y' }), prompt('y', { visual_parent_id: 'x' }),
    prompt('orphan', { group_id: 88 })], [{ id: 4, name: 'Group', position: 0 }]);
  const before = f.pm.getPromptLibrary();
  const outline = (await f.request('/api/prompt-library?projection=outline-v1')).value.outline.roots;
  const expected = new Map();
  const visit = (nodes, parents = []) => nodes.forEach(node => {
    const chain = node.promptId ? [...parents, node.promptId] : [];
    if (node.promptId) expected.set(node.promptId, chain);
    visit(node.children, chain);
  }); visit(outline);
  for (const [id, chain] of expected) {
    const result = await f.read(id); assert.equal(result.status, 200);
    assert.deepEqual(result.value.composition.steps.map(x => x.promptId), chain);
  }
  const a = (await f.read('a')).value.composition.steps[0], b = (await f.read('b')).value.composition.steps[0];
  assert.deepEqual(a, b); assert.equal(a.sourceKey, 'prompt:root');
  assert.deepEqual(f.pm.getPromptLibrary(), before); assert.equal(f.counts().mutations, 0);
});

test('actual SQLite read transaction pins prompts and groups across another connection commit', async t => {
  const f = await fixture(t);
  f.seedRows([prompt('root', { group_id: 4 })], [{ id: 4, name: 'Old group', position: 0 }]);
  const other = new (require('better-sqlite3'))(f.pm.db.db.name);
  const original = f.pm.db.getPrompts;
  try {
    let once = false;
    f.pm.db.getPrompts = function () {
      const rows = original.call(this);
      if (!once) {
        once = true;
        other.transaction(() => {
          other.prepare('UPDATE prompts SET content=? WHERE stable_id=?').run('NEW BODY', 'root');
          other.prepare('UPDATE prompt_groups SET name=? WHERE id=?').run('New group', 4);
        })();
      }
      return rows;
    };
    const old = await f.read('root'); assert.equal(old.status, 200);
    assert.equal(old.value.composition.steps[0].text, 'root text');
    f.pm.db.getPrompts = original;
    const current = await f.read('root'); assert.equal(current.value.composition.steps[0].text, 'NEW BODY');
    assert.notEqual(old.value.read.libraryRevision, current.value.read.libraryRevision);
    // A second controlled commit directly between the two SELECTs proves the
    // groups query is pinned too, not merely prompt clones in the service.
    f.pm.db.getPrompts = function () {
      const rows = original.call(this);
      other.prepare('UPDATE prompt_groups SET name=? WHERE id=?').run('Newest group', 4);
      return rows;
    };
    assert.equal(f.pm.getPromptLibrary().groups[0].name, 'New group');
    f.pm.db.getPrompts = original;
    assert.equal(f.pm.getPromptLibrary().groups[0].name, 'Newest group');
  } finally { f.pm.db.getPrompts = original; other.close(); }
});
