'use strict';

// A subdivision of the reader's EXISTING index allowance, never of the full
// History RAM setting. SQLite main and TEMP have separate pager caches.
// This is cache accounting, not an RSS/heap/SQLite-native hard limit: active
// SQLite pages, statement/schema memory and transient decoded JSON are work.
const KiB = 1024;
const PAGE_BYTES = KiB;
const PAGE_SLOT_RESERVE_BYTES = 16 * KiB;
const MAX_ROOT_RESERVE_BYTES = 4 * 1024 * KiB;
const fail = () => Object.assign(new Error('HISTORY_ROOT_MEMORY_BUDGET'), { code: 'HISTORY_ROOT_MEMORY_BUDGET' });
const bytes = value => Number.isSafeInteger(value) && value >= 0;

function splitHistoryRootCacheBudget(indexBudgetBytes) {
  if (!bytes(indexBudgetBytes)) throw fail();
  const share = Math.min(MAX_ROOT_RESERVE_BYTES, Math.floor(indexBudgetBytes / 8));
  // Round DOWN in 4 KiB units, including at tiny/zero budgets. Each pager
  // receives one quarter; the remaining half covers bounded raw page slots.
  const sqlCacheKiB = Math.floor(share / (4 * 4 * KiB)) * 4;
  const sqliteCacheTargetBytes = 2 * sqlCacheKiB * KiB;
  // A slot charges a conservative fixed allowance for the raw Buffer, its
  // possible backing slab, Buffer/Map bookkeeping and allocator rounding.
  // This is a reservation estimate; it is not a measured native allocation.
  const residentPages = Math.floor((share - sqliteCacheTargetBytes) / PAGE_SLOT_RESERVE_BYTES);
  const rawPageReservationBytes = residentPages * PAGE_SLOT_RESERVE_BYTES;
  const rootReservationBytes = rawPageReservationBytes + sqliteCacheTargetBytes;
  return Object.freeze({ indexBudgetBytes, preparedIndexBudgetBytes: indexBudgetBytes - rootReservationBytes,
    rootReservationBytes, rawPageReservationBytes, sqliteCacheTargetBytes,
    pageSlotReserveBytes: PAGE_SLOT_RESERVE_BYTES,
    storeOptions: Object.freeze({ pageBytes: PAGE_BYTES, indexBytes: residentPages * PAGE_BYTES,
      residentPages, sqlCacheKiB }) });
}

function reserveHistoryRootCacheBudget(cache) {
  const plan = splitHistoryRootCacheBudget(cache.indexMemoryBudget);
  if (!bytes(cache.indexMemoryBytes) || typeof cache.clearMemory !== 'function') throw fail();
  // Synchronous reservation before any Root allocation or legacy read. A
  // previously warm cache cannot keep bytes above its reduced allowance.
  cache.indexMemoryBudget = plan.preparedIndexBudgetBytes;
  if (cache.indexMemoryBytes > cache.indexMemoryBudget) cache.clearMemory();
  if (!bytes(cache.indexMemoryBytes) || cache.indexMemoryBytes > cache.indexMemoryBudget) throw fail();
  return plan;
}

function configureHistoryRootZeroCache(store, plan) {
  if (plan.storeOptions.sqlCacheKiB !== 0) return;
  // The generic store intentionally retains its existing 1 KiB minimum for
  // callers/fixtures. This owned production policy turns both pager retention
  // targets off after bootstrap and before issuing any capabilities. SQLite
  // still needs working pages; zero cache is not zero process memory.
  store.db.pragma('cache_size = 0');
  store.db.pragma('temp.cache_size = 0');
  store.db.pragma('shrink_memory');
}

function historyRootCacheMemory(cache, store, plan) {
  if (!plan) return { status: 'unknown', reason: 'externally-owned-store', accountedIndexMemoryBytes: null };
  const preparedIndexBytes = cache.indexMemoryBytes;
  const open = !!store && !store.closed;
  const rawPageBytes = open ? store.cacheBytes : 0, rawPageCount = open ? store.cache.size : 0;
  if (![preparedIndexBytes, rawPageBytes, rawPageCount].every(bytes)) throw fail();
  const rawPageAccountedBytes = rawPageCount * plan.pageSlotReserveBytes;
  const sqliteCacheTargetBytes = open ? plan.sqliteCacheTargetBytes : 0;
  const accountedIndexMemoryBytes = preparedIndexBytes + rawPageAccountedBytes + sqliteCacheTargetBytes;
  if (preparedIndexBytes > plan.preparedIndexBudgetBytes || rawPageBytes > plan.storeOptions.indexBytes
    || rawPageCount > plan.storeOptions.residentPages || accountedIndexMemoryBytes > plan.indexBudgetBytes) throw fail();
  return { status: 'accounted', indexBudgetBytes: plan.indexBudgetBytes,
    preparedIndexBudgetBytes: plan.preparedIndexBudgetBytes, preparedIndexBytes,
    rootReservationBytes: plan.rootReservationBytes, rawPageBytes, rawPageCount, rawPageAccountedBytes,
    sqliteCacheTargetBytes, sqliteNativeBytes: null, sqliteNativeMemoryMeasured: false,
    accountedIndexMemoryBytes, coverage: 'prepared-index-estimate; raw-page-slot-reserve; main-and-temp-pager-targets; not-RSS' };
}

module.exports = { splitHistoryRootCacheBudget, reserveHistoryRootCacheBudget,
  configureHistoryRootZeroCache, historyRootCacheMemory };
