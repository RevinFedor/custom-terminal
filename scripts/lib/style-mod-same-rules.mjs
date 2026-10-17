import { createHash } from 'node:crypto';

export const STYLE_MOD_VERSION = '4.1.3';
export const STYLE_MOD_UPSTREAM_SHA256 = '43690e452046d6a355a1a9211c1b48aab605613ab63c0aff13f585e742e66c83';
export const STYLE_MOD_PATCH_MARKER = '/* noted:style-mod-same-rules:v1 */';
const modulePath = /(^|[\\/])style-mod[\\/]src[\\/]style-mod\.js$/;
const assignment = '      this.styleTag.textContent = text\n';

// StyleSet already reuses modules. Replacing an unchanged style element's text
// still invalidates its global stylesheet in Chromium. Keep new rules, ordering,
// nonce, root attachment and adoptedStyleSheets on the upstream path.
export function patchStyleModSameRules(source) {
  const hash = createHash('sha256').update(source).digest('hex');
  if (source.includes(STYLE_MOD_PATCH_MARKER)
    || hash !== STYLE_MOD_UPSTREAM_SHA256
    || source.split(assignment).length !== 2) {
    throw new Error(`[style-mod-same-rules] Refusing changed style-mod@${STYLE_MOD_VERSION}: expected pristine ${STYLE_MOD_UPSTREAM_SHA256}, received ${hash}`);
  }
  return source.replace(assignment, `      ${STYLE_MOD_PATCH_MARKER}
      if (this.styleTag.textContent !== text) this.styleTag.textContent = text
`);
}

export function styleModSameRulesVitePlugin() {
  return {
    name: 'noted-style-mod-same-rules',
    enforce: 'pre',
    config() { return { optimizeDeps: { exclude: ['style-mod'] } }; },
    transform(source, id) {
      if (id.startsWith('\0') || !modulePath.test(id.split('?', 1)[0])) return null;
      return { code: patchStyleModSameRules(source), map: null };
    },
  };
}
