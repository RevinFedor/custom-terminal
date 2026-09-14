'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const sourcePath = path.join(__dirname, 'web-server.js');
const mainPath = path.join(__dirname, 'main.js');

test('mobile API publishes process-bound listening health and logs every bind boundary', () => {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const main = fs.readFileSync(mainPath, 'utf8');

  assert.match(source, /service:\s*webServerServiceHealth\(\)/);
  assert.match(source, /mobileDiagnostics:\s*\{ version: 1, serviceHealth: 'api-me' \}/);
  assert.match(source, /running:\s*!!httpServer\?\.listening/);
  assert.match(source, /\[WebServer:Health\] start-request/);
  assert.match(source, /\[WebServer:Health\] bind-conflict/);
  assert.match(source, /\[WebServer:Health\] listen-failed/);
  assert.match(source, /\[WebServer:Health\] listening/);
  assert.match(source, /\[WebServer:Health\] stopped/);
  assert.match(source, /preferredPort:\s*PORT_PREFERRED/);
  assert.match(source, /instanceId:\s*webServerInstanceId/);
  assert.match(main, /readiness is confirmed by \[WebServer:Health\] listening/);
  assert.doesNotMatch(main, /\[Startup\] Mobile WebServer OK/);
});
