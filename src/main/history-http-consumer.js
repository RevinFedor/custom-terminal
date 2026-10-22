'use strict';

// Transport lifetime only. Never a source epoch, input lease, delivery verdict,
// watch subscription or permission to cancel a shared reader/process.
const { createReadControl, currentReadControl, withReadControl,
  isHistoryReadCancelled } = require('./history-read-control');
const { parse: parseUrl } = require('node:url');

function isFiniteHistoryHttpRead(req) {
  // Match the router's pathname for origin-form and absolute-form HTTP targets.
  const pathname = parseUrl(String(req.url || '')).pathname || '';
  return req.method === 'GET'
    && /^\/api\/terminal-tabs\/[^/]+\/(history|timeline|history-payload)$/.test(pathname);
}

function assertHttpHistoryCurrent() { currentReadControl()?.assertCurrent(); }

function runHttpHistoryRead(req, res, operation) {
  if (!isFiniteHistoryHttpRead(req)) return operation();
  const owner = new AbortController();
  const control = createReadControl({ signal: owner.signal });
  const revoke = () => { if (!owner.signal.aborted) owner.abort('http-consumer-closed'); };
  const closed = () => { if (res.writableFinished !== true) revoke(); };
  // Install synchronously BEFORE invoking the handler (and its first await).
  req.once('aborted', revoke);
  res.once('close', closed);
  res.once('error', revoke);
  if (req.aborted || res.destroyed && !res.writableFinished) revoke();
  return withReadControl(control, async () => {
    try {
      control.assertCurrent();
      return await operation();
    } finally {
      req.removeListener('aborted', revoke);
      res.removeListener('close', closed);
      res.removeListener('error', revoke);
      control.finish();
    }
  });
}

// A terminal consumer error must escape compatibility fallback catches.
// Checking the control also handles a transport that closed while a different
// dependency was rejecting. No extra read is allowed after that close.
function rethrowHistoryTerminal(error) {
  // A downstream destroy commonly aborts the HTTP lease while propagating
  // an upstream failure. Preserve that failure's authority classification;
  // an UNKNOWN reader/source cannot become a proven consumer-only cancel.
  if (error?.code === 'HISTORY_READER_PROCESS_EXITED'
    || error?.code === 'HISTORY_READER_TRANSPORT_UNKNOWN'
    || error?.code === 'HISTORY_READER_FENCE_UNAVAILABLE'
    || error?.code === 'HISTORY_READ_IDENTITY_CHANGED'
    || error?.code === 'CODEX_SOURCE_READ_INVALIDATED') throw error;
  assertHttpHistoryCurrent();
  if (isHistoryReadCancelled(error)) throw error;
}

module.exports = { isFiniteHistoryHttpRead, assertHttpHistoryCurrent,
  runHttpHistoryRead, rethrowHistoryTerminal };
