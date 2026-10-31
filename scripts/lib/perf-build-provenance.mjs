import MagicString from 'magic-string';
import { encode } from '@jridgewell/sourcemap-codec';
import { createHash } from 'node:crypto';

// Replaced spans have no original position, even when a prefix resembles old
// code. One-field segments explicitly terminate GLB lookup on every line.
export function mappedReplacements(source, replacements, id) {
  const edits = replacements.map(([before, after]) => ({ start: source.indexOf(before), before, after }))
    .sort((a, b) => a.start - b.start);
  const magic = new MagicString(source);
  let end = 0, generated = '', line = 0, column = 0;
  const unknown = [];
  function advance(text) {
    const parts = text.split('\n');
    if (parts.length > 1) { line += parts.length - 1; column = parts.at(-1).length; }
    else column += text.length;
    generated += text;
  }
  for (const edit of edits) {
    if (edit.start < end) throw new Error('Invalid or overlapping mapped replacements');
    advance(source.slice(end, edit.start));
    const parts = edit.after.split('\n');
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].length) unknown.push({ line: line + i, start: i ? 0 : column, end: (i ? 0 : column) + parts[i].length });
    }
    magic.overwrite(edit.start, edit.start + edit.before.length, edit.after);
    advance(edit.after);
    end = edit.start + edit.before.length;
  }
  advance(source.slice(end));
  const decoded = magic.generateDecodedMap({ source: id, hires: true, includeContent: false });
  for (const span of unknown) {
    const segments = decoded.mappings[span.line] || (decoded.mappings[span.line] = []);
    decoded.mappings[span.line] = segments.filter(s => s[0] < span.start || s[0] >= span.end);
    decoded.mappings[span.line].push([span.start]);
    decoded.mappings[span.line].sort((a, b) => a[0] - b[0]);
  }
  return { code: generated, map: { ...decoded, version: 3, mappings: encode(decoded.mappings) } };
}

// Hash exactly what is present at this post generateBundle hook. The manifest
// is intentionally not self-hashed; later mutations are outside this receipt.
export function perfBuildProvenancePlugin(target) {
  return {
    name: `noted-private-provenance-${target}`,
    apply: 'build', enforce: 'post',
    generateBundle: { order: 'post', handler(_options, bundle) {
      const files = Object.entries(bundle).sort(([a], [b]) => a.localeCompare(b)).map(([name, item]) => {
        const bytes = item.type === 'chunk' ? item.code : item.source;
        return { name, kind: item.type, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: Buffer.byteLength(bytes) };
      });
      this.emitFile({ type: 'asset', fileName: `private-provenance-${target}.json`, source: JSON.stringify({
        schema: 1, target, boundary: 'generateBundle-post', files,
        buildRuntime: { node: process.version, v8: process.versions.v8 },
        runtimeEngine: null,
      }, null, 2) + '\n' });
    } },
  };
}
