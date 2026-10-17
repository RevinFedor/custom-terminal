'use strict';
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');

const MiB = 1024 * 1024;
const DEFAULTS = Object.freeze({ rollingBytes: 2 * MiB, globalRollingBytes: 32 * MiB,
  preBytes: 2 * MiB, tailBytes: 2 * MiB, events: 8192, maxPins: 4,
  maxOwners: 1024, ageMs: 120000, tailMs: 60000 });
const EVENT_CHARGE = 256, OWNER_CHARGE = 4096;
const EPOCH_KEYS = ['lifecycleGeneration', 'mirrorGeneration', 'runSeq', 'stopRevision'];
function ownerFields(value = {}) {
  value ||= {};
  const out = {};
  for (const key of ['tabId', 'lifecycleGeneration', 'mirrorGeneration']) {
    if (typeof value[key] === 'string') out[key] = value[key].slice(0, 256);
  }
  for (const key of ['runSeq', 'stopRevision', 'inputRevision', 'mirrorWriteSeq', 'mirrorFlushedSeq']) {
    if (Number.isFinite(value[key])) out[key] = value[key];
  }
  return out;
}
function sendFields(value = {}) {
  const out = {};
  for (const key of ['handoffId', 'operationKey', 'attemptId', 'incidentId', 'reason']) {
    if (typeof value[key] === 'string') out[key] = value[key].slice(0, 256);
  }
  return out;
}
function epochChanged(a, b) { return EPOCH_KEYS.some(k => a[k] !== b[k]); }

// The source is decoded app onData, BEFORE OSC/synthetic insertions. Owned
// UTF-16LE buffers preserve each delivered code unit, including lone surrogates.
// No diagnostic action may pause the parser, write input or settle a receipt.
function createTerminalRawWindow({ persist, now = () => performance.timeOrigin + performance.now(),
  setTimer = setTimeout, clearTimer = clearTimeout, limits: requested = {}, log = () => {} } = {}) {
  const limits = { ...DEFAULTS, ...requested }, weak = new WeakMap(), owners = new Set(), blocks = new Map(), pins = new Map();
  let rollingCharge = 0, nextBlock = 0, diagnosticsErrors = 0, ownerOmissions = 0, pinOmissions = 0;
  let publications = 0, suppressedPublications = 0, publicationAt = null;
  const safe = (fn, fallback = null) => { try { return fn(); } catch { diagnosticsErrors++; return fallback; } };
  const report = value => safe(() => {
    const time = now();
    if (publicationAt === null || time - publicationAt >= 60000) { publicationAt = time; publications = 0; }
    if (publications >= 8) { suppressedPublications++; return; }
    publications++; log({ ...value, diagnosticsErrors, suppressedPublications });
  });
  const addLoss = (state, event, reason) => {
    const loss = state.loss;
    loss.events++; loss.codeUnits += event.codeUnits; loss.fromSeq ??= event.seq; loss.toSeq = event.seq;
    loss.reasons[reason] = (loss.reasons[reason] || 0) + 1;
  };
  const remove = (block, reason) => {
    if (!blocks.delete(block.id)) return;
    block.owner.events.delete(block.id); block.owner.charge -= block.charge; rollingCharge -= block.charge;
    addLoss(block.owner, block, reason);
  };
  const pruneOwner = (state, time) => {
    for (const event of state.events.values()) {
      if (time - event.at <= limits.ageMs) break;
      remove(event, 'age');
    }
  };
  const get = (token, identity) => {
    if (!token || (typeof token !== 'object' && typeof token !== 'function')) return null;
    let state = weak.get(token);
    if (state) return state;
    if (owners.size >= limits.maxOwners) { ownerOmissions++; return null; }
    state = { id: randomUUID(), epoch: ownerFields(identity), seq: 0, events: new Map(), charge: 0,
      observedCodeUnits: 0, loss: { events: 0, codeUnits: 0, fromSeq: null, toSeq: null, reasons: {} }, pin: null };
    weak.set(token, state); owners.add(state); return state;
  };
  const metadata = block => ({ seq: block.seq, at: block.at, owner: block.epoch,
    originalCodeUnits: block.originalCodeUnits, retainedStartOffset: block.start,
    retainedCodeUnits: block.codeUnits, droppedPrefixCodeUnits: block.start });
  const ownCopy = (text, start, count) => {
    const buffer = Buffer.allocUnsafeSlow(count * 2);
    buffer.write(text.slice(start, start + count), 0, buffer.length, 'utf16le'); return buffer;
  };
  const cloneBytes = bytes => { const copy = Buffer.allocUnsafeSlow(bytes.length); bytes.copy(copy); return copy; };
  const send = (pin, kind, data) => {
    const accepted = safe(() => persist?.[kind]?.(pin.id, data), false);
    if (accepted === false || accepted == null) { pin.persistenceOmissions++; pin.persistenceComplete = false; }
    return accepted;
  };
  const info = pin => ({ version: 1, id: pin.id, sourcePoint: 'app-onData-decoded-v1',
    clock: 'performance.timeOrigin+performance.now', representation: 'UTF-16LE code units; not kernel bytes',
    terminalInstanceId: pin.owner.id, owner: { ...pin.epoch }, send: { ...pin.send }, aliases: pin.aliases.map(x => ({ ...x })),
    aliasesOmitted: pin.aliasesOmitted, captureAt: pin.at, captureSeq: pin.seq,
    captureHeadlessSeq: pin.headlessSeq, captureWhileSyncOpen: pin.syncOpen,
    pre: { ...pin.pre }, tail: { ...pin.tail }, end: pin.end && { ...pin.end },
    persistenceComplete: pin.persistenceComplete, persistenceOmissions: pin.persistenceOmissions,
    // Raw and headless include different synthetic/resize paths; do not invent
    // a complete baseline replay from a complete range of app-delivered data.
    replayFromBaselineComplete: false, replayReason: 'raw-to-headless-insertion-map-not-certified',
    limits: { ...limits }, diagnosticsErrors });
  const seal = (pin, reason, frame = null) => {
    if (pin.end) return;
    pin.end = { at: now(), reason, ...(frame ? { headlessSeq: frame.writeSeq } : {}) };
    clearTimer(pin.timer); pin.owner.pin = null; pins.delete(pin.id);
    send(pin, 'seal', { summary: info(pin) });
    report({ kind: 'incident-sealed', id: pin.id, reason, preStored: pin.pre.storedCodeUnits,
      tailStored: pin.tail.storedCodeUnits, tailDropped: pin.tail.droppedCodeUnits,
      persistenceOmissions: pin.persistenceOmissions });
  };
  const appendTail = (pin, text, state, time) => {
    pin.tail.seenCodeUnits += text.length; pin.tail.seenEvents++;
    const available = Math.max(0, limits.tailBytes - pin.tail.charge - EVENT_CHARGE);
    const count = Math.min(text.length, Math.floor(available / 2));
    if (!count) { pin.tail.droppedCodeUnits += text.length; pin.tail.droppedEvents++; pin.tail.complete = false; return; }
    // Keep earliest late data; once full never evict the pinned prefix/tail.
    const buffer = ownCopy(text, 0, count), descriptor = { seq: state.seq, at: time,
      owner: { ...state.epoch }, originalCodeUnits: text.length, retainedStartOffset: 0,
      retainedCodeUnits: count, droppedSuffixCodeUnits: text.length - count };
    pin.tail.charge += buffer.length + EVENT_CHARGE; pin.tail.storedCodeUnits += count;
    if (count < text.length) { pin.tail.droppedCodeUnits += text.length - count; pin.tail.complete = false; }
    send(pin, 'append', { entries: [{ descriptor, buffer }] });
  };
  const api = {
    output(token, text, identity = {}) { return safe(() => {
      if (typeof text !== 'string' || !text) return null;
      const state = get(token, identity); if (!state) return null;
      const time = now(), epoch = ownerFields(identity);
      if (state.pin && epochChanged(state.pin.epoch, epoch)) seal(state.pin, 'owner-epoch-changed');
      state.epoch = epoch; state.seq++; state.observedCodeUnits += text.length;
      if (state.pin) appendTail(state.pin, text, state, time);
      pruneOwner(state, time);
      const maxUnits = Math.max(0, Math.floor((Math.min(limits.rollingBytes, limits.globalRollingBytes) - EVENT_CHARGE) / 2));
      const count = Math.min(text.length, maxUnits), start = text.length - count;
      if (!count) { addLoss(state, { seq: state.seq, codeUnits: text.length }, 'allocation-budget'); return state.seq; }
      const buffer = ownCopy(text, start, count), charge = buffer.length + EVENT_CHARGE;
      while (state.events.size && (state.charge + charge > limits.rollingBytes || state.events.size >= limits.events)) remove(state.events.values().next().value, 'owner-budget');
      while (blocks.size && rollingCharge + charge > limits.globalRollingBytes) remove(blocks.values().next().value, 'global-budget');
      const block = { id: ++nextBlock, owner: state, seq: state.seq, at: time, epoch, buffer,
        start, codeUnits: count, originalCodeUnits: text.length, charge };
      if (start) addLoss(state, { seq: state.seq, codeUnits: start }, 'oversized-chunk-prefix');
      state.events.set(block.id, block); blocks.set(block.id, block); state.charge += charge; rollingCharge += charge;
      return state.seq;
    }); },
    pin(token, { incidentId, sendIdentity = {}, identity = {}, headlessSeq = null, syncOpen = null } = {}) { return safe(() => {
      const state = get(token, identity);
      if (!state) return { available: false, reason: 'raw-owner-unavailable' };
      const alias = sendFields({ ...sendIdentity, incidentId });
      if (state.pin && epochChanged(state.pin.epoch, ownerFields(identity))) seal(state.pin, 'owner-epoch-changed');
      if (state.pin) {
        if (state.pin.aliases.length < 16) state.pin.aliases.push(alias); else state.pin.aliasesOmitted++;
        return { available: true, id: state.pin.id, joined: true, manifestPath: persist?.reference?.(state.pin.id) || null };
      }
      if (pins.size >= limits.maxPins) { pinOmissions++; return { available: false, reason: 'pin-admission-budget' }; }
      const time = now(); pruneOwner(state, time);
      const kept = []; let charge = 0;
      for (const block of [...state.events.values()].reverse()) {
        if (charge + block.charge > limits.preBytes) break;
        kept.push(block); charge += block.charge;
      }
      kept.reverse();
      const pin = { id: randomUUID(), owner: state, epoch: ownerFields(identity), send: alias, aliases: [], aliasesOmitted: 0,
        at: time, seq: state.seq, headlessSeq, syncOpen,
        pre: { fromSeq: kept[0]?.seq ?? null, toSeq: kept.at(-1)?.seq ?? null,
          storedCodeUnits: kept.reduce((n, b) => n + b.codeUnits, 0), events: kept.length, charge,
          lossBeforeCapture: { ...state.loss, reasons: { ...state.loss.reasons } },
          completeWithinRetainedRange: kept.length > 0 && kept.every(b => b.start === 0),
          onsetObserved: false },
        tail: { seenEvents: 0, seenCodeUnits: 0, storedCodeUnits: 0, droppedCodeUnits: 0, droppedEvents: 0, charge: 0, complete: true },
        persistenceOmissions: 0, persistenceComplete: true, end: null, timer: null };
      const entries = kept.map(block => ({ descriptor: metadata(block), buffer: cloneBytes(block.buffer) }));
      state.pin = pin; pins.set(pin.id, pin);
      send(pin, 'start', { summary: info(pin), entries });
      try { pin.timer = setTimer(() => safe(() => seal(pin, 'tail-deadline')), limits.tailMs); }
      catch { diagnosticsErrors++; seal(pin, 'diagnostic-timer-unavailable'); }
      pin.timer?.unref?.();
      return { available: true, id: pin.id, joined: false, captureSeq: pin.seq,
        manifestPath: persist?.reference?.(pin.id) || null,
        persistence: 'queued-not-yet-confirmed', pre: { ...pin.pre }, replayFromBaselineComplete: false };
    }); },
    commit(token, frame, identity = {}) { safe(() => {
      const state = weak.get(token), pin = state?.pin; if (!pin) return;
      if (epochChanged(pin.epoch, ownerFields(identity))) { seal(pin, 'owner-epoch-changed'); return; }
      if (frame?.authoritativeFrameCommitted === true && frame.synchronizedOutputOpen !== true
        && Number.isFinite(frame.writeSeq) && frame.writeSeq === frame.flushedSeq
        && Number.isFinite(pin.headlessSeq) && frame.writeSeq >= pin.headlessSeq) seal(pin, 'committed-current-frame', frame);
    }); },
    end(token, reason = 'terminal-disposed') { safe(() => {
      const state = weak.get(token); if (!state) return;
      if (state.pin) seal(state.pin, reason);
      for (const block of [...state.events.values()]) remove(block, 'owner-disposed');
      owners.delete(state); weak.delete(token);
    }); },
    snapshot() { return { rollingCharge, rollingOwners: owners.size, activePins: pins.size,
      pinPayloadCharge: [...pins.values()].reduce((n, p) => n + p.pre.charge + p.tail.charge, 0),
      ownerMetadataCharge: owners.size * OWNER_CHARGE, ownerOmissions, pinOmissions,
      diagnosticsErrors, limits: { ...limits }, pins: [...pins.values()].map(info) }; },
    dispose() { for (const pin of [...pins.values()]) safe(() => seal(pin, 'shutdown')); return persist?.close?.(); },
  };
  return api;
}
function observeTerminalRaw(journal, method, ...args) { try { return journal?.[method]?.(...args) ?? null; } catch { return null; } }
module.exports = { createTerminalRawWindow, observeTerminalRaw, DEFAULTS, EVENT_CHARGE };
