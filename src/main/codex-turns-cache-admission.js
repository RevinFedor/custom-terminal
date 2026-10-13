'use strict';

const fs = require('node:fs');

// Proofs live only as long as the already byte/count-bounded outer graph.
// They are not public DTO fields or another records/cache retention policy.
const graphProofs = new WeakMap();
const SOURCE_FIELDS = ['filePath', 'sessionId', 'fileIdentity', 'size', 'mtimeMs', 'ctimeMs', 'sourceGeneration'];
const invalidated = () => Object.assign(new Error('Codex turns source changed during preparation'),
  { code: 'CODEX_SOURCE_READ_INVALIDATED' });

function completeSnapshot(snapshot, sessionId, filePath) {
  return snapshot?.sessionId === sessionId && snapshot.filePath === filePath
    && typeof filePath === 'string' && filePath.length > 0
    && typeof snapshot.fileIdentity === 'string' && snapshot.fileIdentity.length > 0
    && typeof snapshot.sourceGeneration === 'string' && snapshot.sourceGeneration.length > 0
    && Number.isSafeInteger(snapshot.size) && snapshot.size >= 0
    && Number.isFinite(snapshot.mtimeMs) && Number.isFinite(snapshot.ctimeMs);
}

class CodexTurnsCacheAdmission {
  constructor(api, service) { this.api = api; this.service = service; }

  supported() {
    return ['findCodexSessionFile', 'beginCodexSourceRead', 'assertCodexSourceRead',
      'assertCodexSourceReadCurrent', 'finishCodexSourceRead', 'isCodexSourceSnapshotCurrent']
      .every(name => typeof this.api?.[name] === 'function')
      && typeof this.service?.captureCodexTurnsLineageProof === 'function'
      && typeof this.service?.isCodexTurnsLineageProofCurrent === 'function';
  }

  captureLineage(sessionId, cwd) {
    if (!this.supported()) return null;
    try { return this.service.captureCodexTurnsLineageProof(sessionId, cwd); }
    catch { return null; } // optional/unknown proof keeps the canonical reader
  }

  captureSource(loaded, sessionId, cwd, lineage) {
    if (!this.supported() || !lineage || loaded?.composite === true
      || !completeSnapshot(loaded?.sourceSnapshot, sessionId, loaded?.filePath)) return null;
    // Copy only the provenance returned with THESE records. A later stat/read
    // can validate it, but must never become the certificate for an older graph.
    const snapshot = Object.freeze(Object.fromEntries(SOURCE_FIELDS.map(key => [key, loaded.sourceSnapshot[key]])));
    const proof = Object.freeze({ sessionId, cwd, lineage, snapshot });
    this.assertOwner(proof, true);
    return proof;
  }

  get(graph, sessionId, cwd) {
    const proof = graphProofs.get(graph);
    return this.supported() && proof?.sessionId === sessionId && proof.cwd === cwd ? proof : null;
  }

  remember(graph, proof) { if (proof) graphProofs.set(graph, proof); }

  assertOwner(proof, compareLineage = false) {
    const checkLineage = !compareLineage && typeof this.service.isCodexTurnsLineageProofAdmitted === 'function'
      ? this.service.isCodexTurnsLineageProofAdmitted : this.service.isCodexTurnsLineageProofCurrent;
    if (!this.api.isCodexSourceSnapshotCurrent(proof.snapshot)
      || !checkLineage.call(this.service, proof.lineage, proof.sessionId, proof.cwd)) throw invalidated();
  }

  assertFence(proof, read) {
    this.api.assertCodexSourceReadCurrent(read, read.turnsResolverBinding);
    this.assertOwner(proof);
  }

  assertCurrent(proof, read, compareLineage = true) {
    this.assertFence(proof, read);
    this.assertOwner(proof, compareLineage);
    const stat = fs.statSync(proof.snapshot.filePath);
    if (stat.size !== proof.snapshot.size || stat.mtimeMs !== proof.snapshot.mtimeMs
      || stat.ctimeMs !== proof.snapshot.ctimeMs || stat.dev + ':' + stat.ino !== proof.snapshot.fileIdentity) throw invalidated();
    // This cheap fence is last, including after full logical comparison and
    // synchronous source/annotation/diagnostic callbacks. No observer follows it.
    this.assertFence(proof, read);
  }

  async open(proof, { compareLineage = true } = {}) {
    if (!proof || !this.supported()) return null;
    let read = null, admitted = false;
    try {
      this.assertOwner(proof, compareLineage);
      const found = await this.api.findCodexSessionFile(proof.sessionId, proof.cwd);
      this.assertOwner(proof);
      if (found?.filePath !== proof.snapshot.filePath) throw invalidated();
      read = await this.api.beginCodexSourceRead(found.filePath, proof.sessionId);
      read.turnsResolverBinding = Object.freeze({ sessionId: proof.sessionId, filePath: found.filePath });
      this.assertOwner(proof);
      if (!read?.ticket || !completeSnapshot(read.snapshot, proof.sessionId, found.filePath)) return null;
      if (SOURCE_FIELDS.some(key => read.snapshot[key] !== proof.snapshot[key])) throw invalidated();
      this.assertCurrent(proof, read, false);
      admitted = true;
      return read;
    } catch (error) {
      if (error?.code === 'CODEX_SOURCE_READ_INVALIDATED') throw error;
      return null; // no stat/fence authority: no early hit or new certificate
    } finally {
      if (read && !admitted) this.api.finishCodexSourceRead(read);
    }
  }

  async validate(proof, read) {
    this.assertFence(proof, read);
    await this.api.assertCodexSourceRead(read);
    this.assertFence(proof, read);
    // Resolve last, after every projection, annotation and diagnostic await.
    // An unchanged A cannot attest to a SID which now resolves to B.
    const found = await this.api.findCodexSessionFile(proof.sessionId, proof.cwd);
    read.turnsResolverBinding = Object.freeze({ sessionId: proof.sessionId, filePath: found?.filePath });
    this.assertFence(proof, read);
    if (found?.filePath !== proof.snapshot.filePath) throw invalidated();
  }

  async revalidate(graph, sessionId, cwd) {
    const proof = graphProofs.get(graph);
    if (!proof) return null; // canonical/virtual result without optional proof
    if (!this.supported() || proof.sessionId !== sessionId || proof.cwd !== cwd) throw invalidated();
    // The direct loader already checked cache eligibility. This outer wrapper
    // owns a later final comparison; reopening does not repeat that DB/hash read.
    const read = await this.open(proof, { compareLineage: false });
    if (!read) throw invalidated();
    try { await this.validate(proof, read); }
    finally { this.finish(read); }
    // Caller must assertCurrent AFTER awaiting this lease, as Main does. A
    // full comparison/stat here would still require another one after that await.
    this.assertFence(proof, read);
    return { proof, read };
  }

  finish(read) { this.api.finishCodexSourceRead(read); }
}

module.exports = { CodexTurnsCacheAdmission };
