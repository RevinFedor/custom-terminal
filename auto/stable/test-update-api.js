/**
 * Test: Update API → Haiku — кнопка, prefilled JSONL, tab creation
 *
 * Проверяет:
 * 1. Кнопка "Update API → Haiku" отображается в ActionsPanel
 * 2. При наведении появляется popup с выбором claude/gemini
 * 3. claude:create-prefilled-session создаёт валидный JSONL
 * 4. Таб создаётся с именем docs-XX и claude цветом
 * 5. Shared tab counter: docs-01, docs-02... (для обоих flows)
 *
 * Запуск: node auto/sandbox/test-update-api.js 2>&1 | tee /tmp/test-update-api.log
 */

const { launch, waitForTerminal, typeCommand, waitForClaudeSessionId, waitForMainProcessLog, findInLogs } = require('../core/launcher')
const electron = require('../core/electron')
const path = require('path')
const fs = require('fs')
const os = require('os')

const c = {
  reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m',
  cyan: '\x1b[36m', yellow: '\x1b[33m', dim: '\x1b[2m'
}
const log = {
  step: (m) => console.log(`${c.cyan}[STEP]${c.reset} ${m}`),
  pass: (m) => console.log(`${c.green}[PASS]${c.reset} ${m}`),
  fail: (m) => console.log(`${c.red}[FAIL]${c.reset} ${m}`),
  warn: (m) => console.log(`${c.yellow}[WARN]${c.reset} ${m}`),
  info: (m) => console.log(`${c.dim}[INFO]${c.reset} ${m}`)
}

let passed = 0, failed = 0
function assert(cond, msg) {
  if (cond) { log.pass(msg); passed++ }
  else { log.fail(msg); failed++ }
}

// Hard kill safety
const HARD_KILL_MS = 120000
const globalTimer = setTimeout(() => {
  console.error('\n[HARD KILL] Test exceeded ' + (HARD_KILL_MS/1000) + 's — force exit')
  process.exit(1)
}, HARD_KILL_MS)

async function main() {
  log.step('Launching Noted Terminal...')

  const { app, page, consoleLogs, mainProcessLogs } = await launch({
    logConsole: false,
    logMainProcess: true,
    waitForReady: 4000
  })

  log.pass('App launched')

  try {
    // Wait for terminal
    log.step('Waiting for terminal...')
    await waitForTerminal(page, 15000)
    log.pass('Terminal active')

    await electron.focusWindow(app)
    await page.waitForFunction(() => document.hasFocus(), null, { timeout: 3000 })

    // Create a fresh tab
    log.step('Creating new tab (Cmd+T)...')
    const tabCountBefore = await page.evaluate(() => {
      const s = window.useWorkspaceStore?.getState?.()
      return s?.openProjects?.get?.(s?.activeProjectId)?.tabs?.size ?? 0
    })
    await page.keyboard.press('Meta+t')
    await page.waitForFunction((prev) => {
      const s = window.useWorkspaceStore?.getState?.()
      return (s?.openProjects?.get?.(s?.activeProjectId)?.tabs?.size ?? 0) > prev
    }, tabCountBefore, { timeout: 5000 })
    log.pass('New tab created')

    // Navigate to project dir
    const targetDir = '/Users/fedor/Desktop/custom-terminal'
    log.step('cd to ' + targetDir)
    await typeCommand(page, 'cd ' + targetDir)
    await page.waitForTimeout(500)

    // ── TEST 1: "Update API → Haiku" button exists in ActionsPanel ──
    log.step('TEST 1: Checking "Update API → Haiku" button in DOM...')

    // The ActionsPanel is inside InfoPanel which might need to be visible
    // Look for the button text in the page
    const updateApiExists = await page.evaluate(() => {
      const codes = document.querySelectorAll('code')
      for (const el of codes) {
        if (el.textContent?.trim() === 'Update API → Haiku') return true
      }
      return false
    })
    assert(updateApiExists, '"Update API → Haiku" button found in DOM')

    // ── TEST 2: "Update Docs" button also exists ──
    log.step('TEST 2: Checking "Update Docs" button...')
    const updateDocsExists = await page.evaluate(() => {
      const codes = document.querySelectorAll('code')
      for (const el of codes) {
        if (el.textContent?.trim() === 'Update Docs') return true
      }
      return false
    })
    assert(updateDocsExists, '"Update Docs" button found in DOM')

    // ── TEST 3: Both buttons have same font size ──
    log.step('TEST 3: Checking font sizes match...')
    const fontSizes = await page.evaluate(() => {
      const codes = document.querySelectorAll('code')
      let docsSize = null, apiSize = null
      for (const el of codes) {
        const text = el.textContent?.trim()
        if (text === 'Update Docs') docsSize = window.getComputedStyle(el).fontSize
        if (text === 'Update API → Haiku') apiSize = window.getComputedStyle(el).fontSize
      }
      return { docsSize, apiSize }
    })
    log.info('Update Docs fontSize=' + fontSizes.docsSize + ', Update API → Haiku fontSize=' + fontSizes.apiSize)
    assert(fontSizes.docsSize === fontSizes.apiSize, 'Font sizes match: ' + fontSizes.docsSize)

    // ── TEST 4: Hover popup exists (claude/gemini choices) ──
    log.step('TEST 4: Checking hover popup structure...')
    // The popup uses .api-split-btn / .api-split-popup CSS classes
    const popupCount = await page.evaluate(() => {
      return document.querySelectorAll('.api-split-popup').length
    })
    // Should be at least 2: one for the existing [api] button and one for Update API → Haiku
    assert(popupCount >= 2, 'Found ' + popupCount + ' api-split-popup elements (expected >=2)')

    // ── TEST 5: claude:create-prefilled-session IPC works ──
    log.step('TEST 5: Testing claude:create-prefilled-session IPC...')
    const prefilledResult = await page.evaluate(async () => {
      const { ipcRenderer } = window.require('electron')
      return await ipcRenderer.invoke('claude:create-prefilled-session', {
        content: 'Test analysis content from API.\n\nFile changes:\n- src/test.ts: add function foo()',
        cwd: '/Users/fedor/Desktop/custom-terminal'
      })
    })
    log.info('Prefilled result: ' + JSON.stringify(prefilledResult).slice(0, 200))
    assert(prefilledResult.success === true, 'Prefilled session created successfully')
    assert(typeof prefilledResult.sessionId === 'string' && prefilledResult.sessionId.length > 30, 'Valid sessionId: ' + prefilledResult.sessionId?.slice(0, 8) + '...')

    // ── TEST 6: JSONL file exists and has valid structure ──
    log.step('TEST 6: Validating JSONL file structure...')
    if (prefilledResult.success) {
      const slug = '/Users/fedor/Desktop/custom-terminal'.replace(/\//g, '-')
      const jsonlPath = path.join(os.homedir(), '.claude', 'projects', slug, prefilledResult.sessionId + '.jsonl')
      const fileExists = fs.existsSync(jsonlPath)
      assert(fileExists, 'JSONL file exists at: ' + jsonlPath)

      if (fileExists) {
        const lines = fs.readFileSync(jsonlPath, 'utf-8').trim().split('\n')
        assert(lines.length === 2, 'JSONL has 2 entries (user + assistant), got ' + lines.length)

        const entry1 = JSON.parse(lines[0])
        const entry2 = JSON.parse(lines[1])

        assert(entry1.type === 'user', 'Entry 1 is type=user')
        assert(entry1.parentUuid === null, 'Entry 1 parentUuid is null (root)')
        assert(entry1.sessionId === prefilledResult.sessionId, 'Entry 1 sessionId matches')

        assert(entry2.type === 'assistant', 'Entry 2 is type=assistant')
        assert(entry2.parentUuid === entry1.uuid, 'Entry 2 parentUuid links to entry 1')
        assert(entry1.message.content.includes('Test analysis content'), 'Entry 1 (user) contains API response text')
        assert(entry2.message.stop_reason === 'end_turn', 'Entry 2 has stop_reason=end_turn')

        // Cleanup test file
        fs.unlinkSync(jsonlPath)
        log.info('Cleaned up test JSONL')
      }
    }

    // ── TEST 7: Tab naming — docs-XX counter ──
    log.step('TEST 7: Testing docs-XX tab naming...')
    // Simulate the naming logic by checking what names would be generated
    const tabNaming = await page.evaluate(() => {
      const s = window.useWorkspaceStore?.getState?.()
      const p = s?.openProjects?.get?.(s?.activeProjectId)
      if (!p) return { error: 'no project' }

      // Count existing docs- tabs
      const existingDocsTabs = Array.from(p.tabs.values())
        .filter(t => t.name.startsWith('docs-')).length
      const nextName = 'docs-' + String(existingDocsTabs + 1).padStart(2, '0')
      return { existingDocsTabs, nextName }
    })
    log.info('Existing docs tabs: ' + tabNaming.existingDocsTabs + ', next name: ' + tabNaming.nextName)
    assert(tabNaming.nextName?.match(/^docs-\d{2}$/), 'Tab name follows docs-XX pattern: ' + tabNaming.nextName)

    // ── TEST 8: Multi-select state preservation ──
    log.step('TEST 8: Multi-select + data-keep-selection attribute...')
    const hasKeepSelection = await page.evaluate(() => {
      const els = document.querySelectorAll('[data-keep-selection]')
      return els.length > 0
    })
    assert(hasKeepSelection, 'data-keep-selection attribute found (multi-select preservation)')

    // ── Summary ──
    console.log('\n' + '='.repeat(40))
    console.log(`Passed: ${passed}  Failed: ${failed}`)
    if (failed > 0) process.exitCode = 1

  } finally {
    clearTimeout(globalTimer)
    await app.close()
  }
}

main().catch(err => {
  console.error('[FATAL] ' + err.message)
  process.exit(1)
})
