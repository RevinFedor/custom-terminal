import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import * as presentation from '../../utils/mcpCatalogPresentation.mjs';

const require = createRequire(import.meta.url);
const filename = new URL('./McpHubButton.tsx', import.meta.url);
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  fileName: filename.pathname,
  reportDiagnostics: true,
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React,
    target: ts.ScriptTarget.ES2022, esModuleInterop: true },
});
assert.deepEqual((compiled.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error), []);

const names = ['browser', 'electron', 'ios', 'knowledge', 'sc-desktop', 'terminal'];
const catalog = { servers: [
  ...names.map(name => ({ id: name, name, hubServer: name, enabled: true, transport: 'http' })),
  { id: 'legacy', name: 'computer-use', enabled: false, transport: 'stdio' },
  { id: 'current', name: 'cua_repl', enabled: true, source: 'plugin', transport: 'plugin' },
] };
const healthy = { servers: names.map((name, i) => ({ name, pid: 100 + i, up: true,
  initialized: true, pendingRequests: 0, startedAt: null })), clients: [], port: 12345 };

// Render the actual JSX against finite state snapshots. Effects, IPC and portal
// attachment are controlled: this is a rendering regression, not live Electron E2E.
function renderPanel(status, restartError = null) {
  const states = [true, status, null, restartError, catalog, false, { top: 8, right: 8 }];
  let stateIndex = 0;
  const hooks = { ...React,
    useState() { assert.ok(stateIndex < states.length); return [states[stateIndex++], () => {}]; },
    useEffect() {}, useRef(current) { return { current }; }, useCallback(fn) { return fn; },
  };
  const module = { exports: {} };
  const context = {
    module, exports: module.exports, document: { body: {} },
    window: { require(name) {
      assert.equal(name, 'electron');
      return { ipcRenderer: { invoke() { assert.fail('render must not call IPC or restart a server'); } } };
    } },
    require(name) {
      if (name === 'react') return hooks;
      if (name === 'react-dom') return { createPortal: node => node };
      if (name === '../UI/Tooltip') return { __esModule: true, default: ({ children }) => children };
      if (name === '../../utils/mcpCatalogPresentation.mjs') return presentation;
      if (name === 'lucide-react') return require(name);
      assert.fail('unexpected renderer dependency: ' + name);
    },
  };
  vm.runInNewContext(compiled.outputText, context, { filename: filename.pathname, timeout: 1000 });
  return renderToStaticMarkup(React.createElement(module.exports.default));
}

test('panel: unread or failed status displays six unknown routes without claiming tools are down', () => {
  for (const status of [null, { down: true, servers: [] }, { servers: null }]) {
    const html = renderPanel(status);
    assert.match(html, /MCP-хаб · статус неизвестен/);
    assert.equal((html.match(/>статус неизвестен</g) || []).length, 6);
    assert.doesNotMatch(html, /нет в хабе|отсутствующие в хабе|MCP-инструменты недоступны|0\/0 активных/);
    assert.match(html, /computer-use/);
    assert.match(html, />отключён</);
    assert.match(html, /cua_repl/);
    assert.match(html, />настроен</);
  }
});

test('panel: maintenance failure preserves the five other live servers and restart guard', () => {
  const html = renderPanel({ ...healthy,
    browserMaintenance: { held: true, code: 'research_ingress_storage_invalid' } });
  assert.match(html, /5\/6 активных/);
  assert.match(html, /обслуживание/);
  assert.match(html, /disabled=""[^>]*>.*?Перезапустить MCP хаба/s);
  assert.doesNotMatch(html, /нет в хабе|отсутствующие в хабе|статус неизвестен/);
  for (const server of healthy.servers.slice(1)) assert.match(html, new RegExp('pid ' + server.pid));
});

test('panel: an observed missing route remains visible as missing', () => {
  const html = renderPanel({ ...healthy, servers: healthy.servers.filter(s => s.name !== 'browser') });
  assert.match(html, /5\/5 активных/);
  assert.match(html, /отсутствующие в хабе: browser/);
  assert.equal((html.match(/>нет в хабе</g) || []).length, 1);
});

test('panel: live inventory stays healthy while a prior restart error is labelled as the last attempt', () => {
  const html = renderPanel(healthy, 'research_ingress_storage_invalid');
  assert.match(html, /6\/6 активных/);
  assert.match(html, /Последняя попытка: research_ingress_storage_invalid/);
  assert.doesNotMatch(html, /нет в хабе|отсутствующие в хабе|MCP-инструменты недоступны/);
});
