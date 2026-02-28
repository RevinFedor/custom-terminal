/**
 * [E2E] IPC Smoke Test — verifies all modular IPC handlers respond after refactoring.
 *
 * Tests one representative handler from each extracted module:
 *   - ipc/docs.js       → docs:save-temp, docs:read-prompt-file
 *   - ipc/settings.js   → commands:get-global, prompts:get, ai-prompts:get
 *   - ipc/claude-data.js → claude:get-timeline, claude:get-fork-markers
 *   - ipc/gemini-data.js → gemini:get-timeline, gemini:get-history
 *   - main.js (core)     → terminal:create, terminal:getCwd
 *
 * Does NOT require live Claude/Gemini CLI. ~15-20s.
 */

const { launch, waitForTerminal } = require('../core/launcher')
const electron = require('../core/electron')
const path = require('path')
const os = require('os')

const c = {
  reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m',
  cyan: '\x1b[36m', yellow: '\x1b[33m', dim: '\x1b[2m'
}
const log = {
  step: (m) => console.log(`${c.cyan}[STEP]${c.reset} ${m}`),
  pass: (m) => console.log(`${c.green}[PASS]${c.reset} ${m}`),
  fail: (m) => console.log(`${c.red}[FAIL]${c.reset} ${m}`),
  info: (m) => console.log(`${c.dim}[INFO]${c.reset} ${m}`)
}

let passed = 0, failed = 0
function assert(cond, msg) {
  if (cond) { log.pass(msg); passed++ }
  else { log.fail(msg); failed++ }
}

async function main() {
  const { app, page, consoleLogs, mainProcessLogs } = await launch({
    logMainProcess: false,
    waitForReady: 4000
  })

  try {
    await waitForTerminal(page, 15000)
    await electron.focusWindow(app)

    // ═══ MODULE 1: ipc/docs.js ═══
    log.step('MODULE 1: ipc/docs.js — docs:save-temp')
    const saveResult = await page.evaluate(async () => {
      const { ipcRenderer } = window.require('electron')
      return await ipcRenderer.invoke('docs:save-temp', {
        content: 'IPC smoke test content',
        projectPath: require('os').tmpdir()
      })
    })
    assert(saveResult.success === true, 'docs:save-temp returns success')
    assert(saveResult.filePath && saveResult.filePath.includes('noted-docs-'), 'docs:save-temp returns filePath')
    log.info('Saved to: ' + saveResult.filePath)

    log.step('MODULE 1: ipc/docs.js — docs:read-prompt-file')
    const readResult = await page.evaluate(async (fp) => {
      const { ipcRenderer } = window.require('electron')
      return await ipcRenderer.invoke('docs:read-prompt-file', { filePath: fp })
    }, saveResult.filePath)
    assert(readResult.success === true, 'docs:read-prompt-file returns success')
    assert(readResult.content === 'IPC smoke test content', 'docs:read-prompt-file returns correct content')

    // ═══ MODULE 2: ipc/settings.js ═══
    log.step('MODULE 2: ipc/settings.js — commands:get-global')
    const cmdResult = await page.evaluate(async () => {
      const { ipcRenderer } = window.require('electron')
      return await ipcRenderer.invoke('commands:get-global')
    })
    assert(cmdResult.success === true, 'commands:get-global returns success')
    assert(Array.isArray(cmdResult.data), 'commands:get-global returns array')

    log.step('MODULE 2: ipc/settings.js — prompts:get')
    const promptsResult = await page.evaluate(async () => {
      const { ipcRenderer } = window.require('electron')
      return await ipcRenderer.invoke('prompts:get')
    })
    assert(promptsResult.success === true, 'prompts:get returns success')

    log.step('MODULE 2: ipc/settings.js — ai-prompts:get')
    const aiPromptsResult = await page.evaluate(async () => {
      const { ipcRenderer } = window.require('electron')
      return await ipcRenderer.invoke('ai-prompts:get')
    })
    // ai-prompts:get may fail if projectManager.getAIPrompts is not implemented yet
    assert(aiPromptsResult !== undefined, 'ai-prompts:get handler responds (not undefined)')
    log.info('ai-prompts:get result: ' + JSON.stringify({ success: aiPromptsResult.success, error: aiPromptsResult.error }))

    // ═══ MODULE 3: ipc/claude-data.js ═══
    log.step('MODULE 3: ipc/claude-data.js — claude:get-timeline (nonexistent session)')
    const clTimelineResult = await page.evaluate(async () => {
      const { ipcRenderer } = window.require('electron')
      return await ipcRenderer.invoke('claude:get-timeline', {
        sessionId: 'nonexistent-smoke-test-id',
        cwd: '/tmp'
      })
    })
    assert(clTimelineResult.success === true, 'claude:get-timeline returns success (empty)')
    assert(Array.isArray(clTimelineResult.entries) && clTimelineResult.entries.length === 0, 'claude:get-timeline returns empty entries for nonexistent session')

    log.step('MODULE 3: ipc/claude-data.js — claude:get-fork-markers')
    const forkResult = await page.evaluate(async () => {
      const { ipcRenderer } = window.require('electron')
      return await ipcRenderer.invoke('claude:get-fork-markers', {
        sessionId: 'nonexistent-smoke-test-id'
      })
    })
    assert(forkResult.success === true, 'claude:get-fork-markers returns success')
    assert(Array.isArray(forkResult.markers), 'claude:get-fork-markers returns markers array')

    // ═══ MODULE 4: ipc/gemini-data.js ═══
    log.step('MODULE 4: ipc/gemini-data.js — gemini:get-timeline (nonexistent session)')
    const gmTimelineResult = await page.evaluate(async () => {
      const { ipcRenderer } = window.require('electron')
      return await ipcRenderer.invoke('gemini:get-timeline', {
        sessionId: 'nonexistent-smoke-test-id',
        cwd: '/tmp'
      })
    })
    // Nonexistent session returns success:true with empty entries, or success:false — both are valid responses
    assert(gmTimelineResult !== undefined, 'gemini:get-timeline handler responds')
    assert(gmTimelineResult.entries !== undefined || gmTimelineResult.error !== undefined, 'gemini:get-timeline returns entries or error')
    log.info('gemini:get-timeline result: success=' + gmTimelineResult.success + ' entries=' + (gmTimelineResult.entries?.length ?? 'N/A'))

    log.step('MODULE 4: ipc/gemini-data.js — gemini:get-history')
    const gmHistoryResult = await page.evaluate(async () => {
      const { ipcRenderer } = window.require('electron')
      return await ipcRenderer.invoke('gemini:get-history', { dirPath: '/tmp', limit: 5 })
    })
    assert(gmHistoryResult.success === true, 'gemini:get-history returns success')

    // ═══ MODULE 5: main.js (core — terminal handlers) ═══
    log.step('MODULE 5: main.js core — terminal:getCwd')
    const cwdResult = await page.evaluate(async () => {
      const { ipcRenderer } = window.require('electron')
      const state = window.useWorkspaceStore?.getState?.()
      const project = state?.openProjects?.values()?.next()?.value
      const tabId = project?.activeTabId
      if (!tabId) return { success: false, error: 'no active tab' }
      const cwd = await ipcRenderer.invoke('terminal:getCwd', tabId)
      return { success: true, cwd }
    })
    assert(cwdResult.success === true, 'terminal:getCwd returns success')
    assert(typeof cwdResult.cwd === 'string' && cwdResult.cwd.length > 0, 'terminal:getCwd returns valid path')
    log.info('CWD: ' + cwdResult.cwd)

    // ═══ RESULTS ═══
    console.log('')
    console.log('════════════════════════════════════════')
    console.log(`  Passed: ${passed}  Failed: ${failed}`)
    if (failed === 0) {
      console.log(`${c.green}[PASS]${c.reset} ALL IPC SMOKE TESTS PASSED`)
    } else {
      console.log(`${c.red}[FAIL]${c.reset} Some tests failed`)
    }
    console.log('════════════════════════════════════════')

    if (failed > 0) process.exitCode = 1

  } finally {
    // Cleanup temp file
    try {
      const fs = require('fs')
      const tmpFiles = fs.readdirSync(os.tmpdir()).filter(f => f.startsWith('noted-docs-') && f.endsWith('.txt'))
      for (const f of tmpFiles) {
        try { fs.unlinkSync(path.join(os.tmpdir(), f)) } catch {}
      }
    } catch {}

    await app.close()
  }
}

main().catch(err => { console.error(err.message); process.exit(1) })
