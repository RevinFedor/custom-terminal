'use strict';

// Observations for a forced install. A deadline produces UNKNOWN, never idle
// or permission to replay a remote operation. No tool/provider control here.
function createBuildInstallSnapshot({ runtime, input, runs, mcp, startup, readTab, pid = process.pid, timeoutMs = 1500 }) {
  const bounded = async read => {
    let timer;
    try {
      const value = await Promise.race([Promise.resolve().then(read), new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('snapshot deadline')), timeoutMs);
      })]);
      return { known: true, value };
    } catch (error) { return { known: false, error: String(error.code || error.message) }; }
    finally { clearTimeout(timer); }
  };
  return async ({ tabIds = [] } = {}) => {
    const checked = async (read, valid) => { const value = await read(); if (!valid(value)) throw Error('snapshot unavailable'); return value; };
    const [runtimeState, inputState, runState, mcpState, startupState] = await Promise.all([
      bounded(() => checked(runtime, value => Array.isArray(value?.loaders))),
      bounded(() => checked(input, Array.isArray)), bounded(() => checked(runs, Array.isArray)),
      bounded(() => checked(mcp, value => Array.isArray(value?.servers))),
      bounded(() => checked(startup, value => Array.isArray(value?.targets))),
    ]);
    const scope = [...new Set([...tabIds,
      ...(runtimeState.value?.loaders || []).map(row => row.tabId),
      ...(inputState.value || []).map(row => row.tabId),
      ...(startupState.value?.targets || []).map(row => row.tabId),
    ].filter(id => typeof id === 'string' && id))].slice(0, 200);
    const tabs = await Promise.all(scope.map(async tabId => {
      const row = await bounded(() => readTab(tabId));
      if (!row.known) return { tabId, known: false, error: row.error };
      const value = row.value || {};
      return { tabId, known: value.coherent === true, toolType: value.toolType || value.commandType || null,
        sessionId: value.sessionId || null, processStatus: value.processStatus || 'unknown',
        busy: value.busy === true ? true : value.busy === false ? false : null,
        status: value.status || value.sessionStatus || 'unknown', inputReady: value.inputReady === true,
        lifecycleGeneration: value.lifecycleGeneration || null, terminalRunSeq: value.terminalRunSeq ?? null };
    }));
    return { version: 1, mainPid: pid, capturedAt: Date.now(), runtime: runtimeState,
      input: inputState, orchestrations: runState, mcp: mcpState, startup: startupState, tabs,
      coverage: { mcp: 'shared-hub-server-level', exactRpcOwners: false,
        externalPluginAndStdioMcp: 'unknown', maxTabs: 200, truncatedTabs: scope.length >= 200 } };
  };
}

module.exports = { createBuildInstallSnapshot };
