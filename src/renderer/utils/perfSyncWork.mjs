import syncWork from '../../shared/perf-sync-work.cjs';

export const rendererSyncWork = syncWork.createSyncWorkRing({ role: 'renderer-main',
  sourceBoot: 'renderer-' + Math.floor(performance.timeOrigin).toString(36),
  now: () => performance.now(), timeOrigin: performance.timeOrigin });
export const runRendererSyncWork = (site, context, callback) => rendererSyncWork.run(site, context, callback);

// Reuse the existing tagged renderer logger. This pilot delivery is log
// admission, not a durable ACK; disk/transport loss cannot be called complete.
let lastReport = -Infinity, suppressed = 0;
export function reportRendererSyncWork(action, emit) {
  const at = performance.now();
  if (at - lastReport < 1000 || action?.kind === 'visible-commit') { suppressed++; return; }
  lastReport = at;
  const start = action.startAbs - performance.timeOrigin;
  if (!Number.isFinite(start)) return;
  const report = rendererSyncWork.snapshot({ from: start - 1000, to: at, limit: 32 });
  const envelope = { actionId: action.id, event: action.event, relationToAction: 'temporal-only',
    suppressed, delivery: 'existing-logger-no-durable-ack', ...report };
  // Rows are scalar; never retain an Event or inspect the user's document.
  const rows = envelope.rows; delete envelope.rows;
  for (let offset = 0; offset < rows.length || offset === 0; offset += 8) {
    const part = { ...envelope, offset, total: rows.length, rows: rows.slice(offset, offset + 8) };
    emit('[Perf:SyncWindow] ' + JSON.stringify(part));
  }
}
