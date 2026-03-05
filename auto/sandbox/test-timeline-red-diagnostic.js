/**
 * Diagnostic Test: Timeline Red Entries
 *
 * Запускает Claude (--resume), ждёт response, собирает:
 * - Скриншот
 * - promptBoundaries state
 * - Timeline entry count & colors
 * - Main process BoundaryMarker logs
 *
 * [E2E+Claude] Требует: npm run dev + npx electron-vite build + claude CLI
 * Запуск: node auto/sandbox/test-timeline-red-diagnostic.js 2>&1 | tee /tmp/test-red-diag.log
 */

const { launch, waitForTerminal, typeCommand, waitForClaudeSessionId, waitForMainProcessLog, findInLogs } = require('../core/launcher')
const electron = require('../core/electron')
const path = require('path')
const fs = require('fs')

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

// Hard kill after 180s
const globalTimer = setTimeout(() => {
  console.error('\n[HARD KILL] 180s timeout reached')
  process.exit(1)
}, 180000)

// Find a real Claude session to resume (to avoid permissions prompt)
function findRecentClaudeSession() {
  const claudeDir = path.join(require('os').homedir(), '.claude', 'projects')
  if (!fs.existsSync(claudeDir)) return null

  // Look in the custom-terminal project slug
  const slugs = fs.readdirSync(claudeDir)
  for (const slug of slugs) {
    if (!slug.includes('custom-terminal')) continue
    const slugDir = path.join(claudeDir, slug)
    if (!fs.statSync(slugDir).isDirectory()) continue

    const files = fs.readdirSync(slugDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(slugDir, f)).mtime }))
      .sort((a, b) => b.mtime - a.mtime)

    if (files.length > 0) {
      return files[0].name.replace('.jsonl', '')
    }
  }
  return null
}

async function withTimeout(promise, ms, label) {
  const result = await Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label}: timeout ${ms}ms`)), ms))
  ])
  return result
}

async function main() {
  // Find a session to resume
  const sessionId = findRecentClaudeSession()
  log.info(`Using session: ${sessionId || 'NONE (will start fresh)'}`)

  log.step('Запуск Noted Terminal...')
  const { app, page, consoleLogs, mainProcessLogs } = await launch({
    logConsole: false,
    logMainProcess: true,  // enable to see BoundaryDiag logs
    waitForReady: 4000
  })

  try {
    await waitForTerminal(page, 15000)
    await electron.focusWindow(app)
    await page.waitForFunction(() => document.hasFocus(), null, { timeout: 3000 })
    log.pass('App ready')

    // Create fresh tab
    log.step('Creating new tab...')
    const tabCountBefore = await page.evaluate(() => {
      const s = window.useWorkspaceStore?.getState?.()
      const p = s?.openProjects?.get?.(s?.activeProjectId)
      return p?.tabs?.size ?? 0
    })
    await page.keyboard.press('Meta+t')
    await page.waitForFunction((prev) => {
      const s = window.useWorkspaceStore?.getState?.()
      const p = s?.openProjects?.get?.(s?.activeProjectId)
      return (p?.tabs?.size ?? 0) > prev
    }, tabCountBefore, { timeout: 5000 })
    log.pass('New tab created')

    // cd to project dir
    log.step('cd to project dir...')
    await typeCommand(page, 'cd /Users/fedor/Desktop/custom-terminal')
    await page.waitForFunction(() => {
      const s = window.useWorkspaceStore?.getState?.()
      const p = s?.openProjects?.get?.(s?.activeProjectId)
      const tab = p?.tabs?.get?.(p?.activeTabId)
      return tab?.cwd?.includes?.('custom-terminal')
    }, null, { timeout: 5000 })
    log.pass('CWD set')

    // Start claude with --resume to skip permissions prompt
    const claudeCmd = sessionId
      ? `claude --resume ${sessionId} --dangerously-skip-permissions`
      : 'claude --dangerously-skip-permissions'
    log.step(`Starting Claude: ${claudeCmd.slice(0, 60)}...`)
    await typeCommand(page, claudeCmd)

    // Wait for Claude session ID in store
    log.step('Waiting for Claude sessionId in store...')
    try {
      await withTimeout(waitForClaudeSessionId(page, 60000), 60000, 'waitForClaudeSessionId')
      const sid = await page.evaluate(() => {
        const s = window.useWorkspaceStore?.getState?.()
        const p = s?.openProjects?.get?.(s?.activeProjectId)
        return p?.tabs?.get?.(p?.activeTabId)?.claudeSessionId
      })
      log.pass(`Session detected: ${sid?.slice(0, 8)}...`)
    } catch (e) {
      log.fail(`Session detection failed: ${e.message}`)
    }

    // Wait for initial IDLE (Claude ready for input)
    log.step('Waiting for Spinner IDLE (Claude ready)...')
    const idleLog = await waitForMainProcessLog(mainProcessLogs, /Spinner.*IDLE/, 45000)
    if (idleLog) {
      log.pass(`Spinner IDLE: ${idleLog.trim().slice(0, 100)}`)
    } else {
      log.fail('Spinner IDLE never appeared in 45s')
      // Dump last 20 main process logs for diagnosis
      log.info('Last 20 main process logs:')
      mainProcessLogs.slice(-20).forEach(l => {
        const trimmed = l.trim().slice(0, 200)
        if (trimmed) log.info(trimmed)
      })
    }

    // Get current tab ID for precise log matching
    const tabId = await page.evaluate(() => {
      const s = window.useWorkspaceStore?.getState?.()
      const p = s?.openProjects?.get?.(s?.activeProjectId)
      return p?.activeTabId
    })
    log.info(`Active tabId: ${tabId}`)

    // Check bridge detection
    const bridgeLogs = findInLogs(mainProcessLogs, 'Bridge')
    const bridgeForTab = bridgeLogs.filter(l => l.includes(tabId?.slice(-10) || 'xxx'))
    log.info(`Bridge logs for this tab: ${bridgeForTab.length}`)
    bridgeForTab.slice(0, 3).forEach(l => log.info(l.trim().slice(0, 200)))

    // Send a message
    log.step('Sending message to Claude...')
    await page.evaluate((tid) => {
      window.require('electron').ipcRenderer.send('terminal:paste', tid, 'say "hello world test 123"')
    }, tabId)
    await page.waitForTimeout(300)
    await page.keyboard.press('Enter')

    // Wait for BUSY
    log.step('Waiting for Spinner BUSY...')
    const busyLog = await waitForMainProcessLog(mainProcessLogs, /Spinner.*BUSY/, 30000)
    if (busyLog) {
      log.pass(`Spinner BUSY detected`)
    } else {
      log.fail('Spinner BUSY never appeared')
    }

    // Wait for response IDLE
    log.step('Waiting for response (Spinner IDLE)...')
    const responseLog = await waitForMainProcessLog(mainProcessLogs, /Spinner.*IDLE/, 60000)
    if (responseLog) {
      log.pass(`Spinner IDLE (response done)`)
    } else {
      log.fail('Spinner response IDLE never appeared')
    }

    // Wait for timeline to load
    await page.waitForTimeout(3000)

    // === COLLECT ALL DIAGNOSTICS ===

    // Screenshot
    const ssDir = path.join(__dirname, '..', 'screenshots')
    if (!fs.existsSync(ssDir)) fs.mkdirSync(ssDir, { recursive: true })
    const ssPath = path.join(ssDir, 'timeline-red-diagnostic.png')
    await page.screenshot({ path: ssPath })
    log.step(`Screenshot: ${ssPath}`)

    // Registry state
    const reg = await page.evaluate(() => {
      const r = window.__terminalRegistry
      if (!r) return { error: 'no registry' }
      const s = window.useWorkspaceStore?.getState?.()
      const p = s?.openProjects?.get?.(s?.activeProjectId)
      const tid = p?.activeTabId
      return {
        tabId: tid,
        hasTerm: !!r.get(tid),
        boundaryCount: r.getPromptBoundaryCount(tid),
        boundaryLines: r.getPromptBoundaryLines(tid),
        entryMarkerCount: r.getEntryMarkers(tid)?.size ?? 0,
        viewport: r.getViewportState(tid)
      }
    })
    console.log('\n--- REGISTRY STATE ---')
    console.log(JSON.stringify(reg, null, 2))

    assert(reg.boundaryCount > 0, `Prompt boundaries: ${reg.boundaryCount} (need > 0 for non-red timeline)`)

    // Timeline entries
    const entries = await page.evaluate(async () => {
      const s = window.useWorkspaceStore?.getState?.()
      const p = s?.openProjects?.get?.(s?.activeProjectId)
      const tab = p?.tabs?.get?.(p?.activeTabId)
      if (!tab?.claudeSessionId) return { error: 'no session' }
      const ipc = window.require('electron').ipcRenderer
      try {
        const e = await ipc.invoke('claude:get-timeline', tab.claudeSessionId, tab.cwd)
        return { count: e?.length ?? 0, first3: (e||[]).slice(0, 3).map(x => ({ type: x.type, content: (x.content||'').slice(0,40) })) }
      } catch (err) {
        return { error: err.message }
      }
    })
    console.log('--- TIMELINE ENTRIES ---')
    console.log(JSON.stringify(entries, null, 2))
    assert((entries.count || 0) > 0, `Timeline entries: ${entries.count}`)

    // DOM dots and red segments
    const dom = await page.evaluate(() => {
      const allDivs = document.querySelectorAll('div')
      let dots = 0, redSegments = 0
      for (const div of allDivs) {
        const s = window.getComputedStyle(div)
        if (s.borderRadius === '50%' && parseInt(s.width) <= 12) dots++
        const bg = s.backgroundColor
        if (bg.includes('239') && bg.includes('68')) redSegments++
      }
      return { dots, redSegments }
    })
    console.log('--- DOM STATE ---')
    console.log(JSON.stringify(dom, null, 2))
    assert(dom.dots > 0, `Timeline dots in DOM: ${dom.dots}`)
    assert(dom.redSegments === 0, `Red segments: ${dom.redSegments} (should be 0)`)

    // Main process diagnostic logs
    console.log('\n--- KEY MAIN PROCESS LOGS ---')
    const patterns = ['BoundaryMarker', 'Spinner', 'Bridge', 'Sniper', 'claude:session']
    for (const pat of patterns) {
      const logs = findInLogs(mainProcessLogs, pat)
      console.log(`[${pat}]: ${logs.length} entries`)
      logs.slice(0, 3).forEach(l => log.info(l.trim().slice(0, 200)))
    }

    // Renderer boundary logs
    console.log('\n--- RENDERER LOGS ---')
    const rLogs = findInLogs(consoleLogs, 'oundary')
    console.log(`Prompt boundary logs: ${rLogs.length}`)
    rLogs.forEach(l => log.info(l.trim().slice(0, 200)))

    const rOsc = findInLogs(consoleLogs, '7777')
    console.log(`OSC 7777 logs: ${rOsc.length}`)
    rOsc.forEach(l => log.info(l.trim().slice(0, 200)))

    // Summary
    console.log(`\n${'═'.repeat(50)}`)
    console.log(`  Passed: ${passed}  Failed: ${failed}`)
    console.log(`${'═'.repeat(50)}`)
    if (failed > 0) process.exitCode = 1

  } finally {
    clearTimeout(globalTimer)
    await app.close()
  }
}

main().catch(err => {
  console.error(err.message)
  console.error(err.stack)
  process.exit(1)
})
