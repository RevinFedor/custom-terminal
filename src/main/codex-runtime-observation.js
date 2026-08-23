'use strict';

async function resolveCodexWriterInspection({
  projectedInspection = null,
  forceWriterReconcile = false,
  reconcile,
} = {}) {
  if (forceWriterReconcile !== true && projectedInspection) {
    return { inspection: projectedInspection, source: 'event-projection' };
  }
  try {
    const inspection = typeof reconcile === 'function'
      ? await reconcile()
      : { status: 'unknown', error: 'writer-reconcile-unavailable' };
    return { inspection, source: 'fresh-reconcile' };
  } catch (error) {
    return {
      inspection: { status: 'unknown', error: error?.message || String(error) },
      source: 'fresh-reconcile-error',
    };
  }
}

module.exports = { resolveCodexWriterInspection };
