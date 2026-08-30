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
  assert.match(source, /const providerProxyBaseUrl = providerProxyReady[\s\S]{0,120}codexProxyBaseUrl\(PROVIDER_PROXY_PORT, tabId\)/);
  assert.match(source, /buildCodexCommand\(\{[\s\S]{0,360}providerProxyBaseUrl,/);
  assert.match(source, /parts\.push\('-c', shellQuote\('openai_base_url=' \+ tomlString\(providerProxyBaseUrl\)\)\)/);
  assert.doesNotMatch(source, /supports_websockets\s*=\s*false/);
  assert.match(source, /providerProxy\.on\('upgrade'/);
  assert.match(source, /upstream\.send\(data, \{ binary: isBinary \}\)/);
  assert.match(source, /client\.send\(data, \{ binary: isBinary \}\)/);
});

test('Claude stays shadow-only while Codex provider events own live History', () => {
  assert.match(source, /providerSemanticShadow\.armClaudeTurn\(\{[\s\S]{0,260}prompt: submitted_prompt \|\| ''/);
  assert.match(source, /providerSemanticShadow\.finishClaudeTurn\(\{/);
  assert.match(source, /providerSemanticShadow\.observeCanonical\(\{/);
  assert.match(source, /agent-transcript:get-semantic-shadow/);
  assert.match(source, /onCodexSemanticEvent:\s*handleCodexProviderSemanticEvent/);
  assert.match(source, /terminalHistoryPreviewController\.activateSemanticSource\(\{/);
  assert.match(source, /terminalHistoryPreviewController\.observeSemanticEvent\(\{/);
  assert.match(source, /sourceId:\s*currentCodexProviderSemanticSourceId\(route\.tabId\)/);
  assert.match(source, /observeCodexProviderPreviewRawRecord\(detail\)/);
  assert.match(source, /codexProviderPreviewRolloutVerdict\(\{/);
  assert.match(source, /semanticItemId:\s*boundary\.itemId/);
});

test('provider request completion never lowers the Codex turn loader', () => {
  const handlerStart = source.indexOf('function handleCodexProviderSemanticEvent');
  const handlerEnd = source.indexOf('const providerSemanticShadow', handlerStart);
  const handler = source.slice(handlerStart, handlerEnd);
  assert.match(handler, /event\.type === 'turn_started'[\s\S]*publishCodexProviderTurnActivity/);
  assert.match(handler, /event\.type === 'turn_completed'[\s\S]*SEGMENT_END/);
  assert.doesNotMatch(handler, /event\.type === 'turn_completed'[\s\S]{0,500}active:\s*false/);
  assert.match(source, /boundary\.kind === 'lifecycle'[\s\S]{0,500}active:\s*boundary\.active/);
  assert.match(source, /const providerTurnBusy = codexProviderSemanticSources\.get\(tabId\)\?\.turnActive === true/);
  assert.match(source, /busy:\s*providerTurnActive/);
});

test('Codex launch uses the current CLI and no longer injects the patched side-channel', () => {
  assert.doesNotMatch(source, /NOTED_TERMINAL_CODEX_EVENTS_SOCKET:\s*/);
  assert.doesNotMatch(source, /NOTED_CODEX_BIN_DIR:\s*/);
  assert.doesNotMatch(source, /prepareCodexSemanticChannel/);
  assert.doesNotMatch(source, /notedCodexBinPath/);
  assert.match(source, /const retiredCodexBinDir = path\.join\(os\.homedir\(\), '\.noted-terminal', 'bin'\)/);
  assert.match(source, /delete shellEnv\.NOTED_CODEX_BIN_DIR/);
  assert.match(source, /delete shellEnv\.NOTED_TERMINAL_CODEX_EVENTS_SOCKET/);
  assert.match(source, /armCodexProviderSemanticSource\(\{ tabId, launchId \}\)/);
});

test('SSE shadow tap is independent from the byte-for-byte response pipe', () => {
  assert.match(source, /const sseParser = createSseParser\(/);
  assert.match(source, /safelyObserveProviderSemantic\([\s\S]{0,160}'claude-sse-event'[\s\S]{0,160}semanticObserver\.observeSseEvent\(sseEvent\)/);
  assert.match(source, /proxyRes\.pipe\(tap\);\s*proxyRes\.pipe\(res\);/);
  assert.match(source, /semanticObserver\.markGap\('forward-error'\)/);
  assert.match(source, /tap\.unpipe\(\)[\s\S]{0,80}tap\.resume\(\)/);
  assert.match(source, /function safelyObserveProviderSemantic\(/);
});

test('Codex proxy releases poisoned HTTP slots and detects silent WebSocket halves', () => {
  assert.match(source, /createProviderProxyHttpLifecycle\(\{/);
  assert.match(source, /downstreamRequest:\s*req/);
  assert.match(source, /downstreamResponse:\s*res/);
  assert.match(source, /timeoutMs:\s*codexResponseHeaderTimeoutMs\(targetPath\)/);
  assert.match(source, /clientAborted\s*=\s*e\?\.code === 'ECLIENTABORT'/);
  assert.match(source, /statusCode = e\?\.code === 'ETIMEDOUT' \? 504 : 502/);
  assert.match(source, /startProviderProxyWebSocketHeartbeat\(\{/);
  assert.match(source, /event=downstream-close-before-upgrade/);
  assert.match(source, /client\.on\('close'[\s\S]{0,900}upstream\.terminate\(\)/);
});

test('a busy proxy port cannot leave a stale listening callback for the fallback port', () => {
  assert.match(source, /providerProxy\.removeListener\('listening', onListening\)/);
  assert.match(source, /providerProxy\.once\('listening', onListening\)/);
  assert.match(source, /setImmediate\(\(\) => startProxyOnPort\(port \+ 1\)\)/);
  assert.doesNotMatch(source, /providerProxy\.removeAllListeners\('error'\)/);
});
