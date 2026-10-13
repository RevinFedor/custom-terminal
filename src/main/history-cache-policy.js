'use strict';

// Disk retention is independent of parser/index RAM budgets. This is shared
// by the worker cache and the capacity warning; neither reserves disk bytes.
const { DEFAULT_HISTORY_DISK_BUDGET_GIB, normalizeHistoryDiskBudgetGiB } = require('../shared/history-cache-settings.cjs');
const HISTORY_PREPARED_CACHE_DISK_BUDGET_BYTES = DEFAULT_HISTORY_DISK_BUDGET_GIB * 1024 ** 3;
const DISK_CAPACITY_RESERVE_BYTES = 6 * 1024 ** 3;
const historyDiskBudgetBytes = value => normalizeHistoryDiskBudgetGiB(value) * 1024 ** 3;

module.exports = { HISTORY_PREPARED_CACHE_DISK_BUDGET_BYTES, DISK_CAPACITY_RESERVE_BYTES, historyDiskBudgetBytes };
