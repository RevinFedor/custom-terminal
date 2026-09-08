'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mainSource = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const terminalServerSource = fs.readFileSync(
  path.join(__dirname, '../../mcp/terminal-server.mjs'),
  'utf8',
);

test('MCP reads and Project API mutations share the isolated discovery directory', () => {
  assert.match(
    mainSource,
    /const MCP_PORT_DIR = process\.env\.NOTED_DISCOVERY_DIR[\s\S]{0,180}path\.resolve\(process\.env\.NOTED_DISCOVERY_DIR\)/,
    'Electron main must publish mcp-port-* beside the isolated web-server record',
  );
  assert.match(
    terminalServerSource,
    /const PORT_DIR = process\.env\.NOTED_DISCOVERY_DIR[\s\S]{0,180}resolve\(process\.env\.NOTED_DISCOVERY_DIR\)/,
    'Terminal MCP must discover read and mutation channels in the same isolated directory',
  );
  assert.match(terminalServerSource, /const TOKEN_PATH = join\(PORT_DIR, 'web-token\.txt'\)/);
  assert.match(terminalServerSource, /function listLiveInstances\(\)[\s\S]{0,220}readdirSync\(PORT_DIR\)/);
  assert.match(terminalServerSource, /function listLiveWebInstances\(\)[\s\S]{0,220}readdirSync\(PORT_DIR\)/);
});
