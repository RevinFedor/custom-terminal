'use strict';

function validateForceCleanupTabIds({
  forceCleanup = false,
  expectedTabIds,
  actualTabIds,
} = {}) {
  if (!forceCleanup && !Array.isArray(expectedTabIds)) return { ok: true };
  if (!Array.isArray(expectedTabIds)) {
    return { ok: false, error: 'force_cleanup_expected_tab_ids_required' };
  }
  const normalize = (values) => values.map((value) => String(value || '').trim());
  const expected = normalize(expectedTabIds);
  const actual = normalize(Array.isArray(actualTabIds) ? actualTabIds : []);
  if (expected.some((id) => !id) || new Set(expected).size !== expected.length) {
    return { ok: false, error: 'force_cleanup_expected_tab_ids_invalid' };
  }
  if (actual.some((id) => !id) || new Set(actual).size !== actual.length) {
    return { ok: false, error: 'force_cleanup_actual_tab_ids_invalid' };
  }
  expected.sort();
  actual.sort();
  if (expected.length !== actual.length
    || expected.some((id, index) => id !== actual[index])) {
    return {
      ok: false,
      error: 'force_cleanup_tab_snapshot_conflict',
      expectedTabIds: expected,
      actualTabIds: actual,
    };
  }
  return { ok: true };
}

module.exports = { validateForceCleanupTabIds };
