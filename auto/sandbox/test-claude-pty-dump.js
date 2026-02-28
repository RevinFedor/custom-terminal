/**
 * Diagnostic: Raw PTY output capture during Claude thinking
 *
 * Spawns Claude via node-pty, sends a "think hard" prompt,
 * captures ALL raw data chunks and logs them with:
 * - Hex dump of special characters
 * - Unicode codepoints
 * - Stripped text for readability
 *
 * Usage: node auto/sandbox/test-claude-pty-dump.js
 */

const pty = require('node-pty');
const os = require('os');
const fs = require('fs');
const path = require('path');

const c = { R: '\x1b[0m', G: '\x1b[32m', C: '\x1b[36m', Y: '\x1b[33m', D: '\x1b[2m', M: '\x1b[35m' };
const ts = () => new Date().toISOString().slice(11, 23);

// Output log file
const LOG_FILE = path.join(__dirname, 'pty-dump.log');
const logStream = fs.createWriteStream(LOG_FILE);

let chunkCount = 0;
let phase = 'LAUNCH'; // LAUNCH → WAIT_PROMPT → SEND_PROMPT → THINKING → DONE
let promptSeen = false;
let promptSentAt = 0;

// Kill after 90s
const timer = setTimeout(() => {
  console.error('\n[TIMEOUT] 90s');
  process.exit(2);
}, 90000);
timer.unref();

// Interesting Unicode/ANSI patterns to highlight
const PATTERNS = {
  PROMPT_PLAY: '\u23F5',     // ⏵
  PROMPT_ARROW: '\u276F',    // ❯
  STAR_4: '\u2736',          // ✶
  STAR_CROSS: '\u2722',      // ✢
  STAR_6: '\u273B',          // ✻
  SPARKLE: '\u2726',         // ✦
  SPINNER_DOT: '\u25CF',     // ●
  THINKING_BRAILLE: /[\u2800-\u28FF]/,  // Braille pattern chars (sometimes used for spinners)
};

function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
            .replace(/\x1b\][^\x07]*\x07/g, '')
            .replace(/\x1b\[\?[0-9;]*[hl]/g, '')
            .replace(/\r/g, '');
}

function highlightSpecialChars(raw) {
  const highlights = [];
  for (let i = 0; i < raw.length; i++) {
    const cp = raw.codePointAt(i);
    if (cp > 0x7F && cp !== 0x1B) { // Non-ASCII, non-ESC
      const char = String.fromCodePoint(cp);
      highlights.push(`U+${cp.toString(16).toUpperCase().padStart(4, '0')} '${char}'`);
      if (cp > 0xFFFF) i++; // surrogate pair
    }
  }
  return highlights;
}

function analyzeChunk(data) {
  chunkCount++;
  const stripped = stripAnsi(data);
  const trimmed = stripped.replace(/\s+/g, ' ').trim();

  // Check for key markers
  const hasPrompt = data.includes('\u23F5') || data.includes('\u276F');
  const hasThinkingStar = data.includes('\u2722') || data.includes('\u2736') || data.includes('\u273B');
  const hasSparkle = data.includes('\u2726');
  const hasCursorMove = /\x1b\[\d+[ABCDEFGHJKf]/.test(data);
  const hasEraseInLine = /\x1b\[\d*K/.test(data);
  const hasEraseInDisplay = /\x1b\[\d*J/.test(data);
  const hasScrollRegion = /\x1b\[\d+;\d+r/.test(data);
  const hasSyncMarker = data.includes('\x1b[?2026');

  // Log to file (full raw with escapes visible)
  const escaped = data.replace(/\x1b/g, '\\e')
                      .replace(/\r/g, '\\r')
                      .replace(/\n/g, '\\n');
  logStream.write(`\n--- Chunk #${chunkCount} [${ts()}] phase=${phase} len=${data.length} ---\n`);
  logStream.write(`RAW: ${escaped}\n`);
  logStream.write(`STRIPPED: ${trimmed}\n`);

  const unicodes = highlightSpecialChars(data);
  if (unicodes.length > 0) {
    logStream.write(`UNICODE: ${unicodes.join(', ')}\n`);
  }

  // Console output — compact
  let flags = [];
  if (hasPrompt) flags.push(`${c.G}PROMPT${c.R}`);
  if (hasThinkingStar) flags.push(`${c.M}THINKING_STAR${c.R}`);
  if (hasSparkle) flags.push(`${c.M}SPARKLE${c.R}`);
  if (hasSyncMarker) flags.push(`${c.Y}SYNC${c.R}`);
  if (hasCursorMove) flags.push('CURSOR');
  if (hasEraseInLine) flags.push('EIL');
  if (hasEraseInDisplay) flags.push('EID');
  if (hasScrollRegion) flags.push('SCROLL');

  const flagStr = flags.length > 0 ? ` [${flags.join(' ')}]` : '';
  const preview = trimmed.slice(0, 100) || '(empty/whitespace)';

  console.log(`${c.D}#${chunkCount}${c.R} ${c.C}${ts()}${c.R} ${phase} len=${data.length}${flagStr}`);
  if (trimmed.length > 0) {
    console.log(`  ${c.D}${preview}${c.R}`);
  }
  if (unicodes.length > 0 && unicodes.length <= 10) {
    console.log(`  ${c.M}${unicodes.join(', ')}${c.R}`);
  }

  // Phase transitions
  if (phase === 'LAUNCH' || phase === 'WAIT_PROMPT') {
    if (hasPrompt) {
      console.log(`  ${c.G}>>> PROMPT DETECTED <<<${c.R}`);
      phase = 'WAIT_PROMPT';
      if (!promptSeen) {
        promptSeen = true;
        // Debounce: send prompt after 500ms of prompt stability
        setTimeout(() => {
          sendPrompt();
        }, 1000);
      }
    }
  }

  if (phase === 'THINKING') {
    const elapsed = Date.now() - promptSentAt;
    if (hasPrompt && elapsed > 3000) {
      console.log(`  ${c.G}>>> PROMPT RETURNED — Claude done thinking (${elapsed}ms) <<<${c.R}`);
      phase = 'DONE';
      setTimeout(() => {
        console.log(`\n${'═'.repeat(50)}`);
        console.log(`Total chunks: ${chunkCount}`);
        console.log(`Log file: ${LOG_FILE}`);
        console.log(`${'═'.repeat(50)}`);
        process.exit(0);
      }, 2000); // Capture 2 more seconds of idle data
    }
  }
}

function sendPrompt() {
  console.log(`\n${c.Y}>>> SENDING PROMPT <<<${c.R}\n`);
  phase = 'SENDING';

  // Use bracketed paste to send a thinking prompt
  const prompt = 'think step by step about why 137 is special in physics. use extended thinking.';
  const paste = '\x1b[200~' + prompt + '\x1b[201~';

  // Send paste
  term.write(paste);

  // Send Enter after 200ms
  setTimeout(() => {
    term.write('\r');
    promptSentAt = Date.now();
    phase = 'THINKING';
    console.log(`${c.Y}>>> ENTER SENT — now watching for thinking patterns <<<${c.R}\n`);
  }, 200);
}

// === SPAWN PTY ===
console.log(`${c.C}=== Claude PTY Dump ===${c.R}`);
console.log(`Spawning claude --dangerously-skip-permissions...\n`);

const shell = process.env.SHELL || '/bin/zsh';
const term = pty.spawn(shell, ['-l'], {
  name: 'xterm-256color',
  cols: 120,
  rows: 30,
  cwd: process.cwd(),
  env: {
    ...process.env,
    COLORTERM: 'truecolor',
    LANG: process.env.LANG || 'en_US.UTF-8',
    LC_ALL: process.env.LC_ALL || 'en_US.UTF-8',
    // Remove nested session detection vars
    CLAUDE_CODE_ENTRYPOINT: '',
    CLAUDECODE: '',
  }
});

term.onData((data) => {
  analyzeChunk(data);
});

term.onExit(({ exitCode }) => {
  console.log(`\nPTY exited with code ${exitCode}`);
  process.exit(exitCode);
});

// Send claude command after shell init
setTimeout(() => {
  console.log(`${c.Y}>>> Starting Claude <<<${c.R}\n`);
  term.write('claude --dangerously-skip-permissions\r');
}, 1500);
