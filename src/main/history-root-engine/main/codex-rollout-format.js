'use strict';

// Codex keeps a logical *.jsonl address while cold files may physically be
// *.jsonl.zst. Presence checks never decode transcript bytes.
const fs = require('node:fs');

function isCodexRolloutFile(value) {
  return typeof value === 'string' && /\.jsonl(?:\.zst)?$/.test(value);
}
function plainRolloutPath(value) {
  return typeof value === 'string' && value.endsWith('.jsonl.zst') ? value.slice(0, -4) : value;
}
function compressedRolloutPath(value) { return plainRolloutPath(value) + '.zst'; }
function rolloutRepresentation(value) { return value?.endsWith('.jsonl.zst') ? 'zstd' : 'jsonl'; }

async function resolveExistingRollout(value, { stat = fs.promises.stat.bind(fs.promises) } = {}) {
  const plain = plainRolloutPath(value);
  for (const filePath of [plain, compressedRolloutPath(plain)]) {
    try {
      const sourceStat = await stat(filePath);
      if (sourceStat.isFile()) return { state: 'present', filePath, logicalFilePath: plain,
        representation: rolloutRepresentation(filePath), sourceStat };
    } catch (error) {
      // An uninspectable preferred plain file is not permission to return an
      // older compressed sibling as if it were the current source.
      if (!['ENOENT', 'ENOTDIR'].includes(error?.code)) return { state: 'unknown', filePath: null, logicalFilePath: plain };
    }
  }
  return { state: 'missing', filePath: null, logicalFilePath: plain };
}

module.exports = { isCodexRolloutFile, plainRolloutPath, compressedRolloutPath,
  rolloutRepresentation, resolveExistingRollout };
