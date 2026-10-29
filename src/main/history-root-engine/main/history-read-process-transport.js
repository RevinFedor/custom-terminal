'use strict';

const path = require('node:path');
const { EventEmitter } = require('node:events');
const unavailable = () => Object.assign(new Error('History reader process state is unknown'), { code: 'HISTORY_READER_TRANSPORT_UNKNOWN' });

// The adapter deliberately does not equate 'error', disconnected IPC or kill()
// returning true with process death. Only exit permits another generation.
class HistoryProcessTransport extends EventEmitter {
  constructor(child, workerData, { node = false } = {}) {
    super();
    this.child = child; this.node = node; this.state = 'starting';
    const reportUnknown = error => {
      if (this.state === 'exited') return;
      this.state = 'unknown';
      // The child may already exist when initialization fails. Retain it and
      // report only after HistoryReadClient has installed its listeners.
      queueMicrotask(() => { if (this.state !== 'exited') this.emit('error', error); });
    };
    this.reportUnknown = reportUnknown;
    child.on('spawn', () => { if (this.state === 'starting') this.state = 'running'; this.emit('spawn'); });
    child.on('message', message => { if (this.state !== 'exited') this.emit('message', message); });
    child.on('error', error => {
      if (this.state === 'exited') return;
      reportUnknown(Object.assign(unavailable(), { cause: typeof error === 'object' ? error : undefined }));
    });
    child.on('disconnect', () => {
      if (this.state === 'exited') return;
      reportUnknown(unavailable());
    });
    child.on('exit', (code, signal) => {
      if (this.state === 'exited') return;
      this.state = 'exited'; this.exitCode = code; this.exitSignal = signal;
      this.emit('exit', code, signal);
    });
    try { this.postMessage({ event: 'history-reader-init', workerData }); }
    catch (error) { if (this.state !== 'unknown') reportUnknown(Object.assign(unavailable(), { cause: error })); }
  }
  get pid() { return this.child.pid; }
  postMessage(message) {
    if (this.state === 'unknown' || this.state === 'exited') throw unavailable();
    try {
      if (this.node) {
        if (!this.child.connected) throw unavailable();
        this.child.send(message, error => { if (error && this.state !== 'exited') {
          this.reportUnknown(Object.assign(unavailable(), { cause: error }));
        } });
      } else this.child.postMessage(message);
    } catch (cause) {
      const error = Object.assign(unavailable(), { cause });
      this.reportUnknown(error); throw error;
    }
    // Utility-process transfer lists accept MessagePorts, not ArrayBuffers.
    // Existing v8-1 bytes retain their format but cross this boundary by copy.
  }
  ref() { if (this.node) { this.child.ref(); this.child.channel?.ref?.(); } }
  unref() { if (this.node) { this.child.unref(); this.child.channel?.unref?.(); } }
  terminate() {
    if (this.state === 'exited') return Promise.resolve(this.exitCode);
    return new Promise((resolve, reject) => {
      const exited = code => { clearTimeout(timer); resolve(code); };
      const timer = setTimeout(() => {
        this.removeListener('exit', exited); reject(unavailable());
      }, 5000);
      timer.unref?.();
      this.once('exit', exited);
      try { if (!this.child.kill()) { /* exit may still arrive; no death claim */ } }
      catch { /* retain the unknown generation until an actual exit */ }
    });
  }
}

function createHistoryProcessTransport(workerData) {
  const electron = require('electron');
  if (process.type !== 'browser' || !electron.app?.isReady() || !electron.utilityProcess?.fork) {
    throw Object.assign(new Error('History reader requires a ready Electron Main utilityProcess'), { code: 'HISTORY_READER_TRANSPORT_UNKNOWN' });
  }
  const child = electron.utilityProcess.fork(path.join(__dirname, 'history-read-process.js'), [], {
    env: { ...process.env, NOTED_HISTORY_READER_PROCESS: '1' },
    serviceName: 'Noted History Reader', stdio: 'inherit',
  });
  return new HistoryProcessTransport(child, workerData);
}

module.exports = { HistoryProcessTransport, createHistoryProcessTransport };
