/** @returns {{ message: string, type: 'warning' | 'error', report: string }} */
export function storageCleanupIncident({ phase, result, items = [], generation, operationId = null }) {
  const stale = result?.error === 'storage_scan_stale';
  const message = stale
    ? `${result?.scope === 'selected-items' ? 'Selected storage items' : 'The storage list'} changed. Nothing was deleted. Review the refreshed list.`
    : result?.detail || result?.failures?.[0]?.detail || result?.error || 'Storage cleanup failed';
  const report = [
    'Noted Terminal storage incident',
    `Time (UTC): ${new Date().toISOString()}`,
    `Phase: ${phase}`,
    `Error: ${result?.error || 'storage_cleanup_failed'}`,
    `Message: ${message}`,
    `Operation ID: ${operationId || '-'}`,
    `Shown generation: ${generation || '-'}`,
    `Current generation: ${result?.currentGeneration || '-'}`,
    `Rejected scope: ${result?.scope || 'inventory'}`,
    `Selected items: ${items.length}`,
    ...items.slice(0, 32).map((item) => (
      `- ${item.title} | ${item.id} | session=${item.sessionId || '-'} | bytes=${item.sizeBytes} | ${item.path}`
    )),
    ...(items.length > 32 ? [`... ${items.length - 32} more selected items`] : []),
    `Changed items: ${JSON.stringify(result?.changedItems || [])}`,
    `Failures: ${JSON.stringify(result?.failures || [])}`,
  ].join('\n');
  return { message, type: stale ? 'warning' : 'error', report };
}
