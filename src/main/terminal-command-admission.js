/** A prepared shell write can be revoked by Stop, even during async preflight. */
function createTerminalCommandAdmission(getTerminal) {
  const prepared = new Map(), written = new Map(), receipts = new Map();
  return {
    begin(tabId, id) {
      const terminal = getTerminal(tabId);
      if (!terminal || !id || receipts.has(id)) return false;
      prepared.set(tabId, { id, terminal });
      return true;
    },
    valid(tabId, id) {
      const entry = prepared.get(tabId);
      return !!entry && entry.id === id && entry.terminal === getTerminal(tabId);
    },
    cancel(tabId, id) {
      if (!id || prepared.get(tabId)?.id === id) prepared.delete(tabId);
    },
    commit(tabId, id) {
      if (!this.valid(tabId, id)) return false;
      const entry = prepared.get(tabId);
      prepared.delete(tabId);
      written.set(tabId, { ...entry, runSeq: null });
      receipts.set(id, { tabId, terminal: entry.terminal, written: false });
      if (receipts.size > 4096) receipts.delete(receipts.keys().next().value);
      return true;
    },
    confirm(tabId, id) {
      const r = receipts.get(id);
      if (r?.tabId === tabId && r.terminal === getTerminal(tabId)) r.written = true;
    },
    committed(tabId, id) { const r = receipts.get(id); return r?.written === true && r.tabId === tabId && r.terminal === getTerminal(tabId); },
    started(tabId, runSeq) {
      const entry = written.get(tabId);
      if (entry && entry.runSeq !== null && entry.runSeq !== runSeq) { written.delete(tabId); return null; }
      if (entry && entry.terminal === getTerminal(tabId) && entry.runSeq === null) entry.runSeq = runSeq;
      return entry?.runSeq === runSeq ? entry.id : null;
    },
    finished(tabId, runSeq) {
      const entry = written.get(tabId);
      if (!entry || entry.runSeq !== runSeq || entry.terminal !== getTerminal(tabId)) return null;
      written.delete(tabId);
      return entry.id;
    },
    running(tabId) { const entry = written.get(tabId); return entry && entry.terminal === getTerminal(tabId) ? entry.id : null; },
  };
}
module.exports = { createTerminalCommandAdmission };
