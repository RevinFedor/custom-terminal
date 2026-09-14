'use strict';

const { StringDecoder } = require('string_decoder');
const { randomUUID } = require('crypto');
const { performance } = require('perf_hooks');

const UI_METADATA_LIMIT = 64 * 1024;
const UI_COLLECTION_BUDGET_MS = 1500;
const MAX_ROOTS = 24;
const MAX_ANIMATIONS = 256;

/** Chrome's ReturnAsStream export is newline-delimited trace events inside an
 * array. Keep only complete lines; an export cut at 16 MiB still yields IDs.
 * Oversize lines are discarded through their newline, never accumulated. */
function createLayoutRootCollector({ rendererPid, maxRoots = MAX_ROOTS, maxCarryBytes = 65536 } = {}) {
  const cap = Math.max(1, Math.min(MAX_ROOTS, maxRoots));
  const carryCap = Math.max(64, Math.min(65536, maxCarryBytes));
  const decoder = new StringDecoder('utf8');
  const roots = new Map();
  let carry = '', discarding = false, done = false;
  const stats = { bytes: 0, lines: 0, layoutEvents: 0, malformedLayoutLines: 0,
    overlongLines: 0, ignoredRootOccurrences: 0, incompleteTailBytes: 0, completeExport: false };
  function line(text) {
    stats.lines++;
    if (!text.includes('"layoutRoots"')) return;
    text = text.replace(/^\s*\{\s*"traceEvents"\s*:\s*\[/, '').trim().replace(/,$/, '');
    let event;
    try { event = JSON.parse(text); } catch { stats.malformedLayoutLines++; return; }
    if (!['Layout', 'LocalFrameView::layout'].includes(event.name)) return;
    if (rendererPid && event.pid !== rendererPid) return;
    const entries = event.args?.endData?.layoutRoots || event.args?.data?.layoutRoots;
    if (!Array.isArray(entries)) return;
    stats.layoutEvents++;
    for (const root of entries.slice(0, 256)) {
      const id = root?.nodeId;
      if (!Number.isSafeInteger(id) || id <= 0) continue;
      const previous = roots.get(id);
      if (previous) previous.occurrences++;
      else if (roots.size < cap) roots.set(id, { backendNodeId: id, occurrences: 1 });
      else stats.ignoredRootOccurrences++;
    }
  }
  function text(value) {
    let offset = 0;
    while (offset < value.length) {
      const newline = value.indexOf('\n', offset);
      const end = newline < 0 ? value.length : newline;
      const part = value.slice(offset, end);
      if (!discarding) {
        if (Buffer.byteLength(carry) + Buffer.byteLength(part) > carryCap) {
          carry = ''; discarding = true; stats.overlongLines++;
        } else carry += part;
      }
      if (newline < 0) break;
      if (!discarding) line(carry);
      carry = ''; discarding = false; offset = newline + 1;
    }
  }
  return {
    write(data) {
      if (done) return;
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
      stats.bytes += buffer.length; text(decoder.write(buffer));
    },
    finish(completeExport = false) {
      if (!done) {
        text(decoder.end()); stats.completeExport = completeExport === true;
        if (completeExport && carry && !discarding) line(carry);
        else stats.incompleteTailBytes = Buffer.byteLength(carry);
        carry = ''; done = true;
      }
      return { ...stats, carryLimitBytes: carryCap, rootLimit: cap,
        roots: [...roots.values()].sort((a, b) => b.occurrences - a.occurrences || a.backendNodeId - b.backendNodeId) };
    },
  };
}

// Shared by the renderer probe and main validation. No arbitrary attributes or
// CDP exception strings are allowed to reach the new sidecar.
function sanitizeUiNode(raw) {
  const token = value => typeof value === 'string' && /^[A-Za-z0-9_:-]{1,128}$/.test(value) ? value : null;
  const inspector = value => typeof value === 'string' && value.length <= 200
    && /^(src|packages)\/[A-Za-z0-9_./-]+:\d{1,7}:\d{1,7}:[A-Za-z0-9_-]+$/.test(value)
    && !value.includes('..') ? value : null;
  const owners = {};
  for (const key of ['tab', 'pane', 'history', 'composerTab', 'terminalTab', 'stripTab', 'space', 'paneKey']) {
    const value = token(raw?.owners?.[key]); if (value) owners[key] = value;
  }
  return {
    tag: typeof raw?.tag === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(raw.tag) ? raw.tag : null,
    classes: (Array.isArray(raw?.classes) ? raw.classes : []).slice(0, 12)
      .filter(value => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_:-]{0,63}$/.test(value)),
    inspector: inspector(raw?.inspector), owners,
    isolatedPane: raw?.isolatedPane === true, inertAncestor: raw?.inertAncestor === true,
    ariaHiddenAncestor: raw?.ariaHiddenAncestor === true, inlineOpacityZero: raw?.inlineOpacityZero === true,
    ancestorLimitReached: raw?.ancestorLimitReached === true,
    inlineAncestorOpacity: (Array.isArray(raw?.inlineAncestorOpacity) ? raw.inlineAncestorOpacity : []).slice(0, 8)
      .filter(value => Number.isInteger(value?.depth) && value.depth >= 0 && value.depth < 48
        && typeof value?.opacity === 'number' && Number.isFinite(value.opacity) && value.opacity >= 0 && value.opacity <= 1)
      .map(({ depth, opacity }) => ({ depth, opacity })),
  };
}

/** Serialized into a single Runtime call. Reads metadata only: no textContent,
 * inner/outerHTML, value, title, URL, computed style, bounds or selection APIs.
 * Inline opacity is deliberately labelled as such, not claimed as visibility. */
function rendererUiProbe(options, projectNode, target) {
  const started = performance.now();
  const expired = () => performance.now() - started >= options.budgetMs;
  const name = value => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_-]{0,95}$/.test(value) ? value : null;
  const state = value => ['idle', 'running', 'paused', 'finished'].includes(value) ? value : 'unknown';
  function describe(element) {
    if (!element || element.nodeType !== 1) return projectNode(null);
    const result = { tag: element.localName, classes: (element.getAttribute('class') || '').slice(0, 1024).split(/\s+/),
      inspector: element.getAttribute('data-insp-path'), owners: {}, inlineAncestorOpacity: [] };
    const attributes = { tab: 'data-terminal-pane-wrapper', pane: 'data-terminal-pane-chrome-host',
      history: 'data-history-owner', composerTab: 'data-history-composer-tab-id',
      terminalTab: 'data-terminal-layer-tab-id', stripTab: 'data-tab-id', space: 'data-space-id', paneKey: 'data-pane-key' };
    let ancestor = element, depth = 0;
    for (; ancestor && depth < 48; ancestor = ancestor.parentElement, depth++) {
      for (const key of Object.keys(attributes)) {
        if (!result.owners[key]) result.owners[key] = ancestor.getAttribute(attributes[key]);
      }
      if (ancestor.getAttribute('data-pane-focus-isolated') === '1') result.isolatedPane = true;
      if (ancestor.hasAttribute('inert')) result.inertAncestor = true;
      if (ancestor.getAttribute('aria-hidden') === 'true') result.ariaHiddenAncestor = true;
      const inline = ancestor.style?.opacity;
      if (inline && Number.isFinite(Number(inline))) {
        const opacity = Number(inline);
        if (opacity === 0) result.inlineOpacityZero = true;
        if (result.inlineAncestorOpacity.length < 8) result.inlineAncestorOpacity.push({ depth, opacity });
      }
    }
    result.ancestorLimitReached = !!ancestor;
    return projectNode(result);
  }
  const output = { entries: [], observedCount: 0, countLimited: false, sizeLimited: false, timeLimited: false };
  if (options.mode === 'root') output.node = describe(target);
  const source = options.mode === 'root' ? target : document;
  if (!source || typeof source.getAnimations !== 'function') { output.unavailable = true; return output; }
  const animations = options.mode === 'root' ? source.getAnimations({ subtree: true }) : source.getAnimations();
  output.observedCount = animations.length;
  const limit = options.mode === 'root' ? 32 : Math.min(256, options.limit);
  let bytes = 0;
  for (let i = 0; i < Math.min(limit, animations.length); i++) {
    if (expired()) { output.timeLimited = true; break; }
    const animation = animations[i];
    const entry = { cssName: name(animation.animationName), playState: state(animation.playState) };
    if (options.mode !== 'root') entry.target = describe(animation.effect?.target);
    const cost = JSON.stringify(entry).length + 1; // projected strings are ASCII
    if (bytes + cost > options.maxBytes) { output.sizeLimited = true; break; }
    bytes += cost; output.entries.push(entry);
  }
  output.countLimited = animations.length > limit;
  return output;
}

function projectAnimation(raw, withTarget) {
  return {
    cssName: typeof raw?.cssName === 'string' && /^[A-Za-z_][A-Za-z0-9_-]{0,95}$/.test(raw.cssName) ? raw.cssName : null,
    playState: ['idle', 'running', 'paused', 'finished'].includes(raw?.playState) ? raw.playState : 'unknown',
    ...(withTarget ? { target: sanitizeUiNode(raw?.target) } : {}),
  };
}

function projectRootSummary(raw) {
  const result = {};
  for (const key of ['bytes', 'lines', 'layoutEvents', 'malformedLayoutLines', 'overlongLines',
    'ignoredRootOccurrences', 'incompleteTailBytes', 'carryLimitBytes', 'rootLimit']) {
    if (Number.isSafeInteger(raw?.[key]) && raw[key] >= 0) result[key] = raw[key];
  }
  result.completeExport = raw?.completeExport === true;
  result.roots = (Array.isArray(raw?.roots) ? raw.roots : []).slice(0, MAX_ROOTS)
    .filter(root => Number.isSafeInteger(root?.backendNodeId) && root.backendNodeId > 0)
    .map(root => ({ backendNodeId: root.backendNodeId,
      occurrences: Number.isSafeInteger(root.occurrences) && root.occurrences > 0 ? root.occurrences : 1 }));
  return result;
}

async function collectIncidentUiMetadata({ sendCommand, isOwned, traceRoots, captureStopped,
  zoomFactor, budgetMs = UI_COLLECTION_BUDGET_MS, skipReason }) {
  const started = performance.now(), wall = Date.now();
  const budget = Math.max(20, Math.min(UI_COLLECTION_BUDGET_MS, budgetMs));
  const until = started + budget, collectUntil = until - Math.min(100, budget / 5);
  const group = 'noted-incident-ui-' + randomUUID();
  const report = { schema: 'noted-incident-ui-v1', source: 'incident-capture-own-debugger',
    moment: 'post-capture-after-cpu-and-trace-stop', startedWallMs: wall,
    coverage: 'live metadata after measurement; node IDs may be gone or belong to a changed document',
    limits: { durationMs: budget, bytes: UI_METADATA_LIMIT, animations: MAX_ANIMATIONS, roots: MAX_ROOTS },
    trace: projectRootSummary(traceRoots), animations: [], roots: [], errors: [],
    objectGroup: group, objectGroupRelease: 'not-needed', status: 'complete' };
  if (typeof zoomFactor === 'number' && Number.isFinite(zoomFactor) && zoomFactor > 0 && zoomFactor <= 16) report.zoomFactor = zoomFactor;
  const own = () => { try { return isOwned() === true; } catch { return false; } };
  const failureCode = err => ['ownership-lost', 'time-limit', 'evaluation-exception', 'unexpected-response', 'node-unavailable']
    .includes(err?.uiCode) ? err.uiCode : 'command-failed';
  const error = (stage, code, backendNodeId) => {
    if (report.errors.length < 32) report.errors.push({ stage, code, ...(backendNodeId ? { backendNodeId } : {}) });
  };
  let closed = false, releaseNeeded = false, collectionExpired = false;
  function send(method, params, end = collectUntil) {
    if (closed || !own()) return Promise.reject(Object.assign(new Error(), { uiCode: 'ownership-lost' }));
    if (collectionExpired && method !== 'Runtime.releaseObjectGroup') return Promise.reject(Object.assign(new Error(), { uiCode: 'time-limit' }));
    const remaining = end - performance.now();
    if (remaining <= 0) return Promise.reject(Object.assign(new Error(), { uiCode: 'time-limit' }));
    let timer, expired = false;
    const pending = Promise.resolve().then(() => {
      if (!own()) throw Object.assign(new Error(), { uiCode: 'ownership-lost' });
      return sendCommand(method, params);
    });
    // A resolveNode reply can allocate a handle after our deadline. Release
    // that SAME private group again if we still own the debugger; never query
    // the late node or touch a replacement client's object groups.
    pending.then(() => {
      if (expired && own() && method !== 'Runtime.releaseObjectGroup') {
        Promise.resolve().then(() => own() && sendCommand('Runtime.releaseObjectGroup', { objectGroup: group })).catch(() => {});
      }
    }, () => {});
    return Promise.race([pending, new Promise((_, reject) => {
      timer = setTimeout(() => { expired = true; collectionExpired = true; reject(Object.assign(new Error(), { uiCode: 'time-limit' })); }, remaining);
    })]).then(value => {
      if (!own()) throw Object.assign(new Error(), { uiCode: 'ownership-lost' });
      if (performance.now() >= end) { expired = true; collectionExpired = true; throw Object.assign(new Error(), { uiCode: 'time-limit' }); }
      return value;
    }).finally(() => clearTimeout(timer));
  }
  const options = mode => ({ mode, limit: MAX_ANIMATIONS, maxBytes: mode === 'root' ? 4096 : 32768,
    budgetMs: Math.max(1, Math.floor(collectUntil - performance.now())) });
  function value(response) {
    if (response?.exceptionDetails) throw Object.assign(new Error(), { uiCode: 'evaluation-exception' });
    const result = response?.result?.value;
    if (!result || !Array.isArray(result.entries)) throw Object.assign(new Error(), { uiCode: 'unexpected-response' });
    return result;
  }
  try {
    if (skipReason || !captureStopped || !own()) {
      report.status = 'skipped';
      report.reason = ['external-debugger', 'renderer-unavailable'].includes(skipReason) ? skipReason
        : !captureStopped ? 'capture-stop-unconfirmed' : 'debugger-ownership-lost';
    } else {
      releaseNeeded = true;
      try {
        const config = options('document');
        const response = await send('Runtime.evaluate', {
          expression: `(${rendererUiProbe.toString()})(${JSON.stringify(config)}, ${sanitizeUiNode.toString()}, null)`,
          objectGroup: group, returnByValue: true, silent: true, timeout: config.budgetMs,
        });
        const raw = value(response);
        report.animationInventory = { observedCount: Number.isSafeInteger(raw.observedCount) ? Math.max(0, raw.observedCount) : null,
          countLimited: raw.countLimited === true || raw.entries.length > MAX_ANIMATIONS,
          sizeLimited: raw.sizeLimited === true, timeLimited: raw.timeLimited === true, unavailable: raw.unavailable === true };
        let bytes = 0;
        for (const entry of raw.entries.slice(0, MAX_ANIMATIONS)) {
          const projected = projectAnimation(entry, true), cost = Buffer.byteLength(JSON.stringify(projected)) + 1;
          if (bytes + cost > 32768) { report.animationInventory.sizeLimited = true; break; }
          bytes += cost; report.animations.push(projected);
        }
        if (raw.unavailable) error('animations', 'api-unavailable');
      } catch (err) { error('animations', failureCode(err)); }
      let bytes = 0;
      for (const { backendNodeId } of report.trace.roots) {
        if (!own() || collectionExpired || performance.now() >= collectUntil) {
          error('roots', own() ? 'time-limit' : 'ownership-lost'); break;
        }
        let entry;
        try {
          const resolved = await send('DOM.resolveNode', { backendNodeId, objectGroup: group });
          if (typeof resolved?.object?.objectId !== 'string') throw Object.assign(new Error(), { uiCode: 'node-unavailable' });
          const response = await send('Runtime.callFunctionOn', {
            objectId: resolved.object.objectId, objectGroup: group, returnByValue: true, silent: true,
            functionDeclaration: `function() { return (${rendererUiProbe.toString()})(${JSON.stringify(options('root'))}, ${sanitizeUiNode.toString()}, this); }`,
          });
          const raw = value(response);
          entry = { backendNodeId, status: 'ok', node: sanitizeUiNode(raw.node),
            subtreeAnimations: raw.entries.slice(0, 32).map(a => projectAnimation(a, false)),
            countLimited: raw.countLimited === true || raw.entries.length > 32,
            sizeLimited: raw.sizeLimited === true, timeLimited: raw.timeLimited === true };
          if (raw.unavailable) { entry.status = 'partial'; error('root-animations', 'api-unavailable', backendNodeId); }
        } catch (err) {
          entry = { backendNodeId, status: 'error', code: failureCode(err) };
          error('root', entry.code, backendNodeId);
        }
        const cost = Buffer.byteLength(JSON.stringify(entry)) + 1;
        if (bytes + cost > 24576) { report.rootSizeLimited = true; break; }
        bytes += cost; report.roots.push(entry);
      }
    }
  } finally {
    if (releaseNeeded) {
      if (own()) {
        report.objectGroupRelease = 'attempted';
        if (performance.now() >= until) {
          // A blocked main loop may resume after even the cleanup reserve.
          // Still issue cleanup, but do not extend the collection waiting for
          // its reply. The owning capture will detach its session afterward.
          report.objectGroupRelease = 'requested-after-deadline';
          Promise.resolve().then(() => own() && sendCommand('Runtime.releaseObjectGroup', { objectGroup: group })).catch(() => {});
          error('release', 'time-limit');
        } else {
          try { await send('Runtime.releaseObjectGroup', { objectGroup: group }, until); report.objectGroupRelease = 'confirmed'; }
          catch (err) { error('release', failureCode(err)); }
        }
      } else { report.objectGroupRelease = 'ownership-lost'; error('release', 'ownership-lost'); }
    }
    closed = true;
    if (report.status !== 'skipped' && (report.errors.length || report.rootSizeLimited
      || report.animationInventory?.countLimited || report.animationInventory?.sizeLimited
      || report.animationInventory?.timeLimited || report.roots.some(r => r.countLimited || r.sizeLimited || r.timeLimited))) report.status = 'partial';
    report.finishedWallMs = Date.now(); report.elapsedMs = Math.round((performance.now() - started) * 1000) / 1000;
    // Final file cap includes envelopes/errors, not just renderer payloads.
    while (Buffer.byteLength(JSON.stringify(report)) > UI_METADATA_LIMIT && report.animations.length) {
      report.animations.pop(); report.finalSizeLimited = true; report.status = 'partial';
    }
  }
  return report;
}

module.exports = { createLayoutRootCollector, collectIncidentUiMetadata, sanitizeUiNode, rendererUiProbe,
  UI_METADATA_LIMIT, UI_COLLECTION_BUDGET_MS, MAX_ROOTS, MAX_ANIMATIONS };
