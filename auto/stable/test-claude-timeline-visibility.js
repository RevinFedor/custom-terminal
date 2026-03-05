/**
 * Test: Claude Timeline — marker-based visibility & range overlap
 *
 * Verifies that Claude timeline visibility uses OSC 7777 markers (O(1) lookup),
 * NOT text search. Each entry binds to a unique marker → no duplicate position
 * problem like Gemini's buildPositionIndex.
 *
 * Tests:
 * 1. Marker registration via OSC 7777 state machine
 * 2. getMarkerRow returns correct buffer rows
 * 3. Range-based viewport overlap (same logic as Timeline.tsx checkVisibility)
 * 4. First entry has no marker (typed at initial prompt) → gets position 0
 * 5. Marker disposal on scrollback trim → entry becomes unreachable
 * 6. Duplicate user text doesn't cause false visibility (unlike text search)
 *
 * [Headless] — no Electron, no AI, < 1 second.
 *
 * Run: node auto/sandbox/test-claude-timeline-visibility.js
 */

const { Terminal } = require('@xterm/xterm');
const { assert, log, writeAndWait, createMiddleware } = require('../core/headless');

// ─── Simulate terminalRegistry marker APIs ───
// Replicate the exact logic from terminalRegistry.ts

const entryMarkers = new Map(); // tabId → Map<uuid, { marker, isReachable }>

function registerEntryMarker(tabId, uuid, marker) {
  let tab = entryMarkers.get(tabId);
  if (!tab) { tab = new Map(); entryMarkers.set(tabId, tab); }
  const tracked = { uuid, marker, isReachable: true };
  marker.onDispose(() => { tracked.isReachable = false; tracked.marker = null; });
  tab.set(uuid, tracked);
}

function getMarkerRow(tabId, uuid) {
  const tab = entryMarkers.get(tabId);
  if (!tab) return -1;
  const tracked = tab.get(uuid);
  if (!tracked?.marker || tracked.marker.isDisposed) return -1;
  return tracked.marker.line;
}

function isEntryReachable(tabId, uuid) {
  const tab = entryMarkers.get(tabId);
  if (!tab) return true;
  const tracked = tab.get(uuid);
  if (!tracked) return true;
  return tracked.isReachable;
}

// ─── Range-based visibility (from Timeline.tsx checkVisibility) ───
function computeVisibility(positions, viewport) {
  const sorted = positions
    .map((row, index) => ({ index, row }))
    .filter(x => x.row >= 0)
    .sort((a, b) => a.row - b.row);

  const visible = new Set();
  for (let i = 0; i < sorted.length; i++) {
    const blockStart = sorted[i].row;
    const blockEnd = i + 1 < sorted.length ? sorted[i + 1].row : Infinity;
    if (blockStart < viewport.bottom && blockEnd > viewport.top) {
      visible.add(sorted[i].index);
    }
  }
  return visible;
}

async function main() {
  const hardKill = setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, 15000);

  // ════════════════════════════════════════════
  // TEST 1: Marker creation via OSC 7777
  // ════════════════════════════════════════════
  log.step('TEST 1: OSC 7777 markers create unique positions for each entry');

  const tabId = 'test-tab';
  const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true, scrollback: 1000 });
  const promptBoundaries = new Map(); // seq → marker

  // Register OSC handler (same as Terminal.tsx)
  term.parser.registerOscHandler(7777, (data) => {
    if (data.startsWith('prompt:')) {
      const seq = parseInt(data.slice(7), 10);
      const marker = term.registerMarker(0);
      if (marker) {
        promptBoundaries.set(seq, marker);
        marker.onDispose(() => promptBoundaries.delete(seq));
      }
    }
    return true;
  });

  const mw = createMiddleware();

  // Simulate 5-message session with IDENTICAL user messages
  // (this would break text-based search but markers handle it fine)
  const userMessages = [
    'проверь статус',    // Entry 0 — typed at initial prompt, NO marker
    'проверь статус',    // Entry 1 — identical text! But different marker.
    'проверь статус',    // Entry 2 — identical again
    'сделай рефактор',   // Entry 3 — different text
    'проверь статус',    // Entry 4 — identical to 0,1,2
  ];

  // Write initial prompt
  let out = mw.process('\u23F5 ');
  await writeAndWait(term, out);

  for (let i = 0; i < userMessages.length; i++) {
    // User types message → idle→busy
    out = mw.process(userMessages[i] + '\r\n');
    await writeAndWait(term, out);

    // AI response (20 lines of varying content)
    for (let j = 0; j < 20; j++) {
      out = mw.process(`Response ${i} line ${j}: analysis of the codebase...\r\n`);
      await writeAndWait(term, out);
    }

    // Prompt returns → busy→idle, OSC injected
    out = mw.process(`\u23F5 `);
    await writeAndWait(term, out);
  }

  // Bind entries to prompt boundaries (same logic as Timeline.tsx useEffect)
  const entryUuids = userMessages.map((_, i) => `uuid-${i}`);
  // Entry N maps to prompt boundary N-1 (entry 0 has no boundary)
  for (let i = 1; i < entryUuids.length; i++) {
    const marker = promptBoundaries.get(i - 1);
    if (marker && !marker.isDisposed) {
      registerEntryMarker(tabId, entryUuids[i], marker);
    }
  }

  // Verify markers exist for entries 1-4 (entry 0 has no marker)
  assert(getMarkerRow(tabId, 'uuid-0') === -1,
    'Entry 0 has no marker (typed at initial prompt)');

  for (let i = 1; i < entryUuids.length; i++) {
    const row = getMarkerRow(tabId, entryUuids[i]);
    assert(row >= 0, `Entry ${i} has marker at row ${row}`);
  }

  // All markers should have UNIQUE rows (even for identical text!)
  const rows = entryUuids.slice(1).map(uuid => getMarkerRow(tabId, uuid));
  const uniqueRows = new Set(rows);
  assert(uniqueRows.size === rows.length,
    `All ${rows.length} markers have unique rows (${uniqueRows.size} unique)`);

  // Rows should be ascending
  let ascending = true;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i] <= rows[i - 1]) { ascending = false; break; }
  }
  assert(ascending, `Marker rows are ascending: [${rows.join(', ')}]`);

  // ════════════════════════════════════════════
  // TEST 2: computePositions logic for Claude
  // ════════════════════════════════════════════
  log.step('TEST 2: computePositions — first entry gets position 0');

  // Replicate computePositions from Timeline.tsx (Claude branch)
  const positions = entryUuids.map(uuid => getMarkerRow(tabId, uuid));
  // First real entry without marker → position 0
  if (positions[0] < 0) positions[0] = 0;

  assert(positions[0] === 0, `Entry 0 position set to 0 (no marker → buffer start)`);
  for (let i = 1; i < positions.length; i++) {
    assert(positions[i] >= 0, `Entry ${i} has position ${positions[i]}`);
  }

  // All positions unique
  const uniquePos = new Set(positions);
  assert(uniquePos.size === positions.length,
    `All ${positions.length} positions unique`);

  // ════════════════════════════════════════════
  // TEST 3: Viewport overlap — correct entry visible
  // ════════════════════════════════════════════
  log.step('TEST 3: Viewport overlap — only correct entry active');

  // Viewport at entry 2's position + a few rows into its response
  const entry2Row = positions[2];
  const viewport = { top: entry2Row + 2, bottom: entry2Row + 15 };

  const visible = computeVisibility(positions, viewport);
  assert(visible.has(2), `Entry 2 is visible in its own viewport`);

  // Entry 1 and 4 have IDENTICAL text ("проверь статус") but should NOT be visible
  assert(!visible.has(1), `Entry 1 (same text as 2) is NOT visible — marker disambiguates`);
  assert(!visible.has(4), `Entry 4 (same text as 2) is NOT visible — marker disambiguates`);
  log.info(`Visible at viewport [${viewport.top}, ${viewport.bottom}): [${[...visible].join(', ')}]`);

  // ════════════════════════════════════════════
  // TEST 4: Scrollback trim → markers disposed → unreachable
  // ════════════════════════════════════════════
  log.step('TEST 4: Scrollback trim disposes old markers');

  // Create a small-scrollback terminal to trigger trim
  const term2 = new Terminal({ cols: 80, rows: 10, allowProposedApi: true, scrollback: 50 });
  const tab2 = 'trim-tab';
  const promptBoundaries2 = new Map();

  term2.parser.registerOscHandler(7777, (data) => {
    if (data.startsWith('prompt:')) {
      const seq = parseInt(data.slice(7), 10);
      const marker = term2.registerMarker(0);
      if (marker) {
        promptBoundaries2.set(seq, marker);
        marker.onDispose(() => promptBoundaries2.delete(seq));
      }
    }
    return true;
  });

  const mw2 = createMiddleware();

  // Write 2 messages
  let out2 = mw2.process('\u23F5 ');
  await writeAndWait(term2, out2);

  out2 = mw2.process('first message\r\n');
  await writeAndWait(term2, out2);
  for (let j = 0; j < 5; j++) {
    out2 = mw2.process(`Short response ${j}\r\n`);
    await writeAndWait(term2, out2);
  }
  out2 = mw2.process('\u23F5 ');
  await writeAndWait(term2, out2);

  // Bind entry 1 to prompt boundary 0
  const earlyMarker = promptBoundaries2.get(0);
  if (earlyMarker) {
    registerEntryMarker(tab2, 'early-uuid', earlyMarker);
  }

  const earlyRowBefore = getMarkerRow(tab2, 'early-uuid');
  assert(earlyRowBefore >= 0, `Early marker exists at row ${earlyRowBefore}`);
  assert(isEntryReachable(tab2, 'early-uuid'), `Early entry is reachable before trim`);

  // Flood buffer to push early content out of scrollback (50 lines)
  out2 = mw2.process('second message\r\n');
  await writeAndWait(term2, out2);
  for (let j = 0; j < 100; j++) {
    out2 = mw2.process(`Flood line ${j}: pushing old content out of scrollback buffer...\r\n`);
    await writeAndWait(term2, out2);
  }

  // Early marker should now be disposed
  const earlyRowAfter = getMarkerRow(tab2, 'early-uuid');
  assert(earlyRowAfter === -1, `Early marker disposed after scrollback trim (row: ${earlyRowAfter})`);
  assert(!isEntryReachable(tab2, 'early-uuid'), `Early entry is unreachable after trim`);

  // ════════════════════════════════════════════
  // TEST 5: No false visibility for duplicate text
  // ════════════════════════════════════════════
  log.step('TEST 5: Duplicate text — markers prevent false multi-activation');

  // With 4 identical "проверь статус" entries, text search would highlight ALL of them
  // when any one is in viewport. Markers give each a unique position → only 1 active.
  for (let testEntry = 0; testEntry < userMessages.length; testEntry++) {
    const testRow = positions[testEntry];
    const vp = { top: testRow + 1, bottom: testRow + 10 };
    const vis = computeVisibility(positions, vp);

    // Only this entry (and possibly adjacent) should be visible
    const identicalIndices = userMessages
      .map((msg, i) => msg === userMessages[testEntry] && i !== testEntry ? i : -1)
      .filter(i => i >= 0);

    const falsePositives = identicalIndices.filter(i => vis.has(i));
    assert(falsePositives.length === 0,
      `Entry ${testEntry} viewport: no false positives from identical text (${falsePositives.length} FP)`);
  }

  // Cleanup
  term.dispose();
  term2.dispose();
  clearTimeout(hardKill);
}

main().catch(err => { console.error(err.message); process.exit(1); });
