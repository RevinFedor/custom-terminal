import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

// Pinned to the actual renderer graph's @code-inspector/core 1.5.1 ESM bytes.
export const CORE_SHA256 = '929c088ce386c847f6c37e571c1cb7d63b45dc0120ad8f7515ec3e5a99259809';
const digest = s => createHash('sha256').update(s).digest('hex');

const support = `
import { encode as __inspectorEncode } from '@jridgewell/sourcemap-codec';
import { createHash as __inspectorHash } from 'node:crypto';
const __inspectorInjectedEntries = new Set();
const __inspectorDigest = text => __inspectorHash('sha256').update(text).digest('hex');
function __inspectorPrivateMap(ms, source) {
  // Unchanged code preserves the previous transform's map. Line locations are
  // sufficient for sampled callsites; exact source columns are not claimed.
  if (!ms.hasChanged()) return null;
  const decoded = ms.generateDecodedMap({ hires: false, includeContent: false });
  // MagicString advances over inserted text without emitting an unmapped segment.
  // Add explicit barriers and remove mappings for overwritten text; otherwise a
  // consumer's greatest-lower-bound lookup incorrectly attributes injected code.
  const gaps = [];
  let line = 0, column = 0;
  function advance(text, unmapped) {
    if (!text) return;
    let start = 0;
    for (let j = 0; j <= text.length; j++) {
      if (j !== text.length && text[j] !== '\\n') continue;
      const length = j - start;
      if (unmapped && length) (gaps[line] ||= []).push([column, column + length]);
      column += length;
      if (j < text.length) { line++; column = 0; }
      start = j + 1;
    }
  }
  advance(ms.intro, true);
  ms.firstChunk.eachNext(chunk => {
    advance(chunk.intro, true);
    advance(chunk.content, chunk.edited);
    advance(chunk.outro, true);
  });
  advance(ms.outro, true);
  for (let l = 0; l < gaps.length; l++) {
    if (!gaps[l]) continue;
    const spans = gaps[l];
    const segments = decoded.mappings[l] || (decoded.mappings[l] = []);
    let k = 0;
    decoded.mappings[l] = segments.filter(s => {
      while (k < spans.length && spans[k][1] <= s[0]) k++;
      return k === spans.length || s[0] < spans[k][0];
    });
    for (const [a] of spans) decoded.mappings[l].push([a]);
    decoded.mappings[l].sort((a,b) => a[0] - b[0]);
  }
  // Supplying only options.source makes MagicString relativize against an empty
  // file name. Override it with the exact input path, not the inspector label.
  decoded.sources = [source];
  return { ...decoded, mappings: __inspectorEncode(decoded.mappings) };
}
`;

export function patchInspectorCore(source) {
  if (typeof source !== 'string' || digest(source) !== CORE_SHA256) throw new Error('Unsupported inspector core SHA-256');
  const counts = {};
  function replaceOnce(name, from, to) {
    const pieces = source.split(from); counts[name] = pieces.length - 1;
    if (counts[name] !== 1) throw new Error(`Inspector pattern ${name}: expected 1, got ${counts[name]}`);
    source = pieces.join(to);
  }
  replaceOnce('GFt signature', 'function GFt(e, t, r) {', 'function GFt(e, t, r, __sourcePath, __skipMap) {');
  replaceOnce('GFt output', '  }), i.toString();\n}\nfunction m3(', '  }), __skipMap ? i.toString() : { code: i.toString(), map: __inspectorPrivateMap(i, __sourcePath) };\n}\nfunction m3(');
  replaceOnce('original path', '    const a = [...qfr, ...n];\n    r = uar(r, s);', '    const a = [...qfr, ...n];\n    const __sourcePath = r;\n    r = uar(r, s);');
  replaceOnce('jsx dispatch', 'i === "jsx" ? GFt(t, r, a)', 'i === "jsx" ? GFt(t, r, a, __sourcePath, __inspectorInjectedEntries.size > 0 && __inspectorInjectedEntries.has(__inspectorDigest(t)))');
  replaceOnce('entry capture', '    var u, c;\n    if (!mn.existsSync(r) && !r.startsWith("virtual:nuxt:"))', '    var u, c;\n    const __entryInput = i;\n    if (!mn.existsSync(r) && !r.startsWith("virtual:nuxt:"))');
  replaceOnce('entry output', '    return i;\n  });\n}\nfunction thr(e)', '    if (i !== __entryInput) __inspectorInjectedEntries.add(__inspectorDigest(i));\n    return i;\n  });\n}\nfunction thr(e)');
  source = support + source;
  return { source, receipt: { originalSha256: CORE_SHA256, patchedSha256: digest(source), counts, map: 'line-resolution; source columns approximate; unchanged preserves previous map; inserted and overwritten spans unmapped; entry-injected files return string', version: 'core-1.5.1' } };
}

// Register synchronously before importing Vite config or any importer of core.
// Caller owns the hook lifetime and must check receipt.loaded before claiming use.
export function installInspectorPrivateSourcemap(corePath) {
  const path = realpathSync(corePath);
  const original = readFileSync(path, 'utf8');
  const patched = patchInspectorCore(original);
  const receipt = { ...patched.receipt, path, loaded: 0 };
  const hook = registerHooks({ load(url, context, nextLoad) {
    if (!url.startsWith('file:') || fileURLToPath(url) !== path) return nextLoad(url, context);
    const result = nextLoad(url, context);
    if (result.format !== 'module' || digest(Buffer.from(result.source).toString('utf8')) !== CORE_SHA256) throw new Error('Inspector load source or format changed');
    receipt.loaded++;
    return { ...result, source: patched.source };
  } });
  return { receipt, deregister: () => hook.deregister() };
}
