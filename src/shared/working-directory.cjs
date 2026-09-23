'use strict';

// Interpret the app's home shorthand before filesystem validation/spawn.
// The caller supplies native home/path APIs; renderer process.env may be a
// bundler replacement, and a missing explicit directory must never fall back.
function resolveWorkingDirectory(cwd, homeDirectory, paths) {
  const requested = cwd || homeDirectory;
  if (requested === '~') return homeDirectory;
  if (typeof requested === 'string'
    && (requested.startsWith('~/') || (paths.sep === '\\' && requested.startsWith('~\\')))) {
    return paths.join(homeDirectory, requested.slice(2));
  }
  return requested;
}

module.exports = { resolveWorkingDirectory };
