'use strict';

// Native menu -> existing watchdog IPC -> existing flight-recorder admission.
// No renderer command, remote endpoint, quota override or delivery retry.
const { randomBytes } = require('node:crypto');
const MANUAL_KIND = 'manual';
const MANUAL_REASON = 'native-help-before-gesture';
const MANUAL_DURATION_MS = 10000;
const MANUAL_INPUT_DURATION_MS = 40000;
const requestIdPattern = /^manual-\d+-[a-f0-9]{24}$/;
const positive = n => Number.isSafeInteger(n) && n > 0;
function validManualRequest(m, mainPid) {
  const o = m?.owner;
  return m?.t === 'perf-manual-request' && m.version === 1 && requestIdPattern.test(m.requestId)
    && m.kind === MANUAL_KIND && m.reason === MANUAL_REASON
    && [MANUAL_DURATION_MS, MANUAL_INPUT_DURATION_MS].includes(m.durationMs)
    && Number.isFinite(m.requestedWallMs) && m.mainPid === mainPid && o?.mainPid === mainPid
    && positive(o.windowId) && positive(o.webContentsId) && positive(o.rendererPid)
    && Number.isSafeInteger(o.frameProcessId) && o.frameProcessId >= 0
    && Number.isSafeInteger(o.frameRoutingId) && o.frameRoutingId >= 0
    && /^[a-f0-9]{24}$/.test(o.documentToken);
}

function pinManualOwner(window, { mainPid, fromId, watchdog, currentWatchdog }) {
  if (!window || window.isDestroyed()) throw new Error('no-original-window');
  const wc = window.webContents;
  let invalidReason = null, releaseInvalidation;
  const invalidated = new Promise(resolve => { releaseInvalidation = resolve; });
  const invalidate = reason => { if (!invalidReason) { invalidReason = reason; releaseInvalidation(reason); } };
  const navigation = (event, _url, inPlace, mainFrame) => {
    if ((event?.isMainFrame ?? mainFrame) === true && !(event?.isSameDocument ?? inPlace)) invalidate('document-navigation');
  };
  const commit = (_event, _url, _code, _status, mainFrame) => { if (mainFrame === true) invalidate('document-commit'); };
  const gone = () => invalidate('renderer-gone');
  const closed = () => invalidate('window-closed');
  const destroyed = () => invalidate('webcontents-destroyed');
  const channelLost = () => invalidate('watchdog-channel-lost');
  wc.on('did-start-navigation', navigation); wc.on('did-frame-navigate', commit);
  wc.on('render-process-gone', gone); wc.on('destroyed', destroyed); window.on('closed', closed);
  for (const event of ['disconnect', 'error', 'exit']) watchdog.on(event, channelLost);
  const dispose = () => {
    wc.removeListener('did-start-navigation', navigation); wc.removeListener('did-frame-navigate', commit);
    wc.removeListener('render-process-gone', gone); wc.removeListener('destroyed', destroyed); window.removeListener('closed', closed);
    for (const event of ['disconnect', 'error', 'exit']) watchdog.removeListener(event, channelLost);
  };
  let owner;
  const current = () => {
    try {
      const frame = wc.mainFrame;
      return { mainPid, windowId: window.id, webContentsId: wc.id, rendererPid: wc.getOSProcessId(),
        frameProcessId: frame.processId, frameRoutingId: frame.routingId,
        frameOsProcessId: frame.osProcessId, destroyed: window.isDestroyed() || wc.isDestroyed(),
        loading: wc.isLoadingMainFrame(), watchdogCurrent: watchdog === currentWatchdog() && watchdog.connected === true,
        documentToken: invalidReason ? null : owner?.documentToken, invalidReason };
    } catch { return { mainPid, invalidReason: invalidReason || 'owner-unavailable' }; }
  };
  const isCurrent = () => {
    const c = current();
    return !invalidReason && !c.destroyed && !c.loading && c.watchdogCurrent && fromId(owner.windowId) === window
      && window.webContents === wc && c.rendererPid === owner.rendererPid && c.frameOsProcessId === owner.rendererPid
      && c.webContentsId === owner.webContentsId && c.frameProcessId === owner.frameProcessId
      && c.frameRoutingId === owner.frameRoutingId;
  };
  try {
    const c = current();
    owner = { mainPid, windowId: c.windowId, webContentsId: c.webContentsId, rendererPid: c.rendererPid,
      frameProcessId: c.frameProcessId, frameRoutingId: c.frameRoutingId, documentToken: randomBytes(12).toString('hex') };
    if (!isCurrent()) throw new Error('original-owner-unavailable');
    return { owner, webContents: wc, isCurrent, current, invalidated, invalidate, dispose };
  } catch (error) { dispose(); throw error; }
}

function createManualCaptureController({ mainPid, getWatchdog, fromId, capture, suspend, directory,
  log, schedule = setTimeout, cancel = clearTimeout }) {
  let active = null;
  const report = (state, extra = {}, item = active) => log('[Perf:ManualCapture] ' + JSON.stringify({
    state, kind: MANUAL_KIND, reason: MANUAL_REASON,
    requestId: item?.request.requestId || null, owner: item?.request.owner || null,
    currentOwner: item?.pin.current() || null, ...extra }));
  const unknown = (item, reason) => {
    if (active !== item || item.state === 'finished') return;
    item.state = 'unknown'; cancel(item.timer);
    item.pin.invalidate(reason);
    report('unknown', { reason, retry: false }, item);
    // Keep the single-flight latch. A lost request cannot authorize a new one.
    item.pin.dispose();
  };
  function request(window, { durationMs = MANUAL_DURATION_MS } = {}) {
    if (active) { report('refused', { reason: 'manual-in-flight-or-unknown' }); return false; }
    if (![MANUAL_DURATION_MS, MANUAL_INPUT_DURATION_MS].includes(durationMs)) {
      report('refused', { reason: 'invalid-manual-duration' }); return false;
    }
    const watchdog = getWatchdog();
    if (!watchdog?.connected) { report('refused', { reason: 'watchdog-unavailable' }); return false; }
    let pin;
    try { pin = pinManualOwner(window, { mainPid, fromId, watchdog, currentWatchdog: getWatchdog }); }
    catch (error) { report('refused', { reason: error.message }); return false; }
    const request = { t: 'perf-manual-request', version: 1, requestId: 'manual-' + mainPid + '-' + randomBytes(12).toString('hex'),
      mainPid, owner: pin.owner, kind: MANUAL_KIND, reason: MANUAL_REASON,
      durationMs, requestedWallMs: Date.now() };
    if (!validManualRequest(request, mainPid)) { pin.dispose(); report('refused', { reason: 'invalid-original-owner' }); return false; }
    const item = active = { request, pin, watchdog, state: 'requested', timer: null };
    pin.invalidated.then(reason => { if (active === item && item.state === 'requested') unknown(item, reason); });
    item.timer = schedule(() => unknown(item, 'admission-reply-lost'), 5000); item.timer?.unref?.();
    report('requested', { durationMs });
    try { watchdog.send(request, error => { if (error && item.state === 'requested') unknown(item, 'request-delivery-unknown'); }); }
    catch { unknown(item, 'request-delivery-unknown'); }
    return true;
  }
  function handle(message, watchdog) {
    const isManual = message?.kind === MANUAL_KIND || message?.t === 'perf-manual-decision';
    if (!isManual) return false;
    const item = active;
    if (!item || item.watchdog !== watchdog || getWatchdog() !== watchdog
      || message.requestId !== item.request.requestId) { report('refused', { reason: 'unmatched-manual-reply' }); return true; }
    if (message.t === 'perf-manual-decision') {
      if (item.state !== 'requested') return true;
      if (message.allowed === false) {
        cancel(item.timer); report('refused', { decision: message }); item.pin.dispose(); active = null;
      }
      // allowed only means admission, never READY. Wait for the capture request.
      return true;
    }
    if (message.t !== 'capture' || item.state !== 'requested') { report('refused', { reason: 'duplicate-or-late-capture' }); return true; }
    cancel(item.timer);
    const exact = { ...message, t: 'perf-manual-request' };
    if (!validManualRequest(exact, mainPid) || !/^incident-\d+-\d+$/.test(message.id || '')
      || message.durationMs !== item.request.durationMs
      || JSON.stringify(message.owner) !== JSON.stringify(item.request.owner) || !item.pin.isCurrent()) {
      unknown(item, 'stale-or-invalid-original-owner'); return true;
    }
    item.state = 'recording';
    // This synchronous state change precedes every await and duplicate reply.
    void (async () => {
      let resume;
      try {
        resume = suspend(item.pin.webContents);
        if (resume?.ready) await resume.ready;
        if (!item.pin.isCurrent()) throw new Error('stale-original-owner');
        const result = await capture({ request: message, webContents: item.pin.webContents, directory, log,
          durationMs: item.request.durationMs, ownerGuard: item.pin,
          onReady: ready => { if (item.pin.isCurrent()) report('ready', { id: message.id, ...ready }, item); } });
        if (result?.whenRetired) {
          const release = resume; resume = null;
          item.state = 'cleanup-unknown';
          void Promise.resolve(result.whenRetired).then(async receipt => {
            if (receipt?.confirmed !== true || receipt.leaseId !== result.leaseId) {
              report('cleanup-unknown', { id: message.id, reason: 'retirement-not-confirmed-for-lease' }, item);
              return;
            }
            try { await release?.(); }
            catch (error) { report('cleanup-failed', { id: message.id, reason: String(error.message || error).slice(0, 180) }, item); return; }
            if (active === item) { item.state = 'finished'; active = null; }
          }).catch(error => report('cleanup-unknown', { id: message.id, reason: String(error?.message || error).slice(0, 180) }, item));
        } else {
          // A snapshot alone cannot prove that this hold may be released.
          resume = null; item.state = 'cleanup-unknown';
        }
        report('finished', { id: message.id, outcome: result?.outcome || 'unknown',
          profileFile: result?.profileFile || null, artifacts: result?.artifacts || {}, errors: result?.errors || [],
          skipped: { main: result?.mainSkipped, renderer: result?.rendererSkipped, trace: result?.traceSkipped },
          traceComplete: result?.traceComplete ?? null, dataLoss: result?.traceDataLoss ?? null }, item);
      } catch (error) { item.state = 'cleanup-unknown'; report('failed', { reason: String(error.message || error).slice(0, 180) }, item); }
      finally {
        item.pin.dispose();
        if (item.state !== 'cleanup-unknown') { item.state = 'finished'; if (active === item) active = null; }
      }
    })();
    return true;
  }
  return { request, handle };
}

function handleManualWatchdogRequest(message, { mainPid, flight, stopped, send, log }) {
  if (message?.t !== 'perf-manual-request') return false;
  const decision = !validManualRequest(message, mainPid) ? { allowed: false, reason: 'invalid-manual-request' }
    : stopped ? { allowed: false, reason: 'watchdog-shutting-down' }
    : !flight ? { allowed: false, reason: 'recorder-unavailable' }
    : flight.requestManualCapture(message);
  const reply = { t: 'perf-manual-decision', requestId: String(message.requestId || '').slice(0, 100), ...decision };
  log('[Perf:ManualAdmission] ' + JSON.stringify(reply));
  try { send(reply); } catch { log('[Perf:ManualAdmission] reply-delivery-unknown'); }
  return true;
}

function installManualCaptureMenu({ Menu, MenuItem, controller }) {
  const menu = Menu.getApplicationMenu() || new Menu();
  let help = menu.items.find(item => item.role === 'help' || item.label === 'Help');
  if (!help) { help = new MenuItem({ role: 'help', label: 'Help', submenu: [] }); menu.append(help); }
  if (!help.submenu.items.some(item => item.id === 'noted-perf-manual')) {
    help.submenu.append(new MenuItem({ id: 'noted-perf-manual', label: 'Record Performance (10 seconds)',
      click: (_item, originalWindow) => controller.request(originalWindow) }));
  }
  if (!help.submenu.items.some(item => item.id === 'noted-perf-manual-input')) {
    help.submenu.append(new MenuItem({ id: 'noted-perf-manual-input', label: 'Record Input Performance (40 seconds)',
      click: (_item, originalWindow) => controller.request(originalWindow, { durationMs: MANUAL_INPUT_DURATION_MS }) }));
  }
  Menu.setApplicationMenu(menu);
}

module.exports = { MANUAL_DURATION_MS, MANUAL_INPUT_DURATION_MS, validManualRequest, pinManualOwner, createManualCaptureController,
  handleManualWatchdogRequest, installManualCaptureMenu };
