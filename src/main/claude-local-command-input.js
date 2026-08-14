'use strict';

function sameOwner(left, right) {
  if (!left || !right) return false;
  return left.terminal === right.terminal
    && left.sessionId === right.sessionId
    && left.generation === right.generation
    && Number(left.promptSeq) === Number(right.promptSeq);
}

/**
 * Reconstruct one manual agent composer line from xterm input events.
 *
 * The state is observational only: it never authorizes a PTY write.  A line is
 * returned as submitted only when the same terminal/session/launch/prompt
 * generation later carries Enter.  Terminal protocol replies are ignored so
 * focus/cursor reports cannot become phantom user text.
 */
function advanceManualInputLineState(
  previous,
  {
    data,
    owner,
    isTerminalProtocolResponse = false,
  } = {},
) {
  if (typeof data !== 'string' || data.length === 0) {
    return {
      state: previous || null,
      submittedCommands: [],
      submittedCommandDetails: [],
      reason: 'empty-data',
    };
  }
  if (isTerminalProtocolResponse) {
    return {
      state: previous || null,
      submittedCommands: [],
      submittedCommandDetails: [],
      reason: 'terminal-response',
    };
  }

  const base = sameOwner(previous?.owner, owner)
    ? previous
    : { text: '', owner, truncated: false };
  let text = String(base.text || '');
  let truncated = base.truncated === true;
  const submittedCommands = [];
  const submittedCommandDetails = [];
  const flush = () => {
    const command = text.trim();
    if (command) {
      submittedCommands.push(command);
      submittedCommandDetails.push({ text: command, truncated });
    }
    text = '';
    truncated = false;
  };

  const clean = data
    .replace(/\x1b\[200~/g, '')
    .replace(/\x1b\[201~/g, '');

  for (let index = 0; index < clean.length; index += 1) {
    const char = clean[index];
    const code = clean.charCodeAt(index);
    if (char === '\r' || char === '\n') {
      flush();
      continue;
    }
    if (char === '\x7f' || char === '\x08') {
      text = text.slice(0, -1);
      continue;
    }
    if (char === '\x15' || char === '\x03') {
      text = '';
      truncated = false;
      continue;
    }
    if (char === '\x1b') {
      if (clean.length === 1) {
        text = '';
        truncated = false;
        continue;
      }
      while (
        index + 1 < clean.length
        && !/[A-Za-z~]/.test(clean[index + 1])
      ) {
        index += 1;
      }
      if (index + 1 < clean.length) index += 1;
      continue;
    }
    if (code >= 32 && code !== 127) {
      text += char;
      if (text.length > 200) {
        text = text.slice(-200);
        truncated = true;
      }
    }
  }

  return {
    state: text ? { text, owner, truncated } : null,
    submittedCommands,
    submittedCommandDetails,
    reason: sameOwner(previous?.owner, owner) ? 'same-owner' : 'owner-reset',
  };
}

module.exports = {
  advanceManualInputLineState,
  // Compatibility name for the existing Claude caller/tests. The state
  // machine is provider-neutral; ownership and completion remain provider
  // specific at the caller/registry boundary.
  advanceClaudeLocalCommandInputState: advanceManualInputLineState,
  sameOwner,
};
