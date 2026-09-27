// Observe only this History scroller. Native behavior, return values and
// exceptions are preserved; no geometry is read and no position is written.
export function installHistoryScrollWriterDiagnostics(scroller, {
  context, log, now = () => performance.timeOrigin + performance.now(),
  schedule = callback => setTimeout(callback, 0), cancel = clearTimeout,
  maxPerGesture = 8, maxPending = 24,
}) {
  let disposed = false, pending = [], task = null, activeKey = '', count = 0;
  const undo = [];
  const flush = () => {
    task = null;
    const batch = pending; pending = [];
    if (disposed) return;
    const flushAbs = now();
    for (const record of batch) { try { log({ ...record, flushAbs, logLagMs: Math.max(0, flushAbs - record.calledAbs) }); } catch {} }
  };
  const ownNumber = (object, key) => {
    const value = Object.getOwnPropertyDescriptor(object, key)?.value;
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  };
  const observe = (method, args) => {
    try {
      if (disposed) return;
      if (pending.length >= maxPending) {
        if (pending.length) pending[pending.length - 1].queueLimitReached = true;
        return;
      }
      const owner = context();
      if (!owner) return;
      const key = [owner.owner, owner.generation, owner.visit, owner.gid].join(':');
      if (key !== activeKey) { activeKey = key; count = 0; }
      if (count >= maxPerGesture) return;
      count++;
      let x = null, y = null, behavior = null;
      if (method === 'scrollTop=') y = typeof args[0] === 'number' ? args[0] : null;
      else if (args[0] && typeof args[0] === 'object') {
        x = ownNumber(args[0], 'left'); y = ownNumber(args[0], 'top');
        const value = Object.getOwnPropertyDescriptor(args[0], 'behavior')?.value;
        if (['auto', 'instant', 'smooth'].includes(value)) behavior = value;
      } else { x = typeof args[0] === 'number' ? args[0] : null; y = typeof args[1] === 'number' ? args[1] : null; }
      pending.push({ ...owner, method, x, y, behavior, limitReached: count >= maxPerGesture, calledAbs: now(),
        stack: String(new Error().stack || '').split('\n').slice(2, 11).join('\n').slice(0, 1800) });
      if (task === null) task = schedule(flush);
    } catch {} // An unavailable diagnostic must not affect a scroll operation.
  };
  for (const method of ['scrollTo', 'scrollBy']) {
    const originalOwn = Object.getOwnPropertyDescriptor(scroller, method);
    if (originalOwn && !('value' in originalOwn)) continue;
    const original = scroller[method];
    if (typeof original !== 'function' || originalOwn?.configurable === false) continue;
    const wrapped = function(...args) { if (this === scroller) observe(method, args); return Reflect.apply(original, this, args); };
    try {
      Object.defineProperty(scroller, method, { configurable: true, writable: originalOwn?.writable ?? true,
        enumerable: originalOwn?.enumerable ?? false, value: wrapped });
      undo.push(() => {
        if (Object.getOwnPropertyDescriptor(scroller, method)?.value !== wrapped) return;
        if (originalOwn) Object.defineProperty(scroller, method, originalOwn); else delete scroller[method];
      });
    } catch {}
  }
  const originalOwn = Object.getOwnPropertyDescriptor(scroller, 'scrollTop');
  let prototype = scroller, descriptor;
  while (prototype && !descriptor) { descriptor = Object.getOwnPropertyDescriptor(prototype, 'scrollTop'); prototype = Object.getPrototypeOf(prototype); }
  if (descriptor?.get && descriptor?.set && originalOwn?.configurable !== false) {
    const get = function() { return descriptor.get.call(this); };
    const set = function(value) { if (this === scroller) observe('scrollTop=', [value]); return descriptor.set.call(this, value); };
    try {
      Object.defineProperty(scroller, 'scrollTop', { configurable: true, enumerable: descriptor.enumerable, get, set });
      undo.push(() => {
        const current = Object.getOwnPropertyDescriptor(scroller, 'scrollTop');
        if (current?.get !== get || current?.set !== set) return;
        if (originalOwn) Object.defineProperty(scroller, 'scrollTop', originalOwn); else delete scroller.scrollTop;
      });
    } catch {}
  }
  return () => {
    if (disposed) return;
    if (task !== null) cancel(task);
    flush(); disposed = true;
    pending = []; task = null;
    for (const restore of undo.reverse()) restore();
  };
}
