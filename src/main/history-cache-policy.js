'use strict';

// Disk retention is independent of parser/index RAM budgets. This is shared
// by the worker cache and the capacity warning; neither reserves disk bytes.
const HISTORY_PREPARED_CACHE_DISK_BUDGET_BYTES = 20 * 1024 ** 3;
const DISK_CAPACITY_RESERVE_BYTES = 6 * 1024 ** 3;

module.exports = { HISTORY_PREPARED_CACHE_DISK_BUDGET_BYTES, DISK_CAPACITY_RESERVE_BYTES };
