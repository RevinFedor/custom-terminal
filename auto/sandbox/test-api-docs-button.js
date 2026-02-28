/**
 * [E2E] Test: API Docs Button
 *
 * Verifies:
 * 1. The [api] button renders in ActionsPanel
 * 2. IPC handler docs:api-request exists and works (main process fetch, no CORS)
 * 3. API call returns a valid response with text block
 *
 * Requires: npm run dev + fresh main.js (restart Electron after main.js changes)
 */

const { launch, waitForTerminal } = require('../core/launcher');
const electron = require('../core/electron');

const c = {
  reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m',
  cyan: '\x1b[36m', yellow: '\x1b[33m', dim: '\x1b[2m'
};
const log = {
  step: (m) => console.log(`${c.cyan}[STEP]${c.reset} ${m}`),
  pass: (m) => console.log(`${c.green}[PASS]${c.reset} ${m}`),
  fail: (m) => console.log(`${c.red}[FAIL]${c.reset} ${m}`),
  warn: (m) => console.log(`${c.yellow}[WARN]${c.reset} ${m}`),
  info: (m) => console.log(`${c.dim}[INFO]${c.reset} ${m}`)
};

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { log.pass(msg); passed++; }
  else { log.fail(msg); failed++; }
}

async function main() {
  const { app, page, consoleLogs, mainProcessLogs } = await launch({
    logMainProcess: true,
    waitForReady: 4000
  });

  try {
    await waitForTerminal(page, 15000);
    await electron.focusWindow(app);
    await page.waitForFunction(() => document.hasFocus(), null, { timeout: 3000 });

    // ── TEST 1: Check that [api] button renders in ActionsPanel ──
    log.step('TEST 1: Check [api] button exists in DOM');

    // ActionsPanel is embedded in InfoPanel — look for the api button
    // It should have text "api" and purple-ish styling
    const apiButton = await page.evaluate(() => {
      // Search all span elements for one that contains exactly 'api' text
      const spans = document.querySelectorAll('span');
      for (const span of spans) {
        const text = span.textContent?.trim();
        if (text === 'api' && span.style.fontWeight === '600' && span.style.letterSpacing === '0.5px') {
          return {
            found: true,
            text: span.textContent,
            color: span.style.color,
            cursor: window.getComputedStyle(span).cursor
          };
        }
      }
      return { found: false };
    });

    assert(apiButton.found, 'API button found in DOM');
    if (apiButton.found) {
      log.info(`Button text: "${apiButton.text}", color: ${apiButton.color}`);
      assert(apiButton.cursor === 'pointer', 'API button is clickable (cursor: pointer)');
    }

    // ── TEST 2: IPC handler docs:api-request exists ──
    log.step('TEST 2: IPC handler docs:api-request works (small test prompt)');

    // Send a tiny prompt to verify the handler works end-to-end
    // Using a minimal prompt to minimize API cost
    const ipcResult = await page.evaluate(async () => {
      const { ipcRenderer } = window.require('electron');
      try {
        const result = await ipcRenderer.invoke('docs:api-request', {
          prompt: 'Reply with exactly one word: "ok"'
        });
        return result;
      } catch (err) {
        return { success: false, error: err.message };
      }
    });

    log.info(`IPC result: success=${ipcResult.success}, text length=${ipcResult.text?.length || 0}`);

    assert(ipcResult.success === true, 'docs:api-request IPC returns success');
    if (ipcResult.success) {
      assert(typeof ipcResult.text === 'string' && ipcResult.text.length > 0, 'Response has non-empty text');
      log.info(`API response: "${ipcResult.text.slice(0, 100)}"`);

      // ── TEST 3: usage object with token counts ──
      log.step('TEST 3: API response includes usage (token counts)');
      const usage = ipcResult.usage;
      assert(usage && typeof usage.input_tokens === 'number', 'usage.input_tokens is a number');
      assert(usage && typeof usage.output_tokens === 'number', 'usage.output_tokens is a number');
      if (usage) {
        log.info(`Tokens — input: ${usage.input_tokens}, output: ${usage.output_tokens}`);
        const cost = ((usage.input_tokens / 1e6) * 15 + (usage.output_tokens / 1e6) * 75).toFixed(4);
        log.info(`Estimated cost: $${cost}`);
      }
    } else {
      log.warn(`API error: ${ipcResult.error}`);
    }

    // ── TEST 4: Check main process logs for the handler ──
    log.step('TEST 4: Main process logged the API request');

    await new Promise(r => setTimeout(r, 1000)); // let logs flush
    const apiLog = mainProcessLogs.find(l => l.includes('[docs:api-request]'));
    assert(!!apiLog, 'Main process logged [docs:api-request]');
    if (apiLog) log.info(`Log: ${apiLog.slice(0, 120)}`);

    // ── Results ──
    console.log(`\n${'='.repeat(40)}`);
    console.log(`Passed: ${passed}  Failed: ${failed}`);
    if (failed > 0) process.exitCode = 1;

  } finally {
    await app.close();
  }
}

main().catch(err => { console.error(err.message); process.exit(1); });
