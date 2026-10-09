/**
 * Runtime counts and independent attention signals of a workflow.
 *
 * Green counts idle live processes. Orange counts own turn/send/paste work;
 * purple counts waiting for a
 * linked executor. Own work wins over inherited work on ONE tab, like TabCard,
 * but never suppresses another tab's purple count on the same workflow.
 *
 * awaitingCount и completionNotificationCount раньше агрегировались на
 * project-chip. Но проект — владелец вкладок, а workflow — видимое место,
 * куда пользователь должен перейти, чтобы ответить/прочитать результат.
 */
export function resolveWorkflowActivityCounts(entries) {
  const seen = new Set();
  let activeCount = 0;
  let busyCount = 0;
  let inheritedBusyCount = 0;
  let awaitingCount = 0;
  let completionNotificationCount = 0;
  let nonblockingQuestionCount = 0;
  (Array.isArray(entries) ? entries : []).forEach((entry) => {
    const tabId = typeof entry?.tabId === 'string' ? entry.tabId : '';
    if (!tabId || seen.has(tabId)) return;
    seen.add(tabId);
    const ownBusy = entry.busy === true || entry.pasteBusy === true || entry.sendPending === true;
    const inheritedBusy = entry.inheritedBusy === true && !ownBusy;
    if ((entry.processAlive === true || entry.sdkAlive === true) && !ownBusy && !inheritedBusy) activeCount += 1;
    if (ownBusy) busyCount += 1;
    if (inheritedBusy) inheritedBusyCount += 1;
    if (entry.awaiting === true) awaitingCount += 1;
    if (entry.nonblockingQuestion === true) nonblockingQuestionCount += 1;
    if (entry.completionNotificationFired === true) completionNotificationCount += 1;
  });
  return { activeCount, busyCount, awaitingCount, completionNotificationCount,
    ...(inheritedBusyCount ? { inheritedBusyCount } : {}),
    ...(nonblockingQuestionCount ? { nonblockingQuestionCount } : {}) };
}
