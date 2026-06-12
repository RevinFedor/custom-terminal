import { useWorkspaceStore } from '../store/useWorkspaceStore';

let installed = false;

function shortId(value: string | null | undefined): string {
  return value ? value.slice(-12) : 'none';
}

function getContext(): string {
  try {
    const state = useWorkspaceStore.getState();
    const activeProjectId = state.activeProjectId;
    const workspace = activeProjectId ? state.openProjects.get(activeProjectId) : undefined;
    let totalTabs = 0;
    state.openProjects.forEach((ws) => { totalTabs += ws.tabs.size; });
    return (
      'appView=' + state.view +
      ' project=' + shortId(activeProjectId) +
      ' projectView=' + (workspace?.currentView || 'none') +
      ' activeTab=' + shortId(workspace?.activeTabId) +
      ' tabs=' + (workspace?.tabs.size || 0) +
      ' totalTabs=' + totalTabs +
      ' visibility=' + document.visibilityState +
      ' focus=' + (document.hasFocus() ? '1' : '0')
    );
  } catch {
    return 'appView=unknown project=unknown projectView=unknown activeTab=unknown tabs=0 totalTabs=0';
  }
}

function absNow(): number {
  return performance.timeOrigin + performance.now();
}

function cssPath(target: EventTarget | Element | null): string {
  if (!target) return 'null';
  if (!(target instanceof Element)) {
    if (target === window) return 'window';
    if (target === document) return 'document';
    return String(target).slice(0, 80);
  }
  const id = target.id ? '#' + target.id : '';
  const classes = Array.from(target.classList || [])
    .slice(0, 4)
    .map((name) => '.' + name)
    .join('');
  return (target.tagName.toLowerCase() + id + classes).slice(0, 140);
}

function log(message: string) {
  console.warn(message + ' ' + getContext());
}

export function installPerfFreezeProbe() {
  if (installed) return;
  installed = true;

  if (!import.meta.env.DEV || typeof window === 'undefined') return;

  const supported = PerformanceObserver.supportedEntryTypes || [];
  log(
    '[Perf:Probe] installed longtask=' + (supported.includes('longtask') ? '1' : '0') +
    ' event=' + (supported.includes('event') ? '1' : '0')
  );

  let lastRaf = performance.now();
  let lastRafLogAt = 0;
  const rafProbe = (now: number) => {
    const gapMs = now - lastRaf;
    if (
      document.visibilityState === 'visible' &&
      gapMs > 120 &&
      (now - lastRafLogAt > 500 || gapMs > 500)
    ) {
      lastRafLogAt = now;
      log(
        '[Perf:EventLoopLag] source=raf' +
        ' prevFrameAbs=' + (performance.timeOrigin + lastRaf).toFixed(1) +
        ' frameAbs=' + (performance.timeOrigin + now).toFixed(1) +
        ' gapMs=' + gapMs.toFixed(1)
      );
    }
    lastRaf = now;
    window.requestAnimationFrame(rafProbe);
  };
  window.requestAnimationFrame(rafProbe);

  const timerIntervalMs = 250;
  let lastTimer = performance.now();
  let lastTimerLogAt = 0;
  const timerId = window.setInterval(() => {
    const now = performance.now();
    const driftMs = now - lastTimer - timerIntervalMs;
    if (
      document.visibilityState === 'visible' &&
      driftMs > 150 &&
      (now - lastTimerLogAt > 500 || driftMs > 500)
    ) {
      lastTimerLogAt = now;
      log(
        '[Perf:EventLoopLag] source=timer' +
        ' expectedAbs=' + (performance.timeOrigin + lastTimer + timerIntervalMs).toFixed(1) +
        ' firedAbs=' + (performance.timeOrigin + now).toFixed(1) +
        ' intervalMs=' + timerIntervalMs +
        ' driftMs=' + driftMs.toFixed(1)
      );
    }
    lastTimer = now;
  }, timerIntervalMs);
  if (typeof timerId === 'number') {
    // Window timers do not expose unref; branch kept for Electron typings parity.
  }

  if (supported.includes('longtask')) {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as any[]) {
          if (entry.duration < 75) continue;
          const attribution = Array.isArray(entry.attribution)
            ? entry.attribution.map((a: any) => a?.name || a?.containerType || 'unknown').join(',')
            : '';
          log(
            '[Perf:LongTask] startMs=' + entry.startTime.toFixed(1) +
            ' startAbs=' + (performance.timeOrigin + entry.startTime).toFixed(1) +
            ' endAbs=' + (performance.timeOrigin + entry.startTime + entry.duration).toFixed(1) +
            ' durationMs=' + entry.duration.toFixed(1) +
            ' name=' + (entry.name || 'unknown') +
            (attribution ? ' attribution=' + attribution.slice(0, 120) : '')
          );
        }
      });
      observer.observe({ type: 'longtask', buffered: true } as PerformanceObserverInit);
    } catch (err: any) {
      log('[Perf:Probe] longtask-observer-failed error=' + (err?.message || String(err)));
    }
  }

  if (supported.includes('event')) {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as any[]) {
          const name = String(entry.name || '');
          if (!/^(click|pointerdown|mousedown|keydown|keyup)$/.test(name)) continue;
          const inputDelay = typeof entry.processingStart === 'number'
            ? entry.processingStart - entry.startTime
            : NaN;
          const handlerMs = typeof entry.processingEnd === 'number' && typeof entry.processingStart === 'number'
            ? entry.processingEnd - entry.processingStart
            : NaN;
          const presentationDelay = typeof entry.processingEnd === 'number'
            ? entry.duration - (entry.processingEnd - entry.startTime)
            : NaN;
          log(
            '[Perf:EventTiming] event=' + name +
            ' interactionId=' + (entry.interactionId || 0) +
            ' startAbs=' + (performance.timeOrigin + entry.startTime).toFixed(1) +
            ' processingStartAbs=' + (typeof entry.processingStart === 'number' ? (performance.timeOrigin + entry.processingStart).toFixed(1) : 'na') +
            ' processingEndAbs=' + (typeof entry.processingEnd === 'number' ? (performance.timeOrigin + entry.processingEnd).toFixed(1) : 'na') +
            ' durationMs=' + Number(entry.duration || 0).toFixed(1) +
            ' inputDelayMs=' + (Number.isFinite(inputDelay) ? inputDelay.toFixed(1) : 'na') +
            ' handlerMs=' + (Number.isFinite(handlerMs) ? handlerMs.toFixed(1) : 'na') +
            ' presentationDelayMs=' + (Number.isFinite(presentationDelay) ? presentationDelay.toFixed(1) : 'na') +
            ' target=' + cssPath(entry.target || null)
          );
        }
      });
      observer.observe({ type: 'event', buffered: true, durationThreshold: 32 } as PerformanceObserverInit);
    } catch (err: any) {
      log('[Perf:Probe] event-observer-failed error=' + (err?.message || String(err)));
    }
  }

  let lastPointerLogAt = 0;
  const captureInput = (event: Event) => {
    const pointer = event as PointerEvent | MouseEvent;
    const now = performance.now();
    if (event.type !== 'click' && event.type !== 'pointerdown' && event.type !== 'mousedown' && now - lastPointerLogAt < 250) return;
    lastPointerLogAt = now;
    const eventTimeAbs = performance.timeOrigin + event.timeStamp;
    const receivedAbs = absNow();
    const atPoint = 'clientX' in pointer
      ? document.elementFromPoint(pointer.clientX, pointer.clientY)
      : null;
    const hoverStack = Array.from(document.querySelectorAll(':hover'))
      .slice(-5)
      .map(cssPath)
      .join('>');
    log(
      '[Perf:Input] event=' + event.type +
      ' eventTimeAbs=' + eventTimeAbs.toFixed(1) +
      ' receivedAbs=' + receivedAbs.toFixed(1) +
      ' inputDelayMs=' + (receivedAbs - eventTimeAbs).toFixed(1) +
      ' buttons=' + ('buttons' in pointer ? pointer.buttons : 'na') +
      ' isTrusted=' + (event.isTrusted ? '1' : '0') +
      ' target=' + cssPath(event.target) +
      ' atPoint=' + cssPath(atPoint) +
      ' hover=' + hoverStack
    );
  };

  window.addEventListener('click', captureInput, { capture: true, passive: true });
  window.addEventListener('pointerdown', captureInput, { capture: true, passive: true });
  window.addEventListener('mousedown', captureInput, { capture: true, passive: true });
  window.addEventListener('mouseover', captureInput, { capture: true, passive: true });
}
