import { useWorkspaceStore } from '../store/useWorkspaceStore';
import { attributeFreeze, recentRendererActivities, markRendererActivity } from './rendererActivityTrail';
import { reportPerfIncident, setPerfIncidentWriter, sendPerfHeartbeat, createPerfSocketWriter } from './perfIncidentChannel';
import { getInteractionCursor } from './interactionCursor';
import { rendererSyncWork, reportRendererSyncWork } from './perfSyncWork.mjs';
import { installUIActionDiagnostics, captureUIAction, recordUIFrame, recordUIEventTiming, uiDragInput,
  summarizeUIAction, formatDiagnosticKey, createUIClipboardOutcomeQueue, createUIFrameScheduler } from './uiPerformanceDiagnostics.mjs';

let installed = false;

function onFinalPageHide(dispose: () => void): void {
  // beforeunload can be cancelled; a persisted pagehide can resume from bfcache.
  window.addEventListener('pagehide', (event: PageTransitionEvent) => {
    if (!event.persisted) dispose();
  });
}

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

// Freeze attribution lives in its own dependency-free module so hot paths can
// leave a mark without importing this probe (and, through it, the stores).
export { markRendererActivity } from './rendererActivityTrail';

/**
 * Names the work that arrives from main.
 *
 * 63 long tasks totalling 7.7s in one 2-hour boot reported
 * `during=none-marked recent=none`: nothing in the app claimed them, and the
 * platform reports `attribution=unknown` for all same-origin script work. The
 * renderer has 241 separate `ipcRenderer.on` registrations and no shared
 * dispatcher, so marking them one by one is neither reviewable nor complete.
 *
 * Instead this wraps the ONE place every listener goes through — the emitter
 * on ipcRenderer — so each delivered channel leaves a mark named after the
 * channel. It changes nothing about delivery: the original listener is called
 * with the original arguments, its return value is passed through, and a
 * throwing listener still throws after the mark is closed.
 *
 * Sampling: cheap channels fire thousands of times per minute and the trail
 * only holds 80 entries, so a mark is opened only when the previous delivery
 * of that channel was slow enough to matter, or periodically. Otherwise a
 * flood of 0.1ms deliveries would evict the very activity a freeze needs
 * named.
 */
export function installIpcDeliveryAttribution(log: (line: string) => void): void {
  let ipc: any = null;
  try { ipc = (window as any).require?.('electron')?.ipcRenderer; } catch { return; }
  if (!ipc || typeof ipc.on !== 'function' || (ipc as any).__notedIpcAttribution) return;

  const MARK_THRESHOLD_MS = 8;
  const RESAMPLE_EVERY = 64;
  const stats = new Map<string, { slowUntil: number; seen: number; worstMs: number }>();
  const wrapped = new WeakMap<Function, Function>();

  // ipcRenderer is a plain EventEmitter: a listener that throws stops every
  // later listener of the same event. One faulty subscriber therefore starved
  // History of `agent-transcript:changed` / `live-message` in production
  // (01.11: 141 main events, zero History refreshes), and nothing was logged
  // because the renderer had no error forwarding. Isolate and report instead.
  const errorCounts = new Map<string, number>();
  const callIsolated = (channel: string, listener: Function, self: unknown, args: unknown[]) => {
    try {
      return listener.apply(self, args);
    } catch (error: any) {
      const key = channel + '|' + String(error?.message || error).slice(0, 160);
      const count = (errorCounts.get(key) || 0) + 1;
      errorCounts.set(key, count);
      if (count <= 3 || count % 100 === 0) {
        log('[IpcListenerError] channel=' + channel + ' count=' + count
          + ' listener=' + (listener.name || 'anonymous')
          + ' error=' + String(error?.message || error).slice(0, 300)
          + ' stack=' + String(error?.stack || '').split('\n').slice(1, 4).join(' | ').slice(0, 400));
      }
      return undefined;
    }
  };

  const instrument = (channel: string, listener: Function): Function => {
    const existing = wrapped.get(listener);
    if (existing) return existing;
    const instrumented = function (this: unknown, ...args: unknown[]) {
      let stat = stats.get(channel);
      if (!stat) { stat = { slowUntil: 1, seen: 0, worstMs: 0 }; stats.set(channel, stat); }
      stat.seen++;
      // Mark while this channel is known-slow, and re-sample periodically so a
      // channel that becomes slow later is not silently trusted forever.
      const shouldMark = stat.seen <= stat.slowUntil || stat.seen % RESAMPLE_EVERY === 0;
      if (!shouldMark) return callIsolated(channel, listener, this, args);
      const startedAt = performance.now();
      // Diagnostics must never break delivery: 01.11 an unbound name here threw
      // on every marked event and starved every later subscriber (History).
      let endMark: () => void = () => {};
      try { endMark = markRendererActivity('ipc:' + channel); } catch { /* attribution only */ }
      try {
        return callIsolated(channel, listener, this, args);
      } finally {
        try { endMark(); } catch { /* attribution only */ }
        const elapsedMs = performance.now() - startedAt;
        // Keep marking a channel that just cost real time; a cheap one drops
        // back to periodic sampling.
        if (elapsedMs >= MARK_THRESHOLD_MS) stat.slowUntil = stat.seen + 16;
        if (elapsedMs > stat.worstMs) {
          stat.worstMs = elapsedMs;
          if (elapsedMs >= 50) {
            log('[Perf:IpcDelivery] channel=' + channel +
              ' handlerMs=' + elapsedMs.toFixed(1) +
              ' deliveries=' + stat.seen + ' ' + getContext());
          }
        }
      }
    };
    wrapped.set(listener, instrumented);
    return instrumented;
  };

  for (const method of ['on', 'once', 'addListener', 'prependListener', 'prependOnceListener'] as const) {
    const original = ipc[method];
    if (typeof original !== 'function') continue;
    ipc[method] = function (this: unknown, channel: string, listener: Function, ...rest: unknown[]) {
      if (typeof listener !== 'function') return original.call(this, channel, listener, ...rest);
      return original.call(this, channel, instrument(channel, listener), ...rest);
    };
  }
  // Removal must find the SAME wrapper that was registered, otherwise a
  // component unmount would leave its listener attached forever.
  for (const method of ['off', 'removeListener'] as const) {
    const original = ipc[method];
    if (typeof original !== 'function') continue;
    ipc[method] = function (this: unknown, channel: string, listener: Function, ...rest: unknown[]) {
      const instrumented = typeof listener === 'function' ? wrapped.get(listener) : null;
      return original.call(this, channel, instrumented || listener, ...rest);
    };
  }
  Object.defineProperty(ipc, '__notedIpcAttribution', { value: true, configurable: true });
  log('[Perf:Probe] ipcDeliveryAttribution=1 thresholdMs=' + MARK_THRESHOLD_MS + ' resampleEvery=' + RESAMPLE_EVERY);
}

type LoopSample = {
  abs: number;
  gapMs: number;
};

function pushLoopSample(samples: LoopSample[], sample: LoopSample) {
  samples.push(sample);
  if (samples.length > 80) samples.shift();
}

function lastSampleBefore(samples: LoopSample[], abs: number): LoopSample | null {
  for (let i = samples.length - 1; i >= 0; i--) {
    if (samples[i].abs <= abs) return samples[i];
  }
  return null;
}

function firstSampleAfter(samples: LoopSample[], abs: number): LoopSample | null {
  for (const sample of samples) {
    if (sample.abs >= abs) return sample;
  }
  return null;
}

function lastLoopSample(samples: LoopSample[]): LoopSample | null {
  return samples.length > 0 ? samples[samples.length - 1] : null;
}

function formatRecentSamples(samples: LoopSample[], receivedAbs: number): string {
  return samples
    .slice(-10)
    .map((sample) => (sample.abs - receivedAbs).toFixed(0) + ':' + sample.gapMs.toFixed(0))
    .join(',');
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

function freezeSeverity(ms: number): string {
  if (ms >= 2000) return 'critical';
  if (ms >= 1000) return 'major';
  if (ms >= 500) return 'noticeable';
  return 'minor';
}

// ── External watchdog heartbeat ──────────────────────────────────────────────
// Connects DIRECTLY to the perf-watchdog unix socket (not via main IPC — if it
// were routed through main, a frozen main would fake a renderer stall). While
// the renderer event loop is healthy, a JSON heartbeat goes out every 250ms;
// when the loop freezes, heartbeats stop and the watchdog samples THIS process
// during the stall. `vis` rides along so the watchdog ignores silence from
// hidden windows (background timer throttling is not a freeze).
export function installWatchdogHeartbeat() {
  try {
    const electronRequire = (window as any).require;
    if (!electronRequire) return;
    const { ipcRenderer } = electronRequire('electron');
    const net = electronRequire('net');
    const proc = electronRequire('process');
    let sock: any = null;
    let timer: number | null = null;
    let reconnectTimer: number | null = null;
    let stopped = false;
    const teardownSock = () => {
      setPerfIncidentWriter(null);
      if (timer !== null) { window.clearInterval(timer); timer = null; }
      if (sock) {
        // Listeners off before destroy so close cannot schedule a reconnect.
        try { sock.removeAllListeners(); sock.destroy(); } catch {}
        sock = null;
      }
    };
    // Own the lifetime before requesting transport metadata: a late ACK must
    // not create a connection for a document that has already departed.
    onFinalPageHide(() => {
      stopped = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      teardownSock();
    });
    ipcRenderer.invoke('perf:watchdog-info').then((info: { socketPath?: string | null }) => {
      if (stopped) return;
      const socketPath = info?.socketPath;
      if (!socketPath) {
        log('[Perf:Probe] watchdog-heartbeat disabled (no socket)');
        return;
      }
      let retryDelayMs = 1000;
      let reconnectPending = false;
      const scheduleReconnect = () => {
        if (stopped || reconnectPending) return;
        reconnectPending = true;
        teardownSock();
        // Watchdog may restart with main; bounded backoff keeps us quiet if it's gone.
        reconnectTimer = window.setTimeout(() => {
          reconnectTimer = null; reconnectPending = false; connect();
        }, retryDelayMs);
        retryDelayMs = Math.min(retryDelayMs * 2, 30000);
      };
      const connect = () => {
        if (stopped) return;
        teardownSock();
        try {
          sock = net.createConnection(socketPath);
        } catch (e: any) {
          log('[Perf:Probe] watchdog-connect-failed error=' + (e?.message || String(e)));
          scheduleReconnect();
          return;
        }
        const connection = sock;
        sock.on('connect', () => {
          if (stopped || sock !== connection) return;
          retryDelayMs = 1000;
          setPerfIncidentWriter(createPerfSocketWriter(connection, proc.pid));
          timer = window.setInterval(() => {
            sendPerfHeartbeat({ abs: absNow(), vis: document.visibilityState,
              focused: document.hasFocus(), context: getContext() });
          }, 250);
        });
        sock.on('error', scheduleReconnect);
        sock.on('close', scheduleReconnect);
      };
      connect();
      log('[Perf:Probe] watchdog-heartbeat armed sock=' + socketPath);
    }).catch((e: any) => {
      log('[Perf:Probe] watchdog-info-failed error=' + (e?.message || String(e)));
    });
  } catch (e: any) {
    log('[Perf:Probe] watchdog-heartbeat-init-failed error=' + (e?.message || String(e)));
  }
}

export function installPerfFreezeProbe() {
  if (installed) return;
  installed = true;

  if (typeof window === 'undefined') return;

  rendererSyncWork.configure({ enabled: true });
  onFinalPageHide(() => rendererSyncWork.configure({ enabled: false }));
  try {
    const p = (window as any).require?.('node:process');
    if (p?.env.NOTED_E2E_TEST === 'true' && p.env.NOTED_E2E_PERF_PILOT) {
      Object.defineProperty(window, '__notedSyncWorkPilot', { configurable: true, value: rendererSyncWork });
      onFinalPageHide(() => { delete (window as any).__notedSyncWorkPilot; });
    }
  } catch { /* no private test surface in a browser or ordinary production */ }

  installIpcDeliveryAttribution(log);

  const supported = PerformanceObserver.supportedEntryTypes || [];
  log(
    '[Perf:Probe] installed longtask=' + (supported.includes('longtask') ? '1' : '0') +
    ' event=' + (supported.includes('event') ? '1' : '0') +
    ' dev=' + (import.meta.env.DEV ? '1' : '0')
  );

  installWatchdogHeartbeat();
  let diagnosticIpc: any = null;
  try { diagnosticIpc = (window as any).require?.('electron')?.ipcRenderer; } catch {}
  let frameScheduler: ReturnType<typeof createUIFrameScheduler> | null = null;
  const uiActions = installUIActionDiagnostics({ emit: log, onPendingFrame: () => frameScheduler?.wake(), notify: (action: any) => {
    try { diagnosticIpc?.send('perf:ui-summary', action); } catch {}
    try { reportRendererSyncWork(action, log); } catch {}
  } });
  log('[Perf:Probe] actionSchema=2 targetSnapshot=1 safeKeyClass=1 stylesheetIdentity=1 nativeCounters=' + Number(!!diagnosticIpc));

  // Read-only diagnostic control; no input synthesis or change of gesture semantics.
  (window as any).__notedDragDiagnostics = Object.freeze({configure: uiActions.drag.configure, health: uiActions.drag.health});
  const rafSamples: LoopSample[] = [];
  const timerSamples: LoopSample[] = [];

  let lastRaf: number | null = null;
  let lastRafLogAt = 0;
  const rafProbe = (now: number) => {
    const frameAbs = absNow();
    const gapMs = lastRaf === null ? 0 : frameAbs - lastRaf;
    recordUIFrame(performance.timeOrigin + now);
    pushLoopSample(rafSamples, { abs: frameAbs, gapMs });
    if (
      document.visibilityState === 'visible' &&
      gapMs > 120 &&
      (now - lastRafLogAt > 500 || gapMs > 500)
    ) {
      lastRafLogAt = now;
      log(
        '[Perf:EventLoopLag] source=raf' +
        ' prevFrameAbs=' + lastRaf!.toFixed(1) +
        ' frameAbs=' + frameAbs.toFixed(1) +
        ' gapMs=' + gapMs.toFixed(1)
      );
      if (gapMs >= 500) {
        log(
          '[Perf:FreezeSummary] layer=renderer' +
          ' kind=rafGap' +
          ' severity=' + freezeSeverity(gapMs) +
          ' prevFrameAbs=' + lastRaf!.toFixed(1) +
          ' frameAbs=' + frameAbs.toFixed(1) +
          ' gapMs=' + gapMs.toFixed(1)
        );
      }
    }
    lastRaf = frameAbs;
  };
  frameScheduler = createUIFrameScheduler({
    request: (callback: FrameRequestCallback) => window.requestAnimationFrame(callback),
    cancel: (id: number) => window.cancelAnimationFrame(id),
    hasPending: () => uiActions.pending() || uiActions.drag.pending(), onFrame: rafProbe,
    // There is no pre-event continuous frame evidence across intentional idle.
    onIdle: () => { lastRaf = null; rafSamples.length = 0; },
  });
  onFinalPageHide(() => { uiActions.drag.dispose(); frameScheduler?.dispose(); });

  const timerIntervalMs = 250;
  let lastTimer = performance.now();
  let lastTimerLogAt = 0;
  const timerId = window.setInterval(() => {
    const now = performance.now();
    const driftMs = now - lastTimer - timerIntervalMs;
    const firedAbs = performance.timeOrigin + now;
    pushLoopSample(timerSamples, { abs: firedAbs, gapMs: Math.max(0, driftMs) });
    if (
      document.visibilityState === 'visible' &&
      driftMs > 150 &&
      (now - lastTimerLogAt > 500 || driftMs > 500)
    ) {
      lastTimerLogAt = now;
      log(
        '[Perf:EventLoopLag] source=timer' +
        ' expectedAbs=' + (performance.timeOrigin + lastTimer + timerIntervalMs).toFixed(1) +
        ' firedAbs=' + firedAbs.toFixed(1) +
        ' intervalMs=' + timerIntervalMs +
        ' driftMs=' + driftMs.toFixed(1)
      );
      if (driftMs >= 500) {
        log(
          '[Perf:FreezeSummary] layer=renderer' +
          ' kind=timerDrift' +
          ' severity=' + freezeSeverity(driftMs) +
          ' expectedAbs=' + (performance.timeOrigin + lastTimer + timerIntervalMs).toFixed(1) +
          ' firedAbs=' + firedAbs.toFixed(1) +
          ' intervalMs=' + timerIntervalMs +
          ' driftMs=' + driftMs.toFixed(1)
        );
      }
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
          const taskStartAbs = performance.timeOrigin + entry.startTime;
          const taskEndAbs = taskStartAbs + entry.duration;
          if (document.visibilityState === 'visible') reportPerfIncident('long-task', taskStartAbs, entry.duration);
          // The platform's attribution is always "self"/unknown for same-origin
          // work; `during=` is ours and names the app activity that overlapped.
          const during = attributeFreeze(taskStartAbs, taskEndAbs);
          const recent = during === 'none-marked'
            ? recentRendererActivities(taskStartAbs)
            : '';
          log(
            '[Perf:LongTask] startMs=' + entry.startTime.toFixed(1) +
            ' startAbs=' + taskStartAbs.toFixed(1) +
            ' endAbs=' + taskEndAbs.toFixed(1) +
            ' durationMs=' + entry.duration.toFixed(1) +
            ' name=' + (entry.name || 'unknown') +
            ' during=' + during +
            (recent ? ' recent=' + recent : '') +
            (attribution ? ' attribution=' + attribution.slice(0, 120) : '')
          );
          if (entry.duration >= 500) {
            log(
              '[Perf:FreezeSummary] layer=renderer' +
              ' kind=longTask' +
              ' severity=' + freezeSeverity(entry.duration) +
              ' startAbs=' + taskStartAbs.toFixed(1) +
              ' endAbs=' + taskEndAbs.toFixed(1) +
              ' durationMs=' + entry.duration.toFixed(1) +
              ' name=' + (entry.name || 'unknown') +
              ' during=' + during +
              (recent ? ' recent=' + recent : '') +
              (attribution ? ' attribution=' + attribution.slice(0, 120) : '')
            );
          }
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
          const capturedAction = recordUIEventTiming(entry);
          const inputDelay = typeof entry.processingStart === 'number'
            ? entry.processingStart - entry.startTime
            : NaN;
          const handlerMs = typeof entry.processingEnd === 'number' && typeof entry.processingStart === 'number'
            ? entry.processingEnd - entry.processingStart
            : NaN;
          const presentationDelay = typeof entry.processingEnd === 'number'
            ? entry.duration - (entry.processingEnd - entry.startTime)
            : NaN;
          const summary = summarizeUIAction(capturedAction, { event: name, inputDelayMs: inputDelay,
            handlerMs, presentationMs: presentationDelay, browserInteractionId: entry.interactionId });
          if (document.visibilityState === 'visible' && entry.duration >= 120) {
            reportPerfIncident('ui-' + name, performance.timeOrigin + entry.startTime, entry.duration, capturedAction?.id, summary);
          }
          const keyFields = formatDiagnosticKey(summary);
          const target = capturedAction?.target.tag || cssPath(entry.target || null);
          log(
            '[Perf:EventTiming] event=' + name +
            ' actionId=' + (capturedAction?.id || 'uncaptured-or-evicted') +
            keyFields +
            ' targetSource=' + (capturedAction?.target.source || 'unknown') +
            ' interactionId=' + (entry.interactionId || 0) +
            ' startAbs=' + (performance.timeOrigin + entry.startTime).toFixed(1) +
            ' processingStartAbs=' + (typeof entry.processingStart === 'number' ? (performance.timeOrigin + entry.processingStart).toFixed(1) : 'na') +
            ' processingEndAbs=' + (typeof entry.processingEnd === 'number' ? (performance.timeOrigin + entry.processingEnd).toFixed(1) : 'na') +
            ' durationMs=' + Number(entry.duration || 0).toFixed(1) +
            ' inputDelayMs=' + (Number.isFinite(inputDelay) ? inputDelay.toFixed(1) : 'na') +
            ' handlerMs=' + (Number.isFinite(handlerMs) ? handlerMs.toFixed(1) : 'na') +
            ' presentationDelayMs=' + (Number.isFinite(presentationDelay) ? presentationDelay.toFixed(1) : 'na') +
            ' target=' + target
          );
          if (
            (Number.isFinite(inputDelay) && inputDelay >= 500) ||
            Number(entry.duration || 0) >= 500
          ) {
            log(
              '[Perf:FreezeSummary] layer=input' +
              ' kind=eventTiming' +
              ' severity=' + freezeSeverity(Math.max(Number(entry.duration || 0), Number.isFinite(inputDelay) ? inputDelay : 0)) +
              ' event=' + name +
              ' actionId=' + (capturedAction?.id || 'uncaptured-or-evicted') + keyFields +
              ' interactionId=' + (entry.interactionId || 0) +
              ' startAbs=' + (performance.timeOrigin + entry.startTime).toFixed(1) +
              ' processingStartAbs=' + (typeof entry.processingStart === 'number' ? (performance.timeOrigin + entry.processingStart).toFixed(1) : 'na') +
              ' durationMs=' + Number(entry.duration || 0).toFixed(1) +
              ' inputDelayMs=' + (Number.isFinite(inputDelay) ? inputDelay.toFixed(1) : 'na') +
              ' handlerMs=' + (Number.isFinite(handlerMs) ? handlerMs.toFixed(1) : 'na') +
              ' target=' + target
            );
          }
        }
      });
      observer.observe({ type: 'event', buffered: true, durationThreshold: 32 } as PerformanceObserverInit);
    } catch (err: any) {
      log('[Perf:Probe] event-observer-failed error=' + (err?.message || String(err)));
    }
  }

  let lastPointerLogAt = 0;
  let lastDelayContextAt = 0;
  let lastPointerX = -1;
  let lastPointerY = -1;
  let lastPointerTarget: Element | null = null;
  let lastCursorKey = '';
  let lastCursorLogAt = 0;

  const readCursorState = () => {
    // Never force style/layout from diagnostics. In particular, body style
    // MutationObserver runs BEFORE paint after resize freeze/cursor writes.
    // Reading elementFromPoint/getComputedStyle there charged global layout
    // to mousedown and every first mousemove. The target below is the actual
    // dispatched event target (possibly captured), not a fresh hit-test.
    const atPoint = lastPointerTarget?.isConnected ? lastPointerTarget : null;
    const computedCursor = 'not-sampled';
    const bodyCursor = document.body?.style?.cursor || '';
    const htmlCursor = document.documentElement?.style?.cursor || '';
    const active = document.activeElement instanceof Element ? cssPath(document.activeElement) : 'none';
    return {
      x: lastPointerX,
      y: lastPointerY,
      target: cssPath(atPoint),
      targetSource: atPoint?.closest('[data-insp-path]')?.getAttribute('data-insp-path') || 'none',
      targetTab: atPoint?.closest('[data-tab-id]')?.getAttribute('data-tab-id') || 'none',
      gestureCursor: getInteractionCursor(),
      computedCursor,
      bodyCursor,
      htmlCursor,
      active,
    };
  };

  const logCursorState = (reason: string, force = false) => {
    const now = performance.now();
    if (!force && now - lastCursorLogAt < 250) return;
    const state = readCursorState();
    const key = [
      state.computedCursor,
      state.bodyCursor,
      state.htmlCursor,
      state.active,
      state.gestureCursor,
      state.target,
    ].join('|');
    const waitLike = /^(wait|progress)$/.test(state.computedCursor) ||
      /^(wait|progress)$/.test(state.bodyCursor) ||
      /^(wait|progress)$/.test(state.htmlCursor);
    if (!force && key === lastCursorKey && !waitLike) return;
    if (!force && now - lastCursorLogAt < 250) return;
    lastCursorKey = key;
    lastCursorLogAt = now;
    log(
      '[Perf:CursorState] reason=' + reason +
      ' abs=' + absNow().toFixed(1) +
      ' x=' + state.x +
      ' y=' + state.y +
      ' computed=' + (state.computedCursor || 'none') +
      ' targetEvidence=event' +
      ' body=' + (state.bodyCursor || 'none') +
      ' html=' + (state.htmlCursor || 'none') +
      ' gesture=' + (state.gestureCursor || 'none') +
      ' target=' + state.target +
      ' targetSource=' + state.targetSource +
      ' targetTab=' + state.targetTab +
      ' active=' + state.active
    );
  };

  const clipboardOutcomes = createUIClipboardOutcomeQueue({emit:log});
  onFinalPageHide(() => clipboardOutcomes.dispose());
  const captureInput = (event: Event) => {
    const capturedAction = ['click', 'pointerdown', 'mousedown', 'keydown', 'keyup', 'wheel', 'copy', 'cut', 'paste'].includes(event.type)
      ? captureUIAction(event) : null;
    if (capturedAction?.clipboardState) clipboardOutcomes.enqueue(capturedAction, event);
    const pointer = event as PointerEvent | MouseEvent;
    const now = performance.now();
    if ('clientX' in pointer) {
      lastPointerX = pointer.clientX;
      lastPointerY = pointer.clientY;
      lastPointerTarget = event.target instanceof Element ? event.target : null;
    }
    const eventTimeAbs = performance.timeOrigin + event.timeStamp;
    const receivedAbs = absNow();
    const inputDelayMs = receivedAbs - eventTimeAbs;
    const isPrimaryInput = event.type === 'click' || event.type === 'pointerdown' || event.type === 'mousedown';
    if (!isPrimaryInput && inputDelayMs <= 120) return;
    // The console throttle must not hide an eligible direct-channel attempt
    // (and thus its drop count) when EventTiming is unavailable or delayed.
    reportPerfIncident('input-' + event.type, eventTimeAbs, inputDelayMs, capturedAction?.id,
      summarizeUIAction(capturedAction, { event: event.type, inputDelayMs }));
    if (!isPrimaryInput && now - lastPointerLogAt < 250) return;
    lastPointerLogAt = now;
    log(
      '[Perf:Input] event=' + event.type +
      ' actionId=' + (capturedAction?.id || 'uncaptured-or-evicted') + formatDiagnosticKey(capturedAction) +
      ' eventTimeAbs=' + eventTimeAbs.toFixed(1) +
      ' receivedAbs=' + receivedAbs.toFixed(1) +
      ' inputDelayMs=' + inputDelayMs.toFixed(1) +
      ' buttons=' + ('buttons' in pointer ? pointer.buttons : 'na') +
      ' isTrusted=' + (event.isTrusted ? '1' : '0') +
      ' target=' + cssPath(event.target)
    );
    if (inputDelayMs >= 500) {
      log(
        '[Perf:FreezeSummary] layer=input' +
        ' kind=inputCapture' +
        ' severity=' + freezeSeverity(inputDelayMs) +
        ' event=' + event.type +
        ' eventTimeAbs=' + eventTimeAbs.toFixed(1) +
        ' receivedAbs=' + receivedAbs.toFixed(1) +
        ' inputDelayMs=' + inputDelayMs.toFixed(1) +
        ' target=' + cssPath(event.target)
      );
    }
    logCursorState('input-' + event.type, inputDelayMs > 120);

    if (inputDelayMs > 120 && now - lastDelayContextAt > 100) {
      lastDelayContextAt = now;
      const rafBefore = lastSampleBefore(rafSamples, eventTimeAbs);
      const rafAfter = firstSampleAfter(rafSamples, eventTimeAbs);
      const timerBefore = lastSampleBefore(timerSamples, eventTimeAbs);
      const timerAfter = firstSampleAfter(timerSamples, eventTimeAbs);
      const lastRaf = lastLoopSample(rafSamples);
      const lastTimer = lastLoopSample(timerSamples);
      log(
        '[Perf:InputDelayContext] event=' + event.type +
        ' inputDelayMs=' + inputDelayMs.toFixed(1) +
        ' eventTimeAbs=' + eventTimeAbs.toFixed(1) +
        ' receivedAbs=' + receivedAbs.toFixed(1) +
        ' rafSampling=ui-action-frames' +
        ' rafBaseline=' + (lastRaf ? 'sampled-current-burst' : 'unknown-idle-or-before-first-frame') +
        ' lastRafAbs=' + (lastRaf ? lastRaf.abs.toFixed(1) : 'unknown') +
        ' lastTimerAbs=' + (lastTimer ? lastTimer.abs.toFixed(1) : 'none') +
        ' rafAgeAtReceiveMs=' + (lastRaf ? (receivedAbs - lastRaf.abs).toFixed(1) : 'na') +
        ' timerAgeAtReceiveMs=' + (lastTimer ? (receivedAbs - lastTimer.abs).toFixed(1) : 'na') +
        ' rafBeforeEventAbs=' + (rafBefore ? rafBefore.abs.toFixed(1) : 'none') +
        ' rafAfterEventAbs=' + (rafAfter ? rafAfter.abs.toFixed(1) : 'none') +
        ' timerBeforeEventAbs=' + (timerBefore ? timerBefore.abs.toFixed(1) : 'none') +
        ' timerAfterEventAbs=' + (timerAfter ? timerAfter.abs.toFixed(1) : 'none') +
        ' recentRafDeltaGap=' + formatRecentSamples(rafSamples, receivedAbs) +
        ' recentTimerDeltaGap=' + formatRecentSamples(timerSamples, receivedAbs)
      );
    }
  };

  window.addEventListener('click', captureInput, { capture: true, passive: true });
  window.addEventListener('pointerdown', captureInput, { capture: true, passive: true });
  window.addEventListener('mousedown', captureInput, { capture: true, passive: true });
  window.addEventListener('keydown', captureInput, { capture: true, passive: true });
  window.addEventListener('keyup', captureInput, { capture: true, passive: true });
  window.addEventListener('wheel', captureInput, { capture: true, passive: true });
  window.addEventListener('copy', captureInput, { capture: true, passive: true });
  window.addEventListener('cut', captureInput, { capture: true, passive: true });
  window.addEventListener('paste', captureInput, { capture: true, passive: true });
  window.addEventListener('mouseover', captureInput, { capture: true, passive: true });
  window.addEventListener('gotpointercapture', uiDragInput, {capture:true,passive:true});
  window.addEventListener('lostpointercapture', uiDragInput, {capture:true,passive:true});
  window.addEventListener('pointerup', uiDragInput, {capture:true,passive:true});
  window.addEventListener('pointercancel', uiDragInput, {capture:true,passive:true});
  window.addEventListener('pointermove', (event) => {
    uiDragInput(event);
    lastPointerX = event.clientX;
    lastPointerY = event.clientY;
    lastPointerTarget = event.target instanceof Element ? event.target : null;
    logCursorState('pointermove');
  }, { capture: true, passive: true });

  const cursorTimer = window.setInterval(() => logCursorState('interval'), 250);
  void cursorTimer;

  try {
    const cursorObserver = new MutationObserver(() => logCursorState('mutation'));
    cursorObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
    if (document.body) cursorObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
  } catch (err: any) {
    log('[Perf:CursorState] observer-failed error=' + (err?.message || String(err)));
  }
}
