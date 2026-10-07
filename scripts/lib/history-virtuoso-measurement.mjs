import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const HISTORY_VIRTUOSO_VERSION = '4.18.7';
export const HISTORY_VIRTUOSO_UPSTREAM_SHA256 = '6c6d738438d62d4346df8b0c301f6447abbc2cae507e6d40524837e44577393a';
export const HISTORY_VIRTUOSO_PATCH_MARKER = '/* noted:history-virtuoso-measure-before-paint:v1 */';

const pluginName = 'history-virtuoso-measurement';
const modulePath = /(^|[\\/])react-virtuoso[\\/]dist[\\/]index\.mjs$/;
const hookSignature = 'function Mn(t, e, n, o, r, s, i, l, c) {';
const hookReturn = '  return De(d, n, c);\n}';
const listCall = `Mn(
    o,
    I,
    p,
    e ? Jt : c,
    w,
    R,
    s,
    h,
    A("skipAnimationFrameInResizeObserver")
  )`;

const replacements = [
  ['Mn signature', hookSignature, 'function Mn(t, e, n, o, r, s, i, l, c, opt, renderState) {'],
  ['Mn measurement return', hookReturn, `  ${HISTORY_VIRTUOSO_PATCH_MARKER}
  const measured = De(d, n, c);
  E.useLayoutEffect(() => {
    if (typeof opt !== "function" || !opt())
      return;
    const list = measured.ref.current;
    if (n && list && list.offsetParent !== null)
      d(list);
  }, [n, d, opt, renderState]);
  return measured;
}`],
  ['Hn list measurement call', listCall, listCall.replace(
    'A("skipAnimationFrameInResizeObserver")',
    'A("skipAnimationFrameInResizeObserver"),\n    m?.historyMeasureBeforePaint,\n    n',
  )],
];

function patchError(reason) {
  return new Error(
    `[${pluginName}] Refusing to patch react-virtuoso@${HISTORY_VIRTUOSO_VERSION} dist/index.mjs: ${reason}. `
    + 'Use the pristine pinned dependency and apply this adapter exactly once. '
    + 'For an intentional upstream change, review the measurement hook and update the pinned hash, replacements, and tests together.',
  );
}

/**
 * Patch only the verified ESM distribution, without reading or writing files.
 * Hn forwards context.historyMeasureBeforePaint(): boolean; Table keeps its
 * existing arguments. The predicate is evaluated during list layout commits,
 * so the History owner can check current presentation/resize state at that time.
 * De, its ResizeObserver, and the existing size/scroll-state publications stay
 * intact. The list-state dependency excludes unrelated context/footer commits.
 * No scroll position writer is added here.
 */
export function patchHistoryVirtuoso(source) {
  if (typeof source !== 'string') {
    throw new TypeError(`[${pluginName}] Expected the UTF-8 source of react-virtuoso/dist/index.mjs as a string.`);
  }
  if (source.includes(HISTORY_VIRTUOSO_PATCH_MARKER)) {
    throw patchError('patch marker already present (double patch)');
  }

  // Check every anchor before editing anything. Counts also identify which
  // assumption broke when an upstream change fails the SHA check.
  const actualHash = createHash('sha256').update(source, 'utf8').digest('hex');
  for (const [label, before] of replacements) {
    const count = source.split(before).length - 1;
    if (count !== 1) {
      throw patchError(`${label}: expected exactly 1 replacement, found ${count}; SHA-256 expected ${HISTORY_VIRTUOSO_UPSTREAM_SHA256}, received ${actualHash}`);
    }
  }
  if (actualHash !== HISTORY_VIRTUOSO_UPSTREAM_SHA256) {
    throw patchError(`SHA-256 mismatch: expected ${HISTORY_VIRTUOSO_UPSTREAM_SHA256}, received ${actualHash}`);
  }

  return replacements.reduce((patched, [, before, after]) => patched.replace(before, after), source);
}

/** Add to the renderer's Vite plugins; the config owner wires it in. */
export function historyVirtuosoMeasurementVitePlugin() {
  return {
    name: pluginName,
    enforce: 'pre',
    // Vite merges this with the caller's optimizeDeps config. Prebundling would
    // bypass the pinned distribution transform during development.
    config() {
      return { optimizeDeps: { exclude: ['react-virtuoso'] } };
    },
    transform(source, id) {
      if (id.startsWith('\0') || !modulePath.test(id.split('?', 1)[0])) return null;
      return { code: patchHistoryVirtuoso(source), map: null };
    },
  };
}

/** Use the identical patch in owned esbuild fixtures, including frozen copies. */
export function historyVirtuosoMeasurementEsbuildPlugin() {
  return {
    name: pluginName,
    setup(build) {
      build.onLoad({ filter: modulePath, namespace: 'file' }, async ({ path }) => ({
        contents: patchHistoryVirtuoso(await readFile(path, 'utf8')),
        loader: 'js',
        resolveDir: dirname(path),
      }));
    },
  };
}
