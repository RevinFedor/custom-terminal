// SHA256(UTF16LE) for explicit document sinks. Hash code units verbatim: UTF8
// conversion would replace lone surrogates, including across transport chunks.
// Only this fixed scratch buffer is added; callers still own their full text.
export async function createDocumentUtf16Digest() {
  // Electron 28 exposes Node through window.require. Keep the SOURCE Node
  // fallback dynamic so Vite does not substitute a browser crypto shim.
  const builtin = 'node:crypto';
  const { createHash } = typeof window !== 'undefined' && typeof window.require === 'function'
    ? window.require(builtin) : await import(/* @vite-ignore */ builtin);
  const hash = createHash('sha256'), bytes = new Uint8Array(4096);
  return {
    update(text) {
      for (let start = 0; start < text.length; start += bytes.length / 2) {
        const count = Math.min(bytes.length / 2, text.length - start);
        for (let index = 0; index < count; index++) {
          const code = text.charCodeAt(start + index);
          bytes[index * 2] = code & 255; bytes[index * 2 + 1] = code >>> 8;
        }
        // Node Hash.update consumes synchronously; the scratch can be reused.
        hash.update(bytes.subarray(0, count * 2));
      }
    },
    digest() { return hash.digest('hex'); },
  };
}
