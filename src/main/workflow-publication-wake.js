'use strict';

// Best-effort invalidation on the existing projects stream. The durable owner
// is WorkflowOrganization, not this tiny retained clock. No I/O, timer or queue.
function createWorkflowPublicationWake({ onError = () => {} } = {}) {
  let binding = null, latest = null;
  const report = reason => { try { onError(reason); } catch {} };
  const current = () => { try { return binding?.isCurrent() === true; } catch { return false; } };
  const observe = publication => {
    // The early Main callback must not touch later const/let/services. Late
    // start seeds the actual durable publication instead of replaying events.
    if (!binding || !current()) return false;
    if (publication?.version !== 1 || !Number.isSafeInteger(publication.generation) || publication.generation < 0
      || !Number.isSafeInteger(publication.revision) || publication.revision < 0) {
      report('publication-unavailable'); return false;
    }
    if (latest && (publication.generation < latest.generation || publication.revision < latest.revision
      || publication.generation === latest.generation && publication.revision === latest.revision)) return false;
    latest = Object.freeze({ version: 1, source: 'workflow-organization-publication', epoch: binding.epoch,
      generation: publication.generation, revision: publication.revision });
    // State survives a missing channel/subscriber. A future connect seed sees
    // it; neither a scheduled callback nor a successful send is a client ACK.
    try { binding.schedule('workflow-publication'); }
    catch { report('channel-unavailable'); }
    return true;
  };
  return {
    observe,
    start(options) {
      if (binding) return false;
      if (typeof options?.epoch !== 'string' || !options.epoch || options.epoch.length > 90
        || typeof options.isCurrent !== 'function' || typeof options.readPublication !== 'function'
        || typeof options.schedule !== 'function') { report('binding-unavailable'); return false; }
      binding = { epoch: options.epoch, isCurrent: options.isCurrent, schedule: options.schedule };
      if (!current()) return false;
      try { return observe(options.readPublication()); }
      catch { report('publication-unavailable'); return false; }
    },
    snapshot() { return current() && latest ? { ...latest } : null; },
  };
}
module.exports = { createWorkflowPublicationWake };
