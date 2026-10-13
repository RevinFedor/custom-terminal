import { currentUIActionId, uiPerformancePhase } from './uiPerformanceDiagnostics.mjs';

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
  let result, failed = false;
  try { result = call(); return result; }
  catch (error) { failed = true; throw error; }
  finally {
    try {
      const kind = operations.has(operation) ? operation : 'unknown';
      const ms = Math.round((now() - start) * 10) / 10;
      const fields = { ms, failed, missing: metadata.missing === true };
      if (kind === 'read-text' && typeof result === 'string') fields.chars = result.length;
      if (kind === 'write-text' && Number.isSafeInteger(metadata.chars)) fields.chars = metadata.chars;
      if (kind === 'read-formats' && Array.isArray(result)) fields.formatCount = result.length;
      uiPerformancePhase('composer-clipboard-' + kind, fields);
      if(kind==='read-text'&&canary){
        const {runId,step}=canary;canary=null;
        console.warn('[Perf:ClipboardOracle] '+JSON.stringify({runId,step,actionId:currentUIActionId(),
          matchesExpected:failed?null:result===canaryStrings[step],
          matchesPrevious:failed||step===0?null:result===canaryStrings[step-1],failed}));
      }
      if (failed || fields.missing || ms >= 100) console.warn('[Perf:ComposerClipboard] '
        + JSON.stringify({ operation: kind, actionId: currentUIActionId(), ...fields }));
    } catch { /* Observability must never change a successful clipboard result. */ }
  }
}
