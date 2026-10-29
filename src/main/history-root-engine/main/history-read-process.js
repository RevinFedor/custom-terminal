'use strict';

// Production is an Electron utility process. The explicit Node IPC branch is
// used by the bounded synthetic process harness; it never starts Electron.
const { EventEmitter } = require('node:events');
const { initializeHistoryReadRuntime } = require('./history-read-runtime');
if (process.env.NOTED_HISTORY_READER_PROCESS !== '1') throw new Error('History reader process guard missing');
const parentPort = new EventEmitter();
let initialized = false;
const receive = message => {
  if (!initialized) {
    if (message?.event !== 'history-reader-init') throw new Error('History reader initialization missing');
    initialized = true;
    initializeHistoryReadRuntime({ parentPort, workerData: message.workerData, transport: 'process-copy' });
    require('./history-read-worker');
    return;
  }
  parentPort.emit('message', message);
};
if (process.parentPort) {
  parentPort.postMessage = message => process.parentPort.postMessage(message);
  process.parentPort.on('message', event => receive(event.data));
} else if (process.send && process.env.NOTED_HISTORY_READER_NODE_TEST === '1') {
  parentPort.postMessage = message => {
    if (!process.connected) throw Object.assign(new Error('History reader parent disconnected'), { code: 'HISTORY_READER_TRANSPORT_UNKNOWN' });
    process.send(message);
  };
  process.on('message', receive);
  process.on('disconnect', () => process.exit(0));
} else throw new Error('History reader parent port unavailable');
