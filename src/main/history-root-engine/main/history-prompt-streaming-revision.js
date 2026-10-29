'use strict';
// Isolated-reader cold digest. Same bytes/token as JSON.stringify(the legacy
// ordered SQL rows), without an all-row array or whole chips_json String.
const crypto = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const COLUMNS = ['session_id', 'audit_timestamp', 'transport_hash', 'entry_uuid', 'schema_version', 'chips_json', 'updated_at'];
const error = () => Object.assign(new Error('Prompt sidecar row changed during snapshot'), { code: 'HISTORY_PROMPT_ROW_INVALIDATED' });
function streamingPromptPresentationRevision(db, toolType, { chunkBytes = 1024, stats = {} } = {}) {
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 64 || chunkBytes > 4096) throw new RangeError('history_prompt_chunk_bytes');
  Object.assign(stats, { rows: 0, columns: 0, sqlChunks: 0, maxSQLChunkBytes: 0,
    maxQuotedChunkChars: 0, serializedBytes: 0, nativeRowArray: false, sqlNativePeakMeasured: false });
  const run = () => {
    const digest = crypto.createHash('sha256');
    const put = value => { digest.update(value, 'utf8'); stats.serializedBytes += Buffer.byteLength(value); };
    const statements = new Map(COLUMNS.map(column => [column, {
      info: db.prepare('SELECT typeof('+column+') AS kind,length(CAST('+column+' AS BLOB)) AS byteLength FROM history_prompt_presentations WHERE rowid=?'),
      scalar: db.prepare('SELECT '+column+' AS value FROM history_prompt_presentations WHERE rowid=?'),
      chunk: db.prepare('SELECT substr(CAST('+column+' AS BLOB),?,?) AS bytes FROM history_prompt_presentations WHERE rowid=?'),
    }]));
    const emitColumn = (rowid, column) => {
      stats.columns++; const statement = statements.get(column), info = statement.info.get(rowid), kind = info?.kind;
      if (!kind) throw error();
      if (kind === 'null') { put('null'); return; }
      if (kind !== 'text' && kind !== 'blob') { put(JSON.stringify(statement.scalar.get(rowid).value)); return; }
      if (kind === 'blob' && info.byteLength === 0) { put(JSON.stringify(statement.scalar.get(rowid).value)); return; }
      let offset = 1, byteOrdinal = 0, high = '', first = true;
      const decoder = kind === 'text' ? new StringDecoder('utf8') : null;
      const quoted = part => {
        part = high + part; high = '';
        const last = part.charCodeAt(part.length - 1);
        if (last >= 0xd800 && last <= 0xdbff) { high = part.at(-1); part = part.slice(0, -1); }
        const escaped = JSON.stringify(part).slice(1, -1);
        stats.maxQuotedChunkChars = Math.max(stats.maxQuotedChunkChars, escaped.length); put(escaped);
      };
      let binaryBuffer;
      if (kind === 'text') put('"');
      else {
        const sample = statement.chunk.get(1, 1, rowid)?.bytes; if (!sample) throw error();
        stats.sqlChunks++; stats.maxSQLChunkBytes = Math.max(stats.maxSQLChunkBytes,sample.byteLength);
        binaryBuffer = Buffer.isBuffer(sample);
        put(binaryBuffer ? '{"type":"Buffer","data":[' : '{');
      }
      for (;offset <= info.byteLength;) {
        const row = statement.chunk.get(offset, chunkBytes, rowid); if (!row) throw error();
        const bytes = row.bytes;
        if (!ArrayBuffer.isView(bytes)) throw error();
        stats.sqlChunks++; stats.maxSQLChunkBytes = Math.max(stats.maxSQLChunkBytes, bytes.byteLength);
        if (!bytes.byteLength) throw error();
        offset += bytes.byteLength;
        if (decoder) quoted(decoder.write(bytes));
        else for (const byte of bytes) {
          if (!first) put(','); first = false;
          if (!binaryBuffer) put('"'+byteOrdinal+'":'); put(String(byte)); byteOrdinal++;
        }
      }
      if (decoder) {
        quoted(decoder.end()); if (high) put(JSON.stringify(high).slice(1, -1)); put('"');
      } else put(binaryBuffer ? ']}' : '}');
    };
    put('[');
    const rows = db.prepare('SELECT rowid FROM history_prompt_presentations WHERE tool_type=? ORDER BY session_id ASC,audit_timestamp ASC,transport_hash ASC').iterate(toolType);
    for (const row of rows) {
      if (stats.rows) put(','); put('{');
      for (let i=0;i<COLUMNS.length;i++) { if (i) put(','); put(JSON.stringify(COLUMNS[i])+':'); emitColumn(row.rowid,COLUMNS[i]); }
      put('}'); stats.rows++;
    }
    put(']');
    return stats.rows ? digest.digest('hex').slice(0,24) : 'none';
  };
  // Keep every column chunk at one SQL read snapshot. The existing owner
  // retains transaction/memo authority; no sidecar writer or cache is added.
  return db.inTransaction ? run() : db.transaction(run)();
}
module.exports = { streamingPromptPresentationRevision };

