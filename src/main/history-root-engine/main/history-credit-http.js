'use strict';

const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const zlib = require('node:zlib');
const { encodeHistoryJson, DEFAULT_CHUNK_BYTES } = require('./history-json-stream');
const { currentReadControl } = require('./history-read-control');

// The entries array is already encoded in the reader and crosses Main only as
// credited byte frames. Header fields keep the existing public JSON contract.
// This does not bound a legacy projector's input graph or a JSON-decoding client.
async function* historyEntriesEnvelope(header, entries, { control = currentReadControl(),
  verify = async () => {}, chunkBytes = DEFAULT_CHUNK_BYTES } = {}) {
  const check = () => { control?.assertCurrent(); entries.assertCurrent?.(); };
  check(); await verify(); check();
  yield Buffer.from('{');
  let first = true;
  for (const key in header) {
    if (!Object.hasOwn(header, key) || key === 'entries' || header[key] === undefined) continue;
    if (!first) yield Buffer.from(',');
    first = false;
    for await (const chunk of encodeHistoryJson(key, { control, chunkBytes })) { check(); yield chunk; }
    yield Buffer.from(':');
    for await (const chunk of encodeHistoryJson(header[key], { control, chunkBytes })) { check(); yield chunk; }
  }
  yield Buffer.from(first ? '"entries":' : ',"entries":');
  // Advancing entries grants credit for the last frame. The upstream stream
  // can retain only its fixed frame window while the HTTP sink is blocked.
  for await (const chunk of entries) { check(); yield chunk; }
  await verify(); check();
  // The closing brace is the success delimiter. A source/identity failure
  // leaves an incomplete response; no valid empty History or retry is invented.
  yield Buffer.from('}');
}

async function sendHistoryEntriesStream(res, status, header, entries, options = {}) {
  const control = options.control || currentReadControl();
  const chunkBytes = options.chunkBytes || DEFAULT_CHUNK_BYTES;
  const source = Readable.from(historyEntriesEnvelope(header, entries, { ...options, control, chunkBytes }),
    { objectMode: false, highWaterMark: chunkBytes });
  const gzip = /\bgzip\b/.test(String(res.req?.headers?.['accept-encoding'] || ''))
    ? zlib.createGzip({ level: 4, chunkSize: Math.max(64, chunkBytes) }) : null;
  try {
    control?.assertCurrent(); entries.assertCurrent?.();
    res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS', 'Vary': 'Accept-Encoding',
      ...(gzip ? { 'Content-Encoding': 'gzip' } : {}) });
    await pipeline(...(gzip ? [source, gzip, res] : [source, res]),
      ...(control?.signal ? [{ signal: control.signal }] : []));
    control?.assertCurrent();
  } finally {
    source.destroy(); gzip?.destroy();
    // return()/close() is harmless after normal consumption and revokes a
    // partially consumed stream on disconnect or identity failure.
    await entries.return?.();
  }
}

module.exports = { historyEntriesEnvelope, sendHistoryEntriesStream };
