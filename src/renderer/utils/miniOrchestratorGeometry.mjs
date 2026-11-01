// Presentation geometry only. The same pointer owner as Run After/Git owns
// gestures; no PTY, application admission or layout polling lives here.
const MARGIN = 8;
const clamp = (value, min, max) => Math.max(min, Math.min(value, Math.max(min, max)));
export function miniReviewTarget(tabId, source) {
  const id = source && Object.hasOwn(source, 'navigationRequestId') ? source.navigationRequestId : source?.requestIds?.[0];
  if (typeof tabId !== 'string' || !tabId || !source || !['claude', 'codex'].includes(source.provider)
    || typeof source.sessionId !== 'string' || !source.sessionId || typeof id !== 'string' || !id || id === source.turnId
    || !source.requestIds?.includes(id)) return null;
  return { tabId, provider: source.provider, sessionId: source.sessionId, messageId: id };
}
export async function navigateMiniReview(target, jump, onNavigated, onError) {
  if (!target) { onError(); return; }
  try { if (await jump(target) === true) onNavigated?.(); }
  catch { onError(); }
}
export function normalizeMiniPanelRecord(value) {
  const frame = value?.frame;
  if (!frame || !['left', 'top', 'width', 'height'].every(key => Number.isFinite(frame[key]))
    || frame.width <= 0 || frame.height <= 0 || typeof value.detached !== 'boolean') return null;
  // Bound persisted data independently of the current display; fit on read.
  return { frame: { left: clamp(frame.left, -32768, 32768), top: clamp(frame.top, -32768, 32768),
    width: clamp(frame.width, 1, 32768), height: clamp(frame.height, 1, 32768) }, detached: value.detached };
}
export function createMiniPanelPersistence(invoke) {
  const records = new Map(), edited = new Set();
  let hydration, writes = Promise.resolve(), hydrated = false, hydrationOverflow = false;
  const remember = (id, value) => {
    records.delete(id); records.set(id, value);
    while (records.size > 60) records.delete(records.keys().next().value);
  };
  const hydrate = () => hydration ||= Promise.resolve().then(() => invoke('app:getState', 'miniOrchestratorPanelFrames')).then(value => {
    if (Array.isArray(value) && !hydrationOverflow) {
      // Old saved records precede newer local edits in the bounded LRU.
      const local = [...records]; records.clear();
      for (const pair of value.slice(-60)) {
        if (!Array.isArray(pair) || typeof pair[0] !== 'string' || !pair[0] || pair[0].length > 256 || edited.has(pair[0])) continue;
        const record = normalizeMiniPanelRecord(pair[1]);
        if (record) remember(pair[0], record);
      }
      for (const [id, record] of local) remember(id, record);
    }
    hydrated = true; edited.clear();
  }).catch(error => { hydration = null; throw error; });
  return {
    async read(id) { try { await hydrate(); } catch (error) { console.warn('[MiniOrchestrator] geometry load failed', error); } return records.get(id) || null; },
    write(id, value) {
      const record = normalizeMiniPanelRecord(value);
      if (!record || typeof id !== 'string' || !id || id.length > 256) return;
      if (!hydrated && !hydrationOverflow) {
        edited.add(id);
        if (edited.size >= 60) { hydrationOverflow = true; edited.clear(); }
      }
      remember(id, record);
      // Wait for the first load so saving one tab cannot erase the other tabs.
      writes = writes.then(hydrate).then(() => invoke('app:setState', { key: 'miniOrchestratorPanelFrames', value: [...records], reason: 'panel-geometry', source: 'MiniOrchestrator' }))
        .then(result => { if (result?.success !== true) console.warn('[MiniOrchestrator] geometry save unconfirmed'); })
        .catch(error => console.warn('[MiniOrchestrator] geometry save failed', error));
      return writes;
    },
  };
}
export function fitMiniPanel(rect, viewport) {
  const width = clamp(rect.width, 0, Math.max(0, viewport.width - MARGIN * 2));
  const height = clamp(rect.height, 0, Math.max(0, viewport.height - MARGIN * 2));
  return { left: clamp(rect.left, MARGIN, viewport.width - width - MARGIN),
    top: clamp(rect.top, MARGIN, viewport.height - height - MARGIN), width, height };
}
export function resizeMiniPanel(rect, edge, dx, dy, viewport) {
  const right = rect.left + rect.width;
  const width = edge === 'left' || edge === 'left-bottom'
    ? clamp(rect.width - dx, Math.min(280, rect.width, Math.max(0, right - MARGIN)), Math.max(0, right - MARGIN)) : rect.width;
  const height = edge === 'bottom' || edge === 'left-bottom'
    ? clamp(rect.height + dy, Math.min(160, rect.height, Math.max(0, viewport.height - rect.top - MARGIN)), Math.max(0, viewport.height - rect.top - MARGIN)) : rect.height;
  return { left: right - width, top: rect.top, width, height };
}
export function moveMiniPanel(rect, dx, dy, viewport) {
  return fitMiniPanel({ ...rect, left: rect.left + dx, top: rect.top + dy }, viewport);
}
