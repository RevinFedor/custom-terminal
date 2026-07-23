'use strict';

const crypto = require('node:crypto');

function normalizeCodexRewindTargetText(text) {
  return String(text || '').trim();
}

function hashCodexRewindTargetText(text) {
  return crypto
    .createHash('sha256')
    .update(normalizeCodexRewindTargetText(text))
    .digest('hex');
}

function buildCodexRewindMessageProof({
  text = '',
  images = [],
  textElements = [],
} = {}) {
  const normalizedText = normalizeCodexRewindTargetText(text);
  return {
    textHash: hashCodexRewindTargetText(normalizedText),
    signature: crypto
      .createHash('sha256')
      .update(JSON.stringify({
        text: normalizedText,
        images: Array.isArray(images) ? images.map(String) : [],
        textElements: Array.isArray(textElements) ? textElements : [],
      }))
      .digest('hex'),
  };
}

module.exports = {
  buildCodexRewindMessageProof,
  hashCodexRewindTargetText,
  normalizeCodexRewindTargetText,
};
