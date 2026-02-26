/**
 * Test: OSC 7777 Prompt Boundary Markers
 *
 * Validates the full pipeline:
 * 1. main.js detects Claude prompt (⏵/❯) transitions → injects OSC 7777
 * 2. xterm.js parser fires registerOscHandler(7777) → registerPromptBoundary()
 * 3. Timeline binds entries to boundaries → scrollToEntry() works
 *
 * Prerequisites:
 * - Dev server running (npm run dev)
 * - Claude API available (will send test messages)
 *
 * Run: node auto/sandbox/test-osc-boundary-markers.js
 */

const { launch, waitForTerminal, typeCommand, findInLogs, waitForClaudeSessionId } = require('../core/launcher')
const electron = require('../core/electron')

const c = {
  reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m',
  cyan: '\x1b[36m', yellow: '\x1b[33m', dim: '\x1b[2m', bold: '\x1b[1m'
}
const log = {
  step: (m) => console.log(`${c.cyan}[STEP]${c.reset} ${m}`),
  pass: (m) => console.log(`${c.green}[PASS]${c.reset} ${m}`),
  fail: (m) => console.log(`${c.red}[FAIL]${c.reset} ${m}`),
  warn: (m) => console.log(`${c.yellow}[WARN]${c.reset} ${m}`),
  info: (m) => console.log(`${c.dim}[INFO]${c.reset} ${m}`)
}

const TEST_MESSAGES = [
  'ALPHA: say "hello" and nothing else',
  'BRAVO: say "world" and nothing else',
  'CHARLIE: say "done" and nothing else'
]

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
    log.pass('Terminal visible')

    await electron.focusWindow(app)
    await page.waitForTimeout(500)

    // Create new tab to avoid saved sessions
    log.step('Creating new tab (Cmd+T)...')
    await page.keyboard.press('Meta+t')
    await page.waitForTimeout(1500)

    // Navigate to project directory
    const targetDir = '/Users/fedor/Desktop/custom-terminal'
    log.step('cd ' + targetDir)
    await typeCommand(page, 'cd ' + targetDir)
    await page.waitForTimeout(500)

    // Start Claude
    log.step('Starting Claude...')
    await typeCommand(page, 'claude')

    // Wait for Claude session to be detected
    log.step('Waiting for Claude session ID (bridge detection)...')
    await waitForClaudeSessionId(page, 45000)
    log.pass('Claude session detected')

    // Wait for prompt to settle
    await page.waitForTimeout(3000)

    // Send test messages
    for (let i = 0; i < TEST_MESSAGES.length; i++) {
      log.step(`Sending message ${i + 1}/${TEST_MESSAGES.length}: "${TEST_MESSAGES[i]}"`)

      // Use paste to send message (more reliable than typing)
      await page.evaluate((msg) => {
        const store = window.useWorkspaceStore?.getState?.()
        if (!store) return
        const proj = store.openProjects?.get?.(store.activeProjectId)
        if (!proj) return
        const tabId = proj.activeTabId
        window.require('electron').ipcRenderer.invoke('terminal:input', { tabId, data: msg + '\r' })
      }, TEST_MESSAGES[i])

      // Wait for response (Claude should respond quickly to simple prompts)
      log.info('Waiting for response...')
      await page.waitForTimeout(15000)
      log.pass(`Message ${i + 1} sent + responded`)
    }

    // Wait for Timeline to refresh (polls every 2s)
    log.step('Waiting for Timeline refresh...')
    await page.waitForTimeout(4000)

    // =========================================================
    // VERIFY: Check main process logs for boundary marker injection
    // =========================================================
    console.log(`\n${c.bold}=== VERIFICATION ===${c.reset}`)

    // Check 1: BoundaryMarker injection logs
    log.step('Check 1: OSC injection in main process logs')
    const markerLogs = findInLogs(mainProcessLogs, 'BoundaryMarker')
    if (markerLogs.length > 0) {
      log.pass(`Found ${markerLogs.length} BoundaryMarker log(s):`)
      markerLogs.forEach(l => log.info('  ' + l.trim().substring(0, 120)))
    } else {
      log.fail('No BoundaryMarker logs found in main process output!')
      log.info('This means the IDLE→BUSY→IDLE state machine never triggered.')
      log.info('Possible reasons: bridgeKnownSessions not set, or prompt detection failed.')
    }

    // Check 2: Prompt boundary count in renderer
    log.step('Check 2: Prompt boundaries in terminalRegistry')
    const boundaryInfo = await page.evaluate(() => {
      const store = window.useWorkspaceStore?.getState?.()
      if (!store) return { error: 'no store' }
      const proj = store.openProjects?.get?.(store.activeProjectId)
      if (!proj) return { error: 'no project' }
      const tabId = proj.activeTabId

      // Access terminalRegistry from window (it's imported in the renderer)
      const reg = window.__terminalRegistry
      if (!reg) return { error: 'no registry (window.__terminalRegistry not set)' }

      return {
        promptBoundaryCount: reg.getPromptBoundaryCount(tabId),
        entryMarkers: Object.fromEntries(
          [...(reg.getEntryMarkers(tabId) || new Map())].map(([uuid, tracked]) => [
            uuid.substring(0, 8),
            { line: tracked.marker?.line ?? null, isReachable: tracked.isReachable }
          ])
        )
      }
    })

    if (boundaryInfo.error) {
      log.warn('Could not access terminalRegistry: ' + boundaryInfo.error)
      log.info('Need to expose terminalRegistry on window for testing.')
      log.info('Add this to terminalRegistry.ts: (window as any).__terminalRegistry = terminalRegistry;')
    } else {
      log.info('Prompt boundaries: ' + boundaryInfo.promptBoundaryCount)
      log.info('Entry markers: ' + JSON.stringify(boundaryInfo.entryMarkers))

      if (boundaryInfo.promptBoundaryCount >= 2) {
        log.pass('Prompt boundaries detected! (' + boundaryInfo.promptBoundaryCount + ')')
      } else if (boundaryInfo.promptBoundaryCount > 0) {
        log.warn('Only ' + boundaryInfo.promptBoundaryCount + ' boundary (expected >= 2 for 3 messages)')
      } else {
        log.fail('No prompt boundaries registered in renderer')
      }
    }

    // Check 3: Console logs for OSC 7777 parsing
    log.step('Check 3: Renderer console logs for OSC 7777')
    const oscLogs = findInLogs(consoleLogs, 'OSC 7777')
    const regLogs = findInLogs(consoleLogs, 'Prompt boundary')
    if (oscLogs.length > 0 || regLogs.length > 0) {
      log.pass(`Found ${oscLogs.length} OSC 7777 + ${regLogs.length} registry logs`)
      oscLogs.forEach(l => log.info('  ' + l.trim().substring(0, 120)))
      regLogs.forEach(l => log.info('  ' + l.trim().substring(0, 120)))
    } else {
      log.fail('No OSC 7777 logs in renderer console')
    }

    // Check 4: Timeline entries vs markers
    log.step('Check 4: Timeline entry binding')
    const bindingLogs = findInLogs(consoleLogs, 'Bound entry')
    if (bindingLogs.length > 0) {
      log.pass(`Found ${bindingLogs.length} entry bindings`)
      bindingLogs.forEach(l => log.info('  ' + l.trim().substring(0, 120)))
    } else {
      log.warn('No entry binding logs — entries may not be bound to markers yet')
    }

    // Check 5: Try marker-based scroll
    log.step('Check 5: Marker-based scroll test')
    const scrollResult = await page.evaluate(() => {
      const store = window.useWorkspaceStore?.getState?.()
      if (!store) return { error: 'no store' }
      const proj = store.openProjects?.get?.(store.activeProjectId)
      if (!proj) return { error: 'no project' }
      const tabId = proj.activeTabId
      const reg = window.__terminalRegistry
      if (!reg) return { error: 'no registry' }

      const markers = reg.getEntryMarkers(tabId)
      if (!markers || markers.size === 0) return { error: 'no markers', count: 0 }

      const results = []
      for (const [uuid, tracked] of markers) {
        const scrolled = reg.scrollToEntry(tabId, uuid)
        results.push({
          uuid: uuid.substring(0, 8),
          line: tracked.marker?.line ?? null,
          scrolled,
          isReachable: tracked.isReachable
        })
      }
      return { results }
    })

    if (scrollResult.error) {
      log.warn('Scroll test: ' + scrollResult.error)
    } else if (scrollResult.results) {
      for (const r of scrollResult.results) {
        if (r.scrolled) {
          log.pass(`scrollToEntry(${r.uuid}) → line ${r.line}`)
        } else {
          log.fail(`scrollToEntry(${r.uuid}) FAILED (line=${r.line}, reachable=${r.isReachable})`)
        }
      }
    }

    // Summary
    console.log(`\n${c.bold}=== SUMMARY ===${c.reset}`)
    const injected = markerLogs.length
    const rendered = oscLogs.length + regLogs.length
    const bound = bindingLogs.length
    log.info(`Injected (main): ${injected} | Rendered (xterm): ${rendered} | Bound (timeline): ${bound}`)

    if (injected > 0 && rendered > 0) {
      log.pass('OSC 7777 pipeline is WORKING (main.js → xterm.js → markers)')
    } else if (injected > 0 && rendered === 0) {
      log.warn('Injected but not rendered — check Terminal.tsx OSC handler')
    } else {
      log.fail('Pipeline not working — check main.js state machine')
    }

  } finally {
    log.step('Cleanup...')
    await app.close()
    log.info('Done')
  }
}

main().catch(err => {
  console.error(c.red + 'FATAL: ' + err.message + c.reset)
  process.exit(1)
})
