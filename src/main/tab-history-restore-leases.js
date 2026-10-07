'use strict';

class TabHistoryRestoreLeases {
  constructor({ getLatest, getById, deleteById, token, now = Date.now, leaseTtlMs = 120_000 } = {}) {
    if (typeof getLatest !== 'function') throw new TypeError('getLatest must be a function');
    if (typeof getById !== 'function') throw new TypeError('getById must be a function');
    if (typeof deleteById !== 'function') throw new TypeError('deleteById must be a function');
    if (typeof token !== 'function') throw new TypeError('token must be a function');
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    if (!Number.isFinite(leaseTtlMs) || leaseTtlMs <= 0) throw new TypeError('leaseTtlMs must be positive');

    this.getLatest = getLatest;
    this.getById = getById;
    this.deleteById = deleteById;
    this.createToken = token;
    this.now = now;
    this.leaseTtlMs = leaseTtlMs;
    this.leases = new Map();
  }

  begin({ projectId, id } = {}) {
    if (!projectId) return { ok: false, reason: 'invalid_project' };

    const entry = id === undefined || id === null
      ? this.getLatest(projectId)
      : this.getById(id, projectId);
    if (!entry) return { ok: false, reason: 'not_found' };

    const entryId = entry.id;
    if (entryId === undefined || entryId === null) {
      return { ok: false, reason: 'invalid_entry' };
    }

    const entryProjectId = entry.project_id ?? entry.projectId;
    if (entryProjectId !== projectId) {
      return { ok: false, reason: 'project_mismatch', id: entryId };
    }

    const existingLease = this.leases.get(entryId);
    if (existingLease) {
      if (this.now() - existingLease.createdAt < this.leaseTtlMs) {
        return { ok: false, reason: 'busy', id: entryId };
      }
      // Renderer reload/crash can lose the finish call. A bounded lease keeps
      // that from making the history row permanently unrestorable.
      this.leases.delete(entryId);
    }

    const leaseToken = this.createToken({ projectId, id: entryId, entry });
    if (!leaseToken) throw new Error('token() must return a non-empty value');

    this.leases.set(entryId, { projectId, token: leaseToken, createdAt: this.now() });
    return {
      ok: true,
      projectId,
      id: entryId,
      token: leaseToken,
      entry,
    };
  }

  validate({ projectId, id, token } = {}) {
    const lease = this.leases.get(id);
    if (!lease) return { ok: false, reason: 'not_leased' };
    if (this.now() - lease.createdAt >= this.leaseTtlMs) {
      this.leases.delete(id);
      return { ok: false, reason: 'lease_expired' };
    }
    if (lease.projectId !== projectId) return { ok: false, reason: 'project_mismatch' };
    if (lease.token !== token) return { ok: false, reason: 'token_mismatch' };
    const entry = this.getById(id, projectId);
    if (!entry) return { ok: false, reason: 'not_found' };
    return { ok: true, entry, lease };
  }

  finish({ projectId, id, token, commit = false } = {}) {
    const validation = this.validate({ projectId, id, token });
    if (!validation.ok) return validation;

    if (!commit) {
      this.leases.delete(id);
      return { ok: true, committed: false, id };
    }

    try {
      const deleted = this.deleteById(id);
      if (deleted === false) {
        return { ok: false, reason: 'delete_failed', committed: false, id };
      }
      return { ok: true, committed: true, id };
    } finally {
      // A failed delete must not leave an in-memory lease stuck forever. The
      // history row remains available for a later begin() unless deletion
      // actually completed before the dependency threw.
      this.leases.delete(id);
    }
  }
}

module.exports = {
  TabHistoryRestoreLeases,
};
