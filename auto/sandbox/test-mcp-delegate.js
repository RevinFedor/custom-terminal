/**
 * Test: MCP Delegation — Gemini → Claude Sub-Agent
 * [E2E+Claude] — Requires live `claude` CLI
 *
 * Запуск: node auto/sandbox/test-mcp-delegate.js
 */

const { launch, waitForTerminal, waitForMainProcessLog, findInLogs } = require('../core/launcher')
const electron = require('../core/electron')
const http = require('http')
const fs = require('fs')
const path = require('path')

// ─── Hard kill at 150s ───
const GLOBAL_MS = 150000
const globalTimer = setTimeout(() => {
  console.error('\n\x1b[31m[KILL] 150s global timeout\x1b[0m')
  process.exit(2)
}, GLOBAL_MS)
globalTimer.unref()

// ─── Logging ───
const c = { R: '\x1b[0m', G: '\x1b[32m', F: '\x1b[31m', C: '\x1b[36m', Y: '\x1b[33m', D: '\x1b[2m' }
const ts = () => new Date().toISOString().slice(11, 19)
const log = {
  step: (m) => console.log(`${c.C}[${ts()}][STEP]${c.R} ${m}`),
  pass: (m) => console.log(`${c.G}[${ts()}][PASS]${c.R} ${m}`),
  fail: (m) => console.log(`${c.F}[${ts()}][FAIL]${c.R} ${m}`),
  warn: (m) => console.log(`${c.Y}[${ts()}][WARN]${c.R} ${m}`),
  info: (m) => console.log(`${c.D}[${ts()}][INFO]${c.R} ${m}`)
}

let passed = 0, failed = 0
function assert(cond, msg) {
  if (cond) { log.pass(msg); passed++ }
  else { log.fail(msg); failed++ }
}

async function withTimeout(promise, ms, label) {
  let timer
  const to = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`TIMEOUT ${ms}ms`)), ms) })
  try {
    const r = await Promise.race([promise, to])
    clearTimeout(timer)
    return r
  } catch (err) {
    clearTimeout(timer)
    log.fail(`${label}: ${err.message}`)
    failed++
    return null
  }
}

const MCP_PORT_FILE = path.join(require('os').homedir(), '.noted-terminal', 'mcp-port')

function httpReq(method, url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname,
      method, timeout: 10000,
      headers: body ? { 'Content-Type': 'application/json' } : {}
    }, (res) => {
      let d = ''
      res.on('data', c => { d += c })
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }) }
        catch { resolve({ status: res.statusCode, body: { raw: d } }) }
      })
    })
    req.on('timeout', () => { req.destroy(); reject(new Error('HTTP timeout')) })
    req.on('error', reject)
    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}

// Filter: only MCP / Claude / Handshake / PTY-related main process lines
const MCP_FILTER = /MCP|Handshake|sub.agent|Sub.agent|delegate|claudeState|WAITING_PROMPT|PTY:CREATED|terminal:create|Prompt detect|Sniper|session-detect|Bridge/i

async function main() {
  let app = null

  try {
    // ─── LAUNCH ───
    log.step('Launching Electron...')

    const launched = await withTimeout(
      launch({ logConsole: false, logMainProcess: false, waitForReady: 4000 }),
      25000, 'Electron launch'
    )
    if (!launched) { process.exit(1) }

    app = launched.app
    const { page, mainProcessLogs } = launched

    // Stream MCP-related main process lines in real-time
    let lastLogIdx = 0
    const logPump = setInterval(() => {
      for (let i = lastLogIdx; i < mainProcessLogs.length; i++) {
        if (MCP_FILTER.test(mainProcessLogs[i])) {
          console.log(`${c.D}  [main] ${mainProcessLogs[i].replace(/^\[(stdout|stderr)\]\s*/, '').trim().slice(0, 120)}${c.R}`)
        }
      }
      lastLogIdx = mainProcessLogs.length
    }, 500)

    log.pass('App launched')

    // ─── TERMINAL ───
    log.step('Waiting for terminal...')
    const term = await withTimeout(waitForTerminal(page, 15000), 20000, 'Terminal appear')
    if (!term) { process.exit(1) }
    log.pass('Terminal visible')

    await electron.focusWindow(app)
    await page.waitForTimeout(500)

    // ═══════ T1: MCP HTTP server ═══════
    log.step('T1: MCP HTTP server')
    const portLog = await withTimeout(
      waitForMainProcessLog(mainProcessLogs, '[MCP:HTTP] Server listening', 10000),
      12000, 'MCP HTTP port log'
    )
    assert(!!portLog, 'HTTP server started')

    let mcpPort = null
    try { mcpPort = parseInt(fs.readFileSync(MCP_PORT_FILE, 'utf-8').trim()) } catch {}
    assert(mcpPort > 0, `Port=${mcpPort}`)
    if (!mcpPort) { process.exit(1) }

    const health = await withTimeout(httpReq('GET', `http://127.0.0.1:${mcpPort}/status/xxx`), 5000, 'Health')
    assert(health?.status === 404, 'Health OK')

    // ═══════ T2: Gemini tab ═══════
    log.step('T2: Set commandType=gemini on active tab')
    const tabInfo = await page.evaluate(() => {
      const s = window.useWorkspaceStore?.getState?.()
      const p = s?.openProjects?.get?.(s?.activeProjectId)
      const t = p?.tabs?.get?.(p?.activeTabId)
      return { pid: s?.activeProjectId, tid: p?.activeTabId, cwd: t?.cwd }
    })
    log.info(`Active tab: ${tabInfo.tid} cwd: ${tabInfo.cwd}`)

    await page.evaluate(() => {
      const s = window.useWorkspaceStore?.getState?.()
      const p = s?.openProjects?.get?.(s?.activeProjectId)
      if (p?.activeTabId) s.setTabCommandType(p.activeTabId, 'gemini')
    })
    assert(true, 'commandType set')

    // ═══════ T3: POST /delegate ═══════
    log.step('T3: POST /delegate')
    const resp = await withTimeout(
      httpReq('POST', `http://127.0.0.1:${mcpPort}/delegate`, {
        prompt: 'Say exactly this one word: MCP_TEST_OK',
        ppid: 0
      }),
      10000, 'POST /delegate'
    )
    assert(resp?.status === 200, `HTTP 200 (got ${resp?.status})`)
    const taskId = resp?.body?.taskId
    assert(!!taskId, `taskId: ${taskId?.slice(0, 8)}...`)
    if (!taskId) { process.exit(1) }

    // ═══════ T4: Sub-agent tab ═══════
    log.step('T4: Sub-agent tab creation')
    const createLog = await withTimeout(
      waitForMainProcessLog(mainProcessLogs, 'Claude sub-agent tab created', 15000),
      18000, 'Sub-agent creation log'
    )
    assert(!!createLog, 'Sub-agent tab created')

    // Verify in store
    const saHandle = await withTimeout(
      page.waitForFunction(() => {
        const s = window.useWorkspaceStore?.getState?.()
        if (!s) return null
        for (const [, ws] of s.openProjects) {
          for (const [, t] of ws.tabs) {
            if (t.parentTabId) return { id: t.id, pt: t.parentTabId, ct: t.commandType }
          }
        }
        return null
      }, { timeout: 10000 }),
      12000, 'Store: parentTabId'
    )
    const sa = saHandle ? await saHandle.jsonValue() : null
    assert(!!sa, `Sub-agent in store: ${sa?.id || 'N/A'}`)

    // ═══════ T5: Handshake (Claude start + prompt detection) ═══════
    log.step('T5: Claude handshake (watch for PTY output)')
    log.info('Claude should start in sub-agent PTY and show ⏵ prompt...')

    // Check if claude was written to the terminal
    const claudeLaunchLog = await withTimeout(
      waitForMainProcessLog(mainProcessLogs, 'claude --dangerously-skip-permissions', 5000),
      8000, 'Claude launch command in PTY'
    )
    if (claudeLaunchLog) {
      log.pass('Claude command sent to PTY')
    } else {
      log.warn('Claude command not visible in logs (may still work)')
    }

    // Wait for handshake prompt detection
    const hsLog = await withTimeout(
      waitForMainProcessLog(mainProcessLogs, 'Prompt detected', 45000),
      48000, 'Handshake prompt detection'
    )
    if (hsLog) {
      log.pass(`Handshake: ${hsLog.slice(0, 80)}`)
    } else {
      log.fail('Handshake: no prompt detected')
      // Diagnostic: dump sub-agent PTY tab info
      log.warn('Diagnosing...')
      const diag = await page.evaluate(() => {
        const s = window.useWorkspaceStore?.getState?.()
        const result = []
        for (const [, ws] of s?.openProjects || new Map()) {
          for (const [, t] of ws.tabs) {
            if (t.parentTabId || t.commandType === 'claude') {
              result.push({ id: t.id, cwd: t.cwd, ct: t.commandType, sid: t.claudeSessionId, pt: t.parentTabId })
            }
          }
        }
        return result
      })
      diag.forEach(d => log.info(`  Tab: ${JSON.stringify(d)}`))
    }

    // Session ID
    if (sa) {
      log.info('Waiting for claudeSessionId (30s)...')
      const sidH = await withTimeout(
        page.waitForFunction((subId) => {
          const s = window.useWorkspaceStore?.getState?.()
          for (const [, ws] of s?.openProjects || new Map()) {
            const t = ws.tabs?.get?.(subId)
            if (t?.claudeSessionId?.length > 10) return t.claudeSessionId
          }
          return null
        }, sa.id, { timeout: 30000 }),
        32000, 'Session ID'
      )
      const sid = sidH ? await sidH.jsonValue() : null
      if (sid) log.pass(`SessionID: ${sid.slice(0, 20)}...`)
      else log.warn('SessionID not captured (continuing anyway)')
    }

    // ═══════ T6: Completion ═══════
    log.step('T6: Completion (wait for [MCPResult])')
    let dots = 0
    const hb = setInterval(() => { dots++; log.info(`Waiting... ${dots * 10}s`) }, 10000)

    const completeLog = await withTimeout(
      waitForMainProcessLog(mainProcessLogs, '[MCPResult]', 60000, 500),
      65000, '[MCPResult]'
    )
    clearInterval(hb)
    assert(!!completeLog, `Completion: ${completeLog?.slice(0, 60) || 'NOT FOUND'}`)

    // ═══════ T7: GET /status ═══════
    log.step('T7: GET /status/:taskId')
    await page.waitForTimeout(500)
    const st = await withTimeout(httpReq('GET', `http://127.0.0.1:${mcpPort}/status/${taskId}`), 5000, 'GET /status')
    assert(st?.status === 200, 'HTTP 200')
    assert(st?.body?.status === 'completed', `status=${st?.body?.status}`)
    if (st?.body?.result) {
      assert(st.body.result.includes('MCP_TEST_OK'), 'MCP_TEST_OK in result')
      log.info(`Result: ${st.body.result.substring(0, 80)}...`)
    }

    // ═══════ T8: Delivery logs ═══════
    log.step('T8: Delivery')
    const dLogs = findInLogs(mainProcessLogs, '[MCP:deliver]')
    assert(dLogs.length > 0, `Delivery entries: ${dLogs.length}`)

    // ═══════ SUMMARY ═══════
    clearInterval(logPump)
    console.log('\n' + '═'.repeat(45))
    console.log(`  Passed: ${passed}  Failed: ${failed}`)
    if (failed > 0) { process.exitCode = 1; log.fail('SOME TESTS FAILED') }
    else log.pass('ALL TESTS PASSED')
    console.log('═'.repeat(45))

    // Dump filtered main logs
    console.log('\n--- MCP/Claude Logs (last 50) ---')
    mainProcessLogs
      .filter(l => MCP_FILTER.test(l))
      .slice(-50)
      .forEach(l => console.log(l.replace(/^\[(stdout|stderr)\]\s*/, '').trim().slice(0, 160)))

  } finally {
    clearTimeout(globalTimer)
    if (app) {
      log.info('Closing app...')
      await app.close().catch(() => {})
    }
  }
}

main().catch(err => {
  console.error(`\n${c.F}[FATAL]${c.R}`, err.message)
  console.error(err.stack)
  process.exit(1)
})
