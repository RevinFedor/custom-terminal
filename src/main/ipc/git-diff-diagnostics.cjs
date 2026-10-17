'use strict';

const { createHash } = require('node:crypto');

function validGitDiffRequestId(value) {
  return typeof value === 'string' && /^git-diff-[\w-]{1,72}$/.test(value) ? value : null;
}

function stableGitPathIdentity(value) {
  return typeof value === 'string' && value.length
    ? 'sha256:' + createHash('sha256').update(value).digest('hex').slice(0, 20)
    : null;
}

function measureGitDiffText(text) {
  const value = typeof text === 'string' ? text : '';
  let newlineCount = 0;
  for (let i = 0; i < value.length; i++) if (value.charCodeAt(i) === 10) newlineCount++;
  return {
    chars: value.length,
    utf8Bytes: Buffer.byteLength(value, 'utf8'),
    lines: value.length ? newlineCount + (value.charCodeAt(value.length - 1) === 10 ? 0 : 1) : 0,
  };
}

module.exports = { validGitDiffRequestId, stableGitPathIdentity, measureGitDiffText };
