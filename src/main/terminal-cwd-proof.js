'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Validate an OSC 7 cwd candidate against the cwd observed from the live PTY
 * process. The terminal escape sequence is only a candidate; process state is
 * the proof. Canonical comparison permits a logical symlink path reported by
 * the shell while lsof/proc reports its physical target.
 */
async function validateTerminalCwdCandidate({
  candidate,
  readLiveCwd,
  stat = fs.promises.stat,
  realpath = fs.promises.realpath,
} = {}) {
  if (typeof candidate !== 'string' || !candidate || !path.isAbsolute(candidate)) {
    return { accepted: false, reason: 'candidate-not-absolute' };
  }

  let candidateStat;
  try {
    candidateStat = await stat(candidate);
  } catch {
    return { accepted: false, reason: 'candidate-missing' };
  }
  if (!candidateStat || typeof candidateStat.isDirectory !== 'function' || !candidateStat.isDirectory()) {
    return { accepted: false, reason: 'candidate-not-directory' };
  }

  if (typeof readLiveCwd !== 'function') {
    return { accepted: false, reason: 'live-cwd-unknown' };
  }

  let observedCwd;
  try {
    observedCwd = await readLiveCwd();
  } catch {
    return { accepted: false, reason: 'live-cwd-unknown' };
  }
  if (typeof observedCwd !== 'string' || !observedCwd || !path.isAbsolute(observedCwd)) {
    return { accepted: false, reason: 'live-cwd-unknown' };
  }

  let observedStat;
  try {
    observedStat = await stat(observedCwd);
  } catch {
    return { accepted: false, reason: 'live-cwd-unknown', observedCwd };
  }
  if (!observedStat || typeof observedStat.isDirectory !== 'function' || !observedStat.isDirectory()) {
    return { accepted: false, reason: 'live-cwd-unknown', observedCwd };
  }

  let canonicalCandidate;
  let canonicalObserved;
  try {
    [canonicalCandidate, canonicalObserved] = await Promise.all([
      realpath(candidate),
      realpath(observedCwd),
    ]);
  } catch {
    return { accepted: false, reason: 'canonical-cwd-unknown', observedCwd };
  }

  if (canonicalCandidate !== canonicalObserved) {
    return { accepted: false, reason: 'live-cwd-mismatch', observedCwd };
  }

  return {
    accepted: true,
    reason: 'live-cwd-match',
    cwd: candidate,
    observedCwd,
  };
}

module.exports = {
  validateTerminalCwdCandidate,
};
