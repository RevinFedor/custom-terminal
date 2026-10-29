// Finite SOURCE callback adapter, not a React/native/IPC acceptance harness.
// Owners, native predicates, publication and removal execute production code;
// only refs, synchronous React state application and lifecycle scheduling differ.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { Module } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { normalizePromptImageIdentity } from '../promptImageAttachments.mjs';
import { historyPrimaryPromptAdoptionFingerprint } from '../historyPrimaryPromptAdoption.mjs';
import { createHistoryPrimarySparsePublicationOwner } from '../historyPrimarySparsePublication.mjs';

export const compileHistoryFixture = text => ts.transpileModule(text, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React,
} }).outputText;

export function privateHistoryPromptHandoffs(source) {
  const filename = fileURLToPath(new URL('../historyPromptHandoffs.ts', import.meta.url));
  const loaded = new Module(filename, import.meta);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(fileURLToPath(new URL('..', import.meta.url)));
  loaded._compile(compileHistoryFixture(fs.readFileSync(source || filename, 'utf8')), filename);
  return loaded.exports;
}

export function historyPanelFragment(panel, first, last, cap = 40 * 1024) {
  const start = panel.indexOf(first), end = panel.indexOf(last, start + first.length);
  assert.ok(start >= 0 && end > start, first);
  const fragment = panel.slice(start, end);
  assert.ok(Buffer.byteLength(fragment) < cap, 'bounded actual callback: ' + first);
  return fragment;
}

export function installHistoryPromptPanelRows(context, panel, { initialRows = [], adoptionOwners = false } = {}) {
  let rows = initialRows;
  const lifecycleCleanups = [];
  const install = (first, last, names, cap) => {
    const source = historyPanelFragment(panel, first, last, cap);
    const callbacks = vm.runInContext(compileHistoryFixture('(() => {\n' + source
      + '\nreturn {' + names + '};\n})()'), context);
    Object.assign(context, callbacks);
  };
  Object.assign(context, {
    entries: rows, presentationEntriesRef: { current: rows },
    LOCAL_PROMPT_PREFIX: 'local-prompt-', LOCAL_REWIND_PREFIX: 'local-rewind-',
    LOCAL_COMPACT_ERROR_PREFIX: 'local-compact-error-',
    normalizePromptImageIdentity, historyPrimaryPromptAdoptionFingerprint,
    useRef: current => ({ current }),
    setEntries(update) {
      const next = typeof update === 'function' ? update(rows) : update;
      assert.ok(Array.isArray(next), 'finite React state adapter requires rows');
      if (next !== rows) assert.equal(context.presentationEntriesRef.current, next,
        'changed rows must first cross the actual publisher');
      rows = next;
      context.entries = rows;
    },
  });
  install('const normalizeHistoryPromptText =', 'const promptPreview =',
    'normalizeHistoryPromptText,normalizeHistoryPromptIdentityText', 2048);
  install('const isLocalPromptEntry =', 'const findServerPromptEntry =',
    'isLocalPromptEntry,isLocalRewindEntry,isLocalCompactErrorEntry', 2048);
  const owner = createHistoryPrimarySparsePublicationOwner({ isLocal: row => context.isLocalPromptEntry(row)
    || context.isLocalRewindEntry(row) || context.isLocalCompactErrorEntry(row) });
  context.primarySparsePublicationOwner = owner;
  owner.publishCompatibility(rows, {
    ownerKey: context.historyOwnerKeyRef.current, generation: context.historyOwnerGenerationRef.current,
  });
  install('  const publishHistoryRows = useCallback(', '  const primaryLocalPublicationAtRender =',
    'publishHistoryRows', 4096);
  const originalEffect = context.useEffect;
  context.useEffect = effect => {
    const cleanup = effect();
    if (typeof cleanup === 'function') lifecycleCleanups.push(cleanup);
  };
  try {
    install('  const localPromptMetaOwnersRef =', adoptionOwners
      ? '  const appendLocalPromptEntry =' : '  // CURRENT publication fields are read afresh',
    'localPromptMetaOwnersRef,getLocalPromptMetaOwner' + (adoptionOwners
      ? ',primaryPromptPublicationFingerprint,primaryPromptAdoptionLifeRef,capturePrimaryPromptAdoption,primaryPromptAppendPendingRef' : ''));
  } finally { context.useEffect = originalEffect; }
  install('  const captureLocalPromptRemoval =', '  const removeLocalPromptEntry =', 'captureLocalPromptRemoval');
  install('  const removeLocalPromptEntry =', '  const consumeLocalPromptEntry =', 'removeLocalPromptEntry');
  install('  const consumeLocalPromptEntry =', '  const queueMergeIntents =', 'consumeLocalPromptEntry');
  return {
    owner, rows: () => rows,
    commit(next) {
      assert.equal(context.publishHistoryRows(next), true);
      context.setEntries(next);
      return rows;
    },
    close() { for (const cleanup of lifecycleCleanups.splice(0).reverse()) cleanup(); owner.close(); },
  };
}
