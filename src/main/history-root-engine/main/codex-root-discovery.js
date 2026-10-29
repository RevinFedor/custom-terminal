'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const text = require('./history-paged-text');
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// A filesystem syscall takes one pathname, unlike a History text field. Bound
// that atomic string before decoding it. POSIX kernels accept at most 4096
// pathname bytes (this code-unit ceiling is conservative); Win32 extended
// paths accept at most 32767 UTF-16 units. These are fixed native-path scratch
// limits, separate from the three resident History pages and from native RSS.
const NATIVE_PATH_CHARS = process.platform === 'win32' ? 32767 : 4096;
function nativeDirectoryPath(value, arena) {
  if (value.length > NATIVE_PATH_CHARS) throw Object.assign(new Error('history_directory_path_too_long'), { code: 'ENAMETOOLONG' });
  const result = text.isPagedText(value) ? text.small(value, NATIVE_PATH_CHARS) : value;
  arena.metrics.maxDiscoveryPathChars = Math.max(arena.metrics.maxDiscoveryPathChars || 0, result.length);
  arena.metrics.discoveryNativePathBudgetChars = NATIVE_PATH_CHARS;
  return result;
}

function rawSyscallPath(dir, bytes, arena) {
  // The fixed pathname budget is separate from History leaves. Encode the
  // already bounded native directory a code point at a time; Buffer.from
  // never receives a growing history string. Preserve raw filename bytes.
  const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
  const size = Buffer.byteLength(prefix) + bytes.length;
  if (size > NATIVE_PATH_CHARS * 4) throw Object.assign(new Error('history_directory_path_too_long'), { code: 'ENAMETOOLONG' });
  const result = Buffer.allocUnsafe(size); let at = 0;
  for (const point of prefix) at += result.write(point, at, 'utf8');
  bytes.copy(result, at);
  arena.metrics.maxDiscoveryNativePathBytes = Math.max(arena.metrics.maxDiscoveryNativePathBytes || 0, size);
  return result;
}

function readRawEntry(handle, dir, arena) {
  let item;
  try { item = handle.readSync(); }
  catch (error) {
    // Node18's public readSync may lstat its Latin-1 spelling when the native
    // dirent type is DT_UNKNOWN. Recover only a proved single consumed entry
    // from that lstat error, then stat the exact bytes. Never retry enumeration
    // or turn programming/interface errors into an absent child.
    if (error?.syscall !== 'lstat' || typeof error.path !== 'string'
      || error.path.length > NATIVE_PATH_CHARS * 2) throw error;
    const relative = path.relative(dir, error.path), separator = relative.indexOf(path.sep);
    let name;
    if (separator < 0) name = relative;
    else if (relative.indexOf(path.sep, separator + 1) < 0
      && relative.slice(0, separator) === relative.slice(separator + 1)) name = relative.slice(0, separator);
    if (!name || name === '.' || name === '..' || /[\u0100-\uffff]/u.test(name)
      || !/[\u0080-\u00ff]/u.test(name)) throw error;
    const bytes = Buffer.from(name, 'latin1');
    const stat = fs.lstatSync(rawSyscallPath(dir, bytes, arena));
    arena.metrics.discoveryRecoveredStatEntries = (arena.metrics.discoveryRecoveredStatEntries || 0) + 1;
    return { name, isDirectory: () => stat.isDirectory() };
  }
  if (!item) return item;
  // A successful internal stat can be wrong as well: both the UTF-8 filename
  // and its mojibake spelling may exist with different kinds. DirentFromStats
  // overrides the PUBLIC predicates. Inspect that public method relationship;
  // no private symbol, binding, constructor-name check or Dir patch is used.
  if (item instanceof fs.Dirent && item.isDirectory !== fs.Dirent.prototype.isDirectory
    && typeof item.name === 'string' && /[\u0080-\u00ff]/u.test(item.name)) {
    const bytes = Buffer.from(item.name, 'latin1');
    const stat = fs.lstatSync(rawSyscallPath(dir, bytes, arena));
    arena.metrics.discoveryRecheckedStatEntries = (arena.metrics.discoveryRecheckedStatEntries || 0) + 1;
    return { name: item.name, isDirectory: () => stat.isDirectory() };
  }
  return item;
}

function joinedNativePath(dir, name, arena) {
  // Real directory names contain no separator or dot entry. The same fixed
  // syscall scratch guard applies before concatenating a returned/pending path.
  if (dir.length + name.length + 1 > NATIVE_PATH_CHARS) return null;
  return nativeDirectoryPath(path.join(dir, name), arena);
}

// Preserve scandir's bytewise filename order and the old LIFO directory walk.
// Only one Dirent is requested from libuv at a time; the pending directory
// heap/stack live in the existing arena. No new database or executor.
function findRootedCodexAgentFile({ agentSessionId, sessionsDir, rooted: arena }) {
  const scan = () => {
    const wanted = text.coerce(agentSessionId || '').trim();
    if (!wanted) return null;
    const stack = arena.make('array'); stack.push(sessionsDir);
    const compare = (a, b) => {
      // Compare raw filename bytes, before UTF-8 replacement of invalid byte
      // sequences. That distinction can change which duplicate receipt wins.
      const ar = text.reader(a), br = text.reader(b);
      const length = (value, r) => value.length / 4 * 3 - (r.at(value.length - 1) === '=' ? 1 : 0) - (r.at(value.length - 2) === '=' ? 1 : 0);
      const al = length(a, ar), bl = length(b, br);
      const byte = (r, index) => {
        const at = Math.floor(index / 3) * 4, part = index % 3;
        const first = BASE64.indexOf(r.at(at + part)), second = BASE64.indexOf(r.at(at + part + 1));
        return part === 0 ? first * 4 + (second >> 4) : part === 1 ? (first & 15) * 16 + (second >> 2) : (first & 3) * 64 + second;
      };
      for (let i = 0; i < Math.min(al, bl); i++) { const delta = byte(ar, i) - byte(br, i); if (delta) return delta; }
      return al - bl;
    };
    const nativeName = value => {
      const decoder = new StringDecoder('utf8'); let out = '';
      for (let at = 0; at < value.length; at += 64) out += decoder.write(Buffer.from(text.small(value.slice(at, at + 64)), 'base64'));
      out += decoder.end(); return out;
    };
    while (stack.length) {
      let dir;
      try { dir = nativeDirectoryPath(stack.pop(), arena); }
      catch (error) { if (error?.code === 'ENAMETOOLONG') continue; throw error; }
      const directories = arena.make('array');
      let handle, failed = false, first = null;
      const push = name => {
        let at = directories.length; directories.push(name);
        while (at) {
          const parent = Math.floor((at - 1) / 2), old = directories[parent];
          if (compare(old, name) <= 0) break;
          directories[at] = old; at = parent;
        }
        directories[at] = name;
      };
      const pop = () => {
        const value = directories[0], tail = directories.pop();
        if (!directories.length) return value;
        let at = 0;
        while (at * 2 + 1 < directories.length) {
          let child = at * 2 + 1;
          if (child + 1 < directories.length && compare(directories[child + 1], directories[child]) < 0) child++;
          if (compare(tail, directories[child]) <= 0) break;
          directories[at] = directories[child]; at = child;
        }
        directories[at] = tail; return value;
      };
      try {
        // Node 18's Dir.processReadResult passes every name to path.join,
        // which rejects Buffer names. Latin-1 preserves each raw byte in one
        // code unit and keeps that public API boundary a string. Decode UTF-8
        // only after restoring the bytes, before the existing match/path seam.
        handle = fs.opendirSync(dir, { encoding: 'latin1', bufferSize: 1 });
        arena.metrics.discoveryOpenDirectories = (arena.metrics.discoveryOpenDirectories || 0) + 1;
        arena.metrics.maxDiscoveryOpenDirectories = Math.max(arena.metrics.maxDiscoveryOpenDirectories || 0, arena.metrics.discoveryOpenDirectories);
        let item;
        while ((item = readRawEntry(handle, dir, arena)) !== null) {
          arena.metrics.discoveryEntries = (arena.metrics.discoveryEntries || 0) + 1;
          arena.metrics.maxDiscoveryResidentDirents = Math.max(arena.metrics.maxDiscoveryResidentDirents || 0, 1);
          if (typeof item.name !== 'string' && !Buffer.isBuffer(item.name)) throw Object.assign(new Error('history_directory_raw_names_required'), { code:'history_directory_raw_names_required' });
          const bytes = Buffer.isBuffer(item.name) ? item.name : Buffer.from(item.name, 'latin1');
          const key = bytes.toString('base64'), name = bytes.toString('utf8');
          arena.metrics.maxDiscoveryComponentBytes = Math.max(arena.metrics.maxDiscoveryComponentBytes || 0, bytes.length);
          if (item.isDirectory()) push(key);
          else if (name.endsWith('.jsonl') && text.indexOf(name, wanted) >= 0 && (first === null || compare(key, first) < 0)) first = key;
        }
      } catch (error) {
        // A programming/interface failure is not an absent child. Preserve
        // the old unreadable-directory continuation only for OS errno codes.
        if (!/^E[A-Z0-9]+$/.test(String(error?.code || ''))) throw error;
        failed = true;
      }
      finally {
        if (handle) {
          try { handle.closeSync(); arena.metrics.discoveryOpenDirectories--; }
          catch (error) {
            if (error?.code === 'ERR_DIR_CLOSED') arena.metrics.discoveryOpenDirectories--;
            else {
              arena.metrics.discoveryCloseFailures = (arena.metrics.discoveryCloseFailures || 0) + 1;
              throw error; // An uncertain FD closure is not a successful scan.
            }
          }
        }
      }
      if (failed) continue;
      if (first !== null) {
        const found = joinedNativePath(dir, nativeName(first), arena);
        if (found !== null) return found;
      }
      while (directories.length) {
        const next = joinedNativePath(dir, nativeName(pop()), arena);
        if (next !== null) stack.push(next);
      }
      arena.metrics.maxDiscoveryPendingOnDisk = Math.max(arena.metrics.maxDiscoveryPendingOnDisk || 0, stack.length);
    }
    return null;
  };
  return arena.inStep ? scan() : arena.step(scan);
}
module.exports = { findRootedCodexAgentFile, nativeDirectoryPath, NATIVE_PATH_CHARS, readRawEntry };
