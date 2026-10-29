'use strict';

const HISTORY_DISK_BUDGET_KEY = 'historyCacheDiskBudgetGiB';
const DEFAULT_HISTORY_DISK_BUDGET_GIB = 20;
const MIN_HISTORY_DISK_BUDGET_GIB = 1;
const MAX_HISTORY_DISK_BUDGET_GIB = 1024;

function normalizeHistoryDiskBudgetGiB(value) {
  if (value == null || value === '') return DEFAULT_HISTORY_DISK_BUDGET_GIB;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_HISTORY_DISK_BUDGET_GIB;
  return Math.max(MIN_HISTORY_DISK_BUDGET_GIB, Math.min(MAX_HISTORY_DISK_BUDGET_GIB, Math.floor(parsed)));
}

module.exports = { HISTORY_DISK_BUDGET_KEY, DEFAULT_HISTORY_DISK_BUDGET_GIB,
  MIN_HISTORY_DISK_BUDGET_GIB, MAX_HISTORY_DISK_BUDGET_GIB, normalizeHistoryDiskBudgetGiB };
