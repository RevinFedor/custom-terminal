'use strict';

// Which source files decide the MEANING of a cached history row.
//
// The prepared cache is keyed by a fingerprint of the code that produced it:
// reusing rows written by a different parser would silently show wrong
// history. Until 01.11 that fingerprint hashed EVERY `src/**` module loaded
// in the reader process — 119 files, because `database.js` transitively pulls
// in prompt audit, fork markers, image transport and the rest of Main.
//
// Measured consequence: the user reinstalls several times a day, each build
// changes some unrelated file, and every reinstall evicted the whole warm
// cache. The 17:08 install discarded 101 entries / 2.3 GB as
// `obsolete-version`, and every tab paid a cold read again — 2051 ms for 1513
// entries on a 36 MB transcript, which is exactly the "switched tabs and it
// hangs" the user reported at 18:15.
//
// So the scope is now the files that actually define the format. The risk of
// narrowing is the opposite failure: a format change that does NOT rotate the
// key would reuse rows under a new interpretation. Three rules keep that
// safe:
//
//   1. The list is explicit, not a path pattern. A new parser file does not
//      silently join (or stay out of) the fingerprint because of its name.
//   2. `assertHistoryCacheScopeLoaded` fails loudly when a listed file is not
//      actually loaded — a rename or a move cannot quietly shrink the scope.
//   3. Anything in doubt stays IN. The list is intentionally wider than the
//      strict parser: dehydration, paging, fork boundaries and pasted-content
//      all shape stored rows.
//
// Adding a module that changes stored row content WITHOUT adding it here is a
// correctness bug, not an optimization. `historyCacheSchemaScope.test.js`
// holds the contract.

/**
 * Files whose bytes define how a prepared history row is produced or read
 * back. Paths are relative to `src/`, exactly as the fingerprint records them.
 */
const HISTORY_CACHE_SCHEMA_FILES = [
  // The reader itself: it builds the rows that get stored.
  'main/history-read-worker.js',

  // Storage format: on-disk layout, encoding, checksums, index shape.
  'main/history-prepared-cache.js',
  'main/history-paged-store.js',
  'main/history-paged-json.js',
  'main/history-paged-text.js',
  'main/history-json-number.js',
  'main/history-projection-arena.js',

  // Row content: what a stored entry holds and how it is rehydrated.
  'main/history-payload-dehydrate.js',
  'main/history-pending-payloads.js',
  'main/history-entry-window.js',
  'main/history-authoring-projection.js',
  'main/history-prompt-presentations.js',
  'main/history-source-leaf.js',
  'main/history-delta.js',
  'main/history-revision.js',

  // Transcript parsing: the JSONL → entry interpretation itself.
  'main/session-transcript-service.js',
  'main/ipc/codex-data.js',
  // Decodes native Codex rollout compression. Byte offsets stored in a row
  // address DECODED bytes, so a change here re-maps every cached Codex entry.
  'main/codex-rollout-read-views.js',
  // Resolves which spawned child a record belongs to; that ownership is
  // materialized into stored rows, not re-derived on read.
  'main/codex-process-action-ownership.js',

  // Shared semantics embedded into stored rows.
  'shared/fork-operation.cjs',
  'shared/fork-marker-boundary.cjs',
  'shared/pasted-content.cjs',
  'shared/prompt-web-images.cjs',
];

/**
 * Files that are loaded by the reader but cannot change a stored row:
 * transport, admission, diagnostics, timers. Listed explicitly so that the
 * test can prove every loaded module was CLASSIFIED, not merely skipped.
 */
const HISTORY_CACHE_NEUTRAL_FILES = [
  'main/history-read-control.js',
  'main/history-read-error.js',
  'main/history-read-runtime.js',
  'main/history-ipc-demand.js',
  'main/history-root-ipc.js',
  'main/history-cache-policy.js',
  'main/history-preparation-activity.js',
  'main/history-response-timings.js',
  'main/history-byte-stream.js',
  'main/history-stream-codec.js',
  'main/history-process-epochs.js',
  'main/http-read-diagnostics.js',
  // Memory accounting for the reader: observes, never shapes a row.
  'main/history-read-memory-diagnostics.js',
  // This list itself. Editing the classification must not rotate the key —
  // rotation is decided by the files it NAMES, and `selectHistoryCacheSchemaFiles`
  // already changes its output when the names change.
  'main/history-cache-schema-scope.js',
  // Tab/session storage. Row content comes from the transcript files, not from
  // this schema; a tab rename cannot change a prepared history row.
  'main/database.js',
  // Stores prompt attachments on disk and hands back paths. Stored rows carry
  // the reference, which `prompt-web-images.cjs` (listed as format) defines.
  'main/prompt-queue-assets.js',
];

const SCHEMA_FILE_SET = new Set(HISTORY_CACHE_SCHEMA_FILES);

/**
 * Picks the fingerprint inputs out of everything the reader loaded.
 *
 * @param {string[]} loadedRelativePaths every `src/**` module currently loaded,
 *   relative to `src/`, in any order.
 * @returns {{ included: string[], missing: string[] }} `included` is sorted and
 *   deterministic; `missing` names listed files that were NOT loaded.
 */
function selectHistoryCacheSchemaFiles(loadedRelativePaths) {
  const loaded = new Set(loadedRelativePaths);
  const included = [];
  for (const candidate of loadedRelativePaths) {
    if (SCHEMA_FILE_SET.has(candidate)) included.push(candidate);
  }
  included.sort();
  const missing = HISTORY_CACHE_SCHEMA_FILES.filter(name => !loaded.has(name)).sort();
  return { included, missing };
}

/**
 * A listed file that is not loaded means the list drifted from the code: a
 * rename, a move, or a dependency that stopped being reachable. Silently
 * hashing fewer files would weaken the key exactly when the code changed, so
 * the caller must fall back to hashing everything instead.
 */
function assertHistoryCacheScopeLoaded(missing) {
  if (!missing || missing.length === 0) return null;
  return 'history_cache_schema_scope_drift:' + missing.join(',');
}

module.exports = {
  HISTORY_CACHE_SCHEMA_FILES,
  HISTORY_CACHE_NEUTRAL_FILES,
  selectHistoryCacheSchemaFiles,
  assertHistoryCacheScopeLoaded,
};
