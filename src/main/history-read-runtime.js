'use strict';
let runtime;
function initializeHistoryReadRuntime(value) {
  if (runtime) throw new Error('History reader runtime already initialized');
  runtime = value;
}
function getHistoryReadRuntime() {
  if (!runtime) throw new Error('History reader must be started through its process bootstrap');
  return runtime;
}
module.exports = { initializeHistoryReadRuntime, getHistoryReadRuntime };
