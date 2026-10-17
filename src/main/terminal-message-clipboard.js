'use strict';
const path = require('node:path');
const { pathToFileURL } = require('node:url');
let codec;
function loadCodec() {
  // The normal package contains src/main and src/shared together. This module
  // is loaded from srcMainDir, just like the existing copy diagnostic helper.
  return codec ||= import(pathToFileURL(path.join(__dirname, '../shared/terminal-message-reference.mjs')).href);
}
async function writeTerminalMessageDetails(clipboard, detailsText, reference, codecLoader = loadCodec) {
  if (!reference?.source || !reference.referenceId) { clipboard.writeText(detailsText); return; }
  let shared;
  try { shared = await codecLoader(); }
  catch { clipboard.writeText(detailsText); return; } // no rich write was dispatched
  const payload = shared.terminalMessageClipboard(detailsText, { ...reference.source, terminalInstancePid: process.pid }, reference.referenceId);
  if (payload.html) clipboard.write(payload);
  else clipboard.writeText(detailsText);
  console.log('[MessageReference] copy id=' + reference.referenceId + ' rich=' + !!payload.html + ' chars=' + detailsText.length);
}
module.exports = { writeTerminalMessageDetails };
