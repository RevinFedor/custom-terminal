'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { PROMPT_SOURCE_FOLDER, PROMPT_SUFFIX, includePromptSourceEntry } = require('../shared/prompt-source-policy.cjs');
const { stableSort } = require('./prompt-catalog-cooperative');
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const naturalCompare = (a, b) => collator.compare(String(a || ''), String(b || ''));
const identity = s => s ? `${s.dev}:${s.ino}` : null;
const knownMissing = e => e?.code === 'ENOENT' || e?.code === 'ENOTDIR';
const error = (code, cause) => Object.assign(Error(code), { code, statusCode: code === 'prompt_catalog_changed' ? 409 : 503, cause });

async function optionalStat(io, file, method = 'stat') {
  try { return await io(method, file); } catch (e) { if (knownMissing(e)) return null; throw e; }
}
async function probeSource(root, io, control) {
  const docs = path.join(root, PROMPT_SOURCE_FOLDER);
  const probe = async file => {
    const stat = await optionalStat(io, file), link = await optionalStat(io, file, 'lstat');
    const real = stat ? await io('realpath', file) : null;
    await control.step('probe');
    return { exists: !!stat?.isDirectory(), identity: identity(stat), linkIdentity: identity(link),
      symbolic: !!link?.isSymbolicLink(), real, mtimeMs: stat?.mtimeMs ?? null, ctimeMs: stat?.ctimeMs ?? null };
  };
  const rootFacts = await probe(root);
  // Children outside docs (History caches, unrelated files) do not change the
  // source inventory. Root identity/resolution remains required authority.
  delete rootFacts.mtimeMs; delete rootFacts.ctimeMs;
  return { rootPath: root, docsPath: docs, root: rootFacts, docs: await probe(docs) };
}
// Directory times change on authored topology changes; body changes do not alter
// these directory times. A changed observation revokes metadata immediately.
function sameProbe(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

async function captureLayout(store, root, control) {
  const value = await control.step('probe', () => store?.get(root) || { layout: null, revision: 0 });
  const input = value?.layout || {}, layout = { orderByParent: {}, visualParentByPath: {} };
  const hash = crypto.createHash('sha256');
  hash.update(String(value?.revision ?? 'unversioned') + ':');
  for (const key of ['orderByParent', 'visualParentByPath']) {
    hash.update(key);
    for (const name in input[key] || {}) {
      if (!Object.hasOwn(input[key], name)) continue;
      hash.update(name + ':');
      if (key === 'orderByParent') {
        const rows = [];
        for (const item of Array.isArray(input[key][name]) ? input[key][name] : []) {
          await control.step('order', () => { rows.push(item); hash.update(JSON.stringify(item) + ';'); });
        }
        layout[key][name] = rows;
      } else await control.step('order', () => { layout[key][name] = input[key][name]; hash.update(JSON.stringify(input[key][name]) + ';'); });
      await control.step('order');
    }
  }
  return { layout, stamp: hash.digest('hex') };
}

async function orderEntries(entries, dir, root, layout, control) {
  const base = await stableSort(entries, (a, b) => a.isDirectory !== b.isDirectory
    ? (a.isDirectory ? -1 : 1) : naturalCompare(a.name, b.name), control);
  const byPath = new Map(), used = new Set(), ordered = [], children = new Map(), roots = [];
  for (const entry of base) await control.step('order', () => byPath.set(entry.path, entry));
  const requested = layout.orderByParent?.[dir === root ? '__root__' : dir];
  for (const file of Array.isArray(requested) ? requested : []) await control.step('order', () => {
    if (byPath.has(file) && !used.has(file)) { ordered.push(byPath.get(file)); used.add(file); }
  });
  for (const entry of base) await control.step('order', () => { if (!used.has(entry.path)) ordered.push(entry); });
  for (const entry of ordered) await control.step('visual', () => {
    const parentPath = layout.visualParentByPath?.[entry.path], parent = byPath.get(parentPath);
    if (!entry.isDirectory && parent && !parent.isDirectory && parentPath !== entry.path) {
      const list = children.get(parentPath) || []; list.push(entry); children.set(parentPath, list);
    } else roots.push(entry);
  });
  const output = [], seen = new Set();
  // Explicit iterators preserve the original depth-first visual order, including
  // cyclic leftovers, without recursion or a large stack spread operation.
  for (const seed of [roots, ordered]) {
    const stack = [seed[Symbol.iterator]()];
    while (stack.length) await control.step('visual', () => {
      const next = stack.at(-1).next();
      if (next.done) { stack.pop(); return; }
      const entry = next.value; if (seen.has(entry.path)) return;
      seen.add(entry.path); output.push(entry);
      if (children.has(entry.path)) stack.push(children.get(entry.path)[Symbol.iterator]());
    });
  }
  return output;
}

async function scanSourceMetadata(root, probe, layout, io, control) {
  const prompts = [], leafFacts = new Map(); let directories = 0, entriesRead = 0;
  if (!probe.docs.exists) return { prompts, leafFacts, directories, entriesRead };
  const stack = [{ path: probe.docsPath, entries: null, index: 0 }];
  while (stack.length) {
    const frame = stack.at(-1);
    if (!frame.entries) {
      const entries = []; let handle;
      try {
        handle = await io('opendir', frame.path); directories++;
        for (;;) {
          const entry = await io('read', handle); if (!entry) break;
          await control.step('scan', () => {
            entriesRead++;
            if (includePromptSourceEntry(entry)) entries.push({ name: entry.name,
              path: path.join(frame.path, entry.name), isDirectory: entry.isDirectory() });
          });
        }
      } finally { if (handle) await io('close', handle); }
      frame.entries = await orderEntries(entries, frame.path, root, layout, control);
    }
    if (frame.index >= frame.entries.length) { stack.pop(); continue; }
    const entry = frame.entries[frame.index++];
    if (entry.isDirectory) { stack.push({ path: entry.path, entries: null, index: 0 }); continue; }
    if (!entry.name.toLocaleLowerCase().endsWith(PROMPT_SUFFIX)) continue;
    const stat = await io('lstat', entry.path);
    if (stat.isSymbolicLink()) throw error('prompt_catalog_changed');
    await control.step('map', () => {
      const fact = { identity: identity(stat), regular: stat.isFile() };
      leafFacts.set(entry.path, fact);
      prompts.push({ path: entry.path, relativePath: path.relative(root, entry.path),
        title: entry.name.slice(0, -PROMPT_SUFFIX.length) || entry.name, position: prompts.length, facts: fact });
    });
  }
  return { prompts, leafFacts, directories, entriesRead };
}
module.exports = { naturalCompare, probeSource, sameProbe, captureLayout, orderEntries,
  scanSourceMetadata, optionalStat, identity, error, knownMissing };
