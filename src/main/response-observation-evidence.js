'use strict';

const { createHash } = require('node:crypto');
const { normalizeResponseSubject } = require('./orchestration-response-observation');
const { classifyOrchestrationResultProbe } = require('./orchestration-result-proof');

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const subjectKey = subject => digest(normalizeResponseSubject(subject));

// Observed final output is separate from the request registry and notification
// payload. A restart can recover it without rereading a changed conversation.
class ResponseObservationEvidenceStore {
  constructor(db) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS response_observation_evidence (
      run_id TEXT PRIMARY KEY, subject_key TEXT NOT NULL, evidence_json TEXT NOT NULL,
      evidence_hash TEXT NOT NULL
    )`);
    this.select = db.prepare('SELECT * FROM response_observation_evidence WHERE run_id = ? AND subject_key = ?');
    this.selectRun = db.prepare('SELECT * FROM response_observation_evidence WHERE run_id = ?');
    this.insert = db.prepare('INSERT INTO response_observation_evidence (run_id,subject_key,evidence_json,evidence_hash) VALUES (?,?,?,?)');
    this.freeze = db.transaction((runId, subject, result) => {
      const classification = classifyOrchestrationResultProbe(result, { authoritativeCompletion: true });
      if (!runId || result?.sourceVerified !== true || classification.kind === 'pending'
        || (classification.kind === 'complete' && result.found !== true)) {
        throw new Error('response_observation_evidence_unproven');
      }
      const key = subjectKey(subject);
      const existing = this.readSelected(runId);
      const evidence = { version: 1, runId, subject: normalizeResponseSubject(subject), result };
      const json = JSON.stringify(evidence);
      if (existing) return existing;
      this.insert.run(runId, key, json, digest(evidence));
      return evidence;
    });
  }

  read(runId, subject) {
    const row = this.select.get(runId, subjectKey(subject));
    return this.decode(runId, row);
  }

  readSelected(runId) {
    return this.decode(runId, this.selectRun.get(runId));
  }

  decode(runId, row) {
    if (!row) return null;
    let evidence;
    try { evidence = JSON.parse(row.evidence_json); } catch { throw new Error('response_observation_evidence_corrupt'); }
    if (evidence.runId !== runId || (evidence.failure ? row.subject_key !== 'failure' : subjectKey(evidence.subject) !== row.subject_key)
      || digest(evidence) !== row.evidence_hash) throw new Error('response_observation_evidence_corrupt');
    return evidence;
  }

  freezeFailure(runId, { error, code }) {
    return this.db.transaction(() => {
      const existing = this.readSelected(runId);
      if (existing) return existing;
      const evidence = { version: 1, runId, failure: { error: String(error), code: code || 'response_unavailable' } };
      this.insert.run(runId, 'failure', JSON.stringify(evidence), digest(evidence));
      return evidence;
    }).immediate();
  }

  retainRuns(runIds) {
    const retained = new Set(runIds);
    const remove = this.db.prepare('DELETE FROM response_observation_evidence WHERE run_id = ?');
    this.db.transaction(() => {
      for (const row of this.db.prepare('SELECT DISTINCT run_id FROM response_observation_evidence').all()) {
        if (!retained.has(row.run_id)) remove.run(row.run_id);
      }
    }).immediate();
  }
}

module.exports = { ResponseObservationEvidenceStore, responseObservationSubjectKey: subjectKey };
