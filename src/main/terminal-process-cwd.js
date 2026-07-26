'use strict';

const fs = require('node:fs');
const path = require('node:path');

function collectDescendantProcessEntries(children, rootPid) {
  const normalizedRootPid = Number(rootPid);
  if (!Number.isInteger(normalizedRootPid) || normalizedRootPid <= 1 || !(children instanceof Map)) {
    return [];
  }

  const descendants = [];
  const stack = [{ pid: normalizedRootPid, depth: 0 }];
  const seen = new Set([normalizedRootPid]);
  while (stack.length > 0) {
    const current = stack.pop();
    const childEntries = children.get(current.pid) || [];
    for (const child of childEntries) {
      const childPid = Number(child?.pid);
      if (!Number.isInteger(childPid) || childPid <= 1 || seen.has(childPid)) continue;
      seen.add(childPid);
      const entry = {
        ...child,
        pid: childPid,
        depth: current.depth + 1,
      };
      descendants.push(entry);
      stack.push(entry);
    }
  }

  descendants.sort((a, b) => b.depth - a.depth || b.pid - a.pid);
  return descendants;
}

async function canonicalDirectory(value, {
  stat = fs.promises.stat,
  realpath = fs.promises.realpath,
} = {}) {
  if (typeof value !== 'string' || !value || !path.isAbsolute(value)) return null;
  try {
    const info = await stat(value);
    if (!info?.isDirectory?.()) return null;
    return await realpath(value);
  } catch {
    return null;
  }
}

async function selectTerminalCwdObservation({
  candidate,
  rootPid,
  observations = [],
  descendantsComplete = true,
  stat,
  realpath,
} = {}) {
  const valid = observations
    .filter((entry) => Number.isInteger(Number(entry?.pid)) && typeof entry?.cwd === 'string')
    .map((entry) => ({
      ...entry,
      pid: Number(entry.pid),
      depth: Number.isFinite(Number(entry.depth)) ? Number(entry.depth) : 0,
    }));
  const root = valid.find((entry) => entry.pid === Number(rootPid)) || null;

  if (typeof candidate !== 'string' || !candidate) {
    if (root) {
      return {
        status: 'found',
        cwd: root.cwd,
        pid: root.pid,
        source: 'pty-root',
      };
    }
    return descendantsComplete
      ? { status: 'absent', reason: 'successful-empty-snapshot' }
      : { status: 'unknown', reason: 'cwd-observation-incomplete' };
  }

  const canonicalCandidate = await canonicalDirectory(candidate, { stat, realpath });
  if (!canonicalCandidate) {
    return { status: 'unknown', reason: 'candidate-canonicalization-failed' };
  }

  const canonicalized = await Promise.all(valid.map(async (entry) => ({
    entry,
    canonicalCwd: await canonicalDirectory(entry.cwd, { stat, realpath }),
  })));
  const match = canonicalized
    .filter(({ canonicalCwd }) => canonicalCwd === canonicalCandidate)
    .sort((a, b) => b.entry.depth - a.entry.depth || b.entry.pid - a.entry.pid)[0];
  if (match) {
    return {
      status: 'found',
      cwd: match.entry.cwd,
      pid: match.entry.pid,
      source: match.entry.pid === Number(rootPid) ? 'pty-root' : 'pty-descendant',
      depth: match.entry.depth,
    };
  }

  if (!descendantsComplete) {
    return {
      status: 'unknown',
      reason: 'cwd-observation-incomplete',
      cwd: root?.cwd || null,
    };
  }
  if (root) {
    return {
      status: 'found',
      cwd: root.cwd,
      pid: root.pid,
      source: 'pty-root-no-candidate-match',
    };
  }
  return { status: 'absent', reason: 'successful-empty-snapshot' };
}

module.exports = {
  canonicalDirectory,
  collectDescendantProcessEntries,
  selectTerminalCwdObservation,
};
