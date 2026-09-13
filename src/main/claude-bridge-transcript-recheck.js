'use strict';

const fs = require('node:fs');
const path = require('node:path');

// A statusLine bridge can precede its first JSONL. File appearance is only a
// wake-up: onReady must rerun the normal live PID/cwd/transcript admission.
function createClaudeBridgeTranscriptRecheck({ onReady, fsImpl = fs, log = console } = {}) {
  const pending = new Map();
  const directories = new Map();

  function remove(entry) {
    if (pending.get(entry.filename) !== entry) return;
    pending.delete(entry.filename);
    const dir = directories.get(entry.directory);
    dir?.entries.delete(entry);
    if (dir && dir.entries.size === 0) {
      try { dir.watcher?.close(); } catch {}
      directories.delete(entry.directory);
    }
  }

  function check(entry) {
    if (pending.get(entry.filename) !== entry) return;
    if (!entry.isCurrent()) { remove(entry); return; }
    if (!fsImpl.existsSync(entry.transcriptPath)) return;
    remove(entry);
    log.log?.('[Bridge:TranscriptAppeared] tab=' + String(entry.tabId).slice(-12)
      + ' session=' + String(entry.sessionId).slice(0, 8));
    Promise.resolve().then(() => {
      if (entry.isCurrent()) return onReady(entry);
    }).catch(error => log.warn?.('[Bridge:TranscriptRecheck] ' + error.message));
  }

  function defer(candidate) {
    const previous = pending.get(candidate.filename);
    if (previous) remove(previous);
    const entry = { ...candidate, directory: path.dirname(candidate.transcriptPath) };
    pending.set(entry.filename, entry);
    let dir = directories.get(entry.directory);
    if (!dir) {
      dir = { entries: new Set(), watcher: null };
      directories.set(entry.directory, dir);
      try {
        dir.watcher = fsImpl.watch(entry.directory, { persistent: false }, (_event, filename) => {
          for (const waiting of [...dir.entries]) {
            if (!filename || String(filename) === path.basename(waiting.transcriptPath)) check(waiting);
          }
        });
        dir.watcher.on('error', error => {
          log.warn?.('[Bridge:TranscriptRecheck] watcher failed code=' + (error.code || 'unknown'));
          try { dir.watcher?.close(); } catch {}
          dir.watcher = null;
        });
      } catch (error) {
        log.warn?.('[Bridge:TranscriptRecheck] watch unavailable code=' + (error.code || 'unknown'));
      }
    }
    dir.entries.add(entry);
    // Close the stat-before-watch race. The bridge's existing scan also calls
    // recheck as its fallback; no new polling or readiness timeout is created.
    check(entry);
  }

  return {
    defer,
    recheck: () => { for (const entry of [...pending.values()]) check(entry); },
    clearTab: tabId => {
      for (const entry of [...pending.values()]) if (entry.tabId === tabId) remove(entry);
    },
    dispose: () => { for (const entry of [...pending.values()]) remove(entry); },
  };
}

module.exports = { createClaudeBridgeTranscriptRecheck };
