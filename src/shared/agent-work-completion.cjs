'use strict';

// Main-owned metadata on an exact provider outcome. It changes neither turn
// busy nor delivery proof. Unknown future Goal status stays attention, not
// success; legacy/non-Goal providers keep their existing completion contract.
function hasPendingAgentGoalWork(value) {
  return value?.goalWork?.version === 1 && value.goalWork.pending === true;
}

module.exports = { hasPendingAgentGoalWork };
