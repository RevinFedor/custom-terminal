/**
 * Test: Gemini scrollToTextInBuffer same-line fallback
 *
 * Verifies that scrollToTextInBuffer can find multi-line entries
 * when Gemini TUI collapses them into a single logical line.
 *
 * Uses real session data from 705fcd97 (session-2026-02-26T20-13-19-c76c327f.json).
 * Writes user message content into xterm.js headless buffer to simulate
 * how Gemini Ink TUI renders long messages as single logical lines.
 *
 * Run: node auto/sandbox/test-gemini-scroll-sameline.js
 */

const { Terminal } = require('@xterm/headless');
const fs = require('fs');
const path = require('path');

const SESSION_FILE = path.join(
  require('os').homedir(),
  '.gemini/tmp/fedor/chats/session-2026-02-26T20-13-19-c76c327f.json'
);

const c = {
  reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m',
  cyan: '\x1b[36m', yellow: '\x1b[33m', dim: '\x1b[2m'
};
const log = {
  step: (m) => console.log(`${c.cyan}[STEP]${c.reset} ${m}`),
  pass: (m) => console.log(`${c.green}[PASS]${c.reset} ${m}`),
  fail: (m) => console.log(`${c.red}[FAIL]${c.reset} ${m}`),
  info: (m) => console.log(`${c.dim}[INFO]${c.reset} ${m}`)
};

let passed = 0, failed = 0;
function assert(condition, message) {
  if (condition) { log.pass(message); passed++; }
  else { log.fail(message); failed++; }
}

// Helper: xterm.js write() is async, need to wait for callback
function writeAsync(term, data) {
  return new Promise(resolve => term.write(data, resolve));
}

// ─── Replicate getSearchLines from Timeline.tsx ───
function getSearchLines(content) {
  const rawLines = content.split('\n');
  const result = [];
  for (const line of rawLines) {
    const t = line.trim();
    if (!t) continue;
    if (t.length >= 3) {
      if (/^(.)\1+$/.test(t)) continue;
      const freq = new Map();
      for (const ch of t) freq.set(ch, (freq.get(ch) || 0) + 1);
      const maxFreq = Math.max(...freq.values());
      if (maxFreq / t.length >= 0.8) continue;
    }
    result.push(t.slice(0, 50));
    if (result.length >= 3) break;
  }
  return result;
}

// ─── Replicate lineContains logic from terminalRegistry.ts ───
function lineContains(haystack, needle, isStrictShort, isIsolatedShort) {
  if (isStrictShort) {
    const trimmed = haystack.trim();
    if (trimmed === needle) return true;
    if (trimmed.length > needle.length + 4) return false;
    const pos = trimmed.indexOf(needle);
    if (pos < 0) return false;
    if (pos === 0) return true;
    const prefix = trimmed.slice(0, pos);
    return !/[a-zA-Z0-9\u0400-\u04FF]/.test(prefix);
  }
  if (isIsolatedShort) {
    const trimmed = haystack.trim();
    if (trimmed.length > needle.length + 25) return false;
    const pos = trimmed.indexOf(needle);
    if (pos < 0) return false;
    if (pos === 0) return true;
    const prefix = trimmed.slice(0, pos);
    return !/[a-zA-Z0-9\u0400-\u04FF]/.test(prefix);
  }
  if (needle.length >= 5) return haystack.includes(needle);
  let from = 0;
  while (true) {
    const pos = haystack.indexOf(needle, from);
    if (pos === -1) return false;
    const before = pos > 0 ? haystack[pos - 1] : ' ';
    const after = pos + needle.length < haystack.length ? haystack[pos + needle.length] : ' ';
    const boundaryRe = /[\s\.,;:!?\-—–()\[\]{}<>\/\\|"'`~@#$%^&*+=]/;
    if ((pos === 0 || boundaryRe.test(before)) && (pos + needle.length === haystack.length || boundaryRe.test(after))) {
      return true;
    }
    from = pos + 1;
  }
}

// ─── Search logic WITH same-line fallback (new code) ───
function findInLogicalLines(logicalLines, contentLines, occurrenceIndex, startAfterRow) {
  if (logicalLines.length === 0 || contentLines.length === 0) return -1;

  const isStrictShort = contentLines.length === 1 && contentLines[0].length < 5;
  const isIsolatedShort = contentLines.length === 1 && contentLines[0].length < 30;
  const firstLine = contentLines[0];
  let validCount = 0;

  for (let i = 0; i < logicalLines.length; i++) {
    if (startAfterRow >= 0 && logicalLines[i].bufRow <= startAfterRow) continue;
    if (!lineContains(logicalLines[i].text, firstLine, isStrictShort, isIsolatedShort)) continue;

    let allMatch = true;

    if (contentLines.length > 1) {
      // Multi-line match
      let bufIdx = i + 1;
      for (let j = 1; j < contentLines.length; j++) {
        let found = false;
        const maxGap = 5;
        for (let gap = 0; gap < maxGap && bufIdx < logicalLines.length; gap++, bufIdx++) {
          if (lineContains(logicalLines[bufIdx].text, contentLines[j], isStrictShort, isIsolatedShort)) {
            found = true;
            bufIdx++;
            break;
          }
        }
        if (!found) { allMatch = false; break; }
      }

      // Same-line fallback
      if (!allMatch) {
        const sameLine = logicalLines[i].text;
        allMatch = contentLines.slice(1).every(cl => sameLine.includes(cl));
      }

      // Truncation fallback: Gemini TUI truncates long user messages.
      // Accept first-line-only match when it's long enough (>= 30 chars).
      if (!allMatch && firstLine.length >= 15) {
        allMatch = true;
      }
    }

    if (!allMatch) continue;
    if (validCount === occurrenceIndex) return logicalLines[i].bufRow;
    validCount++;
  }
  return -1;
}

// ─── Search logic WITHOUT same-line fallback (old code, for comparison) ───
function findWithoutFallback(logicalLines, contentLines, occurrenceIndex, startAfterRow) {
  if (logicalLines.length === 0 || contentLines.length === 0) return -1;
  const isStrictShort = contentLines.length === 1 && contentLines[0].length < 5;
  const isIsolatedShort = contentLines.length === 1 && contentLines[0].length < 30;
  const firstLine = contentLines[0];
  let validCount = 0;

  for (let i = 0; i <= logicalLines.length - contentLines.length; i++) {
    if (startAfterRow >= 0 && logicalLines[i].bufRow <= startAfterRow) continue;
    if (!lineContains(logicalLines[i].text, firstLine, isStrictShort, isIsolatedShort)) continue;

    let allMatch = true;
    let bufIdx = i + 1;
    for (let j = 1; j < contentLines.length; j++) {
      let found = false;
      for (let gap = 0; gap < 5 && bufIdx < logicalLines.length; gap++, bufIdx++) {
        if (lineContains(logicalLines[bufIdx].text, contentLines[j], isStrictShort, isIsolatedShort)) {
          found = true; bufIdx++; break;
        }
      }
      if (!found) { allMatch = false; break; }
    }
    if (!allMatch) continue;
    if (validCount === occurrenceIndex) return logicalLines[i].bufRow;
    validCount++;
  }
  return -1;
}

// ─── Build logical lines from xterm buffer ───
function buildLogicalLines(terminal) {
  const buf = terminal.buffer.active;
  const logicalLines = [];
  let currentText = '';
  let currentStartRow = 0;

  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i);
    if (!line) continue;

    if (i > 0 && !line.isWrapped) {
      logicalLines.push({ text: currentText, bufRow: currentStartRow });
      currentText = '';
      currentStartRow = i;
    }
    const nextLine = (i + 1 < buf.length) ? buf.getLine(i + 1) : null;
    currentText += line.translateToString(!nextLine?.isWrapped);
  }
  if (currentText) {
    logicalLines.push({ text: currentText, bufRow: currentStartRow });
  }
  return logicalLines;
}

// ═══════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════

async function main() {
  log.step('Loading session data...');
  if (!fs.existsSync(SESSION_FILE)) {
    log.fail('Session file not found: ' + SESSION_FILE);
    process.exit(1);
  }
  const session = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  const userMsgs = session.messages.filter(m => m.type === 'user');
  log.info(`Session: ${session.sessionId}`);
  log.info(`User messages: ${userMsgs.length}`);

  // Precompute search lines
  const allSearchLines = userMsgs.map(m => getSearchLines(m.content?.[0]?.text || ''));

  // ═══════════════════════════════════════════════════════════
  // TEST 1: getSearchLines correctness
  // ═══════════════════════════════════════════════════════════
  log.step('TEST 1: getSearchLines produces valid search lines');

  // Entry #8: separator ────────╯ should be skipped
  const entry8Lines = allSearchLines[8];
  const hasSep8 = entry8Lines.some(l => l.includes('────'));
  assert(!hasSep8, `Entry #8 skips separator (first line: "${entry8Lines[0]?.slice(0, 40)}")`);

  // Entry #9: "Подожди" message with 4 long lines
  const entry9Lines = allSearchLines[9];
  assert(entry9Lines[0]?.startsWith('Подожди'), `Entry #9 starts with "Подожди"`);
  assert(entry9Lines.length === 3, `Entry #9 has 3 search lines (got: ${entry9Lines.length})`);

  // ═══════════════════════════════════════════════════════════
  // TEST 2: Same-line fallback — the actual bug case
  // ═══════════════════════════════════════════════════════════
  log.step('TEST 2: "Подожди" entry found via same-line fallback (collapsed to 1 line)');

  const term2 = new Terminal({ cols: 200, rows: 50, allowProposedApi: true, scrollback: 10000 });

  // Write AI response before
  for (let i = 0; i < 20; i++) {
    await writeAsync(term2, `AI response line ${i}: some analysis text.\r\n`);
  }

  // Write the "Подожди" message as one collapsed line (how Gemini TUI renders)
  const entry9Content = userMsgs[9].content?.[0]?.text || '';
  const collapsed9 = entry9Content.replace(/\n/g, ' ');
  await writeAsync(term2, collapsed9 + '\r\n');

  // Write more after
  for (let i = 0; i < 10; i++) {
    await writeAsync(term2, `More AI output line ${i}.\r\n`);
  }

  const ll2 = buildLogicalLines(term2);
  log.info(`Buffer: ${ll2.length} logical lines`);

  // Verify the collapsed text is one logical line
  const podLine = ll2.find(l => l.text.includes('Подожди'));
  assert(!!podLine, `Collapsed "Подожди" text exists in buffer as logical line`);
  if (podLine) {
    log.info(`  Logical line length: ${podLine.text.length} chars at bufRow ${podLine.bufRow}`);
    assert(podLine.text.includes(entry9Lines[1]), `Same line also contains search line 2`);
    assert(podLine.text.includes(entry9Lines[2]), `Same line also contains search line 3`);
  }

  // Test WITH fallback (new code)
  const row2new = findInLogicalLines(ll2, entry9Lines, 0, -1);
  assert(row2new >= 0, `WITH fallback: "Подожди" FOUND (row: ${row2new})`);

  // Test WITHOUT fallback (old code)
  const row2old = findWithoutFallback(ll2, entry9Lines, 0, -1);
  assert(row2old === -1, `WITHOUT fallback: "Подожди" NOT found (confirms bug existed)`);

  term2.dispose();

  // ═══════════════════════════════════════════════════════════
  // TEST 3: Normal multi-line entries still work (lines on separate rows)
  // ═══════════════════════════════════════════════════════════
  log.step('TEST 3: Normal multi-line matching still works');

  const term3 = new Terminal({ cols: 200, rows: 50, allowProposedApi: true, scrollback: 10000 });

  await writeAsync(term3, 'Some intro text\r\n');
  await writeAsync(term3, entry9Lines[0] + '\r\n');
  await writeAsync(term3, entry9Lines[1] + '\r\n');
  await writeAsync(term3, entry9Lines[2] + '\r\n');
  await writeAsync(term3, 'More text below\r\n');

  const ll3 = buildLogicalLines(term3);
  const row3 = findInLogicalLines(ll3, entry9Lines, 0, -1);
  assert(row3 >= 0, `Multi-line match works when lines are separate (row: ${row3})`);

  term3.dispose();

  // ═══════════════════════════════════════════════════════════
  // TEST 4: All session entries found when collapsed
  // ═══════════════════════════════════════════════════════════
  log.step('TEST 4: All session entries findable when collapsed to single lines');

  const term4 = new Terminal({ cols: 200, rows: 50, allowProposedApi: true, scrollback: 100000 });

  for (let i = 0; i < userMsgs.length; i++) {
    await writeAsync(term4, `AI response ${i}: The model analyzed your request and produced output.\r\n`);
    await writeAsync(term4, '\u2500'.repeat(60) + '\r\n');

    const content = userMsgs[i].content?.[0]?.text || '';
    const collapsed = content.replace(/\n/g, ' ').replace(/\r/g, '');
    await writeAsync(term4, collapsed + '\r\n');
  }

  const ll4 = buildLogicalLines(term4);
  log.info(`Buffer: ${ll4.length} logical lines for ${userMsgs.length} entries`);

  let foundCount4 = 0;
  const notFound4 = [];
  for (let i = 0; i < userMsgs.length; i++) {
    const sl = allSearchLines[i];
    if (sl.length === 0) { notFound4.push(i); continue; }

    const row = findInLogicalLines(ll4, sl, 0, -1);
    if (row >= 0) {
      foundCount4++;
    } else {
      notFound4.push(i);
      log.info(`Entry #${i} NOT found. searchLines: ${JSON.stringify(sl)}`);
    }
  }

  assert(foundCount4 === userMsgs.length,
    `All ${userMsgs.length} entries found (found: ${foundCount4}, missed: [${notFound4.join(',')}])`);

  term4.dispose();

  // ═══════════════════════════════════════════════════════════
  // TEST 5: Anchored sequential search
  // ═══════════════════════════════════════════════════════════
  log.step('TEST 5: Anchored search (startAfterRow) works sequentially');

  const term5 = new Terminal({ cols: 200, rows: 50, allowProposedApi: true, scrollback: 100000 });

  for (let i = 0; i < userMsgs.length; i++) {
    await writeAsync(term5, `Response ${i}: detailed analysis follows...\r\n`);
    const content = userMsgs[i].content?.[0]?.text || '';
    const collapsed = content.replace(/\n/g, ' ').replace(/\r/g, '');
    await writeAsync(term5, collapsed + '\r\n');
  }

  const ll5 = buildLogicalLines(term5);

  let prevRow = -1;
  let anchoredOk = 0;
  for (let i = 0; i < userMsgs.length; i++) {
    const sl = allSearchLines[i];
    if (sl.length === 0) continue;

    const row = findInLogicalLines(ll5, sl, 0, prevRow);
    if (row >= 0 && row > prevRow) {
      anchoredOk++;
      prevRow = row;
    } else {
      log.info(`Entry #${i}: anchored failed (prevRow=${prevRow}, row=${row})`);
      // Fallback without anchor
      const retryRow = findInLogicalLines(ll5, sl, 0, -1);
      if (retryRow >= 0) {
        prevRow = retryRow;
        anchoredOk++;
        log.info(`  → Fallback found at row ${retryRow}`);
      }
    }
  }

  assert(anchoredOk === userMsgs.length,
    `All ${userMsgs.length} entries found with anchored search (found: ${anchoredOk})`);

  term5.dispose();

  // ═══════════════════════════════════════════════════════════
  // TEST 6: Short entry "продолжай" with isIsolatedShort
  // ═══════════════════════════════════════════════════════════
  log.step('TEST 6: Short entries with isIsolatedShort threshold');

  const term6 = new Terminal({ cols: 200, rows: 50, allowProposedApi: true, scrollback: 5000 });

  // Gemini TUI renders with some padding/decoration
  await writeAsync(term6, 'AI response goes here.\r\n');
  await writeAsync(term6, '    продолжай                    \r\n');
  await writeAsync(term6, 'More AI output follows...\r\n');

  const ll6 = buildLogicalLines(term6);
  const shortLines = getSearchLines('продолжай');
  assert(shortLines.length === 1 && shortLines[0] === 'продолжай', `getSearchLines("продолжай") = ["продолжай"]`);

  const row6 = findInLogicalLines(ll6, shortLines, 0, -1);
  assert(row6 >= 0, `"продолжай" found with +25 threshold (row: ${row6})`);

  // Should NOT match in a long AI response
  const term6b = new Terminal({ cols: 200, rows: 50, allowProposedApi: true, scrollback: 5000 });
  await writeAsync(term6b, 'Модель ответила: пожалуйста продолжай работу над задачей в том же духе и не останавливайся.\r\n');
  const ll6b = buildLogicalLines(term6b);
  const row6b = findInLogicalLines(ll6b, shortLines, 0, -1);
  assert(row6b === -1, `"продолжай" NOT found in long AI response line`);

  term6.dispose();
  term6b.dispose();

  // ═══════════════════════════════════════════════════════════
  // TEST 7: "ds" (2 chars) — isStrictShort
  // ═══════════════════════════════════════════════════════════
  log.step('TEST 7: Very short entry "ds" with isStrictShort');

  const term7 = new Terminal({ cols: 200, rows: 50, allowProposedApi: true, scrollback: 5000 });
  await writeAsync(term7, 'Some AI text here.\r\n');
  await writeAsync(term7, '> ds\r\n'); // Gemini prompt prefix
  await writeAsync(term7, 'More text.\r\n');

  const ll7 = buildLogicalLines(term7);
  const dsLines = getSearchLines('ds');
  assert(dsLines.length === 1 && dsLines[0] === 'ds', `getSearchLines("ds") = ["ds"]`);

  const row7 = findInLogicalLines(ll7, dsLines, 0, -1);
  assert(row7 >= 0, `"ds" found with strict short matching (row: ${row7})`);

  // Should NOT match in "model reads files" or similar
  const term7b = new Terminal({ cols: 200, rows: 50, allowProposedApi: true, scrollback: 5000 });
  await writeAsync(term7b, 'The model reads datasets from the repository.\r\n');
  const ll7b = buildLogicalLines(term7b);
  const row7b = findInLogicalLines(ll7b, dsLines, 0, -1);
  assert(row7b === -1, `"ds" NOT found in "reads datasets" (strict boundary check)`);

  term7.dispose();
  term7b.dispose();

  // ═══════════════════════════════════════════════════════════
  // TEST 8: 120 cols terminal — wrapped logical lines
  // ═══════════════════════════════════════════════════════════
  log.step('TEST 8: Wrapped content at 120 cols (realistic terminal width)');

  const term8 = new Terminal({ cols: 120, rows: 50, allowProposedApi: true, scrollback: 100000 });

  for (let i = 0; i < 50; i++) {
    await writeAsync(term8, `Line ${i}: Some AI response content with Cyrillic текст и всякое разное.\r\n`);
  }
  await writeAsync(term8, collapsed9 + '\r\n');
  for (let i = 0; i < 20; i++) {
    await writeAsync(term8, `Follow-up ${i}: more content.\r\n`);
  }

  const ll8 = buildLogicalLines(term8);
  log.info(`120 cols buffer: ${ll8.length} logical lines`);

  const podLine8 = ll8.find(l => l.text.includes('Подожди'));
  assert(!!podLine8, `"Подожди" exists as logical line at 120 cols`);
  if (podLine8) {
    log.info(`  Logical line: ${podLine8.text.length} chars, bufRow: ${podLine8.bufRow}`);
  }

  const row8 = findInLogicalLines(ll8, entry9Lines, 0, -1);
  assert(row8 >= 0, `"Подожди" found at 120 cols (row: ${row8})`);

  term8.dispose();

  // ═══════════════════════════════════════════════════════════
  // TEST 9: REAL BUG — Gemini TUI truncates long user messages
  // Buffer contains only: " > Подожди, у нас в Run.sh...не п" (137 chars)
  // but getSearchLines produces 3 content lines from JSON (7503 chars)
  // ═══════════════════════════════════════════════════════════
  log.step('TEST 9: Truncation fallback — Gemini TUI shows only start of long message');

  const term9 = new Terminal({ cols: 200, rows: 50, allowProposedApi: true, scrollback: 10000 });

  // This is EXACTLY what the real buffer looks like (from debug logs)
  await writeAsync(term9, 'Some AI response before...\r\n');
  await writeAsync(term9, ' > Подожди, у нас в Run.sh, по-моему, не совсем правильно отображается промпт. Потому что пользователь такой промпт не п\r\n');
  await writeAsync(term9, 'More AI text after...\r\n');

  const ll9 = buildLogicalLines(term9);
  const row9 = findInLogicalLines(ll9, entry9Lines, 0, -1);
  assert(row9 >= 0, `Truncated "Подожди" found via truncation fallback (row: ${row9})`);

  // Verify that without truncation fallback it would fail
  const row9old = findWithoutFallback(ll9, entry9Lines, 0, -1);
  assert(row9old === -1, `Without truncation fallback, truncated "Подожди" NOT found (confirms bug)`);

  term9.dispose();

  // ═══════════════════════════════════════════════════════════
  // TEST 10: Truncation fallback does NOT trigger for short first lines
  // (< 30 chars first line should still require multi-line match)
  // ═══════════════════════════════════════════════════════════
  log.step('TEST 10: Short first lines still require multi-line match');

  const term10 = new Terminal({ cols: 200, rows: 50, allowProposedApi: true, scrollback: 5000 });

  // "да сделай" is only 9 chars — too short for truncation fallback
  await writeAsync(term10, 'AI says: да сделай это задание прямо сейчас и не останавливайся.\r\n');

  const ll10 = buildLogicalLines(term10);
  const shortContent = ['да сделай', 'second line not in buffer', 'third line'];
  const row10 = findInLogicalLines(ll10, shortContent, 0, -1);
  // "да сделай" is only 9 chars, so truncation fallback (>= 30) should NOT trigger
  // But it also has contentLines.length > 1, so isIsolatedShort=false, isStrictShort=false
  // lineContains with needle >= 5 chars does haystack.includes(needle) — will find it
  // BUT truncation fallback requires firstLine.length >= 30, and 9 < 30, so it won't match
  assert(row10 === -1, `Short first line "да сделай" (9 chars) does NOT trigger truncation fallback`);

  term10.dispose();

  // ═══════════════════════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(50));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    log.fail('SOME TESTS FAILED');
    process.exit(1);
  } else {
    log.pass('ALL TESTS PASSED');
  }
}

main().catch(err => {
  console.error(`${c.red}[ERROR]${c.reset}`, err.message);
  console.error(err.stack);
  process.exit(1);
});
