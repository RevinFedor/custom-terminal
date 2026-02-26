/**
 * Test: Gemini Timeline Click — scroll to entry in real TUI buffer
 *
 * Forks real Gemini session 705fcd97, waits for TUI to render,
 * then tests scrollToTextInBuffer for each timeline entry against
 * the REAL xterm buffer content.
 *
 * This catches bugs that standalone tests miss (e.g., Gemini TUI
 * truncating long messages, adding "> " prefixes, etc.)
 *
 * Run: node auto/sandbox/test-gemini-scroll-click.js
 * Requires: npm run dev running on localhost:5182
 */

const { waitForTerminal, typeCommand, waitForGeminiSessionId, findInLogs } = require('../core/launcher')
const electronHelper = require('../core/electron')
const { _electron: playwright } = require('playwright')
const http = require('http')
const os = require('os')
const fs = require('fs')
const path = require('path')

const SOURCE_SESSION_ID = '705fcd97-97a5-491a-a830-1e05c76c327f'
const TEST_CWD = '/Users/fedor'

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
function assert(condition, message) {
  if (condition) { log.pass(message); passed++ }
  else { log.fail(message); failed++ }
}

// Custom launch with isolated user-data-dir to avoid SQLite lock conflicts
// with the main running Noted Terminal instance.
// Root cause: better-sqlite3 WAL mode blocks concurrent writers.
// Two Electron instances sharing the same DB path → test hangs on Database init.
async function launchIsolated() {
  const devServerUrl = 'http://localhost:5182'
  const appPath = path.join(__dirname, '..', '..')

  // Verify dev server
  const ok = await new Promise(r => http.get(devServerUrl, () => r(true)).on('error', () => r(false)))
  if (!ok) throw new Error('Dev server not running on ' + devServerUrl)

  // Copy user-data-dir from main app to avoid SQLite lock conflicts
  // (better-sqlite3 WAL mode blocks concurrent writers on same file)
  const sourceDir = path.join(os.homedir(), 'Library', 'Application Support', 'noted-terminal')
  const tmpDir = path.join(os.tmpdir(), 'noted-terminal-test-' + Date.now())
  fs.cpSync(sourceDir, tmpDir, { recursive: true })
  // Remove lock files from copied dir
  for (const f of ['noted-terminal-dev.db-shm', 'noted-terminal-dev.db-wal',
                     'noted-terminal.db-shm', 'noted-terminal.db-wal']) {
    try { fs.unlinkSync(path.join(tmpDir, f)) } catch {}
  }
  log.info('Isolated userData (copy): ' + tmpDir)

  const { CLAUDECODE, ...cleanEnv } = process.env

  const app = await playwright.launch({
    args: [appPath, '--user-data-dir=' + tmpDir],
    timeout: 45000,
    env: {
      ...cleanEnv,
      NODE_ENV: 'development',
      VITE_DEV_SERVER_URL: devServerUrl
    }
  })

  const consoleLogs = []
  const mainProcessLogs = []

  app.process().stdout?.on('data', d => mainProcessLogs.push(d.toString()))
  app.process().stderr?.on('data', d => mainProcessLogs.push(d.toString()))

  // Get main window (skip DevTools)
  let page = null
  for (const win of await app.windows()) {
    if (!(await win.url()).includes('devtools://')) { page = win; break }
  }
  if (!page) {
    page = await app.waitForEvent('window', {
      predicate: async w => !(await w.url()).includes('devtools://'),
      timeout: 30000
    })
  }

  page.on('console', msg => consoleLogs.push(`[${msg.type()}] ${msg.text()}`))
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.waitForTimeout(4000)

  return { app, page, consoleLogs, mainProcessLogs, tmpDir }
}

async function main() {
  log.step('Launching Noted Terminal (isolated user-data-dir)...')
  const { app, page, consoleLogs, mainProcessLogs, tmpDir } = await launchIsolated()

  try {
    await waitForTerminal(page, 15000)
    await electronHelper.focusWindow(app)
    await page.waitForTimeout(500)
    log.pass('Terminal ready')

    // ═══════════════════════════════════════════════════════════
    // SETUP: Create new tab, cd to /Users/fedor, fork session
    // ═══════════════════════════════════════════════════════════

    log.step(`cd ${TEST_CWD}`)
    await typeCommand(page, `cd ${TEST_CWD}`)
    await page.waitForTimeout(500)

    // Fork the session via IPC (creates new file + runs gemini -r)
    log.step('Forking Gemini session via gemini-f...')
    await page.evaluate(({ sessionId, cwd }) => {
      const { ipcRenderer } = window.require('electron')
      const store = window.useWorkspaceStore?.getState?.()
      const proj = store?.openProjects?.get?.(store?.activeProjectId)
      const tabId = proj?.activeTabId
      if (tabId) {
        ipcRenderer.send('gemini:run-command', {
          tabId,
          command: 'gemini-f',
          sessionId,
          cwd
        })
      }
    }, { sessionId: SOURCE_SESSION_ID, cwd: TEST_CWD })

    // Wait for Gemini session ID to appear in store
    log.step('Waiting for Gemini session to load...')
    try {
      await waitForGeminiSessionId(page, 30000)
      log.pass('Gemini session detected in store')
    } catch (e) {
      log.fail('Gemini session not detected: ' + e.message)
      await app.close()
      process.exit(1)
    }

    // Wait for Gemini TUI to fully render the conversation history
    // gemini -r loads the session and renders all messages
    log.step('Waiting for Gemini TUI to render history (20s)...')
    await page.waitForTimeout(20000)

    // ═══════════════════════════════════════════════════════════
    // TEST 1: Get timeline entries
    // ═══════════════════════════════════════════════════════════
    log.step('TEST 1: Loading timeline entries...')

    const { geminiSessionId, tabId } = await page.evaluate(() => {
      const store = window.useWorkspaceStore?.getState?.()
      const proj = store?.openProjects?.get?.(store?.activeProjectId)
      const tab = proj?.tabs?.get?.(proj?.activeTabId)
      return {
        geminiSessionId: tab?.geminiSessionId,
        tabId: proj?.activeTabId
      }
    })

    log.info('Forked session ID: ' + geminiSessionId)
    log.info('Tab ID: ' + tabId)

    const timeline = await page.evaluate(async ({ sessionId, cwd }) => {
      const { ipcRenderer } = window.require('electron')
      return await ipcRenderer.invoke('gemini:get-timeline', { sessionId, cwd })
    }, { sessionId: geminiSessionId, cwd: TEST_CWD })

    assert(timeline.success, 'Timeline IPC success')
    assert(timeline.entries.length > 0, `Timeline has entries (got ${timeline.entries.length})`)

    if (!timeline.success || timeline.entries.length === 0) {
      log.fail('No timeline entries, aborting')
      await app.close()
      process.exit(1)
    }

    log.info(`Timeline entries: ${timeline.entries.length}`)

    // ═══════════════════════════════════════════════════════════
    // TEST 2: Dump real buffer — what does Gemini TUI render?
    // ═══════════════════════════════════════════════════════════
    log.step('TEST 2: Inspecting real xterm buffer...')

    const bufferInfo = await page.evaluate(({ tabId }) => {
      const reg = window.__terminalRegistry
      if (!reg) return { error: 'No __terminalRegistry' }

      const fullText = reg.getFullBufferText(tabId)
      if (!fullText) return { error: 'No buffer text for tabId: ' + tabId }

      const lines = fullText.split('\n')
      return {
        totalLines: lines.length,
        totalChars: fullText.length,
        // Sample lines containing user messages
        sampleLines: lines
          .map((l, i) => ({ text: l, row: i }))
          .filter(l => l.text.trim().length > 0)
          .slice(-50) // last 50 non-empty lines
          .map(l => ({ row: l.row, len: l.text.length, text: l.text.slice(0, 120) }))
      }
    }, { tabId })

    if (bufferInfo.error) {
      log.fail('Buffer inspection failed: ' + bufferInfo.error)
      await app.close()
      process.exit(1)
    }

    log.info(`Buffer: ${bufferInfo.totalLines} lines, ${bufferInfo.totalChars} chars`)

    // ═══════════════════════════════════════════════════════════
    // TEST 3: scrollToTextInBuffer for each entry
    // ═══════════════════════════════════════════════════════════
    log.step('TEST 3: Testing scrollToTextInBuffer for each timeline entry...')

    const scrollResults = await page.evaluate(({ tabId, entries }) => {
      const reg = window.__terminalRegistry
      if (!reg) return { error: 'No registry' }

      // Replicate getSearchLines from Timeline.tsx
      function getSearchLines(content) {
        const rawLines = content.split('\n')
        const result = []
        for (const line of rawLines) {
          const t = line.trim()
          if (!t) continue
          if (t.length >= 3) {
            if (/^(.)\1+$/.test(t)) continue
            const freq = new Map()
            for (const ch of t) freq.set(ch, (freq.get(ch) || 0) + 1)
            const maxFreq = Math.max(...freq.values())
            if (maxFreq / t.length >= 0.8) continue
          }
          result.push(t.slice(0, 50))
          if (result.length >= 3) break
        }
        return result
      }

      const results = []
      let prevRow = -1

      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]
        if (entry.type === 'compact' || entry.type === 'continued') continue

        const searchLines = getSearchLines(entry.content)
        if (searchLines.length === 0) {
          results.push({ index: i, content: entry.content.slice(0, 50), searchLines, found: false, reason: 'no search lines' })
          continue
        }

        // Count duplicates before this entry
        let occurrenceIndex = 0
        for (let j = 0; j < i; j++) {
          const eLines = getSearchLines(entries[j].content)
          if (eLines.length === searchLines.length && eLines.every((l, k) => l === searchLines[k])) {
            occurrenceIndex++
          }
        }

        // Test with anchor
        const anchoredFound = reg.scrollToTextInBuffer(tabId, searchLines, occurrenceIndex, prevRow)

        // Test without anchor as fallback
        let unanchoredFound = false
        if (!anchoredFound) {
          unanchoredFound = reg.scrollToTextInBuffer(tabId, searchLines, occurrenceIndex, -1)
        }

        const found = anchoredFound || unanchoredFound

        // Update prevRow for next iteration
        if (found) {
          const row = reg.findTextBufferRow(tabId, searchLines, occurrenceIndex, anchoredFound ? prevRow : -1)
          if (row >= 0) prevRow = row
        }

        results.push({
          index: i,
          content: entry.content.slice(0, 60),
          searchLines,
          found,
          anchored: anchoredFound,
          fallback: unanchoredFound,
          prevRow
        })
      }

      return { results }
    }, { tabId, entries: timeline.entries })

    if (scrollResults.error) {
      log.fail('Scroll test failed: ' + scrollResults.error)
    } else {
      let foundCount = 0
      let totalCount = scrollResults.results.length

      for (const r of scrollResults.results) {
        if (r.found) {
          foundCount++
          if (r.anchored) {
            log.info(`Entry #${r.index}: FOUND (anchored) — "${r.content.slice(0, 50)}"`)
          } else {
            log.warn(`Entry #${r.index}: FOUND (fallback only) — "${r.content.slice(0, 50)}"`)
          }
        } else {
          log.fail(`Entry #${r.index}: NOT FOUND — "${r.content.slice(0, 50)}" searchLines: ${JSON.stringify(r.searchLines)}`)
        }
      }

      assert(foundCount === totalCount,
        `All ${totalCount} entries found via scrollToTextInBuffer (found: ${foundCount}, failed: ${totalCount - foundCount})`)

      // Individual important entries
      const podEntry = scrollResults.results.find(r => r.content.includes('Подожди'))
      if (podEntry) {
        assert(podEntry.found, `"Подожди, у нас в Run.sh..." entry found`)
      }

      const contEntry = scrollResults.results.find(r => r.content.trim() === 'продолжай')
      if (contEntry) {
        assert(contEntry.found, `"продолжай" entry found`)
      }
    }

    // ═══════════════════════════════════════════════════════════
    // TEST 4: Verify viewport detection matches click results
    // ═══════════════════════════════════════════════════════════
    log.step('TEST 4: Viewport detection vs scroll consistency...')

    const consistencyResults = await page.evaluate(({ tabId, entries }) => {
      const reg = window.__terminalRegistry

      function getSearchLines(content) {
        const rawLines = content.split('\n')
        const result = []
        for (const line of rawLines) {
          const t = line.trim()
          if (!t) continue
          if (t.length >= 3) {
            if (/^(.)\1+$/.test(t)) continue
            const freq = new Map()
            for (const ch of t) freq.set(ch, (freq.get(ch) || 0) + 1)
            const maxFreq = Math.max(...freq.values())
            if (maxFreq / t.length >= 0.8) continue
          }
          result.push(t.slice(0, 50))
          if (result.length >= 3) break
        }
        return result
      }

      function matchesInGeminiBuffer(bufferText, searchLines) {
        const firstLine = searchLines[0]
        const isStrictShort = searchLines.length === 1 && firstLine.length < 5
        const isIsolatedShort = searchLines.length === 1 && firstLine.length < 30
        const bufferLines = bufferText.split('\n')

        for (const hay of bufferLines) {
          if (isStrictShort) {
            const trimmed = hay.trim()
            if (trimmed === firstLine) return true
            if (trimmed.length > firstLine.length + 4) continue
            const pos = trimmed.indexOf(firstLine)
            if (pos < 0) continue
            if (pos === 0) return true
          } else if (isIsolatedShort) {
            const trimmed = hay.trim()
            if (trimmed.length > firstLine.length + 25) continue
            const pos = trimmed.indexOf(firstLine)
            if (pos < 0) continue
            if (pos === 0) return true
            const prefix = trimmed.slice(0, pos)
            if (!/[a-zA-Z0-9\u0400-\u04FF]/.test(prefix)) return true
          } else {
            if (hay.includes(firstLine)) return true
          }
        }
        return false
      }

      const fullText = reg.getFullBufferText(tabId)
      if (!fullText) return { error: 'no buffer' }

      const mismatches = []
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]
        if (entry.type === 'compact' || entry.type === 'continued') continue
        const sl = getSearchLines(entry.content)
        if (sl.length === 0) continue

        const viewportMatch = matchesInGeminiBuffer(fullText, sl)
        const scrollMatch = reg.findTextBufferRow(tabId, sl, 0, -1) >= 0

        if (viewportMatch !== scrollMatch) {
          mismatches.push({
            index: i,
            content: entry.content.slice(0, 50),
            viewport: viewportMatch,
            scroll: scrollMatch
          })
        }
      }

      return { mismatches, total: entries.length }
    }, { tabId, entries: timeline.entries })

    if (consistencyResults.error) {
      log.fail('Consistency check failed: ' + consistencyResults.error)
    } else {
      if (consistencyResults.mismatches.length === 0) {
        assert(true, `Viewport and scroll detection are consistent for all ${consistencyResults.total} entries`)
      } else {
        for (const m of consistencyResults.mismatches) {
          log.fail(`Entry #${m.index} MISMATCH: viewport=${m.viewport}, scroll=${m.scroll} — "${m.content}"`)
        }
        assert(false, `${consistencyResults.mismatches.length} viewport/scroll mismatches found`)
      }
    }

  } finally {
    // Cleanup
    log.step('Closing app...')
    await app.close()

    // Remove temp user-data-dir
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  }

  // ═══════════════════════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(50))
  console.log(`Results: ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    log.fail('SOME TESTS FAILED')
    process.exit(1)
  } else {
    log.pass('ALL TESTS PASSED')
  }
}

main().catch(err => {
  console.error(`${c.red}[ERROR]${c.reset}`, err.message)
  console.error(err.stack)
  process.exit(1)
})
