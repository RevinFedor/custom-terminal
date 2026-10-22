'use strict';
// Explicit test injection, never a production fallback. This runs only the
// attached reader source and private synthetic fixture, not an app/provider.
const path = require('node:path');
const { fork } = require('node:child_process');
const { HistoryProcessTransport } = require('../history-read-process-transport');
module.exports = function createNodeHistoryProcessForTest(workerData) {
  const child = fork(path.join(__dirname, '..', 'history-read-process.js'), [], {
    env: { ...process.env, NOTED_HISTORY_READER_PROCESS: '1', NOTED_HISTORY_READER_NODE_TEST: '1' },
    serialization: 'advanced', execArgv: [], stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  return new HistoryProcessTransport(child, workerData, { node: true });
};
