'use strict';

const nativeFs = require('node:fs');
const crypto = require('node:crypto');
const {
  classifyClaudeStartupSlashRecord, parseClaudeStartupSlashCommand,
  readClaudeLocalCommandRecordText, scanClaudeStartupSlashRecords,
} = require('./claude-startup-slash-proof');

const CHUNK_BYTES = 64 * 1024;
const SYNC_SCAN_BYTES = 256 * 1024;
const MAX_RECORD_BYTES = 16 * 1024 * 1024;
const MAX_CANDIDATES = 64;
const MAX_INDEXED_WRAPPERS = 100_000;
const OWNER_FIELDS = ['terminalInstanceId', 'lifecycleGeneration', 'launchId', 'runSeq',
  'terminalRunSeq', 'processId', 'pid', 'childPid', 'inputRevision', 'writerSessionId',
  'sessionId', 'startupAttemptId', 'freshLaunch'];
const EXECUTION_FIELDS = ['term', 'terminal', 'terminalInstanceId', 'lifecycleGeneration',
  'launchId', 'runSeq', 'terminalRunSeq', 'processId', 'pid', 'childPid'];

const copy = value => JSON.parse(JSON.stringify(value));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const commandText = value => String(value || '').trim().replace(/\s+/g, ' ');
const fileIdentity = stat => String(stat.dev) + ':' + String(stat.ino);
const sameFile = (a, b) => !!a && !!b && a.identity === b.identity;

function currentBinding(value) {
  if (!value || value.verified === false || typeof value.sessionId !== 'string'
    || !value.sessionId || typeof value.filePath !== 'string' || !value.filePath) return null;
  return { sessionId: value.sessionId, filePath: value.filePath,
    revision: value.bindingRevision ?? value.revision ?? null };
}

function bindingKey(binding) {
  return binding ? JSON.stringify([binding.sessionId, binding.filePath, binding.revision]) : null;
}

function carrier(record) {
  return record?.type === 'user' && record?.message?.role === 'user'
    || record?.type === 'system' && record?.subtype === 'local_command';
}

function sameExecution(a, b) {
  let known = false;
  for (const key of EXECUTION_FIELDS) {
    if (a[key] === undefined && b[key] === undefined) continue;
    if (a[key] !== b[key]) return false;
    if (a[key] != null) known = true;
  }
  return known;
}

/**
 * Main-owned command evidence only. No PTY writes, queue, timers or polling.
 * resolveBinding returns a VERIFIED current writer, never a saved-SID hint.
 * The real executor calls prepareWrite immediately before its physical write
 * under its EXISTING PTY lock, then markWritten (or markUncertain on a throw).
 */
function createClaudeSettingEvidence({ captureOwner, isOwnerCurrent, resolveBinding,
  fs: io = nativeFs, now = Date.now, uuid = crypto.randomUUID,
  readOutcome = scanClaudeStartupSlashRecords } = {}) {
  for (const fn of [captureOwner, isOwnerCurrent, resolveBinding, readOutcome]) {
    if (typeof fn !== 'function') throw new TypeError('owner, binding and outcome callbacks are required');
  }
  const members = new WeakMap();
  const byId = new Map();
  const wrapperOwners = new Map();
  // Shared by all operations on this physical file. Only settings UUIDs and
  // their earliest byte positions survive a scan; never transcript bodies.
  const baselineIndexes = new Map();
  let order = 0;

  function snapshot(entry) {
    const owner = {};
    for (const key of OWNER_FIELDS) {
      if (entry.owner[key] === null || ['string', 'number', 'boolean'].includes(typeof entry.owner[key])) owner[key] = entry.owner[key];
    }
    const reader = entry.reader;
    return { commandId: entry.token.commandId, operationId: entry.token.operationId,
      tabId: entry.token.tabId, command: entry.token.command, owner,
      admittedAt: entry.admittedAt, preparedAt: entry.preparedAt,
      startupAttemptId: entry.startupAttemptId, write: { ...entry.write },
      checkpoint: { sessionId: entry.baseline?.sessionId || null,
        fileIdentity: entry.baseline?.identity || null, offset: entry.baseline?.offset ?? null,
        skipInitialPartial: entry.baseline?.skipPartial ?? null,
        enterOffset: entry.enterBaseline?.offset ?? null,
        anchor: entry.baseline?.anchor ? { ...entry.baseline.anchor } : null,
        bindingRevision: entry.bindingRevision, cursor: reader?.tail.cursor ?? null,
        lineageVerified: reader?.lineageVerified ?? false,
        wrapperUuid: entry.bound?.wrapper.uuid || null },
      binding: reader ? { sessionId: reader.binding.sessionId, filePath: reader.binding.filePath,
        fileIdentity: reader.identity } : null,
      ambiguousCommandIds: [...entry.ambiguous.keys()], reason: entry.invalidReason || entry.reason || null };
  }

  function result(entry, reason, outcome = 'unknown', extra = {}) {
    return { success: false, outcome, reason, ...extra, commandId: entry?.token.commandId || null,
      operationId: entry?.token.operationId || null, evidence: entry ? snapshot(entry) : null };
  }

  function current(entry) {
    try { return isOwnerCurrent(entry.token.tabId, entry.owner) === true; } catch { return false; }
  }

  function resolve(entry) {
    try { return currentBinding(resolveBinding(entry.token.tabId, entry.owner)); }
    catch { return null; }
  }

  // Only bounded synchronous I/O at the physical admission boundary. Complete
  // baseline membership is read asynchronously later, within this exact EOF.
  function captureFile(binding) {
    let fd;
    try {
      fd = io.openSync(binding.filePath, 'r');
      const stat = io.fstatSync(fd);
      if (!stat.isFile()) return null;
      const size = stat.size;
      const tail = Buffer.alloc(Math.min(size, CHUNK_BYTES));
      const count = tail.length ? io.readSync(fd, tail, 0, tail.length, size - tail.length) : 0;
      if (count !== tail.length) return null;
      const after = io.fstatSync(fd);
      if (fileIdentity(after) !== fileIdentity(stat) || after.size < size
        || fileIdentity(io.statSync(binding.filePath)) !== fileIdentity(stat)) return null;
      const skipPartial = size > 0 && tail.at(-1) !== 10;
      let anchor = null;
      // A partial source record after this anchor could predate our write.
      // Never use that anchor to declare the whole copied suffix new.
      if (!skipPartial && size) {
        let end = tail.length - 1;
        while (end >= 0 && (tail[end] === 10 || tail[end] === 13)) end--;
        const start = tail.lastIndexOf(10, end) + 1;
        if (start > 0 || tail.length === size) {
          const raw = tail.subarray(start, end + 1);
          try {
            const record = JSON.parse(raw.toString('utf8'));
            if (typeof record.uuid === 'string' && record.uuid) anchor = { uuid: record.uuid, hash: hash(raw) };
          } catch { /* Unknown anchor is explicit, never an offset-zero lease. */ }
        }
      }
      const guardBytes = tail.subarray(Math.max(0, tail.length - 1024));
      return { sessionId: binding.sessionId, filePath: binding.filePath,
        identity: fileIdentity(stat), offset: size, skipPartial, anchor,
        guard: { offset: size - guardBytes.length, length: guardBytes.length, hash: hash(guardBytes) } };
    } catch { return null; }
    finally { if (fd !== undefined) io.closeSync(fd); }
  }

  function missingFile(binding) {
    try { io.statSync(binding.filePath); return false; }
    catch (error) { return error?.code === 'ENOENT'; }
  }

  function cachedGuardMatches(filePath, identity, guard) {
    if (!guard?.length) return true;
    let fd;
    try {
      fd = io.openSync(filePath, 'r');
      if (fileIdentity(io.fstatSync(fd)) !== identity) return false;
      const buffer = Buffer.alloc(guard.length);
      const count = io.readSync(fd, buffer, 0, buffer.length, guard.offset);
      return count === buffer.length && hash(buffer) === guard.hash;
    } catch { return null; }
    finally { if (fd !== undefined) io.closeSync(fd); }
  }

  // The last asynchronous boundary is handle.close(). Re-open synchronously
  // afterwards and validate the bounded bytes that authorized this proof.
  // Merely checking inode/size would accept an equal-size in-place rewrite.
  function finalGuardFailure(filePath, identity, items) {
    let fd;
    try {
      fd = io.openSync(filePath, 'r');
      if (fileIdentity(io.fstatSync(fd)) !== identity) return 'transcript-replaced';
      const unique = new Map();
      for (const item of items) {
        const guard = item?.guard;
        if (guard?.length) unique.set(JSON.stringify(guard), item);
      }
      for (const { guard, reason } of unique.values()) {
        const buffer = Buffer.alloc(guard.length);
        const count = io.readSync(fd, buffer, 0, buffer.length, guard.offset);
        if (count !== buffer.length || hash(buffer) !== guard.hash) return reason;
      }
      if (fileIdentity(io.fstatSync(fd)) !== identity
        || fileIdentity(io.statSync(filePath)) !== identity) return 'transcript-replaced';
      return null;
    } catch { return 'transcript-read-unavailable'; }
    finally { if (fd !== undefined) io.closeSync(fd); }
  }

  function admit({ tabId, command, operationId, startupAttemptId = null } = {}) {
    const normalized = commandText(command);
    if (typeof tabId !== 'string' || !tabId || !parseClaudeStartupSlashCommand(normalized)) throw new TypeError('exact tab and settings command required');
    const captured = captureOwner(tabId);
    if (!captured || typeof captured !== 'object') throw new TypeError('admitted owner required');
    const owner = { ...captured, ...(captured.sourceBaseline ? { sourceBaseline: { ...captured.sourceBaseline } } : {}) };
    const commandId = 'claude-setting:' + uuid();
    if (byId.has(commandId)) throw new Error('duplicate settings command ID');
    const token = Object.freeze({ commandId, operationId: operationId || 'settings:' + uuid(), tabId, command: normalized });
    const entry = { token, owner, startupAttemptId, order: ++order, target: parseClaudeStartupSlashCommand(normalized),
      admittedAt: now(), preparedAt: null, prepared: false,
      write: { pasteWritten: false, enterWritten: false, enterArmed: false,
        admissionInputRevision: owner.inputRevision ?? null, pasteInputRevision: null, enterInputRevision: null }, pasteArmed: false,
      baseline: null, enterBaseline: null, admissionBinding: null, freshZeroAllowed: false,
      reader: null, bindingRevision: 0, bound: null, ambiguous: new Map(),
      invalidReason: null, reason: null, inflight: null, inflightSession: null };
    members.set(token, entry);
    byId.set(commandId, entry);
    return token;
  }

  function get(commandId, { tabId, command } = {}) {
    const entry = byId.get(commandId);
    if (!entry || entry.token.tabId !== tabId || entry.token.command !== commandText(command)) return null;
    return entry.token;
  }

  function lineState(cursor, skip = false) { return { cursor, carry: Buffer.alloc(0), skip, start: cursor }; }

  function ensureReader(entry, binding) {
    if (!binding) { entry.reason = 'writer-binding-pending'; return null; }
    if (entry.reader && binding.sessionId === entry.reader.binding.sessionId
      && binding.filePath === entry.reader.binding.filePath) {
      if (bindingKey(binding) !== bindingKey(entry.reader.binding)) entry.bindingRevision++;
      entry.reader.binding = binding;
      return entry.reader;
    }
    if (entry.bound) { entry.reason = 'binding-changed-after-wrapper'; return null; }
    const file = captureFile(binding);
    if (!file) { entry.reason = 'writer-file-pending'; return null; }
    const baseline = entry.enterBaseline || entry.baseline;
    let offset = 0;
    let skip = false;
    let lineageVerified = false;
    if (baseline && baseline.filePath === binding.filePath && baseline.sessionId === binding.sessionId) {
      if (!sameFile(baseline, file) || file.offset < baseline.offset) {
        entry.invalidReason = sameFile(baseline, file) ? 'transcript-truncated' : 'transcript-replaced';
        return null;
      }
      offset = baseline.offset;
      skip = baseline.skipPartial;
      lineageVerified = true;
    } else if (entry.freshZeroAllowed && !entry.reader && !baseline) {
      lineageVerified = true;
    } else if (!baseline?.anchor) {
      entry.reason = 'lineage-unknown';
      return null;
    }
    // A changed verified writer gets a new binding revision, never a new
    // admission epoch. Until its source anchor is found, offset zero is only a
    // read cursor through history, NOT permission to recognize a command.
    let index = baselineIndexes.get(file.identity);
    if (index && !index.invalidReason) {
      const unchanged = cachedGuardMatches(binding.filePath, file.identity, index.guard);
      if (unchanged === null) { entry.reason = 'baseline-index-unavailable'; return null; }
      if (!unchanged) index.invalidReason = 'transcript-rewritten';
    }
    if (!index || index.invalidReason) {
      // Old readers keep the invalid old index. A NEW explicit operation can
      // index the rewritten file once at its own valid pre-write checkpoint;
      // it does not inherit a permanent cache poison after ordinary Rewind.
      index = { state: lineState(0), offsets: new Map(), invalidReason: null, pendingRead: null, guard: null };
      baselineIndexes.set(file.identity, index);
    }
    const reader = { binding, identity: file.identity, tail: lineState(offset, skip),
      guard: sameFile(baseline, file) ? baseline.guard : file.guard,
      index, prefix: index.state, prefixEnd: offset, prefixDone: index.state.cursor >= offset,
      baselineWrappers: new Set(), lineageVerified, candidates: new Map() };
    entry.reader = reader;
    entry.bindingRevision++;
    entry.reason = lineageVerified ? null : 'lineage-pending';
    return reader;
  }

  function claimKey(reader, wrapperUuid) {
    return JSON.stringify([reader.identity, reader.binding.sessionId, wrapperUuid]);
  }

  function oldWrapper(reader, wrapperUuid) {
    const offset = reader.index.offsets.get(wrapperUuid);
    return offset !== undefined && offset < reader.prefixEnd || reader.baselineWrappers.has(wrapperUuid);
  }

  function tryBind(entry) {
    const reader = entry.reader;
    if (!reader || entry.bound || !reader.prefixDone || !reader.lineageVerified || entry.invalidReason) return;
    for (const candidate of reader.candidates.values()) {
      if (oldWrapper(reader, candidate.wrapper.uuid)) continue;
      const claimed = wrapperOwners.get(claimKey(reader, candidate.wrapper.uuid));
      if (claimed && claimed !== entry.token.commandId) continue;
      // Only a wrapper physically begun BEFORE every later admission fence
      // disambiguates a previously unbound Enter. FIFO and timestamps do not.
      const earlierThanAll = [...entry.ambiguous].every(([id, fence]) => {
        const other = byId.get(id);
        return other && entry.order < other.order && fence.identity === reader.identity && candidate.start < fence.offset;
      });
      if (entry.ambiguous.size && !earlierThanAll) return;
      entry.bound = candidate;
      wrapperOwners.set(claimKey(reader, candidate.wrapper.uuid), entry.token.commandId);
      for (const [id] of entry.ambiguous) byId.get(id)?.ambiguous.delete(entry.token.commandId);
      entry.ambiguous.clear();
      for (const other of byId.values()) {
        if (other !== entry && other.token.tabId === entry.token.tabId && !other.ambiguous.size) tryBind(other);
      }
      return;
    }
  }

  function record(entry, reader, raw, start, baselineOnly) {
    let value;
    try { value = JSON.parse(raw.toString('utf8')); } catch { return; }
    const kind = carrier(value) ? classifyClaudeStartupSlashRecord(value, entry.target) : null;
    if (baselineOnly) {
      if (carrier(value) && value.uuid && /^<command-name>\/(?:model|effort)<\/command-name>/i.test(readClaudeLocalCommandRecordText(value))) {
        if (!reader.index.offsets.has(value.uuid)) {
          if (reader.index.offsets.size >= MAX_INDEXED_WRAPPERS) reader.index.invalidReason = 'baseline-wrapper-index-overflow';
          else reader.index.offsets.set(value.uuid, start);
        }
      }
      return;
    }
    if (!reader.lineageVerified) {
      const anchor = (entry.enterBaseline || entry.baseline).anchor;
      if (value.uuid === anchor.uuid && hash(raw) === anchor.hash) {
        reader.lineageVerified = true;
        entry.reason = null;
        return;
      }
      if (value.sessionId === reader.binding.sessionId
        && (value.parentUuid === anchor.uuid || value.logicalParentUuid === anchor.uuid)) {
        reader.lineageVerified = true;
        entry.reason = null;
      } else {
        if (kind === 'wrapper' && value.uuid) {
          if (reader.baselineWrappers.size >= MAX_INDEXED_WRAPPERS) entry.invalidReason = 'baseline-wrapper-index-overflow';
          else reader.baselineWrappers.add(value.uuid);
        }
        return;
      }
    }
    if (value.sessionId !== reader.binding.sessionId || typeof value.uuid !== 'string' || !value.uuid || !kind) return;
    if (kind === 'wrapper') {
      if (oldWrapper(reader, value.uuid) || reader.candidates.has(value.uuid)) return;
      if (entry.bound) return;
      if (reader.candidates.size >= MAX_CANDIDATES) { entry.invalidReason = 'command-candidates-overflow'; return; }
      reader.candidates.set(value.uuid, { wrapper: value, child: null, start,
        wrapperGuard: { offset: start, length: raw.length, hash: hash(raw) }, childGuard: null });
      tryBind(entry);
    } else {
      const candidate = reader.candidates.get(value.parentUuid);
      // Direct child, same writer, physically AFTER that exact wrapper.
      if (candidate && !candidate.child) {
        candidate.child = value;
        candidate.childGuard = { offset: start, length: raw.length, hash: hash(raw) };
      }
    }
  }

  function consume(entry, reader, state, buffer, baselineOnly) {
    const data = state.carry.length ? Buffer.concat([state.carry, buffer]) : buffer;
    let start = 0;
    let newline;
    while ((newline = data.indexOf(10, start)) >= 0) {
      if (state.skip) state.skip = false;
      else {
        let raw = data.subarray(start, newline);
        if (raw.at(-1) === 13) raw = raw.subarray(0, raw.length - 1);
        if (raw.length > MAX_RECORD_BYTES) {
          entry.invalidReason = 'transcript-record-too-large';
          if (baselineOnly) reader.index.invalidReason = entry.invalidReason;
        }
        else record(entry, reader, raw, state.start + start, baselineOnly);
      }
      start = newline + 1;
    }
    const remainder = data.subarray(start);
    if (remainder.length > MAX_RECORD_BYTES) {
      entry.invalidReason = 'transcript-record-too-large';
      if (baselineOnly) reader.index.invalidReason = entry.invalidReason;
      state.carry = Buffer.alloc(0);
      state.skip = true;
      state.start += data.length;
    } else {
      state.carry = Buffer.from(remainder);
      state.start += start;
    }
    state.cursor += buffer.length;
  }

  function nextState(reader) {
    if (!reader.prefixDone && reader.prefix.cursor >= reader.prefixEnd) {
      reader.prefixDone = true;
      // Shared carry may become a complete old record at a later EOF. It must
      // survive; this operation separately skips its initial incomplete tail.
    }
    return reader.prefixDone ? reader.tail : reader.prefix;
  }

  function checkStat(entry, reader, stat) {
    if (reader.index.invalidReason) entry.invalidReason = reader.index.invalidReason;
    else if (fileIdentity(stat) !== reader.identity) entry.invalidReason = 'transcript-replaced';
    else if (stat.size < Math.max(reader.tail.cursor, reader.prefixEnd, reader.index.state.cursor)) {
      entry.invalidReason = 'transcript-truncated';
      reader.index.invalidReason = entry.invalidReason;
    }
    return !entry.invalidReason;
  }

  function guards(reader) {
    const unique = new Map();
    for (const guard of [reader.index.guard, reader.guard]) {
      if (guard?.length) unique.set(JSON.stringify(guard), guard);
    }
    return [...unique.values()];
  }

  async function checkGuards(entry, handle, items, reason = 'transcript-rewritten') {
    for (const guard of items) {
      if (!guard?.length) continue;
      const buffer = Buffer.alloc(guard.length);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, guard.offset);
      if (bytesRead !== buffer.length || hash(buffer) !== guard.hash) {
        entry.invalidReason = reason;
        if (reason === 'transcript-rewritten') entry.reader.index.invalidReason = reason;
        return false;
      }
    }
    return true;
  }

  function scanSync(entry, budget = SYNC_SCAN_BYTES) {
    if (!entry.prepared || !entry.write.enterArmed || entry.invalidReason || budget <= 0) return 0;
    const binding = resolve(entry);
    const reader = ensureReader(entry, binding);
    if (!reader) return 0;
    let fd;
    let consumed = 0;
    try {
      fd = io.openSync(binding.filePath, 'r');
      const stat = io.fstatSync(fd);
      if (!checkStat(entry, reader, stat)) return 0;
      let remaining = budget;
      for (const guard of guards(reader)) {
        if (guard.length > remaining) return consumed;
        const buffer = Buffer.alloc(guard.length);
        const count = io.readSync(fd, buffer, 0, buffer.length, guard.offset);
        remaining -= count; consumed += count;
        if (count !== buffer.length || hash(buffer) !== guard.hash) {
          entry.invalidReason = 'transcript-rewritten';
          reader.index.invalidReason = entry.invalidReason;
          return consumed;
        }
      }
      while (remaining > 0) {
        const state = nextState(reader);
        const end = reader.prefixDone ? stat.size : reader.prefixEnd;
        if (state.cursor >= end) break;
        const data = Buffer.alloc(Math.min(CHUNK_BYTES, remaining, end - state.cursor));
        const count = io.readSync(fd, data, 0, data.length, state.cursor);
        if (!count) { entry.reason = 'transcript-read-incomplete'; break; }
        consume(entry, reader, state, data.subarray(0, count), !reader.prefixDone);
        remaining -= count;
        consumed += count;
      }
      nextState(reader);
      if (checkStat(entry, reader, io.statSync(binding.filePath))) tryBind(entry);
    } catch { entry.reason = 'transcript-read-unavailable'; }
    finally { if (fd !== undefined) io.closeSync(fd); }
    return consumed;
  }

  function prepareWrite(token, kind) {
    const entry = members.get(token);
    const refusal = reason => ({ allowed: false, reason, commandId: entry?.token.commandId || null,
      evidence: entry ? snapshot(entry) : null });
    if (!entry || !['paste', 'enter'].includes(kind)) return refusal('invalid-command-capability');
    if (!current(entry)) return refusal('owner-changed');
    if (entry.write.enterArmed) return refusal('enter-already-armed');
    if (!entry.prepared) {
      entry.admissionBinding = resolve(entry);
      entry.baseline = entry.admissionBinding ? captureFile(entry.admissionBinding) : null;
      if (!entry.baseline && entry.owner.sourceBaseline) {
        const source = currentBinding(entry.owner.sourceBaseline);
        if (source) entry.baseline = captureFile(source);
      }
      entry.freshZeroAllowed = entry.owner.freshLaunch === true && !entry.baseline && !entry.owner.sourceBaseline
        && (!entry.admissionBinding || missingFile(entry.admissionBinding));
      entry.preparedAt = now();
      entry.prepared = true;
      ensureReader(entry, entry.admissionBinding);
      let scanBudget = SYNC_SCAN_BYTES;
      for (const prior of byId.values()) {
        if (prior === entry || prior.order >= entry.order || prior.token.tabId !== token.tabId
          || prior.target.kind !== entry.target.kind || prior.target.value !== entry.target.value
          || !prior.write.enterArmed || !sameExecution(prior.owner, entry.owner)) continue;
        if (prior.bound) continue;
        scanBudget -= scanSync(prior, scanBudget);
        if (prior.bound) continue;
        const fence = { identity: entry.baseline?.identity || null, offset: entry.baseline?.offset ?? null };
        entry.ambiguous.set(prior.token.commandId, fence);
        prior.ambiguous.set(entry.token.commandId, fence);
      }
    }
    // Capture/check again after all synchronous baseline work and immediately
    // before caller's byte. No read callback can arm an Enter.
    if (!current(entry)) return refusal('owner-changed');
    if (kind === 'enter') {
      const binding = resolve(entry);
      entry.enterBaseline = binding ? captureFile(binding) : null;
      if (binding && !entry.enterBaseline && !missingFile(binding)) {
        // Read failure is not evidence that no older wrapper arrived between
        // paste and Enter. Keep the physical action possible, but never turn
        // that lost floor into an offset-zero or timestamp-based proof.
        entry.invalidReason = 'enter-checkpoint-unavailable';
      }
      if (!entry.enterBaseline && !entry.invalidReason && entry.owner.sourceBaseline) {
        const source = currentBinding(entry.owner.sourceBaseline);
        if (source) entry.enterBaseline = captureFile(source);
      }
      // This is a stronger fence inside the SAME admitted epoch. A wrapper
      // logged before this Enter cannot be caused by it, even if paste had
      // already started. Never reset the first-byte checkpoint or commandId.
      if (entry.enterBaseline) entry.reader = null;
      if (!current(entry)) return refusal('owner-changed');
      entry.write.enterArmed = true;
      entry.write.enterWritten = null;
    }
    else entry.pasteArmed = true;
    // The existing PTY owner may legitimately reserve a newer input revision
    // after admit(). Preserve both facts; never reject its own reservation by
    // comparing it to the earlier admission revision.
    const writeOwner = captureOwner(token.tabId);
    if (kind === 'enter' || entry.write.pasteInputRevision === null) {
      entry.write[kind + 'InputRevision'] = Number.isSafeInteger(writeOwner?.inputRevision) ? writeOwner.inputRevision : null;
    }
    if (!current(entry)) return refusal('owner-changed');
    return { allowed: true, commandId: token.commandId, evidence: snapshot(entry) };
  }

  function markWritten(token, kind) {
    const entry = members.get(token);
    if (!entry || !['paste', 'enter'].includes(kind)
      || (kind === 'enter' ? !entry.write.enterArmed : !entry.pasteArmed)) return false;
    entry.write[kind + 'Written'] = true;
    return true;
  }

  function markUncertain(token, kind = 'enter', reason = 'physical-write-unknown') {
    const entry = members.get(token);
    if (!entry || !['paste', 'enter'].includes(kind)
      || (kind === 'enter' ? !entry.write.enterArmed : !entry.pasteArmed)) return false;
    if (entry.write[kind + 'Written'] !== true) entry.write[kind + 'Written'] = null;
    entry.reason = String(reason);
    return true;
  }

  async function readEntry(entry, requestedSession) {
    if (!entry.prepared) return result(entry, 'write-not-prepared', 'pending');
    if (!entry.write.enterArmed || entry.write.enterWritten === false) return result(entry, 'enter-withheld', 'pending');
    if (!current(entry)) return result(entry, 'owner-changed');
    if (entry.invalidReason) return result(entry, entry.invalidReason);
    const binding = resolve(entry);
    if (requestedSession && binding?.sessionId !== requestedSession) return result(entry, 'session-binding-mismatch');
    const reader = ensureReader(entry, binding);
    if (!reader) return result(entry, entry.invalidReason || entry.reason);
    const stamp = bindingKey(binding);
    const stable = () => current(entry) && entry.reader === reader && bindingKey(resolve(entry)) === stamp;
    let handle;
    try {
      handle = await io.promises.open(binding.filePath, 'r');
      if (!stable()) return result(entry, 'owner-or-binding-changed');
      const stat = await handle.stat();
      if (!stable()) return result(entry, 'owner-or-binding-changed');
      if (!checkStat(entry, reader, stat)) return result(entry, entry.invalidReason);
      if (!await checkGuards(entry, handle, guards(reader))) return result(entry, entry.invalidReason);
      if (!stable()) return result(entry, 'owner-or-binding-changed');
      while (!entry.invalidReason) {
        const state = nextState(reader);
        const end = reader.prefixDone ? stat.size : reader.prefixEnd;
        if (state.cursor >= end) break;
        const cursor = state.cursor;
        let data;
        let bytesRead;
        if (!reader.prefixDone) {
          // Concurrent readers join the same read-only prefix chunk, not a
          // settings execution queue and not duplicate whole-history I/O.
          let pending = reader.index.pendingRead;
          if (!pending || pending.cursor !== cursor) {
            const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, end - cursor));
            pending = { cursor, promise: null };
            pending.promise = handle.read(buffer, 0, buffer.length, cursor)
              .then(reply => ({ data: buffer, bytesRead: reply.bytesRead }))
              .finally(() => { if (reader.index.pendingRead === pending) reader.index.pendingRead = null; });
            reader.index.pendingRead = pending;
          }
          ({ data, bytesRead } = await pending.promise);
        } else {
          data = Buffer.alloc(Math.min(CHUNK_BYTES, end - cursor));
          ({ bytesRead } = await handle.read(data, 0, data.length, cursor));
        }
        if (!stable()) return result(entry, 'owner-or-binding-changed');
        // A sibling may advance the shared prefix while this read awaits I/O.
        // It is already parsed once; discard this duplicate chunk and catch up.
        if (state.cursor !== cursor) continue;
        if (!bytesRead) return result(entry, 'transcript-read-incomplete');
        consume(entry, reader, state, data.subarray(0, bytesRead), !reader.prefixDone);
      }
      nextState(reader);
      if (reader.prefixDone && reader.prefixEnd > 0 && reader.guard
        && reader.prefixEnd >= (reader.index.guard?.offset || 0) + (reader.index.guard?.length || 0)) {
        reader.index.guard = reader.guard;
      }
      const after = await io.promises.stat(binding.filePath);
      if (!stable()) return result(entry, 'owner-or-binding-changed');
      if (!checkStat(entry, reader, after)) return result(entry, entry.invalidReason);
      tryBind(entry);
      if (entry.ambiguous.size) return result(entry, 'ambiguous-prior-command');
      if (!reader.lineageVerified) return result(entry, 'lineage-pending');
      if (!entry.bound?.child) return result(entry, entry.bound ? 'stdout-not-found' : 'wrapper-not-found', 'pending');
      const pair = [copy(entry.bound.wrapper), copy(entry.bound.child)];
      const proof = await readOutcome(pair, entry.token.command, { sessionId: binding.sessionId,
        wrapperUuid: entry.bound.wrapper.uuid, afterMs: 0 });
      if (!stable()) return result(entry, 'owner-or-binding-changed');
      const finalStat = await io.promises.stat(binding.filePath);
      if (!stable()) return result(entry, 'owner-or-binding-changed');
      if (!checkStat(entry, reader, finalStat)) return result(entry, entry.invalidReason);
      if (!await checkGuards(entry, handle, [entry.bound.wrapperGuard, entry.bound.childGuard], 'command-record-changed')) {
        return result(entry, entry.invalidReason);
      }
      if (!stable()) return result(entry, 'owner-or-binding-changed');
      if (entry.ambiguous.size || entry.invalidReason) return result(entry, entry.invalidReason || 'ambiguous-prior-command');
      await handle.close();
      handle = null;
      // close() is an asynchronous boundary too. There must be no unguarded
      // await between the final owner/file/content check and publishing proof.
      if (!stable()) return result(entry, 'owner-or-binding-changed');
      if (!checkStat(entry, reader, io.statSync(binding.filePath))) return result(entry, entry.invalidReason);
      const finalFailure = finalGuardFailure(binding.filePath, reader.identity, [
        ...guards(reader).map(guard => ({ guard, reason: 'transcript-rewritten' })),
        { guard: entry.bound.wrapperGuard, reason: 'command-record-changed' },
        { guard: entry.bound.childGuard, reason: 'command-record-changed' },
      ]);
      if (finalFailure) {
        if (finalFailure !== 'transcript-read-unavailable') entry.invalidReason = finalFailure;
        if (finalFailure === 'transcript-rewritten') reader.index.invalidReason = finalFailure;
        return result(entry, finalFailure);
      }
      if (!stable()) return result(entry, 'owner-or-binding-changed');
      return result(entry, proof?.reason || 'exact-command-pair', proof?.success === true ? 'found'
        : proof?.terminal === true ? 'unknown' : 'pending', proof || {});
    } catch { return result(entry, 'transcript-read-unavailable'); }
    finally { if (handle) await handle.close().catch(() => {}); }
  }

  function read({ tabId, command, commandId, sessionId = null } = {}) {
    const token = get(commandId, { tabId, command });
    if (!token) return Promise.resolve(result(null, 'unknown-command-capability'));
    const entry = members.get(token);
    if (entry.inflight) return entry.inflightSession === sessionId ? entry.inflight
      : Promise.resolve(result(entry, 'different-binding-read-in-flight'));
    entry.inflightSession = sessionId;
    entry.inflight = readEntry(entry, sessionId).finally(() => { entry.inflight = null; entry.inflightSession = null; });
    return entry.inflight;
  }

  return { admit, get, prepareWrite, markWritten, markUncertain, read };
}

module.exports = { createClaudeSettingEvidence };
