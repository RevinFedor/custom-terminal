// Operation boundaries and bounded source progress enter this store. It never inspects History DOM,
// resource measurements, transcript bodies or provider busy state.
export function createHistoryPreparationStatus(ipc) {
  let main = { epoch: null, revision: -1, operations: [] };
  let prewarm = 0;
  let visit = 0;
  let snapshot = Object.freeze({ active: false, prewarm: false, operations: [] });
  let activitySnapshot = snapshot;
  const listeners = new Set();
  const publish = () => {
    const active = prewarm > 0 || main.operations.length > 0;
    if (snapshot.active === active && snapshot.prewarm === (prewarm > 0)
      && snapshot.operations === main.operations) return;
    snapshot = Object.freeze({ active, prewarm: prewarm > 0, operations: main.operations });
    // The resource chip only needs start/end and owner metadata. Byte ticks
    // must not render its open process table four times per second.
    if (activitySnapshot.active !== active || activitySnapshot.prewarm !== snapshot.prewarm
      || activitySnapshot.operations.length !== main.operations.length
      || activitySnapshot.operations.some((operation, index) => operation.id !== main.operations[index].id)) {
      activitySnapshot = snapshot;
    }
    for (const listener of listeners) listener();
  };
  const apply = payload => {
    if (!payload || typeof payload.epoch !== 'string' || !Number.isInteger(payload.revision)
      || !Array.isArray(payload.operations)) return;
    if (main.epoch === payload.epoch && main.revision >= payload.revision) return;
    main = payload;
    publish();
  };
  const onChange = (_event, payload) => apply(payload);
  return {
    getSnapshot: () => snapshot,
    getActivitySnapshot: () => activitySnapshot,
    setPrewarm(remaining) {
      prewarm = Math.max(0, Number(remaining) || 0);
      publish();
    },
    subscribe(listener) {
      if (!listeners.size) {
        const currentVisit = ++visit;
        ipc.on('history-preparation:changed', onChange);
        // Subscribe before snapshot. Revision ordering rejects an older reply
        // arriving after an operation finished while IPC was in flight.
        Promise.resolve(ipc.invoke('history-preparation:subscribe'))
          .then(payload => { if (visit === currentVisit && listeners.size) apply(payload); })
          .catch(() => {});
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          visit++;
          ipc.removeListener('history-preparation:changed', onChange);
          void ipc.invoke('history-preparation:unsubscribe').catch(() => {});
        }
      };
    },
  };
}

let singleton;
export function historyPreparationStatus() {
  singleton ||= createHistoryPreparationStatus(window.require('electron').ipcRenderer);
  return singleton;
}

// A session may be projected on behalf of another tab or client. The progress
// belongs to the exact source, independent from focus and the initiating tab.
export function selectHistoryPreparation(status, { toolType, sessionId, cwd }) {
  if (!sessionId) return null;
  return status.operations.find(operation => operation.kind === 'history'
    && operation.sessionId === sessionId && operation.source?.toolType === toolType
    && operation.source.cwd === (cwd || '')) || null;
}

export function historyPreparationLabel(status, tabNames = new Map()) {
  if (!status.active) return 'Потребление ресурсов: вкладки, их инструменты и само приложение';
  if (status.prewarm || status.operations.length !== 1) return 'Подготовка историй';
  const operation = status.operations[0];
  const name = tabNames.get(operation.tabId)?.title || tabNames.get(operation.tabId);
  return 'Загрузка истории' + (typeof name === 'string' && name ? ': ' + name : '');
}
