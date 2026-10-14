const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  executeAtomicMoveBatch,
  registerAtomicMoveBatchIpc,
} = require('../main/atomic-move-batch.cjs');

function createFixture(prefix = 'atomic-move-batch-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const sourceDir = path.join(root, 'source');
  const destinationDir = path.join(root, 'destination');
  fs.mkdirSync(sourceDir);
  fs.mkdirSync(destinationDir);
  return { root, sourceDir, destinationDir };
}

function writeFile(filePath, content = path.basename(filePath)) {
  fs.writeFileSync(filePath, content);
  return filePath;
}

function fakeLayoutStore(result = { ok: true, revision: 2 }) {
  const calls = [];
  return {
    calls,
    put(...args) {
      calls.push(args);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

function removeFixture(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
    invoke(channel, payload) {
      const handler = handlers.get(channel);
      assert.equal(typeof handler, 'function', `Missing IPC handler ${channel}`);
      return handler({}, payload);
    },
  };
}

test('commits every move and writes layout exactly once', () => {
  const fixture = createFixture();
  try {
    const first = writeFile(path.join(fixture.sourceDir, 'first.md'), 'first');
    const second = writeFile(path.join(fixture.sourceDir, 'second.md'), 'second');
    const firstDestination = path.join(fixture.destinationDir, 'first.md');
    const secondDestination = path.join(fixture.destinationDir, 'second.md');
    const finalLayout = { orderByParent: { destination: ['first.md', 'second.md'] } };
    const layoutStore = fakeLayoutStore({ ok: true, revision: 8 });

    const result = executeAtomicMoveBatch({
      rootPath: fixture.root,
      moves: [
        { sourcePath: first, destinationPath: firstDestination },
        { sourcePath: second, destinationPath: secondDestination },
      ],
      finalLayout,
      expectedRevision: 7,
      layoutStore,
    });

    assert.equal(result.committed, true);
    assert.equal(result.crashSafe, false);
    assert.deepEqual(layoutStore.calls, [[fixture.root, finalLayout, 7]]);
    assert.equal(fs.existsSync(first), false);
    assert.equal(fs.existsSync(second), false);
    assert.equal(fs.readFileSync(firstDestination, 'utf8'), 'first');
    assert.equal(fs.readFileSync(secondDestination, 'utf8'), 'second');
    assert.deepEqual(result.moves.map((move) => move.actualPath), [firstDestination, secondDestination]);
  } finally {
    removeFixture(fixture.root);
  }
});

test('failure before the second rename rolls the first move back and skips CAS', () => {
  const fixture = createFixture();
  try {
    const first = writeFile(path.join(fixture.sourceDir, 'first.md'), 'first');
    const second = writeFile(path.join(fixture.sourceDir, 'second.md'), 'second');
    const firstDestination = path.join(fixture.destinationDir, 'first.md');
    const secondDestination = path.join(fixture.destinationDir, 'second.md');
    const layoutStore = fakeLayoutStore();

    const result = executeAtomicMoveBatch({
      rootPath: fixture.root,
      moves: [
        { sourcePath: first, destinationPath: firstDestination },
        { sourcePath: second, destinationPath: secondDestination },
      ],
      finalLayout: {},
      expectedRevision: 1,
      layoutStore,
      beforeRename: ({ step }) => {
        if (step === 2) throw new Error('injected second-step failure');
      },
    });

    assert.equal(result.committed, false);
    assert.equal(result.rolledBack, true);
    assert.equal(result.partial, false);
    assert.equal(result.reason, 'move-failed');
    assert.equal(layoutStore.calls.length, 0);
    assert.equal(fs.readFileSync(first, 'utf8'), 'first');
    assert.equal(fs.readFileSync(second, 'utf8'), 'second');
    assert.equal(fs.existsSync(firstDestination), false);
    assert.equal(fs.existsSync(secondDestination), false);
  } finally {
    removeFixture(fixture.root);
  }
});

test('layout CAS conflict rolls every filesystem move back', () => {
  const fixture = createFixture();
  try {
    const first = writeFile(path.join(fixture.sourceDir, 'first.md'));
    const second = writeFile(path.join(fixture.sourceDir, 'second.md'));
    const firstDestination = path.join(fixture.destinationDir, 'first.md');
    const secondDestination = path.join(fixture.destinationDir, 'second.md');
    const layoutStore = fakeLayoutStore({ ok: false, conflict: true, revision: 9 });

    const result = executeAtomicMoveBatch({
      rootPath: fixture.root,
      moves: [
        { sourcePath: first, destinationPath: firstDestination },
        { sourcePath: second, destinationPath: secondDestination },
      ],
      finalLayout: { changed: true },
      expectedRevision: 8,
      layoutStore,
    });

    assert.equal(result.conflict, true);
    assert.equal(result.rolledBack, true);
    assert.equal(result.partial, false);
    assert.equal(result.reason, 'layout-conflict');
    assert.equal(layoutStore.calls.length, 1);
    assert.equal(fs.existsSync(first), true);
    assert.equal(fs.existsSync(second), true);
    assert.equal(fs.existsSync(firstDestination), false);
    assert.equal(fs.existsSync(secondDestination), false);
  } finally {
    removeFixture(fixture.root);
  }
});

test('rollback failure is reported as partial with actual paths', () => {
  const fixture = createFixture();
  try {
    const first = writeFile(path.join(fixture.sourceDir, 'first.md'), 'first');
    const second = writeFile(path.join(fixture.sourceDir, 'second.md'), 'second');
    const firstDestination = path.join(fixture.destinationDir, 'first.md');
    const secondDestination = path.join(fixture.destinationDir, 'second.md');
    const layoutStore = fakeLayoutStore();
    const fsImpl = Object.create(fs);
    fsImpl.renameSync = (from, to) => {
      if (from === firstDestination && to === first) {
        const error = new Error('injected rollback failure');
        error.code = 'EIO';
        throw error;
      }
      return fs.renameSync(from, to);
    };

    const result = executeAtomicMoveBatch({
      rootPath: fixture.root,
      moves: [
        { sourcePath: first, destinationPath: firstDestination },
        { sourcePath: second, destinationPath: secondDestination },
      ],
      finalLayout: {},
      expectedRevision: 1,
      layoutStore,
      fsImpl,
      beforeRename: ({ step }) => {
        if (step === 2) throw new Error('injected move failure');
      },
    });

    assert.equal(result.committed, false);
    assert.equal(result.rolledBack, false);
    assert.equal(result.partial, true);
    assert.equal(result.partialRollbackFailure, true);
    assert.equal(result.reason, 'move-failed');
    assert.equal(result.rollbackErrors.length, 1);
    assert.equal(result.moves[0].status, 'rollback-failed');
    assert.equal(result.moves[0].actualPath, firstDestination);
    assert.equal(result.moves[1].actualPath, second);
    assert.equal(layoutStore.calls.length, 0);
  } finally {
    removeFixture(fixture.root);
  }
});

test('duplicate destinations fail preflight without changing disk or layout', () => {
  const fixture = createFixture();
  try {
    const first = writeFile(path.join(fixture.sourceDir, 'first.md'));
    const second = writeFile(path.join(fixture.sourceDir, 'second.md'));
    const duplicateDestination = path.join(fixture.destinationDir, 'same.md');
    const layoutStore = fakeLayoutStore();

    const result = executeAtomicMoveBatch({
      rootPath: fixture.root,
      moves: [
        { sourcePath: first, destinationPath: duplicateDestination },
        { sourcePath: second, destinationPath: duplicateDestination },
      ],
      finalLayout: {},
      expectedRevision: 1,
      layoutStore,
    });

    assert.equal(result.reason, 'preflight-failed');
    assert.equal(result.preflightErrors.some((error) => error.code === 'duplicate-destination'), true);
    assert.equal(fs.existsSync(first), true);
    assert.equal(fs.existsSync(second), true);
    assert.equal(fs.existsSync(duplicateDestination), false);
    assert.equal(layoutStore.calls.length, 0);
  } finally {
    removeFixture(fixture.root);
  }
});

test('directory cannot move into its own descendant', () => {
  const fixture = createFixture();
  try {
    const folder = path.join(fixture.sourceDir, 'folder');
    const child = path.join(folder, 'child');
    fs.mkdirSync(child, { recursive: true });
    const destination = path.join(child, 'folder');
    const layoutStore = fakeLayoutStore();

    const result = executeAtomicMoveBatch({
      rootPath: fixture.root,
      moves: [{ sourcePath: folder, destinationPath: destination }],
      finalLayout: {},
      expectedRevision: 1,
      layoutStore,
    });

    assert.equal(result.reason, 'preflight-failed');
    assert.equal(result.preflightErrors.some((error) => error.code === 'self-descendant'), true);
    assert.equal(fs.existsSync(folder), true);
    assert.equal(fs.existsSync(destination), false);
    assert.equal(layoutStore.calls.length, 0);
  } finally {
    removeFixture(fixture.root);
  }
});

test('overlapping source roots fail preflight before either source moves', () => {
  const fixture = createFixture();
  try {
    const folder = path.join(fixture.sourceDir, 'folder');
    fs.mkdirSync(folder);
    const child = writeFile(path.join(folder, 'child.md'), 'child');
    const folderDestination = path.join(fixture.destinationDir, 'folder');
    const childDestination = path.join(fixture.destinationDir, 'child.md');
    const layoutStore = fakeLayoutStore();

    const result = executeAtomicMoveBatch({
      rootPath: fixture.root,
      moves: [
        { sourcePath: folder, destinationPath: folderDestination },
        { sourcePath: child, destinationPath: childDestination },
      ],
      finalLayout: {},
      expectedRevision: 1,
      layoutStore,
    });

    assert.equal(result.reason, 'preflight-failed');
    assert.equal(result.preflightErrors.some((error) => error.code === 'overlapping-sources'), true);
    assert.equal(fs.existsSync(folder), true);
    assert.equal(fs.existsSync(child), true);
    assert.equal(fs.existsSync(folderDestination), false);
    assert.equal(fs.existsSync(childDestination), false);
    assert.equal(layoutStore.calls.length, 0);
  } finally {
    removeFixture(fixture.root);
  }
});

test('IPC controller rejects failure injection outside a disposable fixture', () => {
  const ipcMain = fakeIpcMain();
  registerAtomicMoveBatchIpc({
    ipcMain,
    layoutStore: fakeLayoutStore(),
    allowDevFailureInjection: true,
    logger: null,
  });

  const result = ipcMain.invoke('dnd-dev-arm-atomic-move-failure', {
    rootPath: path.join(os.homedir(), 'Documents'),
    step: 2,
  });

  assert.deepEqual(result, { ok: false, reason: 'fixture-root-required' });
});

test('IPC controller consumes an injected second-step failure once and rolls back', () => {
  const fixture = createFixture('dnd-e2e-');
  try {
    const first = writeFile(path.join(fixture.sourceDir, 'first.md'), 'first');
    const second = writeFile(path.join(fixture.sourceDir, 'second.md'), 'second');
    const firstDestination = path.join(fixture.destinationDir, 'first.md');
    const secondDestination = path.join(fixture.destinationDir, 'second.md');
    const layoutStore = fakeLayoutStore();
    const ipcMain = fakeIpcMain();
    registerAtomicMoveBatchIpc({
      ipcMain,
      layoutStore,
      allowDevFailureInjection: true,
      logger: null,
    });

    const armed = ipcMain.invoke('dnd-dev-arm-atomic-move-failure', {
      rootPath: fixture.root,
      step: 2,
    });
    assert.equal(armed.ok, true);

    const payload = {
      rootPath: fixture.root,
      moves: [
        { sourcePath: first, destinationPath: firstDestination },
        { sourcePath: second, destinationPath: secondDestination },
      ],
      finalLayout: {},
      expectedRevision: 1,
    };
    const failed = ipcMain.invoke('move-items-atomic', payload);
    assert.equal(failed.reason, 'move-failed');
    assert.equal(failed.rolledBack, true);
    assert.equal(layoutStore.calls.length, 0);
    assert.equal(fs.existsSync(first), true);
    assert.equal(fs.existsSync(second), true);

    const committed = ipcMain.invoke('move-items-atomic', payload);
    assert.equal(committed.committed, true);
    assert.equal(layoutStore.calls.length, 1);
    assert.equal(fs.existsSync(firstDestination), true);
    assert.equal(fs.existsSync(secondDestination), true);
  } finally {
    removeFixture(fixture.root);
  }
});
