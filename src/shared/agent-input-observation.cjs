'use strict';

// A conservative renderer-positive hint may supplement an unavailable read,
// but cannot revive evidence whose process/input owner was explicitly revoked.
function agentInputObservationInvalidated(value) {
  return value?.observation?.status === 'superseded'
    || value?.observation?.status === 'cancelled';
}

module.exports = { agentInputObservationInvalidated };
