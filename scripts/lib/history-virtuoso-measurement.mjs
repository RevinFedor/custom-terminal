import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { mappedReplacements } from './perf-build-provenance.mjs';

export const HISTORY_VIRTUOSO_VERSION = '4.18.7';
export const HISTORY_VIRTUOSO_UPSTREAM_SHA256 = '6c6d738438d62d4346df8b0c301f6447abbc2cae507e6d40524837e44577393a';
export const HISTORY_VIRTUOSO_PATCH_MARKER = '/* noted:history-virtuoso-measure-before-paint:v4 */';

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
  ['Mn signature', hookSignature, 'function Mn(t, e, n, o, r, s, i, l, c, opt, renderState, commitToken) {'],
  ['Mn measurement return', hookReturn, `  ${HISTORY_VIRTUOSO_PATCH_MARKER}
  const measured = De(d, n, c);
  E.useLayoutEffect(() => {
    if (typeof opt !== "function" || !opt())
      return;
    const list = measured.ref.current;
    if (n && list && list.offsetParent !== null)
      d(list);
  }, [n, d, opt, renderState, commitToken]);
  return measured;
}`],
  ['Hn list measurement call', listCall, listCall.replace(
    'A("skipAnimationFrameInResizeObserver")',
    'A("skipAnimationFrameInResizeObserver"),\n    m?.historyMeasureBeforePaint,\n    n,\n    m?.historyOnPrimaryWindowCommit',
  )],
  ['Hn current list state', 'const n = A("listState"), o = Ct("sizeRanges")',
    'const n = A("listState"), latestListState = E.useRef(n), o = Ct("sizeRanges")'],
  ['Hn list-state observation', '  on("deviation", (F) => {', `  latestListState.current = n;
  on("listState", (value) => { latestListState.current = value; });
  on("deviation", (F) => {`],
  ['Hn admission before synchronous key', '      children: (e ? n.topItems : n.items).map((F) => {\n        const mt = F.originalIndex, q = C(mt + n.firstItemIndex, F.data, m);', `      children: (() => {
        const render = () => {
          primaryAdmission = typeof m?.historyPrimaryItemAdmission === "function"
            ? (e ? n.topItems : n.items).map((item) => item.index === item.originalIndex + n.firstItemIndex
              && m.historyPrimaryItemAdmission(item.index) === true) : null;
          return (e ? n.topItems : n.items).map((F, primaryOffset) => {
        if (primaryAdmission && primaryAdmission[primaryOffset] !== true) {
          if (typeof m?.historyPrimaryPendingItem !== "function")
            throw new Error("HISTORY_PRIMARY_PENDING_RENDERER_REQUIRED");
          return m.historyPrimaryPendingItem(F.index, F.size);
        }
        const mt = F.originalIndex, q = C(mt + n.firstItemIndex, F.data, m);`],
  ['Hn row transaction end', '\n      })\n    }\n  );\n}), hr =', `
      });
        };
        return typeof m?.historyPrimaryRenderTransaction === "function"
          ? m.historyPrimaryRenderTransaction(render) : render();
      })()
    }
  );
}), hr =`],
  ['Hn committed primary range', '  return !e && n.totalCount === 0 && H !== null && H !== void 0 ?', `  let primaryAdmission = null;
  E.useLayoutEffect(() => {
    if (e || typeof m?.historyOnPrimaryWindowCommit !== "function") return;
    const items = n.items;
    const latest = latestListState.current;
    const same = latest && Array.isArray(latest.items) && ["totalCount","firstItemIndex","offsetTop","offsetBottom","top","bottom"]
      .every((key) => latest[key] === n[key]) && latest.items.length === items.length
      && items.every((item, index) => ["index","originalIndex","offset","size","type"]
        .every((key) => item[key] === latest.items[index][key]));
    m.historyOnPrimaryWindowCommit({
      totalCount: n.totalCount,
      startIndex: items.length ? items[0].index : 0,
      endIndex: items.length ? items[items.length - 1].index : 0,
      itemCount: items.length,
      ...(primaryAdmission ? { admittedCount: primaryAdmission.filter(Boolean).length } : {}),
      stable: !!same && !z && (n.totalCount === 0 || N)
    });
  }, [e, n, N, z, m?.historyOnPrimaryWindowCommit, m?.historyPrimaryItemAdmission]);
  return !e && n.totalCount === 0 && H !== null && H !== void 0 ?`],
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
 * Primary Hn rows require an exact synchronous admission before their real
 * computeItemKey/itemContent callbacks. Unadmitted indices use status-only
 * shells without measured-row attributes; the committed range still requests
 * data. The bounded admission vector contains booleans for this actual window,
 * never N physical keys. Legacy list/Table behavior is unchanged.
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
      const code = patchHistoryVirtuoso(source); // retains all existing guards
      const mapped = mappedReplacements(source, replacements.map(([, before, after]) => [before, after]), id.split('?', 1)[0]);
      if (mapped.code !== code) throw patchError('mapped patch differs from guarded patch');
      return mapped;
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
