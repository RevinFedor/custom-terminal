'use strict';
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

// One main instance has one Claude data namespace. No fallback to the global
// projects tree when the explicitly selected private directory is empty.
function claudeConfigDir(env = process.env, home = os.homedir()) {
  const configured = typeof env.CLAUDE_CONFIG_DIR === 'string' ? env.CLAUDE_CONFIG_DIR : '';
  if (!configured) return path.join(home, '.claude');
  if (!path.isAbsolute(configured)) throw new Error('claude_config_dir_must_be_absolute');
  return path.resolve(configured);
}
function claudeProjectsDir() { return path.join(claudeConfigDir(), 'projects'); }
function claudeBridgeDir() { return path.join(claudeConfigDir(), 'bridge'); }
function assertClaudeDataPath(filePath) {
  if (!process.env.CLAUDE_CONFIG_DIR) return filePath;
  const root = fs.realpathSync(claudeConfigDir());
  let existing = path.resolve(filePath);
  const suffix = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) throw new Error('claude_data_path_unavailable');
    suffix.unshift(path.basename(existing)); existing = parent;
  }
  const actual = path.resolve(fs.realpathSync(existing), ...suffix);
  const relative = path.relative(root, actual);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('claude_data_path_outside_config_dir');
  }
  return filePath;
}
module.exports = { claudeConfigDir, claudeProjectsDir, claudeBridgeDir, assertClaudeDataPath };
