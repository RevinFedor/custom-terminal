'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

test('provider proxy keeps Claude legacy routing and adds an explicit Codex route', () => {
  assert.match(source, /const proxyRoute = parseProviderProxyRoute\(req\.url\)/);
  assert.match(source, /const proxyProvider = proxyRoute\.provider/);
  assert.match(source, /mode = proxyProvider === 'codex' \? 'codex' : reqState\.type/);
  assert.match(source, /resolveCodexUpstream\(\{ headers: req\.headers, forwardUrl \}\)/);
});

test('Codex launch routes through the ready local proxy without disabling native WebSockets', () => {
  assert.match(source, /providerProxyBaseUrl:\s*providerProxyReady[\s\S]{0,180}codexProxyBaseUrl\(PROVIDER_PROXY_PORT, tabId\)/);
  assert.match(source, /parts\.push\('-c', shellQuote\('openai_base_url=' \+ tomlString\(providerProxyBaseUrl\)\)\)/);
  assert.doesNotMatch(source, /supports_websockets\s*=\s*false/);
  assert.match(source, /providerProxy\.on\('upgrade'/);
  assert.match(source, /upstream\.send\(data, \{ binary: isBinary \}\)/);
  assert.match(source, /client\.send\(data, \{ binary: isBinary \}\)/);
});

test('shadow observer is armed by exact Claude hook ownership and never owns History output', () => {
  assert.match(source, /providerSemanticShadow\.armClaudeTurn\(\{[\s\S]{0,260}prompt: submitted_prompt \|\| ''/);
  assert.match(source, /providerSemanticShadow\.finishClaudeTurn\(\{/);
  assert.match(source, /providerSemanticShadow\.observeCodexReference\(\{ tabId, event \}\)/);
  assert.match(source, /providerSemanticShadow\.observeCanonical\(\{/);
  assert.match(source, /agent-transcript:get-semantic-shadow/);
  assert.doesNotMatch(source, /emitTerminalHistoryPreview\(providerSemanticShadow/);
});

test('SSE shadow tap is independent from the byte-for-byte response pipe', () => {
  assert.match(source, /const sseParser = createSseParser\(/);
  assert.match(source, /safelyObserveProviderSemantic\([\s\S]{0,160}'claude-sse-event'[\s\S]{0,160}semanticObserver\.observeSseEvent\(sseEvent\)/);
  assert.match(source, /proxyRes\.pipe\(tap\);\s*proxyRes\.pipe\(res\);/);
  assert.match(source, /semanticObserver\.markGap\('forward-error'\)/);
  assert.match(source, /tap\.unpipe\(\)[\s\S]{0,80}tap\.resume\(\)/);
  assert.match(source, /function safelyObserveProviderSemantic\(/);
});

test('a busy proxy port cannot leave a stale listening callback for the fallback port', () => {
  assert.match(source, /providerProxy\.removeListener\('listening', onListening\)/);
  assert.match(source, /providerProxy\.once\('listening', onListening\)/);
  assert.match(source, /setImmediate\(\(\) => startProxyOnPort\(port \+ 1\)\)/);
  assert.doesNotMatch(source, /providerProxy\.removeAllListeners\('error'\)/);
});
