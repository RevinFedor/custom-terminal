import { currentUIActionId, uiPerformancePhase, uiPerformancePhaseForAction } from './uiPerformanceDiagnostics.mjs';

const operations = new Set(['read-text', 'write-text', 'read-formats', 'read-snapshot']);
const now = () => globalThis.performance?.now?.() ?? Date.now();
const canaryStrings=['abc','111'];
let canary=null;

// Explicitly armed by a controlled test only; there is no production hotkey,
// polling or arbitrary expected-text input. Observe the already required read.
export function armComposerClipboardOracle({runId,step}) {
  if(!/^clipboard-canary-[a-z0-9-]{1,80}$/.test(runId)||![0,1].includes(step))throw Error('invalid clipboard canary');
  canary={runId,step};
}

// Measures only the native operation already needed by the composer. Never
// verify by reading the clipboard again, serialize its body, or force layout.
export function measureComposerClipboardCall(operation, call, metadata = {}) {
  const start = now();
  const startedAbs = (globalThis.performance?.timeOrigin || 0) + start;
  let result, failed = false;
  try { result = call(); return result; }
  catch (error) { failed = true; throw error; }
  finally {
    try {
      const kind = operations.has(operation) ? operation : 'unknown';
      const ms = Math.round((now() - start) * 10) / 10;
      const fields = { ms, failed, missing: metadata.missing === true };
      if (metadata.surface === 'history' || metadata.surface === 'file-preview') fields.surface = metadata.surface;
      if (kind === 'read-text' && typeof result === 'string') fields.chars = result.length;
      if (kind === 'write-text' && Number.isSafeInteger(metadata.chars)) fields.chars = metadata.chars;
      if (kind === 'read-formats' && Array.isArray(result)) fields.formatCount = result.length;
      const explicitAction = Object.prototype.hasOwnProperty.call(metadata, 'actionId');
      const actionId = explicitAction ? metadata.actionId : currentUIActionId();
      const phaseName = (fields.surface || 'composer') + '-clipboard-' + kind;
      if (explicitAction) {
        if (!actionId || !uiPerformancePhaseForAction(actionId, phaseName, fields)) {
          fields.phaseMissing = true;
          fields.phaseMissingReason = 'original-action-unavailable';
        }
      } else uiPerformancePhase(phaseName, fields);
      if(kind==='read-text'&&canary){
        const {runId,step}=canary;canary=null;
        console.warn('[Perf:ClipboardOracle] '+JSON.stringify({runId,step,actionId:currentUIActionId(),
          matchesExpected:failed?null:result===canaryStrings[step],
          matchesPrevious:failed||step===0?null:result===canaryStrings[step-1],failed}));
      }
      // Explicit Copy is sparse. Its completion may arrive after the original
      // action was flushed/evicted, so persist this outcome even when native IO
      // itself was fast. Never borrow a newer navigation gesture after await.
      const buttonCopy = fields.surface === 'history' || fields.surface === 'file-preview';
      if (failed || fields.missing || fields.phaseMissing || ms >= 100 || buttonCopy) console.warn('[Perf:ComposerClipboard] '
        + JSON.stringify({ operation: kind, actionId, ...fields,
          ...(buttonCopy ? { startedAbs, completedAbs: startedAbs + ms,
            ...(Number.isFinite(metadata.requestedAbs) ? { requestedAbs: metadata.requestedAbs,
              waitBeforeWriteMs: Math.max(0, Math.round((startedAbs - metadata.requestedAbs) * 10) / 10) } : {}) } : {}) }));
    } catch { /* Observability must never change a successful clipboard result. */ }
  }
}

// Reuse the same action/phase channel for explicit Copy buttons. The text is
// passed to the native writer once; diagnostics retain only its length/time.
export function captureClipboardWriteContext() {
  return { actionId: currentUIActionId(), requestedAbs: (globalThis.performance?.timeOrigin || 0) + now() };
}

export function writeMeasuredClipboardText(clipboard, text, surface, context = captureClipboardWriteContext()) {
  return measureComposerClipboardCall('write-text', () => clipboard.writeText(text), {
    chars: typeof text === 'string' ? text.length : undefined,
    surface,
    actionId: context.actionId,
    requestedAbs: context.requestedAbs,
  });
}
