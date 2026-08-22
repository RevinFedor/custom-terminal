/**
 * Два независимых числа workflow.
 *
 * activeCount отвечает «сколько вкладок держат живой процесс» и рисуется
 * зелёным. busyCount отвечает «сколько вкладок прямо сейчас показывают loader»
 * (turn / paste / inherited orchestration) и рисуется отдельным оранжевым
 * badge с ring. Один tab может участвовать в обоих числах — это два вопроса,
 * не части одного total.
 */
export function resolveWorkflowActivityCounts(entries) {
  const seen = new Set();
  let activeCount = 0;
  let busyCount = 0;
  (Array.isArray(entries) ? entries : []).forEach((entry) => {
    const tabId = typeof entry?.tabId === 'string' ? entry.tabId : '';
    if (!tabId || seen.has(tabId)) return;
    seen.add(tabId);
    if (entry.processAlive === true || entry.sdkAlive === true) activeCount += 1;
    if (entry.busy === true || entry.pasteBusy === true || entry.inheritedBusy === true) busyCount += 1;
  });
  return { activeCount, busyCount };
}
