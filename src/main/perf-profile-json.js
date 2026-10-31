'use strict';
const fs = require('node:fs');

// Bounded output serialization after STOP. The initial Inspector/CDP profile
// object already exists; this avoids a second whole-profile JSON allocation.
async function writeProfileJson(file, data, limit = 16 * 1024 * 1024) {
  const fd = await fs.promises.open(file, fs.constants.O_CREAT | fs.constants.O_WRONLY |
    fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  let bytes = 0, chunk = '', nodes = 0;
  const ancestors = new Set();
  async function token(text) {
    const size = Buffer.byteLength(text);
    if (bytes + size > limit) throw Error('profile-size-limit');
    bytes += size;
    if (chunk.length + text.length > 32768) { if (chunk) await fd.writeFile(chunk); chunk = ''; }
    if (text.length > 32768) await fd.writeFile(text); else chunk += text;
  }
  async function value(v, depth) {
    if (++nodes > 2000000 || depth > 64) throw Error('profile-structure-limit');
    if (v === null || typeof v === 'boolean' || typeof v === 'number') return token(JSON.stringify(v));
    if (typeof v === 'string') {
      if (v.length > 262144) throw Error('profile-string-limit');
      return token(JSON.stringify(v));
    }
    if (!v || typeof v !== 'object' || ancestors.has(v)) throw Error('profile-shape-invalid');
    ancestors.add(v);
    try {
      const array = Array.isArray(v), keys = array ? null : Object.keys(v);
      await token(array ? '[' : '{'); let comma = false;
      const count = array ? v.length : keys.length;
      if (count > 1000000) throw Error('profile-structure-limit');
      for (let i = 0; i < count; i++) {
        const k = array ? String(i) : keys[i], d = Object.getOwnPropertyDescriptor(v, k);
        if (!d || !Object.hasOwn(d, 'value')) throw Error('profile-accessor-refused');
        if (!array && d.value === undefined) continue;
        if (comma) await token(','); comma = true;
        if (!array) { await token(JSON.stringify(k)); await token(':'); }
        await value(d.value === undefined ? null : d.value, depth + 1);
      }
      await token(array ? ']' : '}');
    } finally { ancestors.delete(v); }
  }
  try { await value(data, 0); if (chunk) await fd.writeFile(chunk); }
  finally { await fd.close(); }
  return bytes;
}
module.exports = { writeProfileJson };
