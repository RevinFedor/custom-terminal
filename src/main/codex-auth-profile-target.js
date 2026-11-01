'use strict';

const fs = require('node:fs');
const path = require('node:path');
const LIMIT = 16 * 1024;
const fail = code => Object.assign(new Error(code), { code });
const inside = (root, file) => file.startsWith(root + path.sep);

// An explicit existing-account source is usable by an isolated packaged test,
// never by an ordinary packaged startup. CLI home isolation is checked by Main
// first; this file only pins the local opt-in config to the actual app image.
function readPackagedAuthProfileConfiguration({ configPath, appPath, isolation }) {
  if (!isolation?.root || !path.isAbsolute(configPath || '') || !path.isAbsolute(appPath || ''))
    throw fail('codex_auth_profile_requires_explicit_private_test_target');
  const root = fs.realpathSync(isolation.root), file = fs.realpathSync(configPath);
  if (!inside(root, file)) throw fail('codex_auth_profile_configuration_outside_lease');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  let text;
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size > LIMIT) throw fail('codex_auth_profile_configuration_invalid');
    const buffer = Buffer.alloc(LIMIT + 1);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0), after = fs.fstatSync(fd);
    if (bytes > LIMIT || bytes !== before.size || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)
      throw fail('codex_auth_profile_configuration_changed');
    text = buffer.toString('utf8', 0, bytes);
  } finally { fs.closeSync(fd); }
  const configuration = JSON.parse(text), target = configuration?.target;
  if (configuration.version !== 1 || target?.kind !== 'isolated-packaged'
    || !path.isAbsolute(target.appPath || ''))
    throw fail('codex_auth_profile_requires_explicit_private_test_target');
  if (fs.realpathSync(target.appPath) !== fs.realpathSync(appPath))
    throw fail('codex_auth_profile_packaged_target_mismatch');
  return configuration;
}

module.exports = { readPackagedAuthProfileConfiguration };
