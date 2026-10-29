'use strict';

// The primary root migration is qualified in an explicitly selected private
// test profile before ordinary installed History adopts that reader. Both Main
// and renderer use the SAME decision; a UI-only switch would leave the slow
// experimental producer on the ordinary service route.
function historyPrimaryRootEnabled(env = {}) {
  const root = env.NOTED_E2E_CLI_ISOLATION_ROOT;
  return env.NOTED_E2E_TEST === 'true'
    && env.NOTED_E2E_PRIMARY_HISTORY_ROOT === '1'
    && typeof root === 'string' && root.startsWith('/') && !root.endsWith('/')
    && env.NOTED_USER_DATA_DIR === root + '/user-data';
}

module.exports = { historyPrimaryRootEnabled };
