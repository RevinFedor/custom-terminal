/**
 * Test: Gemini /model menu — raw PTY output capture
 *
 * Goal: understand how Gemini CLI renders the model selection TUI
 * - What ANSI codes are used for ● (selected) items
 * - Whether sync markers (\x1b[?2026l) are present
 * - How to navigate and confirm selection
 *
 * Run: node auto/sandbox/test-gemini-model-menu.js
 */

const { launch, waitForTerminal, typeCommand, waitForGeminiSessionId } = require('../core/launcher')
const electron = require('../core/electron')
const fs = require('fs')
const path = require('path')

const c = {
  reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m',
  cyan: '\x1b[36m', yellow: '\x1b[33m', dim: '\x1b[2m', bold: '\x1b[1m',
  magenta: '\x1b[35m'
}
const log = {
  step: (m) => console.log(`${c.cyan}[STEP]${c.reset} ${m}`),
  info: (m) => console.log(`${c.dim}[INFO]${c.reset} ${m}`),
  pass: (m) => console.log(`${c.green}[PASS]${c.reset} ${m}`),
  fail: (m) => console.log(`${c.red}[FAIL]${c.reset} ${m}`),
  warn: (m) => console.log(`${c.yellow}[WARN]${c.reset} ${m}`),
  raw:  (m) => console.log(`${c.magenta}[RAW]${c.reset} ${m}`)
}

// Dump raw PTY bytes in readable hex+text format
function dumpRaw(raw, label) {
  console.log(`\n${c.bold}═══ ${label} (${raw.length} bytes) ═══${c.reset}`)

  // Show escape sequences visually
  const visual = raw
    .replace(/\x1b/g, '⟨ESC⟩')
    .replace(/\r/g, '⟨CR⟩')
    .replace(/\n/g, '⟨LF⟩\n')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f]/g, (ch) => `⟨0x${ch.charCodeAt(0).toString(16)}⟩`)
  console.log(visual)

  // Extract all ANSI color codes
  const colorCodes = raw.match(/\x1b\[[\d;]*m/g) || []
  const uniqueColors = [...new Set(colorCodes)]
  console.log(`\n${c.dim}Unique ANSI color codes found:${c.reset}`)
  uniqueColors.forEach(code => {
    const readable = code.replace(/\x1b/g, 'ESC')
    const count = colorCodes.filter(c => c === code).length
    console.log(`  ${readable} (×${count})`)
  })

  // Extract RGB codes specifically
  const rgbCodes = raw.match(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g) || []
  if (rgbCodes.length > 0) {
    console.log(`\n${c.dim}RGB foreground colors:${c.reset}`)
    const uniqueRgb = [...new Set(rgbCodes)]
    uniqueRgb.forEach(code => {
      const m = code.match(/38;2;(\d+);(\d+);(\d+)/)
      console.log(`  RGB(${m[1]}, ${m[2]}, ${m[3]})`)
    })
  }

  // Check for sync markers
  const syncMarkers = (raw.match(/\x1b\[\?2026[hl]/g) || [])
  console.log(`\n${c.dim}Sync markers (?2026h/l): ${syncMarkers.length}${c.reset}`)
  syncMarkers.forEach(m => {
    const readable = m.replace(/\x1b/g, 'ESC')
    console.log(`  ${readable}`)
  })

  // Check for ● (U+25CF) or other bullet symbols
  const bullets = raw.match(/[●○◉◎⦿⦾•]/g) || []
  console.log(`\n${c.dim}Bullet symbols: ${bullets.join(', ') || 'none'}${c.reset}`)

  console.log(`${c.bold}═══ END ${label} ═══${c.reset}\n`)
}

async function main() {
  log.step('Launching Noted Terminal...')
  const { app, page, mainProcessLogs } = await launch({
    logConsole: false, logMainProcess: true, waitForReady: 4000
  })
  log.pass('App launched')

  try {
    log.step('Waiting for terminal...')
    await waitForTerminal(page, 15000)
    await electron.focusWindow(app)
    await page.waitForTimeout(500)

    log.step('New tab...')
    await page.keyboard.press('Meta+t')
    await page.waitForTimeout(1500)

    await typeCommand(page, 'cd /Users/fedor/Desktop/custom-terminal')
    await page.waitForTimeout(2000)

    const tabId = await page.evaluate(() => {
      const s = window.useWorkspaceStore?.getState?.()
      const p = s?.openProjects?.get?.(s?.activeProjectId)
      return p?.activeTabId
    })
    if (!tabId) { log.fail('No activeTabId'); return }
    log.info('Tab: ' + tabId)

    // ═══════════════════════════════════════════════════════════
    // PHASE 1: Start Gemini
    // ═══════════════════════════════════════════════════════════
    log.step('Starting gemini...')
    await typeCommand(page, 'gemini')

    try {
      await waitForGeminiSessionId(page, 35000)
      log.pass('Gemini session detected')
    } catch {
      log.warn('Gemini session ID not detected (continuing anyway)')
    }

    log.step('Waiting for Gemini to fully initialize (8s)...')
    await page.waitForTimeout(8000)

    // ═══════════════════════════════════════════════════════════
    // PHASE 2: Send /model and capture raw output
    // ═══════════════════════════════════════════════════════════
    log.step('Sending /model command to Gemini...')

    // Set up raw PTY capture BEFORE sending the command
    // We'll use ipcRenderer.invoke('terminal:capture-raw') but that doesn't exist.
    // Instead, we'll inject a listener into main process via evaluate.

    // Strategy: Use main process IPC to capture raw data from PTY
    // We need to tap into term.onData in main process.
    // BUT we can't easily add dynamic listeners from renderer.

    // Alternative: Read xterm buffer after the command
    // This loses ANSI codes but we can check what's visible.

    // Let's use BOTH approaches:
    // 1. Read xterm visible text (clean, no ANSI)
    // 2. Send command via safePasteAndSubmit (fast mode for Gemini)

    // First, let's try sending /model via terminal:input (raw keystroke approach)
    await page.evaluate((tid) => {
      const { ipcRenderer } = window.require('electron')
      // Type /model character by character
      for (const ch of '/model') {
        ipcRenderer.send('terminal:input', tid, ch)
      }
    }, tabId)
    await page.waitForTimeout(500)

    // Press Enter
    await page.evaluate((tid) => {
      const { ipcRenderer } = window.require('electron')
      ipcRenderer.send('terminal:input', tid, '\r')
    }, tabId)

    // Wait for menu to render
    log.step('Waiting for /model menu to render (3s)...')
    await page.waitForTimeout(3000)

    // Read visible terminal text
    const visibleText = await page.evaluate((tid) => {
      // Access terminal registry
      const reg = window.terminalRegistry
      if (!reg) return 'NO REGISTRY'
      return reg.getVisibleText(tid) || 'EMPTY'
    }, tabId)

    console.log(`\n${c.bold}═══ VISIBLE TERMINAL TEXT ═══${c.reset}`)
    console.log(visibleText)
    console.log(`${c.bold}═══ END VISIBLE TEXT ═══${c.reset}\n`)

    // Check if menu is visible (look for "Select Model" or numbered options)
    const hasMenu = visibleText.includes('Select Model') || visibleText.includes('Auto') || visibleText.includes('Manual')
    if (hasMenu) {
      log.pass('Model menu detected in terminal!')
    } else {
      log.warn('Model menu not visible yet')
    }

    // Check for ● in visible text
    const bulletLines = visibleText.split('\n').filter(l => l.includes('●'))
    if (bulletLines.length > 0) {
      log.pass('Found ● selection markers:')
      bulletLines.forEach(l => console.log('  → ' + l.trim()))
    }

    // ═══════════════════════════════════════════════════════════
    // PHASE 3: Try to capture raw PTY data by sending arrow keys
    // We'll use the same approach as claude:open-history-menu
    // but go through a custom IPC handler
    // ═══════════════════════════════════════════════════════════

    // Let's try navigating: send UP arrow and capture what changes
    log.step('Sending UP arrow and reading buffer...')

    await page.evaluate((tid) => {
      const { ipcRenderer } = window.require('electron')
      ipcRenderer.send('terminal:input', tid, '\x1b[A') // UP arrow
    }, tabId)
    await page.waitForTimeout(1000)

    const afterUp = await page.evaluate((tid) => {
      const reg = window.terminalRegistry
      if (!reg) return 'NO REGISTRY'
      return reg.getVisibleText(tid) || 'EMPTY'
    }, tabId)

    console.log(`\n${c.bold}═══ AFTER UP ARROW ═══${c.reset}`)
    console.log(afterUp)
    console.log(`${c.bold}═══ END AFTER UP ═══${c.reset}\n`)

    // Compare ● positions
    const afterBullets = afterUp.split('\n').filter(l => l.includes('●'))
    if (afterBullets.length > 0) {
      log.pass('● positions after UP:')
      afterBullets.forEach(l => console.log('  → ' + l.trim()))
    }

    // Send another UP
    log.step('Sending another UP arrow...')
    await page.evaluate((tid) => {
      const { ipcRenderer } = window.require('electron')
      ipcRenderer.send('terminal:input', tid, '\x1b[A')
    }, tabId)
    await page.waitForTimeout(1000)

    const afterUp2 = await page.evaluate((tid) => {
      const reg = window.terminalRegistry
      if (!reg) return 'NO REGISTRY'
      return reg.getVisibleText(tid) || 'EMPTY'
    }, tabId)

    const afterBullets2 = afterUp2.split('\n').filter(l => l.includes('●'))
    if (afterBullets2.length > 0) {
      log.pass('● positions after second UP:')
      afterBullets2.forEach(l => console.log('  → ' + l.trim()))
    }

    // Send DOWN to go back
    log.step('Sending DOWN arrow...')
    await page.evaluate((tid) => {
      const { ipcRenderer } = window.require('electron')
      ipcRenderer.send('terminal:input', tid, '\x1b[B')
    }, tabId)
    await page.waitForTimeout(1000)

    const afterDown = await page.evaluate((tid) => {
      const reg = window.terminalRegistry
      if (!reg) return 'NO REGISTRY'
      return reg.getVisibleText(tid) || 'EMPTY'
    }, tabId)

    const afterBullets3 = afterDown.split('\n').filter(l => l.includes('●'))
    if (afterBullets3.length > 0) {
      log.pass('● positions after DOWN:')
      afterBullets3.forEach(l => console.log('  → ' + l.trim()))
    }

    // ═══════════════════════════════════════════════════════════
    // PHASE 4: Try confirming selection with Enter
    // Navigate to "Manual" (should be option 3), then pick a model
    // ═══════════════════════════════════════════════════════════

    // First, navigate to "Manual" option
    // Find which option has ● and determine current position
    const currentMenu = afterDown
    const lines = currentMenu.split('\n').map(l => l.trim()).filter(Boolean)

    log.step('Current menu state:')
    lines.forEach((l, i) => {
      if (l.includes('●') || l.includes('Select') || l.includes('Auto') || l.includes('Manual')) {
        console.log(`  [${i}] ${l}`)
      }
    })

    // Press Escape to close menu without selecting
    log.step('Pressing Escape to close menu...')
    await page.evaluate((tid) => {
      const { ipcRenderer } = window.require('electron')
      ipcRenderer.send('terminal:input', tid, '\x1b')
    }, tabId)
    await page.waitForTimeout(2000)

    const afterEsc = await page.evaluate((tid) => {
      const reg = window.terminalRegistry
      if (!reg) return 'NO REGISTRY'
      return reg.getVisibleText(tid) || 'EMPTY'
    }, tabId)

    const menuStillOpen = afterEsc.includes('Select Model')
    log.info('Menu still open after Escape: ' + menuStillOpen)

    // ═══════════════════════════════════════════════════════════
    // PHASE 5: Now try the FULL flow via IPC with raw capture
    // Create a temporary IPC handler that captures raw PTY data
    // ═══════════════════════════════════════════════════════════

    log.step('Testing raw PTY capture via drainPtyData approach...')

    // Send /model again and capture main process logs
    const logsBefore = mainProcessLogs.length

    // Use evaluate to call IPC that sends raw data + captures
    const rawCapture = await page.evaluate(async (tid) => {
      const { ipcRenderer } = window.require('electron')

      // Send /model and wait
      for (const ch of '/model') {
        ipcRenderer.send('terminal:input', tid, ch)
        await new Promise(r => setTimeout(r, 50))
      }
      ipcRenderer.send('terminal:input', tid, '\r')

      // Wait for menu
      await new Promise(r => setTimeout(r, 3000))

      // Read buffer
      const reg = window.terminalRegistry
      const text = reg ? reg.getVisibleText(tid) : 'NO REG'
      const fullText = reg ? reg.getFullBufferText(tid) : 'NO REG'

      return { visible: text, full: fullText }
    }, tabId)

    console.log(`\n${c.bold}═══ FULL BUFFER (last 2000 chars) ═══${c.reset}`)
    console.log(rawCapture.full.slice(-2000))
    console.log(`${c.bold}═══ END FULL BUFFER ═══${c.reset}\n`)

    // Final summary
    console.log(`\n${c.bold}═══════════════════════════════════════${c.reset}`)
    console.log(`${c.bold}  SUMMARY${c.reset}`)
    console.log(`${c.bold}═══════════════════════════════════════${c.reset}`)

    const hasSelectModel = rawCapture.visible.includes('Select Model')
    const hasBullet = rawCapture.visible.includes('●')
    const hasAutoGemini3 = rawCapture.visible.includes('Auto') && rawCapture.visible.includes('Gemini 3')
    const hasManual = rawCapture.visible.includes('Manual')

    console.log(`  Select Model header: ${hasSelectModel ? c.green + 'YES' : c.red + 'NO'}${c.reset}`)
    console.log(`  ● bullet symbol:     ${hasBullet ? c.green + 'YES' : c.red + 'NO'}${c.reset}`)
    console.log(`  Auto (Gemini 3):     ${hasAutoGemini3 ? c.green + 'YES' : c.red + 'NO'}${c.reset}`)
    console.log(`  Manual option:       ${hasManual ? c.green + 'YES' : c.red + 'NO'}${c.reset}`)
    console.log(`${c.bold}═══════════════════════════════════════${c.reset}`)

    // Close the menu
    await page.evaluate((tid) => {
      const { ipcRenderer } = window.require('electron')
      ipcRenderer.send('terminal:input', tid, '\x1b')
    }, tabId)

  } finally {
    log.step('Closing...')
    await app.close()
  }
}

main().catch(err => { console.error(c.red + err.message + c.reset); process.exit(1) })
